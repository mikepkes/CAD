// The note commands: notes on the design, by people and agents, each with an
// optional freehand drawing over a view of the model and an optional pin on
// what it is about. They change nothing in the model; as timeline operations
// they undo, roll back and travel with the file like an intent.
//
// Strokes come in as point lists (0..1) or SVG path data (0..1000) and are
// stored as points (core/notes.ts); the op keeps what was given, so a canvas
// that sends path data keeps the file small. Timestamps are stamped onto a
// new op (`at`) so replaying it gives the same note.

import type { CadDocument, Note } from "../document";
import type { CommandDef, JSONSchema } from "./types";
import { StrokeInput, anchorFromInput, checkBackground, missingAnchor, strokesFromInputs, NOTE_SPACE } from "../notes";

const V3: JSONSchema = { type: "object", required: ["x", "y", "z"], properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } };

const STROKE: JSONSchema = {
  type: "object",
  additionalProperties: false,
  description:
    `One pen stroke. Give \`path\` — SVG path data in a ${NOTE_SPACE}×${NOTE_SPACE} canvas, origin top-left, y down (M L H V C S Q T A Z, relative forms too; ` +
    "each subpath becomes its own stroke; curves are flattened) — or `points`, a list of {x,y} or [x,y] in 0..1 across the canvas.",
  properties: {
    color: { type: "string", description: "Hex (#d33, #1f2328) or a colour name. Default #1f2328 (ink)." },
    width: { type: "number", description: `Line width in ${NOTE_SPACE}ths of the canvas side (2 fine, 4 pen, 8 marker, 16 highlighter). Default 4.` },
    points: { type: "array", description: "Points in 0..1: [{x, y}, …] or [[x, y], …]." },
    path: { type: "string", description: `SVG path data in 0..${NOTE_SPACE}, e.g. "M100 100 L900 100 L500 800 Z".` },
  },
};
const STROKES: JSONSchema = { type: "array", items: STROKE, description: "Strokes, drawn in order." };
const BACKGROUND: JSONSchema = {
  type: ["string", "null"],
  description: "An image the strokes are drawn over: a data URL (data:image/png;base64,…, or jpeg / webp), square is best. null removes it (a blank canvas).",
};
const ANCHOR: JSONSchema = {
  type: ["object", "null"],
  additionalProperties: false,
  description:
    "What the note is about, marked with a numbered pin in the 3D view: `feature` (a feature/body id), `sketch` (a sketch id), and/or `point` (world mm; with a feature or sketch it marks that spot on it). " +
    "`view` is a camera {position, target, up} that opening the note can go back to. null removes the pin.",
  properties: {
    feature: { type: "string" },
    sketch: { type: "string" },
    point: V3,
    view: { type: "object", properties: { position: V3, target: V3, up: V3 } },
  },
};
const AUTHOR: JSONSchema = { type: "string", description: "Who writes it: \"human\", \"agent\", or a name. Agent tools fill in \"agent\" when left out." };
const AT: JSONSchema = { type: "number", description: "Epoch ms; the app stamps it — leave it out." };

const notes = (draft: CadDocument): Note[] => (draft.notes ??= []);
function noteById(draft: CadDocument, id: string): Note {
  const n = notes(draft).find((x) => x.id === id);
  if (!n) throw new Error(`No note "${id}"`);
  return n;
}
const stamp = <P extends { at?: number }>(p: P): P => ({ ...p, at: p.at ?? Date.now() });
const atOf = (p: { at?: number }) => (typeof p.at === "number" ? p.at : 0);
/** Record who made a change: nothing extra when it is the author. */
function touch(n: Note, p: { at?: number; author?: string }) {
  n.updatedAt = atOf(p);
  const by = p.author?.trim();
  if (by && by !== n.author) n.updatedBy = by; else if (by) delete n.updatedBy;
}
const warnAnchor = (draft: CadDocument, n: Note) => {
  const missing = missingAnchor(draft, n.anchor);
  return missing ? ` (pinned to ${missing}, which this document doesn't have now: the pin shows once it does)` : "";
};

