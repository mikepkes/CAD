// Command framework types. Commands are the ONLY way to mutate a document.
// Each command is fully described by a JSON Schema plus prose, so the same
// definitions drive: (1) the UI, (2) undo/redo, and (3) an MCP tool surface an
// LLM/agent can call. Keeping one registry means the agent and the app always
// share the exact same vocabulary.

import { CadDocument } from "../document";

// A deliberately small JSON-Schema subset — enough to document and validate
// command params, and to emit as MCP tool input schemas, without a dependency.
export type JSONSchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean";

export interface JSONSchema {
  type?: JSONSchemaType | JSONSchemaType[];
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: (string | number)[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  default?: unknown;
  /** Allow one of several shapes (e.g. a point given as coords OR a ref). */
  oneOf?: JSONSchema[];
  additionalProperties?: boolean;
}

export interface CommandContext {
  /** Allocate a stable, document-local id (advances the doc counter). */
  alloc(prefix: string): string;
}

/** Returned by a command's apply, surfaced in the dispatch result. */
export interface CommandApplyInfo {
  /** Ids of entities/objects the command created. */
  createdIds?: string[];
  /** Primary sketch the command touched, for targeted diagnosis. */
  affectedSketchId?: string;
  /** A short human/LLM-readable note about what happened. */
  message?: string;
}

export interface CommandDef<P = Record<string, unknown>> {
  /** Stable, namespaced id, e.g. "sketch.addLine". */
  type: string;
  /** Short title for menus. */
  title: string;
  /** One-line summary (shown to humans and agents). */
  summary: string;
  /** Longer description of behavior, invariants, and effects. */
  description: string;
  /** JSON Schema for `params` — validated on dispatch, exported to MCP. */
  paramsSchema: JSONSchema;
  /** Worked examples, invaluable for LLM tool use. */
  examples?: { note?: string; params: P }[];
  /** Whether this command adds constraints (enables the over-constraint guard). */
  constrains?: boolean;
  /** Removes or overwrites existing model content (undoable, but flagged to MCP clients as destructive). */
  destructive?: boolean;
  /** Mutate the draft document. Must be deterministic given (doc, params). */
  apply(draft: CadDocument, params: P, ctx: CommandContext): CommandApplyInfo | void;
}

/**
 * A node in the parametric timeline (the "recipe"). The document IS an ordered
 * list of these; the current geometry is derived by replaying them. Each
 * operation permanently owns the ids it created (`createdIds`), so editing an
 * earlier operation and replaying keeps later operations' references valid —
 * this is what makes "edit an early sketch, propagate downstream" work.
 */
export interface OperationRecord {
  /** Stable id of this timeline node. */
  opId: string;
  /** Command type to replay. */
  type: string;
  params: Record<string, unknown>;
  /** Ids this operation allocated, in order — reused verbatim on every replay. */
  createdIds: string[];
  /** Suppressed operations are skipped during replay (like Fusion's suppress). */
  suppressed?: boolean;
  /** Set if the operation failed to replay (e.g. a dangling reference). */
  error?: string;
  /** Short label for the timeline UI. */
  label: string;
  at: number;
}
