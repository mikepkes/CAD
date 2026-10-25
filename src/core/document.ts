// The CAD document: the canonical, serializable design intent. It holds only
// *intent* (parameters, sketch topology, constraints) — solved coordinates are
// derived by `recompute` and written back onto the sketch entities. Everything
// here is plain JSON (float64), renderer-agnostic and transport-agnostic.

import { LinearUnit } from "./units";
import { Sketch } from "../sketch/types";
import { WorkPlane } from "../geometry/plane";
import { OperationRecord } from "./command/types";

export interface Parameter {
  id: string;
  name: string;
  /** Expression in the parameter language, e.g. "40", "width/2", "rad(30)". */
  expr: string;
  /** Last evaluated value (canonical units). */
  value: number;
  error?: string;
  /** Optional lower / upper extent. A UI slider and validation honour these.
   *  Mutually exclusive with `values`. */
  min?: number;
  max?: number;
  /** Optional discrete set of acceptable values (an enum). Mutually exclusive
   *  with min/max. */
  values?: number[];
  /** Set when the resolved value falls outside the extents / enum. */
  warning?: string;
}

/**
 * A component: a node in the assembly tree with its own placement frame. The
 * frame is the hook instances and joints will build on — for now a translation,
 * extensible to full rigid placement (rotation) without a data-model change.
 */
export interface ComponentTransform {
  position: { x: number; y: number; z: number };
}

export interface Component {
  id: string;
  name: string;
  parentId: string | null;
  children: string[];
  sketches: string[];
  /** Placement relative to the parent component (identity for root). */
  transform: ComponentTransform;
}

/** How a feature combines with the running bodies (Fusion-style). */
export type BooleanOp = "new" | "join" | "cut" | "intersect";

/** A solid feature built by extruding sketch regions. Geometry is derived by the OCC kernel. */
export interface ExtrudeFeature {
  id: string;
  kind: "extrude";
  name: string;
  sketchId: string;
  /** Distance expression (parametric), e.g. "10" or "height*2". */
  distanceExpr: string;
  distanceValue: number;
  symmetric?: boolean;
  /** Extrude against the sketch normal (equivalent to a negative distance). */
  direction?: "normal" | "reverse";
  /** "blind" (default): `distance`. "throughAll": far past every existing body in the chosen direction(s) — for cuts/joins that must go all the way through. */
  extent?: "blind" | "throughAll";
  /** How this solid combines with existing bodies (Fusion-style). Default "new". */
  operation?: BooleanOp;
  /** Interior point (sketch u,v) selecting one region; omitted = every region. */
  regionPoint?: { x: number; y: number };
}

/** A solid feature built by revolving sketch regions about an axis in the sketch plane. */
export interface RevolveFeature {
  id: string;
  kind: "revolve";
  name: string;
  sketchId: string;
  /** Axis in sketch (u,v) coordinates: through p1 and p2. */
  axis: { p1: { x: number; y: number }; p2: { x: number; y: number } };
  /** Sweep angle expression in degrees (360 = full). */
  angleExpr: string;
  angleValue: number;
  operation?: BooleanOp;
  regionPoint?: { x: number; y: number };
}

/**
 * Selects B-rep edges of a body for fillet/chamfer. Every set field narrows the
 * selection (AND); an empty selector means every edge.
 */
export interface EdgeSelector {
  /** Edges whose direction is parallel to a world axis. */
  parallelTo?: "X" | "Y" | "Z";
  /** Edges lying in an origin plane offset along its normal (e.g. the top face's outline: {plane:"XY", offset: height}). */
  inPlane?: { plane: "XY" | "XZ" | "YZ"; offset?: number };
  /** Only straight / only circular edges. */
  curveType?: "line" | "circle";
  minLength?: number;
  maxLength?: number;
  /** Edges that pass through (within tolerance of) a world point. */
  nearPoint?: { x: number; y: number; z: number };
  /** Edges entirely inside an axis-aligned world box. */
  inBox?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
}

/** Selects B-rep faces of a body (shell openings). Empty = no faces. */
export interface FaceSelector {
  /** Faces parallel to an origin plane (planar faces only). */
  parallelTo?: "XY" | "XZ" | "YZ";
  /** Faces lying in an origin plane offset along its normal. */
  inPlane?: { plane: "XY" | "XZ" | "YZ"; offset?: number };
  /** The face containing (within tolerance of) a world point. */
  nearPoint?: { x: number; y: number; z: number };
}

/** Round or bevel selected edges of the most recent body. */
export interface EdgeBlendFeature {
  id: string;
  kind: "fillet" | "chamfer";
  name: string;
  /** Radius (fillet) / setback (chamfer) expression. */
  sizeExpr: string;
  sizeValue: number;
  edges: EdgeSelector;
}

/** Hollow the most recent body to a wall thickness, opening the selected faces. */
export interface ShellFeature {
  id: string;
  kind: "shell";
  name: string;
  thicknessExpr: string;
  thicknessValue: number;
  openFaces: FaceSelector;
}

/** Repeat the most recent body along a vector or around an axis, fusing the copies in. */
export interface PatternFeature {
  id: string;
  kind: "pattern";
  name: string;
  mode: "linear" | "circular";
  /** Total instances including the original. */
  count: number;
  /** linear: offset between instances (world). */
  step?: { x: number; y: number; z: number };
  /** circular: axis origin + direction (world) and angle between instances (degrees). */
  axis?: { origin: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } };
  angle?: number;
}
/**
 * Mirror feature: reflects the running bodies across a plane and fuses each
 * reflection into its source body. The first solid transform — the primitive
 * that patterns and (later) component placement build on.
 */
