// Recompute: derive solved state from design intent. Resolves parameters, then
// for every sketch compiles → solves → writes solved coordinates back onto the
// entities and records a diagnosis (DoF, conflicts, redundancies). This is the
// "math solve" layer; it is independent of any renderer.

import { CadDocument } from "./document";
import { resolveParameters } from "../model/parameters";
import { ConstraintSolver, SolveDiagnosis } from "./solver/model";
import { compileSketch } from "./solver/compile";
import { compileExpr, Scope } from "../math/expr";
import { planeById, offsetPlane, makePlaneFromNormal, WorkPlane } from "../geometry/plane";
import { Rigid, IDENTITY, translation, compose, invert, applyPoint, applyVec, rotationAbout } from "../math/transform";
import { Vec3 } from "../math/vec";
import { Joint } from "./document";
import { DimensionConstraint, Sketch, SketchArc, SketchCircle, SketchLine, SketchPoint } from "../sketch/types";

export interface SketchEvaluation {
  sketchId: string;
  diagnosis: SolveDiagnosis;
  status: "ok" | "failed" | "invalid" | "empty";
  warnings: string[];
  message: string;
}

export type Evaluations = Record<string, SketchEvaluation>;

export async function recompute(
  doc: CadDocument,
  solver: ConstraintSolver
): Promise<Evaluations> {
  const { scope, resolved } = resolveParameters(doc.parameters);
  doc.parameters = resolved;

  // Resolve datum planes (parametric frames) and place each sketch in its owning
  // component's world frame, so geometry moves when a datum offset or a joint
  // value changes.
  placeComponentSketches(doc, scope);

  const evals: Evaluations = {};

  for (const sketch of Object.values(doc.sketches)) {
    placeParametricPoints(sketch, scope);
    const { model, warnings, dimensionValues } = compileSketch(sketch, scope);

    // Update stored dimension values regardless of solve outcome.
    for (const [cid, v] of Object.entries(dimensionValues)) {
      const c = sketch.constraints[cid];
      if (c && "expr" in c) (c as { value: number }).value = v;
    }

    if (model.points.length === 0) {
      evals[sketch.id] = emptyEval(sketch.id);
      sketch.status = { dof: 0, fullyConstrained: false, converged: true, conflicting: false, message: "Empty" };
      continue;
    }

    const result = await solver.solve(model);

    // write solved geometry back onto the entities
    for (const [pid, pos] of Object.entries(result.points)) {
      const e = sketch.entities[pid];
      if (e && e.kind === "point") {
        (e as SketchPoint).x = pos.x;
        (e as SketchPoint).y = pos.y;
      }
    }
    for (const [cid, r] of Object.entries(result.radii)) {
      const e = sketch.entities[cid];
      if (e && e.kind === "circle") (e as SketchCircle).r = r;
      else if (e && e.kind === "arc") (e as SketchArc).r = r;
    }

    // Driven (reference) dimensions: report the measured value from the solved
    // geometry rather than an expression.
    for (const c of Object.values(sketch.constraints)) {
      if ("expr" in c && (c as { driven?: boolean }).driven) {
        const m = measureDimension(sketch, c as DimensionConstraint);
        if (m != null) (c as { value: number }).value = m;
      }
    }

    const d = result.diagnosis;
    const message = d.hasConflict
      ? `Over-constrained — conflicting: ${d.conflicting.join(", ") || "unknown"}`
      : d.fullyConstrained
        ? "Fully constrained"
        : `${d.dof} degree${d.dof === 1 ? "" : "s"} of freedom`;

    evals[sketch.id] = {
      sketchId: sketch.id,
      diagnosis: d,
      status: result.status,
      warnings,
      message,
    };
    sketch.status = {
      dof: d.dof,
      fullyConstrained: d.fullyConstrained,
      converged: result.status === "ok",
      conflicting: d.hasConflict,
      message,
    };
  }

  return evals;
}

/** Move every expression-positioned point to its parameters' current value
 *  (they are fixed, so the solve builds the rest of the sketch around them). A
 *  coordinate that no longer evaluates keeps its last position. */
