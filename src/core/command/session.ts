// CadSession owns the document and mediates every change.
//
// Two distinct concepts, deliberately kept separate:
//
//  • The TIMELINE (doc.operations) is the parametric recipe. It can be edited
//    anywhere — append, edit an earlier op's params, suppress, delete, or move
//    the rollback bar — and `rebuild` replays it so changes propagate
//    downstream. This is Fusion's feature tree.
//
//  • UNDO/REDO is a separate stack of whole-document snapshots taken around
//    each edit. Editing an early operation is itself one undoable transaction:
//    undo restores the prior document (old op params AND the downstream result).
//
// After every transition we recompute (solve) and run the incremental
// over-constraint guard, which can reject a change and name the clashing
// constraints.

import { CadDocument, findConfiguration } from "../document";
import { isHideable } from "../visibility";
import { ConstraintSolver } from "../solver/model";
import { Evaluations, recompute } from "../recompute";
import { rebuild } from "../build";
import { CommandRegistry } from "./registry";
import { CommandApplyInfo, OperationRecord } from "./types";
import { validate } from "./validate";

export interface DispatchOptions {
  rejectOnConflict?: boolean;
}

export interface DispatchResult {
  ok: boolean;
  opId?: string;
  createdIds: string[];
  evaluations: Evaluations;
  error?: string;
  conflicting?: string[];
  message?: string;
}

interface Snapshot {
  label: string;
  docBefore: CadDocument;
  evalsBefore: Evaluations;
  docAfter: CadDocument;
  evalsAfter: Evaluations;
}

const clone = <T>(v: T): T => structuredClone(v);

/** A restorable session state (documents are immutable snapshots, so this is cheap). */
export interface SessionCheckpoint {
  doc: CadDocument;
  evaluations: Evaluations;
  undo: Snapshot[];
  redo: Snapshot[];
}

