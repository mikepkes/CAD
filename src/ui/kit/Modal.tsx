// The one modal every dialog is built on (Settings, Keyboard shortcuts, the shop
// drawing, the in-app question). It is a real dialog to assistive technology
// (role="dialog", aria-modal, named by its own heading), moves focus into
// itself when it opens, keeps Tab inside, hands focus back to whatever had it
// when it closes, closes on Escape (only the topmost one, and the app's own
// Escape doesn't also run), and fits the window: the head and foot stay put and
// the body scrolls (.modal in styles.css).

import { FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject, useEffect, useId, useRef } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The focusable elements inside `root`, in tab order (visible ones only, where layout says so). */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[inert]") && el.getAttribute("aria-hidden") !== "true");
}

// ---- the open modals, topmost last: only the top one answers Escape ----
interface Entry { id: symbol; escape: () => boolean }
const stack: Entry[] = [];
let listening = false;
function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  const top = stack[stack.length - 1];
  if (!top) return;
  if (!top.escape()) return; // this modal handles Escape itself right now (a key being captured, say)
  e.preventDefault();
  e.stopImmediatePropagation();
}
function push(entry: Entry): () => void {
  stack.push(entry);
  if (!listening) { window.addEventListener("keydown", onKey, true); listening = true; }
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    if (!stack.length && listening) { window.removeEventListener("keydown", onKey, true); listening = false; }
  };
}
/** Whether any modal is open (other overlays leave Escape to it). */
export const modalOpen = (): boolean => stack.length > 0;

export interface ModalProps {
  /** The heading; it names the dialog. */
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Extra class on the dialog box (e.g. "hk-modal", "drawing-view"). */
  className?: string;
  /** Controls in the head row, before the close button. */
  actions?: ReactNode;
  /** Where focus goes when it opens (default: the first focusable control in the body, else the dialog). */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Escape closes it (default). False while the dialog uses Escape itself (cancelling a key capture). */
  closeOnEscape?: boolean;
  /** Pressing outside closes it (default). */
  closeOnBackdrop?: boolean;
  /** No ✕ in the head (a question that must be answered by its buttons). */
  hideClose?: boolean;
  /** Render the box as a form (Enter submits). */
  onSubmit?: (e: FormEvent) => void;
  /** Accessible description: the id of an element inside. */
  describedBy?: string;
}

export function Modal(p: ModalProps) {
  const titleId = useId();
  const box = useRef<HTMLElement | null>(null);
  const props = useRef(p);
  props.current = p;

  // Escape (topmost only), initial focus, and focus handed back on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const pop = push({ id: Symbol("modal"), escape: () => { if (props.current.closeOnEscape === false) return false; props.current.onClose(); return true; } });
    // after paint, so the click that opened the dialog doesn't take focus back
    const t = setTimeout(() => {
      const root = box.current;
      if (!root || root.contains(document.activeElement)) return;
      const want = props.current.initialFocus?.current;
      const body = root.querySelector<HTMLElement>(".modal-body") ?? root;
      const first = want ?? focusables(body)[0] ?? focusables(root)[0];
      (first ?? root).focus();
      if (want) want.scrollIntoView?.({ block: "center" });
    });
    return () => {
      clearTimeout(t);
      pop();
      // back to where focus was, if that is still on the page (and nothing else took it)
      if (opener && opener.isConnected && (document.activeElement === document.body || !document.activeElement || box.current?.contains(document.activeElement))) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  // Tab and Shift+Tab cycle inside the dialog.
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab" || !box.current) return;
    const list = focusables(box.current);
    if (!list.length) { e.preventDefault(); box.current.focus(); return; }
    const first = list[0], last = list[list.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === box.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    else if (!box.current.contains(at)) { e.preventDefault(); first.focus(); }
  };

  const common = {
    className: `modal ${p.className ?? ""}`.trim(),
    role: "dialog",
    "aria-modal": true,
    "aria-labelledby": titleId,
    "aria-describedby": p.describedBy,
    tabIndex: -1,
    onKeyDown,
    onPointerDown: (e: ReactPointerEvent) => e.stopPropagation(),
  } as const;
  const inner = (
    <>
      <div className="modal-head">
        <h2 className="modal-title" id={titleId}>{p.title}</h2>
        {p.actions && <div className="modal-actions">{p.actions}</div>}
        {!p.hideClose && <button type="button" className="icon-btn modal-close" aria-label="Close" title="Close (Esc)" onClick={p.onClose}>✕</button>}
      </div>
      {p.children}
    </>
  );
  return (
    <div className="modal-backdrop" onPointerDown={() => { if (p.closeOnBackdrop !== false) p.onClose(); }}>
      {p.onSubmit
        ? <form {...common} ref={(el) => { box.current = el; }} onSubmit={p.onSubmit}>{inner}</form>
        : <div {...common} ref={(el) => { box.current = el; }}>{inner}</div>}
    </div>
  );
}