export interface MirrorFeature {
  id: string;
  kind: "mirror";
  name: string;
  /** Plane to mirror across: "XY"/"XZ"/"YZ" or a datum plane id. */
  plane: string;
  /** Which bodies to reflect: every body (default) or only the most recent one. */
  bodies?: "all" | "last";
}
/** A solid lofted through an ordered list of profile sketches (one region each). */
export interface LoftFeature {
  id: string;
  kind: "loft";
  name: string;
  /** Ordered profile sketches; the first closed region of each is used. */
  sketchIds: string[];
  /** Straight (ruled) sections between profiles vs. a smooth blend. */
  ruled?: boolean;
  /** How the loft combines with existing bodies. Default "new". */
  operation?: BooleanOp;
}

/** A solid swept: a closed profile sketch dragged along an open path sketch (its spine). */
export interface SweepFeature {
  id: string;
  kind: "sweep";
  name: string;
  profileSketch: string; // closed profile (first region)
  pathSketch: string;    // open path (spine)
  operation?: BooleanOp;
}

export type FeatureDef = ExtrudeFeature | RevolveFeature | LoftFeature | SweepFeature | EdgeBlendFeature | ShellFeature | PatternFeature | MirrorFeature;
/** Features that own a single sketch (the profile-driven ones). */
export type SketchFeature = ExtrudeFeature | RevolveFeature;

/**
 * A datum/reference plane — a reusable, parametric coordinate frame (the first
 * step toward full reference geometry: axes, points, angled/through planes).
 * Currently an offset from a base plane (an origin plane id, or another datum).
 * `plane` is the resolved frame, written by recompute.
 */
export interface DatumPlane {
  id: string;
  name: string;
  kind: "offset";
  /** Base plane: "XY"/"XZ"/"YZ" or another datum plane id. */
  base: string;
  offsetExpr: string;
  offsetValue: number;
  /** Resolved world frame (set during recompute). */
  plane?: WorkPlane;
  /** Set if the datum could not be resolved (e.g. dangling base). */
  error?: string;
}

/** A named, collapsible grouping of timeline operations (organization only). */
export interface TimelineGroup {
  id: string;
  name: string;
  opIds: string[];
  collapsed: boolean;
}

/**
 * An assembly joint: positions the `moved` component relative to `base` by
 * aligning a connector point on each (in local coordinates), then applying the
 * joint's motion. Resolved to the moved component's world frame by recompute.
 *  - rigid: fully fixed (connectors coincide, no residual motion)
 *  - revolute: free rotation about `axis` by `value` degrees
 *  - slider: free translation along `axis` by `value`
 */
export interface Joint {
  id: string;
  name: string;
  kind: "rigid" | "revolute" | "slider";
  base: string;  // base component id (root = ground)
  moved: string; // the component this joint places
  /** Connector point on each component, in that component's LOCAL coordinates. */
  baseOrigin: { x: number; y: number; z: number };
  movedOrigin: { x: number; y: number; z: number };
  /** Joint axis in the base component's local frame (revolute/slider). */
  axis: { x: number; y: number; z: number };
  /** Motion value expression (degrees for revolute, length for slider). */
  valueExpr: string;
  valueValue: number;
  error?: string;
}

export interface CadDocument {
  schema: 1;
  id: string;
  units: LinearUnit;
  /** Monotonic id counter — never decreases, so ids are globally unique. */
  nextId: number;

  // ---- canonical design intent (the recipe) ----
  /** The parametric timeline: replaying operations[0..rollbackIndex) builds the model. */
  operations: OperationRecord[];
  /** Operations at index >= rollbackIndex are rolled back (inactive). */
  rollbackIndex: number;
  /** Named, collapsible groupings over the operations (UI organization). */
  timelineGroups: TimelineGroup[];

  // ---- derived state (a cache, always reproducible from `operations`) ----
  parameters: Parameter[];
  rootComponentId: string;
  components: Record<string, Component>;
  planes: Record<string, DatumPlane>;
  joints: Record<string, Joint>;
  sketches: Record<string, Sketch>;
  features: Record<string, FeatureDef>;
}

/** A fresh, empty root component map (used when rebuilding derived state). */
export function freshComponents(rootId: string): Record<string, Component> {
  return {
    [rootId]: { id: rootId, name: "Root Component", parentId: null, children: [], sketches: [], transform: identityTransform() },
  };
}

export function identityTransform(): ComponentTransform {
  return { position: { x: 0, y: 0, z: 0 } };
}

export function createDocument(id = "doc1"): CadDocument {
  const rootId = "cmp-root";
  return {
    schema: 1,
    id,
    units: "mm",
    nextId: 1,
    operations: [],
    rollbackIndex: 0,
    timelineGroups: [],
    parameters: [],
    rootComponentId: rootId,
    components: freshComponents(rootId),
    planes: {},
    joints: {},
    sketches: {},
    features: {},
  };
}

/** Allocate a stable id by advancing the document counter (mutates draft). */
export function allocId(draft: CadDocument, prefix: string): string {
  const n = draft.nextId++;
  return `${prefix}${n}`;
}

export function getParameterByName(doc: CadDocument, name: string): Parameter | undefined {
  return doc.parameters.find((p) => p.name === name);
}
