// Replay the operation recipe to (re)derive the document's geometry.
//
// This is what makes the timeline parametric: editing an earlier operation and
// calling rebuild re-runs every active operation in order, so changes propagate
// downstream. Stable ids are guaranteed by having each operation reuse the ids
// it allocated the first time (`op.createdIds`); only genuinely new allocations
// advance `doc.nextId`.

import { CadDocument, freshComponents, Configuration } from "./document";
import { CommandRegistry } from "./command/registry";
import { CommandApplyInfo, CommandContext, OperationRecord } from "./command/types";

/** An id allocator that replays an operation's recorded ids, then extends. */
function replayAllocator(op: OperationRecord, doc: CadDocument): CommandContext {
  let i = 0;
  return {
    alloc(prefix: string): string {
      if (i < op.createdIds.length) return op.createdIds[i++];
      const id = `${prefix}${doc.nextId++}`;
      op.createdIds.push(id);
      i++;
      return id;
    },
  };
}

export interface RebuildResult {
  /** CommandApplyInfo per operation id, for the caller (e.g. the just-added op). */
  infos: Record<string, CommandApplyInfo>;
  /** Operation ids that failed to replay. */
  errored: string[];
}

/**
 * Rebuild the derived state (parameters, components, sketch geometry) from the
 * active prefix of the operation recipe. Mutates `doc` in place. Does NOT solve
 * constraints — call `recompute` after this.
 */
export function rebuild(doc: CadDocument, registry: CommandRegistry): RebuildResult {
  // Reset derived state; operations repopulate it.
  doc.parameters = [];
  doc.components = freshComponents(doc.rootComponentId);
  doc.planes = {};
  doc.joints = {};
  doc.componentPatterns = {};
  doc.jointTemplates = {};
  doc.materials = {};
  doc.sketches = {};
  doc.features = {};
  doc.configurations = [];

  const infos: Record<string, CommandApplyInfo> = {};
  const errored: string[] = [];
  const active = Math.max(0, Math.min(doc.rollbackIndex, doc.operations.length));

  for (let k = 0; k < active; k++) {
    const op = doc.operations[k];
    if (op.suppressed) {
      op.error = undefined;
      continue;
    }
    const def = registry.get(op.type);
    if (!def) {
      op.error = `Unknown command "${op.type}"`;
      errored.push(op.opId);
      continue;
    }
    const ctx = replayAllocator(op, doc);
    try {
      infos[op.opId] = def.apply(doc, op.params, ctx) || {};
      op.error = undefined;
    } catch (err) {
      op.error = (err as Error).message;
      errored.push(op.opId);
    }
  }

  applyConfiguration(doc);
  return { infos, errored };
}

/**
 * Put the active configuration into effect on the freshly replayed model: its
 * cells replace parameter expressions (the timeline's own is kept as
 * `baseExpr`) and its suppressed features are switched off. Cells that name a
 * parameter or feature that no longer exists become warnings on the row. An
 * active id that no longer exists (the row was deleted) falls back to none.
 */
function applyConfiguration(doc: CadDocument) {
  for (const c of doc.configurations) {
    const warnings = [
      ...Object.keys(c.values).filter((n) => !doc.parameters.some((p) => p.name === n)).map((n) => `no parameter "${n}"`),
      ...(c.suppress ?? []).filter((id) => !doc.features[id]).map((id) => `no feature "${id}"`),
    ];
    c.warnings = warnings.length ? warnings : undefined;
  }
  const active: Configuration | undefined = doc.configurations.find((c) => c.id === doc.activeConfiguration);
  if (!active) { doc.activeConfiguration = undefined; return; }
  for (const p of doc.parameters) {
    const cell = active.values[p.name];
    if (cell === undefined) continue;
    p.baseExpr = p.expr;
    p.expr = cell;
    p.configuredBy = active.name;
  }
  for (const id of active.suppress ?? []) if (doc.features[id]) doc.features[id].configSuppressed = true;
}
