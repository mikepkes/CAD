// Data model for 2D sketches. Entities reference points by id; only point
// coordinates and circle/arc radii become solver variables.

export type EntityId = string;
export type ConstraintId = string;

export interface SketchPoint {
  id: EntityId;
  kind: "point";
  x: number;
  y: number;
  fixed?: boolean; // locked in the solver (e.g. the sketch origin)
  construction?: boolean;
  // true when the point exists only as another entity's defining point
  // (line end, circle center) and should not render as a standalone node.
  implicit?: boolean;
}

export interface SketchLine {
  id: EntityId;
  kind: "line";
  p1: EntityId;
  p2: EntityId;
  construction?: boolean;
}

export interface SketchCircle {
  id: EntityId;
  kind: "circle";
  center: EntityId;
  r: number;
  construction?: boolean;
}

export interface SketchArc {
  id: EntityId;
  kind: "arc";
  center: EntityId;
  p1: EntityId; // start
  p2: EntityId; // end
  r: number;
  ccw: boolean; // sweep direction start→end
  construction?: boolean;
}

export type SketchEntity = SketchPoint | SketchLine | SketchCircle | SketchArc;
export type CurveEntity = SketchLine | SketchCircle | SketchArc;

// ---- Constraints -----------------------------------------------------------

export type GeometricConstraint =
  | { id: ConstraintId; type: "coincident"; a: EntityId; b: EntityId }
  | { id: ConstraintId; type: "horizontal"; a: EntityId; b: EntityId }
  | { id: ConstraintId; type: "vertical"; a: EntityId; b: EntityId }
  | { id: ConstraintId; type: "parallel"; l1: EntityId; l2: EntityId }
  | { id: ConstraintId; type: "perpendicular"; l1: EntityId; l2: EntityId }
  | { id: ConstraintId; type: "equal"; e1: EntityId; e2: EntityId }
  | { id: ConstraintId; type: "pointOnLine"; point: EntityId; line: EntityId }
  | { id: ConstraintId; type: "midpoint"; point: EntityId; line: EntityId }
  | { id: ConstraintId; type: "pointOnCircle"; point: EntityId; circle: EntityId }
  | { id: ConstraintId; type: "concentric"; c1: EntityId; c2: EntityId }
  | { id: ConstraintId; type: "tangent"; a: EntityId; b: EntityId }
  | { id: ConstraintId; type: "symmetric"; a: EntityId; b: EntityId; line: EntityId }
  | { id: ConstraintId; type: "fix"; point: EntityId };

export type DimensionType =
  | "distance"
  | "distanceX"
  | "distanceY"
  | "pointLineDistance"
  | "radius"
  | "diameter"
  | "angle";

export interface DimensionConstraint {
  id: ConstraintId;
  type: DimensionType;
  // references depend on the dimension type
  a?: EntityId;
  b?: EntityId;
  point?: EntityId;
  line?: EntityId;
  circle?: EntityId;
  l1?: EntityId;
  l2?: EntityId;
  /** Value expression, e.g. "40" or "width * 2". Evaluated against params. */
  expr: string;
  /** Last evaluated numeric value (radians for angle). */
  value: number;
  /** Label placement offset in sketch (u,v) space, for rendering. */
  label?: { x: number; y: number };
}

export type Constraint = GeometricConstraint | DimensionConstraint;

/** Omit that distributes over unions (so discriminated members keep their keys). */
export type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
export type NewGeometricConstraint = DistributiveOmit<GeometricConstraint, "id">;

export const isDimension = (c: Constraint): c is DimensionConstraint =>
  (c as DimensionConstraint).expr !== undefined;

export interface Sketch {
  id: string;
  name: string;
  planeId: string; // which plane this sketch lives on
  originPointId: EntityId;
  entities: Record<EntityId, SketchEntity>;
  constraints: Record<ConstraintId, Constraint>;
  // solver status, refreshed after each solve
  status: {
    dof: number;
    fullyConstrained: boolean;
    converged: boolean;
    conflicting: boolean;
    message?: string;
  };
}
