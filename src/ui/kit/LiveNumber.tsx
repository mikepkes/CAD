// A number in running text you can drag sideways, step with the arrow keys,
// or type into (Enter). All the arithmetic is in numberMath.ts.

import { useEffect, useRef, useState, KeyboardEvent, PointerEvent } from "react";
import { NumberSpec, formatValue, keyStep, parseTyped, scrubValue } from "./numberMath";

export interface LiveNumberProps {
  value: number;
  spec: NumberSpec;
  unit?: string;
  /** What the number is, for the accessible name ("wall thickness"). */
  name: string;
  /** Called with each new value while scrubbing and on every key step. */
  onChange: (v: number) => void;
  /** Called once when a drag or typed edit finishes (where the caller commits an undo step). */
  onCommit?: (v: number) => void;
  onHover?: (hot: boolean) => void;
  /** Externally driven highlight (the part is hovered). */
  hot?: boolean;
  /** Show the unit after the number (default true). */
  showUnit?: boolean;
}

export function LiveNumber(p: LiveNumberProps) {
  const [typing, setTyping] = useState<string | null>(null);
  const drag = useRef<{ x: number; v: number; moved: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isTyping = typing != null;
  useEffect(() => { if (isTyping) { inputRef.current?.focus(); inputRef.current?.select(); } }, [isTyping]);

  const onDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, v: p.value, moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
  };
  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const v = scrubValue(d.v, dx, p.spec, { coarse: e.shiftKey, fine: e.altKey });
    if (v !== p.value) p.onChange(v);
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) p.onCommit?.(p.value);
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter") { e.preventDefault(); setTyping(formatValue(p.value, p.spec)); return; }
    const v = keyStep(p.value, e.key, e.shiftKey, p.spec);
    if (v == null) return;
    e.preventDefault();
    if (v !== p.value) { p.onChange(v); p.onCommit?.(v); }
  };
  const finishTyping = (ok: boolean) => {
    if (typing == null) return;
    const v = ok ? parseTyped(typing, p.spec) : null;
    setTyping(null);
    if (v != null && v !== p.value) { p.onChange(v); p.onCommit?.(v); }
  };

  if (typing != null) {
    return (
      <input
        ref={inputRef}
        className="k-live-input"
        value={typing}
        aria-label={p.name}
        onChange={(e) => setTyping(e.target.value)}
        onBlur={() => finishTyping(true)}
        onKeyDown={(e) => { if (e.key === "Enter") finishTyping(true); else if (e.key === "Escape") finishTyping(false); e.stopPropagation(); }}
      />
    );
  }
  const text = formatValue(p.value, p.spec, p.showUnit === false ? "" : p.unit);
  return (
    <button
      type="button"
      className={`k-live${p.hot ? " hot" : ""}`}
      aria-label={`${p.name}, ${formatValue(p.value, p.spec, p.unit)}. Drag sideways, use the arrow keys, or press Enter to type.`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey}
      onMouseEnter={() => p.onHover?.(true)}
      onMouseLeave={() => p.onHover?.(false)}
      onClick={(e) => { if (drag.current?.moved) e.preventDefault(); }}
    >
      {text}
    </button>
  );
}