export function placeParametricPoints(sk: Sketch, scope: Scope): void {
  for (const e of Object.values(sk.entities)) {
    if (e.kind !== "point" || (e.xExpr === undefined && e.yExpr === undefined)) continue;
    for (const [axis, expr] of [["x", e.xExpr], ["y", e.yExpr]] as const) {
      if (expr === undefined) continue;
      try { const v = compileExpr(expr).eval(scope); if (Number.isFinite(v)) e[axis] = v; } catch { /* keep last */ }
    }
    e.fixed = true;
  }
}

/** Resolve datum planes, then set every sketch's world plane from its owning
 *  component's frame (static offset or joint-driven transform). Always rebuilt
 *  from the immutable base plane, so it is correct for ANY pose (including when a
 *  joint returns to 0 / identity) and never accumulates — which lets the motion
 *  study re-place sketches for each sampled pose, not just during a recompute. */
export function placeComponentSketches(doc: CadDocument, scope: Scope): void {
  resolveDatumPlanes(doc, scope);
  const componentWorld = resolveComponentWorld(doc, scope);
  for (const sk of Object.values(doc.sketches)) {
    if (sk.planeId === "custom") {
      // A pattern instance: the template's world plane, moved by the instance's
      // frame relative to the template's (as instanceSolids moves template bodies).
      if (sk.templatePlane) {
        const iW = (sk.componentId ? componentWorld.get(sk.componentId) : undefined) ?? IDENTITY;
        const tW = componentWorld.get(sk.templatePlane.componentId) ?? IDENTITY;
        sk.plane = transformPlane(compose(iW, invert(tW)), sk.templatePlane.plane);
      }
      continue; // otherwise face/offset planes carry their own world position
    }
    const base = sk.datumId ? doc.planes[sk.datumId]?.plane : planeById(sk.planeId);
    const W = sk.componentId ? componentWorld.get(sk.componentId) : undefined;
    if (W && !isIdentity(W)) sk.plane = base ? transformPlane(W, base) : sk.plane;
    else sk.plane = sk.datumId ? base : undefined; // origin-plane sketch → fall back to base
  }
}

const DEG = Math.PI / 180;

/** The world rigid transform a joint gives its `moved` component.
 *  Built in the BASE's local frame (seat the connectors, apply the joint motion
 *  about the base-local connector/axis) and then mapped out by `baseWorld`, so
 *  `moved` inherits the base's full pose — position AND orientation. Composing
 *  only a translation here would leave a child of a rotated base un-rotated, so
 *  its connector (the bearing) would drift off its mate. */
function jointWorld(baseWorld: Rigid, j: Joint, scope: Scope): Rigid {
  let value = j.valueValue;
  // a solved joint keeps the loop solve's value (its expression is only the first seed)
  if (!j.solve) {
    try { const v = compileExpr(j.valueExpr).eval(scope); if (Number.isFinite(v)) value = v; } catch { /* keep last */ }
  }
  j.valueValue = value;
  // Seat `moved` so its connector coincides with the base connector (base-local).
  const seat = translation({ x: j.baseOrigin.x - j.movedOrigin.x, y: j.baseOrigin.y - j.movedOrigin.y, z: j.baseOrigin.z - j.movedOrigin.z });
  let motion: Rigid;
  if (j.kind === "revolute" || j.kind === "flexure") {
    motion = rotationAbout(j.axis, value * DEG, j.baseOrigin); // about the base-local connector
  } else if (j.kind === "slider") {
    const m = Math.hypot(j.axis.x, j.axis.y, j.axis.z) || 1;
    motion = translation({ x: (j.axis.x / m) * value, y: (j.axis.y / m) * value, z: (j.axis.z / m) * value });
  } else if (j.kind === "planar") {
    const pv = (j.planarValue ??= { x: 0, y: 0, angle: 0 });
    for (const k of ["x", "y", "angle"] as const) {
      const e = j.planar?.[k];
      if (e !== undefined) try { const v = compileExpr(e).eval(scope); if (Number.isFinite(v)) pv[k] = v; } catch { /* keep last */ }
    }
    // turn about the connector, then shift
    motion = compose(translation({ x: pv.x, y: pv.y, z: 0 }), rotationAbout({ x: 0, y: 0, z: 1 }, pv.angle * DEG, j.baseOrigin));
  } else {
    motion = IDENTITY; // rigid
  }
  return compose(baseWorld, compose(motion, seat));
}

