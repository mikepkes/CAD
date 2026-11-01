// A one-line row that never wraps: items that don't fit move, lowest priority
// first, into a "⋯" menu at its end (fitItems in overflow.ts decides which).
// The toolbar and the panel switches use it, so neither grows a second row
// and moves the view. Each item is rendered once: in the row, or (while the
// menu is open) in the menu.

import { CSSProperties, ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fitItems, sameKeys } from "./overflow";

export interface OverflowRowItem {
  key: string;
  node: ReactNode;
  /** Higher stays in the row longer (default 0). */
  priority?: number;
  /** Never moves to the menu. */
  pin?: boolean;
  /** A flexible gap (pushes what follows to the end). */
  spacer?: boolean;
  /** What the menu shows instead of `node`. */
  menuNode?: ReactNode;
}

export interface OverflowRowProps {
  items: OverflowRowItem[];
  className?: string;
  role?: string;
  ariaLabel?: string;
  /** The menu button's accessible name (default "More"). */
  moreLabel?: string;
  style?: CSSProperties;
}

const MORE_FALLBACK = 40;

export function OverflowRow(p: OverflowRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const widths = useRef(new Map<string, number>());
  const moreRef = useRef<HTMLSpanElement>(null);
  const moreWidth = useRef(MORE_FALLBACK);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);

  // re-fit when the row is resized
  useEffect(() => {
    const el = rowRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    for (const it of p.items) {
      const el = itemRefs.current.get(it.key);
      if (el && !hidden.has(it.key) && !it.spacer) widths.current.set(it.key, el.offsetWidth);
    }
    if (moreRef.current?.offsetWidth) moreWidth.current = moreRef.current.offsetWidth;
    const cs = getComputedStyle(row);
    const gap = parseFloat(cs.columnGap) || 0;
    const available = row.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    if (available <= 0) return; // not laid out (jsdom, a hidden panel)
    const next = fitItems(p.items.map((it) => ({ key: it.key, width: widths.current.get(it.key) ?? 0, priority: it.priority, pin: it.pin, spacer: it.spacer })), available, gap, moreWidth.current);
    if (!sameKeys(next, hidden)) setHidden(next);
  });
  void tick;

  // the menu closes on a click outside it, on Escape, and once one of its commands has run
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!moreRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", onDown, true); window.removeEventListener("keydown", onKey, true); };
  }, [open]);
  useEffect(() => { if (open && hidden.size === 0) setOpen(false); }, [open, hidden]);

  const inMenu = p.items.filter((it) => hidden.has(it.key));
  return (
    <div ref={rowRef} className={`k-ovf${p.className ? ` ${p.className}` : ""}`} role={p.role} aria-label={p.ariaLabel} style={p.style}>
      {p.items.map((it) =>
        it.spacer ? <span key={it.key} className="k-ovf-spacer" /> : (
          <span
            key={it.key}
            className="k-ovf-item"
            data-ovf={it.key}
            hidden={hidden.has(it.key) || undefined}
            ref={(el) => { if (el) itemRefs.current.set(it.key, el); else itemRefs.current.delete(it.key); }}
          >
            {hidden.has(it.key) ? null : it.node}
          </span>
        ))}
      {inMenu.length > 0 && (
        <span ref={moreRef} className="k-ovf-more">
          <button type="button" className="k-ovf-more-btn" aria-haspopup="menu" aria-expanded={open} aria-label={p.moreLabel ?? "More"}
            title={`${inMenu.length} more`} onClick={() => setOpen((o) => !o)}>
            ⋯<span className="k-ovf-count">{inMenu.length}</span>
          </button>
          {open && (
            <div className="k-ovf-menu" role="menu" aria-label={p.moreLabel ?? "More"}
              // on the way back up (bubbling), after the command's own handler: closing on the way down unmounts
              // the menu before a real click reaches its button (React re-renders between the two phases)
              onClick={(e) => { const t = e.target as HTMLElement; if (t.closest("button:not([aria-haspopup]), [role=menuitem]") && !t.closest("label")) setOpen(false); }}>
              {inMenu.map((it) => <div key={it.key} className="k-ovf-menu-item" data-ovf={it.key}>{it.menuNode ?? it.node}</div>)}
            </div>
          )}
        </span>
      )}
    </div>
  );
}
