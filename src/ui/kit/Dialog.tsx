// Draws the open in-app question (askDialog.ts). Enter confirms, Escape or a press
// outside cancels; Escape is taken in the capture phase so the app's own Escape
// (deselect, close cards) doesn't also fire.

import { useEffect, useRef, useState } from "react";
import { useDialog } from "./askDialog";
import { Button } from "./primitives";

export function Dialog() {
  const req = useDialog((s) => s.current);
  const cancel = useDialog((s) => s.cancel);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!req) return;
    setValue(req.kind === "text" ? req.initial ?? "" : "");
    // focus after paint so the click that opened the dialog doesn't take it back
    const t = setTimeout(() => { if (req.kind === "text") inputRef.current?.select(); else okRef.current?.focus(); });
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); cancel(); } };
    window.addEventListener("keydown", onKey, true);
    return () => { clearTimeout(t); window.removeEventListener("keydown", onKey, true); };
  }, [req, cancel]);

  if (!req) return null;
  const confirm = () => { if (req.kind === "confirm") req.settle(true); else if (value.trim()) req.settle(value.trim()); };

  return (
    <div className="modal-backdrop" onPointerDown={cancel}>
      <form
        className="modal k-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={req.title}
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); confirm(); }}
      >
        <div className="modal-head"><span>{req.title}</span></div>
        <div className="modal-body">
          {req.text && <p className="k-dialog-text">{req.text}</p>}
          {req.kind === "text" && (
            <label className="k-dialog-field">
              {req.label && <span className="field-label">{req.label}</span>}
              <input ref={inputRef} className="field-input" aria-label={req.label ?? req.title} value={value} onChange={(e) => setValue(e.target.value)} />
            </label>
          )}
        </div>
        <div className="modal-foot k-dialog-foot">
          <Button ghost onClick={cancel}>Cancel</Button>
          <Button ref={okRef} type="submit" accent className={req.danger ? "k-danger" : undefined} disabled={req.kind === "text" && !value.trim()}>
            {req.confirmLabel ?? "OK"}
          </Button>
        </div>
      </form>
    </div>
  );
}
