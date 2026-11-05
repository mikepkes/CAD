// Notes: the pure logic behind doc.notes — reading strokes an agent or the
// canvas hands in (point lists or SVG path data), writing them back out as SVG
// in the 1000×1000 space the tools speak, and the summaries the panel and the
// MCP tools show. No DOM, no React: the commands, the Notes panel and both MCP
// surfaces share it.
//
// Two coordinate spaces, on purpose. A stored point is 0..1 across a square
// canvas (x right, y down), so a drawing does not care what size it is shown
// at. Paths and widths that cross the tool boundary are in a 1000×1000 space,
// where integers are precise enough to draw with and easy for an agent to
// reason about (500,500 is the middle).

import type { CadDocument, Note, NoteAnchor, NoteDrawing, NoteStroke, NoteView } from "./document";

/** The side of the square space paths and widths are written in. */
export const NOTE_SPACE = 1000;
export const DEFAULT_INK = "#1f2328";
export const DEFAULT_WIDTH = 4;
const MAX_POINTS = 4000;
const MAX_STROKES = 2000;
/** A captured view is a few hundred kB; this keeps a pasted photo from bloating every save. */
export const MAX_BACKGROUND_CHARS = 3_000_000;

type P = { x: number; y: number };
type V3 = { x: number; y: number; z: number };

/** A stroke as a caller gives it: points in 0..1 (objects or [x, y] pairs) or SVG path data in the
 *  1000×1000 space (each subpath becomes its own stroke). */
export interface StrokeInput {
  color?: string;
  width?: number;
  points?: (P | [number, number])[];
  path?: string;
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// ---- reading SVG path data ----

/** The subpaths of SVG path data as point lists (curves and arcs flattened), in the path's own units.
 *  Throws on a command it can't read, naming it. */
export function parseSvgPath(d: string): P[][] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: P[][] = [];
  let cur: P[] = [];
  let i = 0, cmd = "";
  let x = 0, y = 0, sx = 0, sy = 0;
  let lastCtrl: P | null = null, lastCmd = "";
  const num = (): number => {
    const t = tokens[i];
    if (t === undefined || /[a-zA-Z]/.test(t)) throw new Error(`path data: "${cmd}" is missing a number`);
    i++;
    return Number(t);
  };
  const flush = () => { if (cur.length) out.push(cur); cur = []; };
  const push = (px: number, py: number) => { x = px; y = py; cur.push({ x, y }); };
  const bezier = (pts: P[], n: number) => {
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      let row = pts.slice();
      while (row.length > 1) row = row.slice(1).map((q, j) => ({ x: row[j].x + (q.x - row[j].x) * t, y: row[j].y + (q.y - row[j].y) * t }));
      cur.push(row[0]);
    }
    const end = pts[pts.length - 1];
    x = end.x; y = end.y;
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) throw new Error("path data must start with M");
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case "M": {
        flush();
        push(ox + num(), oy + num());
        sx = x; sy = y;
        cmd = rel ? "l" : "L"; // further pairs are line-tos
        break;
      }
      case "L": push(ox + num(), oy + num()); break;
      case "H": push(ox + num(), y); break;
      case "V": push(x, oy + num()); break;
      case "C": {
        const c1 = { x: ox + num(), y: oy + num() }, c2 = { x: ox + num(), y: oy + num() }, e = { x: ox + num(), y: oy + num() };
        if (!cur.length) cur.push({ x, y });
        bezier([{ x, y }, c1, c2, e], 16); lastCtrl = c2;
        break;
      }
      case "S": {
        const c1: P = lastCtrl && /[CS]/i.test(lastCmd) ? { x: 2 * x - lastCtrl.x, y: 2 * y - lastCtrl.y } : { x, y };
        const c2 = { x: ox + num(), y: oy + num() }, e = { x: ox + num(), y: oy + num() };
        if (!cur.length) cur.push({ x, y });
        bezier([{ x, y }, c1, c2, e], 16); lastCtrl = c2;
        break;
      }
      case "Q": {
        const c = { x: ox + num(), y: oy + num() }, e = { x: ox + num(), y: oy + num() };
        if (!cur.length) cur.push({ x, y });
        bezier([{ x, y }, c, e], 12); lastCtrl = c;
        break;
      }
      case "T": {
        const c: P = lastCtrl && /[QT]/i.test(lastCmd) ? { x: 2 * x - lastCtrl.x, y: 2 * y - lastCtrl.y } : { x, y };
        const e = { x: ox + num(), y: oy + num() };
        if (!cur.length) cur.push({ x, y });
        bezier([{ x, y }, c, e], 12); lastCtrl = c;
        break;
      }
      case "A": {
        const rx = Math.abs(num()), ry = Math.abs(num()), rot = num(), large = num(), sweep = num();
        const e = { x: ox + num(), y: oy + num() };
        if (!cur.length) cur.push({ x, y });
        for (const q of arcPoints({ x, y }, e, rx, ry, rot, !!large, !!sweep)) cur.push(q);
        x = e.x; y = e.y;
        break;
      }
      case "Z": {
        if (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) throw new Error("path data: a number after Z needs a command first (M or L)");
        if (cur.length) cur.push({ x: sx, y: sy });
        x = sx; y = sy;
        flush();
        break;
      }
      default: throw new Error(`path data: unknown command "${cmd}"`);
    }
    lastCmd = cmd;
    if (!/[CSQT]/i.test(cmd)) lastCtrl = null;
  }
  flush();
  return out;
}

