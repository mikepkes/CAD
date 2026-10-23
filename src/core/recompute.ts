// Recompute: derive solved state from design intent. Resolves parameters, then
// for every sketch compiles → solves → writes solved coordinates back onto the
// entities and records a diagnosis (DoF, conflicts, redundancies). This is the
// "math solve" layer; it is independent of any renderer.

import { CadDocument } from "./document";
import { resolveParameters } from "../model/parameters";
import { ConstraintSolver, SolveDiagnosis } from "./solver/model";
import { compileSketch } from "./solver/compile";
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
