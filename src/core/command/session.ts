// CadSession ties the pieces together: it owns the document, dispatches
// commands through the registry, recomputes (solves) after each, keeps an
// undo/redo timeline, and enforces the incremental over-constraint guard.
//
// Because constraints are added one command at a time, when a command tips a
// sketch into conflict we know *that* command's constraint is the culprit — so
// we can reject it (optionally) and hand back exactly which constraints clash,
// which is what lets a user or an agent self-correct.

import { CadDocument, allocId } from "../document";
import { ConstraintSolver } from "../solver/model";
import { Evaluations, recompute } from "../recompute";
import { CommandRegistry } from "./registry";
import { CommandContext, CommandRecord } from "./types";
import { validate } from "./validate";

export interface DispatchOptions {
  /** Revert the command if it introduces a new conflict in the touched sketch. */
  rejectOnConflict?: boolean;
}

export interface DispatchResult {
  ok: boolean;
  record?: CommandRecord;
  createdIds: string[];
  evaluations: Evaluations;
  /** Present when the command failed validation or was rejected. */
  error?: string;
  /** Constraint ids that conflict (when over-constrained). */
  conflicting?: string[];
  message?: string;
}

interface TimelineEntry {
  record: CommandRecord;
  docBefore: CadDocument;
  evalsBefore: Evaluations;
  docAfter: CadDocument;
  evalsAfter: Evaluations;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

export class CadSession {
  doc: CadDocument;
  evaluations: Evaluations = {};
  private undoStack: TimelineEntry[] = [];
  private redoStack: TimelineEntry[] = [];

  constructor(
    initialDoc: CadDocument,
    private registry: CommandRegistry,
    private solver: ConstraintSolver
  ) {
    this.doc = initialDoc;
  }

  get timeline(): CommandRecord[] {
    return this.undoStack.map((e) => e.record);
  }
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Recompute the current document (e.g. after loading). */
  async recompute(): Promise<Evaluations> {
    this.evaluations = await recompute(this.doc, this.solver);
    return this.evaluations;
  }

  async dispatch(
    type: string,
    params: Record<string, unknown>,
    opts: DispatchOptions = {}
  ): Promise<DispatchResult> {
    const def = this.registry.get(type);
    if (!def) {
      return { ok: false, createdIds: [], evaluations: this.evaluations, error: `Unknown command "${type}"` };
    }

    const errors = validate(def.paramsSchema, params);
    if (errors.length) {
      return {
        ok: false,
        createdIds: [],
        evaluations: this.evaluations,
        error: `Invalid params for "${type}": ${errors.join("; ")}`,
      };
    }

    const docBefore = this.doc;
    const evalsBefore = this.evaluations;

    const draft = clone(docBefore);
    const ctx: CommandContext = { alloc: (prefix) => allocId(draft, prefix) };

    let info;
    try {
      info = def.apply(draft, params, ctx) || {};
    } catch (err) {
      return {
        ok: false,
        createdIds: [],
        evaluations: this.evaluations,
        error: `Command "${type}" failed: ${(err as Error).message}`,
      };
    }

    // Commit tentatively and recompute.
    this.doc = draft;
    this.evaluations = await recompute(draft, this.solver);

    // Over-constraint guard.
    const reject = opts.rejectOnConflict ?? def.constrains ?? false;
    const affected = info.affectedSketchId;
    const conflictInfo = this.newConflict(affected, evalsBefore);
    if (reject && conflictInfo.isNew) {
      // revert
      this.doc = docBefore;
      this.evaluations = evalsBefore;
      return {
        ok: false,
        createdIds: [],
        evaluations: this.evaluations,
        error: `Command "${type}" would over-constrain sketch ${conflictInfo.sketchId}`,
        conflicting: conflictInfo.conflicting,
        message: `Rejected: conflicts with ${conflictInfo.conflicting.join(", ") || "existing constraints"}`,
      };
    }

    const record: CommandRecord = { type, params, at: Date.now(), label: def.title };
    this.undoStack.push({
      record,
      docBefore,
      evalsBefore,
      docAfter: this.doc,
      evalsAfter: this.evaluations,
    });
    this.redoStack = [];

    return {
      ok: true,
      record,
      createdIds: info.createdIds ?? [],
      evaluations: this.evaluations,
      conflicting: conflictInfo.conflicting.length ? conflictInfo.conflicting : undefined,
      message: info.message,
    };
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

  getMcpTools() {
    return this.registry.toMcpTools();
  }

  /** Did a (new) conflict appear, relative to the prior evaluation? */
  private newConflict(
    affectedSketchId: string | undefined,
    before: Evaluations
  ): { isNew: boolean; sketchId: string; conflicting: string[] } {
    const sketchIds = affectedSketchId ? [affectedSketchId] : Object.keys(this.evaluations);
    for (const sid of sketchIds) {
      const after = this.evaluations[sid];
      if (after?.diagnosis.hasConflict) {
        const wasConflicting = before[sid]?.diagnosis.hasConflict ?? false;
        return { isNew: !wasConflicting, sketchId: sid, conflicting: after.diagnosis.conflicting };
      }
    }
    return { isNew: false, sketchId: "", conflicting: [] };
  }
}
