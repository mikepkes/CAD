import { useEffect, useReducer, useState } from "react";
import { useStore } from "../model/store";
import { hotkeys, eventToKey, prettyKey } from "../core/hotkeys";

type Capture = { id: string; slot: "primary" | "secondary" } | null;

export function HotkeyPanel() {
  const open = useStore((s) => s.hotkeysOpen);
  const close = () => useStore.getState().setHotkeysOpen(false);
  const [, bump] = useReducer((x) => x + 1, 0);
  const [capturing, setCapturing] = useState<Capture>(null);

  // Re-render whenever bindings / contexts change.
  useEffect(() => hotkeys.subscribe(bump), []);

  // While capturing a new binding, swallow the key so it rebinds instead of firing.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") { setCapturing(null); return; }
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return; // wait for the real key
      hotkeys.setBinding(capturing.id, capturing.slot, eventToKey(e));
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [capturing]);

  if (!open) return null;
  const { contexts, conflicts } = hotkeys.describe();
  const conflictKeys = new Set(conflicts.flatMap((c) => c.actionIds.map((id) => `${c.context}:${id}:${c.key}`)));
  const isConflict = (ctx: string, id: string, key: string | null) => !!key && conflictKeys.has(`${ctx}:${id}:${key}`);

  const cell = (ctx: string, id: string, slot: "primary" | "secondary", key: string | null) => {
    const cap = capturing && capturing.id === id && capturing.slot === slot;
    return (
      <span className="hk-cell">
        <button
          className={`hk-key ${cap ? "capturing" : ""} ${isConflict(ctx, id, key) ? "conflict" : ""}`}
          title={cap ? "Press a key… (Esc to cancel)" : "Click to rebind"}
          onClick={() => setCapturing({ id, slot })}
        >
          {cap ? "press…" : prettyKey(key)}
        </button>
        {key && !cap && (
          <button className="hk-clear" title="Clear binding" onClick={() => hotkeys.setBinding(id, slot, null)}>×</button>
        )}
      </span>
    );
  };

  return (
    <div className="modal-backdrop" onPointerDown={close}>
      <div className="modal hk-modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>Keyboard shortcuts</span>
          <button className="icon-btn" onClick={close}>✕</button>
        </div>
        <div className="modal-body">
          <p className="field-note">
            Contexts stack top-down — a higher (active) context overrides the same key below it.
            Conflicts only matter within one context. Click a key to rebind, × to clear.
          </p>
          {conflicts.length > 0 && (
            <p className="hk-warn">⚠ {conflicts.length} conflict{conflicts.length === 1 ? "" : "s"} within a context (highlighted below).</p>
          )}
          {contexts.map((c) => (
            <div key={c.context} className="hk-context">
              <div className="hk-context-head">
                <span className={`hk-ctx-name ${c.active ? "active" : ""}`}>{c.context}</span>
                {c.active ? <span className="hk-badge">active</span> : <span className="hk-badge off">inactive</span>}
              </div>
              <div className="hk-rows">
                <div className="hk-row hk-row-head">
                  <span>Command</span><span>Primary</span><span>Secondary</span>
                </div>
                {c.actions.map((a) => (
                  <div key={a.id} className="hk-row">
                    <span className="hk-label">{a.label}{a.customized && <em className="hk-custom" title="Customized"> ·</em>}</span>
                    {cell(c.context, a.id, "primary", a.primary)}
                    {cell(c.context, a.id, "secondary", a.secondary)}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={() => hotkeys.resetAll()}>Reset all to defaults</button>
          <button className="btn primary" onClick={close}>Done</button>
        </div>
      </div>
    </div>
  );
}
