// Evaluate solid features (extrude) from the document. Resolves each feature's
// parametric distance, extracts the sketch region(s), and asks the OCC kernel
// for a display mesh. Features combine into bodies via boolean operations
// (new / join / cut), Fusion-style: a joined extrude fuses into the running
// body, a cut subtracts from it. Kept separate from the (fast, pure) sketch
// recompute because it drives the heavier B-rep kernel.

import { compileExpr, Scope } from "../math/expr";
import {
  CadDocument, ExtrudeFeature, FeatureDef, MirrorFeature, EdgeBlendFeature, ShellFeature, PatternFeature, LoftFeature, SweepFeature, SketchFeature, PrimitiveFeature, HoleFeature, ThreadFeature, ThreadSpec, ThreadDecal, BooleanOp,
} from "./document";
import { offsetPlane, resolveSketchPlane, planeById, makePlaneFromNormal, to3d, WorkPlane } from "../geometry/plane";
import { extractRegions, extractOpenPath, regionAt, Region } from "./geometry/profile";
import { FaceRef } from "../sketch/types";
import {
  Edge3D, buildRegionsSolid, buildRegionsRevolved, buildLoftSolid, buildSweepSolid, fuseShapes, cutShapes, intersectShapes, mirrorShape, meshShape, edgesOfShape, blobOfShape,
  planarFacesOfShape, PlanarFace, isKernelReady, SolidMesh, blendEdges, shellShape, translateShape, rotateShape,
  boundsOfShape, volumeOfShape, Bounds3, buildPrimitive, buildHoleCutter, HoleCutterSpec, buildThread,
} from "./occ/kernel";
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
 * Build this feature's solid in isolation (regions extruded/revolved + fused).
 * `targetBounds` sizes a through-all extrude against the body it will act on.
 */
function buildFeatureSolid(doc: CadDocument, scope: Scope, f: SketchFeature, targetBounds?: Bounds3): Shape3D {
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
    return buildRegionsRevolved(wp0, regions, o, dir, Math.abs(angle) < 1e-9 ? 360 : angle);
  }
  let distance = resolveDistance(f, scope);
  // Through-all: a length that clears the target body from any face of it, both ways when symmetric.
  if (f.extent === "throughAll") distance = throughAllLength(targetBounds) * (f.symmetric ? 2 : 1);
  if (f.direction === "reverse") distance = -distance;
  const d = Math.abs(distance) < 1e-9 ? 1e-6 : distance;
  const wp = f.symmetric ? offsetPlane(wp0, -d / 2) : wp0;
  return buildRegionsSolid(wp, regions, d);
}

interface Body { id: string; name: string; sketchId: string; distance: number; shape: Shape3D; decals?: ThreadDecal[] }

/** Row for a feature that modifies bodies but makes none (listed in the inspector/timeline, not rendered). */
const modifierRow = (f: FeatureDef): SolidEval => ({ featureId: f.id, name: f.name, sketchId: "", distance: 0 });

/** The body a modifier (cut/join/fillet/shell/pattern) acts on: the most recent one. */
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

const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * Re-resolve the current plane of the face a sketch references, by matching the
 * stored normal against the live bodies' planar faces (tie-broken by nearness to
 * the original pick point). Returns the face's frame, built with the same origin
 * convention as creation (foot of the perpendicular from the world origin), so
 * the sketch's (u,v) geometry maps consistently as the face moves.
 */
