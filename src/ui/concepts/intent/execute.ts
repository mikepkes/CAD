// Runs an IntentAction against the app's command path. Everything it needs is
// injected, so it has no React and no store import of its own and is tested in
// Node with fakes; IntentLine.tsx supplies the real store, useUi and hotkeys.

import type { ConceptPanel } from "../../../model/concepts/uiState";
import type { IntentAction } from "./intent";

export interface Executor {
  setParameterExpr(name: string, expr: string): Promise<void> | void;
  editOperation(opId: string, params: Record<string, unknown>): Promise<void> | void;
  moveRollback(index: number): Promise<void> | void;
  suppressOperation(opId: string, suppressed: boolean): Promise<void> | void;
  undo(): void;
  redo(): void;
  /** window.dispatchEvent(new CustomEvent(name, { detail })) */
  fire(name: "chisel:view" | "chisel:frame" | "chisel:lookAt", detail?: string): void;
  /** hotkeys.runAction */
  runAction(id: string): boolean;
  setOpenFeature(id: string | null): void;
  togglePanel(panel: ConceptPanel): void;
  /** useIntents().add(text, label) — the shared intents store, which dispatches intent.add; false (or null)
   *  when the text is not a comparison, else true or the command's promise, which is awaited. */
  addIntent(text: string, label: string): boolean | null | Promise<unknown>;
}

/** Perform the action. Resolves when the store call has settled; throws what the store throws. */
export async function execute(action: IntentAction, x: Executor): Promise<void> {
  switch (action.type) {
    case "setParameter": await x.setParameterExpr(action.name, action.expr); return;
    case "editOperation": await x.editOperation(action.opId, action.params); return;
    case "view": x.fire("chisel:view", action.view); return;
    case "frame": x.fire("chisel:frame"); return;
    case "rollback": await x.moveRollback(action.index); return;
    case "suppress": await x.suppressOperation(action.opId, action.suppressed); return;
    case "undo": x.undo(); return;
    case "redo": x.redo(); return;
    case "openFeature": x.setOpenFeature(action.featureId); return;
    case "togglePanel": x.togglePanel(action.panel); return;
    case "addIntent": {
      const text = `${action.lhs} ${action.op} ${action.rhs}`;
      const r = x.addIntent(text, action.label);
      if (!r) throw new Error(`"${text}" is not a comparison`);
      await r;
      return;
    }
    case "hotkey":
      if (!x.runAction(action.id)) throw new Error(`"${action.id}" is not available right now`);
      return;
  }
}
