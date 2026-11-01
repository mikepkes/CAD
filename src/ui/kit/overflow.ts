// Which items of a one-line row move into its "⋯" menu when the row is too
// narrow: the lowest priority first (later items first among equals), never a
// pinned one, until the rest and the menu button fit. Pure, tested in Node
// (test/overflow.test.ts); OverflowRow.tsx measures and templates it.

export interface FitItem {
  key: string;
  /** Measured width in px. */
  width: number;
  /** Higher stays in the row longer (default 0). */
  priority?: number;
  /** Never moves to the menu. */
  pin?: boolean;
  /** A flexible gap: takes no width of its own and never moves. */
  spacer?: boolean;
}

/** The keys that go into the menu so the row fits in `available` px (gap between items, the menu button `moreWidth`). */
export function fitItems(items: FitItem[], available: number, gap: number, moreWidth: number): Set<string> {
  const solid = items.filter((it) => !it.spacer);
  const total = (list: FitItem[]) => list.reduce((a, it) => a + it.width, 0) + gap * Math.max(0, list.length - 1);
  const hidden = new Set<string>();
  if (total(solid) <= available) return hidden;
  const budget = available - moreWidth - gap;
  const order = solid
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => !it.pin)
    .sort((a, b) => (a.it.priority ?? 0) - (b.it.priority ?? 0) || b.i - a.i);
  let used = total(solid);
  for (const { it } of order) {
    if (used <= budget) break;
    hidden.add(it.key);
    used -= it.width + gap;
  }
  return hidden;
}

/** Whether two hidden sets are the same (so a re-measure that changes nothing doesn't re-render). */
export function sameKeys(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}
