// Data model for 2D sketches. Entities reference points by id; only point
// coordinates and circle/arc radii become solver variables.

import type { WorkPlane } from "../geometry/plane";
import type { Vec3 } from "../math/vec";

/** A parametric handle to a planar body face, re-resolved against the live
 *  geometry each rebuild: by its topological `name` (see core/naming.ts) when
 *  pinned, else matched by normal and tie-broken by the original pick point. */
export interface FaceRef {
  normal: Vec3;
  point: Vec3;
  /** Topological face name, e.g. "extrude3:end" (pinned when the face was picked). */
  name?: string;
}

export type EntityId = string;
export type ConstraintId = string;

export interface SketchPoint {
  id: EntityId;
  kind: "point";
  x: number;
  y: number;
  fixed?: boolean; // locked in the solver (e.g. the sketch origin)
  /** Parametric position: expressions in the document's parameters, re-evaluated
   *  on every recompute (the point is fixed there). */
  xExpr?: string;
  yExpr?: string;
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

export interface SketchEllipse {
  id: EntityId;
  kind: "ellipse";
  center: EntityId;
  rx: number; // major (horizontal before rotation) radius
  ry: number; // minor radius
  rotation: number; // radians, CCW
  construction?: boolean;
}

/** An interpolating spline through ordered sketch points (C1 cubic; see core/geometry/spline.ts). */
export interface SketchSpline {
  id: EntityId;
  kind: "spline";
  /** Through-points in order (at least 2). The first/last are the curve's ends. */
  points: EntityId[];
  construction?: boolean;
}

export type SketchEntity = SketchPoint | SketchLine | SketchCircle | SketchArc | SketchEllipse | SketchSpline;
export type CurveEntity = SketchLine | SketchCircle | SketchArc | SketchEllipse | SketchSpline;

// ---- Constraints -----------------------------------------------------------

export type GeometricConstraint =
  | { id: ConstraintId; type: "coincident"; a: EntityId; b: EntityId }
  | { id: ConstraintId; type: "horizontal"; a: EntityId; b: EntityId }
  | { id: ConstraintId; type: "vertical"; a: EntityId; b: EntityId }
  | { id: ConstraintId; type: "parallel"; l1: EntityId; l2: EntityId }
  | { id: ConstraintId; type: "perpendicular"; l1: EntityId; l2: EntityId }
  | { id: ConstraintId; type: "collinear"; l1: EntityId; l2: EntityId }
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
  /** Driven (reference) dimension: measures geometry, does not constrain it. */
  driven?: boolean;
  /** Label placement offset in sketch (u,v) space, for rendering. */
  label?: { x: number; y: number };
}

export type Constraint = GeometricConstraint | DimensionConstraint;

/** Omit that distributes over unions (so discriminated members keep their keys). */
export type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
export type NewGeometricConstraint = DistributiveOmit<GeometricConstraint, "id">;

export const isDimension = (c: Constraint): c is DimensionConstraint =>
  (c as DimensionConstraint).expr !== undefined;

const DIM_WORDS: Record<DimensionType, string> = {
  distance: "Length", distanceX: "Horizontal distance", distanceY: "Vertical distance", pointLineDistance: "Distance",
  radius: "Radius", diameter: "Diameter", angle: "Angle",
};
const GEO_WORDS: Record<GeometricConstraint["type"], string> = {
  coincident: "Coincident", horizontal: "Horizontal", vertical: "Vertical", parallel: "Parallel", perpendicular: "Perpendicular",
  collinear: "Collinear", equal: "Equal", pointOnLine: "Point on line", midpoint: "Midpoint", pointOnCircle: "Point on circle",
  concentric: "Concentric", tangent: "Tangent", symmetric: "Symmetric", fix: "Fixed",
};
const round2 = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "?");

/** A constraint as a person would name it: "Length 80 mm", "Angle 30°", "Horizontal" (never its id). */
export function describeConstraint(c: Constraint | undefined): string {
  if (!c) return "a constraint";
  if (isDimension(c)) {
    const v = c.type === "angle" ? `${round2((c.value * 180) / Math.PI)}°` : `${round2(c.value)} mm`;
    const shown = /^[-+0-9.\s]+$/.test(c.expr) ? v : `${c.expr} (${v})`;
    return `${DIM_WORDS[c.type] ?? "Dimension"} ${shown}`;
  }
  return GEO_WORDS[c.type] ?? c.type;
}

/** "A", "A and B", "A, B and C". */
export function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export interface Sketch {
  id: string;
  name: string;
  planeId: string; // which plane this sketch lives on ("XY"/"XZ"/"YZ", "custom", or "datum")
  /** Full plane geometry when not one of the origin planes (face / offset / datum plane). */
  plane?: WorkPlane;
  /** Set when the sketch lives on a datum plane; recompute copies its resolved frame into `plane`. */
  datumId?: string;
  /** Owning component; recompute composes its world frame into `plane`. Defaults to root. */
  componentId?: string;
  /**
   * Parametric reference to the body face this sketch lives on. When set, the
   * geometry pass re-resolves the face's current plane each rebuild (so the
   * sketch tracks the face when upstream geometry changes) and writes it into
   * `plane`. `plane` (the baked frame from creation) is the fallback.
   */
  faceRef?: FaceRef;
  /**
   * Pattern instances only (set by expandAssembly): the template sketch's world
   * plane and owning component. A custom (offset/face) plane is stored in world
   * space, so an instance places it by the instance's frame relative to the
   * template's: instanceWorld · inverse(templateWorld).
   */
  templatePlane?: { plane: WorkPlane; componentId: string };
  /**
   * An offset or explicit plane, as drawn in its component (as modelled): the
   * component's placement carries it, as it does an origin-plane sketch's, so
   * a sketch lifted off a moving part's floor moves with the part.
   */
  localPlane?: WorkPlane;
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
