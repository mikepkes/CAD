// The action ring: eight compass slots around the pointer, each holding a
// hotkey action id. Context-aware: every context has its own ring, and an empty
// slot inherits the same slot from the context below it on the active stack, so
// the outer slots keep their muscle memory (views, undo) while the focused
// context overrides the ones it needs. User-configurable: overrides are kept
// per context, per slot, in localStorage, layered over DEFAULT_RING.
//
// The ring runs only hotkey actions (`hotkeys.runAction`), so it can never do
// anything a key, the intent line or a 3D-mouse button couldn't, and it never
// drifts from them. Geometry and resolution are pure; `useRing` is the state.

import { create } from "zustand";
import { CONTEXTS, ContextId } from "./contexts";

/** Slots clockwise from the top. */
export const SLOT_COUNT = 8;
export const SLOT_NAMES = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/** A context's own slots: an action id, or null to inherit from below. */
export type RingRow = (string | null)[];

const row = (...ids: (string | null)[]): RingRow => Array.from({ length: SLOT_COUNT }, (_, i) => ids[i] ?? null);

/** The shipped rings. `global` fills every slot so nothing is ever blank. */
export const DEFAULT_RING: Record<ContextId, RingRow> = {
  global: row("view.top", "view.iso", "view.right", "view.frame", "view.front", "intent.open", "edit.undo", "edit.redo"),
  model: row("model.sketch", "model.extrude", null, null, "model.box", "view.lens", null, "model.component"),
  sketch: row("tool.line", "tool.rectangle", "tool.circle", "tool.arc", "sketch.finish", "tool.dimension", null, "sketch.construction"),
  component: row("component.up", null, null, null, null, null, null, "component.root"),
  lens: row("lens.zebra", "lens.draft", "lens.curvature", "lens.xray", "lens.overhang", "lens.shape", null, "view.lens"),
  feature: row("feature.rollTo", null, "feature.next", "feature.suppress", null, "feature.delete", "feature.prev", null),
  face: row("face.sketch", "face.extrude", "face.push", "face.feature", "face.lookAt", null, "face.pull", null),
};

/** User changes: context → slot index → action id, or null for "inherit from below". Absent = the default. */
export type RingOverrides = Partial<Record<ContextId, Record<number, string | null>>>;

/** A context's own slots after the user's changes. */
export function ownRow(ctx: ContextId, overrides: RingOverrides): RingRow {
  const o = overrides[ctx] ?? {};
  return DEFAULT_RING[ctx].map((d, i) => (i in o ? o[i] : d));
}

export interface RingSlot {
  index: number;
  /** The action in this slot, or null when nothing on the stack fills it. */
  actionId: string | null;
  /** The context that supplied it (the top-most one with this slot set). */
  from: ContextId | null;
}

/** The ring for an active stack (bottom → top): each slot from the top-most context that sets it. */
export function resolveRing(stack: ContextId[], overrides: RingOverrides): RingSlot[] {
  const rows = stack.map((c) => [c, ownRow(c, overrides)] as const);
  return Array.from({ length: SLOT_COUNT }, (_, index) => {
    for (let k = rows.length - 1; k >= 0; k--) {
      const id = rows[k][1][index];
      if (id) return { index, actionId: id, from: rows[k][0] };
    }
    return { index, actionId: null, from: null };
  });
}

/** What a slot in `ctx`'s ring would show if `ctx` set nothing there: the slot inherited from its base contexts. */
export function inheritedSlot(base: ContextId[], index: number, overrides: RingOverrides): RingSlot {
  return resolveRing(base, overrides)[index];
}

/** Whether the user changed anything in `ctx`'s ring. */
export function isCustomized(ctx: ContextId, overrides: RingOverrides): boolean {
  return Object.keys(overrides[ctx] ?? {}).length > 0;
}

// ---- geometry ----

