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
import { renameInOperation, inlineInOperation } from "../parameterRename";
import { isValidParamName } from "../parameters";
import { describeConstraint, listWords } from "../../sketch/types";

/** Why a change was refused for over-constraining, in the sketch's and the constraints' own names (ids stay in
 *  `conflicting` for agents). The constraints the change itself added are left out of "conflicts with". */
function overConstraintText(doc: CadDocument, sketchId: string, conflicting: string[], added: string[]): string {
  const sk = doc.sketches[sketchId];
  const others = conflicting.filter((id) => !added.includes(id)).map((id) => describeConstraint(sk?.constraints[id]));
  const where = sk?.name ?? "the sketch";
  return others.length
    ? `That would over-constrain ${where}: it conflicts with ${listWords([...new Set(others)])}`
    : `That would over-constrain ${where}: it's already fully determined there`;
}

export interface DispatchOptions {
  rejectOnConflict?: boolean;
}

/** What one step does, in words ("Edit Extrude 2", "Set width = 40"): the undo stack's label and the message an edit reports. */
function stepLabel(op: OperationRecord, verb = "Edit"): string {
  const p = op.params as Record<string, unknown>;
  if (verb === "Edit" && op.type === "parameter.add" && typeof p.name === "string") return `Set ${p.name} = ${String(p.expression ?? "")}`;
  const name = typeof p.name === "string" && p.name && !op.type.startsWith("parameter.") ? p.name : op.label;
  return `${verb} ${name}`;
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
    if (def.stampNew) params = def.stampNew(params);
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
    // An edit reports itself ("Set width = 40", "Edit Extrude 2"), not the message its op gives when first applied.
    const label = stepLabel(op);
    const r = await this.finish(before, evalsBefore, draft, op, def.constrains ?? false, opts, label);
    return r.ok ? { ...r, message: op.error ? r.message : label } : r;
  }

  /** Rename a parameter and every reference to it, in one undoable step (see parameterRename.ts). */
  async renameParameter(from: string, to: string): Promise<DispatchResult> {
    if (!isValidParamName(to)) return this.fail(`"${to}" isn't a valid name: use letters, digits and _, starting with a letter`);
    if (from === to) return this.fail("That's already its name");
    if (this.doc.parameters.some((p) => p.name === to)) return this.fail(`There's already a parameter called ${to}`);
    if (!this.doc.parameters.some((p) => p.name === from)) return this.fail(`No parameter called ${from}`);
    const before = this.doc;
    const evalsBefore = this.evaluations;
    const draft = clone(before);
    for (const op of draft.operations) op.params = renameInOperation(op, from, to);
    return this.finish(before, evalsBefore, draft, undefined, false, {}, `Rename ${from} to ${to}`);
  }

  /** Suppress or unsuppress an operation (skipped during replay when suppressed). */
  async setSuppressed(opId: string, suppressed: boolean): Promise<DispatchResult> {
    const before = this.doc;
    const evalsBefore = this.evaluations;
    const draft = clone(before);
    const op = draft.operations.find((o) => o.opId === opId);
    if (!op) return this.fail(`No operation "${opId}"`);
    op.suppressed = suppressed;
    return this.finish(before, evalsBefore, draft, undefined, false, {}, stepLabel(op, suppressed ? "Suppress" : "Unsuppress"));
  }

  /** Delete an operation. Downstream operations that referenced it will error. */
  async deleteOperation(opId: string): Promise<DispatchResult> {
    const before = this.doc;
    const evalsBefore = this.evaluations;
    const draft = clone(before);
    const idx = draft.operations.findIndex((o) => o.opId === opId);
    if (idx < 0) return this.fail(`No operation "${opId}"`);
    const [gone] = draft.operations.splice(idx, 1);
    if (draft.rollbackIndex > idx) draft.rollbackIndex--;
    return this.finish(before, evalsBefore, draft, undefined, false, {}, stepLabel(gone, "Delete"));
  }

  /** Move the rollback bar: operations at index >= `index` become inactive. */
  async moveRollback(index: number): Promise<DispatchResult> {
    const before = this.doc;
    const evalsBefore = this.evaluations;
    const draft = clone(before);
    draft.rollbackIndex = Math.max(0, Math.min(index, draft.operations.length));
    return this.finish(before, evalsBefore, draft, undefined, false, {}, draft.rollbackIndex >= draft.operations.length ? "Roll to the end" : "Roll back");
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
    return this.finish(before, evalsBefore, draft, undefined, false, {}, "Change configuration");
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
    return this.finish(before, evalsBefore, draft, undefined, false, {}, "Show or hide");
  }

  /** Delete a parameter. With `inline`, everything that used it keeps its current value as a plain number first,
   *  so nothing collapses; in one undoable step either way. Removes the op that added it (or records a
   *  parameter.delete when no op of this history added it). */
  async deleteParameter(name: string, opts: { inline?: boolean } = {}): Promise<DispatchResult> {
    const param = this.doc.parameters.find((p) => p.name === name);
    if (!param) return this.fail(`No parameter called ${name}`);
    const addOp = this.doc.operations.find((o) => o.type === "parameter.add" && (o.params as { name?: unknown }).name === name);
    if (!addOp) {
      if (!opts.inline) return this.dispatch("parameter.delete", { name });
    }
    const before = this.doc;
    const evalsBefore = this.evaluations;
    const draft = clone(before);
    if (opts.inline) for (const op of draft.operations) if (op.opId !== addOp?.opId) op.params = inlineInOperation(op, name, param.value);
    if (addOp) {
      const idx = draft.operations.findIndex((o) => o.opId === addOp.opId);
      draft.operations.splice(idx, 1);
      if (draft.rollbackIndex > idx) draft.rollbackIndex--;
    } else {
      // parameter.add came from elsewhere (a template): record the delete as a step after the inlining
      const op: OperationRecord = { opId: `op${draft.nextId++}`, type: "parameter.delete", params: { name }, createdIds: [], label: "Delete parameter", at: Date.now() };
      draft.operations.splice(draft.rollbackIndex, 0, op);
      draft.rollbackIndex++;
    }
    return this.finish(before, evalsBefore, draft, undefined, false, {}, opts.inline ? `Delete ${name}, keeping its value` : `Delete ${name}`);
  }

  /** Name the document (what Save names its file after); empty clears it. Undoable, not a timeline step. */
  async renameDocument(name: string): Promise<DispatchResult> {
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 80);
    if ((this.doc.name ?? "") === clean) return this.fail("That's already its name");
    const before = this.doc;
    const evalsBefore = this.evaluations;
    const draft = clone(before);
    if (clean) draft.name = clean; else delete draft.name;
    return this.finish(before, evalsBefore, draft, undefined, false, {}, clean ? `Name the document ${clean}` : "Clear the document's name");
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

  /** What undo would take back ("Edit Extrude 2"), or null when there is nothing to undo. */
  undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }
  /** What redo would put back, or null. */
  redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }

  /** Fold every step taken since `cp` into one undo step called `label` (a gesture that took several commands,
   *  like a rectangle and the constraints its snaps add, undoes in one go). No-op when nothing was done since. */
  squash(cp: SessionCheckpoint, label?: string): void {
    const added = this.undoStack.length - cp.undo.length;
    if (added < 1 || this.doc === cp.doc) return;
    if (added === 1 && !label) return;
    const first = this.undoStack[cp.undo.length];
    this.undoStack = [...cp.undo, { label: label ?? first.label, docBefore: cp.doc, evalsBefore: cp.evaluations, docAfter: this.doc, evalsAfter: this.evaluations }];
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

  /** How many undoable steps there are: a mark for squashSince / dropSince. */
  get undoDepth(): number {
    return this.undoStack.length;
  }

  /** Fold every undoable step taken since `mark` into one (a drag that wrote a
   *  value on each move undoes in one step). Nothing happens with fewer than one. */
  squashSince(mark: number, label?: string): void {
    const from = Math.max(0, Math.min(mark, this.undoStack.length));
    const steps = this.undoStack.splice(from);
    if (!steps.length) return;
    const first = steps[0], last = steps[steps.length - 1];
    this.undoStack.push({ label: label ?? last.label, docBefore: first.docBefore, evalsBefore: first.evalsBefore, docAfter: last.docAfter, evalsAfter: last.evalsAfter });
  }

  /** Forget the undoable steps taken since `mark`, keeping the document as it is
   *  (a preview that has put everything back leaves nothing to undo). */
  dropSince(mark: number): void {
    this.undoStack.splice(Math.max(0, Math.min(mark, this.undoStack.length)));
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
    opts: DispatchOptions,
    label?: string
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
        error: overConstraintText(draft, conflict.sketchId, conflict.conflicting, newOp?.createdIds ?? []),
        conflicting: conflict.conflicting,
        message: `Rejected: conflicts with ${conflict.conflicting.join(", ") || "existing constraints"}`,
      };
    }

    // commit
    this.doc = draft;
    this.evaluations = evalsAfter;
    this.undoStack.push({
      label: label ?? newOp?.label ?? "Edit",
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
