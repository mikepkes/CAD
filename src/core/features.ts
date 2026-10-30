// Evaluate solid features (extrude) from the document. Resolves each feature's
// parametric distance, extracts the sketch region(s), and asks the OCC kernel
// for a display mesh. Features combine into bodies via boolean operations
// (new / join / cut), Fusion-style: a joined extrude fuses into the running
// body, a cut subtracts from it. Kept separate from the (fast, pure) sketch
// recompute because it drives the heavier B-rep kernel.

import { compileExpr, Scope } from "../math/expr";
import {
  CadDocument, ExtrudeFeature, FeatureDef, ImportFeature, MirrorFeature, EdgeBlendFeature, ShellFeature, PatternFeature, LoftFeature, SweepFeature, SketchFeature, PrimitiveFeature, HoleFeature, ThreadFeature, ThreadSpec, ThreadDecal, BooleanOp, materialForComponent,
} from "./document";
import { offsetPlane, resolveSketchPlane, planeById, makePlaneFromNormal, to3d, WorkPlane } from "../geometry/plane";
import { extractRegions, extractOpenPath, regionAt, Region } from "./geometry/profile";
import { FaceRef } from "../sketch/types";
import {
  Edge3D, buildRegionsSolid, buildRegionsRevolved, buildLoftSolid, buildSweepSolid, fuseShapes, intersectShapes, mirrorShape, meshShape, edgesOfShape, blobOfShape,
  planarFacesOfShape, PlanarFace, isKernelReady, SolidMesh, blendEdges, shellShape, translateShape, rotateShape,
  boundsOfShape, volumeOfShape, massPropsOfShape, MassProps, Bounds3, buildPrimitive, buildHoleCutter, HoleCutterSpec, buildThread,
  faceGeoms, edgeGeoms, FaceGeom, EdgeGeom, booleanWithHistory, BooleanKind, surfaceParents, distanceBetween, readStep,
} from "./occ/kernel";
import { genericNames, extrudeNames, revolveNames, holeCutterNames, inheritNames, copyNames, edgeNamesOf } from "./naming";
import { stableJson, contentHash } from "./contentKey";
import type { Shape3D } from "replicad";
import { Vec3 } from "../math/vec";
import { Rigid, IDENTITY, axisAngle, compose, invert, applyPoint, applyVec } from "../math/transform";
import { resolveComponentWorld } from "./recompute";

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
}

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
    out[f.id] = { featureId: f.id, name: f.name, sketchId: f.sketchId, distance, error: (e as Error).message };
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
    out[f.id] = { featureId: f.id, name: f.name, sketchId: f.sketchId, distance, error: (e as Error).message };
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
    out[f.id] = { ...modifierRow(f), error: (e as Error).message };
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
    out[f.id] = { ...modifierRow(f), error: (e as Error).message };
    return;
  }
  addOrCombine(f, tool, bodies, out, f.shape);
}

