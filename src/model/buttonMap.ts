// 3D-mouse buttons → hotkey actions, per context. The same model as the ring:
// the global row is the base (`SpaceMouseSettings.buttons`, as before), every
// other context may override a button (`contextButtons`), and a press resolves
// top-down through the active stack. A context's "" means "nothing here" (it
// stops inheritance); a context that doesn't mention a button inherits it. An
// action that can't run now (`hotkeys.can`) falls through to the context below,
// as a key does when its action's `when` fails.

import { CONTEXT_BASE, CONTEXTS, ContextId } from "./contexts";
import type { SpaceMouseSettings } from "../viewport/spaceMouse";

/** Context → button index → action id ("" = nothing). */
export type ButtonMap = Partial<Record<ContextId, Record<number, string>>>;

/** The full map the settings hold: the global row plus the per-context overrides. */
export function buttonMapOf(s: Pick<SpaceMouseSettings, "buttons" | "contextButtons">): ButtonMap {
  const out: ButtonMap = { global: { ...s.buttons } };
  for (const c of CONTEXTS) if (c !== "global" && s.contextButtons?.[c]) out[c] = { ...s.contextButtons[c] };
  return out;
}

/** Back to the settings' two fields. Empty context rows are dropped. */
export function settingsOf(map: ButtonMap): Pick<SpaceMouseSettings, "buttons" | "contextButtons"> {
  const contextButtons: Record<string, Record<number, string>> = {};
  for (const c of CONTEXTS) if (c !== "global" && map[c] && Object.keys(map[c]!).length) contextButtons[c] = { ...map[c] };
  return { buttons: { ...(map.global ?? {}) }, contextButtons };
}

export interface ResolvedButton {
  actionId: string | null;
  /** The context that decided it (null when nothing on the stack mentions the button). */
  from: ContextId | null;
}

/** What button `b` runs on this stack (bottom → top). `can` filters actions that can't run now; omit it to resolve the configuration alone. */
export function resolveButton(b: number, stack: ContextId[], map: ButtonMap, can: (id: string) => boolean = () => true): ResolvedButton {
  for (let k = stack.length - 1; k >= 0; k--) {
    const row = map[stack[k]];
    if (!row || !(b in row)) continue;
    const id = row[b];
    if (!id) return { actionId: null, from: stack[k] }; // "nothing here"
    if (can(id)) return { actionId: id, from: stack[k] };
  }
  return { actionId: null, from: null };
}

/** What button `b` would do in `ctx` if `ctx` didn't set it: resolved over the contexts it sits on. */
export function inheritedButton(b: number, ctx: ContextId, map: ButtonMap): ResolvedButton {
  return resolveButton(b, CONTEXT_BASE[ctx], map);
}

/** Set button `b` in `ctx`: an action id, "" for nothing, or null to inherit (in global, null and "" both clear it). */
export function setButton(map: ButtonMap, ctx: ContextId, b: number, id: string | null): ButtonMap {
  const row = { ...(map[ctx] ?? {}) };
  if (id === null || (ctx === "global" && id === "")) delete row[b];
  else row[b] = id;
  const out = { ...map };
  if (Object.keys(row).length || ctx === "global") out[ctx] = row; else delete out[ctx];
  return out;
}

/** Whether a non-global context overrides any button. */
export function overridesButtons(ctx: ContextId, map: ButtonMap): boolean {
  return ctx !== "global" && Object.keys(map[ctx] ?? {}).length > 0;
}

/** How many button rows to show: at least two, and enough for every configured or seen button. */
export function buttonRows(map: ButtonMap, seen: number[], extra = 0): number {
  let n = 2;
  for (const row of Object.values(map)) for (const k of Object.keys(row ?? {})) n = Math.max(n, Number(k) + 1);
  for (const b of seen) n = Math.max(n, b + 1);
  return n + extra;
}
