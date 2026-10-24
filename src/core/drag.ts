// Transient drag solve. Used for live preview while dragging a point: compile
// the sketch, re-seed the dragged point to the cursor, and solve — WITHOUT
// committing anything. The result is overlaid in the viewport; on release the
// caller commits a single `sketch.moveGeometry` command with the final seeds.

import { Scope } from "../math/expr";
import { Sketch } from "../sketch/types";
import { compileSketch } from "./solver/compile";
import { ConstraintSolver } from "./solver/model";

export interface DragSolveResult {
  points: Record<string, { x: number; y: number }>;
  fullyConstrained: boolean;
  conflicting: string[];
}

export async function solveDrag(
  sketch: Sketch,
  scope: Scope,
  solver: ConstraintSolver,
  dragPointId: string,
  x: number,
  y: number,
  /**
   * Previous-frame solved positions. Seeding the solver from these (rather than
   * the committed positions) gives the free DOF temporal coherence, so an
   * under-constrained sketch slides smoothly instead of popping between the
   * solver's solution branches each frame.
   */
  seed?: Record<string, { x: number; y: number }>
): Promise<DragSolveResult> {
  const { model } = compileSketch(sketch, scope);
  if (seed) {
    for (const pt of model.points) {
      if (pt.fixed) continue;
      const s = seed[pt.id];
      if (s) { pt.x = s.x; pt.y = s.y; }
    }
  }
  const p = model.points.find((pt) => pt.id === dragPointId);
  if (p && !p.fixed) {
    p.x = x;
    p.y = y;
    // Anchor the dragged point to the cursor so it tracks it as closely as its
    // own constraints allow (sliding on a circle/line), instead of the solver
    // spending the motion on other free DOF.
    model.dragAnchor = { pointId: dragPointId, x, y };
  }
  const res = await solver.solve(model);
  return {
    points: res.points,
    fullyConstrained: res.diagnosis.fullyConstrained,
    conflicting: res.diagnosis.conflicting,
  };
}
