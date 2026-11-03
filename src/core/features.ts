// Evaluate solid features (extrude) from the document. Resolves each feature's
// parametric distance, extracts the sketch region(s), and asks the OCC kernel
// for a display mesh. Features combine into bodies via boolean operations
// (new / join / cut), Fusion-style: a joined extrude fuses into the running
// body, a cut subtracts from it. Kept separate from the (fast, pure) sketch
// recompute because it drives the heavier B-rep kernel.

import { compileExpr, Scope } from "../math/expr";
import {
  CadDocument, ExtrudeFeature, FeatureDef, GearFeature, GearDim, ImportFeature, MemberFeature, SheetFeature, FlangeFeature, FoldFeature, UnfoldFeature, SurfaceFeature, StitchFeature, ThickenFeature, TrimFeature, UntrimFeature, MirrorFeature, EdgeBlendFeature, ShellFeature, PatternFeature, VoronoiFeature, LoftFeature, SweepFeature, SketchFeature, PrimitiveFeature, HoleFeature, ThreadFeature, ThreadSpec, ThreadDecal, BooleanOp, materialForComponent, isReferenceBody,
} from "./document";
import { offsetPlane, resolveSketchPlane, planeById, makePlaneFromNormal, to3d, WorkPlane } from "../geometry/plane";
import { extractRegions, extractOpenPath, extractChains, regionAt, loopPolygon, Region, Profile, Loop } from "./geometry/profile";
import { FaceRef } from "../sketch/types";
import {
  Edge3D, buildRegionsSolid, buildRegionsRevolved, buildLoftSolid, buildSweepSolid, fuseShapes, cutShapes, intersectShapes, mirrorShape, meshShape, edgesOfShape, blobOfShape,
  planarFacesOfShape, PlanarFace, isKernelReady, SolidMesh, blendEdges, shellShape, translateShape, rotateShape,
  boundsOfShape, volumeOfShape, massPropsOfShape, MassProps, Bounds3, buildPrimitive, buildHoleCutter, HoleCutterSpec, buildThread,
  faceGeoms, faceKinds, edgeGeoms, kernelErrorMessage, FaceGeom, EdgeGeom, booleanWithHistory, BooleanKind, surfaceParents, distanceBetween, readStep, readBrep, readStl, analyzeShape, keepHalfSpace,
  readNurbsBrep, chainWire, surfaceExtrude, surfaceRevolve, surfaceLoft, surfaceSweep, planarPatch, sewShapes, thickenShape, offsetSurface, untrimFaces, hasSolid, buildSpineSweep, SpineSweepSpec,
} from "./occ/kernel";
import { controlSpine, throughSpine, spineTable, paramAtLength, sectionPlane, easedLaw, curveDerivs } from "./geometry/spine";
import { genericNames, extrudeNames, revolveNames, holeCutterNames, inheritNames, copyNames, edgeNamesOf } from "./naming";
import { stableJson, contentHash } from "./contentKey";
import { standardProfile, profileLabel, profileReach, profileHalfWidth, memberLines, memberJoints, ProfileDims } from "./weldment";
import type { Shape3D } from "replicad";
import { Vec3 } from "../math/vec";
import { Rigid, IDENTITY, axisAngle, compose, invert, applyPoint, applyVec } from "../math/transform";
import { resolveComponentWorld } from "./recompute";
import { SheetState, SheetFold, SheetRow, blankEdges, contourBlank, addFlange, jogFolds, flatPointOf, chordAcross, isSequenced } from "./sheet";
import { sequenceAngles, sequenceUVs } from "./sheetSequence";
import { buildSheet, SheetBuild } from "./sheetBuild";
import { flatBlankOf } from "./occ/sheet";
import { localGearSolid, peekLocalGear, placeShape, gearExtent, Annulus } from "./occ/gear";
import { gearDefaults } from "./geometry/gear";
import { RadialProbe, voronoiWall, scaleOutline, VoronoiWall, WallOpening } from "./geometry/voronoi";

export interface SolidEval {
  featureId: string;
  name: string;
  sketchId: string;
  distance: number;
  mesh?: SolidMesh;
  error?: string;
  /** Non-fatal diagnostics, e.g. a cut that removed nothing. */
  warning?: string;
  /** World bounds of the body (set for body rows). */
  bounds?: Bounds3;
  /** Enclosed volume in mm³ (set for body rows). */
  volume?: number;
  /** Exact surface area in mm² (set for body rows). */
  area?: number;
  /** Centroid of the body's volume, world mm (set for body rows). */
  centroid?: Vec3;
  /** Cosmetic thread regions on this body (rendered as a shaded texture). */
  threadDecals?: ThreadDecal[];
  /** A surface body: shells / faces with no enclosed volume (volume reads 0). */
  surface?: boolean;
  /** A structural member (weldment): its profile, cut length and end-cut angles (0° = square). */
  member?: { profile: string; length: number; angles: [number, number] };
  /** A sheet-metal (or paper) body: its rules, fold angles and flat pattern. `stale` once another feature has changed it while folded (the flat pattern no longer matches). */
  sheet?: SheetRow;
}

/** Evaluate a parametric expression, writing the value back onto `holder[key]Value`. */
function resolveExpr(expr: string, last: number, scope: Scope): number {
  try {
    const v = compileExpr(expr).eval(scope);
    if (Number.isFinite(v)) return v;
  } catch {
    /* keep last value */
  }
  return last;
}

function resolveDistance(f: ExtrudeFeature, scope: Scope): number {
  f.distanceValue = resolveExpr(f.distanceExpr, f.distanceValue, scope);
  return f.distanceValue;
}

/** A length that is "through everything": past the far side of `bounds` from any point inside it. */
function throughAllLength(bounds: Bounds3 | undefined): number {
  if (!bounds) return 1e4;
  const dx = bounds.max.x - bounds.min.x, dy = bounds.max.y - bounds.min.y, dz = bounds.max.z - bounds.min.z;
  return Math.max(2 * Math.hypot(dx, dy, dz), 1);
}

/** Regions this feature extrudes: the one under regionPoint, or all of them. */
function featureRegions(doc: CadDocument, f: SketchFeature): Region[] {
  const sketch = doc.sketches[f.sketchId];
  if (!sketch) return [];
  if (f.regionPoint) {
    const hit = regionAt(sketch, f.regionPoint);
    return hit ? [hit] : [];
  }
  return extractRegions(sketch);
}

/**
 * Build this feature's solid in isolation (regions extruded/revolved + fused),
 * with its faces named (see naming.ts). `targetBounds` sizes a through-all
 * extrude against the body it will act on.
 */
function buildFeatureSolid(doc: CadDocument, scope: Scope, f: SketchFeature, targetBounds?: Bounds3, bodies: Body[] = []): Named {
  const sketch = doc.sketches[f.sketchId];
  if (!sketch) throw new Error("sketch not found");
  const regions = featureRegions(doc, f);
  if (regions.length === 0) throw new Error("no closed region in sketch");
  const wp0 = resolveSketchPlane(sketch);
  if (f.kind === "revolve") {
    const angle = resolveExpr(f.angleExpr, f.angleValue, scope);
    f.angleValue = angle;
    // about a sketch line: its solved ends now, so the axis follows the line
    let ax = f.axis;
    const ln = f.axisLine ? sketch.entities[f.axisLine] : undefined;
    if (ln?.kind === "line") {
      const a = sketch.entities[ln.p1], b = sketch.entities[ln.p2];
      if (a?.kind === "point" && b?.kind === "point") ax = { p1: { x: a.x, y: a.y }, p2: { x: b.x, y: b.y } };
    }
    const o = to3d(wp0, ax.p1.x, ax.p1.y);
    const q = to3d(wp0, ax.p2.x, ax.p2.y);
    const dir = { x: q.x - o.x, y: q.y - o.y, z: q.z - o.z };
    if (Math.hypot(dir.x, dir.y, dir.z) < 1e-9) throw new Error("revolve axis points coincide");
    const shape = buildRegionsRevolved(wp0, regions, o, dir, Math.abs(angle) < 1e-9 ? 360 : angle);
    return { shape, names: nameSafely(shape, f.id, (g) => revolveNames(f.id, g, sketch, wp0, o, dir)) };
  }
  let distance = resolveDistance(f, scope);
  // Through-all: a length that clears the target body from any face of it, both ways when symmetric.
  if (f.extent === "throughAll") distance = throughAllLength(targetBounds) * (f.symmetric ? 2 : 1);
  if (f.direction === "reverse") distance = -distance;
  // To a face: the signed distance along the sketch normal to that face's plane, re-found on every rebuild.
  // A start offset slides the whole extrude along the sketch normal (Push/Pull on a start cap); a "to face" extrude
  // still ends at its face.
  const off = f.startOffsetExpr ? (f.startOffsetValue = resolveExpr(f.startOffsetExpr, f.startOffsetValue ?? 0, scope)) : 0;
  if (f.extent === "toFace") distance = toFaceDistance(f, wp0, bodies) - off;
  const d = Math.abs(distance) < 1e-9 ? 1e-6 : distance;
  const base = off ? offsetPlane(wp0, off) : wp0;
  const wp = f.symmetric ? offsetPlane(base, -d / 2) : base;
  const shape = buildRegionsSolid(wp, regions, d);
  const n = wp0.normal, dir = d >= 0 ? n : { x: -n.x, y: -n.y, z: -n.z };
  return { shape, names: nameSafely(shape, f.id, (g) => extrudeNames(f.id, g, sketch, wp0, dir)) };
}

/** How far an extrude must go along its sketch's normal to reach its `toFace` (negative = against the normal). */
function toFaceDistance(f: ExtrudeFeature, wp: WorkPlane, bodies: Body[]): number {
  if (!f.toFace) throw new Error("extrude to a face: no face chosen");
  const tp = resolveFacePlane(bodies, f.toFace);
  if (!tp) throw new Error("extrude to a face: that face is gone");
  if (Math.abs(dot(tp.normal, wp.normal)) < 1 - 1e-6) throw new Error("extrude to a face: the face must be parallel to the sketch (an angled face is not supported yet)");
  const d = dot({ x: tp.origin.x - wp.origin.x, y: tp.origin.y - wp.origin.y, z: tp.origin.z - wp.origin.z }, wp.normal);
  if (Math.abs(d) < 1e-6) throw new Error("extrude to a face: the face is in the sketch's own plane");
  f.distanceValue = d;
  return d;
}

/** A solid plus the topological names of its faces (in face order). */
interface Named { shape: Shape3D; names: string[] }

/** Name a freshly built solid's faces; if a namer can't make sense of them, fall back to geometry-only names. */
function nameSafely(shape: Shape3D, featureId: string, namer: (g: FaceGeom[]) => string[]): string[] {
  const geoms = faceGeoms(shape);
  try { return namer(geoms); } catch { return genericNames(featureId, geoms); }
}
const named = (shape: Shape3D, featureId: string): Named => ({ shape, names: genericNames(featureId, faceKinds(shape)) });

interface Body {
  id: string; name: string; sketchId: string; distance: number; shape: Shape3D; decals?: ThreadDecal[];
  /** A gear placed as is: its local solid's key, where it was put, and the shape it put there (once
   *  another feature changes the body, its shape is another and the pose no longer describes it). */
  pose?: { key: string; T: Rigid; shape: Shape3D; sharp?: Parameters<typeof localGearSolid>[0] };
  /** Round bodies (a gear, a pin): annuli about world axes that hold all of `shape` — what a
   *  collision check rules pairs out with before a boolean. Stale once the shape is another. */
  hull?: { shape: Shape3D; parts: Hull[] };
  /** Topological name of each face of `shape`, in face order. */
  faceNames: string[];
  /** Content signature of this body's shape (set when evaluating with a cache). */
  sig?: string;
  /** The frame that content is expressed in — the step that last changed the body did its work
   *  relative to it (see stepFrame), so the same body somewhere else has the same signature. */
  frame?: Rigid;
  /** Set on a structural member: what the cut list needs. */
  member?: MemberMeta;
  /** Set on a sheet-metal body: its flat state and folds (what flanges, folds and the flat pattern build on). */
  sheet?: SheetState;
}

/** A member's axis (start, unit direction), profile name and end-cut angles. */
interface MemberMeta { origin: Vec3; axis: Vec3; profile: string; angles: [number, number] }

/** Row for a feature that modifies bodies but makes none (listed in the inspector/timeline, not rendered). */
const modifierRow = (f: FeatureDef): SolidEval => ({ featureId: f.id, name: f.name, sketchId: "", distance: 0 });

/** The body a modifier/boolean targets: a specific one by its creating-feature id
 *  (`body`), else the most recent. Bodies are named by the feature that created
 *  them, so `body` is an extrude/revolve/primitive/loft/sweep id. */
function pickBody(bodies: Body[], ref: string | undefined, what: string): Body {
  if (!bodies.length) throw new Error(`${what}: no body to modify yet`);
  if (!ref || ref === "last") return bodies[bodies.length - 1];
  const b = bodies.find((x) => x.id === ref);
  if (!b) throw new Error(`${what}: no body "${ref}" (a body is named by the feature that created it)`);
  return b;
}

/** Replace a body's shape, freeing the old one. */
function replaceShape(body: Body, next: Shape3D) {
  body.shape.delete();
  body.shape = next;
  // a sheet changed by any other feature no longer matches its flat state
  if (body.sheet) body.sheet = { ...body.sheet, edited: true };
}

const BOOLEAN: Record<BooleanOp, BooleanKind> = { new: "fuse", join: "fuse", cut: "cut", intersect: "intersect" };

/** Fold `tool` into `target` by a boolean, carrying face names through the
 *  kernel's history. Does not free `tool`. */
function booleanInto(op: BooleanOp, target: Body, tool: Shape3D | Shape3D[], toolNames: string[], featureId: string) {
  const { shape, parents } = booleanWithHistory(BOOLEAN[op], target.shape, tool);
  const names = inheritNames([...target.faceNames, ...toolNames], parents, shape, featureId, "new");
  replaceShape(target, shape);
  target.faceNames = names;
}

const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => a.x * b.x + a.y * b.y + a.z * b.z;

/** The frame of a planar face, built with the same origin convention as
 *  creation (foot of the perpendicular from the world origin), so the sketch's
 *  (u,v) geometry maps consistently as the face moves. */
const faceFrame = (center: Vec3, n: Vec3): WorkPlane => { const off = dot(center, n); return makePlaneFromNormal({ x: n.x * off, y: n.y * off, z: n.z * off }, n); };

/**
 * Re-resolve the current plane of the face a sketch references. A pinned face
 * name wins: the planar face carrying that name (the piece nearest the
 * original pick point if the face was split), wherever upstream edits moved or
 * turned it. Otherwise (an unnamed ref, or a name that no longer exists) match
 * the stored normal against the live planar faces, tie-broken by nearness to
 * the original pick point.
 */
function resolveFacePlane(bodies: Body[], ref: FaceRef): WorkPlane | undefined {
  const near = (c: Vec3) => (c.x - ref.point.x) ** 2 + (c.y - ref.point.y) ** 2 + (c.z - ref.point.z) ** 2;
  if (ref.name) {
    let best: { g: FaceGeom; d: number } | undefined;
    for (const b of bodies) {
      if (!b.faceNames.includes(ref.name)) continue;
      let geoms: FaceGeom[];
      try { geoms = faceGeoms(b.shape); } catch { continue; }
      geoms.forEach((g, i) => {
        if (b.faceNames[i] !== ref.name || g.type !== "PLANE") return;
        const d = near(g.center);
        if (!best || d < best.d) best = { g, d };
      });
    }
    if (best) return faceFrame(best.g.center, best.g.normal);
  }
  const faces: PlanarFace[] = [];
  for (const b of bodies) {
    try { faces.push(...planarFacesOfShape(b.shape)); } catch { /* skip a bad body */ }
  }
  let best: PlanarFace | undefined;
  let bestScore = Infinity;
  for (const f of faces) {
    const align = dot(f.normal, ref.normal); // both ~unit; ~1 when same direction
    if (align < 0.99) continue; // only faces pointing the same way as the pick
    const score = near(f.origin); // nearest centroid to the pick
    if (score < bestScore) { bestScore = score; best = f; }
  }
  return best ? faceFrame(best.origin, best.normal) : undefined;
}

/** Resolve the plane a mirror reflects across (origin plane or a datum frame). */
function mirrorPlane(doc: CadDocument, f: MirrorFeature): WorkPlane {
  if (["XY", "XZ", "YZ"].includes(f.plane)) return planeById(f.plane);
  const dp = doc.planes[f.plane]?.plane;
  if (!dp) throw new Error(`mirror plane "${f.plane}" not found`);
  return dp;
}