/** An SVG elliptical arc as points after `a` up to and including `b` (the endpoint parameterization of the SVG spec, F.6.5). */
function arcPoints(a: P, b: P, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean): P[] {
  if (!rx || !ry || (a.x === b.x && a.y === b.y)) return [b];
  const phi = (rotDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (a.x - b.x) / 2, dy = (a.y - b.y) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  const cx1 = (k * rx * y1) / ry, cy1 = (-k * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (a.x + b.x) / 2, cy = sin * cx1 + cos * cy1 + (a.y + b.y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(4, Math.ceil(Math.abs(dt) / (Math.PI / 16)));
  const out: P[] = [];
  for (let j = 1; j <= n; j++) {
    const t = t1 + (dt * j) / n;
    out.push({ x: cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, y: cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos });
  }
  out[out.length - 1] = b;
  return out;
}

// ---- strokes in and out ----

/** Ramer–Douglas–Peucker: drop points that sit within `eps` of the line through their neighbours. */
export function simplifyPoints(pts: P[], eps: number): P[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const a = pts[s], b = pts[e];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    let best = -1, far = eps;
    for (let k = s + 1; k < e; k++) {
      const d = len ? Math.abs(dy * (pts[k].x - a.x) - dx * (pts[k].y - a.y)) / len : Math.hypot(pts[k].x - a.x, pts[k].y - a.y);
      if (d > far) { far = d; best = k; }
    }
    if (best > 0) { keep[best] = 1; stack.push([s, best], [best, e]); }
  }
  return pts.filter((_, k) => keep[k]);
}

const COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/;

/** The strokes a StrokeInput describes, checked and stored compactly (points in 0..1 to 4 places, nearly
 *  collinear points dropped). Throws with what is wrong, for the agent to fix. */
export function strokesFromInput(input: StrokeInput, where = "stroke"): NoteStroke[] {
  const color = input.color?.trim() || DEFAULT_INK;
  if (!COLOR.test(color)) throw new Error(`${where}: color "${input.color}" should be a hex colour like #d33 or a colour name`);
  const width = input.width ?? DEFAULT_WIDTH;
  if (!(width > 0 && width <= 100)) throw new Error(`${where}: width ${input.width} should be between 0 and 100 (thousandths of the canvas side)`);
  let lists: P[][];
  if (typeof input.path === "string" && input.path.trim()) {
    lists = parseSvgPath(input.path).map((l) => l.map((q) => ({ x: q.x / NOTE_SPACE, y: q.y / NOTE_SPACE })));
  } else if (Array.isArray(input.points)) {
    const pts = input.points.map((q) => (Array.isArray(q) ? { x: q[0], y: q[1] } : q));
    if (pts.some((q) => !q || !Number.isFinite(q.x) || !Number.isFinite(q.y))) throw new Error(`${where}: every point needs a finite x and y`);
    if (pts.some((q) => q.x < -0.01 || q.x > 1.01 || q.y < -0.01 || q.y > 1.01)) {
      throw new Error(`${where}: points are 0..1 across the canvas (x right, y down); for 0..1000 coordinates give \`path\` instead (SVG path data)`);
    }
    lists = [pts];
  } else {
    throw new Error(`${where}: give \`points\` (0..1) or \`path\` (SVG path data in 0..1000)`);
  }
  const out: NoteStroke[] = [];
  for (const l of lists) {
    const pts = simplifyPoints(l.map((q) => ({ x: round4(clamp01(q.x)), y: round4(clamp01(q.y)) })), 0.0006);
    if (!pts.length) continue;
    if (pts.length > MAX_POINTS) throw new Error(`${where}: ${pts.length} points is more than ${MAX_POINTS}; split it into several strokes`);
    out.push({ color, width: Math.round(width * 100) / 100, points: pts });
  }
  return out;
}

/** Every stroke of several inputs, numbered in errors. */
export function strokesFromInputs(inputs: StrokeInput[]): NoteStroke[] {
  const out = inputs.flatMap((s, k) => strokesFromInput(s, `strokes[${k}]`));
  if (out.length > MAX_STROKES) throw new Error(`a drawing holds at most ${MAX_STROKES} strokes`);
  return out;
}

const fmt = (v: number) => String(Math.round(v * NOTE_SPACE * 10) / 10);

/** A stored stroke as SVG path data in the 1000×1000 space (a dot is a zero-length line, drawn by the round cap). */
export function strokePath(s: NoteStroke): string {
  const [first, ...rest] = s.points;
  if (!first) return "";
  const tail = rest.length ? rest : [first];
  return `M${fmt(first.x)} ${fmt(first.y)}L${tail.map((q) => `${fmt(q.x)} ${fmt(q.y)}`).join(" ")}`;
}

/** The stroke as a canvas sends it: path data at a tenth of a unit (a third the size of point objects). */
export function strokeInputOf(s: NoteStroke): StrokeInput {
  return { color: s.color, width: s.width, path: strokePath(s) };
}

/** Checks a background image: a base64 data URL of a PNG, JPEG or WebP, not too large. */
export function checkBackground(src: string): string {
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/.test(src)) throw new Error("background must be a data URL: data:image/png;base64,…");
  if (src.length > MAX_BACKGROUND_CHARS) throw new Error(`background is ${Math.round(src.length / 1000)} kB; keep it under ${MAX_BACKGROUND_CHARS / 1_000_000} MB (a smaller capture)`);
  return src;
}

/** The whole drawing as one SVG document (background image under the strokes). `size` is the pixel side. */
export function noteSvg(drawing: NoteDrawing | undefined, size = NOTE_SPACE): string {
  const paths = (drawing?.strokes ?? []).map((s) =>
    `<path d="${strokePath(s)}" fill="none" stroke="${s.color}" stroke-width="${s.width}" stroke-linecap="round" stroke-linejoin="round"/>`);
  const bg = drawing?.background
    ? `<image href="${drawing.background}" x="0" y="0" width="${NOTE_SPACE}" height="${NOTE_SPACE}" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect width="${NOTE_SPACE}" height="${NOTE_SPACE}" fill="#ffffff"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${NOTE_SPACE} ${NOTE_SPACE}">${bg}${paths.join("")}</svg>`;
}

/** Strokes that the eraser, a circle at `at` with radius `r` (both 0..1), leaves whole: a stroke it touches goes. */
export function eraseStrokes(strokes: NoteStroke[], at: P, r: number): NoteStroke[] {
  const hit = (s: NoteStroke) => {
    const reach = r + s.width / NOTE_SPACE / 2;
    if (s.points.length === 1) return Math.hypot(s.points[0].x - at.x, s.points[0].y - at.y) <= reach;
    for (let k = 1; k < s.points.length; k++) if (segmentDistance(at, s.points[k - 1], s.points[k]) <= reach) return true;
    return false;
  };
  return strokes.filter((s) => !hit(s));
}

function segmentDistance(p: P, a: P, b: P): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ---- anchors ----

const isV3 = (v: unknown): v is V3 => !!v && typeof v === "object" && ["x", "y", "z"].every((k) => Number.isFinite((v as Record<string, unknown>)[k]));

/** An anchor as given, checked (ids are kept even if nothing carries them yet: a note outlives what it is
 *  pinned to). Null clears. */
export function anchorFromInput(a: unknown): NoteAnchor | undefined {
  if (a == null) return undefined;
  const o = a as Record<string, unknown>;
  const out: NoteAnchor = {};
  if (typeof o.feature === "string" && o.feature.trim()) out.feature = o.feature.trim();
  if (typeof o.sketch === "string" && o.sketch.trim()) out.sketch = o.sketch.trim();
  if (o.point !== undefined) {
    if (!isV3(o.point)) throw new Error("anchor.point needs finite x, y and z (world mm)");
    out.point = { x: o.point.x, y: o.point.y, z: o.point.z };
  }
  if (o.view !== undefined) {
    const v = o.view as Record<string, unknown>;
    if (!isV3(v?.position) || !isV3(v?.target)) throw new Error("anchor.view needs position and target, each {x, y, z}");
    out.view = { position: { ...v.position }, target: { ...v.target }, up: isV3(v.up) ? { ...v.up } : { x: 0, y: 0, z: 1 } } as NoteView;
  }
  return Object.keys(out).length ? out : undefined;
}

/** What an anchor points at that the document doesn't have (for a warning, not an error). */
export function missingAnchor(doc: CadDocument, a: NoteAnchor | undefined): string | null {
  if (a?.feature && !doc.features[a.feature]) return `feature "${a.feature}"`;
  if (a?.sketch && !doc.sketches[a.sketch]) return `sketch "${a.sketch}"`;
  return null;
}

// ---- reading notes back ----

export const notesOf = (doc: CadDocument): Note[] => doc.notes ?? [];
export const findNote = (doc: CadDocument, id: string): Note | undefined => notesOf(doc).find((n) => n.id === id);

/** The first line of the body, plain, for a list row. */
export function excerpt(body: string, max = 90): string {
  const line = body.split("\n").map((l) => l.replace(/[*_`#>]/g, "").replace(/^\s*[-+] /, "").trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** One row of notes_list. */
export function noteSummary(n: Note): Record<string, unknown> {
  return {
    id: n.id, title: n.title, author: n.author, createdAt: n.createdAt, updatedAt: n.updatedAt,
    ...(n.updatedBy ? { updatedBy: n.updatedBy } : {}),
    excerpt: excerpt(n.body),
    ...(n.anchor ? { anchor: { ...n.anchor, ...(n.anchor.view ? { view: true } : {}) } } : {}),
    strokes: n.drawing?.strokes.length ?? 0,
    hasBackground: !!n.drawing?.background,
  };
}

/** notes_get's answer: the note with each stroke as path data in the 1000×1000 space (the background,
 *  when there is one, goes back as an image beside this). */
export function noteDetail(n: Note): Record<string, unknown> {
  return {
    id: n.id, title: n.title, body: n.body, author: n.author, createdAt: n.createdAt, updatedAt: n.updatedAt,
    ...(n.updatedBy ? { updatedBy: n.updatedBy } : {}),
    ...(n.anchor ? { anchor: n.anchor } : {}),
    drawing: n.drawing
      ? {
        space: `${NOTE_SPACE}x${NOTE_SPACE}, origin top-left, y down`,
        strokes: n.drawing.strokes.map((s) => ({ color: s.color, width: s.width, path: strokePath(s) })),
        background: n.drawing.background ? "attached as an image" : "none (blank canvas)",
      }
      : null,
  };
}

/** The author of a change made through an agent surface: "agent" unless the agent named itself. */
export function withAgentAuthor(type: string, params: Record<string, unknown>): Record<string, unknown> {
  if (!type.startsWith("note.") || type === "note.delete") return params;
  return typeof params.author === "string" && params.author.trim() ? params : { ...params, author: "agent" };
}

/** Split a data URL into what an MCP image block wants. */
export function dataUrlParts(src: string): { mimeType: string; data: string } | null {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(src);
  return m ? { mimeType: m[1], data: m[2].replace(/\s+/g, "") } : null;
}