function resolveFacePlane(bodies: Body[], ref: FaceRef): WorkPlane | undefined {
  const faces: PlanarFace[] = [];
  for (const b of bodies) {
    try { faces.push(...planarFacesOfShape(b.shape)); } catch { /* skip a bad body */ }
  }
  let best: PlanarFace | undefined;
  let bestScore = Infinity;
  for (const f of faces) {
    const align = dot(f.normal, ref.normal); // both ~unit; ~1 when same direction
    if (align < 0.99) continue; // only faces pointing the same way as the pick
    const dx = f.origin.x - ref.point.x, dy = f.origin.y - ref.point.y, dz = f.origin.z - ref.point.z;
    const score = dx * dx + dy * dy + dz * dz; // nearest centroid to the pick
    if (score < bestScore) { bestScore = score; best = f; }
  }
  if (!best) return undefined;
  const n = best.normal;
  const off = dot(best.origin, n); // signed plane offset along the normal
  const origin = { x: n.x * off, y: n.y * off, z: n.z * off };
  return makePlaneFromNormal(origin, n);
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
  let shape: Shape3D;
  try {
    shape = buildFeatureSolid(doc, scope, f, target ? safeBounds(target.shape) : undefined);
  } catch (e) {
    out[f.id] = { featureId: f.id, name: f.name, sketchId: f.sketchId, distance, error: (e as Error).message };
    return;
  }
  if (!target) {
    bodies.push({ id: f.id, name: f.name, sketchId: f.sketchId, distance, shape });
    return;
  }
  try {
    const before = volumeOfShape(target.shape);
    const combined = op === "cut" ? cutShapes(target.shape, shape) : op === "intersect" ? intersectShapes(target.shape, shape) : fuseShapes(target.shape, shape);
    shape.delete();
    replaceShape(target, combined);
    const after = volumeOfShape(target.shape);
    // A boolean that changed nothing almost always means the tool missed the body
    // (wrong plane offset / direction) — say so instead of failing silently.
    if (Number.isFinite(before) && Number.isFinite(after) && Math.abs(after - before) <= 1e-6 * Math.max(1, before)) {
      const msg = `${op} changed nothing: the ${f.kind} does not intersect the body (check plane offset, direction, extent)`;
      out[f.id] = { ...modifierRow(f), sketchId: f.sketchId, distance, ...(f.requireEffect ? { error: msg } : { warning: msg }) };
    }
  } catch (e) {
    shape.delete();
    out[f.id] = { featureId: f.id, name: f.name, sketchId: f.sketchId, distance, error: (e as Error).message };
  }
}

function safeBounds(shape: Shape3D): Bounds3 | undefined {
  try { return boundsOfShape(shape); } catch { return undefined; }
}

/** Fold a freshly built solid into an existing body via a boolean op, detecting a
 *  no-op (tool missed the body). Consumes `shape`. On a no-op or failure it writes
 *  a modifier row for the feature (error when it opted into `requireEffect`). */
function combineBody(op: BooleanOp, target: Body, shape: Shape3D, f: FeatureDef & { requireEffect?: boolean }, label: string, out: Record<string, SolidEval>) {
  try {
    const before = volumeOfShape(target.shape);
    const combined = op === "cut" ? cutShapes(target.shape, shape) : op === "intersect" ? intersectShapes(target.shape, shape) : fuseShapes(target.shape, shape);
    shape.delete();
    replaceShape(target, combined);
    const after = volumeOfShape(target.shape);
    if (Number.isFinite(before) && Number.isFinite(after) && Math.abs(after - before) <= 1e-6 * Math.max(1, Math.abs(before))) {
      const msg = `${op} changed nothing: the ${label} does not intersect the body (check position, size, operation)`;
      out[f.id] = { ...modifierRow(f), ...(f.requireEffect ? { error: msg } : { warning: msg }) };
    }
  } catch (e) {
    shape.delete();
    out[f.id] = { ...modifierRow(f), error: (e as Error).message };
  }
}

/** Build a primitive solid (box/cylinder/cone/sphere/torus) and fold it in. */
function applyPrimitive(scope: Scope, f: PrimitiveFeature, bodies: Body[], out: Record<string, SolidEval>) {
  let shape: Shape3D;
  try {
    const dim = (k: keyof PrimitiveFeature["dims"]): number | undefined => {
      const expr = f.dims[k];
      if (expr == null) return undefined;
      const v = resolveExpr(expr, (f.dimValues?.[k] as number) ?? 0, scope);
      (f.dimValues ??= {})[k] = v;
      return v;
    };
    shape = buildPrimitive({
      shape: f.shape, at: f.at ?? { x: 0, y: 0, z: 0 },
      x: dim("x"), y: dim("y"), z: dim("z"), radius: dim("radius"), radius2: dim("radius2"), height: dim("height"), tube: dim("tube"),
    });
  } catch (e) {
    out[f.id] = { ...modifierRow(f), error: (e as Error).message };
    return;
  }
  const op = f.operation ?? "new";
  const target = op !== "new" && bodies.length ? pickBody(bodies, f.body, "primitive") : undefined;
  if (!target) { bodies.push({ id: f.id, name: f.name, sketchId: "", distance: 0, shape }); return; }
  combineBody(op, target, shape, f, f.shape, out);
}