/** Fold an extrude/revolve into the running body list via its boolean op. */
function applySketchFeature(doc: CadDocument, scope: Scope, f: SketchFeature, bodies: Body[], out: Record<string, SolidEval>) {
  const distance = f.kind === "extrude" ? resolveDistance(f, scope) : 0;
  // A sketch on a body face re-resolves to the face's CURRENT plane against the
  // bodies built so far, so it tracks the face when upstream geometry changes.
  const sketch = doc.sketches[f.sketchId];
  if (sketch?.faceRef && bodies.length) {
    const wp = resolveFacePlane(bodies, sketch.faceRef);
    if (wp) sketch.plane = wp; // also the frame the ghost render / next pass uses
  }
  const op = f.operation ?? "new";
  const target = op !== "new" && bodies.length ? pickBody(bodies, f.body, f.kind) : undefined;
  let tool: Named;
  try {
    tool = buildFeatureSolid(doc, scope, f, target ? safeBounds(target.shape) : undefined, bodies);
  } catch (e) {
    out[f.id] = { featureId: f.id, name: f.name, sketchId: f.sketchId, distance, error: kernelErrorMessage(e) };
    return;
  }
  if (!target) {
    const parts = f.kind === "extrude" ? roundExtrudeHull(doc, f, distance) : undefined;
    bodies.push({ id: f.id, name: f.name, sketchId: f.sketchId, distance, shape: tool.shape, faceNames: tool.names, ...(parts ? { hull: { shape: tool.shape, parts } } : {}) });
    return;
  }
  try {
    const before = volumeOfShape(target.shape);
    booleanInto(op, target, tool.shape, tool.names, f.id);
    const after = volumeOfShape(target.shape);
    // A boolean that changed nothing almost always means the tool missed the body
    // (wrong plane offset / direction) — say so instead of failing silently.
    if (Number.isFinite(before) && Number.isFinite(after) && Math.abs(after - before) <= 1e-6 * Math.max(1, before)) {
      const msg = `${op} changed nothing: the ${f.kind} does not intersect the body (check plane offset, direction, extent)`;
      out[f.id] = { ...modifierRow(f), sketchId: f.sketchId, distance, ...(f.requireEffect ? { error: msg } : { warning: msg }) };
    }
  } catch (e) {
    out[f.id] = { featureId: f.id, name: f.name, sketchId: f.sketchId, distance, error: kernelErrorMessage(e) };
  } finally {
    tool.shape.delete();
  }
}

/** An extrude of circles only (each with at most concentric circular holes): its annuli, for the
 *  collision check's prefilter. Undefined for anything else. */
function roundExtrudeHull(doc: CadDocument, f: ExtrudeFeature, distance: number): Hull[] | undefined {
  if (f.extent && f.extent !== "blind") return undefined;
  const sketch = doc.sketches[f.sketchId];
  if (!sketch) return undefined;
  const regions = featureRegions(doc, f);
  if (!regions.length || !regions.every((r) => r.outer.circle && r.holes.length <= 1 && r.holes.every((h) => h.circle && Math.hypot(h.circle.center.x - r.outer.circle!.center.x, h.circle.center.y - r.outer.circle!.center.y) < 1e-9))) return undefined;
  const wp = resolveSketchPlane(sketch);
  let d = f.direction === "reverse" ? -distance : distance;
  let z0 = f.startOffsetValue ?? 0;
  if (f.symmetric) z0 -= Math.abs(d) / 2, d = Math.abs(d);
  const lo = Math.min(z0, z0 + d), hi = Math.max(z0, z0 + d);
  return regions.map((r) => {
    const c = r.outer.circle!;
    return { o: to3d(wp, c.center.x, c.center.y), d: wp.normal, rIn: r.holes[0]?.circle ? Math.max(0, r.holes[0].circle.r - 1e-3) : 0, rOut: c.r + 1e-3, z0: lo, z1: hi };
  });
}

function safeBounds(shape: Shape3D): Bounds3 | undefined {
  try { return boundsOfShape(shape); } catch { return undefined; }
}

/** Fold a freshly built solid into an existing body via a boolean op, detecting a
 *  no-op (tool missed the body). Consumes `tool`. On a no-op or failure it writes
 *  a modifier row for the feature (error when it opted into `requireEffect`). */
function combineBody(op: BooleanOp, target: Body, tool: Named, f: FeatureDef & { requireEffect?: boolean }, label: string, out: Record<string, SolidEval>) {
  try {
    const before = volumeOfShape(target.shape);
    booleanInto(op, target, tool.shape, tool.names, f.id);
    const after = volumeOfShape(target.shape);
    if (Number.isFinite(before) && Number.isFinite(after) && Math.abs(after - before) <= 1e-6 * Math.max(1, Math.abs(before))) {
      const msg = `${op} changed nothing: the ${label} does not intersect the body (check position, size, operation)`;
      out[f.id] = { ...modifierRow(f), ...(f.requireEffect ? { error: msg } : { warning: msg }) };
    }
  } catch (e) {
    out[f.id] = { ...modifierRow(f), error: kernelErrorMessage(e) };
  } finally {
    tool.shape.delete();
  }
}

/** Start a new body, or fold the tool into the target per the feature's boolean op. */
function addOrCombine(f: FeatureDef & { operation?: BooleanOp; body?: string; requireEffect?: boolean }, tool: Named, bodies: Body[], out: Record<string, SolidEval>, label: string, sketchId = "") {
  const op = f.operation ?? "new";
  const target = op !== "new" && bodies.length ? pickBody(bodies, f.body, label) : undefined;
  // a new body belongs to the component of the sketch it was built from (its material, its visibility)
  if (!target) { bodies.push({ id: f.id, name: f.name, sketchId, distance: 0, shape: tool.shape, faceNames: tool.names }); return; }
  combineBody(op, target, tool, f, label, out);
}

/** Build a primitive solid (box/cylinder/cone/sphere/torus) and fold it in. */
function applyPrimitive(scope: Scope, f: PrimitiveFeature, bodies: Body[], out: Record<string, SolidEval>) {
  let tool: Named;
  try {
    const dim = (k: keyof PrimitiveFeature["dims"]): number | undefined => {
      const expr = f.dims[k];
      if (expr == null) return undefined;
      const v = resolveExpr(expr, (f.dimValues?.[k] as number) ?? 0, scope);
      (f.dimValues ??= {})[k] = v;
      return v;
    };
    tool = named(buildPrimitive({
      shape: f.shape, at: f.at ?? { x: 0, y: 0, z: 0 },
      x: dim("x"), y: dim("y"), z: dim("z"), radius: dim("radius"), radius2: dim("radius2"), height: dim("height"), tube: dim("tube"),
    }), f.id);
  } catch (e) {
    out[f.id] = { ...modifierRow(f), error: kernelErrorMessage(e) };
    return;
  }
  addOrCombine(f, tool, bodies, out, f.shape);
}

/** Per gear spec (see localGearSolid): its faces' kinds, and — once a gear of it has been meshed and
 *  measured — its display mesh and mass properties in its own frame (shared by every gear of the spec). */
const GEAR_LOCAL = new Map<string, { geoms: Pick<FaceGeom, "type" | "normal">[]; extent: Annulus[] | null; mesh?: SolidMesh; mass?: MassProps }>();

/** A mesh carried by a rigid transform (positions and edges moved, normals turned). */
function moveMesh(m: SolidMesh, T: Rigid): SolidMesh {
  const mv = (src: Float32Array, vec: boolean): Float32Array => {
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      const p = { x: src[i], y: src[i + 1], z: src[i + 2] };
      const q = vec ? applyVec(T, p) : applyPoint(T, p);
      out[i] = q.x; out[i + 1] = q.y; out[i + 2] = q.z;
    }
    return out;
  };
  return { ...cloneMesh(m), positions: mv(m.positions, false), normals: mv(m.normals, true), edges: mv(m.edges, false) };
}

/** A body evaluation carried by a rigid transform: the same mesh moved, the same volume, the centroid
 *  moved, and the moved shape's own bounds (`bounds`: a turned box would be loose). */
function posedEval(ev: BodyEval, T: Rigid, bounds: Bounds3 | undefined): BodyEval {
  return { mesh: moveMesh(ev.mesh, T), bounds, mass: { ...ev.mass, centroid: applyPoint(T, ev.mass.centroid) }, ...(ev.surface ? { surface: true } : {}) };
}

/** The box around a mesh's vertices: within the meshing tolerance of the body's own. */
function meshBounds(pos: Float32Array): Bounds3 {
  let nx = Infinity, ny = Infinity, nz = Infinity, xx = -Infinity, xy = -Infinity, xz = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < nx) nx = x; if (y < ny) ny = y; if (z < nz) nz = z;
    if (x > xx) xx = x; if (y > xy) xy = y; if (z > xz) xz = z;
  }
  return { min: { x: nx, y: ny, z: nz }, max: { x: xx, y: xy, z: xz } };
}

/** A gear's numbers now: each expression (or its default) evaluated, written back to dimValues. */
export function gearValues(f: GearFeature, scope: Scope): Record<GearDim, number> {
  const out = {} as Record<GearDim, number>;
  const val = (k: GearDim, fallback: number): number => {
    const expr = f.dims[k];
    const v = expr == null ? fallback : resolveExpr(expr, (f.dimValues?.[k] as number) ?? fallback, scope);
    (f.dimValues ??= {})[k] = v;
    out[k] = v;
    return v;
  };
  const m = val("module", 2), z = val("teeth", f.gearType === "worm" ? 1 : 20);
  const d = gearDefaults(f.gearType, m, z, f.dims.mateTeeth != null ? resolveExpr(f.dims.mateTeeth, z, scope) : z);
  for (const k of ["faceWidth", "pressureAngle", "helixAngle", "backlash", "addendum", "dedendum", "rootFillet", "rim", "mateTeeth", "wormDiameter", "bore", "dFlat", "keyway", "keywayDepth", "hubDiameter", "hubLength", "spokes", "x", "y", "offset", "rotation"] as GearDim[]) {
    val(k, d[k as keyof typeof d] ?? 0);
  }
  return out;
}

/** A gear: built in its own frame (axis +Z), placed on its sketch's plane at (x, y), `offset` up
 *  the normal and turned `rotation`° about it, then added as a body of the sketch's component. */
function applyGear(doc: CadDocument, scope: Scope, f: GearFeature, bodies: Body[], out: Record<string, SolidEval>) {
  let tool: Named;
  let pose: Body["pose"];
  try {
    const sk = doc.sketches[f.sketchId];
    if (!sk) throw new Error(`gear: no sketch "${f.sketchId}"`);
    const v = gearValues(f, scope);
    const spec: Parameters<typeof localGearSolid>[0] = {
      type: f.gearType, module: v.module, teeth: v.teeth, faceWidth: v.faceWidth, pressureAngle: v.pressureAngle, helixAngle: v.helixAngle,
      herringbone: !!f.herringbone, backlash: v.backlash, addendum: v.addendum, dedendum: v.dedendum, rootFillet: v.rootFillet, rim: v.rim,
      mateTeeth: v.mateTeeth, wormDiameter: v.wormDiameter, bore: v.bore, dFlat: v.dFlat, keyway: v.keyway, keywayDepth: v.keywayDepth > 0 ? v.keywayDepth : undefined,
      hubDiameter: v.hubDiameter, hubLength: v.hubLength, spokes: v.spokes, ...(f.chamfer ? { chamfer: true } : {}),
    };
    const { key, shape: local, warning } = localGearSolid(spec);
    if (warning) out[f.id] = { ...modifierRow(f), sketchId: f.sketchId, warning };
    const wp = resolveSketchPlane(sk);
    const a = (v.rotation * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const T: Rigid = {
      origin: { x: wp.origin.x + v.x * wp.u.x + v.y * wp.v.x + v.offset * wp.normal.x, y: wp.origin.y + v.x * wp.u.y + v.y * wp.v.y + v.offset * wp.normal.y, z: wp.origin.z + v.x * wp.u.z + v.y * wp.v.z + v.offset * wp.normal.z },
      x: { x: c * wp.u.x + s * wp.v.x, y: c * wp.u.y + s * wp.v.y, z: c * wp.u.z + s * wp.v.z },
      y: { x: -s * wp.u.x + c * wp.v.x, y: -s * wp.u.y + c * wp.v.y, z: -s * wp.u.z + c * wp.v.z },
      z: { ...wp.normal },
    };
    // faces named in the gear's own frame (so a turned gear keeps its names), from geometry kept per spec
    let local0 = GEAR_LOCAL.get(key);
    if (!local0) { local0 = { geoms: faceKinds(local), extent: gearExtent(spec) }; GEAR_LOCAL.set(key, local0); while (GEAR_LOCAL.size > 48) GEAR_LOCAL.delete(GEAR_LOCAL.keys().next().value as string); }
    tool = { shape: placeShape(local, T), names: genericNames(f.id, local0.geoms) };
    // a gear with its edges broken collides as its sharp self (see collideFeatures)
    pose = { key, T, shape: tool.shape, ...(spec.chamfer ? { sharp: { ...spec, chamfer: undefined } } : {}) };
  } catch (e) {
    out[f.id] = { ...modifierRow(f), sketchId: f.sketchId, error: kernelErrorMessage(e) };
    return;
  }
  const op = f.operation ?? "new";
  if (op === "new" || !bodies.length) {
    const ext = GEAR_LOCAL.get(pose!.key)?.extent;
    const hull = ext ? { shape: tool.shape, parts: ext.map((e) => ({ o: pose!.T.origin, d: pose!.T.z, ...e })) } : undefined;
    bodies.push({ id: f.id, name: f.name, sketchId: f.sketchId, distance: 0, shape: tool.shape, faceNames: tool.names, pose, ...(hull ? { hull } : {}) });
    return;
  }
  combineBody(op, pickBody(bodies, f.body, "gear"), tool, f, "gear", out);
}

const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** Read an imported file into a body (or fold it into one). Faces are named by file order. */
function applyImport(f: ImportFeature, bodies: Body[], out: Record<string, SolidEval>) {
  let tool: Named;
  try {
    let shape = f.format === "brep" ? readBrep(f.data) : f.format === "stl" ? readStl(base64ToBytes(f.data)) : f.format === "nurbs" ? readNurbsBrep(f.data) : readStep(f.data);
    if (f.at && (f.at.x || f.at.y || f.at.z)) { const moved = translateShape(shape, f.at); shape.delete(); shape = moved; }
    tool = { shape, names: faceKinds(shape).map((_, i) => `${f.id}:f${i}`) };
  } catch (e) {
    out[f.id] = { ...modifierRow(f), error: `import: ${kernelErrorMessage(e)}` };
    return;
  }
  addOrCombine(f, tool, bodies, out, "import");
}

/** A member's cut length: the extent of its mesh along its axis. */
function extentAlong(positions: Float32Array, axis: Vec3): number {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const t = positions[i] * axis.x + positions[i + 1] * axis.y + positions[i + 2] * axis.z;
    lo = Math.min(lo, t); hi = Math.max(hi, t);
  }
  return hi > lo ? hi - lo : 0;
}

/**
 * Structural members: the profile extruded along each layout line (one body
 * per line, id "<feature>/<line>"), then each corner treated. A mitred corner
 * of two members cuts both on the bisector plane; a butt corner trims every
 * later member to the earlier ones; open ends can get end caps; corners of two
 * members can get a gusset plate (its own body). Members run a little past
 * each treated joint before the cut, so the corner closes fully.
 */
