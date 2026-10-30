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
  /** Optional increment: the value snaps to multiples of this (a slider then only
   *  lands on them). `step: 1` makes the parameter integer-only. */
  step?: number;
  /** Optional discrete set of acceptable values (an enum). Mutually exclusive
   *  with min/max. */
  values?: number[];
  /** A yes/no switch: values [0, 1], shown as a checkbox (1 = checked). */
  boolean?: boolean;
  /** Named choices (an enum): values [0 … n−1], shown as a dropdown of these
   *  names; the value is the chosen index (use it with pick()). */
  options?: string[];
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
  /** Named attachment frames (joint origins) in local coords, for relational joints. */
  connectors?: Record<string, Connector>;
  /** Material assigned to this component (bodies inherit; nearest ancestor wins). */
  materialId?: string;
  /** Instead of one material: the one a parameter picks, materials[value of `by`]
   *  (e.g. a named-choice "material" parameter). */
  materialChoice?: { by: string; materials: string[] };
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
  /** Target body (feature id) for a join/cut/intersect; default the most recent. */
  body?: string;
  /** If set, a join/cut/intersect that changes nothing is an error, not a warning. */
  requireEffect?: boolean;
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
  body?: string;
  requireEffect?: boolean;
}

/** A parametric primitive solid (box/cylinder/cone/sphere/torus) built directly,
 *  with no sketch — centred on `at`. One feature instead of sketch→extrude. */
export interface PrimitiveFeature {
  id: string;
  kind: "primitive";
  name: string;
  shape: "box" | "cylinder" | "cone" | "sphere" | "torus";
  /** Size expressions (parametric); which are used depends on `shape`. */
  dims: Partial<Record<"x" | "y" | "z" | "radius" | "radius2" | "height" | "tube", string>>;
  dimValues?: Partial<Record<string, number>>;
  /** World centre of the primitive. Default origin. */
  at?: { x: number; y: number; z: number };
  operation?: BooleanOp;
  body?: string;
  requireEffect?: boolean;
}

/** A body read from a neutral CAD file. The file's text is kept in the
 *  document, so a saved design is self-contained and replays anywhere. */
export interface ImportFeature {
  id: string;
  kind: "import";
  name: string;
  format: "step";
  /** The file contents (STEP is plain text). */
  data: string;
  /** World offset applied to the imported geometry. */
  at?: { x: number; y: number; z: number };
  operation?: BooleanOp;
  body?: string;
  requireEffect?: boolean;
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
  /** Edges by topological name ("faceA|faceB", from body_topology); a name
   *  without a "#k" suffix matches every edge between those two faces. */
  names?: string[];
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
  /** Target body (feature id) to modify; default the most recent. */
  body?: string;
  /** If set, a blend that matches no edges is an error, not a warning. */
  requireEffect?: boolean;
}

/** Hollow the most recent body to a wall thickness, opening the selected faces. */
export interface ShellFeature {
  id: string;
  kind: "shell";
  name: string;
  thicknessExpr: string;
  thicknessValue: number;
  openFaces: FaceSelector;
  body?: string;
  requireEffect?: boolean;
}

/** Repeat the most recent body along a vector or around an axis, fusing the copies in. */
export interface PatternFeature {
  id: string;
  kind: "pattern";
  name: string;
  mode: "linear" | "circular";
  /** Total instances including the original. */
  count: number;
  /** Optional expression driving `count` (e.g. a "stages" parameter). Evaluated,
   *  rounded and clamped to ≥1 at rebuild; `count` holds the last value. */
  countExpr?: string;
  /** linear: offset between instances (world). */
  step?: { x: number; y: number; z: number };
  /** Optional expressions driving each `step` component (parametric spacing). */
  stepExpr?: { x?: string; y?: string; z?: string };
  /** circular: axis origin + direction (world) and angle between instances (degrees). */
  axis?: { origin: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } };
  angle?: number;
  /** Optional expression driving `angle` (degrees between instances). */
  angleExpr?: string;
  /** Target body (feature id) to repeat; default the most recent. */
  body?: string;
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
  body?: string;
  requireEffect?: boolean;
}

/** A solid swept: a closed profile sketch dragged along an open path sketch (its spine). */
export interface SweepFeature {
  id: string;
  kind: "sweep";
  name: string;
  profileSketch: string; // closed profile (first region)
  pathSketch: string;    // open path (spine)
  operation?: BooleanOp;
  body?: string;
  requireEffect?: boolean;
}

/** A drilled hole (cut) at one or more points: simple, counterbored or
 *  countersunk, blind or through, with an optional thread. */
