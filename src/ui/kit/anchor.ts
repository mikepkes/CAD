// Where a floating card goes, given the point it belongs to and the box it
// must stay inside. Pure, so every card (feature card, face verbs, lens HUD)
// places itself the same way and the rule is tested once.

export interface Box { w: number; h: number }
export interface Pt { x: number; y: number }

/** Card widths (px): a feature card, a wide card (verbs, HUD), a narrow chooser. Concepts never restate these. */
export const CARD_W = 280;
export const CARD_W_WIDE = 320;
export const CARD_W_NARROW = 180;
/** Height a placed card is assumed to have until it is measured (useCardSize). */
export const CARD_FALLBACK_H = 160;

export interface PlaceOpts {
  /** The point the card hangs off (viewport-local pixels). */
  anchor: Pt;
  /** The card's size. */
  size: Box;
  /** The container the card must stay inside. */
  bounds: Box;
  /** Gap between the anchor and the card's nearest edge (default 14). */
  gap?: number;
  /** Which side of the anchor to try first (default "right"). */
  prefer?: "right" | "left" | "below" | "above";
  /** Keep this far from the container's edges (default 8). */
  margin?: number;
}

/** Top-left of the card: on the preferred side when it fits, else flipped, always clamped inside the bounds. */
export function placeCard(o: PlaceOpts): Pt {
  const gap = o.gap ?? 14, m = o.margin ?? 8, prefer = o.prefer ?? "right";
  const fitsRight = o.anchor.x + gap + o.size.w + m <= o.bounds.w;
  const fitsLeft = o.anchor.x - gap - o.size.w - m >= 0;
  const fitsBelow = o.anchor.y + gap + o.size.h + m <= o.bounds.h;
  const fitsAbove = o.anchor.y - gap - o.size.h - m >= 0;
  let x: number, y: number;
  if (prefer === "right" || prefer === "left") {
    const right = prefer === "right" ? fitsRight || !fitsLeft : !fitsLeft ? true : false;
    x = right ? o.anchor.x + gap : o.anchor.x - gap - o.size.w;
    y = o.anchor.y - 8;
  } else {
    const below = prefer === "below" ? fitsBelow || !fitsAbove : !fitsAbove ? true : false;
    y = below ? o.anchor.y + gap : o.anchor.y - gap - o.size.h;
    x = o.anchor.x - 8;
  }
  return clampInside({ x, y }, o.size, o.bounds, m);
}

export function clampInside(p: Pt, size: Box, bounds: Box, margin = 8): Pt {
  return {
    x: Math.max(margin, Math.min(bounds.w - size.w - margin, p.x)),
    y: Math.max(margin, Math.min(bounds.h - size.h - margin, p.y)),
  };
}

/** Offset a pin from its anchor along a fixed direction so it sits beside the geometry, not on it. */
export function pinOffset(anchor: Pt, dir: "ne" | "nw" | "se" | "sw", dist = 40): Pt {
  const sx = dir.endsWith("e") ? 1 : -1, sy = dir.startsWith("n") ? -1 : 1;
  return { x: anchor.x + sx * dist * 0.75, y: anchor.y + sy * dist * 0.75 };
}

/** Merge pins closer than `radius` into clusters (so an assembly's hundred pins read as a few badges). */
export function clusterPins<T extends { pos: Pt }>(pins: T[], radius: number): { pos: Pt; members: T[] }[] {
  const out: { pos: Pt; members: T[] }[] = [];
  for (const p of pins) {
    const near = out.find((c) => Math.hypot(c.pos.x - p.pos.x, c.pos.y - p.pos.y) < radius);
    if (near) {
      near.members.push(p);
      const n = near.members.length;
      near.pos = { x: near.pos.x + (p.pos.x - near.pos.x) / n, y: near.pos.y + (p.pos.y - near.pos.y) / n };
    } else out.push({ pos: { ...p.pos }, members: [p] });
  }
  return out;
}
