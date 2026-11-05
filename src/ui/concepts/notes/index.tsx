// The Notes tab: notes on the design, written here or by an agent (note.add
// over MCP), each with an optional sketch drawn over a captured view and an
// optional pin on what it is about. The list reads newest change first; a note
// opens to its body and drawing; New note / Edit open the editor, whose Save
// sends one undoable step (notes.ts decides which commands). The pins over the
// view are NotesOverlay: a numbered marker at each anchored note, which opens
// it here. Every write is a note.* command (tenet 1); the notes themselves are
// document state (doc.notes), so undo, the file and the agent all see them.

import { useMemo, useState } from "react";
import type { Note, NoteAnchor, NoteDrawing } from "../../../core/document";
import { strokePath, NOTE_SPACE } from "../../../core/notes";
import { useStore } from "../../../model/store";
import { useUi } from "../../../model/concepts/uiState";
import { Button, Input, Pin } from "../../kit/primitives";
import { useFeatureRows } from "../../kit/useFeatureRows";
import { useProjected, useScene } from "../../kit/useProjected";
import { ask } from "../../kit/askDialog";
import { DrawingPad } from "./DrawingPad";
import { useNotesUi } from "./notesState";
import { anchorText, anchorWorld, authorBadge, draftOf, markdownBlocks, newestFirst, noteNumbers, pinFromSelection, saveCommands, timeAgo, type NoteDraft, type Span } from "./notes";
import "./notes.css";

export { useNotesUi } from "./notesState";

const useNotes = (): Note[] => {
  useStore((s) => s.rev);
  return useStore((s) => s.session.doc.notes) ?? [];
};