export interface HoleFeature {
  id: string;
  kind: "hole";
  name: string;
  /** Hole-mouth centres in world mm (one or many). */
  at: { x: number; y: number; z: number }[];
  /** Drilling direction (default straight down, −Z). */
  axis?: { x: number; y: number; z: number };
  diameterExpr: string;
  diameterValue?: number;
  /** Blind depth (to the start of the drill point). Omit with throughAll. */
  depthExpr?: string;
  depthValue?: number;
  throughAll?: boolean;
  /** Blind-hole bottom: flat (default) or a 118° drill point. */
  bottom?: "flat" | "drill";
  counterbore?: { diameterExpr: string; depthExpr: string };
  countersink?: { diameterExpr: string; angleExpr?: string }; // included angle (default 90°)
  /** Optional thread cut into the bore (see ThreadSpec). */
  thread?: ThreadSpec;
  body?: string;
  requireEffect?: boolean;
}

/** A thread: either cosmetic (a cheap helical hint) or fully modelled, with a
 *  standard or custom axial profile. Shared by feature.thread and threaded holes. */
export interface ThreadSpec {
  /** Profile family. "custom" uses `profilePoints` (axial, one pitch tall). */
  form: "metric" | "unified" | "acme" | "trapezoidal" | "square" | "buttress" | "ballscrew" | "custom";
  /** Thread pitch (mm) — axial distance per turn (per start). */
  pitch: number;
  /** Thread (major, external / nominal) diameter in mm. */
  diameter: number;
  /** Threaded length along the axis (mm). */
  length: number;
  /** Internal (a nut/bore) vs external (a screw/shaft). Default external. */
  internal?: boolean;
  /** Left-hand thread. Default right-hand. */
  leftHand?: boolean;
  /** Number of starts (multi-start). Default 1. */
  starts?: number;
  /** Depth of engagement override (mm); default derived from the form. */
  depth?: number;
  /** cosmetic = cheap coarse helix hint; modeled = full geometry. Default cosmetic. */
  representation?: "cosmetic" | "modeled";
  /** custom form: axial half-profile points (u = radial offset from the pitch line, v = axial 0..pitch). */
  profilePoints?: { x: number; y: number }[];
}

/** A thread at a point along an axis: external (added) or internal (cut as a tap). */
export interface ThreadFeature {
  id: string;
  kind: "thread";
  name: string;
  /** Base point of the thread (world mm) — the start of the threaded length. */
  at: { x: number; y: number; z: number };
  /** Thread axis direction (default +Z). */
  axis?: { x: number; y: number; z: number };
  spec: ThreadSpec;
  /** external only: combine with a body (new = standalone rod, join = add to a
   *  shaft). internal is always cut. Default new. */
  operation?: BooleanOp;
  body?: string;
  requireEffect?: boolean;
}

/** A cosmetic-thread appearance region on a body: a plain cylinder shaded as a
 *  thread by the renderer (a normal map), carrying the parameters that texture
 *  needs. Plain data — it crosses the geometry worker and never holds geometry. */
export interface ThreadDecal {
  at: { x: number; y: number; z: number };     // base of the threaded length
  axis: { x: number; y: number; z: number };   // thread axis
  radius: number;                               // major radius (external) / bore radius (internal)
  length: number;
  form: "metric" | "unified" | "acme" | "trapezoidal" | "square" | "buttress" | "ballscrew" | "custom";
  pitch: number;
  starts?: number;
  leftHand?: boolean;
  internal?: boolean;
  profilePoints?: { x: number; y: number }[];
}

/**
 * Pattern instances only (set by expandAssembly on a cloned sketch-less feature:
 * fillet, shell, hole…). Its world-space parameters (edge selectors, points,
 * axes) were authored on the template, so it is evaluated in the template's
 * frame: the target body is moved back by T⁻¹ (T = instanceWorld · templateWorld⁻¹),
 * modified, and moved out again.
 */
export interface InstanceFrame {
  component: string; // the instance's component
  template: string;  // the source (template) component it was cloned from
}

export type FeatureDef = (ExtrudeFeature | RevolveFeature | PrimitiveFeature | ImportFeature | HoleFeature | ThreadFeature | LoftFeature | SweepFeature | EdgeBlendFeature | ShellFeature | PatternFeature | MirrorFeature) & {
  instanceFrame?: InstanceFrame;
  /** Build this feature only while this expression is non-zero (a checkbox
   *  parameter switching an optional part on or off). */
  when?: string;
};
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
  /** offset: parallel to `base` at `offsetExpr`. frame: through `originExpr`
   *  (expressions in the parameters) with normal `normal`; its in-plane axes are
   *  chosen as for a face sketch (u horizontal when the normal is, v = +Z). */
  kind: "offset" | "frame";
  /** Base plane: "XY"/"XZ"/"YZ" or another datum plane id (offset only). */
  base: string;
  offsetExpr: string;
  offsetValue: number;
  originExpr?: { x: string; y: string; z: string };
  normal?: { x: number; y: number; z: number };
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
 *  - pin-slot: rotates about `axis`, but the angle is SOLVED so that a pin point
 *    on the moved body stays on a slot line on another body (a 1-DOF closed-loop
 *    constraint). This is how a real mechanism — e.g. a leg-vise criss-cross — is
 *    driven: the kernel finds the angle instead of the author supplying trig.
 */