/** Pointer offset from the ring centre → the slot it points at, or null inside the dead zone. */
export function slotAt(dx: number, dy: number, deadZone = 28): number | null {
  if (Math.hypot(dx, dy) < deadZone) return null;
  const a = Math.atan2(dx, -dy); // 0 = up, clockwise positive
  const step = (2 * Math.PI) / SLOT_COUNT;
  return ((Math.round(a / step) % SLOT_COUNT) + SLOT_COUNT) % SLOT_COUNT;
}

/** A slot's centre relative to the ring centre at radius `r`. */
export function slotOffset(index: number, r: number): { x: number; y: number } {
  const a = (index * 2 * Math.PI) / SLOT_COUNT;
  const q = (v: number) => Math.round(v * 100) / 100 + 0; // + 0 turns -0 into 0
  return { x: q(r * Math.sin(a)), y: q(-r * Math.cos(a)) };
}

/** Keep the whole ring (radius `r` plus the slot labels' reach `pad`) inside the viewport. */
export function clampCentre(p: { x: number; y: number }, r: number, pad: number, bounds: { w: number; h: number }): { x: number; y: number } {
  const m = r + pad;
  const c = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
  return { x: c(p.x, m, bounds.w - m), y: c(p.y, m, bounds.h - m) };
}

/** Releasing the ring key: run the pointed slot; a quick tap leaves the ring open to click; a long hold pointing nowhere closes it. */
export const TAP_MS = 250;
export function releaseOutcome(heldMs: number, slot: number | null): "run" | "stay" | "close" {
  if (slot != null) return "run";
  return heldMs < TAP_MS ? "stay" : "close";
}

// ---- state ----

const STORAGE_KEY = "chisel.ring.v1";

function load(): RingOverrides {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    const parsed = raw ? JSON.parse(raw) : {};
    const out: RingOverrides = {};
    for (const c of CONTEXTS) if (parsed && typeof parsed[c] === "object") out[c] = parsed[c];
    return out;
  } catch { return {}; }
}

function save(o: RingOverrides) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(o)); } catch { /* ignore */ }
}

export interface RingState {
  /** Whether the ring is showing. */
  open: boolean;
  /** Its centre in client (window) coordinates. */
  at: { x: number; y: number };
  /** When it opened (performance.now()), for tap vs hold. */
  openedAt: number;
  /** Last pointer position in client coordinates, kept by the overlay; where the ring opens. */
  pointer: { x: number; y: number };
  overrides: RingOverrides;

  /** Open at `at` (default: the last pointer position). No-op when already open. */
  openRing: (at?: { x: number; y: number }) => void;
  close: () => void;
  setPointer: (p: { x: number; y: number }) => void;
  /** Set a slot of `ctx`'s ring: an action id, null to inherit from below, or undefined to restore the default. */
  setSlot: (ctx: ContextId, index: number, actionId: string | null | undefined) => void;
  resetContext: (ctx: ContextId) => void;
  resetAll: () => void;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export const useRing = create<RingState>((set, get) => ({
  open: false,
  at: { x: 0, y: 0 },
  openedAt: 0,
  pointer: { x: 0, y: 0 },
  overrides: load(),
  openRing: (at) => { if (!get().open) set({ open: true, at: at ?? get().pointer, openedAt: now() }); },
  close: () => { if (get().open) set({ open: false }); },
  setPointer: (pointer) => set({ pointer }),
  setSlot: (ctx, index, actionId) => {
    const mine = { ...(get().overrides[ctx] ?? {}) };
    if (actionId === undefined || actionId === DEFAULT_RING[ctx][index]) delete mine[index];
    else mine[index] = actionId;
    const overrides = { ...get().overrides };
    if (Object.keys(mine).length) overrides[ctx] = mine; else delete overrides[ctx];
    save(overrides);
    set({ overrides });
  },
  resetContext: (ctx) => {
    const overrides = { ...get().overrides };
    delete overrides[ctx];
    save(overrides);
    set({ overrides });
  },
  resetAll: () => { save({}); set({ overrides: {} }); },
}));

/** The ring action itself: registered in the global context by hotkeyActions.ts. */
export const RING_ACTION_ID = "ring.open";
