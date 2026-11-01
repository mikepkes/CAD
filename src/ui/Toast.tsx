// The transient message at the bottom of the view (the store's `toast`). It
// lives in a live region that is always on the page, so a screen reader reads
// each message as it appears (errors assertively), and goes after four seconds
// or a click.

import { useEffect } from "react";
import { useStore } from "../model/store";

export function Toast() {
  const toast = useStore((s) => s.toast);
  const dismiss = useStore((s) => s.dismissToast);
  useEffect(() => {
    if (toast) {
      // a toast that offers a way forward stays long enough to take it
      const t = setTimeout(dismiss, toast.action ? 10000 : 4000);
      return () => clearTimeout(t);
    }
  }, [toast, dismiss]);
  return (
    <div className="toast-region" role="status" aria-live="polite" aria-atomic="true">
      {toast && (
        <div className={`toast ${toast.kind}`} role={toast.kind === "error" ? "alert" : undefined} onClick={dismiss}>
          {toast.text}
          {toast.action && (
            <span className="toast-actions">
              <button className="btn primary" onClick={(e) => { e.stopPropagation(); toast.action!.run(); }}>{toast.action.label}</button>
              <button className="btn ghost" onClick={(e) => { e.stopPropagation(); dismiss(); }}>Cancel</button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