export class CadSession {
  doc: CadDocument;
  evaluations: Evaluations = {};
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];

  constructor(
    initialDoc: CadDocument,
    private registry: CommandRegistry,
    private solver: ConstraintSolver
  ) {
    this.doc = initialDoc;
  }

  // ---- timeline (the recipe) ----
  get timeline(): OperationRecord[] {
    return this.doc.operations;
  }
  get rollbackIndex(): number {
    return this.doc.rollbackIndex;
  }
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  async recompute(): Promise<Evaluations> {
    rebuild(this.doc, this.registry);
    this.evaluations = await recompute(this.doc, this.solver);
    return this.evaluations;
  }

  /** Append a new operation to the timeline (at the rollback bar) and run it. */
  async dispatch(
    type: string,
    params: Record<string, unknown>,
    opts: DispatchOptions = {}
  ): Promise<DispatchResult> {
    const def = this.registry.get(type);
    if (!def) return this.fail(`Unknown command "${type}"`);
    const errors = validate(def.paramsSchema, params);
    if (errors.length) return this.fail(`Invalid params for "${type}": ${errors.join("; ")}`);

    const before = this.doc;
    const evalsBefore = this.evaluations;
    const draft = clone(before);

    const opId = `op${draft.nextId++}`;
    const op: OperationRecord = {
      opId,
      type,
      params,
      createdIds: [],
      label: def.title,
      at: Date.now(),
    };
    draft.operations.splice(draft.rollbackIndex, 0, op);
    draft.rollbackIndex++;

    return this.finish(before, evalsBefore, draft, op, def.constrains ?? false, opts);
  }

  /** Edit an existing operation's params; downstream operations re-run. */
  async editOperation(
    opId: string,
    newParams: Record<string, unknown>,
    opts: DispatchOptions = {}
  ): Promise<DispatchResult> {
    const before = this.doc;
    const evalsBefore = this.evaluations;
    const draft = clone(before);
    const op = draft.operations.find((o) => o.opId === opId);
    if (!op) return this.fail(`No operation "${opId}"`);
    const def = this.registry.get(op.type);
    if (!def) return this.fail(`Unknown command "${op.type}"`);
    const errors = validate(def.paramsSchema, newParams);
    if (errors.length) return this.fail(`Invalid params: ${errors.join("; ")}`);

    op.params = newParams;
    // Keep op.createdIds so ids (and downstream references) stay stable.
    return this.finish(before, evalsBefore, draft, op, def.constrains ?? false, opts);
  }

  /** Suppress or unsuppress an operation (skipped during replay when suppressed). */
  async setSuppressed(opId: string, suppressed: boolean): Promise<DispatchResult> {
    const before = this.doc;
    const evalsBefore = this.evaluations;
    const draft = clone(before);
    const op = draft.operations.find((o) => o.opId === opId);
    if (!op) return this.fail(`No operation "${opId}"`);
    op.suppressed = suppressed;
    return this.finish(before, evalsBefore, draft, undefined, false, {});
  }

  /** Delete an operation. Downstream operations that referenced it will error. */
  async deleteOperation(opId: string): Promise<DispatchResult> {
    const before = this.doc;
    const evalsBefore = this.evaluations;
    const draft = clone(before);
    const idx = draft.operations.findIndex((o) => o.opId === opId);
    if (idx < 0) return this.fail(`No operation "${opId}"`);
    draft.operations.splice(idx, 1);
    if (draft.rollbackIndex > idx) draft.rollbackIndex--;
    return this.finish(before, evalsBefore, draft, undefined, false, {});
  }

  /** Move the rollback bar: operations at index >= `index` become inactive. */
  async moveRollback(index: number): Promise<DispatchResult> {
    const before = this.doc;
    const evalsBefore = this.evaluations;
    const draft = clone(before);
    draft.rollbackIndex = Math.max(0, Math.min(index, draft.operations.length));
    return this.finish(before, evalsBefore, draft, undefined, false, {});
  }

  /** Make a configuration active (by id or name), or none (`null`): the model
   *  re-evaluates with its cells in effect. Undoable; not a timeline step. */
  async setActiveConfiguration(ref: string | null): Promise<DispatchResult> {
    const before = this.doc;
    const evalsBefore = this.evaluations;
    const draft = clone(before);
    if (ref !== null) {
      const c = findConfiguration(draft, ref);
      if (!c) return this.fail(`No configuration "${ref}"`);
      draft.activeConfiguration = c.id;
    } else {
      draft.activeConfiguration = undefined;
    }
    return this.finish(before, evalsBefore, draft, undefined, false, {});
  }

  /** Replace the hidden list (display-only; undoable, not a timeline step). Ids
   *  must name a feature (body), sketch, component or datum plane. */
  async setHidden(ids: string[]): Promise<DispatchResult> {
    // A stale entry (its feature since deleted) is dropped quietly; a new unknown id is an error.
    const was = new Set(this.doc.hidden ?? []);
    const unknown = ids.filter((id) => !isHideable(this.doc, id) && !was.has(id));
    if (unknown.length) return this.fail(`Nothing to hide called ${unknown.map((u) => `"${u}"`).join(", ")}`);
    ids = ids.filter((id) => isHideable(this.doc, id));
    const before = this.doc;
    const evalsBefore = this.evaluations;
    const draft = clone(before);
    const list = [...new Set(ids)];
    draft.hidden = list.length ? list : undefined;
    return this.finish(before, evalsBefore, draft, undefined, false, {});
  }

  /** Show or hide some ids, leaving the rest of the hidden list as it is. */
  setVisibility(ids: string[], visible: boolean): Promise<DispatchResult> {
    const now = new Set(this.doc.hidden ?? []);
    for (const id of ids) { if (visible) now.delete(id); else now.add(id); }
    return this.setHidden([...now]);
  }

  /** The document as it would be with configuration `ref` active (or none),
   *  rebuilt and solved, without changing the session — for exporting or
   *  measuring a variant that isn't the active one. */
  async previewConfiguration(ref: string | null): Promise<CadDocument> {
    const draft = clone(this.doc);
    if (ref !== null) {
      const c = findConfiguration(draft, ref);
      if (!c) throw new Error(`No configuration "${ref}"`);
      draft.activeConfiguration = c.id;
    } else {
      draft.activeConfiguration = undefined;
    }
    rebuild(draft, this.registry);
    await recompute(draft, this.solver);
    return draft;
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.doc = entry.docBefore;
    this.evaluations = entry.evalsBefore;
    this.redoStack.push(entry);
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.doc = entry.docAfter;
    this.evaluations = entry.evalsAfter;
    this.undoStack.push(entry);
    return true;
  }

  /** Capture the current state, for an all-or-nothing batch of edits. */
  checkpoint(): SessionCheckpoint {
    return { doc: this.doc, evaluations: this.evaluations, undo: this.undoStack.slice(), redo: this.redoStack.slice() };
  }

  /** Return to a checkpoint: the document, its evaluations and the undo/redo history as they were. */
  rollback(cp: SessionCheckpoint): void {
    this.doc = cp.doc;
    this.evaluations = cp.evaluations;
    this.undoStack = cp.undo.slice();
    this.redoStack = cp.redo.slice();
  }

  getMcpTools() {
    return this.registry.toMcpTools();
  }

  // ---- internals ----

  private fail(error: string): DispatchResult {
    return { ok: false, createdIds: [], evaluations: this.evaluations, error };
  }

  private async finish(
    before: CadDocument,
    evalsBefore: Evaluations,
    draft: CadDocument,
    newOp: OperationRecord | undefined,
    constrains: boolean,
    opts: DispatchOptions
  ): Promise<DispatchResult> {
    const { infos } = rebuild(draft, this.registry);

    // A brand-new op that fails on its first run is a hard failure (no commit).
    if (newOp && newOp.error && newOp.createdIds.length === 0 && before.operations.length < draft.operations.length) {
      return { ok: false, createdIds: [], evaluations: this.evaluations, error: newOp.error };
    }

    const evalsAfter = await recompute(draft, this.solver);

    const info: CommandApplyInfo = (newOp && infos[newOp.opId]) || {};
    const affected = info.affectedSketchId;
    const conflict = this.newConflict(evalsAfter, evalsBefore, affected);

    const reject = opts.rejectOnConflict ?? constrains;
    if (reject && conflict.isNew) {
      // discard draft; this.doc stays `before`
      return {
        ok: false,
        createdIds: [],
        evaluations: this.evaluations,
        error: `Change would over-constrain sketch ${conflict.sketchId}`,
        conflicting: conflict.conflicting,
        message: `Rejected: conflicts with ${conflict.conflicting.join(", ") || "existing constraints"}`,
      };
    }

    // commit
    this.doc = draft;
    this.evaluations = evalsAfter;
    this.undoStack.push({
      label: newOp?.label ?? "Edit",
      docBefore: before,
      evalsBefore,
      docAfter: draft,
      evalsAfter,
    });
    this.redoStack = [];

    // Expose the command's *semantic* created ids (e.g. [line, start, end]),
    // not the raw allocation order held in op.createdIds (for replay).
    return {
      ok: true,
      opId: newOp?.opId,
      createdIds: info.createdIds ?? newOp?.createdIds ?? [],
      evaluations: evalsAfter,
      conflicting: conflict.conflicting.length ? conflict.conflicting : undefined,
      message: info.message ?? newOp?.error,
    };
  }

  private newConflict(
    after: Evaluations,
    before: Evaluations,
    affectedSketchId: string | undefined
  ): { isNew: boolean; sketchId: string; conflicting: string[] } {
    const ids = affectedSketchId ? [affectedSketchId] : Object.keys(after);
    for (const sid of ids) {
      const a = after[sid];
      if (a?.diagnosis.hasConflict) {
        const wasConflicting = before[sid]?.diagnosis.hasConflict ?? false;
        return { isNew: !wasConflicting, sketchId: sid, conflicting: a.diagnosis.conflicting };
      }
    }
    return { isNew: false, sketchId: "", conflicting: [] };
  }
}