const V = {
  norm: (a: Vec3): Vec3 => { const m = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / m, y: a.y / m, z: a.z / m }; },
  cross: (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }),
  dot: (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z,
};

/** Rotate `base` so its `from` axis aligns with world `axis`, then translate to
 *  `p`. Returns a fresh shape (the base is preserved). */
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
      bodies.push({ id: f.id, name: f.name, sketchId: "", distance: 0, shape: cyl, decals: [decal] });
      return;
    }
    try { (pickBody(bodies, f.body, "thread").decals ??= []).push(decal); }
    catch (e) { out[f.id].error = (e as Error).message; }
  };

  if (!modeled) { cosmetic(); return; }

  try {
    const rod = placeAlong(buildThreadRod(f.spec, internal ? 0.1 : 0), { x: 0, y: 0, z: 1 }, axis, f.at);
    const op = internal ? "cut" : (f.operation ?? "new");
    if (op !== "cut" && (op === "new" || !bodies.length)) { bodies.push({ id: f.id, name: f.name, sketchId: "", distance: 0, shape: rod }); return; }
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
    const axis = f.axis ?? { x: 0, y: 0, z: -1 };
    const pts = f.at && f.at.length ? f.at : [{ x: 0, y: 0, z: 0 }];
    const before = volumeOfShape(target.shape);
    try {
      for (const p of pts) {
        const cutter = orientCutter(base, axis, p);
        try { const cut = cutShapes(target.shape, cutter); replaceShape(target, cut); }
        finally { cutter.delete(); }
      }
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
            for (const p of pts) {
              const tap = placeAlong(shape, { x: 0, y: 0, z: 1 }, axis, p);
              try { const cut = cutShapes(target.shape, tap); replaceShape(target, cut); }
              finally { tap.delete(); }
            }
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
  let shape: Shape3D;
  try {
    const profileSk = doc.sketches[f.profileSketch];
    const pathSk = doc.sketches[f.pathSketch];
    if (!profileSk) throw new Error(`sweep: no profile sketch "${f.profileSketch}"`);
    if (!pathSk) throw new Error(`sweep: no path sketch "${f.pathSketch}"`);
    const regions = extractRegions(profileSk);
    if (!regions.length) throw new Error("sweep: profile sketch has no closed region");
    const path = extractOpenPath(pathSk);
    if (!path) throw new Error("sweep: path sketch has no open chain of lines/arcs");
    shape = buildSweepSolid(regions[0], resolveSketchPlane(pathSk), path);
  } catch (e) {
    out[f.id] = { ...modifierRow(f), error: (e as Error).message };
    return;
  }
  const op = f.operation ?? "new";
  const target = op !== "new" && bodies.length ? pickBody(bodies, f.body, "sweep") : undefined;
  if (!target) { bodies.push({ id: f.id, name: f.name, sketchId: "", distance: 0, shape }); return; }
  combineBody(op, target, shape, f, "sweep", out);
}

/** Loft a solid through the feature's ordered profile sketches, then combine it. */
function applyLoft(doc: CadDocument, f: LoftFeature, bodies: Body[], out: Record<string, SolidEval>) {
  let shape: Shape3D;
  try {
    const profiles = f.sketchIds.map((sid) => {
      const sk = doc.sketches[sid];
      if (!sk) throw new Error(`loft: no sketch "${sid}"`);
      const regions = extractRegions(sk);
      if (!regions.length) throw new Error(`loft: sketch "${sk.name}" has no closed region`);
      return { wp: resolveSketchPlane(sk), region: regions[0] };
    });
    if (profiles.length < 2) throw new Error("loft needs at least two profile sketches");
    shape = buildLoftSolid(profiles, !!f.ruled);
  } catch (e) {
    out[f.id] = { ...modifierRow(f), error: (e as Error).message };
    return;
  }
  const op = f.operation ?? "new";
  const target = op !== "new" && bodies.length ? pickBody(bodies, f.body, "loft") : undefined;
  if (!target) { bodies.push({ id: f.id, name: f.name, sketchId: "", distance: 0, shape }); return; }
  combineBody(op, target, shape, f, "loft", out);
}

/** Fillet or chamfer the selected edges of the most recent body. */
function applyEdgeBlend(scope: Scope, f: EdgeBlendFeature, bodies: Body[], out: Record<string, SolidEval>) {
  out[f.id] = modifierRow(f);
  try {
    const target = pickBody(bodies, f.body, f.kind);
    const size = resolveExpr(f.sizeExpr, f.sizeValue, scope);
    f.sizeValue = size;
    if (!(size > 0)) throw new Error(`${f.kind} size must be positive`);
    const before = volumeOfShape(target.shape);
    const blended = blendEdges(target.shape, f.kind, size, f.edges);
    const after = volumeOfShape(blended);
    const dim = f.kind === "fillet" ? "radius" : "setback";
    // An un-measurable result means OCC produced an invalid solid (usually the
    // size doesn't fit): don't corrupt the body with it — surface the failure.
    if (Number.isFinite(before) && !Number.isFinite(after)) {
      blended.delete();
      throw new Error(`${f.kind} failed: the ${dim} (${size}) does not fit the selected edges`);
    }
    replaceShape(target, blended);
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
    replaceShape(target, hollowed);
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
    for (let i = 1; i < n; i++) {
      let copy: Shape3D;
      if (f.mode === "linear") {
        const s = f.step ?? { x: 0, y: 0, z: 0 };
        copy = translateShape(original, { x: s.x * i, y: s.y * i, z: s.z * i });
      } else {
        const ax = f.axis ?? { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } };
        copy = rotateShape(original, (f.angle ?? 360 / n) * i, ax.origin, ax.direction);
      }
      const fused = fuseShapes(acc, copy);
      acc.delete(); copy.delete();
      acc = fused;
    }
    replaceShape(target, acc);
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
      const reflected = mirrorShape(body.shape, wp); // new shape; body.shape untouched
      const fused = fuseShapes(body.shape, reflected);
      body.shape.delete();
      reflected.delete();
      body.shape = fused;
    } catch (e) {
      out[f.id].error = (e as Error).message;
    }
  }
}