export function NotesPanel() {
  const notes = useNotes();
  const open = useNotesUi((s) => s.open);
  const editing = useNotesUi((s) => s.editing);
  const { setOpen, edit } = useNotesUi.getState();
  const nums = useMemo(() => noteNumbers(notes), [notes]);
  const editNote = editing && editing !== "new" ? notes.find((n) => n.id === editing) ?? null : null;

  return (
    <section className="panel notes" aria-label="Notes">
      <div className="notes-head">
        <span className="k-label">{notes.length ? `${notes.length} note${notes.length === 1 ? "" : "s"}` : "Notes"}</span>
        {!editing && <Button size="sm" accent onClick={() => edit("new")} title="Write a note; draw on it, pin it to what it is about">New note</Button>}
      </div>
      {editing === "new" && <NoteEditor note={null} />}
      {editNote && <NoteEditor key={editNote.id} note={editNote} num={nums.get(editNote.id)} />}
      {!editing && !notes.length && (
        <p className="notes-empty k-dim">No notes yet. Write one, sketch over the view, pin it to a face — or ask the agent to leave one.</p>
      )}
      {!editing && notes.length > 0 && (
        <ul className="notes-list" aria-label="Notes on this design">
          {newestFirst(notes).map((n) => (
            <li key={n.id} className={`notes-row${open === n.id ? " open" : ""}`}>
              <NoteRow note={n} num={nums.get(n.id)!} open={open === n.id} onToggle={() => setOpen(open === n.id ? null : n.id)} />
              {open === n.id && <NoteBody note={n} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AuthorBadge(p: { author: string }) {
  const b = authorBadge(p.author);
  return <span className={`notes-author ${b.kind}`} title={b.kind === "agent" ? "Written by an agent" : undefined}>{b.label}</span>;
}

function NoteRow(p: { note: Note; num: number; open: boolean; onToggle: () => void }) {
  const n = p.note;
  return (
    <button type="button" className="notes-pick" aria-expanded={p.open} onClick={p.onToggle}>
      <span className={`notes-num${n.anchor ? " pinned" : ""}`} title={n.anchor ? "Pinned in the view" : undefined}>{p.num}</span>
      <span className="notes-title">
        <b>{n.title}</b>
        <span className="notes-meta k-dim">
          <AuthorBadge author={n.author} />
          <span title={new Date(n.updatedAt).toLocaleString()}>{timeAgo(n.updatedAt)}</span>
          {n.updatedBy && <span>· edited by {authorBadge(n.updatedBy).label.toLowerCase() === "you" ? "you" : authorBadge(n.updatedBy).label}</span>}
          {n.anchor && <span aria-label="pinned">· pinned</span>}
          {n.drawing && <span>· drawing</span>}
        </span>
      </span>
    </button>
  );
}

function Spans(p: { spans: Span[] }) {
  return <>{p.spans.map((s, i) => s.bold ? <strong key={i}>{s.text}</strong> : s.italic ? <em key={i}>{s.text}</em> : s.code ? <code key={i}>{s.text}</code> : <span key={i}>{s.text}</span>)}</>;
}

/** The body's markdown, the cheap part: paragraphs with their line breaks, lists, headings, bold/italic/code. */
export function Markdown(p: { text: string }) {
  return (
    <div className="notes-md">
      {markdownBlocks(p.text).map((b, i) => {
        if (b.kind === "h") return <h4 key={i}><Spans spans={b.spans} /></h4>;
        if (b.kind === "p") return <p key={i}>{b.lines.map((l, j) => <span key={j}>{j > 0 && <br />}<Spans spans={l} /></span>)}</p>;
        const items = b.items.map((it, j) => <li key={j}><Spans spans={it} /></li>);
        return b.kind === "ul" ? <ul key={i}>{items}</ul> : <ol key={i}>{items}</ol>;
      })}
    </div>
  );
}

/** A drawing as SVG: the same strokes the pad paints, over the captured image (or paper). */
export function DrawingPreview(p: { drawing: NoteDrawing; label?: string }) {
  return (
    <svg className="notes-preview" viewBox={`0 0 ${NOTE_SPACE} ${NOTE_SPACE}`} role="img" aria-label={p.label ?? "Drawing"}>
      {p.drawing.background
        ? <image href={p.drawing.background} width={NOTE_SPACE} height={NOTE_SPACE} preserveAspectRatio="xMidYMid slice" />
        : <rect width={NOTE_SPACE} height={NOTE_SPACE} fill="#ffffff" />}
      {p.drawing.strokes.map((s, i) => <path key={i} d={strokePath(s)} fill="none" stroke={s.color} strokeWidth={s.width} strokeLinecap="round" strokeLinejoin="round" />)}
    </svg>
  );
}

function AnchorLine(p: { anchor: NoteAnchor | undefined }) {
  const doc = useStore((s) => s.session.doc);
  const rows = useFeatureRows();
  const scene = useScene();
  const t = anchorText(p.anchor, doc, rows);
  if (!t && !p.anchor?.view) return null;
  return (
    <div className="notes-anchor">
      {t && <span className={t.missing ? "notes-missing" : "k-dim"}>Pinned to {t.text}{t.missing ? " (not in the model now)" : ""}</span>}
      {p.anchor?.view && <Button size="sm" ghost disabled={!scene} title="Turn the view back to where this note was written" onClick={() => scene?.restoreView(p.anchor!.view!)}>Go to view</Button>}
    </div>
  );
}

function NoteBody(p: { note: Note }) {
  const n = p.note;
  const remove = async () => {
    const ok = await ask({ title: "Delete this note?", text: `“${n.title}”${n.drawing ? " and its drawing" : ""} will be removed. Undo brings it back.`, confirmLabel: "Delete" });
    if (ok) await useStore.getState().dispatch("note.delete", { id: n.id });
  };
  return (
    <div className="notes-body">
      {n.body.trim() ? <Markdown text={n.body} /> : <p className="k-dim">No text.</p>}
      {n.drawing && <DrawingPreview drawing={n.drawing} label={`Drawing on ${n.title}`} />}
      <AnchorLine anchor={n.anchor} />
      <div className="notes-actions">
        <Button size="sm" onClick={() => useNotesUi.getState().edit(n.id)}>Edit</Button>
        <Button size="sm" ghost onClick={() => void remove()}>Delete</Button>
      </div>
    </div>
  );
}

function NoteEditor(p: { note: Note | null; num?: number }) {
  const [draft, setDraft] = useState<NoteDraft>(() => draftOf(p.note));
  const [drawing, setDrawing] = useState(!!(p.note?.drawing));
  const [saving, setSaving] = useState(false);
  const doc = useStore((s) => s.session.doc);
  const rows = useFeatureRows();
  const scene = useScene();
  const selection = pinFromSelection({
    faceSelection: useStore((s) => s.faceSelection),
    mode: useStore((s) => s.mode),
    activeSketchId: useStore((s) => s.activeSketchId),
    openFeature: useUi((s) => s.openFeature),
  });
  const patch = (d: Partial<NoteDraft>) => setDraft((x) => ({ ...x, ...d }));
  const setAnchor = (a: NoteAnchor | undefined) => setDraft((x) => {
    const { anchor: _old, ...rest } = x; // eslint-disable-line @typescript-eslint/no-unused-vars
    const clean = a ? Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) as NoteAnchor : undefined;
    return clean && Object.keys(clean).length ? { ...rest, anchor: clean } : rest;
  });
  const pinned = anchorText(draft.anchor, doc, rows);
  const selected = selection ? anchorText(selection, doc, rows) : null;

  const close = () => useNotesUi.getState().edit(null);
  const save = async () => {
    const cmds = saveCommands(p.note, draft);
    if (!cmds.length) return close();
    setSaving(true);
    const st = useStore.getState();
    const mark = st.beginGesture();
    let newId: string | undefined;
    let ok = true;
    for (const c of cmds) {
      const r = await st.dispatch(c.type, c.params);
      if (!r.ok) { ok = false; break; }
      if (c.type === "note.add") newId = r.createdIds[0];
    }
    st.endGesture(mark, ok ? { label: p.note ? `Edit note ${p.note.title}` : "Add note" } : "drop");
    setSaving(false);
    if (!ok) return; // the store's toast says why; the draft stays to fix
    close();
    if (newId) useNotesUi.getState().setOpen(newId);
  };

  return (
    <form className="notes-editor" aria-label={p.note ? `Edit note ${p.num ?? ""}`.trim() : "New note"} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Input ariaLabel="Note title" placeholder="Title (optional: the first line of the text)" value={draft.title} onChange={(v) => patch({ title: v })} />
      <textarea className="k-input notes-text" aria-label="Note text" placeholder={"What about it? Markdown works: **bold**, - lists"} rows={5}
        value={draft.body} onChange={(e) => patch({ body: e.target.value })}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); } }} />
      {drawing
        ? <DrawingPad strokes={draft.strokes} background={draft.background}
          onStrokes={(strokes) => patch({ strokes })}
          onBackground={(background, view) => setDraft((x) => ({
            ...x, background,
            // a captured view remembers its camera, so "Go to view" returns to what was drawn over
            ...(background && view ? { anchor: { ...(x.anchor ?? {}), view } } : {}),
          }))} />
        : <Button size="sm" onClick={() => setDrawing(true)} title="Sketch on a blank page or over a capture of the view">Add a drawing</Button>}
      <div className="notes-pinrow">
        <span className={pinned?.missing ? "notes-missing" : "k-dim"}>{pinned ? `Pinned to ${pinned.text}${draft.anchor?.view ? " · view saved" : ""}` : draft.anchor?.view ? "View saved" : "Not pinned"}</span>
        <Button size="sm" disabled={!selection} title={selected ? `Pin to ${selected.text}` : "Select a face, open a feature's card, or edit a sketch to pin to it"}
          onClick={() => selection && setAnchor({ ...selection, ...(draft.anchor?.view ? { view: draft.anchor.view } : {}) })}>Pin to selection</Button>
        <Button size="sm" ghost disabled={!scene} title="Remember the camera, so the note can turn the view back here" on={!!draft.anchor?.view}
          onClick={() => scene && setAnchor(draft.anchor?.view ? { ...draft.anchor, view: undefined } : { ...(draft.anchor ?? {}), view: scene.cameraView() })}>Save view</Button>
        {draft.anchor && <Button size="sm" ghost onClick={() => setAnchor(undefined)}>Unpin</Button>}
      </div>
      <div className="notes-actions">
        <Button type="submit" size="sm" accent disabled={saving}>{p.note ? "Save" : "Add note"}</Button>
        <Button size="sm" ghost onClick={close}>Cancel</Button>
      </div>
    </form>
  );
}

/** The numbered markers over the view, one per pinned note whose anchor is in the model; a click opens the
 *  note in the Notes tab. Shown while the Notes panel is on. */
export function NotesOverlay() {
  const on = useUi((s) => s.panels.notes);
  const notes = useNotes();
  const doc = useStore((s) => s.session.doc);
  const rows = useFeatureRows();
  const open = useNotesUi((s) => s.open);
  const nums = useMemo(() => noteNumbers(notes), [notes]);
  const placed = on ? notes.map((n) => ({ n, at: anchorWorld(n.anchor, doc, rows) })).filter((x): x is { n: Note; at: { x: number; y: number; z: number } } => !!x.at) : [];
  const screen = useProjected(placed.map((x) => x.at));
  return (
    <>
      {placed.map(({ n }, i) => screen[i]?.visible && (
        <Pin key={n.id} at={screen[i]} className={`notes-pin${authorBadge(n.author).kind === "agent" ? " agent" : ""}`} state={open === n.id ? "open" : ""}
          ariaLabel={`Note ${nums.get(n.id)}: ${n.title}`} title={`${n.title} — ${authorBadge(n.author).label}`} onClick={() => useNotesUi.getState().reveal(n.id)}>
          {nums.get(n.id)}
        </Pin>
      ))}
    </>
  );
}