function applyMembers(doc: CadDocument, scope: Scope, f: MemberFeature, bodies: Body[], out: Record<string, SolidEval>) {
  out[f.id] = modifierRow(f);
  const made: Body[] = [];
  try {
    const sk = doc.sketches[f.sketchId];
    if (!sk) throw new Error(`no layout sketch "${f.sketchId}"`);
    const plane = resolveSketchPlane(sk);
    const lines = memberLines(sk, plane, f.lines);
    if (!lines.length) throw new Error("the layout sketch has no lines to lay members along");
    const num = (e: string | undefined, fallback = 0) => (e == null || e === "" ? fallback : resolveExpr(e, fallback, scope));
    const dims: ProfileDims = { kind: f.profile.kind, w: num(f.profile.w), h: num(f.profile.h), t: num(f.profile.t), d: num(f.profile.d) };
    let section: Profile;
    if (f.profile.kind === "custom") {
      const psk = f.profile.sketch && doc.sketches[f.profile.sketch];
      if (!psk) throw new Error("a custom member profile needs its profile sketch");
      const regions = extractRegions(psk);
      if (!regions.length) throw new Error("the profile sketch has no closed region");
      section = regions[0];
    } else section = standardProfile(dims);
    const label = f.profile.kind === "custom" ? `Custom (${doc.sketches[f.profile.sketch!]?.name ?? f.profile.sketch})` : profileLabel(dims);
    const reach = profileReach(section);
    const rotate = (num(f.rotateExpr) * Math.PI) / 180;
    const corner = f.corner ?? "miter";
    const up = plane.normal;
    const joints = memberJoints(lines);
    // how far each member end runs past its joint before the corner is cut
    const extend = lines.map(() => ({ a: 0, b: 0 }));
    for (const j of joints) if (j.ends.length >= 2 && corner !== "none") for (const e of j.ends) extend[e.member][e.end] = 3 * reach;

    const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
    const unit = (a: Vec3): Vec3 => { const m = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / m, y: a.y / m, z: a.z / m }; };
    const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
    const along = (p: Vec3, d: Vec3, k: number): Vec3 => ({ x: p.x + d.x * k, y: p.y + d.y * k, z: p.z + d.z * k });
    const dirs = lines.map((m) => unit(sub(m.b, m.a)));
    const angles = lines.map(() => [0, 0] as [number, number]);

    lines.forEach((m, i) => {
      const d = dirs[i];
      // profile frame: x across the member, y toward the layout plane's normal, turned by `rotate`
      let x = cross(up, d);
      if (Math.hypot(x.x, x.y, x.z) < 1e-9) x = cross({ x: 1, y: 0, z: 0 }, d);
      x = unit(x);
      const y = cross(d, x);
      const u = { x: x.x * Math.cos(rotate) + y.x * Math.sin(rotate), y: x.y * Math.cos(rotate) + y.y * Math.sin(rotate), z: x.z * Math.cos(rotate) + y.z * Math.sin(rotate) };
      const v = cross(d, u);
      const length = Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y, m.b.z - m.a.z);
      const wp: WorkPlane = { id: "custom", name: "member", origin: along(m.a, d, -extend[i].a), u, v, normal: d, color: "#888" };
      const shape = buildRegionsSolid(wp, [section], length + extend[i].a + extend[i].b);
      const id = `${f.id}/${m.lineId}`;
      made.push({ id, name: `${f.name} ${i + 1}`, sketchId: f.sketchId, distance: length, shape, faceNames: genericNames(id, faceKinds(shape)), member: { origin: m.a, axis: d, profile: label, angles: angles[i] } });
    });

    const trimTo = (b: Body, origin: Vec3, normal: Vec3) => {
      const next = keepHalfSpace(b.shape, origin, normal);
      b.faceNames = inheritNames(b.faceNames, surfaceParents(b.shape, next), next, b.id, "cut");
      replaceShape(b, next);
    };
    for (const j of joints) {
      if (j.ends.length < 2 || corner === "none") continue;
      // away-from-joint direction of each member end
      const away = j.ends.map((e) => (e.end === "a" ? dirs[e.member] : { x: -dirs[e.member].x, y: -dirs[e.member].y, z: -dirs[e.member].z }));
      if (corner === "miter" && j.ends.length === 2) {
        const [ea, eb] = j.ends, [da, db] = away;
        const n = sub(da, db);
        if (Math.hypot(n.x, n.y, n.z) < 1e-9) continue; // folded back on itself: nothing sensible to cut
        trimTo(made[ea.member], j.at, n);
        trimTo(made[eb.member], j.at, { x: -n.x, y: -n.y, z: -n.z });
        const cut = (90 - (Math.acos(Math.max(-1, Math.min(1, da.x * db.x + da.y * db.y + da.z * db.z))) * 90) / Math.PI);
        angles[ea.member][ea.end === "a" ? 0 : 1] = cut;
        angles[eb.member][eb.end === "a" ? 0 : 1] = cut;
      } else {
        // butt: the first member runs through, square, to the far side of the
        // others; each later member stops at the first one's side face (the
        // plane half its width off its axis, on the later member's side).
        const half = profileHalfWidth(section, rotate);
        const [first, ...rest] = j.ends;
        const d1 = dirs[first.member];
        trimTo(made[first.member], along(j.at, away[0], -half), away[0]);
        rest.forEach((e, k) => {
          const aw = away[k + 1];
          let m = unit(cross(up, d1));
          if (m.x * aw.x + m.y * aw.y + m.z * aw.z < 0) m = { x: -m.x, y: -m.y, z: -m.z };
          trimTo(made[e.member], along(j.at, m, half), m);
          const cos = Math.abs(m.x * aw.x + m.y * aw.y + m.z * aw.z);
          angles[e.member][e.end === "a" ? 0 : 1] = (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
        });
      }
    }
    // end caps on open ends: a plate of the profile's outline, 3 mm or the wall thickness
    if (f.endCaps) {
      const capT = dims.t > 0 ? dims.t : 3;
      for (const j of joints) {
        if (j.ends.length !== 1) continue;
        const e = j.ends[0], b = made[e.member], d = dirs[e.member];
        const outward = e.end === "a" ? { x: -d.x, y: -d.y, z: -d.z } : d;
        let x = cross(up, d); if (Math.hypot(x.x, x.y, x.z) < 1e-9) x = cross({ x: 1, y: 0, z: 0 }, d); x = unit(x);
        const y = cross(d, x);
        const u = { x: x.x * Math.cos(rotate) + y.x * Math.sin(rotate), y: x.y * Math.cos(rotate) + y.y * Math.sin(rotate), z: x.z * Math.cos(rotate) + y.z * Math.sin(rotate) };
        const cap = buildRegionsSolid({ id: "custom", name: "cap", origin: j.at, u, v: cross(outward, u), normal: outward, color: "#888" }, [{ outer: section.outer, holes: [] }], capT);
        try { booleanInto("join", b, cap, genericNames(`${b.id}:cap`, faceKinds(cap)), f.id); } finally { cap.delete(); }
      }
    }
    // gussets: a triangular plate in the inside corner of two members, clear of them
    const gusset = num(f.gussetExpr);
    if (gusset > 0) {
      const t = dims.t > 0 ? dims.t : 3;
      let k = 0;
      for (const j of joints) {
        if (j.ends.length !== 2) continue;
        const da = j.ends[0].end === "a" ? dirs[j.ends[0].member] : { x: -dirs[j.ends[0].member].x, y: -dirs[j.ends[0].member].y, z: -dirs[j.ends[0].member].z };
        const db = j.ends[1].end === "a" ? dirs[j.ends[1].member] : { x: -dirs[j.ends[1].member].x, y: -dirs[j.ends[1].member].y, z: -dirs[j.ends[1].member].z };
        const nrm = cross(da, db);
        if (Math.hypot(nrm.x, nrm.y, nrm.z) < 1e-6) continue; // straight through: no corner
        const n = unit(nrm), u = da, vv = cross(n, u);
        const local = (p: Vec3) => ({ x: (p.x - j.at.x) * u.x + (p.y - j.at.y) * u.y + (p.z - j.at.z) * u.z, y: (p.x - j.at.x) * vv.x + (p.y - j.at.y) * vv.y + (p.z - j.at.z) * vv.z });
        const tri = [{ x: 0, y: 0 }, local(along(j.at, da, gusset)), local(along(j.at, db, gusset))];
        const loop: Loop = { start: tri[0], segments: [{ kind: "line", to: tri[1] }, { kind: "line", to: tri[2] }, { kind: "line", to: tri[0] }], area: 0 };
        let plate = buildRegionsSolid({ id: "custom", name: "gusset", origin: along(j.at, n, -t / 2), u, v: vv, normal: n, color: "#888" }, [{ outer: loop, holes: [] }], t);
        for (const e of j.ends) { const next = cutShapes(plate, made[e.member].shape); plate.delete(); plate = next; }
        const id = `${f.id}/gusset${++k}`;
        made.push({ id, name: `${f.name} gusset ${k}`, sketchId: f.sketchId, distance: 0, shape: plate, faceNames: genericNames(id, faceKinds(plate)) });
      }
    }
    bodies.push(...made);
  } catch (e) {
    for (const b of made) { try { b.shape.delete(); } catch { /* already freed */ } }
    out[f.id].error = kernelErrorMessage(e);
  }
}

// ---- sheet metal (and paper) ------------------------------------------------

/** An expression that must evaluate (a sheet's dimensions have no sensible fallback). */
function strictExpr(expr: string, what: string, scope: Scope): number {
  let v = NaN;
  try { v = compileExpr(expr).eval(scope); } catch { /* reported below */ }
  if (!Number.isFinite(v)) throw new Error(`${what} "${expr}" doesn't evaluate to a number`);
  return v;
}
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Swap a sheet body's geometry for a freshly built state. */
function setSheet(b: Body, built: SheetBuild) {
  b.shape.delete();
  b.shape = built.shape;
  b.faceNames = genericNames(b.id, faceKinds(built.shape));
  b.sheet = { ...built.state, pattern: built.pattern };
}

/** The sheet body a sheet feature works on (still a plain sheet: not changed by another feature since). */
function sheetBody(bodies: Body[], ref: string | undefined, what: string): Body & { sheet: SheetState } {
  const b = pickBody(bodies, ref, what);
  if (!b.sheet) throw new Error(`${what}: "${b.id}" isn't a sheet-metal body`);
  if (b.sheet.edited && !b.sheet.unfolded) throw new Error(`${what}: "${b.id}" was changed by another feature after it was folded — unfold it (feature.unfold), make the change while flat, then refold`);
  return b as Body & { sheet: SheetState };
}

/** The open run of straight lines in a sketch, in order, with their ids (a contour flange's profile). */
function contourPolyline(sk: CadDocument["sketches"][string]): { pts: { x: number; y: number }[]; ids: string[] } {
  const lines = Object.values(sk.entities).filter((e) => e.kind === "line" && !e.construction) as { id: string; p1: string; p2: string }[];
  if (Object.values(sk.entities).some((e) => (e.kind === "arc" || e.kind === "spline") && !e.construction)) throw new Error("a contour flange takes straight lines (the bends round its corners)");
  if (!lines.length) throw new Error(`sketch "${sk.name}" has no lines`);
  const at = new Map<string, typeof lines>();
  for (const l of lines) for (const p of [l.p1, l.p2]) at.set(p, [...(at.get(p) ?? []), l]);
  const ends = [...at.entries()].filter(([, ls]) => ls.length === 1).map(([p]) => p);
  if ([...at.values()].some((ls) => ls.length > 2) || ends.length !== 2) throw new Error("a contour flange needs one open, unbranched run of lines");
  const pt = (id: string) => { const p = sk.entities[id] as { x: number; y: number }; return { x: p.x, y: p.y }; };
  let cur = ends.sort()[0];
  const pts = [pt(cur)], ids: string[] = [], used = new Set<string>();
  for (;;) {
    const next = (at.get(cur) ?? []).find((l) => !used.has(l.id));
    if (!next) break;
    used.add(next.id);
    ids.push(next.id);
    cur = next.p1 === cur ? next.p2 : next.p1;
    pts.push(pt(cur));
  }
  return { pts, ids };
}

function applySheet(doc: CadDocument, scope: Scope, f: SheetFeature, bodies: Body[], out: Record<string, SolidEval>) {
  out[f.id] = modifierRow(f);
  try {
    const sk = doc.sketches[f.sketchId];
    if (!sk) throw new Error(`no sketch "${f.sketchId}"`);
    const wp = resolveSketchPlane(sk);
    const t = strictExpr(f.thicknessExpr, "thickness", scope);
    if (t < 0) throw new Error("the thickness can't be negative");
    const r = f.radiusExpr != null && f.radiusExpr !== "" ? strictExpr(f.radiusExpr, "bend radius", scope) : t;
    const k = f.kFactorExpr ? strictExpr(f.kFactorExpr, "K-factor", scope) : 0.5;
    if (r < 0) throw new Error("the bend radius can't be negative");
    if (!(k >= 0 && k <= 1)) throw new Error("the K-factor is between 0 and 1");
    const reliefWidth = f.reliefWidthExpr ? strictExpr(f.reliefWidthExpr, "relief width", scope) : t > 0 ? t : 1;
    const rules = { thickness: t, kFactor: k, radius: r, reliefWidth };
    const N = wp.normal;
    let state: SheetState;
    if (f.mode === "contour") {
      const { pts, ids } = contourPolyline(sk);
      const width = strictExpr(f.widthExpr ?? "10", "width", scope);
      if (!(width > 0)) throw new Error("a contour flange needs a positive width");
      const cb = contourBlank(pts, ids, width, !!f.flip, rules, f.id);
      const e0 = { x: wp.u.x * cb.startDir.x + wp.v.x * cb.startDir.y, y: wp.u.y * cb.startDir.x + wp.v.y * cb.startDir.y, z: wp.u.z * cb.startDir.x + wp.v.z * cb.startDir.y };
      const cr = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
      const z = f.flip ? cr(N, e0) : cr(e0, N);
      state = { frame: { origin: to3d(wp, pts[0].x, pts[0].y), x: e0, y: cr(z, e0), z }, base: { regions: cb.regions }, ops: [], edges: cb.edges, folds: cb.folds, ...rules, fixed: cb.fixed };
    } else {
      const regions = extractRegions(sk);
      if (!regions.length) throw new Error(`sketch "${sk.name}" has no closed region for the blank`);
      const pt = (id: string) => { const p = sk.entities[id] as { x: number; y: number } | undefined; if (!p) throw new Error(`sketch point "${id}" is missing`); return { x: p.x, y: p.y }; };
      const lines = Object.values(sk.entities).filter((e) => e.kind === "line" && !e.construction).map((e) => { const l = e as { id: string; p1: string; p2: string }; return { id: l.id, a: pt(l.p1), b: pt(l.p2) }; });
      const folds: SheetFold[] = (f.folds ?? []).map((fd) => {
        const l = sk.entities[fd.line];
        if (!l || l.kind !== "line") throw new Error(`fold "${fd.line}" isn't a line of sketch "${sk.name}"`);
        const angle = fd.angleExpr != null && fd.angleExpr !== "" ? rad(strictExpr(fd.angleExpr, `fold ${fd.line} angle`, scope)) : undefined;
        const radius = fd.radiusExpr != null && fd.radiusExpr !== "" ? strictExpr(fd.radiusExpr, `fold ${fd.line} radius`, scope) : r;
        const direction: 1 | -1 = fd.direction === "mountain" ? -1 : fd.direction === "valley" ? 1 : angle != null && angle < 0 ? -1 : 1;
        // folds made in steps are sharp creases; a line may serve two steps (turn about it, then fold along it)
        // (a crease of a collapse without an angle is solved, starting its way by `direction`)
        if (fd.step != null) return { id: fd.line, a: pt(l.p1), b: pt(l.p2), angle: angle ?? (fd.collapse ? direction : undefined), direction, radius: 0, step: fd.step, ...(fd.collapse && angle == null ? { solve: true } : {}), ...(fd.turn ? { turn: true } : {}), ...(fd.flip ? { flip: true } : {}), ...(fd.collapse ? { collapse: true } : {}), ...(fd.with ? { with: fd.with } : {}), ...(fd.through ? { through: fd.through } : {}), ...(fd.depth != null ? { depth: fd.depth } : {}), ...(fd.bend ? { bend: true } : {}) };
        return { id: fd.line, a: pt(l.p1), b: pt(l.p2), angle, direction, radius, extend: radius > 0 };
      });
      const origin = f.flip ? { x: wp.origin.x - N.x * t, y: wp.origin.y - N.y * t, z: wp.origin.z - N.z * t } : wp.origin;
      state = { frame: { origin, x: wp.u, y: wp.v, z: N }, base: { regions }, ops: [], edges: blankEdges(regions, lines), folds, ...rules, fixed: f.fixed ?? regions[0].interior };
      if (f.progressExpr != null && f.progressExpr !== "") state.progress = strictExpr(f.progressExpr, "progress", scope);
    }
    const built = buildSheet(state);
    bodies.push({ id: f.id, name: f.name, sketchId: f.sketchId, distance: t, shape: built.shape, faceNames: genericNames(f.id, faceKinds(built.shape)), sheet: { ...built.state, pattern: built.pattern } });
    if (built.warnings.length) out[f.id].warning = built.warnings.join("; ");
  } catch (e) {
    out[f.id].error = kernelErrorMessage(e);
  }
}

function applyFlange(scope: Scope, f: FlangeFeature, bodies: Body[], out: Record<string, SolidEval>) {
  out[f.id] = modifierRow(f);
  try {
    const b = sheetBody(bodies, f.body, "flange");
    if (b.sheet.unfolded) throw new Error("flange: refold the sheet first");
    if (isSequenced(b.sheet)) throw new Error("flange: this sheet is folded in steps (paper) — add the fold as another step instead");
    const angle = rad(strictExpr(f.angleExpr ?? (f.hem ? "180" : "90"), "flange angle", scope));
    const radius = f.radiusExpr != null && f.radiusExpr !== "" ? strictExpr(f.radiusExpr, "flange radius", scope) : f.hem ? 0 : b.sheet.radius;
    const length = strictExpr(f.lengthExpr, "flange length", scope);
    const inset = (f.insetExprs ?? ["0", "0"]).map((x, i) => strictExpr(x || "0", `inset ${i + 1}`, scope)) as [number, number];
    const next = addFlange(b.sheet, f.edge, { id: f.id, length, angle, radius, position: f.position, inset });
    const built = buildSheet(next);
    setSheet(b, built);
    if (built.warnings.length) out[f.id].warning = built.warnings.join("; ");
  } catch (e) {
    out[f.id].error = kernelErrorMessage(e);
  }
}

function applyFold(doc: CadDocument, scope: Scope, f: FoldFeature, bodies: Body[], out: Record<string, SolidEval>) {
  out[f.id] = modifierRow(f);
  try {
    const b = sheetBody(bodies, f.body, "fold");
    const s = b.sheet;
    if (s.unfolded) throw new Error("fold: refold the sheet first");
    if (isSequenced(s)) throw new Error("fold: this sheet is folded in steps — add the fold to it as another step instead");
    const sk = doc.sketches[f.sketchId];
    if (!sk) throw new Error(`no sketch "${f.sketchId}"`);
    const line = (f.line ? sk.entities[f.line] : Object.values(sk.entities).find((e) => e.kind === "line")) as { kind: string; p1: string; p2: string } | undefined;
    if (!line || line.kind !== "line") throw new Error(f.line ? `"${f.line}" isn't a line of sketch "${sk.name}"` : `sketch "${sk.name}" has no line to fold along`);
    const wp = resolveSketchPlane(sk);
    const world = (id: string) => { const p = sk.entities[id] as { x: number; y: number }; return to3d(wp, p.x, p.y); };
    const p1 = flatPointOf(s, world(line.p1)), p2 = flatPointOf(s, world(line.p2));
    if (!p1 || !p2) throw new Error("the fold line must lie on a face of the sheet (sketch on its top or bottom)");
    if (p1.panel !== p2.panel) throw new Error("the fold line must lie within one flat face of the sheet");
    const [a, bb] = chordAcross(p1.flat, p2.flat, s.panels![p1.panel].segs);
    const angle = rad(strictExpr(f.angleExpr, "fold angle", scope));
    const radius = f.radiusExpr != null && f.radiusExpr !== "" ? strictExpr(f.radiusExpr, "fold radius", scope) : s.radius;
    const folds: SheetFold[] = f.jogExpr
      ? jogFolds(a, bb, strictExpr(f.jogExpr, "jog offset", scope), angle, radius, !!f.flip, s, f.id)
      : [{ id: f.id, ...(f.flip ? { a: bb, b: a } : { a, b: bb }), angle, direction: angle < 0 ? -1 : 1, radius, extend: true }];
    const built = buildSheet({ ...s, folds: [...s.folds, ...folds] });
    setSheet(b, built);
    if (built.warnings.length) out[f.id].warning = built.warnings.join("; ");
  } catch (e) {
    out[f.id].error = kernelErrorMessage(e);
  }
}