/** Solve a pin-slot joint: rotate `moved` about `axis` (through baseOrigin, in the
 *  base frame) by the angle that puts its `pin` point on the slot line, then map
 *  out by `baseWorld`. The pin travels a circle; the signed distance to the slot
 *  line (measured along the in-plane normal) is a + b·cosθ + c·sinθ, so we find
 *  its root nearest the last solution for a smooth, continuous motion. */
function jointWorldPinSlot(baseWorld: Rigid, slotBaseWorld: Rigid, j: Joint): Rigid {
  const seat = translation({ x: j.baseOrigin.x - j.movedOrigin.x, y: j.baseOrigin.y - j.movedOrigin.y, z: j.baseOrigin.z - j.movedOrigin.z });
  const movedW = (theta: number): Rigid => compose(baseWorld, compose(rotationAbout(j.axis, theta, j.baseOrigin), seat));
  if (!j.pin || !j.slotPoint || !j.slotDir) { j.error = "pin-slot missing constraint"; return movedW(j.valueValue * DEG); }

  const axisW = applyVec(baseWorld, j.axis);
  const Dw = applyVec(slotBaseWorld, j.slotDir);
  const P = applyPoint(slotBaseWorld, j.slotPoint);
  // n = axis × slotDir: perpendicular to both, so it lies in the plane the pin
  // sweeps and is perpendicular to the slot — the direction to drive to zero.
  let n = { x: axisW.y * Dw.z - axisW.z * Dw.y, y: axisW.z * Dw.x - axisW.x * Dw.z, z: axisW.x * Dw.y - axisW.y * Dw.x };
  const nl = Math.hypot(n.x, n.y, n.z);
  if (nl < 1e-9) { j.error = "pin-slot: axis parallel to slot"; return movedW(j.valueValue * DEG); }
  n = { x: n.x / nl, y: n.y / nl, z: n.z / nl };
  const res = (theta: number): number => { const p = applyPoint(movedW(theta), j.pin!); return (p.x - P.x) * n.x + (p.y - P.y) * n.y + (p.z - P.z) * n.z; };

  const seed = j.valueValue * DEG;
  const N = 240; const TWO_PI = Math.PI * 2;
  const wrap = (a: number) => { let d = a; while (d > Math.PI) d -= TWO_PI; while (d < -Math.PI) d += TWO_PI; return d; };
  let best: number | null = null, bestD = Infinity;
  let prevT = -Math.PI, prevF = res(-Math.PI);
  for (let i = 1; i <= N; i++) {
    const t = -Math.PI + (TWO_PI * i) / N, ft = res(t);
    if ((prevF < 0) !== (ft < 0)) {               // sign change → a root in (prevT, t]
      let lo = prevT, hi = t, flo = prevF;
      for (let k = 0; k < 44; k++) { const mid = (lo + hi) / 2, fm = res(mid); if ((flo < 0) !== (fm < 0)) hi = mid; else { lo = mid; flo = fm; } }
      const root = (lo + hi) / 2, d = Math.abs(wrap(root - seed));
      if (d < bestD) { bestD = d; best = root; }
    }
    prevT = t; prevF = ft;
  }
  if (best === null) { j.error = "pin-slot: pin cannot reach the slot"; return movedW(seed); }
  j.error = undefined;
  j.valueValue = best / DEG;
  return movedW(best);
}

/** Resolve every component's world frame — from its joint if it has one, else
 *  its static placement composed down the parent chain — then close any loops. */
/** Settles a document's free planar axes (minimum stored energy) and returns
 *  the settled placement; `place` re-places the parts for the axes as they
 *  stand. Supplied by the compliance layer (src/sim/flexure.ts), which owns the
 *  energy model; without it, free axes stay where they last were. */
export type EnergySettler = (doc: CadDocument, scope: Scope, place: () => Map<string, Rigid>) => Map<string, Rigid> | undefined;
let settler: EnergySettler | undefined;
export function setEnergySettler(fn: EnergySettler): void { settler = fn; }
/** Any planar joint with an axis left free to settle. */
export const hasFreeAxes = (doc: CadDocument): boolean =>
  Object.values(doc.joints).some((j) => j.kind === "planar" && (["x", "y", "angle"] as const).some((k) => j.planar?.[k] === undefined));

/** Place every component. With `settle` (the default), free planar axes are
 *  then settled at minimum stored energy; without it they stay as they are
 *  (what a settler itself, or a probe around a settled pose, wants). */
