// The organizational-assist inbox in the status bar: a quiet count of what is
// waiting for a name, opening a small card to accept a suggested name, type
// another, or dismiss; and the last few names the agent gave, each renamable.
// Logic lives in model/assist.ts and model/assistController.ts.

import { useEffect, useState } from "react";
import { modalOpen } from "./kit/Modal";
import { useStore } from "../model/store";
import { useAssist, nameWithAgent, resolveAssist } from "../model/assistController";
import { inboxSections, suggestName, currentName, type AssistItem } from "../model/assist";
import { Button, Card, Input } from "./kit/primitives";
import "./assist.css";

function PendingRow({ item }: { item: AssistItem }) {
  const doc = useStore((s) => s.session.doc);
  const [draft, setDraft] = useState(() => suggestName(doc, item));
  const kind = item.targetKind === "sketch" ? "Sketch" : "Feature";
  return (
    <form className="assist-row" aria-label={`Name ${item.from}`} onSubmit={(e) => { e.preventDefault(); void resolveAssist({ id: item.id, name: draft }); }}>
      <span className="assist-from k-dim" title={`${kind} ${item.target}`}>{item.from}</span>
      <Input value={draft} onChange={setDraft} ariaLabel={`New name for ${item.from}`} />
      <Button size="sm" type="submit" disabled={!draft.trim()} ariaLabel={`Accept name for ${item.from}`}>✓</Button>
      <Button size="sm" ghost ariaLabel={`Dismiss ${item.from}`} title="Keep the name as it is" onClick={() => void resolveAssist({ id: item.id, dismiss: true })}>×</Button>
      {item.error && <span className="assist-note k-dim">{item.error}</span>}
    </form>
  );
}

function RecentRow({ item }: { item: AssistItem }) {
  const doc = useStore((s) => s.session.doc);
  const [editing, setEditing] = useState(false);
  const now = currentName(doc, item.target) ?? item.name ?? "";
  const [draft, setDraft] = useState(now);
  if (editing) {
    return (
      <form className="assist-row" aria-label={`Rename ${now}`} onSubmit={(e) => { e.preventDefault(); void resolveAssist({ id: item.id, name: draft }).then(() => setEditing(false)); }}>
        <span className="assist-from k-dim">{item.from}</span>
        <Input value={draft} onChange={setDraft} ariaLabel={`New name for ${now}`} />
        <Button size="sm" type="submit" disabled={!draft.trim()} ariaLabel={`Save name for ${now}`}>✓</Button>
        <Button size="sm" ghost ariaLabel="Cancel" onClick={() => setEditing(false)}>×</Button>
      </form>
    );
  }
  return (
    <div className="assist-row">
      <span className="assist-from k-dim">{item.from} →</span>
      <span className="assist-name">{now}</span>
      <span className="k-dim assist-by">{item.by === "agent" ? "Claude" : item.by === "external" ? "agent" : "you"}</span>
      <Button size="sm" ghost ariaLabel={`Rename ${now}`} onClick={() => { setDraft(now); setEditing(true); }}>✎</Button>
    </div>
  );
}

/** The status-bar entry: hidden while there is nothing to show or the assist is off. */
export function AssistChip() {
  const enabled = useAssist((s) => s.enabled);
  const items = useAssist((s) => s.items);
  const busy = useAssist((s) => s.busy);
  const hasAgent = useStore((s) => !!s.apiKey);
  const [open, setOpen] = useState(false);
  // Escape closes the card (a dialog over it takes Escape first); the app's own Escape doesn't also run
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || modalOpen()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setOpen(false);
      document.querySelector<HTMLElement>(".assist-wrap > .k-btn")?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  if (!enabled) return null;
  const { pending, recent } = inboxSections(items);
  if (!pending.length && !recent.length) return null;
  const label = busy ? "Naming…" : pending.length ? `${pending.length} to name` : "Named";
  return (
    <span className="assist-wrap">
      <Button size="sm" ghost on={open} ariaLabel="Organizational assist" title="Organizational assist: names for sketches and features" onClick={() => setOpen((v) => !v)}>
        ✎ {label}
      </Button>
      {open && (
        <Card className="assist-card" title="Organizational assist" ariaLabel="Organizational assist inbox" onClose={() => setOpen(false)}
          foot={pending.length > 0 && hasAgent ? <Button size="sm" accent disabled={busy} onClick={() => void nameWithAgent(pending.map((i) => i.id))}>Name with Claude</Button> : undefined}>
          {pending.length > 0 && (
            <div className="assist-list" role="list" aria-label="Waiting for a name">
              <span className="k-label">Waiting for a name</span>
              {pending.map((i) => <PendingRow key={i.id} item={i} />)}
            </div>
          )}
          {recent.length > 0 && (
            <div className="assist-list" role="list" aria-label="Recently named">
              <span className="k-label">Recently named</span>
              {recent.map((i) => <RecentRow key={i.id} item={i} />)}
            </div>
          )}
        </Card>
      )}
    </span>
  );
}