function applyUnfold(f: UnfoldFeature, bodies: Body[], out: Record<string, SolidEval>) {
  out[f.id] = modifierRow(f);
  try {
    const b = sheetBody(bodies, f.body, f.kind);
    const s = b.sheet;
    if (f.kind === "unfold") {
      if (s.unfolded) { out[f.id].warning = "the sheet is already flat"; return; }
      setSheet(b, buildSheet({ ...s, unfolded: true }));
      return;
    }
    if (!s.unfolded) { out[f.id].warning = "the sheet is already folded"; return; }
    // cuts made while flat become the new blank
    const next: SheetState = s.edited ? { ...s, base: { brep: flatBlankOf(b.shape, invert(s.frame), s.thickness) }, ops: [] } : s;
    const built = buildSheet({ ...next, unfolded: false });
    setSheet(b, built);
    if (built.warnings.length) out[f.id].warning = built.warnings.join("; ");
  } catch (e) {
    out[f.id].error = kernelErrorMessage(e);
  }
}

// ---- surface modelling ------------------------------------------------------

/** A surface body from sketch curves (open paths or closed loops alike). */
function applySurface(doc: CadDocument, scope: Scope, f: SurfaceFeature, bodies: Body[], out: Record<string, SolidEval>) {
  out[f.id] = modifierRow(f);
  try {
    const sketchOf = (id: string | undefined, what: string) => { const sk = id ? doc.sketches[id] : undefined; if (!sk) throw new Error(`surface ${f.mode}: no ${what} sketch`); return sk; };
    const wiresOf = (sk: ReturnType<typeof sketchOf>) => {
      const chains = extractChains(sk);
      if (!chains.length) throw new Error(`sketch "${sk.name}" has no curves`);
      return { chains, wires: chains.map((c) => chainWire(c, resolveSketchPlane(sk))) };
    };
    let shape: Shape3D;
    let names: (g: FaceGeom[]) => string[] = (g) => genericNames(f.id, g);
    if (f.mode === "extrude") {
      const sk = sketchOf(f.sketchId, "profile");
      const wp = resolveSketchPlane(sk);
      let d = resolveExpr(f.distanceExpr ?? "10", f.distanceValue ?? 10, scope);
      f.distanceValue = d;
      if (f.direction === "reverse") d = -d;
      const n = wp.normal, dir = { x: n.x * d, y: n.y * d, z: n.z * d };
      const from = f.symmetric ? { x: -dir.x / 2, y: -dir.y / 2, z: -dir.z / 2 } : undefined;
      shape = surfaceExtrude(wiresOf(sk).wires, dir, from);
      const unitDir = d >= 0 ? n : { x: -n.x, y: -n.y, z: -n.z };
      names = (g) => extrudeNames(f.id, g, sk, wp, unitDir);
    } else if (f.mode === "revolve") {
      const sk = sketchOf(f.sketchId, "profile");
      const wp = resolveSketchPlane(sk);
      if (!f.axis) throw new Error("surface revolve needs an axis");
      const o = to3d(wp, f.axis.p1.x, f.axis.p1.y), q = to3d(wp, f.axis.p2.x, f.axis.p2.y);
      const dir = { x: q.x - o.x, y: q.y - o.y, z: q.z - o.z };
      const angle = resolveExpr(f.angleExpr ?? "360", 360, scope);
      shape = surfaceRevolve(wiresOf(sk).wires, o, dir, Math.abs(angle) < 1e-9 ? 360 : angle);
      names = (g) => revolveNames(f.id, g, sk, wp, o, dir);
    } else if (f.mode === "loft") {
      const ids = f.sketchIds ?? [];
      if (ids.length < 2) throw new Error("a surface loft needs at least two section sketches");
      shape = surfaceLoft(ids.map((id) => { const { wires } = wiresOf(sketchOf(id, "section")); if (wires.length !== 1) throw new Error("each loft section sketch needs exactly one chain"); return wires[0]; }), !!f.ruled);
    } else if (f.mode === "sweep") {
      const prof = wiresOf(sketchOf(f.sketchId, "profile"));
      const path = wiresOf(sketchOf(f.pathSketch, "path"));
      if (path.wires.length !== 1) throw new Error("the sweep path sketch needs exactly one chain");
      shape = asOneShape(prof.wires.map((w) => surfaceSweep(w, path.wires[0])));
    } else {
      const { chains, wires } = wiresOf(sketchOf(f.sketchId, "boundary"));
      const closed = wires.filter((_, i) => chains[i].closed);
      if (!closed.length) throw new Error("a patch needs a closed loop to fill");
      shape = asOneShape(closed.map(planarPatch));
    }
    bodies.push({ id: f.id, name: f.name, sketchId: f.sketchId ?? "", distance: 0, shape, faceNames: nameSafely(shape, f.id, names) });
  } catch (e) {
    out[f.id].error = kernelErrorMessage(e);
  }
}
const asOneShape = (shapes: Shape3D[]): Shape3D => (shapes.length === 1 ? shapes[0] : sewShapes(shapes, 1e-6, false));

/** Sew listed bodies into the first one (shell, or solid when closed); the rest are consumed. */
function applyStitch(scope: Scope, f: StitchFeature, bodies: Body[], out: Record<string, SolidEval>) {
  out[f.id] = modifierRow(f);
  try {
    if (f.bodies.length < 2) throw new Error("stitch needs at least two bodies");
    const parts = f.bodies.map((id) => pickBody(bodies, id, "stitch"));
    const tol = Math.max(1e-7, resolveExpr(f.toleranceExpr ?? "0.01", 0.01, scope));
    const sewn = sewShapes(parts.map((b) => b.shape), tol, !!f.solid);
    // names travel by surface: sewing keeps each face's surface
    const all = parts.map((b) => b.shape);
    const parentNames = parts.flatMap((b) => b.faceNames);
    const parents = surfaceParentsOf(all, sewn);
    const target = parts[0];
    replaceShape(target, sewn);
    target.faceNames = inheritNames(parentNames, parents, sewn, f.id, "sewn");
    for (const b of parts.slice(1)) { b.shape.delete(); bodies.splice(bodies.indexOf(b), 1); }
  } catch (e) {
    out[f.id].error = kernelErrorMessage(e);
  }
}

/** Surface parents of `out`'s faces among several input shapes' faces (concatenated in order). */
function surfaceParentsOf(inputs: Shape3D[], output: Shape3D): number[][] {
  const result: number[][] = [];
  let offset = 0;
  for (const input of inputs) {
    const p = surfaceParents(input, output);
    p.forEach((ps, j) => { (result[j] ??= []).push(...ps.map((i) => i + offset)); });
    offset += faceKinds(input).length;
  }
  return result;
}

/** A surface becomes a solid with thickness on its normal side, the other, or split across both. */
function applyThicken(scope: Scope, f: ThickenFeature, bodies: Body[], out: Record<string, SolidEval>) {
  out[f.id] = modifierRow(f);
  try {
    const target = pickBody(bodies, f.body, "thicken");
    const t = resolveExpr(f.thicknessExpr, f.thicknessValue ?? 0, scope);
    f.thicknessValue = t;
    if (!(t > 0)) throw new Error("thickness must be positive");
    let solid: Shape3D;
    if (f.side === "both") {
      const shifted = offsetSurface(target.shape, -t / 2);
      try { solid = thickenShape(shifted, t); } finally { shifted.delete(); }
    } else solid = thickenShape(target.shape, f.side === "in" ? -t : t);
    if (!hasSolid(solid)) { solid.delete(); throw new Error("thicken didn't make a solid (is the body a surface?)"); }
    const names = inheritNames(target.faceNames, surfaceParents(target.shape, solid), solid, f.id, "thick", { geoms: faceGeoms(solid), offsetOf: true });
    replaceShape(target, solid);
    target.faceNames = names;
  } catch (e) {
    out[f.id].error = kernelErrorMessage(e);
  }
}

/** Trim a body by a sketch's regions (carried through everything along the sketch normal) or by another body. */
function applyTrim(doc: CadDocument, f: TrimFeature, bodies: Body[], out: Record<string, SolidEval>) {
  out[f.id] = modifierRow(f);
  try {
    const target = pickBody(bodies, f.body, "trim");
    let tool: Shape3D, owned = false;
    if (f.toolBody) {
      tool = pickBody(bodies, f.toolBody, "trim").shape;
    } else {
      const sk = f.sketchId ? doc.sketches[f.sketchId] : undefined;
      if (!sk) throw new Error("trim needs a sketch (closed regions) or a tool body");
      const regions = extractRegions(sk);
      if (!regions.length) throw new Error("the trim sketch has no closed region");
      const len = throughAllLength(safeBounds(target.shape)) * 2;
      tool = buildRegionsSolid(offsetPlane(resolveSketchPlane(sk), -len / 2), regions, len);
      owned = true;
    }
    try {
      const toolNames = genericNames(`${f.id}:tool`, faceKinds(tool));
      booleanInto(f.keep === "inside" ? "intersect" : "cut", target, tool, toolNames, f.id);
    } finally { if (owned) tool.delete(); }
  } catch (e) {
    out[f.id].error = kernelErrorMessage(e);
  }
}

/** Fill the holes trimmed into each face of a body. */
function applyUntrim(f: UntrimFeature, bodies: Body[], out: Record<string, SolidEval>) {
  out[f.id] = modifierRow(f);
  try {
    const target = pickBody(bodies, f.body, "untrim");
    const filled = untrimFaces(target.shape);
    const names = inheritNames(target.faceNames, surfaceParents(target.shape, filled), filled, f.id, "filled");
    replaceShape(target, filled);
    target.faceNames = names;
  } catch (e) {
    out[f.id].error = kernelErrorMessage(e);
  }
}

const V = {
  norm: (a: Vec3): Vec3 => { const m = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / m, y: a.y / m, z: a.z / m }; },
  cross: (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }),
  dot: (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z,
};

/** Rotate `base` so its `from` axis aligns with world `axis`, then translate to
 *  `p`. Returns a fresh shape (the base is preserved; faces keep their order). */
function placeAlong(base: Shape3D, from: Vec3, axis: Vec3, p: Vec3): Shape3D {
  const to = V.norm(axis);
  const d = Math.max(-1, Math.min(1, V.dot(from, to)));
  let rotated: Shape3D;
  if (d > 0.999999) rotated = translateShape(base, { x: 0, y: 0, z: 0 }); // same direction → clone
  else {
    const rotAxis = d < -0.999999 ? V.norm(V.cross(from, { x: 1, y: 0, z: 0 })) : V.norm(V.cross(from, to));
    const angle = d < -0.999999 ? 180 : (Math.acos(d) * 180) / Math.PI;
    rotated = rotateShape(base, angle, { x: 0, y: 0, z: 0 }, rotAxis);
  }
  if (p.x === 0 && p.y === 0 && p.z === 0) return rotated;
  const moved = translateShape(rotated, p);
  rotated.delete();
  return moved;
}

/** A −Z cutter (mouth at origin) oriented to drill along `axis` from point `p`. */
const orientCutter = (base: Shape3D, axis: Vec3, p: Vec3): Shape3D => placeAlong(base, { x: 0, y: 0, z: -1 }, axis, p);

/** A modelled thread rod (+Z) for a spec; throws if the helical sweep degenerates. */
function buildThreadRod(spec: ThreadSpec, clearance: number): Shape3D {
  return buildThread({
    form: spec.form, pitch: spec.pitch, majorDiameter: spec.diameter + clearance, length: spec.length,
    leftHand: spec.leftHand, starts: spec.starts, depth: spec.depth, custom: spec.profilePoints,
  });
}

/** The cosmetic-thread decal for a spec at a placement. */
function threadDecalOf(spec: ThreadSpec, at: ThreadDecal["at"], axis: ThreadDecal["axis"], internal: boolean): ThreadDecal {
  return { at, axis, radius: spec.diameter / 2, length: spec.length, form: spec.form, pitch: spec.pitch, starts: spec.starts, leftHand: spec.leftHand, internal, profilePoints: spec.profilePoints };
}

/** A thread at a point: external (a new rod / joined to a shaft) or internal
 *  (cut as a tap). Cosmetic threads are a plain cylinder + a shaded decal; a
 *  modelled thread is real geometry that falls back to a cosmetic decal if the
 *  kernel can't form it. */
function applyThread(f: ThreadFeature, bodies: Body[], out: Record<string, SolidEval>) {
  out[f.id] = modifierRow(f);
  const axis = f.axis ?? { x: 0, y: 0, z: 1 };
  const internal = !!f.spec.internal;
  const modeled = f.spec.representation === "modeled";

  // Cosmetic: no thread geometry — a decal on the relevant body (and a plain
  // cylinder for a standalone external thread).
  const cosmetic = (warn?: string) => {
    if (warn) out[f.id].warning = out[f.id].warning ? `${out[f.id].warning}; ${warn}` : warn;
    const decal = threadDecalOf(f.spec, f.at, axis, internal);
    const op = internal ? "cut" : (f.operation ?? "new");
    if (!internal && (op === "new" || !bodies.length)) {
      const cyl = placeAlong(buildPrimitive({ shape: "cylinder", at: { x: 0, y: 0, z: f.spec.length / 2 }, radius: f.spec.diameter / 2, height: f.spec.length }), { x: 0, y: 0, z: 1 }, axis, f.at);
      bodies.push({ id: f.id, name: f.name, sketchId: "", distance: 0, shape: cyl, faceNames: genericNames(f.id, faceKinds(cyl)), decals: [decal] });
      return;
    }
    try { (pickBody(bodies, f.body, "thread").decals ??= []).push(decal); }
    catch (e) { out[f.id].error = kernelErrorMessage(e); }
  };

  if (!modeled) { cosmetic(); return; }

  try {
    const rod = named(placeAlong(buildThreadRod(f.spec, internal ? 0.1 : 0), { x: 0, y: 0, z: 1 }, axis, f.at), f.id);
    const op = internal ? "cut" : (f.operation ?? "new");
    if (op !== "cut" && (op === "new" || !bodies.length)) { bodies.push({ id: f.id, name: f.name, sketchId: "", distance: 0, shape: rod.shape, faceNames: rod.names }); return; }
    combineBody(op, pickBody(bodies, f.body, "thread"), rod, f, "thread", out);
  } catch (e) {
    cosmetic(`modelled thread fell back to cosmetic: ${kernelErrorMessage(e)}`); // kernel couldn't form it
  }
}

/** Drill one or more holes (cut) into a body: simple / counterbore / countersink. */
function applyHole(scope: Scope, f: HoleFeature, bodies: Body[], out: Record<string, SolidEval>) {
  out[f.id] = modifierRow(f);
  try {
    const target = pickBody(bodies, f.body, "hole");
    const dia = resolveExpr(f.diameterExpr, f.diameterValue ?? 0, scope); f.diameterValue = dia;
    if (!(dia > 0)) throw new Error("hole diameter must be positive");
    const radius = dia / 2;
    const tb = safeBounds(target.shape);
    const depth = f.throughAll ? throughAllLength(tb) : resolveExpr(f.depthExpr ?? "0", f.depthValue ?? 0, scope);
    if (!f.throughAll && !(depth > 0)) throw new Error("hole needs a positive depth (or throughAll)");
    f.depthValue = depth;
    const spec: HoleCutterSpec = { radius, depth, drillPoint: !f.throughAll && f.bottom === "drill" };
    if (f.counterbore) spec.counterbore = { radius: resolveExpr(f.counterbore.diameterExpr, 0, scope) / 2, depth: resolveExpr(f.counterbore.depthExpr, 0, scope) };
    if (f.countersink) spec.countersink = { radius: resolveExpr(f.countersink.diameterExpr, 0, scope) / 2, angle: resolveExpr(f.countersink.angleExpr ?? "90", 90, scope) };
    const base = buildHoleCutter(spec);
    const baseNames = nameSafely(base, f.id, (g) => holeCutterNames(f.id, g, { radius, depth, counterbore: spec.counterbore }));
    const axis = f.axis ?? { x: 0, y: 0, z: -1 };
    const pts = f.at && f.at.length ? f.at : [{ x: 0, y: 0, z: 0 }];
    // several holes in one feature: tag each one's faces with its (1-based) index
    const namesAt = (names: string[], i: number) => (pts.length > 1 ? names.map((n) => `${n}@${i + 1}`) : names);
    const before = volumeOfShape(target.shape);
    try {
      pts.forEach((p, i) => {
        const cutter = orientCutter(base, axis, p);
        try { booleanInto("cut", target, cutter, namesAt(baseNames, i), f.id); }
        finally { cutter.delete(); }
      });
    } finally { base.delete(); }
    // Threaded hole: cosmetic = a decal per bore; modelled = cut a tap (a thread
    // rod at the nominal/major diameter) from each bore, so the hole should be
    // drilled at the tap-drill (minor) diameter.
    if (f.thread) {
      const addDecals = (warn?: string) => {
        if (warn) out[f.id].warning = out[f.id].warning ? `${out[f.id].warning}; ${warn}` : warn;
        target.decals ??= [];
        for (const p of pts) target.decals.push(threadDecalOf(f.thread!, p, axis, true));
      };
      if (f.thread.representation === "modeled") {
        try {
          const shape = buildThreadRod(f.thread, 0.1);
          try {
            const tapNames = genericNames(`${f.id}:tap`, faceKinds(shape));
            pts.forEach((p, i) => {
              const tap = placeAlong(shape, { x: 0, y: 0, z: 1 }, axis, p);
              try { booleanInto("cut", target, tap, namesAt(tapNames, i), f.id); }
              finally { tap.delete(); }
            });
          } finally { shape.delete(); }
        } catch (e) { addDecals(`modelled thread fell back to cosmetic: ${kernelErrorMessage(e)}`); }
      } else {
        addDecals();
      }
    }
    const after = volumeOfShape(target.shape);
    if (Number.isFinite(before) && Number.isFinite(after) && Math.abs(after - before) <= 1e-6 * Math.max(1, before)) {
      const msg = "hole changed nothing: it does not meet the body (check at / axis / depth)";
      if (f.requireEffect) out[f.id].error = msg; else out[f.id].warning = msg;
    }
  } catch (e) {
    out[f.id].error = kernelErrorMessage(e);
  }
}

