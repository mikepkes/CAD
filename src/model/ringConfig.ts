// Ring configuration as the Hotkeys panel's ring editor, the agent and MCP see
// it. One reading of the ring (`describeRing`), one validated write
// (`applyRingSlot`), and the per-slot view the editor draws; all of it over
// ring.ts (rows, resolution, the `useRing` overrides) and the hotkey actions
// that are actually registered. A slot can hold only an action from the
// contexts its ring sits on (`ringSources`), so a ring never offers something
// that cannot run where it shows.

import { hotkeys as appHotkeys, HotkeyManager } from "./hotkeys";
import { CONTEXTS, CONTEXT_BASE, CONTEXT_LABELS, ContextId, isContextId, ringSources } from "./contexts";
import {
  DEFAULT_RING, RING_ACTION_ID, RingOverrides, RingSlot, SLOT_COUNT, SLOT_NAMES,
  inheritedSlot, isCustomized, ownRow, resolveRing, slotOffset, useRing,
} from "./ring";

/** What the ring config reads from the hotkey manager (the app singleton by default; tests pass their own). */
export type RingHotkeys = Pick<HotkeyManager, "describe" | "info" | "getContexts">;

/** A context's display name; unknown ids (a context the ring doesn't know) read as themselves. */
export function contextLabel(c: string): string {
  return isContextId(c) ? CONTEXT_LABELS[c] : c;
}

/** The active stack as ring contexts (bottom → top). */
export function activeStack(hk: RingHotkeys = appHotkeys): ContextId[] {
  return hk.getContexts().filter(isContextId);
}

/** An action's label, or its id when nothing is registered under it. */
export function actionLabel(id: string | null, hk: RingHotkeys = appHotkeys): string {
  if (!id) return "—";
  return hk.info(id)?.label ?? id;
}

/** "N" / "ne" / 0..7 / "3" → a slot index, or null. */
export function parseSlot(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 && v < SLOT_COUNT ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  if (/^\d+$/.test(s)) return parseSlot(Number(s));
  const i = (SLOT_NAMES as readonly string[]).indexOf(s);
  return i >= 0 ? i : null;
}

export interface RingChoice { id: string; label: string; primary: string | null }
export interface RingChoiceGroup { context: ContextId; label: string; actions: RingChoice[] }

/** The actions a slot of `ctx`'s ring may hold, grouped by source context (base first). Never the ring key itself. */
export function ringChoices(ctx: ContextId, hk: RingHotkeys = appHotkeys): RingChoiceGroup[] {
  const byContext = new Map(hk.describe().contexts.map((c) => [c.context, c.actions]));
  return ringSources(ctx).map((c) => ({
    context: c,
    label: CONTEXT_LABELS[c],
    actions: (byContext.get(c) ?? [])
      .filter((a) => a.id !== RING_ACTION_ID)
      .map((a) => ({ id: a.id, label: a.label, primary: a.primary })),
  }));
}

/** Why `id` can't sit in `ctx`'s ring, or null when it can. */
export function ringSlotProblem(ctx: ContextId, id: string, hk: RingHotkeys = appHotkeys): string | null {
  if (id === RING_ACTION_ID) return "the ring can't hold the action that opens it";
  const info = hk.info(id);
  if (!info) return `no hotkey action "${id}" (see get_hotkeys)`;
  const sources = ringSources(ctx);
  if (!(sources as string[]).includes(info.context)) {
    return `"${id}" belongs to the ${info.context} context; a ${ctx} ring may hold actions from ${sources.join(", ")}`;
  }
  return null;
}

/** One slot of `ctx`'s ring as the editor shows it. */
export interface SlotView {
  index: number;
  name: string;
  /** The context's own value (null = inherits). */
  own: string | null;
  /** The shipped value. */
  default: string | null;
  /** The user changed this slot. */
  overridden: boolean;
  /** What it shows when `own` is null: the slot from the contexts below. */
  inherited: RingSlot;
}

