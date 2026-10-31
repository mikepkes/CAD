// The lens on screen: a ring with a handle, or a wipe line with a handle,
// drawn as SVG over the viewport. Dragging (pointer capture) or the arrow
// keys move it; the arithmetic is lens.ts's dragTo / arrowDelta.

import { useRef, useState, KeyboardEvent, PointerEvent } from "react";
import { arrowDelta, dragTo, handlePos, type LensFrame as Frame } from "./lens";

export interface LensFrameProps {
  frame: Frame;
  /** The viewport's client rect (local bounds plus where it sits in the window). */
  rect: { left: number; top: number; w: number; h: number };
  onMove: (p: { x: number; y: number; wipeX: number }) => void;
}

export function LensFrame(p: LensFrameProps) {
  const drag = useRef<{ grab: { x: number; y: number }; frame: Frame } | null>(null);
  const [dragging, setDragging] = useState(false);
  const bounds = { w: p.rect.w, h: p.rect.h };
  const local = (e: { clientX: number; clientY: number }) => ({ x: e.clientX - p.rect.left, y: e.clientY - p.rect.top });

  const onDown = (e: PointerEvent<SVGElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = { grab: local(e), frame: p.frame };
    setDragging(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* jsdom / older browsers */ }
  };
  const onMoveP = (e: PointerEvent<SVGElement>) => {
    const d = drag.current;
    if (!d) return;
    p.onMove(dragTo(d.frame, d.grab, local(e), bounds));
  };
  const onUp = () => { drag.current = null; setDragging(false); };
  const onKey = (e: KeyboardEvent<SVGElement>) => {
    const d = arrowDelta(e.key, e.shiftKey ? 50 : 10);
    if (!d) return;
    e.preventDefault();
    p.onMove(dragTo(p.frame, { x: 0, y: 0 }, d, bounds));
  };

  const h = handlePos(p.frame, bounds);
  const dragProps = { onPointerDown: onDown, onPointerMove: onMoveP, onPointerUp: onUp, onPointerCancel: onUp };
  const cls = dragging ? " dragging" : "";
  return (
    <svg className="lens-frame" width={bounds.w} height={bounds.h} aria-hidden={false}>
      {p.frame.shape === "lens"
        ? <circle className={"lens-ring" + cls} cx={p.frame.x} cy={p.frame.y} r={p.frame.r} data-testid="lens-ring" {...dragProps} />
        : <line className={"lens-wipe" + cls} x1={p.frame.wipeX} y1={0} x2={p.frame.wipeX} y2={bounds.h} data-testid="lens-wipe" {...dragProps} />}
      <circle
        className={"lens-handle" + cls}
        cx={h.x} cy={h.y} r={7}
        role="button" tabIndex={0}
        aria-label={p.frame.shape === "lens" ? "Move the lens" : "Move the wipe"}
        onKeyDown={onKey}
        {...dragProps}
      />
    </svg>
  );
}