/** Sweep the feature's profile along its path sketch, then combine it. */
function applySweep(doc: CadDocument, scope: Scope, f: SweepFeature, bodies: Body[], out: Record<string, SolidEval>) {
  let tool: Named;
  if (f.path3d) {
    let spec: SpineSweepSpec;
    try { spec = spineSweepSpec(doc, scope, f); tool = named(buildSpineSweep(spec), f.id); }
    catch (e) { out[f.id] = { ...modifierRow(f), sketchId: f.profileSketch, error: kernelErrorMessage(e) }; return; }
    const parts = (f.operation ?? "new") === "new" ? straightSweepHull(spec) : undefined;
    if (parts) { bodies.push({ id: f.id, name: f.name, sketchId: f.profileSketch, distance: 0, shape: tool.shape, faceNames: tool.names, hull: { shape: tool.shape, parts } }); return; }
    addOrCombine(f, tool, bodies, out, "sweep", f.profileSketch);
    return;
  }
  try {
    const profileSk = doc.sketches[f.profileSketch];
    const pathSk = doc.sketches[f.pathSketch];
    if (!profileSk) throw new Error(`sweep: no profile sketch "${f.profileSketch}"`);
    if (!pathSk) throw new Error(`sweep: no path sketch "${f.pathSketch}"`);
    const regions = extractRegions(profileSk);
    if (!regions.length) throw new Error("sweep: profile sketch has no closed region");
    const path = extractOpenPath(pathSk);
    if (!path) throw new Error("sweep: path sketch has no open chain of lines/arcs");
    tool = named(buildSweepSolid(regions[0], resolveSketchPlane(pathSk), path), f.id);
  } catch (e) {
    out[f.id] = { ...modifierRow(f), error: kernelErrorMessage(e) };
    return;
  }
  addOrCombine(f, tool, bodies, out, "sweep", f.profileSketch);
}

/** The annulus that holds a sweep along a STRAIGHT 3D path (a grip, a collar, a
 *  plug), for the collision check to rule pairs out without a boolean: its
 *  sections are drawn about the axis, so out to their farthest point, in to the
 *  nearest point of a hole the axis runs through (scaled by the law's extremes).
 *  Undefined for a bent path. */
function straightSweepHull(spec: SpineSweepSpec): Hull[] | undefined {
  const P = spec.spine.poles, n = P.length / 3;
  const a = { x: P[0], y: P[1], z: P[2] }, b = { x: P[3 * n - 3], y: P[3 * n - 2], z: P[3 * n - 1] };
  const L = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  if (!(L > 1e-9)) return undefined;
  const d = { x: (b.x - a.x) / L, y: (b.y - a.y) / L, z: (b.z - a.z) / L };
  for (let i = 0; i < n; i++) {
    const w = { x: P[3 * i] - a.x, y: P[3 * i + 1] - a.y, z: P[3 * i + 2] - a.z }, t = w.x * d.x + w.y * d.y + w.z * d.z;
    if (Math.hypot(w.x - t * d.x, w.y - t * d.y, w.z - t * d.z) > 1e-6) return undefined;
  }
  const kMax = spec.law ? Math.max(...spec.law.value) : 1, kMin = spec.law ? Math.min(...spec.law.value) : 1;
  let rOut = 0, rIn = Infinity;
  for (const s of spec.sections) {
    for (const p of loopPolygon(s.region.outer)) rOut = Math.max(rOut, Math.hypot(p.x, p.y));
    const bore = s.region.holes.map(loopPolygon).find((poly) => pointInPolygon({ x: 0, y: 0 }, poly));
    rIn = Math.min(rIn, bore ? Math.min(...bore.map((p) => Math.hypot(p.x, p.y))) : 0);
  }
  // the polygons are sampled on the curves: allow for what runs between the samples
  return [{ o: a, d, rIn: Math.max(0, rIn * kMin * Math.cos(Math.PI / 24) - 0.01), rOut: rOut * kMax * 1.01 + 0.01, z0: 0, z1: L }];
}

function pointInPolygon(p: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** A sweep's 3D path resolved: its spine in world space (the points framed by
 *  the path sketch's plane), the sections placed square to it, the scale law. */
export function spineSweepSpec(doc: CadDocument, scope: Scope, f: SweepFeature): SpineSweepSpec {
  const p3 = f.path3d!;
  const frameSk = doc.sketches[f.pathSketch];
  if (!frameSk) throw new Error(`sweep: no path sketch "${f.pathSketch}"`);
  const wp = resolveSketchPlane(frameSk);
  const num = (e: string, what: string, extra?: Scope): number => {
    const v = compileExpr(e).eval(extra ? { ...scope, ...extra } : scope);
    if (!Number.isFinite(v)) throw new Error(`sweep: ${what} "${e}" is not a number`);
    return v;
  };
  const pts = p3.points.map((q, i) => {
    const x = num(q.x, `point ${i + 1} x`), y = num(q.y, `point ${i + 1} y`), z = num(q.z, `point ${i + 1} z`);
    return { x: wp.origin.x + x * wp.u.x + y * wp.v.x + z * wp.normal.x, y: wp.origin.y + x * wp.u.y + y * wp.v.y + z * wp.normal.y, z: wp.origin.z + x * wp.u.z + y * wp.v.z + z * wp.normal.z };
  });
  if (pts.length < 2) throw new Error("sweep: a 3D path needs at least two points");
  const spine = p3.through ? throughSpine(pts) : controlSpine(pts);
  const tab = spineTable(spine);
  const extra = { pathLength: tab.length };
  const up = p3.up ?? wp.normal;
  const regionOf = (sid: string) => {
    const sk = doc.sketches[sid];
    if (!sk) throw new Error(`sweep: no section sketch "${sid}"`);
    const regions = extractRegions(sk);
    if (!regions.length) throw new Error(`sweep: section sketch "${sk.name}" has no closed region`);
    return regions[0];
  };
  const placed = (f.sections?.length ? f.sections : [{ sketch: f.profileSketch, at: "0" }])
    .map((s, i) => ({ s: num(s.at, `section ${i + 1} position`, extra), region: regionOf(s.sketch) }))
    .sort((a, b) => a.s - b.s);
  for (let i = 1; i < placed.length; i++) if (placed[i].s - placed[i - 1].s < 1e-3) throw new Error("sweep: two sections sit at the same place on the path");
  let prev: WorkPlane | undefined;
  const sections = placed.map((p) => { prev = sectionPlane(spine, paramAtLength(tab, p.s), up, prev); return { wp: prev, region: p.region }; });
  let law: SpineSweepSpec["law"];
  if (f.scale?.length) {
    if (placed.length > 1) throw new Error("sweep: a scale law takes one profile, not several sections");
    const stations = f.scale.map((st, i) => ({ at: num(st.at, `scale station ${i + 1}`, extra), value: num(st.value, `scale ${i + 1}`, extra) }));
    if (stations.some((st) => !(st.value > 0))) throw new Error("sweep: a scale must be above zero");
    const value = easedLaw(stations);
    const n = 160, t: number[] = [], v: number[] = [];
    for (let k = 0; k <= n; k++) { const s = (tab.length * k) / n; t.push(paramAtLength(tab, s)); v.push(value(s)); }
    // the single profile sits at the path's start, at the law's first scale
    law = { t, value: v };
  }
  // the frame the sections ride: a guide curve a fixed height "up" off the spine (C2 like it),
  // so every section stays square to the spine, upright, and the surface stays C2
  // (lifted by half the tightest bend's radius at most, so the guide never folds over itself)
  const guidePts: Vec3[] = [];
  let gp: WorkPlane | undefined, kMax = 0;
  const nG = Math.max(24, 6 * (spine.poles.length / 3));
  for (let k = 0; k <= 4 * nG; k++) {
    const { d1, d2 } = curveDerivs(spine, k / (4 * nG));
    const c = { x: d1.y * d2.z - d1.z * d2.y, y: d1.z * d2.x - d1.x * d2.z, z: d1.x * d2.y - d1.y * d2.x };
    kMax = Math.max(kMax, Math.hypot(c.x, c.y, c.z) / Math.max(1e-12, Math.hypot(d1.x, d1.y, d1.z) ** 3));
  }
  const lift = Math.max(0.5, Math.min(50, kMax > 0 ? 0.5 / kMax : 50));
  for (let k = 0; k <= nG; k++) { gp = sectionPlane(spine, paramAtLength(tab, (tab.length * k) / nG), up, gp); guidePts.push({ x: gp.origin.x + lift * gp.v.x, y: gp.origin.y + lift * gp.v.y, z: gp.origin.z + lift * gp.v.z }); }
  return { spine, up, sections, law, guide: throughSpine(guidePts) };
}

/** Loft a solid through the feature's ordered profile sketches, then combine it. */
function applyLoft(doc: CadDocument, f: LoftFeature, bodies: Body[], out: Record<string, SolidEval>) {
  let tool: Named;
  try {
    const profiles = f.sketchIds.map((sid) => {
      const sk = doc.sketches[sid];
      if (!sk) throw new Error(`loft: no sketch "${sid}"`);
      const regions = extractRegions(sk);
      if (!regions.length) throw new Error(`loft: sketch "${sk.name}" has no closed region`);
      return { wp: resolveSketchPlane(sk), region: regions[0] };
    });
    if (profiles.length < 2) throw new Error("loft needs at least two profile sketches");
    tool = named(buildLoftSolid(profiles, !!f.ruled), f.id);
  } catch (e) {
    out[f.id] = { ...modifierRow(f), error: kernelErrorMessage(e) };
    return;
  }
  addOrCombine(f, tool, bodies, out, "loft", f.sketchIds[0]);
}

/** Topological names of a body's edges (aligned with its shape's edges). */
const bodyEdgeNames = (b: Body): string[] => edgeNamesOf(edgeGeoms(b.shape), b.faceNames);

/** Fillet or chamfer the selected edges of the most recent body. */
function applyEdgeBlend(scope: Scope, f: EdgeBlendFeature, bodies: Body[], out: Record<string, SolidEval>) {
  out[f.id] = modifierRow(f);
  try {
    const target = pickBody(bodies, f.body, f.kind);
    const size = resolveExpr(f.sizeExpr, f.sizeValue, scope);
    f.sizeValue = size;
    if (!(size > 0)) throw new Error(`${f.kind} size must be positive`);
    const before = volumeOfShape(target.shape);
    const blended = blendEdges(target.shape, f.kind, size, f.edges, f.edges.names?.length ? bodyEdgeNames(target) : undefined);
    const after = volumeOfShape(blended);
    const dim = f.kind === "fillet" ? "radius" : "setback";
    // An un-measurable result means OCC produced an invalid solid (usually the
    // size doesn't fit): don't corrupt the body with it — surface the failure.
    if (Number.isFinite(before) && !Number.isFinite(after)) {
      blended.delete();
      throw new Error(`${f.kind} failed: the ${dim} (${size}) does not fit the selected edges`);
    }
    const names = inheritNames(target.faceNames, surfaceParents(target.shape, blended), blended, f.id, f.kind === "fillet" ? "blend" : "chamfer");
    replaceShape(target, blended);
    target.faceNames = names;
    // A blend that changed nothing means no edges matched (or OCC skipped them).
    if (Number.isFinite(before) && Number.isFinite(after) && Math.abs(after - before) <= 1e-6 * Math.max(1, Math.abs(before))) {
      const msg = `${f.kind} changed nothing: no edges matched the selector, or the ${dim} does not fit`;
      if (f.requireEffect) out[f.id].error = msg; else out[f.id].warning = msg;
    }
  } catch (e) {
    out[f.id].error = kernelErrorMessage(e);
  }
}

/** Hollow the most recent body. */
function applyShell(scope: Scope, f: ShellFeature, bodies: Body[], out: Record<string, SolidEval>) {
  out[f.id] = modifierRow(f);
  try {
    const target = pickBody(bodies, f.body, "shell");
    const t = resolveExpr(f.thicknessExpr, f.thicknessValue, scope);
    f.thicknessValue = t;
    if (!(t > 0)) throw new Error("shell thickness must be positive");
    const before = volumeOfShape(target.shape);
    const hollowed = shellShape(target.shape, t, f.openFaces, f.openFaces.names?.length ? target.faceNames : undefined);
    const after = volumeOfShape(hollowed);
    // An un-measurable result means OCC produced an invalid solid (usually the
    // wall is thicker than the body allows, or no face matched): keep the body.
    if (Number.isFinite(before) && !Number.isFinite(after)) {
      hollowed.delete();
      throw new Error(`shell failed: wall thickness (${t}) is too large for the body, or openFaces matched no face`);
    }
    const names = inheritNames(target.faceNames, surfaceParents(target.shape, hollowed), hollowed, f.id, "inner", { geoms: faceGeoms(hollowed), offsetOf: true });
    replaceShape(target, hollowed);
    target.faceNames = names;
    if (Number.isFinite(before) && Number.isFinite(after) && Math.abs(after - before) <= 1e-6 * Math.max(1, Math.abs(before))) {
      const msg = "shell changed nothing: no faces matched openFaces, or the wall is thicker than the body allows";
      if (f.requireEffect) out[f.id].error = msg; else out[f.id].warning = msg;
    }
  } catch (e) {
    out[f.id].error = kernelErrorMessage(e);
  }
}

/** The axis frame of a voronoi feature: origin, and unit e1, e2, e3 (e3 along the axis). */
export function voronoiFrame(f: VoronoiFeature): { o: Vec3; e1: Vec3; e2: Vec3; e3: Vec3 } {
  const o = f.axis?.origin ?? { x: 0, y: 0, z: 0 };
  const d = f.axis?.direction ?? { x: 0, y: 0, z: 1 };
  const L = Math.hypot(d.x, d.y, d.z);
  if (!(L > 1e-12)) throw new Error("voronoi: the axis direction is zero");
  const e3 = { x: d.x / L, y: d.y / L, z: d.z / L };
  const seed = Math.abs(e3.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const k = dot(seed, e3);
  const t = { x: seed.x - k * e3.x, y: seed.y - k * e3.y, z: seed.z - k * e3.z };
  const tl = Math.hypot(t.x, t.y, t.z);
  const e1 = { x: t.x / tl, y: t.y / tl, z: t.z / tl };
  const e2 = { x: e3.y * e1.z - e3.z * e1.y, y: e3.z * e1.x - e3.x * e1.z, z: e3.x * e1.y - e3.y * e1.x };
  return { o, e1, e2, e3 };
}

/** Lay out a voronoi feature's openings on its target body (exported for the tests that measure them). */
export function voronoiLayout(scope: Scope, f: VoronoiFeature, shape: Shape3D): { wall: VoronoiWall; frame: ReturnType<typeof voronoiFrame> } {
  const frame = voronoiFrame(f);
  const { o, e1, e2, e3 } = frame;
  const mesh = meshShape(shape);
  const local = new Float64Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const p = { x: mesh.positions[i] - o.x, y: mesh.positions[i + 1] - o.y, z: mesh.positions[i + 2] - o.z };
    local[i] = dot(p, e1); local[i + 1] = dot(p, e2); local[i + 2] = dot(p, e3);
  }
  const probe = new RadialProbe(local, mesh.indices);
  const H = probe.zMax - probe.zMin;
  const count = Math.round(resolveExpr(f.cellsExpr, f.cellsValue ?? 0, scope)); f.cellsValue = count;
  if (!(count >= 3)) throw new Error("voronoi: needs at least 3 cells");
  if (count > 2000) throw new Error("voronoi: at most 2000 cells");
  const web = resolveExpr(f.webExpr, f.webValue ?? 0, scope); f.webValue = web;
  const round = f.roundExpr ? resolveExpr(f.roundExpr, f.roundValue ?? 0, scope) : 0; f.roundValue = round;
  const from = f.fromExpr ? resolveExpr(f.fromExpr, f.fromValue ?? 0, scope) : probe.zMin + H / 10; f.fromValue = from;
  const to = f.toExpr ? resolveExpr(f.toExpr, f.toValue ?? 0, scope) : probe.zMax - H / 10; f.toValue = to;
  const twist = f.twistExpr ? resolveExpr(f.twistExpr, f.twistValue ?? 0, scope) : 0; f.twistValue = twist;
  const wall = voronoiWall({ probe, count, seed: f.seed, relax: f.relax ?? 8, web, round, from, to, twist: (twist * Math.PI) / 180 });
  return { wall, frame };
}

/** The cutter for one opening: a ruled loft between the opening on a plane inside the wall and on one
 *  outside it, every edge running straight out from the axis. */
export function voronoiCutter(op: WallOpening, frame: ReturnType<typeof voronoiFrame>): Shape3D {
  const { o, e1, e2, e3 } = frame;
  const c = Math.cos(op.theta), s = Math.sin(op.theta);
  const normal = { x: c * e1.x + s * e2.x, y: c * e1.y + s * e2.y, z: c * e1.z + s * e2.z };
  const u = { x: -s * e1.x + c * e2.x, y: -s * e1.y + c * e2.y, z: -s * e1.z + c * e2.z };
  const section = (rho: number) => {
    const wp: WorkPlane = { id: "voronoi", name: "voronoi", origin: { x: o.x + rho * normal.x, y: o.y + rho * normal.y, z: o.z + rho * normal.z }, u, v: e3, normal, color: "" };
    const loop: Loop = { ...scaleOutline(op.outline, rho), area: 0 };
    return { wp, region: { outer: loop, holes: [] } };
  };
  return buildLoftSolid([section(op.rIn), section(op.rOut)], true);
}

/** Cut a wrapped Voronoi pattern of openings through the wall of a hollow body. */
function applyVoronoi(scope: Scope, f: VoronoiFeature, bodies: Body[], out: Record<string, SolidEval>) {
  out[f.id] = modifierRow(f);
  try {
    const target = pickBody(bodies, f.body, "voronoi");
    const { wall, frame } = voronoiLayout(scope, f, target.shape);
    f.openingsValue = wall.openings.length;
    if (!wall.openings.length) throw new Error("voronoi: no cell is big enough for an opening once the web is taken off (fewer cells, or a narrower web)");
    const cutters: Shape3D[] = [];
    try {
      for (const op of wall.openings) cutters.push(voronoiCutter(op, frame));
      const before = volumeOfShape(target.shape);
      booleanInto("cut", target, cutters, genericNames(f.id, cutters.flatMap((c) => faceKinds(c))), f.id);
      const after = volumeOfShape(target.shape);
      if (Number.isFinite(before) && Number.isFinite(after) && Math.abs(after - before) <= 1e-6 * Math.max(1, before)) {
        const msg = "voronoi changed nothing: the openings miss the wall (check the axis and the band)";
        if (f.requireEffect) out[f.id].error = msg; else out[f.id].warning = msg;
      }
    } finally { for (const c of cutters) c.delete(); }
    if (wall.skipped) out[f.id].warning = `${wall.skipped} of ${wall.strip.cells.length} cells too small for an opening once the web is taken off`;
  } catch (e) {
    out[f.id].error = kernelErrorMessage(e);
  }
}

/** Repeat the most recent body (linear vector or circular axis), fusing the copies in. */
function applyPattern(scope: Scope, f: PatternFeature, bodies: Body[], out: Record<string, SolidEval>) {
  out[f.id] = modifierRow(f);
  try {
    const target = pickBody(bodies, f.body, "pattern");
    // Resolve parametric count / spacing / angle, falling back to the stored
    // literal when there is no expression. count is rounded to an integer ≥1.
    f.count = Math.max(1, Math.round(f.countExpr ? resolveExpr(f.countExpr, f.count, scope) : f.count));
    const n = f.count;
    if (f.stepExpr && f.step) {
      f.step = {
        x: f.stepExpr.x ? resolveExpr(f.stepExpr.x, f.step.x, scope) : f.step.x,
        y: f.stepExpr.y ? resolveExpr(f.stepExpr.y, f.step.y, scope) : f.step.y,
        z: f.stepExpr.z ? resolveExpr(f.stepExpr.z, f.step.z, scope) : f.step.z,
      };
    }
    if (f.angleExpr) f.angle = resolveExpr(f.angleExpr, f.angle ?? 360 / n, scope);
    const original = target.shape;
    let acc: Shape3D = (original as unknown as { clone: () => Shape3D }).clone();
    let accNames = target.faceNames;
    for (let i = 1; i < n; i++) {
      let copy: Shape3D;
      if (f.mode === "linear") {
        const s = f.step ?? { x: 0, y: 0, z: 0 };
        copy = translateShape(original, { x: s.x * i, y: s.y * i, z: s.z * i });
      } else {
        const ax = f.axis ?? { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } };
        copy = rotateShape(original, (f.angle ?? 360 / n) * i, ax.origin, ax.direction);
      }
      try {
        const fused = booleanWithHistory("fuse", acc, copy); // a copy keeps the original's face order
        accNames = inheritNames([...accNames, ...copyNames(target.faceNames, `${f.id}.${i}`)], fused.parents, fused.shape, f.id, "new");
        acc.delete();
        acc = fused.shape;
      } finally { copy.delete(); }
    }
    replaceShape(target, acc);
    target.faceNames = accNames;
  } catch (e) {
    out[f.id].error = kernelErrorMessage(e);
  }
}

