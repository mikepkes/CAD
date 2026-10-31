// The intent line: a palette where you type what you want ("wall 5", "front",
// "back to 2", "mass <= 120") and the ranked suggestions run through the same
// store commands as every other surface. A thin template: the grammar is in
// intent.ts, the action→store mapping in execute.ts.

import { useCallback, useEffect, useMemo, useRef, useState, KeyboardEvent } from "react";
import { useStore } from "../../../model/store";
import { hotkeys, prettyKey } from "../../../model/hotkeys";
import { useUi } from "../../../model/concepts/uiState";
import { useIntents } from "../../../model/concepts/intentsStore";
import { Button, Card } from "../../kit/primitives";
import { useFeatureRows } from "../../kit/useFeatureRows";
import { MAX_SUGGESTIONS, Suggestion, buildCtx, moveSelection, resolve } from "./intent";
import { execute, Executor } from "./execute";
import "./intent.css";

/** Id of the hotkey action that opens the palette (⌘K / Ctrl+K, or "/"). */
export const OPEN_ACTION_ID = "intent.open";

const PLACEHOLDER = "wall 5 · front · back to 2 · measure hole · mass <= 120";

export function IntentLine() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const session = useStore((s) => s.session);
  const rev = useStore((s) => s.rev);
  const mode = useStore((s) => s.mode);
  const rows = useFeatureRows();
  const intents = useIntents((s) => s.intents);

  // ---- open from the hotkey manager (⌘K, "/") and from the ⌘K button ----
  useEffect(() => hotkeys.register({
    id: OPEN_ACTION_ID, label: "Intent line", context: "global", defaultPrimary: "mod+k", defaultSecondary: "/",
    run: () => { setText(""); setSel(0); setOpen(true); },
  }), []);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  const close = useCallback(() => setOpen(false), []);

  // ---- what the resolver can see (the hotkey contexts depend on the mode and on what is mounted, so re-read on open) ----
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ctx = useMemo(() => buildCtx(session, rows, hotkeys.describe().contexts, intents), [session, rev, rows, mode, intents, open]);
  const suggestions = useMemo(() => (open ? resolve(text, ctx) : []), [open, text, ctx]);
  const selected = Math.min(sel, Math.max(0, suggestions.length - 1));

  // ---- run: every route ends in the store ----
  const run = useCallback(async (s: Suggestion) => {
    const st = useStore.getState();
    const x: Executor = {
      setParameterExpr: st.setParameterExpr, editOperation: st.editOperation, moveRollback: st.moveRollback, suppressOperation: st.suppressOperation,
      undo: st.undo, redo: st.redo,
      fire: (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail })),
      runAction: (id) => hotkeys.runAction(id),
      setOpenFeature: useUi.getState().setOpenFeature,
      togglePanel: (p) => useUi.getState().togglePanel(p),
      addIntent: (text, label) => useIntents.getState().add(text, label),
    };
    setOpen(false);
    try {
      await execute(s.action, x);
      useStore.getState().setMessage(s.message);
    } catch (e) {
      useStore.getState().setMessage(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel(moveSelection(selected, 1, suggestions.length)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel(moveSelection(selected, -1, suggestions.length)); }
    else if (e.key === "Enter") { e.preventDefault(); const s = suggestions[selected]; if (s) void run(s); }
  };

  if (!open) return null;
  const listId = "intent-options";
  return (
    <div className="intent-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <Card at={{ x: 0, y: 0 }} className="intent-card" role="dialog" ariaLabel="Intent line">
        <input
          ref={inputRef}
          className="k-input lg k-mono intent-input"
          role="combobox"
          aria-label="What do you want?"
          aria-expanded={suggestions.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={suggestions[selected]?.id}
          autoComplete="off"
          spellCheck={false}
          placeholder={PLACEHOLDER}
          value={text}
          onChange={(e) => { setText(e.target.value); setSel(0); }}
          onKeyDown={onKey}
        />
        <ul id={listId} className="intent-list" role="listbox" aria-label="Suggestions">
          {suggestions.length === 0 && text.trim() && <li className="intent-empty k-dim">Nothing matches — try a feature, a parameter, a view or a hotkey.</li>}
          {suggestions.slice(0, MAX_SUGGESTIONS).map((s, i) => (
            <li
              key={s.id}
              id={s.id}
              role="option"
              aria-selected={i === selected}
              className={`intent-option${i === selected ? " on" : ""}`}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void run(s)}
            >
              <span className="k-label intent-kind">{s.kind}</span>
              <span className="intent-label">{s.label}</span>
              <span className="k-dim intent-detail">{s.detail}</span>
            </li>
          ))}
        </ul>
        <div className="intent-hint k-dim k-num">↑↓ choose · Enter run · Esc close</div>
      </Card>
    </div>
  );
}

/** A small "⌘K" button the integrator can place in the toolbar; it opens the palette through the hotkey action. */
export function IntentButton(p: { size?: "sm" | "md" | "lg" }) {
  return (
    <Button size={p.size ?? "sm"} ghost title="Intent line: type what you want" ariaLabel="Open the intent line" onClick={() => hotkeys.runAction(OPEN_ACTION_ID)}>
      <span className="k-num">{prettyKey("mod+k")}</span>
    </Button>
  );
}
