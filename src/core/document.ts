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
}

export interface Component {
  id: string;
  name: string;
  parentId: string | null;
  children: string[];
  sketches: string[];
}

/** A solid feature (currently extrude). Geometry is derived by the OCC kernel. */
export interface ExtrudeFeature {
  id: string;
  kind: "extrude";
  name: string;
  sketchId: string;
  /** Distance expression (parametric), e.g. "10" or "height*2". */
  distanceExpr: string;
  distanceValue: number;
  symmetric?: boolean;
  /** How this solid combines with existing bodies (Fusion-style). Default "new". */
  operation?: "new" | "join" | "cut";
  /** Interior point (sketch u,v) selecting one region; omitted = every region. */
  regionPoint?: { x: number; y: number };
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
}
export type FeatureDef = ExtrudeFeature | MirrorFeature;

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
  sketches: Record<string, Sketch>;
  features: Record<string, FeatureDef>;
}

/** A fresh, empty root component map (used when rebuilding derived state). */
export function freshComponents(rootId: string): Record<string, Component> {
  return {
    [rootId]: { id: rootId, name: "Root Component", parentId: null, children: [], sketches: [] },
  };
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