/**
 * A per-body mesh cache for incremental evaluation. Keyed by a content signature
 * of everything that shapes a body, so an edit only rebuilds the bodies whose
 * inputs changed; the rest are served from cache. Lives in the geometry backend
 * (persists across evaluations). Stored meshes are pristine copies — the output
 * always gets its own copy, so transferring output buffers never detaches them.
 */
export class GeometryCache {
  private meshes = new Map<string, SolidMesh>();
  hits = 0;
  misses = 0;
  get(sig: string): SolidMesh | undefined { return this.meshes.get(sig); }
  store(sig: string, mesh: SolidMesh): void { this.meshes.set(sig, cloneMesh(mesh)); }
  /** Drop entries not touched this evaluation (bounds the cache to the live model). */
  prune(used: Set<string>): void { for (const k of this.meshes.keys()) if (!used.has(k)) this.meshes.delete(k); }
  clear(): void { this.meshes.clear(); }
  get size(): number { return this.meshes.size; }
}

function cloneMesh(m: SolidMesh): SolidMesh {
  return { positions: m.positions.slice(), normals: m.normals.slice(), indices: m.indices.slice(), edges: m.edges.slice(), triangleCount: m.triangleCount };
}

/** A body group: a "new" extrude plus the join/cut extrudes folded into it. */
interface ExtrudeGroup { newId: string; name: string; sketchId: string; features: ExtrudeFeature[] }

