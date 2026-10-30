// Evaluate solid features (extrude) from the document. Resolves each feature's
// parametric distance, extracts the sketch region(s), and asks the OCC kernel
// for a display mesh. Features combine into bodies via boolean operations
// (new / join / cut), Fusion-style: a joined extrude fuses into the running
// body, a cut subtracts from it. Kept separate from the (fast, pure) sketch
// recompute because it drives the heavier B-rep kernel.

import { compileExpr, Scope } from "../math/expr";
import {
  CadDocument, ExtrudeFeature, FeatureDef, ImportFeature, MemberFeature, SheetFeature, FlangeFeature, FoldFeature, UnfoldFeature, SurfaceFeature, StitchFeature, ThickenFeature, TrimFeature, UntrimFeature, MirrorFeature, EdgeBlendFeature, ShellFeature, PatternFeature, LoftFeature, SweepFeature, SketchFeature, PrimitiveFeature, HoleFeature, ThreadFeature, ThreadSpec, ThreadDecal, BooleanOp, materialForComponent,
} from "./document";
import { offsetPlane, resolveSketchPlane, planeById, makePlaneFromNormal, to3d, WorkPlane } from "../geometry/plane";
import { extractRegions, extractOpenPath, extractChains, regionAt, Region, Profile, Loop } from "./geometry/profile";
import { FaceRef } from "../sketch/types";
import {
  Edge3D, buildRegionsSolid, buildRegionsRevolved, buildLoftSolid, buildSweepSolid, fuseShapes, cutShapes, intersectShapes, mirrorShape, meshShape, edgesOfShape, blobOfShape,
  planarFacesOfShape, PlanarFace, isKernelReady, SolidMesh, blendEdges, shellShape, translateShape, rotateShape,
  boundsOfShape, volumeOfShape, massPropsOfShape, MassProps, Bounds3, buildPrimitive, buildHoleCutter, HoleCutterSpec, buildThread,
  faceGeoms, edgeGeoms, kernelErrorMessage, FaceGeom, EdgeGeom, booleanWithHistory, BooleanKind, surfaceParents, distanceBetween, readStep, readBrep, readStl, analyzeShape, keepHalfSpace,
  readNurbsBrep, chainWire, surfaceExtrude, surfaceRevolve, surfaceLoft, surfaceSweep, planarPatch, sewShapes, thickenShape, offsetSurface, untrimFaces, hasSolid,
} from "./occ/kernel";
import { genericNames, extrudeNames, revolveNames, holeCutterNames, inheritNames, copyNames, edgeNamesOf } from "./naming";
import { stableJson, contentHash } from "./contentKey";
import { standardProfile, profileLabel, profileReach, profileHalfWidth, memberLines, memberJoints, ProfileDims } from "./weldment";
import type { Shape3D } from "replicad";
import { Vec3 } from "../math/vec";
import { Rigid, IDENTITY, axisAngle, compose, invert, applyPoint, applyVec } from "../math/transform";
import { resolveComponentWorld } from "./recompute";
import { SheetState, SheetFold, SheetRow, blankEdges, contourBlank, addFlange, jogFolds, flatPointOf, chordAcross } from "./sheet";
import { buildSheet, SheetBuild } from "./sheetBuild";
import { flatBlankOf } from "./occ/sheet";

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
function buildFeatureSolid(doc: CadDocument, scope: Scope, f: SketchFeature, targetBounds?: Bounds3): Named {
  const sketch = doc.sketches[f.sketchId];
  if (!sketch) throw new Error("sketch not found");
  const regions = featureRegions(doc, f);
  if (regions.length === 0) throw new Error("no closed region in sketch");
  const wp0 = resolveSketchPlane(sketch);
  if (f.kind === "revolve") {
    const angle = resolveExpr(f.angleExpr, f.angleValue, scope);
    f.angleValue = angle;
    const o = to3d(wp0, f.axis.p1.x, f.axis.p1.y);
    const q = to3d(wp0, f.axis.p2.x, f.axis.p2.y);
    const dir = { x: q.x - o.x, y: q.y - o.y, z: q.z - o.z };
    if (Math.hypot(dir.x, dir.y, dir.z) < 1e-9) throw new Error("revolve axis points coincide");
    const shape = buildRegionsRevolved(wp0, regions, o, dir, Math.abs(angle) < 1e-9 ? 360 : angle);
    return { shape, names: nameSafely(shape, f.id, (g) => revolveNames(f.id, g, sketch, wp0, o, dir)) };
  }
  let distance = resolveDistance(f, scope);
  // Through-all: a length that clears the target body from any face of it, both ways when symmetric.
  if (f.extent === "throughAll") distance = throughAllLength(targetBounds) * (f.symmetric ? 2 : 1);
  if (f.direction === "reverse") distance = -distance;
  const d = Math.abs(distance) < 1e-9 ? 1e-6 : distance;
  const wp = f.symmetric ? offsetPlane(wp0, -d / 2) : wp0;
  const shape = buildRegionsSolid(wp, regions, d);
  const n = wp0.normal, dir = d >= 0 ? n : { x: -n.x, y: -n.y, z: -n.z };
  return { shape, names: nameSafely(shape, f.id, (g) => extrudeNames(f.id, g, sketch, wp0, dir)) };
}

