// Replay the operation recipe to (re)derive the document's geometry.
//
// This is what makes the timeline parametric: editing an earlier operation and
// calling rebuild re-runs every active operation in order, so changes propagate
// downstream. Stable ids are guaranteed by having each operation reuse the ids
// it allocated the first time (`op.createdIds`); only genuinely new allocations
// advance `doc.nextId`.

import { CadDocument, freshComponents } from "./document";
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
  doc.sketches = {};
  doc.features = {};

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

  return { infos, errored };
}
