// The CAD document: the canonical, serializable design intent. It holds only
// *intent* (parameters, sketch topology, constraints) — solved coordinates are
// derived by `recompute` and written back onto the sketch entities. Everything
// here is plain JSON (float64), renderer-agnostic and transport-agnostic.

import { LinearUnit } from "./units";
import { Sketch } from "../sketch/types";
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

  // ---- derived state (a cache, always reproducible from `operations`) ----
  parameters: Parameter[];
  rootComponentId: string;
  components: Record<string, Component>;
  sketches: Record<string, Sketch>;
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
    parameters: [],
    rootComponentId: rootId,
    components: freshComponents(rootId),
    sketches: {},
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
