// The action ring overlay: eight hotkey actions around the pointer. Hold the
// ring key (Space), point, release to run; tap it to leave the ring open and
// click a slot; or right-click the viewport in model mode (opens it sticky).
// A thin template: the slots are resolveRing over the active hotkey contexts
// (src/model/ring.ts), labels and key handling come from ./ringView, and a
// slot only ever runs through hotkeys.runAction.

import { useCallback, useEffect, useReducer, useRef, useState, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { hotkeys, eventToKey } from "../../../model/hotkeys";
import { useRing, resolveRing, slotAt, slotOffset, clampCentre, releaseOutcome } from "../../../model/ring";
import { CONTEXT_LABELS, isContextId } from "../../../model/contexts";
import { RING_R, RING_PAD, DEAD_ZONE, SlotView, slotViews, ringKeys, releasesRingKey, digitSlot, arrowDir, moveHighlight } from "./ringView";
import "./ring.css";

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const centreOf = (at: { x: number; y: number }) => clampCentre(at, RING_R, RING_PAD, { w: window.innerWidth, h: window.innerHeight });
const swallow = (e: Event) => { e.preventDefault(); e.stopPropagation(); };

/** Mount once (it portals into document.body); renders only while useRing.open. */
export function RingOverlay() {
  const open = useRing((s) => s.open);
  const at = useRing((s) => s.at);
  const overrides = useRing((s) => s.overrides);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [hi, setHi] = useState<number | null>(null);

  // Contexts, bindings and `when` guards live in the hotkey manager: re-read on its changes.
  useEffect(() => hotkeys.subscribe(bump), []);

  const stack = hotkeys.getContexts().filter(isContextId);
  const slots = slotViews(resolveRing(stack, overrides), hotkeys);
  const top = stack[stack.length - 1] ?? "global";

  // The window listeners outlive renders; they read the latest slots and highlight from refs.
  const slotsRef = useRef<SlotView[]>(slots);
  slotsRef.current = slots;
  const hiRef = useRef(hi);
  hiRef.current = hi;
  /** The ring key went down while the ring was closed: its key-up decides run / stay / close. */
  const armed = useRef(false);

  useEffect(() => { if (open) setHi(null); }, [open]);

  /** Run slot `i` if it can run now; the ring closes first so the action may open other surfaces. */
  const run = useCallback((i: number): boolean => {
    const id = slotsRef.current[i]?.actionId;
    if (!id || !hotkeys.can(id)) return false;
    useRing.getState().close();
    hotkeys.runAction(id);
    return true;
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const p = { x: e.clientX, y: e.clientY };
      const ring = useRing.getState();
      ring.setPointer(p); // where the ring opens next, even while closed
      if (ring.open) {
        const c = centreOf(ring.at);
        setHi(slotAt(p.x - c.x, p.y - c.y, DEAD_ZONE));
      }
    };
    // Capture phase on window: ahead of the hotkey manager, so Escape / digits /
    // a held ring key never also reach the global actions.
    const onKeyDown = (e: KeyboardEvent) => {
      const key = eventToKey(e);
      const ring = useRing.getState();
      const isRingKey = ringKeys(hotkeys).includes(key);
      if (isRingKey && e.repeat) { swallow(e); return; } // a held key never re-opens or toggles
      if (!ring.open) { if (isRingKey) armed.current = true; return; }
      if (isRingKey) { swallow(e); armed.current = false; ring.close(); return; } // a fresh press closes a ring left open
      if (key === "escape") { swallow(e); armed.current = false; ring.close(); return; }
      const d = digitSlot(key);
      if (d != null) { swallow(e); run(d); return; }
      const dir = arrowDir(key);
      if (dir) { swallow(e); setHi((h) => moveHighlight(h, dir)); return; }
      if (key === "enter") { swallow(e); if (hiRef.current != null) run(hiRef.current); }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!armed.current || !releasesRingKey(eventToKey(e), ringKeys(hotkeys))) return;
      armed.current = false;
      const ring = useRing.getState();
      if (!ring.open) return;
      swallow(e); // no button activation / scroll from the released Space
      const h = hiRef.current;
      const pointed = h != null && slotsRef.current[h]?.actionId && hotkeys.can(slotsRef.current[h].actionId!) ? h : null;
      const out = releaseOutcome(now() - ring.openedAt, pointed);
      if (out === "run") run(pointed!);
      else if (out === "close") ring.close();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [run]);

  if (!open) return null;
  const c = centreOf(at);
  const context = CONTEXT_LABELS[top];
  const onScrimDown = (e: ReactPointerEvent) => { if (e.target === e.currentTarget) useRing.getState().close(); };
  const onScrimMenu = (e: ReactMouseEvent) => { e.preventDefault(); if (e.target === e.currentTarget) useRing.getState().close(); };

  return createPortal(
    <div className="ring-scrim" onPointerDown={onScrimDown} onContextMenu={onScrimMenu}>
      <div className="ring" role="menu" aria-label={`Action ring: ${context}`} style={{ left: c.x, top: c.y }}>
        <div className="ring-track" style={{ width: 2 * RING_R, height: 2 * RING_R }} aria-hidden="true" />
        <div className="ring-centre" aria-hidden="true">
          <span className="k-label ring-context">{context}</span>
          <span className="k-dim ring-hint">configure in ⌨</span>
        </div>
        {slots.map((s) => {
          const o = slotOffset(s.index, RING_R);
          if (!s.actionId) return <span key={s.index} className="ring-dot" style={{ left: o.x, top: o.y }} aria-hidden="true" />;
          return (
            <button
              key={s.index}
              type="button"
              role="menuitem"
              className={`k-btn sm ring-slot${s.index === hi ? " accent" : ""}`}
              style={{ left: o.x, top: o.y }}
              disabled={!s.enabled}
              aria-disabled={!s.enabled}
              aria-label={s.key ? `${s.title} (${s.key})` : s.title}
              title={`${s.title}${s.from ? ` · ${CONTEXT_LABELS[s.from]}` : ""} · ${s.index + 1}`}
              onClick={() => run(s.index)}
            >
              <span className="ring-label">{s.label}</span>
              {s.key && <span className="k-num k-dim ring-key">{s.key}</span>}
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