export function slotViews(ctx: ContextId, overrides: RingOverrides): SlotView[] {
  const own = ownRow(ctx, overrides);
  const mine = overrides[ctx] ?? {};
  return own.map((id, index) => ({
    index,
    name: SLOT_NAMES[index],
    own: id,
    default: DEFAULT_RING[ctx][index],
    overridden: index in mine,
    inherited: inheritedSlot(CONTEXT_BASE[ctx], index, overrides),
  }));
}

/** Where the editor draws slot `i`: the ring's own compass, stretched to an ellipse of radii (`rx`, `ry`). */
export function editorSlotPos(i: number, rx: number, ry: number): { x: number; y: number } {
  const u = slotOffset(i, 1);
  return { x: Math.round(u.x * rx), y: Math.round(u.y * ry) };
}

/** "N Line tool · NE Rectangle tool · …": what the ring key shows on this stack right now. */
export function ringPreview(stack: ContextId[], overrides: RingOverrides, hk: RingHotkeys = appHotkeys): string {
  return resolveRing(stack, overrides).map((s) => `${SLOT_NAMES[s.index]} ${actionLabel(s.actionId, hk)}`).join(" · ");
}

/** The whole ring config for the agent / MCP: every context's own row and defaults, and the ring on the active stack. */
export function describeRing(overrides: RingOverrides = useRing.getState().overrides, hk: RingHotkeys = appHotkeys) {
  const stack = activeStack(hk);
  return {
    slots: [...SLOT_NAMES],
    stack,
    ring: resolveRing(stack, overrides).map((s) => ({
      slot: SLOT_NAMES[s.index], action: s.actionId, label: s.actionId ? actionLabel(s.actionId, hk) : null, from: s.from,
    })),
    contexts: CONTEXTS.map((c) => ({
      context: c,
      label: CONTEXT_LABELS[c],
      active: stack.includes(c),
      customized: isCustomized(c, overrides),
      sources: ringSources(c),
      own: ownRow(c, overrides),
      defaults: DEFAULT_RING[c],
    })),
  };
}

/** set_ring_slot: validate, then write through `useRing.setSlot`. `action` null = inherit, "default" = the shipped value. Throws on bad input. */
export function applyRingSlot(args: { context?: unknown; slot?: unknown; action?: unknown }, hk: RingHotkeys = appHotkeys) {
  const ctx = String(args.context ?? "");
  if (!isContextId(ctx)) throw new Error(`unknown context "${ctx}"; one of ${CONTEXTS.join(", ")}`);
  const slot = parseSlot(args.slot);
  if (slot == null) throw new Error(`slot must be 0-7 or one of ${SLOT_NAMES.join("/")}`);
  if (args.action === undefined) throw new Error("action is required: an action id, null to inherit, or \"default\"");
  let value: string | null | undefined;
  if (args.action === null) value = null;
  else if (args.action === "default") value = undefined;
  else {
    value = String(args.action);
    const problem = ringSlotProblem(ctx, value, hk);
    if (problem) throw new Error(problem);
  }
  useRing.getState().setSlot(ctx, slot, value);
  return { ok: true, context: ctx, slot: SLOT_NAMES[slot], ring: describeRing(useRing.getState().overrides, hk) };
}

export const GET_RING_DESCRIPTION =
  "Read the action ring (Space, or right-click in the model): eight compass slots N, NE, E, SE, S, SW, W, NW, each a hotkey action id. Every context (global, model, sketch, component, lens, feature, face) has its own row; null inherits the slot from the contexts below on the active stack. Returns `stack` (active, bottom → top), `ring` (what the ring shows right now, each slot with the context it came from), and per context its `own` row, shipped `defaults`, `sources` (contexts whose actions it may hold) and whether the user `customized` it.";
export const SET_RING_SLOT_DESCRIPTION =
  "Set one slot of a context's ring. `context` is a ring context (global, model, sketch, component, lens, feature, face); `slot` is 0-7 or N/NE/E/SE/S/SW/W/NW (clockwise from the top); `action` is a registered action id from get_hotkeys whose context is one of the ring's sources (see get_ring), null to inherit from the contexts below, or \"default\" to restore the shipped slot.";