export function resolveComponentWorld(doc: CadDocument, scope: Scope, opts: { settle?: boolean } = {}): Map<string, Rigid> {
  const place = () => placeComponents(doc, scope);
  if (opts.settle !== false && settler && hasFreeAxes(doc)) return settler(doc, scope, place) ?? place();
  return place();
}

function placeComponents(doc: CadDocument, scope: Scope): Map<string, Rigid> {
  const jointByMoved = new Map<string, Joint>();
  const closures: Joint[] = [];
  for (const j of Object.values(doc.joints)) {
    j.error = undefined;
    // flexure dimensions given as expressions follow the parameters
    if (j.flexure?.exprs) for (const [k, e] of Object.entries(j.flexure.exprs) as ["length" | "width" | "thickness", string][]) {
      try { const v = compileExpr(e).eval(scope); if (Number.isFinite(v) && v > 0) j.flexure[k] = v; } catch { /* keep last */ }
    }
    if (j.beam?.exprs) for (const [k, e] of Object.entries(j.beam.exprs) as ["width" | "thickness", string][]) {
      try { const v = compileExpr(e).eval(scope); if (Number.isFinite(v) && v > 0) j.beam[k] = v; } catch { /* keep last */ }
    }
    j.beam?.viaExprs?.forEach((e, i) => {
      for (const k of ["x", "y"] as const) try { const v = compileExpr(e[k]).eval(scope); if (Number.isFinite(v)) j.beam!.via![i][k] = v; } catch { /* keep last */ }
    });
    // ...and so do connector points given as expressions
    for (const [side, key] of [["base", "baseOrigin"], ["moved", "movedOrigin"]] as const) {
      const ex = j.originExprs?.[side];
      if (ex) for (const [k, e] of Object.entries(ex) as ["x" | "y" | "z", string][]) {
        try { const v = compileExpr(e).eval(scope); if (Number.isFinite(v)) j[key][k] = v; } catch { /* keep last */ }
      }
    }
    if (!doc.components[j.base]) { j.error = `joint base "${j.base}" not found`; continue; }
    if (!doc.components[j.moved]) { j.error = `joint moved "${j.moved}" not found`; continue; }
    if (j.kind === "beam") continue; // an elastic element between placed parts, not a placement
    if (j.closes) closures.push(j); // a constraint, not a placement
    else jointByMoved.set(j.moved, j);
  }
  const tree = (): Map<string, Rigid> => {
    const world = new Map<string, Rigid>();
    const active = new Set<string>();
    const resolve = (id: string): Rigid => {
      const cached = world.get(id);
      if (cached) return cached;
      const c = doc.components[id];
      if (!c || active.has(id)) return IDENTITY; // missing or cycle
      active.add(id);
      const j = jointByMoved.get(id);
      let W: Rigid;
      if (j && j.kind === "pin-slot") W = jointWorldPinSlot(resolve(j.base), resolve(j.slotBase ?? j.base), j);
      else if (j) W = jointWorld(resolve(j.base), j, scope);
      else if (c.parentId) W = compose(resolve(c.parentId), translation(c.transform.position));
      else W = IDENTITY;
      active.delete(id);
      world.set(id, W);
      return W;
    };
    for (const id of Object.keys(doc.components)) resolve(id);
    return world;
  };
  return closures.length ? closeLoops(doc, closures, tree) : tree();
}

/** Where a closing joint's two connectors sit in the world, as one residual
 *  vector (base point − moved point, per closure). Zero when every loop closes. */
function loopResidual(closures: Joint[], W: Map<string, Rigid>): number[] {
  const out: number[] = [];
  for (const c of closures) {
    const p = applyPoint(W.get(c.base) ?? IDENTITY, c.baseOrigin), q = applyPoint(W.get(c.moved) ?? IDENTITY, c.movedOrigin);
    out.push(p.x - q.x, p.y - q.y, p.z - q.z);
  }
  return out;
}

/** Solve the `solve` joints so every closing joint's connectors meet — damped
 *  Gauss–Newton (Levenberg–Marquardt) on the coincidence residual with a
 *  finite-difference Jacobian, seeded from the last solution so a mechanism
 *  stays on the assembly branch it is on as its drive moves. Then record each
 *  closing joint's resulting relative rotation (its valueValue). */