/** Reflect every running body across the plane and fuse each mirror into its source. */
function applyMirror(doc: CadDocument, f: MirrorFeature, bodies: Body[], out: Record<string, SolidEval>) {
  // A mirror is a feature row but makes no body of its own (listed, not rendered).
  out[f.id] = { featureId: f.id, name: f.name, sketchId: "", distance: 0 };
  let wp: WorkPlane;
  try {
    wp = mirrorPlane(doc, f);
  } catch (e) {
    out[f.id].error = kernelErrorMessage(e);
    return;
  }
  const targets = f.bodies === "last" ? bodies.slice(-1) : bodies;
  for (const body of targets) {
    try {
      const reflected = mirrorShape(body.shape, wp); // new shape (same face order); body.shape untouched
      try { booleanInto("join", body, reflected, copyNames(body.faceNames, f.id), f.id); }
      finally { reflected.delete(); }
    } catch (e) {
      out[f.id].error = kernelErrorMessage(e);
    }
  }
}

// ---- incremental evaluation -------------------------------------------------
//
// Every feature step is keyed by its inputs: the feature's own definition, the
// solved sketches it reads, the parameter values its expressions mention, its
// instance frame, and the content signatures of the bodies it reads. A step
// whose key was seen before replays its recorded effect — the bodies it added
// or changed (as shared OCC handles: a clone is a new reference to the same
// B-rep, not a copy), its row, and any face-resolved sketch planes — instead of
// calling the kernel. A body's signature is the key of the step that last
// changed it, so independent bodies never invalidate each other and an edit
// late in the timeline reuses everything before it. Meshes and mass
// properties are cached per body signature.
//
// Keys are written in a FRAME, so a body that only moved is the same body: a
// sketch feature's key says where its sketch entities are and where the bodies
// it reads sit RELATIVE TO ITS SKETCH PLANE, not where the plane is in the
// world; a name-only fillet's says where things are relative to its target. A
// joint drive moving a component moves every plane in it together, so the keys
// of the features drawn there don't change, and a replay moves the recorded
// shapes (and their meshes) by the frame's delta instead of rebuilding. A step
// whose definition is in world coordinates (a primitive's `at`, a hole, a
// mirror plane, an edge selector by axis) is keyed in the world, where a moved
// body reads as a different input, as it should.

interface BodyState {
  id: string; name: string; sketchId: string; distance: number; shape: Shape3D; faceNames: string[]; decals?: ThreadDecal[]; sig: string; frame: Rigid; member?: MemberMeta; sheet?: SheetState;
  /** What the collision check knows of a round body's shape (kept by a cache made with `keepShapeHints`): a gear
   *  placed as is (its pose, without the shape it describes) and the annuli that hold it. */
  hints?: { pose?: Omit<NonNullable<Body["pose"]>, "shape">; hull?: Hull[] };
}
interface StepEffect { bodies: (BodyState & { added: boolean })[]; removed?: string[]; row?: SolidEval; planes: Record<string, WorkPlane> }
interface BodyEval { mesh: SolidMesh; bounds?: Bounds3; mass: MassProps; surface?: boolean }

const cloneShape = (s: Shape3D): Shape3D => (s as unknown as { clone: () => Shape3D }).clone();
const cloneDecals = (d?: ThreadDecal[]) => (d ? d.map((x) => structuredClone(x)) : undefined);

/** Incremental-evaluation cache (lives in the geometry backend, across evaluations). */
export class GeometryCache {
  private steps = new Map<string, { eff: StepEffect; used: number }>();
  private evals = new Map<string, { ev: BodyEval; frame: Rigid; used: number; bytes: number }>();
  private generation = 0;
  private readonly generations: number;
  private readonly meshBudget: number;
  /** Whether replayed bodies keep what the collision check rules pairs out with (a gear's pose, a round body's
   *  annuli), moved with them: the motion study's cache, where a pose replays every body the joints only move. */
  readonly keepShapeHints: boolean;
  /** Feature steps replayed from cache / run through the kernel. */
  hits = 0;
  misses = 0;
  /**
   * `generations`: how many recent evaluations' entries to keep. 1 keeps only
   * the live model; more lets switching back to a recent state (another
   * configuration, an undo) replay from cache. `meshBudgetBytes` caps the
   * cached meshes, dropping the least recently used first.
   */
  constructor(opts: { generations?: number; meshBudgetBytes?: number; keepShapeHints?: boolean } = {}) {
    this.generations = Math.max(1, Math.floor(opts.generations ?? 1));
    this.meshBudget = opts.meshBudgetBytes ?? 256 * 1024 * 1024;
    this.keepShapeHints = !!opts.keepShapeHints;
  }
  step(key: string): StepEffect | undefined { const s = this.steps.get(key); if (s) s.used = this.generation; return s?.eff; }
  storeStep(key: string, eff: StepEffect): void { this.dropStep(key); this.steps.set(key, { eff, used: this.generation }); }
  /** A body's cached evaluation, with the frame it was measured in (the same body elsewhere is moved from it). */
  bodyEval(sig: string): { ev: BodyEval; frame: Rigid } | undefined { const e = this.evals.get(sig); if (e) e.used = this.generation; return e ? { ev: e.ev, frame: e.frame } : undefined; }
  storeBodyEval(sig: string, e: BodyEval, frame: Rigid): void {
    const mesh = cloneMesh(e.mesh);
    const bytes = mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength + mesh.edges.byteLength;
    this.evals.set(sig, { ev: { ...e, mesh }, frame, used: this.generation, bytes });
  }
  /** Start an evaluation. */
  begin(): void { this.generation++; }
  /** Finish one: drop (and free) entries no recent evaluation touched, then trim meshes to the budget. */
  end(): void {
    const oldest = this.generation - this.generations + 1;
    for (const [k, s] of [...this.steps]) if (s.used < oldest) this.dropStep(k);
    for (const [k, e] of [...this.evals]) if (e.used < oldest) this.evals.delete(k);
    let bytes = 0;
    for (const e of this.evals.values()) bytes += e.bytes;
    if (bytes <= this.meshBudget) return;
    for (const [k, e] of [...this.evals].sort((x, y) => x[1].used - y[1].used)) {
      if (bytes <= this.meshBudget || e.used === this.generation) break;
      this.evals.delete(k);
      bytes -= e.bytes;
    }
  }
  clear(): void { for (const k of [...this.steps.keys()]) this.dropStep(k); this.evals.clear(); }
  /** Bodies with a cached mesh. */
  get size(): number { return this.evals.size; }
  /** Feature steps with a cached effect. */
  get stepCount(): number { return this.steps.size; }
  private dropStep(key: string): void {
    const s = this.steps.get(key);
    if (!s) return;
    for (const b of s.eff.bodies) { try { b.shape.delete(); } catch { /* already freed */ } }
    this.steps.delete(key);
  }
}

function cloneMesh(m: SolidMesh): SolidMesh {
  return { positions: m.positions.slice(), normals: m.normals.slice(), indices: m.indices.slice(), edges: m.edges.slice(), triangleCount: m.triangleCount, faceRanges: m.faceRanges?.slice(), faceNames: m.faceNames?.slice(), ...(m.uvs ? { uvs: m.uvs.slice() } : {}) };
}

/** Sketches a feature reads. */
function featureSketches(f: FeatureDef): string[] {
  switch (f.kind) {
    case "extrude": case "revolve": case "gear": return [f.sketchId];
    case "loft": return f.sketchIds;
    case "sweep": return [f.profileSketch, f.pathSketch, ...(f.sections ?? []).map((s) => s.sketch)];
    case "member": return f.profile.sketch ? [f.sketchId, f.profile.sketch] : [f.sketchId];
    case "sheet": case "fold": return [f.sketchId];
    case "surface": return [...(f.sketchId ? [f.sketchId] : []), ...(f.sketchIds ?? []), ...(f.pathSketch ? [f.pathSketch] : [])];
    case "trim": return f.sketchId ? [f.sketchId] : [];
    default: return [];
  }
}

/** The bodies a step reads (and so whose content its result depends on). */
function bodiesRead(doc: CadDocument, f: FeatureDef, bodies: Body[]): Body[] {
  if (!bodies.length) return [];
  const target = (): Body[] => { try { return [pickBody(bodies, "body" in f ? (f.body as string | undefined) : undefined, f.kind)]; } catch { return bodies; } };
  const op = "operation" in f ? (f.operation ?? "new") : "new";
  switch (f.kind) {
    case "extrude": case "revolve":
      if (doc.sketches[f.sketchId]?.faceRef) return bodies; // re-resolves its plane against every body
      if (f.kind === "extrude" && f.extent === "toFace") return bodies; // finds its face on any body
      return op === "new" ? [] : target();
    case "primitive": case "gear": case "import": case "loft": case "sweep": return op === "new" ? [] : target();
    case "mirror": return f.bodies === "last" ? bodies.slice(-1) : bodies;
    case "member": case "surface": case "sheet": return []; // make bodies of their own
    case "stitch": return f.bodies.map((id) => bodies.find((b) => b.id === id)).filter((b): b is Body => !!b);
    case "trim": { const t = target(); const tool = f.toolBody ? bodies.find((b) => b.id === f.toolBody) : undefined; return tool ? [...t, tool] : t; }
    default: return target(); // hole, thread, fillet, chamfer, shell, pattern
  }
}

/** Outputs the evaluation writes back onto a feature: not inputs, so not part of its key. */
const DERIVED_FIELD = /Values?$/;
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;

// ---- frames ----

/** A plane as the rigid transform from its (u, v, normal) coordinates to the world. */
const rigidOfPlane = (p: WorkPlane): Rigid => ({ origin: { ...p.origin }, x: { ...p.u }, y: { ...p.v }, z: { ...p.normal } });
/** A rigid transform rounded to the nanometre, so two computations of the same pose hash alike. */
const r9 = (v: number) => { const r = Math.round(v * 1e9) / 1e9; return r === 0 ? 0 : r; };
const rv = (v: Vec3): Vec3 => ({ x: r9(v.x), y: r9(v.y), z: r9(v.z) });
const roundRigid = (T: Rigid): Rigid => ({ origin: rv(T.origin), x: rv(T.x), y: rv(T.y), z: rv(T.z) });
/** Whether two rigid transforms are the same pose (to 1e-10: no real move is that small). */
function samePose(a: Rigid, b: Rigid): boolean {
  const near = (p: Vec3, q: Vec3) => Math.abs(p.x - q.x) < 1e-10 && Math.abs(p.y - q.y) < 1e-10 && Math.abs(p.z - q.z) < 1e-10;
  return near(a.origin, b.origin) && near(a.x, b.x) && near(a.y, b.y) && near(a.z, b.z);
}
/** Whether a rigid transform turns (so a moved body's bounds aren't its old bounds moved). */
const turns = (T: Rigid): boolean => !samePose({ ...T, origin: IDENTITY.origin }, IDENTITY);
/** Whether an edge selector picks by topological name alone (so it follows the body wherever it is). */
const byNameOnly = (sel: object): boolean => Object.entries(sel).every(([k, v]) => v === undefined || k === "names");
/** `shape` moved by T (operand untouched; faces keep their order; the B-rep is shared, only its placement is new). */
const moveShape = (shape: Shape3D, T: Rigid): Shape3D => placeShape(shape, T);

/**
 * The frame a step's work is expressed in, given the bodies it reads:
 *  - a sketch feature: its (first) sketch's plane — the entities are drawn in it, and
 *    any body it cuts or joins is keyed by where it sits relative to it;
 *  - a modifier that picks by topological name alone: the body it modifies;
 *  - anything that names world coordinates (a primitive's `at`, a hole, a mirror plane,
 *    a geometric selector), a face-referenced sketch, a sheet or a weldment: the world.
 */
function stepFrame(doc: CadDocument, f: FeatureDef, reads: Body[]): Rigid {
  if (reads.some((b) => b.member || b.sheet)) return IDENTITY;
  switch (f.kind) {
    case "extrude": case "revolve": case "gear": case "loft": case "sweep": case "surface": {
      const sk = doc.sketches[featureSketches(f)[0]];
      if (!sk || sk.faceRef || sk.templatePlane) return IDENTITY;
      if (f.kind === "extrude" && f.extent === "toFace") return IDENTITY;
      return rigidOfPlane(resolveSketchPlane(sk));
    }
    case "fillet": case "chamfer": return reads[0] && byNameOnly(f.edges) ? reads[0].frame ?? IDENTITY : IDENTITY;
    case "thicken": case "untrim": case "stitch": return reads[0]?.frame ?? IDENTITY;
    default: return IDENTITY;
  }
}

