// The Notes concept's decisions, apart from React: how a body's markdown reads,
// how old a note is, who wrote it, where its pin goes in 3D, what "pin to
// selection" pins to, and which commands saving an edit sends (so drawing more
// sends only the new strokes). Tested in Node (test/notesPanel.test.ts).

import type { CadDocument, Note, NoteAnchor, NoteStroke } from "../../../core/document";
import type { FeatureRow } from "../../../model/concepts/featureCatalog";
import { pinAnchor } from "../../../model/concepts/featureCatalog";
import { resolveSketchPlane } from "../../../geometry/plane";
import { simplifyPoints, strokeInputOf } from "../../../core/notes";

type V3 = { x: number; y: number; z: number };

// ---- markdown, the cheap part of it ----

export interface Span { text: string; bold?: boolean; italic?: boolean; code?: boolean }
export type Block =
  | { kind: "p"; lines: Span[][] }
  | { kind: "ul" | "ol"; items: Span[][] }
  | { kind: "h"; spans: Span[] };

/** **bold**, *italic* / _italic_ and `code` within a line; anything else is text. */
export function inlineSpans(line: string): Span[] {
  const out: Span[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_/g;
  let at = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > at) out.push({ text: line.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ text: m[1], bold: true });
    else if (m[2] !== undefined) out.push({ text: m[2], code: true });
    else out.push({ text: m[3] ?? m[4], italic: true });
    at = m.index + m[0].length;
  }
  if (at < line.length) out.push({ text: line.slice(at) });
  return out;
}

/** Paragraphs (line breaks kept), "- " / "* " lists, "1. " lists and "# " headings. */
export function markdownBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  let para: Span[][] | null = null;
  let list: { kind: "ul" | "ol"; items: Span[][] } | null = null;
  const end = () => { para = null; list = null; };
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line), num = /^\s*\d+[.)]\s+(.*)$/.exec(line), head = /^#{1,6}\s+(.*)$/.exec(line);
    if (!line.trim()) { end(); continue; }
    if (head) { end(); blocks.push({ kind: "h", spans: inlineSpans(head[1]) }); continue; }
    const item = bullet ? { kind: "ul" as const, text: bullet[1] } : num ? { kind: "ol" as const, text: num[1] } : null;
    if (item) {
      para = null;
      if (!list || list.kind !== item.kind) { list = { kind: item.kind, items: [] }; blocks.push(list); }
      list.items.push(inlineSpans(item.text));
      continue;
    }
    list = null;
    if (!para) { para = []; blocks.push({ kind: "p", lines: para }); }
    para.push(inlineSpans(line));
  }
  return blocks;
}

// ---- who and when ----

/** "just now", "5 min ago", "3 h ago", "yesterday", else the date. */
export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (!ms) return "";
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86400) return "yesterday";
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", ...(new Date(ms).getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) });
}

/** The author badge: you, the agent, or someone by name. */
export function authorBadge(author: string): { label: string; kind: "human" | "agent" | "named" } {
  if (author === "human") return { label: "You", kind: "human" };
  if (author === "agent") return { label: "Agent", kind: "agent" };
  return { label: author, kind: /agent|claude|bot|ai\b/i.test(author) ? "agent" : "named" };
}

// ---- order and numbers ----

/** Notes in the order they were written: a note's number (its pin's too) is its place here, so it never moves. */
export const byCreation = (notes: Note[]): Note[] => [...notes].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
/** id → its number (1-based). */
export function noteNumbers(notes: Note[]): Map<string, number> {
  return new Map(byCreation(notes).map((n, i) => [n.id, i + 1]));
}
/** The list, newest change first. */
export const newestFirst = (notes: Note[]): Note[] => [...notes].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);

// ---- anchors ----

/** Where a note's pin goes in the world: its point; else the feature's pin spot (where the feature's own pin
 *  sits, so the two read together); else the middle of the sketch's points. Null when none of it is built. */