function closeLoops(doc: CadDocument, closures: Joint[], tree: () => Map<string, Rigid>): Map<string, Rigid> {
  const unknowns = Object.values(doc.joints).filter((j) => j.solve && !j.closes && !j.error);
  const norm = (r: number[]) => Math.sqrt(r.reduce((a, v) => a + v * v, 0));
  let W = tree();
  let r = loopResidual(closures, W);
  let lambda = 1e-3;
  const h = 1e-5; // degrees (or mm for a slider)
  for (let it = 0; it < 100 && unknowns.length && norm(r) > 1e-10; it++) {
    const x0 = unknowns.map((j) => j.valueValue);
    const J = unknowns.map((j, k) => {
      j.valueValue = x0[k] + h;
      const rk = loopResidual(closures, tree());
      j.valueValue = x0[k];
      return rk.map((v, i) => (v - r[i]) / h);
    });
    // (JᵀJ + λ·diag(JᵀJ)) dx = −Jᵀr
    const n = unknowns.length;
    const A = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J[a].reduce((acc, v, i) => acc + v * J[b][i], 0)));
    const g = J.map((col) => -col.reduce((acc, v, i) => acc + v * r[i], 0));
    for (let a = 0; a < n; a++) A[a][a] *= 1 + lambda;
    const dx = solveSmall(A, g);
    if (!dx) break;
    unknowns.forEach((j, k) => { j.valueValue = x0[k] + dx[k]; });
    const W2 = tree(), r2 = loopResidual(closures, W2);
    if (norm(r2) < norm(r)) { W = W2; r = r2; lambda = Math.max(1e-9, lambda / 3); }
    else { unknowns.forEach((j, k) => { j.valueValue = x0[k]; }); lambda *= 4; if (lambda > 1e8) break; }
  }
  const closed = norm(r) <= 1e-6;
  for (const c of closures) {
    c.error = closed ? undefined : "loop does not close at this drive value";
    c.valueValue = relativeRotation(W.get(c.base) ?? IDENTITY, W.get(c.moved) ?? IDENTITY, c.axis);
  }
  return W;
}

/** Rotation (degrees) of `moved` relative to `base` about base-local `axis`. */
function relativeRotation(base: Rigid, moved: Rigid, axis: Vec3): number {
  const rel = compose(invert(base), moved);
  const m = Math.hypot(axis.x, axis.y, axis.z) || 1;
  const n = { x: axis.x / m, y: axis.y / m, z: axis.z / m };
  // any vector perpendicular to the axis, and where the relative rotation takes it
  const t = Math.abs(n.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const d = t.x * n.x + t.y * n.y + t.z * n.z;
  const e = { x: t.x - d * n.x, y: t.y - d * n.y, z: t.z - d * n.z };
  const f = applyVec(rel, e);
  const cr = { x: e.y * f.z - e.z * f.y, y: e.z * f.x - e.x * f.z, z: e.x * f.y - e.y * f.x };
  return (Math.atan2(cr.x * n.x + cr.y * n.y + cr.z * n.z, e.x * f.x + e.y * f.y + e.z * f.z) * 180) / Math.PI;
}

/** Solve a small dense system (Gaussian elimination, partial pivoting); null if singular. */
function solveSmall(A: number[][], b: number[]): number[] | null {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
    if (Math.abs(M[p][k]) < 1e-14) return null;
    [M[k], M[p]] = [M[p], M[k]];
    for (let i = k + 1; i < n; i++) { const f = M[i][k] / M[k][k]; for (let c = k; c <= n; c++) M[i][c] -= f * M[k][c]; }
  }
  const x = new Array(n).fill(0);
  for (let k = n - 1; k >= 0; k--) { let v = M[k][n]; for (let c = k + 1; c < n; c++) v -= M[k][c] * x[c]; x[k] = v / M[k][k]; }
  return x;
}

const isIdentity = (W: Rigid): boolean =>
  Math.abs(W.origin.x) < 1e-9 && Math.abs(W.origin.y) < 1e-9 && Math.abs(W.origin.z) < 1e-9 &&
  Math.abs(W.x.x - 1) < 1e-9 && Math.abs(W.y.y - 1) < 1e-9 && Math.abs(W.z.z - 1) < 1e-9 &&
  Math.abs(W.x.y) < 1e-9 && Math.abs(W.x.z) < 1e-9 && Math.abs(W.y.x) < 1e-9;