export interface Joint {
  id: string;
  name: string;
  kind: "rigid" | "revolute" | "slider" | "pin-slot" | "flexure" | "beam" | "planar";
  base: string;  // base component id (root = ground)
  moved: string; // the component this joint places
  /** Connector point on each component, in that component's LOCAL coordinates. */
  baseOrigin: { x: number; y: number; z: number };
  movedOrigin: { x: number; y: number; z: number };
  /** Joint axis in the base component's local frame (revolute/slider/pin-slot). */
  axis: { x: number; y: number; z: number };
  /** Motion value expression (degrees for revolute, length for slider). For
   *  pin-slot it is only a seed/fallback; the solved angle is stored in valueValue. */
  valueExpr: string;
  valueValue: number;
  // ---- pin-slot only: the constraint that solves the angle ----
  /** The point on the MOVED body (moved-local) that must lie on the slot. */
  pin?: { x: number; y: number; z: number };
  /** Component whose local frame defines the slot line (default = base). */
  slotBase?: string;
  /** A point on the slot line, in slotBase-local coordinates. */
  slotPoint?: { x: number; y: number; z: number };
  /** The slot line's direction, in slotBase-local coordinates. */
  slotDir?: { x: number; y: number; z: number };
  // ---- closed loops ----
  /** The value is an unknown, solved so every `closes` joint's connectors meet
   *  (valueExpr is only the first seed; the last solution seeds the next solve). */
  solve?: boolean;
  /** Closes a loop instead of placing `moved` (which another joint places): its
   *  two connectors must coincide. Its valueValue reports the resulting relative
   *  rotation of moved vs base about `axis` (degrees, from the as-modelled pose). */
  closes?: boolean;
  /** flexure only: the compliant hinge's section. Moves like a revolute joint;
   *  modelled as a small-length flexural pivot (src/sim/flexure.ts). */
  flexure?: FlexureSection;
  /** beam only: a long compliant strip clamped from `baseOrigin` (on base) to
   *  `movedOrigin` (on moved). It places nothing — other joints place both
   *  parts — but stores energy as they move apart, solved as a large-deflection
   *  beam (src/sim/beam2d.ts). Both points are in the parts' as-modelled frames,
   *  which must coincide (parts drawn in place). */
  beam?: BeamSection;
  /** planar only: the moved part translates (x, y, mm) and turns (angle, °,
   *  about the connector) in the base's XY plane. An axis given an expression
   *  is driven by it; one left out is free, and settles where the stored
   *  elastic energy (beams, flexures) is least — the part floats on its
   *  compliant supports. */
  planar?: Partial<Record<"x" | "y" | "angle", string>>;
  /** planar only: where each axis is now (driven, or settled). */
  planarValue?: { x: number; y: number; angle: number };
  /** Connector points given as expressions in the parameters (per coordinate);
   *  baseOrigin / movedOrigin hold their last evaluation. */
  originExprs?: { base?: Partial<Record<"x" | "y" | "z", string>>; moved?: Partial<Record<"x" | "y" | "z", string>> };
  error?: string;
}

/** A thin flexure strip (mm): `length` along the strip, `thickness` in the
 *  bending direction, `width` across it (along the hinge axis). `material`
 *  defaults to the moved component's. */
export interface FlexureSection {
  length: number;
  width: number;
  thickness: number;
  material?: string;
  /** Dimensions given as expressions in the parameters (e.g. one per print
   *  material); the numbers above are their last evaluation. */
  exprs?: Partial<Record<"length" | "width" | "thickness", string>>;
}

/** A beam element's strip: `width` (out of plane), `thickness` (in the bending
 *  plane, XY). Its unstressed shape runs from the base point to the moved point:
 *  straight, or "cosine" — a smooth S leaving and arriving parallel to X (half
 *  of a clamped-clamped cosine beam, the curved-beam bistable's shape). */
export interface BeamSection {
  width: number;
  thickness: number;
  profile: "straight" | "cosine";
  /** Corners the strip runs through on its way, in the base's as-modelled frame
   *  (a frame's bar turning a corner, a folded spring): then it is straight
   *  from point to point, and `profile` is ignored. */
  via?: { x: number; y: number }[];
  viaExprs?: { x: string; y: string }[];
  material?: string;
  exprs?: Partial<Record<"width" | "thickness", string>>;
  /** The strip is there only while this expression is non-zero (an optional
   *  spring behind a checkbox or a count): switched off, it carries nothing. */
  when?: string;
}

