// UI control for agents: show or hide a panel, and run any hotkey action by id.
// The agent and both MCP surfaces (webmcp.ts, agent.ts) share these, so an
// agent can reach every panel, tool, lens mode and view a key can.
//
// The concept panels are read from useUi (whatever `panels` holds, so a panel
// added there later is listed without touching this file); app-level panels
// outside it (the agent chat, the hotkeys sheet) are registered by whoever
// owns their state (`registerPanel`), so this module stays free of the store.

import { useUi, type ConceptPanel } from "./concepts/uiState";
import { hotkeys as appHotkeys, type HotkeyManager } from "./hotkeys";

interface ExtraPanel { get: () => boolean; set: (on: boolean) => void; label?: string }
const extra = new Map<string, ExtraPanel>();

/** Make an app panel (state outside useUi) switchable by set_panel. Returns an unregister function. */
export function registerPanel(name: string, p: ExtraPanel): () => void {
  extra.set(name, p);
  return () => { if (extra.get(name) === p) extra.delete(name); };
}

/** Every switchable panel and whether it is shown. */
export function listPanels(): Record<string, boolean> {
  const out: Record<string, boolean> = { ...useUi.getState().panels };
  for (const [name, p] of extra) out[name] = p.get();
  return out;
}

/** set_panel: {panel, on}. `on` omitted toggles. */
export function setPanel(args: { panel?: unknown; on?: unknown }): { ok: boolean; panel?: string; on?: boolean; panels: Record<string, boolean>; error?: string } {
  const name = typeof args.panel === "string" ? args.panel.trim() : "";
  const concept = Object.keys(useUi.getState().panels);
  if (concept.includes(name)) {
    const on = typeof args.on === "boolean" ? args.on : undefined;
    useUi.getState().togglePanel(name as ConceptPanel, on);
    return { ok: true, panel: name, on: useUi.getState().panels[name as ConceptPanel], panels: listPanels() };
  }
  const p = extra.get(name);
  if (p) {
    p.set(typeof args.on === "boolean" ? args.on : !p.get());
    return { ok: true, panel: name, on: p.get(), panels: listPanels() };
  }
  return { ok: false, error: `Unknown panel "${name}". Panels: ${Object.keys(listPanels()).join(", ")}`, panels: listPanels() };
}

/** run_action: run a registered hotkey action by id, honouring its context and `when`. */
export function runActionTool(args: { action?: unknown }, hk: Pick<HotkeyManager, "can" | "runAction" | "info" | "describe"> = appHotkeys): { ok: boolean; action?: string; label?: string; ran?: boolean; error?: string; actions?: string[] } {
  const id = typeof args.action === "string" ? args.action.trim() : "";
  const info = hk.info(id);
  if (!info) {
    const ids = hk.describe().contexts.flatMap((c) => c.actions.map((a) => a.id));
    const near = ids.filter((x) => id && (x.includes(id) || id.includes(x.split(".").pop() ?? "\u0000")));
    return { ok: false, error: `Unknown action "${id}" — call get_hotkeys for the ids`, actions: (near.length ? near : ids).slice(0, 40) };
  }
  if (!hk.can(id)) return { ok: false, action: id, label: info.label, ran: false, error: `"${info.label}" can't run now (its context "${info.context}" isn't active, or it doesn't apply)` };
  const ran = hk.runAction(id);
  return { ok: ran, action: id, label: info.label, ran, ...(ran ? {} : { error: `"${info.label}" did not run` }) };
}

export const SET_PANEL_DESCRIPTION =
  "Show or hide a panel of the app: {panel, on} (omit `on` to toggle). Panels are the concept surfaces (workbench pins and history strip, ledger, space, lens, intent line, and any added later) plus app panels such as the agent chat and the hotkeys sheet. Returns every panel and whether it is shown; an unknown name lists them.";

export const RUN_ACTION_DESCRIPTION =
  "Run any app action a key, the action ring or a 3D-mouse button can run, by its id: drawing tools (tool.line, tool.circle, …), views (view.front, view.iso, view.frame), lens modes, panel toggles, undo/redo and more. Call get_hotkeys first for the ids and which contexts are active: an action runs only when its context is on the active stack and it applies now. Returns whether it ran; an unknown id lists the action ids.";

export const SET_PANEL_SCHEMA = { type: "object", required: ["panel"], properties: { panel: { type: "string" }, on: { type: "boolean" } } };
export const RUN_ACTION_SCHEMA = { type: "object", required: ["action"], properties: { action: { type: "string" } } };