export function anchorWorld(anchor: NoteAnchor | undefined, doc: CadDocument, rows: FeatureRow[]): V3 | null {
  if (!anchor) return null;
  if (anchor.point) return anchor.point;
  if (anchor.feature) {
    const row = rows.find((r) => r.featureId === anchor.feature && !r.rolledBack);
    return row ? pinAnchor(row) : null;
  }
  const sk = anchor.sketch ? doc.sketches[anchor.sketch] : undefined;
  if (sk) {
    const pts = Object.values(sk.entities).filter((e) => e.kind === "point") as { x: number; y: number }[];
    const u = pts.length ? pts.reduce((a, p) => a + p.x, 0) / pts.length : 0, v = pts.length ? pts.reduce((a, p) => a + p.y, 0) / pts.length : 0;
    const wp = resolveSketchPlane(sk);
    return { x: wp.origin.x + u * wp.u.x + v * wp.v.x, y: wp.origin.y + u * wp.u.y + v * wp.v.y, z: wp.origin.z + u * wp.u.z + v * wp.v.z };
  }
  return null;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** What a pin is on, in words ("Extrude 3", "Sketch 1", "a point at 10, 0, 5"); `missing` when the document lacks it. */
export function anchorText(anchor: NoteAnchor | undefined, doc: CadDocument, rows: FeatureRow[]): { text: string; missing: boolean } | null {
  if (!anchor) return null;
  if (anchor.feature) {
    const row = rows.find((r) => r.featureId === anchor.feature);
    const name = row?.name ?? doc.features[anchor.feature]?.name;
    return { text: name ?? anchor.feature, missing: !name || !!row?.rolledBack };
  }
  if (anchor.sketch) {
    const sk = doc.sketches[anchor.sketch];
    return { text: sk?.name ?? anchor.sketch, missing: !sk };
  }
  if (anchor.point) return { text: `a point at ${r1(anchor.point.x)}, ${r1(anchor.point.y)}, ${r1(anchor.point.z)}`, missing: false };
  return null; // a saved view alone pins nothing in the model
}

/** What "Pin to selection" pins to now: the selected face's spot on its body, else the sketch being edited,
 *  else the feature whose card is open. Null when nothing is selected. */
export function pinFromSelection(st: {
  faceSelection: { bodyId: string; point: V3 } | null;
  mode: string;
  activeSketchId: string | null;
  openFeature: string | null;
}): NoteAnchor | null {
  if (st.faceSelection) return { feature: st.faceSelection.bodyId, point: { ...st.faceSelection.point } };
  if (st.mode === "sketch" && st.activeSketchId) return { sketch: st.activeSketchId };
  if (st.openFeature) return { feature: st.openFeature };
  return null;
}

// ---- saving an edit ----

export interface NoteDraft {
  title: string;
  body: string;
  anchor?: NoteAnchor;
  strokes: NoteStroke[];
  background?: string;
}

/** A draft of an existing note, or of a new one. */
export function draftOf(n: Note | null): NoteDraft {
  if (!n) return { title: "", body: "", strokes: [] };
  return { title: n.title, body: n.body, ...(n.anchor ? { anchor: n.anchor } : {}), strokes: n.drawing?.strokes ?? [], ...(n.drawing?.background ? { background: n.drawing.background } : {}) };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The commands that save `draft` over `note` (null: a new note): one note.add, or a note.update with what
 *  changed — strokes only drawn on top go as one note.stroke.add rather than the whole drawing again. Strokes
 *  travel as path data (compact). Empty when nothing changed. */
export function saveCommands(note: Note | null, draft: NoteDraft, author = "human"): { type: string; params: Record<string, unknown> }[] {
  const strokes = draft.strokes.map(strokeInputOf);
  if (!note) {
    return [{
      type: "note.add",
      params: {
        title: draft.title.trim() || undefined, body: draft.body, author,
        ...(draft.anchor ? { anchor: draft.anchor } : {}),
        ...(strokes.length || draft.background ? { drawing: { strokes, ...(draft.background ? { background: draft.background } : {}) } } : {}),
      },
    }].map((c) => ({ ...c, params: Object.fromEntries(Object.entries(c.params).filter(([, v]) => v !== undefined)) }));
  }
  const was = draftOf(note);
  const out: { type: string; params: Record<string, unknown> }[] = [];
  const update: Record<string, unknown> = {};
  if (draft.title.trim() && draft.title.trim() !== was.title) update.title = draft.title.trim();
  if (draft.body !== was.body) update.body = draft.body;
  if (!same(draft.anchor, was.anchor)) update.anchor = draft.anchor ?? null;
  if ((draft.background ?? null) !== (was.background ?? null)) update.background = draft.background ?? null;
  const prefix = draft.strokes.length >= was.strokes.length && same(draft.strokes.slice(0, was.strokes.length), was.strokes);
  const added = prefix ? draft.strokes.slice(was.strokes.length) : [];
  if (!prefix) update.strokes = strokes;
  if (Object.keys(update).length) out.push({ type: "note.update", params: { id: note.id, ...update, author } });
  if (added.length) out.push({ type: "note.stroke.add", params: { id: note.id, strokes: added.map(strokeInputOf), author } });
  return out;
}

// ---- the drawing pad ----

/** The pens: ink, red, blue, green — drawn on paper white or on a captured view, so each reads on both. */
export const PEN_COLORS = [
  { key: "#1f2328", label: "Ink" },
  { key: "#e5484d", label: "Red" },
  { key: "#2563eb", label: "Blue" },
  { key: "#16a34a", label: "Green" },
] as const;
/** Widths in thousandths of the pad side. */
export const PEN_WIDTHS = [
  { key: 2, label: "Fine" },
  { key: 4, label: "Pen" },
  { key: 9, label: "Marker" },
] as const;
/** The eraser's reach, as a fraction of the pad side. */
export const ERASER_R = 0.02;

/** A pointer position on a pad drawn at `rect`, in 0..1 (clamped), or null when the pad has no size. */
export function padPoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): { x: number; y: number } | null {
  if (!(rect.width > 0 && rect.height > 0)) return null;
  const c = (v: number) => Math.min(1, Math.max(0, v));
  return { x: c((clientX - rect.left) / rect.width), y: c((clientY - rect.top) / rect.height) };
}

/** A finished pen stroke: simplified (a hand-drawn line keeps its shape with a fraction of the points), stored to 4 places. */
export function finishStroke(points: { x: number; y: number }[], color: string, width: number): NoteStroke | null {
  if (!points.length) return null;
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  const pts = simplifyPoints(points, 0.0012).map((p) => ({ x: r(p.x), y: r(p.y) }));
  return { color, width, points: pts };
}