/** A step's cache key and frame, or undefined when a body it reads has no signature. */
function stepKey(doc: CadDocument, scope: Scope, f: FeatureDef, bodies: Body[], instance?: Rigid): { key: string; frame: Rigid } | undefined {
  const reads = bodiesRead(doc, f, bodies);
  if (reads.some((b) => !b.sig || !b.frame)) return undefined;
  const frame = stepFrame(doc, f, reads);
  const inv = invert(frame);
  const def = Object.fromEntries(Object.entries(f).filter(([k]) => !DERIVED_FIELD.test(k)));
  const params = new Set<string>();
  JSON.stringify(f, (_k, v) => { if (typeof v === "string") for (const id of v.match(IDENT) ?? []) if (id in scope) params.add(id); return v; });
  const sketches = featureSketches(f).map((sid, i) => {
    const sk = doc.sketches[sid];
    if (!sk) return { id: sid, missing: true };
    if (frame === IDENTITY) return { id: sid, planeId: sk.planeId, plane: sk.plane, faceRef: sk.faceRef, entities: sk.entities };
    // in the step's frame: the first sketch IS the frame; another sits somewhere relative to it
    return { id: sid, faceRef: sk.faceRef, entities: sk.entities, ...(i ? { rel: roundRigid(compose(inv, rigidOfPlane(resolveSketchPlane(sk)))) } : {}) };
  });
  const datum = f.kind === "mirror" ? doc.planes[f.plane]?.plane : undefined;
  // a through-all extrude is as long as its target's box is wide: that length is an input to what
  // a join or an intersect leaves (a cut takes the same away however far past the body it reaches)
  const through = f.kind === "extrude" && f.extent === "throughAll" && f.operation !== "cut" && reads[0] ? r9(throughAllLength(safeBounds(reads[0].shape))) : undefined;
  const key = contentHash(stableJson({
    def, sketches, datum, instance, through,
    params: [...params].sort().map((p) => [p, scope[p]]),
    reads: reads.map((b) => [b.id, b.sig, b.frame === frame ? 0 : roundRigid(compose(inv, b.frame!))]),
  }));
  return { key, frame };
}

const bodyState = (b: Body): BodyState => ({ id: b.id, name: b.name, sketchId: b.sketchId, distance: b.distance, shape: cloneShape(b.shape), faceNames: b.faceNames.slice(), decals: cloneDecals(b.decals), sig: b.sig!, frame: b.frame!, ...(b.member ? { member: structuredClone(b.member) } : {}), ...(b.sheet ? { sheet: structuredClone(b.sheet) } : {}) });

/** A recorded body brought back live in `frame`: moved by the frame's delta since it was recorded, if it has one. */
function replayBody(b: BodyState, frame: Rigid): Body {
  const delta = compose(frame, invert(b.frame));
  const still = samePose(delta, IDENTITY);
  const live: Body = still ? { ...bodyState(b as unknown as Body), frame }
    : { ...bodyState(b as unknown as Body), shape: moveShape(b.shape, delta), decals: b.decals?.map((d) => ({ ...structuredClone(d), at: applyPoint(delta, d.at), axis: applyVec(delta, d.axis) })), frame };
  // the collision check's hints, moved with the body and describing its new shape
  if (b.hints?.pose) live.pose = { ...b.hints.pose, T: still ? b.hints.pose.T : compose(delta, b.hints.pose.T), shape: live.shape };
  if (b.hints?.hull) live.hull = { shape: live.shape, parts: still ? b.hints.hull : b.hints.hull.map((h) => ({ ...h, o: applyPoint(delta, h.o), d: applyVec(delta, h.d) })) };
  return live;
}

/** A body's collision hints, as far as they still describe its shape (see BodyState.hints). */
function shapeHints(b: Body): BodyState["hints"] {
  const pose = b.pose && b.pose.shape === b.shape ? { key: b.pose.key, T: b.pose.T, ...(b.pose.sharp ? { sharp: b.pose.sharp } : {}) } : undefined;
  const hull = hullOf(b);
  return pose || hull ? { ...(pose ? { pose } : {}), ...(hull ? { hull } : {}) } : undefined;
}

/** Run one step through `run`, recording what it did; or replay a recorded effect. */
function cachedStep(cache: GeometryCache, key: string, frame: Rigid, doc: CadDocument, f: FeatureDef, bodies: Body[], out: Record<string, SolidEval>, run: () => void) {
  const hit = cache.step(key);
  if (hit && [...hit.bodies.filter((b) => !b.added).map((b) => b.id), ...(hit.removed ?? [])].every((id) => bodies.some((x) => x.id === id))) {
    cache.hits++;
    for (const id of hit.removed ?? []) { // bodies the step consumed (a stitch)
      const i = bodies.findIndex((x) => x.id === id);
      bodies[i].shape.delete();
      bodies.splice(i, 1);
    }
    for (const b of hit.bodies) {
      const live = replayBody(b, frame);
      if (b.added) { bodies.push(live); continue; }
      const i = bodies.findIndex((x) => x.id === b.id);
      bodies[i].shape.delete();
      bodies[i] = live;
    }
    if (hit.row) out[f.id] = structuredClone(hit.row);
    for (const [sid, plane] of Object.entries(hit.planes)) if (doc.sketches[sid]) doc.sketches[sid].plane = plane;
    return;
  }
  cache.misses++;
  const before = new Map(bodies.map((b) => [b.id, { shape: b.shape, names: b.faceNames, decals: b.decals?.length ?? 0 }]));
  const planesBefore = new Map(featureSketches(f).map((sid) => [sid, doc.sketches[sid]?.plane]));
  run();
  const eff: StepEffect = { bodies: [], planes: {} };
  const gone = [...before.keys()].filter((id) => !bodies.some((b) => b.id === id));
  if (gone.length) eff.removed = gone;
  for (const b of bodies) {
    const was = before.get(b.id);
    if (was && was.shape === b.shape && was.names === b.faceNames && was.decals === (b.decals?.length ?? 0)) continue;
    b.sig = contentHash(`${key}|${b.id}`);
    b.frame = frame;
    const hints = cache.keepShapeHints ? shapeHints(b) : undefined;
    eff.bodies.push({ ...bodyState(b), added: !was, ...(hints ? { hints } : {}) });
  }
  if (out[f.id]) eff.row = structuredClone(out[f.id]);
  for (const [sid, plane] of planesBefore) { const now = doc.sketches[sid]?.plane; if (now && now !== plane) eff.planes[sid] = now; }
  cache.storeStep(key, eff);
}

function applyFeature(doc: CadDocument, scope: Scope, f: FeatureDef, bodies: Body[], out: Record<string, SolidEval>) {
  switch (f.kind) {
    case "extrude":
    case "revolve": applySketchFeature(doc, scope, f, bodies, out); break;
    case "primitive": applyPrimitive(scope, f, bodies, out); break;
    case "gear": applyGear(doc, scope, f, bodies, out); break;
    case "import": applyImport(f, bodies, out); break;
    case "member": applyMembers(doc, scope, f, bodies, out); break;
    case "sheet": applySheet(doc, scope, f, bodies, out); break;
    case "flange": applyFlange(scope, f, bodies, out); break;
    case "fold": applyFold(doc, scope, f, bodies, out); break;
    case "unfold": case "refold": applyUnfold(f, bodies, out); break;
    case "surface": applySurface(doc, scope, f, bodies, out); break;
    case "stitch": applyStitch(scope, f, bodies, out); break;
    case "thicken": applyThicken(scope, f, bodies, out); break;
    case "trim": applyTrim(doc, f, bodies, out); break;
    case "untrim": applyUntrim(f, bodies, out); break;
    case "hole": applyHole(scope, f, bodies, out); break;
    case "thread": applyThread(f, bodies, out); break;
    case "loft": applyLoft(doc, f, bodies, out); break;
    case "sweep": applySweep(doc, scope, f, bodies, out); break;
    case "mirror": applyMirror(doc, f, bodies, out); break;
    case "fillet":
    case "chamfer": applyEdgeBlend(scope, f, bodies, out); break;
    case "shell": applyShell(scope, f, bodies, out); break;
    case "pattern": applyPattern(scope, f, bodies, out); break;
    case "voronoi": applyVoronoi(scope, f, bodies, out); break;
  }
}

/** Copy of a shape moved by a rigid transform (operand untouched; faces keep their order). */
function transformShape(shape: Shape3D, T: Rigid): Shape3D {
  const { axis, angle } = axisAngle(T);
  if (angle < 1e-12) return translateShape(shape, T.origin);
  const turned = rotateShape(shape, (angle * 180) / Math.PI, { x: 0, y: 0, z: 0 }, axis);
  try { return translateShape(turned, T.origin); } finally { turned.delete(); }
}

/** Apply a cloned pattern-instance feature in its template's frame (see
 *  InstanceFrame): move the target body back by T⁻¹, run the feature with its
 *  template-authored parameters, then move the result — and any thread decals it
 *  added — out by T. */
function applyInTemplateFrame(apply: () => void, f: FeatureDef, bodies: Body[], T: Rigid) {
  // expandAssembly pins every clone's target (a mirror ignores it, but its "most
  // recent body" is the same one: an instance's features are cloned contiguously)
  const ref = "body" in f ? f.body : undefined;
  const target = bodies.find((b) => b.id === ref);
  if (!target) { apply(); return; } // nothing to move; the feature reports its own error
  const decals = target.decals?.length ?? 0;
  replaceShape(target, transformShape(target.shape, invert(T)));
  try { apply(); } finally {
    replaceShape(target, transformShape(target.shape, T));
    for (const d of target.decals?.slice(decals) ?? []) { d.at = applyPoint(T, d.at); d.axis = applyVec(T, d.axis); }
  }
}

/** Build every feature in order into live bodies (caller frees the shapes).
 *  With a cache, unchanged steps replay instead of running the kernel. */
/** Which phase a build is in, and how far through it: building the features, then meshing the bodies.
 *  The meshing is a tenth of the bar but can take seconds (a clock's gear teeth), so it is named. */
export interface BuildStep { phase: "features" | "meshing"; done: number; total: number }
/** Hears a running build's progress: the fraction (0…1) and the step it is on. */
export type BuildProgressSink = (fraction: number, step?: BuildStep) => void;
/** Where a build reports how far it has got (0…1): set around one evaluation by its caller. */
let buildProgress: BuildProgressSink | null = null;
/** Report a running evaluation's progress to `sink` while `fn` runs (the features, then the meshing). */
export function withBuildProgress<T>(sink: BuildProgressSink | undefined, fn: () => T): T {
  const was = buildProgress;
  buildProgress = sink ?? null;
  try { return fn(); } finally { buildProgress = was; }
}
// building the features is nearly all the work (the star box: 2.8 s of 3); meshing them the rest
const FEATURE_SHARE = 0.9;

export function evaluateBodies(doc: CadDocument, scope: Scope, cache?: GeometryCache): { bodies: Body[]; out: Record<string, SolidEval> } {
  const out: Record<string, SolidEval> = {};
  const bodies: Body[] = [];
  let worlds: Map<string, Rigid> | undefined; // component frames, resolved only for pattern instances
  const active = activeFeatures(doc, scope);
  let done = 0;
  for (const f of active) {
    buildProgress?.((FEATURE_SHARE * done) / active.length, { phase: "features", done, total: active.length });
    done++;
    let T: Rigid | undefined;
    if (f.instanceFrame) {
      worlds ??= resolveComponentWorld(doc, scope);
      T = compose(worlds.get(f.instanceFrame.component) ?? IDENTITY, invert(worlds.get(f.instanceFrame.template) ?? IDENTITY));
    }
    const run = T ? () => applyInTemplateFrame(() => applyFeature(doc, scope, f, bodies, out), f, bodies, T!) : () => applyFeature(doc, scope, f, bodies, out);
    const step = cache ? stepKey(doc, scope, f, bodies, T) : undefined;
    if (cache && step) cachedStep(cache, step.key, step.frame, doc, f, bodies, out, run);
    else run();
  }
  return { bodies, out };
}

/** Whether a feature is switched on: not suppressed by the active
 *  configuration, and no `when` or a `when` that's non-zero (one that can't be
 *  evaluated leaves the feature on rather than drop it). */
export function featureActive(f: FeatureDef, scope: Scope): boolean {
  if (f.configSuppressed) return false;
  if (!f.when) return true;
  try { return compileExpr(f.when).eval(scope) !== 0; } catch { return true; }
}

/** The features that build, in order: those switched off by `when` are skipped. */
const activeFeatures = (doc: CadDocument, scope: Scope): FeatureDef[] => Object.values(doc.features).filter((f) => featureActive(f, scope));

/** Evaluate every feature into body meshes (+ bounds and exact mass
 *  properties). With a cache, only the steps whose inputs changed touch the
 *  kernel, and only bodies whose content changed are re-meshed. */
export function evaluateFeatures(doc: CadDocument, scope: Scope, cache?: GeometryCache): Record<string, SolidEval> {
  const staged = evaluateFeaturesStaged(doc, scope, cache);
  while (staged.measureNext()) { /* every body, exactly */ }
  return staged.solids;
}

/**
 * An evaluation in two stages: the rows with their meshes first, then the exact
 * measuring. Measuring a body — its box (OCC's optimal one, which on a gear's
 * hundreds of B-spline faces takes longer than meshing it) and its volume, area
 * and centroid (an adaptive integral) — is most of a cold build's time and none
 * of what it takes to show the model, so a caller may show `solids` as soon as it
 * has them and measure after, one body per `measureNext`. Until a body is
 * measured its row carries its mesh's box (within the meshing tolerance of the
 * exact one) and no volume, area or centroid. A body measured before (in this
 * pose, or moved without turning) needs nothing more.
 */
export interface StagedEvaluation {
  solids: Record<string, SolidEval>;
  /** Bodies still to be measured. */
  readonly pending: number;
  /** Measure one more body, writing the result onto its row (and into the cache); false when none is left. */
  measureNext(): boolean;
  /** Give up the measuring that is left (the model is superseded). */
  dispose(): void;
}

/** A body awaiting its exact measurement. `mass` is known when only the box is missing (a turned replay);
 *  `store` says the full evaluation goes into the cache once measured; `gear` shares its mass per spec. */
interface Pending { body: Body; row: SolidEval; mesh: SolidMesh; surface: boolean; mass?: MassProps; store: boolean; gear?: { key: string; T: Rigid } }

export function evaluateFeaturesStaged(doc: CadDocument, scope: Scope, cache?: GeometryCache): StagedEvaluation {
  const features: FeatureDef[] = activeFeatures(doc, scope);
  const done: StagedEvaluation = { solids: {}, pending: 0, measureNext: () => false, dispose: () => {} };
  if (!isKernelReady()) {
    for (const f of features) {
      done.solids[f.id] = f.kind === "extrude"
        ? { featureId: f.id, name: f.name, sketchId: f.sketchId, distance: resolveDistance(f, scope), error: "kernel not ready" }
        : { ...modifierRow(f), sketchId: f.kind === "revolve" ? f.sketchId : "", error: "kernel not ready" };
    }
    return done;
  }
  const pending: Pending[] = [];
  cache?.begin();
  try {
    const { bodies, out } = evaluateBodies(doc, scope, cache);
    let meshed = 0;
    for (const body of bodies) {
      buildProgress?.(FEATURE_SHARE + ((1 - FEATURE_SHARE) * meshed) / bodies.length, { phase: "meshing", done: meshed, total: bodies.length });
      meshed++;
      const row: SolidEval = { ...(out[body.id] ?? {}), featureId: body.id, name: body.name, sketchId: body.sketchId, distance: body.distance };
      if (body.decals?.length) row.threadDecals = body.decals;
      let keep = false; // the shape stays alive for its measuring
      try {
        let ev: BodyEval | undefined;
        let later: Pending | undefined;
        const frame = body.frame ?? IDENTITY;
        const cached = cache && body.sig ? cache.bodyEval(body.sig) : undefined;
        if (cached) {
          // the same body, measured before — here, or somewhere else (then moved: the same
          // mesh and volume; a turned body gets its box measured afresh)
          const delta = compose(frame, invert(cached.frame));
          const b = cached.ev.bounds;
          if (samePose(delta, IDENTITY)) ev = cached.ev;
          else if (!turns(delta) && b) ev = posedEval(cached.ev, delta, { min: applyPoint(delta, b.min), max: applyPoint(delta, b.max) });
          else {
            ev = posedEval(cached.ev, delta, undefined);
            ev.bounds = meshBounds(ev.mesh.positions);
            later = { body, row, mesh: ev.mesh, surface: !!ev.surface, mass: ev.mass, store: false };
          }
        }
        if (!ev && body.pose) {
          // a gear: meshed once in its own frame and moved; measured once per spec too
          const local = GEAR_LOCAL.get(body.pose.key);
          const lshape = local && body.pose.shape === body.shape ? peekLocalGear(body.pose.key) : undefined;
          if (local && lshape) {
            local.mesh ??= meshShape(lshape);
            const mesh = moveMesh(local.mesh, body.pose.T);
            const mass = local.mass ? { ...local.mass, centroid: applyPoint(body.pose.T, local.mass.centroid) } : undefined;
            ev = { mesh, bounds: meshBounds(mesh.positions), mass: mass ?? NO_MASS };
            later = { body, row, mesh, surface: false, mass, store: true, gear: { key: body.pose.key, T: body.pose.T } };
          }
        }
        if (!ev) {
          const mesh = meshShape(body.shape);
          const surface = !hasSolid(body.shape);
          ev = { mesh, bounds: meshBounds(mesh.positions), mass: NO_MASS, ...(surface ? { surface: true } : {}) };
          later = { body, row, mesh, surface, store: true };
        }
        row.mesh = cloneMesh(ev.mesh);
        if (row.mesh.faceRanges && row.mesh.faceRanges.length === 2 * body.faceNames.length) row.mesh.faceNames = body.faceNames.slice();
        writeMeasure(row, ev.bounds, ev.mass, !!ev.surface);
        if (body.member) row.member = { profile: body.member.profile, length: extentAlong(ev.mesh.positions, body.member.axis), angles: body.member.angles };
        if (body.sheet?.pattern) {
          const sh = body.sheet;
          row.sheet = { thickness: sh.thickness, kFactor: sh.kFactor, unfolded: !!sh.unfolded, ...(sh.edited && !sh.unfolded ? { stale: true } : {}), angles: Object.fromEntries(Object.entries(sh.angles ?? {}).map(([k, v]) => [k, Math.round(v * 180 / Math.PI * 1e6) / 1e6])), edges: sh.edges.map((e) => e.name), flat: sh.pattern! };
          if (sh.seq && !(sh.edited && !sh.unfolded)) {
            const progress = sh.unfolded ? 0 : sh.progress;
            row.sheet.sequence = { plan: sh.seq, ...(progress != null ? { progress } : {}), frame: sh.frame };
            // the paper's own coordinates on its mesh, so a material drawn on it stays put as it folds
            row.mesh.uvs = sequenceUVs(sh.seq, sequenceAngles(sh.seq, progress), sh.frame, row.mesh.positions);
          }
        }
        if (later) { pending.push(later); keep = true; }
      } catch (e) {
        row.error = kernelErrorMessage(e);
      } finally {
        if (!keep) body.shape.delete();
      }
      out[body.id] = row;
    }
    done.solids = out;
  } finally {
    cache?.end();
  }
  const measure = (p: Pending) => {
    const { body, row } = p;
    try {
      const bounds = safeBounds(body.shape);
      let mass = p.mass;
      if (!mass && p.gear) {
        const local = GEAR_LOCAL.get(p.gear.key);
        const inv = invert(p.gear.T);
        const m = local?.mass ?? (() => { const w = massPropsOfShape(body.shape); return { ...w, centroid: applyPoint(inv, w.centroid) }; })();
        if (local && !local.mass) local.mass = m;
        mass = { ...m, centroid: applyPoint(p.gear.T, m.centroid) };
      }
      mass ??= massPropsOfShape(body.shape);
      writeMeasure(row, bounds, mass, p.surface);
      if (p.store && cache && body.sig) cache.storeBodyEval(body.sig, { mesh: p.mesh, bounds, mass, ...(p.surface ? { surface: true } : {}) }, body.frame ?? IDENTITY);
    } catch (e) {
      row.error ??= kernelErrorMessage(e);
    } finally {
      body.shape.delete();
    }
  };
  return {
    solids: done.solids,
    get pending() { return pending.length; },
    measureNext() { const p = pending.shift(); if (!p) return false; measure(p); return true; },
    dispose() { for (const p of pending.splice(0)) p.body.shape.delete(); },
  };
}

