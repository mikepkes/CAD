// Recompute: derive solved state from design intent. Resolves parameters, then
// for every sketch compiles → solves → writes solved coordinates back onto the
// entities and records a diagnosis (DoF, conflicts, redundancies). This is the
// "math solve" layer; it is independent of any renderer.

import { CadDocument } from "./document";
import { resolveParameters } from "../model/parameters";
import { ConstraintSolver, SolveDiagnosis } from "./solver/model";
import { compileSketch } from "./solver/compile";
import { SketchArc, SketchCircle, SketchPoint } from "../sketch/types";

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
