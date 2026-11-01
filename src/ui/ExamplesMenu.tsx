// Open a bundled example: a menu beside Open (and on the first-run card). The
// examples are listed in model/examples.ts. Opening one replaces the document,
// so a document with work in it asks first (it is autosaved either way).

import { useEffect, useState } from "react";
import { useStore } from "../model/store";
import { EXAMPLES } from "../model/examples";
import { ask } from "./kit/askDialog";
import { Icon } from "./icons";

/** Open `name`, asking first when the current document has work in it. */
export async function openExampleAsking(name: string): Promise<void> {
  const st = useStore.getState();
  if (st.session.doc.operations.length) {
    const title = EXAMPLES.find((e) => e.name === name)?.title ?? name;
    const ok = await ask({ title: `Open ${title}?`, text: "The current document is replaced. It is autosaved in this browser or app only; save it to a file first if you want to keep it.", confirmLabel: "Open example" });
    if (!ok) return;
  }
  await st.openExample(name);
}

/** The list itself (a menu of examples), for the toolbar's menu and the first-run card. */
export function ExampleList(p: { onPick?: () => void }) {
  return (
    <div className="export-list examples-list" role="menu" aria-label="Examples">
      {EXAMPLES.map((e) => (
        <button key={e.name} role="menuitem" className="export-item" onClick={() => { p.onPick?.(); void openExampleAsking(e.name); }}>
          <b>{e.title}</b><span>{e.blurb}</span>
        </button>
      ))}
    </div>
  );
}

/** "Examples ▾": a menu button that drops the list. */
export function ExamplesMenu(p: { label?: string; className?: string } = {}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); setOpen(false); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  return (
    <span className="export-menu">
      <button className={p.className ?? "btn ghost with-icon"} aria-haspopup="menu" aria-expanded={open} title="Open one of the example models" onClick={() => setOpen((o) => !o)}>
        <Icon name="folder" />{p.label ?? "Examples"} ▾
      </button>
      {open && (
        <>
          <div className="export-scrim" onPointerDown={() => setOpen(false)} />
          <ExampleList onPick={() => setOpen(false)} />
        </>
      )}
    </span>
  );
}
