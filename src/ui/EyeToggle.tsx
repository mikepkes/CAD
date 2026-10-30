import { useStore } from "../model/store";

/** Show/hide one body (feature id), sketch, component or datum plane. Hidden is
 *  display-only and undoable; a hidden component hides everything inside it. */
export function EyeToggle({ id, label }: { id: string; label?: string }) {
  useStore((s) => s.rev);
  const hidden = useStore((s) => (s.session.doc.hidden ?? []).includes(id));
  const setVisibility = useStore((s) => s.setVisibility);
  return (
    <button
      className={`eye-btn ${hidden ? "off" : ""}`}
      title={`${hidden ? "Show" : "Hide"}${label ? ` ${label}` : ""}`}
      aria-pressed={!hidden}
      onClick={(e) => { e.stopPropagation(); void setVisibility([id], hidden); }}
    >{hidden ? "◌" : "◉"}</button>
  );
}