/** Read an imported file into a body (or fold it into one). Faces are named by file order. */
function applyImport(f: ImportFeature, bodies: Body[], out: Record<string, SolidEval>) {
  let tool: Named;
  try {
    let shape = readStep(f.data);
    if (f.at && (f.at.x || f.at.y || f.at.z)) { const moved = translateShape(shape, f.at); shape.delete(); shape = moved; }
    tool = { shape, names: faceGeoms(shape).map((_, i) => `${f.id}:f${i}`) };
  } catch (e) {
    out[f.id] = { ...modifierRow(f), error: `import: ${(e as Error).message}` };
    return;
  }
  addOrCombine(f, tool, bodies, out, "import");
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
    catch (e) { out[f.id].error = (e as Error).message; }
  };

  if (!modeled) { cosmetic(); return; }

  try {
    const rod = named(placeAlong(buildThreadRod(f.spec, internal ? 0.1 : 0), { x: 0, y: 0, z: 1 }, axis, f.at), f.id);
    const op = internal ? "cut" : (f.operation ?? "new");
    if (op !== "cut" && (op === "new" || !bodies.length)) { bodies.push({ id: f.id, name: f.name, sketchId: "", distance: 0, shape: rod.shape, faceNames: rod.names }); return; }
    combineBody(op, pickBody(bodies, f.body, "thread"), rod, f, "thread", out);
  } catch (e) {
    cosmetic(`modelled thread fell back to cosmetic: ${(e as Error).message}`); // kernel couldn't form it
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
        } catch (e) { addDecals(`modelled thread fell back to cosmetic: ${(e as Error).message}`); }
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
    out[f.id].error = (e as Error).message;
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
    out[f.id] = { ...modifierRow(f), error: (e as Error).message };
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
    out[f.id] = { ...modifierRow(f), error: (e as Error).message };
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
    out[f.id].error = (e as Error).message;
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
    out[f.id].error = (e as Error).message;
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
    out[f.id].error = (e as Error).message;
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
    out[f.id].error = (e as Error).message;
    return;
  }
  const targets = f.bodies === "last" ? bodies.slice(-1) : bodies;
  for (const body of targets) {
    try {
      const reflected = mirrorShape(body.shape, wp); // new shape (same face order); body.shape untouched
      try { booleanInto("join", body, reflected, copyNames(body.faceNames, f.id), f.id); }
      finally { reflected.delete(); }
    } catch (e) {
      out[f.id].error = (e as Error).message;
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

interface BodyState { id: string; name: string; sketchId: string; distance: number; shape: Shape3D; faceNames: string[]; decals?: ThreadDecal[]; sig: string }
interface StepEffect { bodies: (BodyState & { added: boolean })[]; row?: SolidEval; planes: Record<string, WorkPlane> }
interface BodyEval { mesh: SolidMesh; bounds?: Bounds3; mass: MassProps }

const cloneShape = (s: Shape3D): Shape3D => (s as unknown as { clone: () => Shape3D }).clone();
const cloneDecals = (d?: ThreadDecal[]) => (d ? d.map((x) => structuredClone(x)) : undefined);

/** Incremental-evaluation cache (lives in the geometry backend, across evaluations). */
export class GeometryCache {
  private steps = new Map<string, StepEffect>();
  private evals = new Map<string, BodyEval>();
  private usedSteps = new Set<string>();
  private usedEvals = new Set<string>();
  /** Feature steps replayed from cache / run through the kernel. */
  hits = 0;
  misses = 0;
  step(key: string): StepEffect | undefined { const s = this.steps.get(key); if (s) this.usedSteps.add(key); return s; }
  storeStep(key: string, eff: StepEffect): void { this.dropStep(key); this.steps.set(key, eff); this.usedSteps.add(key); }
  bodyEval(sig: string): BodyEval | undefined { const e = this.evals.get(sig); if (e) this.usedEvals.add(sig); return e; }
  storeBodyEval(sig: string, e: BodyEval): void { this.evals.set(sig, { ...e, mesh: cloneMesh(e.mesh) }); this.usedEvals.add(sig); }
  /** Start an evaluation: track which entries it touches. */
  begin(): void { this.usedSteps.clear(); this.usedEvals.clear(); }
  /** Finish one: drop (and free) everything it didn't touch, bounding the cache to the live model. */
  end(): void {
    for (const k of [...this.steps.keys()]) if (!this.usedSteps.has(k)) this.dropStep(k);
    for (const k of [...this.evals.keys()]) if (!this.usedEvals.has(k)) this.evals.delete(k);
  }
  clear(): void { for (const k of [...this.steps.keys()]) this.dropStep(k); this.evals.clear(); }
  /** Bodies with a cached mesh. */
  get size(): number { return this.evals.size; }
  /** Feature steps with a cached effect. */
  get stepCount(): number { return this.steps.size; }
  private dropStep(key: string): void {
    const s = this.steps.get(key);
    if (!s) return;
    for (const b of s.bodies) { try { b.shape.delete(); } catch { /* already freed */ } }
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

const bodyState = (b: Body): BodyState => ({ id: b.id, name: b.name, sketchId: b.sketchId, distance: b.distance, shape: cloneShape(b.shape), faceNames: b.faceNames.slice(), decals: cloneDecals(b.decals), sig: b.sig! });

/** Run one step through `run`, recording what it did; or replay a recorded effect. */
function cachedStep(cache: GeometryCache, key: string, doc: CadDocument, f: FeatureDef, bodies: Body[], out: Record<string, SolidEval>, run: () => void) {
  const hit = cache.step(key);
  if (hit && hit.bodies.every((b) => b.added || bodies.some((x) => x.id === b.id))) {
    cache.hits++;
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

/** Whether a feature is switched on: no `when`, or a `when` that's non-zero
 *  (one that can't be evaluated leaves the feature on rather than drop it). */
export function featureActive(f: FeatureDef, scope: Scope): boolean {
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
          ev = { mesh: meshShape(body.shape), bounds: safeBounds(body.shape), mass: massPropsOfShape(body.shape) };
          if (cache && body.sig) cache.storeBodyEval(body.sig, ev);
        }
        row.mesh = cloneMesh(ev.mesh);
        if (row.mesh.faceRanges && row.mesh.faceRanges.length === 2 * body.faceNames.length) row.mesh.faceNames = body.faceNames.slice();
        row.bounds = ev.bounds;
        if (Number.isFinite(ev.mass.volume)) row.volume = ev.mass.volume;
        if (Number.isFinite(ev.mass.area)) row.area = ev.mass.area;
        if (Number.isFinite(ev.mass.centroid.x)) row.centroid = ev.mass.centroid;
      } catch (e) {
        row.error = (e as Error).message;
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
      return { id: b.id, name: b.name, volume: mass.volume, area: mass.area, centroid: mass.centroid, bounds: safeBounds(b.shape), faces, edges };
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
