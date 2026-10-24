// Neutral constraint-solver interface.
//
// The rest of the system never talks to PlaneGCS (or any solver) directly — it
// compiles a sketch into this solver-agnostic `SolverModel`, and reads back a
// `SolveResult`. Swapping solvers (PlaneGCS ↔ a native fallback ↔ something
// future) means implementing this one interface. Dimension values are already
// evaluated to numbers here, so the solver layer is free of the parameter/
// expression system.

export interface SolverPoint {
  id: string;
  x: number;
  y: number;
  /** Locked — the solver must not move it. */
  fixed: boolean;
}
export interface SolverLine {
  id: string;
  p1: string;
  p2: string;
}
export interface SolverCircle {
  id: string;
  center: string;
  r: number;
}
export interface SolverArc {
  id: string;
  center: string;
  start: string;
  end: string;
  r: number;
}

/**
 * Geometric constraints carry no value; dimensional constraints carry a
 * pre-evaluated numeric `value`. Every constraint has a stable `id` so the
 * solver can report conflicts/redundancies back by id.
 */
export type SolverConstraint =
  | { id: string; kind: "coincident"; a: string; b: string }
  | { id: string; kind: "horizontal"; a: string; b: string }
  | { id: string; kind: "vertical"; a: string; b: string }
  | { id: string; kind: "parallel"; l1: string; l2: string }
  | { id: string; kind: "perpendicular"; l1: string; l2: string }
  | { id: string; kind: "equalLength"; l1: string; l2: string }
  | { id: string; kind: "equalRadius"; c1: string; c2: string }
  | { id: string; kind: "pointOnLine"; point: string; line: string }
  | { id: string; kind: "pointOnCircle"; point: string; circle: string }
  | { id: string; kind: "midpoint"; a: string; b: string; point: string }
  | { id: string; kind: "symmetric"; a: string; b: string; line: string }
  | { id: string; kind: "distance"; a: string; b: string; value: number }
  | { id: string; kind: "distanceX"; a: string; b: string; value: number }
  | { id: string; kind: "distanceY"; a: string; b: string; value: number }
  | { id: string; kind: "pointLineDistance"; point: string; line: string; value: number }
  | { id: string; kind: "radius"; circle: string; value: number }
  | { id: string; kind: "diameter"; circle: string; value: number }
  | { id: string; kind: "angle"; l1: string; l2: string; value: number };

export interface SolverModel {
  points: SolverPoint[];
  lines: SolverLine[];
  circles: SolverCircle[];
  arcs: SolverArc[];
  constraints: SolverConstraint[];
  /**
   * Transient drag target: pull `pointId` toward (x,y) with a temporary anchor
   * so the dragged point tracks the cursor as closely as its own constraints
   * allow (slides along a circle/line it's on), instead of the solver spending
   * the drag on other free DOF. Not persisted — set only for live drag solves.
   */
  dragAnchor?: { pointId: string; x: number; y: number };
}

export type SolveStatusCode = "ok" | "failed" | "invalid" | "empty";

export interface SolveDiagnosis {
  /** 0 = fully constrained. */
  dof: number;
  fullyConstrained: boolean;
  /** Constraint ids that mutually conflict (no solution satisfies them all). */
  conflicting: string[];
  /** Constraint ids that are redundant (already implied). */
  redundant: string[];
  /** Constraint ids that are redundant only in part. */
  partiallyRedundant: string[];
  hasConflict: boolean;
  hasRedundancy: boolean;
}

export interface SolveResult {
  status: SolveStatusCode;
  /** Solved coordinates, by point id. */
  points: Record<string, { x: number; y: number }>;
  /** Solved radii, by circle/arc id. */
  radii: Record<string, number>;
  diagnosis: SolveDiagnosis;
  /** Max residual after solving (mm), when the solver reports it. */
  maxResidual?: number;
}

export const EMPTY_DIAGNOSIS: SolveDiagnosis = {
  dof: 0,
  fullyConstrained: false,
  conflicting: [],
  redundant: [],
  partiallyRedundant: [],
  hasConflict: false,
  hasRedundancy: false,
};

export interface ConstraintSolver {
  /** Resolve once the solver is ready to use (e.g. WASM loaded). */
  ready(): Promise<void>;
  /** Solve a model. May be async (worker/WASM) or sync (native). */
  solve(model: SolverModel): Promise<SolveResult>;
  /** Human-readable solver name, for diagnostics. */
  readonly name: string;
  /** Release native resources. */
  dispose(): void;
}