function groupExtrudes(features: FeatureDef[]): ExtrudeGroup[] {
  const groups: ExtrudeGroup[] = [];
  for (const f of features) {
    if (f.kind !== "extrude") continue;
    const op = f.operation ?? "new";
    if (op === "new" || groups.length === 0) groups.push({ newId: f.id, name: f.name, sketchId: f.sketchId, features: [f] });
    else groups[groups.length - 1].features.push(f);
  }
  return groups;
}

/** A content signature for a body group: changes iff its built shape would change. */
function groupSignature(doc: CadDocument, scope: Scope, g: ExtrudeGroup): string {
  const parts: string[] = [];
  for (const f of g.features) {
    parts.push(f.id, f.operation ?? "new", f.symmetric ? "s" : "", f.direction ?? "", f.extent ?? "", f.regionPoint ? `${f.regionPoint.x},${f.regionPoint.y}` : "", String(resolveDistance(f, scope)));
    const sk = doc.sketches[f.sketchId];
    if (sk) parts.push(sketchSignature(sk));
  }
  return parts.join("|");
}

function sketchSignature(sk: { entities: Record<string, unknown>; plane?: WorkPlane; planeId: string }): string {
  const ents: number[] = [];
  for (const e of Object.values(sk.entities) as { kind: string; x?: number; y?: number; r?: number; rx?: number; ry?: number; rotation?: number }[]) {
    ents.push(e.x ?? 0, e.y ?? 0, e.r ?? 0, e.rx ?? 0, e.ry ?? 0, e.rotation ?? 0);
  }
  const p = sk.plane ? sk.plane.origin : { x: 0, y: 0, z: 0 };
  const n = sk.plane ? sk.plane.normal : { x: 0, y: 0, z: 0 };
  // The in-plane basis matters too: a sketch that only rotates about its own
  // normal (a jointed bar swinging within its plane) keeps the same origin and
  // normal, so without u/v its signature would be stale and the cache would
  // serve a mesh built at the previous pose.
  const u = sk.plane ? sk.plane.u : { x: 0, y: 0, z: 0 };
  return `${sk.planeId}:${p.x},${p.y},${p.z},${n.x},${n.y},${n.z},${u.x},${u.y},${u.z}#${ents.join(",")}`;
}

/** Build a body group's final shape: its "new" extrude with its joins/cuts folded in. */
function buildGroupShape(doc: CadDocument, scope: Scope, g: ExtrudeGroup): Shape3D {
  let shape = buildFeatureSolid(doc, scope, g.features[0]);
  for (let i = 1; i < g.features.length; i++) {
    const f = g.features[i];
    const s = buildFeatureSolid(doc, scope, f, f.extent === "throughAll" ? safeBounds(shape) : undefined);
    const combined = (f.operation ?? "new") === "cut" ? cutShapes(shape, s) : fuseShapes(shape, s);
    shape.delete(); s.delete();
    shape = combined;
  }
  return shape;
}

export function evaluateFeatures(doc: CadDocument, scope: Scope, cache?: GeometryCache): Record<string, SolidEval> {
  const features: FeatureDef[] = Object.values(doc.features);
  if (!isKernelReady()) {
    const out: Record<string, SolidEval> = {};
    for (const f of features) {
      out[f.id] = f.kind === "extrude"
        ? { featureId: f.id, name: f.name, sketchId: f.sketchId, distance: resolveDistance(f, scope), error: "kernel not ready" }
        : { ...modifierRow(f), sketchId: f.kind === "revolve" ? f.sketchId : "", error: "kernel not ready" };
    }
    return out;
  }
  // The cache only applies when every body is independent: extrude-only models
  // with no face-referenced sketch. Modifiers (mirror, fillet, shell, pattern,
  // revolve) take the full path — still correct, just not incremental.
  // Body targeting and requireEffect both need the full, ordered path (the cache
  // groups join/cuts onto the previous "new" and never flags no-ops), so they opt
  // out of incremental evaluation.
  const independent = features.every((f) => f.kind === "extrude" && !f.body && !f.requireEffect)
    && !Object.values(doc.sketches).some((s) => s.faceRef);
  if (cache && independent) return evaluateCached(doc, scope, cache);
  return evaluateFull(doc, scope);
}