/** Mass properties not measured yet. */
const NO_MASS: MassProps = { volume: NaN, area: NaN, centroid: { x: NaN, y: NaN, z: NaN } };

/** A body's measurements onto its row (a NaN is left off; an open surface encloses nothing). */
function writeMeasure(row: SolidEval, bounds: Bounds3 | undefined, mass: MassProps, surface: boolean) {
  row.bounds = bounds;
  if (surface) row.volume = 0;
  else if (Number.isFinite(mass.volume)) row.volume = mass.volume;
  if (Number.isFinite(mass.area)) row.area = mass.area;
  if (Number.isFinite(mass.centroid.x)) row.centroid = mass.centroid;
  if (surface) row.surface = true;
}

/** Faces and edges of each body with their topological names and geometry
 *  (for body_topology / measure): one row per body, or just `bodyId`'s. */
export interface BodyTopology {
  id: string;
  name: string;
  volume: number;
  area: number;
  centroid: Vec3;
  bounds?: Bounds3;
  faces: (FaceGeom & { name: string })[];
  edges: (EdgeGeom & { name: string; faceNames: string[] })[];
}

export function bodyTopology(doc: CadDocument, scope: Scope, opts: { bodyId?: string; faces?: boolean; edges?: boolean } = {}): BodyTopology[] {
  if (!isKernelReady()) return [];
  const { bodies } = evaluateBodies(doc, scope);
  try {
    return bodies.filter((b) => !opts.bodyId || b.id === opts.bodyId).map((b) => {
      const mass = massPropsOfShape(b.shape);
      const faces = opts.faces === false ? [] : faceGeoms(b.shape).map((g, i) => ({ ...g, name: b.faceNames[i] ?? `f${i}` }));
      let edges: BodyTopology["edges"] = [];
      if (opts.edges !== false) {
        const eg = edgeGeoms(b.shape);
        const names = edgeNamesOf(eg, b.faceNames);
        edges = eg.map((e, i) => ({ ...e, name: names[i], faceNames: e.faces.map((j) => b.faceNames[j] ?? `f${j}`) }));
      }
      return { id: b.id, name: b.name, volume: hasSolid(b.shape) ? mass.volume : 0, area: mass.area, centroid: mass.centroid, bounds: safeBounds(b.shape), faces, edges };
    });
  } finally {
    for (const b of bodies) b.shape.delete();
  }
}

/** Surface-quality analysis of one body, aligned with its display mesh. */
export interface BodyAnalysisResult {
  featureId: string;
  name: string;
  /** Vertex count of the mesh the curvature array is aligned with. */
  vertices: number;
  /** k1, k2 per vertex (1/mm, convex positive). */
  curvature: Float32Array;
  /** Curvature comb segments (flat xyz pairs). */
  combs: Float32Array;
  /** Every edge between two faces, by name, with its continuity. */
  edges: { name: string; continuity: "G0" | "G1" | "G2"; angleDeg: number; curvatureJump: number }[];
  stats: { kMin: number; kMax: number; meanMin: number; meanMax: number; gaussMin: number; gaussMax: number };
}

/** Curvature, edge continuity and curvature combs for each body (or one). */
export function analyzeBodies(doc: CadDocument, scope: Scope, opts: { bodyId?: string; combs?: boolean } = {}): BodyAnalysisResult[] {
  if (!isKernelReady()) return [];
  const { bodies } = evaluateBodies(doc, scope);
  try {
    return bodies.filter((b) => !opts.bodyId || b.id === opts.bodyId).map((b) => {
      const mesh = meshShape(b.shape);
      const a = analyzeShape(b.shape, mesh, { combs: opts.combs });
      const names = edgeNamesOf(edgeGeoms(b.shape), b.faceNames);
      return {
        featureId: b.id, name: b.name, vertices: mesh.positions.length / 3,
        curvature: a.curvature, combs: a.combs, stats: a.stats,
        edges: a.edges.map((e) => ({ name: names[e.edge], continuity: e.continuity, angleDeg: e.angleDeg, curvatureJump: e.curvatureJump })),
      };
    });
  } finally {
    for (const b of bodies) b.shape.delete();
  }
}

/** Minimum distance between two bodies (by creating-feature id); 0 when they touch or overlap. */
export function bodyDistance(doc: CadDocument, scope: Scope, a: string, b: string): number {
  if (!isKernelReady()) throw new Error("kernel not ready");
  const { bodies } = evaluateBodies(doc, scope);
  try {
    const find = (id: string) => { const x = bodies.find((y) => y.id === id); if (!x) throw new Error(`no body "${id}" (bodies: ${bodies.map((y) => y.id).join(", ") || "none"})`); return x; };
    return distanceBetween(find(a).shape, find(b).shape);
  } finally {
    for (const x of bodies) x.shape.delete();
  }
}

export interface CollisionResult {
  /** Largest pairwise intersection volume (mm³) between any two bodies. */
  maxOverlap: number;
  /** Bodies that interpenetrate (display names + body ids), with the overlap volume. */
  overlaps: { a: string; b: string; aId: string; bId: string; volume: number }[];
  /** A feature failed to build at this configuration (a "crash" to warn about). */
  buildError?: string;
}

/** An annulus about an axis through o along unit d, from z0 to z1 along it (world mm). */
type Hull = Annulus & { o: Vec3; d: Vec3 };
const hullOf = (b: Body): Hull[] | undefined => (b.hull && b.hull.shape === b.shape ? b.hull.parts : undefined);
const EPS = 1e-6;
/** Two annuli on parallel axes that can't meet: side by side, past each other's ends, one in the other's hole. */
function annuliApart(a: Hull, b: Hull): boolean {
  if (Math.abs(dot(a.d, b.d)) < 1 - 1e-9) return false; // crossed axes: leave it to the boolean
  const w = { x: b.o.x - a.o.x, y: b.o.y - a.o.y, z: b.o.z - a.o.z };
  const along = dot(w, a.d), s = Math.sign(dot(a.d, b.d));
  const [b0, b1] = s > 0 ? [along + b.z0, along + b.z1] : [along - b.z1, along - b.z0];
  if (b1 <= a.z0 + EPS || b0 >= a.z1 - EPS) return true;
  const p = Math.hypot(w.x - along * a.d.x, w.y - along * a.d.y, w.z - along * a.d.z);
  return p >= a.rOut + b.rOut || p + b.rOut <= a.rIn || p + a.rOut <= b.rIn;
}
/** An annulus on a world axis and a box that can't meet (on any other axis: undecided). */
function annulusBoxApart(c: Hull, box: Bounds3): boolean {
  const k = (["x", "y", "z"] as const).find((ax) => Math.abs(c.d[ax]) > 1 - 1e-9);
  if (!k) return false;
  const [u, v] = (["x", "y", "z"] as const).filter((ax) => ax !== k);
  const s = Math.sign(c.d[k]);
  const lo = c.o[k] + (s > 0 ? c.z0 : -c.z1), hi = c.o[k] + (s > 0 ? c.z1 : -c.z0);
  if (box.max[k] <= lo + EPS || box.min[k] >= hi - EPS) return true;
  const near = Math.hypot(Math.max(box.min[u] - c.o[u], 0, c.o[u] - box.max[u]), Math.max(box.min[v] - c.o[v], 0, c.o[v] - box.max[v]));
  const far = Math.hypot(Math.max(Math.abs(box.min[u] - c.o[u]), Math.abs(box.max[u] - c.o[u])), Math.max(Math.abs(box.min[v] - c.o[v]), Math.abs(box.max[v] - c.o[v])));
  return near >= c.rOut || far <= c.rIn;
}

/** Build every body and measure how much any two of them interpenetrate. Used by
 *  the motion study to pass/fail a configuration: designed point/line contact has
 *  no volume, so only real overlap registers. With a cache (made with
 *  keepShapeHints), a body a pose only moves is not rebuilt: its build replays,
 *  moved to where the pose puts it (a step is keyed in its own frame), so a study
 *  builds the bodies once and checks placed copies of them at every other pose. */
export function collideFeatures(doc: CadDocument, scope: Scope, cache?: GeometryCache): CollisionResult {
  cache?.begin();
  let built: ReturnType<typeof evaluateBodies>;
  try { built = evaluateBodies(doc, scope, cache); } finally { cache?.end(); }
  const { bodies, out } = built;
  const buildError = Object.values(out).find((o) => o.error)?.error;
  const overlaps: CollisionResult["overlaps"] = [];
  let maxOverlap = 0;
  // A gear placed as is, its edges broken, is checked as its sharp self: that holds it (the chamfer
  // only takes material away), so clear sharp is clear chamfered — and a boolean on the sharp solid
  // keeps a third of the kernel memory (a motion study runs hundreds).
  const proxies: Shape3D[] = [];
  const shapes = bodies.map((b) => {
    if (!b.pose?.sharp || b.pose.shape !== b.shape) return b.shape;
    try { const p = placeShape(localGearSolid(b.pose.sharp).shape, b.pose.T); proxies.push(p); return p; } catch { return b.shape; }
  });
  try {
    // bodies whose boxes don't meet can't overlap: skip the boolean (a gear train is mostly such pairs)
    const boxes = shapes.map((sh) => safeBounds(sh));
    // (boxes that only touch — OCC pads each by its tolerance — hold no common volume either)
    const T = 1e-5;
    const boxApart = (a: Bounds3, b: Bounds3) => a.max.x < b.min.x + T || b.max.x < a.min.x + T || a.max.y < b.min.y + T || b.max.y < a.min.y + T || a.max.z < b.min.z + T || b.max.z < a.min.z + T;
    // round bodies (gears, pins) by their annuli: a gear beside another, a pin in a bore
    const hulls = bodies.map(hullOf);
    const apart = (i: number, j: number) => {
      const a = boxes[i], b = boxes[j];
      if (!a || !b) return false;
      if (boxApart(a, b)) return true;
      const ha = hulls[i], hb = hulls[j];
      if (ha && hb) return ha.every((x) => hb.every((y) => annuliApart(x, y)));
      if (ha) return ha.every((x) => annulusBoxApart(x, b));
      if (hb) return hb.every((y) => annulusBoxApart(y, a));
      return false;
    };
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        if (apart(i, j)) continue;
        let vol = 0;
        try {
          const inter = intersectShapes(shapes[i], shapes[j]);
          try { const v = volumeOfShape(inter); if (Number.isFinite(v)) vol = Math.abs(v); } finally { inter.delete(); }
        } catch { vol = 0; } // disjoint / touching solids → no common volume
        if (vol > 1e-4) { overlaps.push({ a: bodies[i].name, b: bodies[j].name, aId: bodies[i].id, bId: bodies[j].id, volume: vol }); maxOverlap = Math.max(maxOverlap, vol); }
      }
    }
  } finally {
    for (const b of bodies) { try { b.shape.delete(); } catch { /* already freed */ } }
    for (const p of proxies) { try { p.delete(); } catch { /* already freed */ } }
  }
  return { maxOverlap, overlaps, buildError };
}

/** B-rep edges of a feature's own solid, in world space (for projection into a sketch). */
export function featureEdges(doc: CadDocument, scope: Scope, featureId: string): Edge3D[] {
  const f = doc.features[featureId];
  if (!f || (f.kind !== "extrude" && f.kind !== "revolve") || !isKernelReady()) return [];
  try {
    const solid = buildFeatureSolid(doc, scope, f).shape;
    try { return edgesOfShape(solid); } finally { solid.delete(); }
  } catch {
    return [];
  }
}

/**
 * Export the finished BODY that `featureId` starts (its joins, cuts, fillets,
 * shells and patterns included) — not just that feature's own solid.
 */
export function exportFeatureBlob(doc: CadDocument, scope: Scope, featureId: string, format: "stl" | "step"): Blob | null {
  const f = doc.features[featureId];
  if (!f || !isKernelReady()) return null;
  const { bodies } = evaluateBodies(doc, scope);
  try {
    const body = bodies.find((b) => b.id === featureId) ?? bodies[bodies.length - 1];
    return body ? blobOfShape(body.shape, format) : null;
  } catch {
    return null;
  } finally {
    for (const b of bodies) b.shape.delete();
  }
}

/**
 * Export EVERY body fused into one solid, at the pose the doc's sketches are
 * placed in — the print file for a one-piece part modelled as several moving
 * components (a compliant mechanism: links joined by flexures print as one).
 * A reference part's bodies (Component.reference) are left out: they are not made.
 */
export function exportFusedBlob(doc: CadDocument, scope: Scope, format: "stl" | "step"): Blob | null {
  if (!isKernelReady()) return null;
  const { bodies } = evaluateBodies(doc, scope);
  const partials: Shape3D[] = []; // fuse results (the operands stay owned by their bodies)
  try {
    let fused: Shape3D | null = null;
    for (const b of bodies) {
      if (isReferenceBody(doc, b)) continue;
      fused = fused ? fuseShapes(fused, b.shape) : b.shape;
      if (fused !== b.shape) partials.push(fused);
    }
    return fused ? blobOfShape(fused, format) : null;
  } catch {
    return null;
  } finally {
    for (const s of partials) s.delete();
    for (const b of bodies) b.shape.delete();
  }
}

/**
 * The print parts of a multi-material model: every body fused with the others
 * of its material (each body's from its component), meshed. One part for a
 * single-material model; a TPU frame with an embedded PLA skeleton gives two.
 * A reference part's bodies are left out.
 */
export function printPartsByMaterial(doc: CadDocument, scope: Scope): { name: string; color?: string; mesh: SolidMesh }[] {
  if (!isKernelReady()) return [];
  const { bodies } = evaluateBodies(doc, scope);
  const groups = new Map<string, { name: string; color?: string; shapes: Shape3D[] }>();
  for (const b of bodies) {
    if (isReferenceBody(doc, b)) continue; // context, not a part to print
    const m = materialForComponent(doc, doc.sketches[b.sketchId]?.componentId, scope);
    const key = m?.id ?? "";
    if (!groups.has(key)) groups.set(key, { name: m?.name ?? "Part", color: m?.color, shapes: [] });
    groups.get(key)!.shapes.push(b.shape);
  }
  const partials: Shape3D[] = [];
  try {
    return [...groups.values()].map((g) => {
      let fused = g.shapes[0];
      for (const sh of g.shapes.slice(1)) { fused = fuseShapes(fused, sh); partials.push(fused); }
      return { name: g.name, color: g.color, mesh: meshShape(fused) };
    });
  } finally {
    for (const sh of partials) sh.delete();
    for (const b of bodies) b.shape.delete();
  }
}

/** Export bytes (transferable) — the worker-safe form of exportFeatureBlob. */
export async function exportFeatureBytes(doc: CadDocument, scope: Scope, featureId: string, format: "stl" | "step"): Promise<Uint8Array | null> {
  const blob = exportFeatureBlob(doc, scope, featureId, format);
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}