interface AddParams { title?: string; body?: string; author?: string; anchor?: unknown; drawing?: { strokes?: StrokeInput[]; background?: string | null }; strokes?: StrokeInput[]; at?: number }
interface UpdateParams { id: string; title?: string; body?: string; author?: string; anchor?: unknown; drawing?: { strokes?: StrokeInput[]; background?: string | null } | null; strokes?: StrokeInput[]; background?: string | null; at?: number }

export const NOTE_COMMANDS: CommandDef<any>[] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
  {
    type: "note.add",
    title: "Add note",
    summary: "Write a note on the design — text, an optional drawing, optionally pinned to a feature, sketch or point.",
    description:
      "Adds a note people see in the Notes panel (and as a numbered pin in the 3D view when anchored). The model is unchanged. " +
      "`body` is markdown (line breaks, **bold**, - lists). To draw a diagram, pass `strokes` (or `drawing.strokes`): each stroke is SVG path data in a " +
      `${NOTE_SPACE}×${NOTE_SPACE} canvas (\`path\`) or a point list in 0..1 (\`points\`). \`drawing.background\` puts an image (a data URL, e.g. render_view's PNG) behind the strokes. ` +
      "Returns the note id. Read notes back with notes_list / notes_get.",
    paramsSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "A short title (default: the body's first line)." },
        body: { type: "string", description: "Markdown text." },
        author: AUTHOR,
        anchor: ANCHOR,
        strokes: STROKES,
        drawing: { type: "object", additionalProperties: false, properties: { strokes: STROKES, background: BACKGROUND } },
        at: AT,
      },
    },
    examples: [
      { note: "A remark pinned to a feature", params: { title: "Wall too thin?", body: "The **left wall** looks thin next to the boss.\n- check 2 mm min\n- or add a rib", anchor: { feature: "extrude3" } } },
      { note: "A drawn diagram: an arrow and a circle", params: { title: "Move the hole here", strokes: [{ path: "M150 800 L450 520 M450 520 L380 530 M450 520 L440 590", color: "#d33", width: 6 }, { path: "M600 450 A 90 90 0 1 0 600 451", color: "#d33" }] } },
    ],
    stampNew: stamp,
    apply(draft, p: AddParams, ctx) {
      const strokes = strokesFromInputs([...(p.drawing?.strokes ?? []), ...(p.strokes ?? [])]);
      const background = typeof p.drawing?.background === "string" ? checkBackground(p.drawing.background) : undefined;
      const anchor = anchorFromInput(p.anchor);
      const body = p.body ?? "";
      const title = p.title?.trim() || body.split("\n").map((l) => l.replace(/[*_#>`-]/g, "").trim()).find(Boolean)?.slice(0, 60) || "Untitled note";
      const id = ctx.alloc("note");
      const at = atOf(p);
      const n: Note = {
        id, title, body, author: p.author?.trim() || "human", createdAt: at, updatedAt: at,
        ...(anchor ? { anchor } : {}),
        ...(strokes.length || background ? { drawing: { strokes, ...(background ? { background } : {}) } } : {}),
      };
      notes(draft).push(n);
      return { createdIds: [id], message: `Added note “${title}”${strokes.length ? ` with ${strokes.length} stroke${strokes.length === 1 ? "" : "s"}` : ""}${warnAnchor(draft, n)}` };
    },
  },
  {
    type: "note.update",
    title: "Edit note",
    summary: "Change a note's title, body, pin or drawing.",
    description:
      "Updates the given fields of a note by id; the others stay. `anchor: null` removes the pin. `strokes` replaces every stroke (to add some, use note.stroke.add); " +
      "`background` sets the image behind them (null: blank canvas); `drawing` replaces the whole drawing (null removes it). `author` records who made the change.",
    paramsSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "The note id (from note.add or notes_list)." },
        title: { type: "string" },
        body: { type: "string", description: "Markdown text (replaces the body)." },
        author: AUTHOR,
        anchor: ANCHOR,
        strokes: STROKES,
        background: BACKGROUND,
        drawing: { type: ["object", "null"], additionalProperties: false, properties: { strokes: STROKES, background: BACKGROUND } },
        at: AT,
      },
    },
    examples: [
      { params: { id: "note12", body: "Fixed: the wall is 3 mm now." } },
      { note: "Replace the strokes, keep the background", params: { id: "note12", strokes: [{ points: [[0.2, 0.2], [0.8, 0.8]] }] } },
    ],
    stampNew: stamp,
    apply(draft, p: UpdateParams) {
      const n = noteById(draft, p.id);
      if (p.title !== undefined) n.title = p.title.trim() || n.title;
      if (p.body !== undefined) n.body = p.body;
      if (p.anchor !== undefined) { const a = anchorFromInput(p.anchor); if (a) n.anchor = a; else delete n.anchor; }
      if (p.drawing === null) delete n.drawing;
      else if (p.drawing) {
        const bg = typeof p.drawing.background === "string" ? checkBackground(p.drawing.background) : undefined;
        n.drawing = { strokes: strokesFromInputs(p.drawing.strokes ?? []), ...(bg ? { background: bg } : {}) };
      }
      if (p.strokes) n.drawing = { ...(n.drawing ?? {}), strokes: strokesFromInputs(p.strokes) };
      if (p.background !== undefined) {
        const d = { strokes: n.drawing?.strokes ?? [] } as NonNullable<Note["drawing"]>;
        if (p.background !== null) d.background = checkBackground(p.background);
        n.drawing = d;
      }
      if (n.drawing && !n.drawing.strokes.length && !n.drawing.background) delete n.drawing;
      touch(n, p);
      return { message: `Updated note “${n.title}”${warnAnchor(draft, n)}` };
    },
  },
  {
    type: "note.stroke.add",
    title: "Draw on note",
    summary: "Add strokes to a note's drawing (starts one if it has none).",
    description: `Appends strokes on top of the note's drawing. Each stroke is SVG path data in ${NOTE_SPACE}×${NOTE_SPACE} (\`path\`) or points in 0..1 (\`points\`).`,
    paramsSchema: {
      type: "object",
      required: ["id", "strokes"],
      additionalProperties: false,
      properties: { id: { type: "string" }, strokes: STROKES, author: AUTHOR, at: AT },
    },
    examples: [{ note: "Circle a spot", params: { id: "note12", strokes: [{ path: "M500 300 A 120 120 0 1 1 499 300", color: "#2563eb", width: 5 }] } }],
    stampNew: stamp,
    apply(draft, p: { id: string; strokes: StrokeInput[]; author?: string; at?: number }) {
      const n = noteById(draft, p.id);
      const add = strokesFromInputs(p.strokes);
      n.drawing = { ...(n.drawing ?? {}), strokes: [...(n.drawing?.strokes ?? []), ...add] };
      touch(n, p);
      return { message: `Drew ${add.length} stroke${add.length === 1 ? "" : "s"} on “${n.title}”` };
    },
  },
  {
    type: "note.stroke.clear",
    title: "Clear note drawing",
    summary: "Remove every stroke from a note's drawing.",
    description: "Clears the strokes; the background image stays unless `background` is true.",
    paramsSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: { type: "string" }, background: { type: "boolean", description: "Also remove the background image." }, author: AUTHOR, at: AT },
    },
    destructive: true,
    stampNew: stamp,
    apply(draft, p: { id: string; background?: boolean; author?: string; at?: number }) {
      const n = noteById(draft, p.id);
      const bg = p.background ? undefined : n.drawing?.background;
      if (bg) n.drawing = { strokes: [], background: bg }; else delete n.drawing;
      touch(n, p);
      return { message: `Cleared the drawing on “${n.title}”` };
    },
  },
  {
    type: "note.delete",
    title: "Delete note",
    summary: "Remove a note by id.",
    description: "Removes the note, its drawing and its pin. Undo brings it back.",
    paramsSchema: { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string" } } },
    destructive: true,
    apply(draft, p: { id: string }) {
      const n = noteById(draft, p.id);
      draft.notes = notes(draft).filter((x) => x.id !== p.id);
      return { message: `Deleted note “${n.title}”` };
    },
  },
];
