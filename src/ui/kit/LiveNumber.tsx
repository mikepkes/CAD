// A number in running text you can drag sideways, step with the arrow keys, or
// type into: a click without dragging, Enter, or just typing a digit starts
// typing. A typed value outside the number's limits isn't clamped silently: the
// field stays open and says what the limits are. A typed expression (w*2) goes
// to `onExpression` when the caller stores expressions. All the arithmetic is in
// numberMath.ts.

import { useEffect, useRef, useState, KeyboardEvent, PointerEvent } from "react";
import { NumberSpec, formatValue, keyStep, limitsText, parseTyped, scrubValue, typedProblem } from "./numberMath";

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
  /** A typed expression that isn't a plain number ("width*2"): the caller stores it as is. Without this, only
   *  numbers are accepted. */
  onExpression?: (text: string) => void;
  onHover?: (hot: boolean) => void;
  /** Externally driven highlight (the part is hovered). */
  hot?: boolean;
  /** Show the unit after the number (default true). */
  showUnit?: boolean;
}

/** A key that starts typing on a focused number: a digit, a sign, a point, a bracket, or a letter (a parameter name)
 *  when expressions are taken. */
const startsTyping = (key: string, expressions: boolean) => /^[0-9.\-+(]$/.test(key) || (expressions && /^[A-Za-z_]$/.test(key));

export function LiveNumber(p: LiveNumberProps) {
  const [typing, setTyping] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // the spec is frozen for the drag: a caller whose step depends on the live value must not change the scale mid-scrub
  const drag = useRef<{ x: number; v: number; spec: NumberSpec; moved: boolean; last?: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Typing began with a key press: keep the caret after it rather than selecting the text. */
  const fromKey = useRef(false);
  const isTyping = typing != null;
  useEffect(() => {
    if (!isTyping) return;
    const el = inputRef.current;
    el?.focus();
    if (fromKey.current) { const n = el?.value.length ?? 0; el?.setSelectionRange(n, n); } else el?.select();
  }, [isTyping]);

  /** Whether the field is open, read synchronously (a blur that follows Enter must not take the value twice). */
  const open = useRef(false);
  const startTyping = (text: string, byKey = false) => { fromKey.current = byKey; open.current = true; setProblem(null); setTyping(text); };
  const close = () => { open.current = false; setProblem(null); setTyping(null); };

  const onDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, v: p.value, spec: p.spec, moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
  };
  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const v = scrubValue(d.v, dx, d.spec, { coarse: e.shiftKey, fine: e.altKey });
    d.last = v;
    if (v !== p.value) p.onChange(v);
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    // commit the last scrubbed value, not the displayed prop: a live edit may still be in flight
    if (d.moved) p.onCommit?.(d.last ?? p.value);
    // a click without dragging types into it
    else startTyping(formatValue(p.value, p.spec).replace(/,/g, ""));
  };
  const onCancelDrag = () => { const d = drag.current; drag.current = null; if (d?.moved) p.onCommit?.(d.last ?? p.value); };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter") { e.preventDefault(); startTyping(formatValue(p.value, p.spec).replace(/,/g, "")); return; }
    if (!e.metaKey && !e.ctrlKey && !e.altKey && startsTyping(e.key, !!p.onExpression)) {
      e.preventDefault(); e.stopPropagation(); // the key is the first character, not a hotkey
      startTyping(e.key, true);
      return;
    }
    const v = keyStep(p.value, e.key, e.shiftKey, p.spec);
    if (v == null) return;
    e.preventDefault();
    if (v !== p.value) { p.onChange(v); p.onCommit?.(v); }
  };
  /** Take what was typed: a number within the limits, else an expression when the caller takes them. Returns
   *  whether the field may close (false keeps it open, saying why). */
  const take = (text: string): boolean => {
    const v = parseTyped(text, p.spec);
    if (v != null) {
      const why = typedProblem(v, p.spec, p.unit);
      if (why) { setProblem(why); return false; }
      if (v !== p.value) { p.onChange(v); p.onCommit?.(v); }
      return true;
    }
    if (p.onExpression && text.trim()) { p.onExpression(text.trim()); return true; }
    setProblem(p.onExpression ? "Type a number or an expression" : "Type a number");
    return false;
  };
  const finishTyping = (ok: boolean) => {
    if (typing == null || !open.current) return;
    if (ok && !take(typing)) return;
    close();
  };

  if (typing != null) {
    return (
      <span className="k-live-edit">
        <input
          ref={inputRef}
          className={`k-live-input${problem ? " bad" : ""}`}
          value={typing}
          aria-label={p.name}
          aria-invalid={problem ? true : undefined}
          title={limitsText(p.spec, p.unit) ?? undefined}
          onChange={(e) => { setTyping(e.target.value); if (problem) setProblem(null); }}
          // leaving the field takes a good value; one it can't take puts the old one back rather than keeping a bad one
          onBlur={() => { if (!open.current) return; take(typing); close(); }}
          onKeyDown={(e) => { if (e.key === "Enter") finishTyping(true); else if (e.key === "Escape") finishTyping(false); e.stopPropagation(); }}
        />
        {problem && <span className="k-live-problem" role="alert">{problem}</span>}
      </span>
    );
  }
  const text = formatValue(p.value, p.spec, p.showUnit === false ? "" : p.unit);
  const limits = limitsText(p.spec, p.unit);
  return (
    <button
      type="button"
      className={`k-live${p.hot ? " hot" : ""}`}
      aria-label={`${p.name}, ${formatValue(p.value, p.spec, p.unit)}. Click or type to edit, drag sideways, or use the arrow keys.`}
      title={limits ? `Click to type, drag to change. ${limits}` : "Click to type, drag to change"}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancelDrag}
      onKeyDown={onKey}
      onMouseEnter={() => p.onHover?.(true)}
      onMouseLeave={() => p.onHover?.(false)}
      onClick={(e) => { if (drag.current?.moved) e.preventDefault(); }}
    >
      {text}
    </button>
  );
}