/** A solid plus the topological names of its faces (in face order). */
interface Named { shape: Shape3D; names: string[] }

/** Name a freshly built solid's faces; if a namer can't make sense of them, fall back to geometry-only names. */
function nameSafely(shape: Shape3D, featureId: string, namer: (g: FaceGeom[]) => string[]): string[] {
  const geoms = faceGeoms(shape);
  try { return namer(geoms); } catch { return genericNames(featureId, geoms); }
}
const named = (shape: Shape3D, featureId: string): Named => ({ shape, names: genericNames(featureId, faceGeoms(shape)) });

interface Body {
  id: string; name: string; sketchId: string; distance: number; shape: Shape3D; decals?: ThreadDecal[];
  /** Topological name of each face of `shape`, in face order. */
  faceNames: string[];
  /** Content signature of this body's shape (set when evaluating with a cache). */
  sig?: string;
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
function booleanInto(op: BooleanOp, target: Body, tool: Shape3D, toolNames: string[], featureId: string) {
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
    tool = buildFeatureSolid(doc, scope, f, target ? safeBounds(target.shape) : undefined);
  } catch (e) {
    out[f.id] = { featureId: f.id, name: f.name, sketchId: f.sketchId, distance, error: kernelErrorMessage(e) };
    return;
  }
  if (!target) {
    bodies.push({ id: f.id, name: f.name, sketchId: f.sketchId, distance, shape: tool.shape, faceNames: tool.names });
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
function addOrCombine(f: FeatureDef & { operation?: BooleanOp; body?: string; requireEffect?: boolean }, tool: Named, bodies: Body[], out: Record<string, SolidEval>, label: string) {
  const op = f.operation ?? "new";
  const target = op !== "new" && bodies.length ? pickBody(bodies, f.body, label) : undefined;
  if (!target) { bodies.push({ id: f.id, name: f.name, sketchId: "", distance: 0, shape: tool.shape, faceNames: tool.names }); return; }
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
    tool = { shape, names: faceGeoms(shape).map((_, i) => `${f.id}:f${i}`) };
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
      made.push({ id, name: `${f.name} ${i + 1}`, sketchId: f.sketchId, distance: length, shape, faceNames: genericNames(id, faceGeoms(shape)), member: { origin: m.a, axis: d, profile: label, angles: angles[i] } });
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
        try { booleanInto("join", b, cap, genericNames(`${b.id}:cap`, faceGeoms(cap)), f.id); } finally { cap.delete(); }
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
        made.push({ id, name: `${f.name} gusset ${k}`, sketchId: f.sketchId, distance: 0, shape: plate, faceNames: genericNames(id, faceGeoms(plate)) });
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
  b.faceNames = genericNames(b.id, faceGeoms(built.shape));
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
        return { id: fd.line, a: pt(l.p1), b: pt(l.p2), angle, direction, radius, extend: radius > 0 };
      });
      const origin = f.flip ? { x: wp.origin.x - N.x * t, y: wp.origin.y - N.y * t, z: wp.origin.z - N.z * t } : wp.origin;
      state = { frame: { origin, x: wp.u, y: wp.v, z: N }, base: { regions }, ops: [], edges: blankEdges(regions, lines), folds, ...rules, fixed: f.fixed ?? regions[0].interior };
    }
    const built = buildSheet(state);
    bodies.push({ id: f.id, name: f.name, sketchId: f.sketchId, distance: t, shape: built.shape, faceNames: genericNames(f.id, faceGeoms(built.shape)), sheet: { ...built.state, pattern: built.pattern } });
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
    offset += faceGeoms(input).length;
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
      const toolNames = genericNames(`${f.id}:tool`, faceGeoms(tool));
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
      bodies.push({ id: f.id, name: f.name, sketchId: "", distance: 0, shape: cyl, faceNames: genericNames(f.id, faceGeoms(cyl)), decals: [decal] });
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
            const tapNames = genericNames(`${f.id}:tap`, faceGeoms(shape));
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
function applySweep(doc: CadDocument, f: SweepFeature, bodies: Body[], out: Record<string, SolidEval>) {
  let tool: Named;
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
  addOrCombine(f, tool, bodies, out, "sweep");
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
  addOrCombine(f, tool, bodies, out, "loft");
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
    const hollowed = shellShape(target.shape, t, f.openFaces);
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

interface BodyState { id: string; name: string; sketchId: string; distance: number; shape: Shape3D; faceNames: string[]; decals?: ThreadDecal[]; sig: string; member?: MemberMeta; sheet?: SheetState }
interface StepEffect { bodies: (BodyState & { added: boolean })[]; removed?: string[]; row?: SolidEval; planes: Record<string, WorkPlane> }
interface BodyEval { mesh: SolidMesh; bounds?: Bounds3; mass: MassProps; surface?: boolean }

const cloneShape = (s: Shape3D): Shape3D => (s as unknown as { clone: () => Shape3D }).clone();
const cloneDecals = (d?: ThreadDecal[]) => (d ? d.map((x) => structuredClone(x)) : undefined);

/** Incremental-evaluation cache (lives in the geometry backend, across evaluations). */
export class GeometryCache {
  private steps = new Map<string, { eff: StepEffect; used: number }>();
  private evals = new Map<string, { ev: BodyEval; used: number; bytes: number }>();
  private generation = 0;
  private readonly generations: number;
  private readonly meshBudget: number;
  /** Feature steps replayed from cache / run through the kernel. */
  hits = 0;
  misses = 0;
  /**
   * `generations`: how many recent evaluations' entries to keep. 1 keeps only
   * the live model; more lets switching back to a recent state (another
   * configuration, an undo) replay from cache. `meshBudgetBytes` caps the
   * cached meshes, dropping the least recently used first.
   */
  constructor(opts: { generations?: number; meshBudgetBytes?: number } = {}) {
    this.generations = Math.max(1, Math.floor(opts.generations ?? 1));
    this.meshBudget = opts.meshBudgetBytes ?? 256 * 1024 * 1024;
  }
  step(key: string): StepEffect | undefined { const s = this.steps.get(key); if (s) s.used = this.generation; return s?.eff; }
  storeStep(key: string, eff: StepEffect): void { this.dropStep(key); this.steps.set(key, { eff, used: this.generation }); }
  bodyEval(sig: string): BodyEval | undefined { const e = this.evals.get(sig); if (e) e.used = this.generation; return e?.ev; }
  storeBodyEval(sig: string, e: BodyEval): void {
    const mesh = cloneMesh(e.mesh);
    const bytes = mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength + mesh.edges.byteLength;
    this.evals.set(sig, { ev: { ...e, mesh }, used: this.generation, bytes });
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
  return { positions: m.positions.slice(), normals: m.normals.slice(), indices: m.indices.slice(), edges: m.edges.slice(), triangleCount: m.triangleCount, faceRanges: m.faceRanges?.slice(), faceNames: m.faceNames?.slice() };
}

/** Sketches a feature reads. */
function featureSketches(f: FeatureDef): string[] {
  switch (f.kind) {
    case "extrude": case "revolve": return [f.sketchId];
    case "loft": return f.sketchIds;
    case "sweep": return [f.profileSketch, f.pathSketch];
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
      return op === "new" ? [] : target();
    case "primitive": case "import": case "loft": case "sweep": return op === "new" ? [] : target();
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

/** A step's cache key, or undefined when a body it reads has no signature. */
function stepKey(doc: CadDocument, scope: Scope, f: FeatureDef, bodies: Body[], frame?: Rigid): string | undefined {
  const reads = bodiesRead(doc, f, bodies);
  if (reads.some((b) => !b.sig)) return undefined;
  const def = Object.fromEntries(Object.entries(f).filter(([k]) => !DERIVED_FIELD.test(k)));
  const params = new Set<string>();
  JSON.stringify(f, (_k, v) => { if (typeof v === "string") for (const id of v.match(IDENT) ?? []) if (id in scope) params.add(id); return v; });
  const sketches = featureSketches(f).map((sid) => {
    const sk = doc.sketches[sid];
    return sk ? { id: sid, planeId: sk.planeId, plane: sk.plane, faceRef: sk.faceRef, entities: sk.entities } : { id: sid, missing: true };
  });
  const datum = f.kind === "mirror" ? doc.planes[f.plane]?.plane : undefined;
  return contentHash(stableJson({
    def, sketches, datum, frame,
    params: [...params].sort().map((p) => [p, scope[p]]),
    reads: reads.map((b) => [b.id, b.sig]),
  }));
}

const bodyState = (b: Body): BodyState => ({ id: b.id, name: b.name, sketchId: b.sketchId, distance: b.distance, shape: cloneShape(b.shape), faceNames: b.faceNames.slice(), decals: cloneDecals(b.decals), sig: b.sig!, ...(b.member ? { member: structuredClone(b.member) } : {}), ...(b.sheet ? { sheet: structuredClone(b.sheet) } : {}) });

/** Run one step through `run`, recording what it did; or replay a recorded effect. */
function cachedStep(cache: GeometryCache, key: string, doc: CadDocument, f: FeatureDef, bodies: Body[], out: Record<string, SolidEval>, run: () => void) {
  const hit = cache.step(key);
  if (hit && [...hit.bodies.filter((b) => !b.added).map((b) => b.id), ...(hit.removed ?? [])].every((id) => bodies.some((x) => x.id === id))) {
    cache.hits++;
    for (const id of hit.removed ?? []) { // bodies the step consumed (a stitch)
      const i = bodies.findIndex((x) => x.id === id);
      bodies[i].shape.delete();
      bodies.splice(i, 1);
    }
    for (const b of hit.bodies) {
      const live = { ...bodyState(b as unknown as Body), sig: b.sig };
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
    eff.bodies.push({ ...bodyState(b), added: !was });
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
    case "sweep": applySweep(doc, f, bodies, out); break;
    case "mirror": applyMirror(doc, f, bodies, out); break;
    case "fillet":
    case "chamfer": applyEdgeBlend(scope, f, bodies, out); break;
    case "shell": applyShell(scope, f, bodies, out); break;
    case "pattern": applyPattern(scope, f, bodies, out); break;
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
function evaluateBodies(doc: CadDocument, scope: Scope, cache?: GeometryCache): { bodies: Body[]; out: Record<string, SolidEval> } {
  const out: Record<string, SolidEval> = {};
  const bodies: Body[] = [];
  let worlds: Map<string, Rigid> | undefined; // component frames, resolved only for pattern instances
  for (const f of activeFeatures(doc, scope)) {
    let T: Rigid | undefined;
    if (f.instanceFrame) {
      worlds ??= resolveComponentWorld(doc, scope);
      T = compose(worlds.get(f.instanceFrame.component) ?? IDENTITY, invert(worlds.get(f.instanceFrame.template) ?? IDENTITY));
    }
    const run = T ? () => applyInTemplateFrame(() => applyFeature(doc, scope, f, bodies, out), f, bodies, T!) : () => applyFeature(doc, scope, f, bodies, out);
    const key = cache ? stepKey(doc, scope, f, bodies, T) : undefined;
    if (cache && key) cachedStep(cache, key, doc, f, bodies, out, run);
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
  const features: FeatureDef[] = activeFeatures(doc, scope);
  if (!isKernelReady()) {
    const out: Record<string, SolidEval> = {};
    for (const f of features) {
      out[f.id] = f.kind === "extrude"
        ? { featureId: f.id, name: f.name, sketchId: f.sketchId, distance: resolveDistance(f, scope), error: "kernel not ready" }
        : { ...modifierRow(f), sketchId: f.kind === "revolve" ? f.sketchId : "", error: "kernel not ready" };
    }
    return out;
  }
  cache?.begin();
  try {
    const { bodies, out } = evaluateBodies(doc, scope, cache);
    for (const body of bodies) {
      const row: SolidEval = { ...(out[body.id] ?? {}), featureId: body.id, name: body.name, sketchId: body.sketchId, distance: body.distance };
      if (body.decals?.length) row.threadDecals = body.decals;
      try {
        let ev = cache && body.sig ? cache.bodyEval(body.sig) : undefined;
        if (!ev) {
          ev = { mesh: meshShape(body.shape), bounds: safeBounds(body.shape), mass: massPropsOfShape(body.shape), ...(hasSolid(body.shape) ? {} : { surface: true }) };
          if (cache && body.sig) cache.storeBodyEval(body.sig, ev);
        }
        row.mesh = cloneMesh(ev.mesh);
        if (row.mesh.faceRanges && row.mesh.faceRanges.length === 2 * body.faceNames.length) row.mesh.faceNames = body.faceNames.slice();
        row.bounds = ev.bounds;
        // an open surface encloses nothing: OCC's volume integral over it means nothing
        if (ev.surface) row.volume = 0;
        else if (Number.isFinite(ev.mass.volume)) row.volume = ev.mass.volume;
        if (Number.isFinite(ev.mass.area)) row.area = ev.mass.area;
        if (Number.isFinite(ev.mass.centroid.x)) row.centroid = ev.mass.centroid;
        if (ev.surface) row.surface = true;
        if (body.member) row.member = { profile: body.member.profile, length: extentAlong(ev.mesh.positions, body.member.axis), angles: body.member.angles };
        if (body.sheet?.pattern) {
          const sh = body.sheet;
          row.sheet = { thickness: sh.thickness, kFactor: sh.kFactor, unfolded: !!sh.unfolded, ...(sh.edited && !sh.unfolded ? { stale: true } : {}), angles: Object.fromEntries(Object.entries(sh.angles ?? {}).map(([k, v]) => [k, Math.round(v * 180 / Math.PI * 1e6) / 1e6])), edges: sh.edges.map((e) => e.name), flat: sh.pattern! };
        }
      } catch (e) {
        row.error = kernelErrorMessage(e);
      } finally {
        body.shape.delete();
      }
      out[body.id] = row;
    }
    return out;
  } finally {
    cache?.end();
  }
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

/** Build every body and measure how much any two of them interpenetrate. Used by
 *  the motion study to pass/fail a configuration: designed point/line contact has
 *  no volume, so only real overlap registers. */
export function collideFeatures(doc: CadDocument, scope: Scope): CollisionResult {
  const { bodies, out } = evaluateBodies(doc, scope);
  const buildError = Object.values(out).find((o) => o.error)?.error;
  const overlaps: CollisionResult["overlaps"] = [];
  let maxOverlap = 0;
  try {
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        let vol = 0;
        try {
          const inter = intersectShapes(bodies[i].shape, bodies[j].shape);
          try { const v = volumeOfShape(inter); if (Number.isFinite(v)) vol = Math.abs(v); } finally { inter.delete(); }
        } catch { vol = 0; } // disjoint / touching solids → no common volume
        if (vol > 1e-4) { overlaps.push({ a: bodies[i].name, b: bodies[j].name, aId: bodies[i].id, bId: bodies[j].id, volume: vol }); maxOverlap = Math.max(maxOverlap, vol); }
      }
    }
  } finally {
    for (const b of bodies) { try { b.shape.delete(); } catch { /* already freed */ } }
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
 */
export function exportFusedBlob(doc: CadDocument, scope: Scope, format: "stl" | "step"): Blob | null {
  if (!isKernelReady()) return null;
  const { bodies } = evaluateBodies(doc, scope);
  const partials: Shape3D[] = []; // fuse results (the operands stay owned by their bodies)
  try {
    let fused: Shape3D | null = null;
    for (const b of bodies) {
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
 */
export function printPartsByMaterial(doc: CadDocument, scope: Scope): { name: string; color?: string; mesh: SolidMesh }[] {
  if (!isKernelReady()) return [];
  const { bodies } = evaluateBodies(doc, scope);
  const groups = new Map<string, { name: string; color?: string; shapes: Shape3D[] }>();
  for (const b of bodies) {
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