/** A named attachment frame on a component, in that component's LOCAL coordinates.
 *  Relational joints bind to these by name instead of to raw coordinates, so a
 *  pattern's joints can say "instance i's `top` meets instance i-1's `bottom`". */
export interface Connector {
  origin: { x: number; y: number; z: number };
  /** Parametric origin: expressions in the parameters, evaluated where the
   *  connector is used (`origin` keeps the value at creation as a fallback). */
  originExpr?: { x: string; y: string; z: string };
  axis?: { x: number; y: number; z: number };
}

/** A reference, inside a joint template, to one endpoint of a to-be-generated
 *  joint. Resolved per instance at rebuild: `self` → the current instance, `prev`
 *  → the one before it, `root` → ground. `component` names which SOURCE component
 *  the clone descends from; `port` names a connector on it. */
export interface RoleRef {
  role: "self" | "prev" | "root";
  /** Source component whose per-instance clone this addresses (self/prev). */
  component?: string;
  /** Connector name on that component; when omitted, `origin` is used raw. */
  port?: string;
  /** Explicit local origin when there is no named port (e.g. a ground anchor). */
  origin?: { x: number; y: number; z: number };
}

/** A relational joint attached to a component pattern. The expander stamps one
 *  concrete `Joint` per applicable instance, resolving the role refs to real
 *  component ids and connector origins. `valueExpr` may reference the 0-based
 *  instance index `i` (and parameters), so per-instance motion laws are possible;
 *  a regular mechanism (like a scissor) uses the same expression every stage. */
export interface JointTemplate {
  id: string;
  name: string;
  patternId: string;
  kind: "rigid" | "revolute" | "slider";
  base: RoleRef;
  moved: RoleRef;
  axis: { x: number; y: number; z: number };
  valueExpr: string;
  /** Which instances get this joint: the first (i=0), the rest (i>=1), or all.
   *  Grounding/seed joints are "first"; the repeating chain joints are "rest". */
  appliesTo: "first" | "rest" | "all";
}

/** Duplicate a component subtree N times, where N is a parameter expression.
 *  Placement comes entirely from the pattern's joint templates (so the copies are
 *  jointed, not rigid) — the feature F360 lacks: a parametric instance count on a
 *  mechanism that still articulates. */
export interface ComponentPattern {
  id: string;
  name: string;
  /** Component id whose subtree (components + sketches + features) is instanced. */
  source: string;
  countExpr: string;
  count: number;
}

/** An appearance assigned to components/bodies. Wood is procedural (species +
 *  params); metal/plastic are PBR. Rendering turns this into a three.js material. */
export interface Material {
  id: string;
  name: string;
  kind: "wood" | "metal" | "plastic" | "painted";
  /** wood: species preset key (e.g. "white-oak", "walnut"). */
  species?: string;
  /** metal/plastic: finish preset (polished | brushed | satin | matte | gloss). */
  finish?: string;
  /** base/tint colour override (hex). */
  color?: string;
  roughness?: number;
  metalness?: number;
  /** wood grain overrides. */
  ringScale?: number;
  grainContrast?: number;
  poreStrength?: number;
  /** Mechanical properties, for flexures and other compliant analysis. */
  mechanical?: MechanicalProps;
}

export interface MechanicalProps {
  /** Young's modulus (MPa). */
  E: number;
  /** Peak strain a flexure may see in service (fraction, e.g. 0.08 = 8%). */
  allowableStrain: number;
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
  /** Parametric component patterns (jointed duplication) and their joint templates.
   *  These stay as design intent; the expander materializes instances at rebuild. */
  componentPatterns: Record<string, ComponentPattern>;
  jointTemplates: Record<string, JointTemplate>;
  /** Appearance library; components reference these by id. */
  materials: Record<string, Material>;
  sketches: Record<string, Sketch>;
  features: Record<string, FeatureDef>;
}

/** The material that applies to `componentId`: its own, else the nearest ancestor's
 *  (root may hold the document default). Undefined → the viewport's plain default.
 *  A material picked by a parameter reads it from `scope` when given (e.g. a
 *  study's overrides), else from the document's last evaluation. */
export function materialForComponent(doc: CadDocument, componentId: string | undefined, scope?: Record<string, number>): Material | undefined {
  let id = componentId;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const c = doc.components[id];
    if (!c) break;
    if (c.materialChoice) {
      const v = scope?.[c.materialChoice.by] ?? doc.parameters.find((p) => p.name === c.materialChoice!.by)?.value ?? 0;
      const m = doc.materials[c.materialChoice.materials[Math.round(v)]];
      if (m) return m;
    }
    if (c.materialId && doc.materials[c.materialId]) return doc.materials[c.materialId];
    id = c.parentId ?? undefined;
  }
  return undefined;
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
    componentPatterns: {},
    jointTemplates: {},
    materials: {},
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
