// What the ring overlay shows and how its keys move: slot labels and key
// hints from the hotkey manager, the ring key's bindings, digit / arrow keys.
// Pure (no React): the overlay maps these onto kit buttons. Which action sits
// in which slot is src/model/ring.ts (resolveRing); this only presents it.

import { prettyKey } from "../../../model/hotkeys";
import { RING_ACTION_ID, RingSlot, SLOT_COUNT, SLOT_NAMES } from "../../../model/ring";
import { ContextId } from "../../../model/contexts";

/** Radius of the slot centres, px. */
export const RING_R = 96;
/** How far a slot's button reaches past its centre (half its widest label), px: keeps it on screen. */
export const RING_PAD = 72;
/** Pointer this close to the centre points at no slot, px. */
export const DEAD_ZONE = 28;

/** The slice of the HotkeyManager the ring reads (the singleton satisfies it; tests may stub it). */
export interface HotkeySource {
  info(id: string): { label: string; context: string } | null;
  primary(id: string): string | null;
  secondary(id: string): string | null;
  can(id: string): boolean;
}

export interface SlotView {
  index: number;
  /** Compass name of the slot ("N", "NE", …). */
  name: (typeof SLOT_NAMES)[number];
  actionId: string | null;
  /** Short label for the ring; the full one is `title`. */
  label: string;
  title: string;
  /** Pretty primary binding, or "" when the action has none. */
  key: string;
  /** Whether it would run now (registered, its context active, its guard passing). */
  enabled: boolean;
  from: ContextId | null;
}

/** A hotkey label cut to fit a ring slot: "View: Top" → "Top", "Toggle the lens" → "Lens",
 *  "Line tool" → "Line", "Frame selection / fit" → "Frame selection". */
export function shortLabel(label: string, max = 16): string {
  let s = label.trim();
  s = s.replace(/\s*\(.*\)\s*$/, ""); // "Action ring (hold, point, release)"
  s = s.split(" / ")[0]; // "Frame selection / fit"
  const colon = s.indexOf(": ");
  if (colon > 0 && colon < s.length - 2) s = s.slice(colon + 2); // "View: Top", "Lens: Zebra"
  s = s.replace(/^toggle\s+(the\s+)?/i, ""); // "Toggle the lens"
  s = s.replace(/\s+tool$/i, ""); // "Line tool"
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

/** The resolved ring as the overlay draws it. An id nothing registered shows as itself, disabled. */
export function slotViews(slots: RingSlot[], hk: HotkeySource): SlotView[] {
  return slots.map((s) => {
    const name = SLOT_NAMES[s.index];
    if (!s.actionId) return { index: s.index, name, actionId: null, label: "", title: "", key: "", enabled: false, from: null };
    const info = hk.info(s.actionId);
    const title = info?.label ?? s.actionId;
    const bound = hk.primary(s.actionId);
    return {
      index: s.index, name, actionId: s.actionId,
      label: info ? shortLabel(title) : s.actionId, title,
      key: bound ? prettyKey(bound) : "",
      enabled: hk.can(s.actionId),
      from: s.from,
    };
  });
}

/** The ring key's bindings (primary, secondary), whichever are set. */
export function ringKeys(hk: Pick<HotkeySource, "primary" | "secondary">): string[] {
  return [hk.primary(RING_ACTION_ID), hk.secondary(RING_ACTION_ID)].filter((k): k is string => !!k);
}

const lastPart = (k: string) => k.split("+").pop() ?? "";

/** Whether a key-up releases the ring key. Only the key itself is compared, since its
 *  modifiers may be let go first ("mod+space" released as "space"). */
export function releasesRingKey(eventKey: string, bindings: string[]): boolean {
  const k = lastPart(eventKey);
  return bindings.some((b) => lastPart(b) === k);
}

/** Digit keys "1"…"8" pick slots N…NW. */
export function digitSlot(key: string): number | null {
  const n = /^[1-8]$/.test(key) ? Number(key) : 0;
  return n ? n - 1 : null;
}

export type ArrowDir = "up" | "right" | "down" | "left";
const ARROW_SLOT: Record<ArrowDir, number> = { up: 0, right: 2, down: 4, left: 6 };

export function arrowDir(key: string): ArrowDir | null {
  return key === "up" || key === "right" || key === "down" || key === "left" ? key : null;
}

/** An arrow key moves the highlight one slot toward that side of the ring: from N, → gives NE then E;
 *  from nothing, or from the opposite side, it jumps straight to that side. */
export function moveHighlight(current: number | null, dir: ArrowDir): number {
  const target = ARROW_SLOT[dir];
  if (current == null) return target;
  const cw = (target - current + SLOT_COUNT) % SLOT_COUNT; // clockwise steps to the target
  if (cw === 0 || cw === SLOT_COUNT / 2) return target;
  return (current + (cw < SLOT_COUNT / 2 ? 1 : -1) + SLOT_COUNT) % SLOT_COUNT;
}