/** Map a work plane through a rigid transform (rotate the basis, move the origin). */
function transformPlane(W: Rigid, p: WorkPlane): WorkPlane {
  return { ...p, origin: applyPoint(W, p.origin), u: applyVec(W, p.u), v: applyVec(W, p.v), normal: applyVec(W, p.normal) };
}

/** Resolve each datum plane's frame from its base + offset expression. Chains
 *  (datum on datum) resolve over a few passes; a dangling base records an error. */
function resolveDatumPlanes(doc: CadDocument, scope: Scope) {
  const datums = Object.values(doc.planes);
  for (const dp of datums) { dp.plane = undefined; dp.error = undefined; }
  for (let pass = 0; pass <= datums.length; pass++) {
    let progress = false;
    for (const dp of datums) {
      if (dp.plane) continue;
      if (dp.kind === "frame" && dp.originExpr && dp.normal) {
        const ev = (e: string) => { try { const v = compileExpr(e).eval(scope); return Number.isFinite(v) ? v : NaN; } catch { return NaN; } };
        const o = { x: ev(dp.originExpr.x), y: ev(dp.originExpr.y), z: ev(dp.originExpr.z) };
        if (![o.x, o.y, o.z].every(Number.isFinite)) { dp.error = "plane origin does not evaluate"; continue; }
        dp.plane = { ...makePlaneFromNormal(o, dp.normal, dp.name), id: "datum" };
        progress = true;
        continue;
      }
      const base = ["XY", "XZ", "YZ"].includes(dp.base) ? planeById(dp.base) : doc.planes[dp.base]?.plane;
      if (!base) continue; // base is an unresolved datum — try next pass
      let off = dp.offsetValue;
      try { const v = compileExpr(dp.offsetExpr).eval(scope); if (Number.isFinite(v)) off = v; } catch { /* keep last */ }
      dp.offsetValue = off;
      dp.plane = { ...offsetPlane(base, off), id: "datum", name: dp.name };
      progress = true;
    }
    if (!progress) break;
  }
  for (const dp of datums) if (!dp.plane) dp.error ??= `Base plane "${dp.base}" not found`;
}

/** Measure a dimension's current geometric value from solved entities. */
function measureDimension(sk: Sketch, d: DimensionConstraint): number | null {
  const P = (id?: string) => (id ? (sk.entities[id] as SketchPoint) : undefined);
  const circle = d.circle ? (sk.entities[d.circle] as SketchCircle | SketchArc) : undefined;
  const dir = (lid?: string) => {
    const l = lid ? (sk.entities[lid] as SketchLine) : undefined;
    if (!l) return null;
    const a = P(l.p1)!, b = P(l.p2)!;
    return { x: b.x - a.x, y: b.y - a.y };
  };
  try {
    switch (d.type) {
      case "distance": { const a = P(d.a)!, b = P(d.b)!; return Math.hypot(a.x - b.x, a.y - b.y); }
      case "distanceX": return P(d.b)!.x - P(d.a)!.x;
      case "distanceY": return P(d.b)!.y - P(d.a)!.y;
      case "radius": return circle ? circle.r : null;
      case "diameter": return circle ? circle.r * 2 : null;
      case "angle": {
        const d1 = dir(d.l1), d2 = dir(d.l2);
        if (!d1 || !d2) return null;
        return Math.atan2(d1.x * d2.y - d1.y * d2.x, d1.x * d2.x + d1.y * d2.y);
      }
      case "pointLineDistance": {
        const p = P(d.point)!, l = sk.entities[d.line!] as SketchLine;
        const a = P(l.p1)!, b = P(l.p2)!;
        const dx = b.x - a.x, dy = b.y - a.y;
        const mag = Math.hypot(dx, dy) || 1;
        return Math.abs((dx * (p.y - a.y) - dy * (p.x - a.x)) / mag);
      }
    }
  } catch {
    return null;
  }
  return null;
}

function emptyEval(sketchId: string): SketchEvaluation {
  return {
    sketchId,
    diagnosis: {
      dof: 0,
      fullyConstrained: false,
      conflicting: [],
      redundant: [],
      partiallyRedundant: [],
      hasConflict: false,
      hasRedundancy: false,
    },
    status: "empty",
    warnings: [],
    message: "Empty",
  };
}
