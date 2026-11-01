// Which icon an intent-line suggestion shows: the icon of what it runs (the
// feature's own command for a feature, the action's icon for a hotkey, …).

import { IconName, iconForAction, iconForCommand, iconForPanel, iconForView } from "../../icons";
import type { IntentAction } from "./intent";

/** The rows' op (type and params) by op id and by feature id, for feature suggestions. */
export interface OpLookup {
  opId: string;
  featureId: string;
  op: { type: string; params?: Record<string, unknown> };
}

export function suggestionIcon(a: IntentAction, rows: readonly OpLookup[], timelineLength: number): IconName {
  const byOp = (pick: (r: OpLookup) => boolean): IconName => {
    const r = rows.find(pick);
    return r ? iconForCommand(r.op.type, r.op.params) : "box";
  };
  switch (a.type) {
    case "setParameter": return "parameter-edit";
    case "editOperation": return byOp((r) => r.opId === a.opId);
    case "openFeature": return byOp((r) => r.featureId === a.featureId);
    case "view": return iconForView(a.view);
    case "frame": return "view-frame";
    case "rollback": return a.index >= timelineLength ? "history-end" : "roll-to";
    case "suppress": return "suppress";
    case "undo": return "undo";
    case "redo": return "redo";
    case "togglePanel": return iconForPanel(a.panel);
    case "addIntent": return "intent-add";
    case "hotkey": return iconForAction(a.id);
  }
}
