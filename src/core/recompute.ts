// Recompute: derive solved state from design intent. Resolves parameters, then
// for every sketch compiles → solves → writes solved coordinates back onto the
// entities and records a diagnosis (DoF, conflicts, redundancies). This is the
// "math solve" layer; it is independent of any renderer.

import { CadDocument } from "./document";
import { resolveParameters } from "../model/parameters";
import { ConstraintSolver, SolveDiagnosis } from "./solver/model";
import { compileSketch } from "./solver/compile";
import { compileExpr, Scope } from "../math/expr";
import { planeById, offsetPlane, WorkPlane } from "../geometry/plane";
import { Rigid, IDENTITY, translation, compose, applyPoint, applyVec, rotationAbout } from "../math/transform";
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

/** Resolve datum planes, then set every sketch's world plane from its owning
 *  component's frame (static offset or joint-driven transform). Always rebuilt
 *  from the immutable base plane, so it is correct for ANY pose (including when a
 *  joint returns to 0 / identity) and never accumulates — which lets the motion
 *  study re-place sketches for each sampled pose, not just during a recompute. */
export function placeComponentSketches(doc: CadDocument, scope: Scope): void {
  resolveDatumPlanes(doc, scope);
  const componentWorld = resolveComponentWorld(doc, scope);
  for (const sk of Object.values(doc.sketches)) {
    if (sk.planeId === "custom") continue; // face/offset planes carry their own world position
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
  try { const v = compileExpr(j.valueExpr).eval(scope); if (Number.isFinite(v)) value = v; } catch { /* keep last */ }
  j.valueValue = value;
  // Seat `moved` so its connector coincides with the base connector (base-local).
  const seat = translation({ x: j.baseOrigin.x - j.movedOrigin.x, y: j.baseOrigin.y - j.movedOrigin.y, z: j.baseOrigin.z - j.movedOrigin.z });
  let motion: Rigid;
  if (j.kind === "revolute") {
    motion = rotationAbout(j.axis, value * DEG, j.baseOrigin); // about the base-local connector
  } else if (j.kind === "slider") {
    const m = Math.hypot(j.axis.x, j.axis.y, j.axis.z) || 1;
    motion = translation({ x: (j.axis.x / m) * value, y: (j.axis.y / m) * value, z: (j.axis.z / m) * value });
  } else {
    motion = IDENTITY; // rigid
  }
  return compose(baseWorld, compose(motion, seat));
}

/** Resolve every component's world frame — from its joint if it has one, else
 *  its static placement composed down the parent chain. */
export function resolveComponentWorld(doc: CadDocument, scope: Scope): Map<string, Rigid> {
  const jointByMoved = new Map<string, Joint>();
  for (const j of Object.values(doc.joints)) {
    j.error = undefined;
    if (!doc.components[j.base]) { j.error = `joint base "${j.base}" not found`; continue; }
    if (!doc.components[j.moved]) { j.error = `joint moved "${j.moved}" not found`; continue; }
    jointByMoved.set(j.moved, j);
  }
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
    if (j) W = jointWorld(resolve(j.base), j, scope);
    else if (c.parentId) W = compose(resolve(c.parentId), translation(c.transform.position));
    else W = IDENTITY;
    active.delete(id);
    world.set(id, W);
    return W;
  };
  for (const id of Object.keys(doc.components)) resolve(id);
  return world;
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
  for (const dp of datums) if (!dp.plane) dp.error = `Base plane "${dp.base}" not found`;
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
