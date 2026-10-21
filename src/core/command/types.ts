// Command framework types. Commands are the ONLY way to mutate a document.
// Each command is fully described by a JSON Schema plus prose, so the same
// definitions drive: (1) the UI, (2) undo/redo, and (3) an MCP tool surface an
// LLM/agent can call. Keeping one registry means the agent and the app always
// share the exact same vocabulary.

import { CadDocument } from "../document";

// A deliberately small JSON-Schema subset — enough to document and validate
// command params, and to emit as MCP tool input schemas, without a dependency.
export interface JSONSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: (string | number)[];
  minimum?: number;
  maximum?: number;
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
  /** Mutate the draft document. Must be deterministic given (doc, params). */
  apply(draft: CadDocument, params: P, ctx: CommandContext): CommandApplyInfo | void;
}

/** A recorded, replayable history entry. */
export interface CommandRecord {
  type: string;
  params: Record<string, unknown>;
  at: number;
  label: string;
}