/** Incremental: rebuild only the body groups whose signature changed. */
function evaluateCached(doc: CadDocument, scope: Scope, cache: GeometryCache): Record<string, SolidEval> {
  const out: Record<string, SolidEval> = {};
  const used = new Set<string>();
  for (const g of groupExtrudes(Object.values(doc.features))) {
    const distance = resolveDistance(g.features[0], scope);
    const meta = { featureId: g.newId, name: g.name, sketchId: g.sketchId, distance };
    const sig = groupSignature(doc, scope, g);
    used.add(sig);
    const hit = cache.get(sig);
    if (hit) { cache.hits++; out[g.newId] = { ...meta, mesh: cloneMesh(hit) }; continue; }
    cache.misses++;
    try {
      const shape = buildGroupShape(doc, scope, g);
      let mesh: SolidMesh;
      try { mesh = meshShape(shape); } finally { shape.delete(); }
      cache.store(sig, mesh);
      out[g.newId] = { ...meta, mesh };
    } catch (e) {
      out[g.newId] = { ...meta, error: (e as Error).message };
    }
  }
  cache.prune(used);
  return out;
}

function applyFeature(doc: CadDocument, scope: Scope, f: FeatureDef, bodies: Body[], out: Record<string, SolidEval>) {
  switch (f.kind) {
    case "extrude":
    case "revolve": applySketchFeature(doc, scope, f, bodies, out); break;
    case "primitive": applyPrimitive(scope, f, bodies, out); break;
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

/** Copy of a shape moved by a rigid transform (operand untouched). */
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

/** Build every feature in order into live bodies (caller frees the shapes). */
function evaluateBodies(doc: CadDocument, scope: Scope): { bodies: Body[]; out: Record<string, SolidEval> } {
  const out: Record<string, SolidEval> = {};
  const bodies: Body[] = [];
  let worlds: Map<string, Rigid> | undefined; // component frames, resolved only for pattern instances
  for (const f of Object.values(doc.features)) {
    if (!f.instanceFrame) { applyFeature(doc, scope, f, bodies, out); continue; }
    worlds ??= resolveComponentWorld(doc, scope);
    const T = compose(worlds.get(f.instanceFrame.component) ?? IDENTITY, invert(worlds.get(f.instanceFrame.template) ?? IDENTITY));
    applyInTemplateFrame(() => applyFeature(doc, scope, f, bodies, out), f, bodies, T);
  }
  return { bodies, out };
}

/** Full evaluation: builds every feature in order (handles modifiers + face refs). */
function evaluateFull(doc: CadDocument, scope: Scope): Record<string, SolidEval> {
  const { bodies, out } = evaluateBodies(doc, scope);
  for (const body of bodies) {
    const row: SolidEval = { ...(out[body.id] ?? {}), featureId: body.id, name: body.name, sketchId: body.sketchId, distance: body.distance };
    if (body.decals?.length) row.threadDecals = body.decals;
    try {
      row.mesh = meshShape(body.shape);
      row.bounds = safeBounds(body.shape);
      const vol = volumeOfShape(body.shape);
      if (Number.isFinite(vol)) row.volume = vol;
    } catch (e) {
      row.error = (e as Error).message;
    } finally {
      body.shape.delete();
    }
    out[body.id] = row;
  }
  return out;
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
    const solid = buildFeatureSolid(doc, scope, f);
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

/** Export bytes (transferable) — the worker-safe form of exportFeatureBlob. */
export async function exportFeatureBytes(doc: CadDocument, scope: Scope, featureId: string, format: "stl" | "step"): Promise<Uint8Array | null> {
  const blob = exportFeatureBlob(doc, scope, featureId, format);
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}
