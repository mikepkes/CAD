// Shop drawings from the parametric model: a builder's cut list and orthographic
// (third-angle) views, both derived straight from the component/geometry model so
// they stay in sync with the parameters. This is the foundation for producing
// buildable drawings — a flat SVG sheet, no rendering, so it is cheap and exact.
//
// Dimensions in the cut list are each part's OWN box (measured in the component's
// local frame), so a rotated part — a canted handle, a tilted brace — still
// reports true stock sizes. The views use the finished body edges in world space.
import { CadDocument, materialForComponent } from "./document";
import { evaluateFeatures, type SolidEval } from "./features";
import { placeComponentSketches, resolveComponentWorld } from "./recompute";
import { invert, applyPoint, Rigid } from "../math/transform";
import type { Scope } from "../math/expr";

export interface CutPart {
  part: string;        // grouped part name (instance suffixes stripped)
  qty: number;
  material: string;
  kind: string;        // wood | metal | plastic | painted | rubber | printed | —
  thickness: number;   // mm, smallest dimension
  width: number;       // mm, middle dimension
  length: number;      // mm, largest dimension
}

/** Strip a trailing instance token so "Leg FL"/"Leg FR" group as "Leg",
 *  "Top 1".."Top 4" as "Top", "Wheel handle 1" as "Wheel handle". */
function partName(n: string): string {
  return n.replace(/[\s#]+([0-9]+|[A-Z]{1,2})$/, "").trim() || n;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** A builder's cut list: each distinct part with finished dimensions (mm),
 *  material and quantity. The doc should already be recomputed/placed. `built`: its bodies, when already evaluated. */
export function cutList(doc: CadDocument, scope: Scope, built?: Record<string, SolidEval>): CutPart[] {
  placeComponentSketches(doc, scope);
  const solids = Object.values(built ?? evaluateFeatures(doc, scope)).filter((b) => b.mesh && b.bounds);
  const worlds = resolveComponentWorld(doc, scope);

  // Union each component's solids into one box, measured in its own local frame.
  const box = new Map<string, { min: number[]; max: number[] }>();
  for (const b of solids) {
    const cid = doc.sketches[b.sketchId]?.componentId;
    if (!cid) continue;
    const W = worlds.get(cid);
    const Winv: Rigid | undefined = W ? invert(W) : undefined;
    const pos = b.mesh!.positions;
    let rec = box.get(cid);
    if (!rec) { rec = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; box.set(cid, rec); }
    for (let i = 0; i < pos.length; i += 3) {
      let p = { x: pos[i], y: pos[i + 1], z: pos[i + 2] };
      if (Winv) p = applyPoint(Winv, p);
      const a = [p.x, p.y, p.z];
      for (let k = 0; k < 3; k++) { if (a[k] < rec.min[k]) rec.min[k] = a[k]; if (a[k] > rec.max[k]) rec.max[k] = a[k]; }
    }
  }

  // One row per component, then group identical (name + material + dims).
  const grouped = new Map<string, CutPart>();
  for (const [cid, rec] of box) {
    const comp = doc.components[cid];
    if (!comp) continue;
    const dims = [rec.max[0] - rec.min[0], rec.max[1] - rec.min[1], rec.max[2] - rec.min[2]].map(r1).sort((a, b) => a - b);
    const mat = materialForComponent(doc, cid);
    const name = partName(comp.name);
    const key = `${name}|${mat?.name ?? "—"}|${dims.join("x")}`;
    const g = grouped.get(key);
    if (g) g.qty += 1;
    else grouped.set(key, { part: name, qty: 1, material: mat?.name ?? "—", kind: mat?.kind ?? "—", thickness: dims[0], width: dims[1], length: dims[2] });
  }

  // Wood first (longest first), then other materials.
  return [...grouped.values()].sort((a, b) =>
    (a.kind === "wood" ? 0 : 1) - (b.kind === "wood" ? 0 : 1) || b.length - a.length || a.part.localeCompare(b.part));
}

export type ViewDir = "front" | "top" | "right";
type Seg = [[number, number], [number, number]];

/** Project a world point to a view's 2D (u right, v up). Third-angle:
 *  front looks along −Y (XZ), top looks along −Z (XY), right looks along −X (YZ). */
function project(x: number, y: number, z: number, view: ViewDir): [number, number] {
  if (view === "front") return [x, z];
  if (view === "top") return [x, y];
  return [y, z]; // right
}

/** Orthographic line segments for one view, from the finished body edges. */
export function viewSegments(doc: CadDocument, scope: Scope, view: ViewDir, built?: Record<string, SolidEval>): Seg[] {
  placeComponentSketches(doc, scope);
  const solids = Object.values(built ?? evaluateFeatures(doc, scope)).filter((b) => b.mesh);
  const segs: Seg[] = [];
  for (const b of solids) {
    const e = b.mesh!.edges;
    for (let i = 0; i + 5 < e.length; i += 6) {
      segs.push([project(e[i], e[i + 1], e[i + 2], view), project(e[i + 3], e[i + 4], e[i + 5], view)]);
    }
  }
  return segs;
}

interface Box2 { minU: number; minV: number; maxU: number; maxV: number; }
function boundsOf(segs: Seg[]): Box2 {
  const b: Box2 = { minU: Infinity, minV: Infinity, maxU: -Infinity, maxV: -Infinity };
  for (const [[u1, v1], [u2, v2]] of segs) {
    b.minU = Math.min(b.minU, u1, u2); b.maxU = Math.max(b.maxU, u1, u2);
    b.minV = Math.min(b.minV, v1, v2); b.maxV = Math.max(b.maxV, v1, v2);
  }
  return b;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

export interface SheetOptions { title?: string; units?: string; }

export interface SheetLayout {
  /** Paper units per model mm. */
  scale: number;
  /** Top-left of each view on the paper. */
  front: { x: number; y: number };
  top: { x: number; y: number };
  right: { x: number; y: number };
  /** Where the cut list goes: under the views, in a column at the right, or in the corner the third-angle
   *  arrangement leaves empty (right of the top view, above the right view). */
  table: { x: number; y: number; w: number; place: "below" | "side" | "corner" };
}

/** The cut list's width when it is a column (part, qty, material, three dimensions). */
export const CUT_LIST_COLUMN_W = 440;

/** Where the views and the cut list go: whichever of three arrangements draws the views largest — the list under
 *  them, in a column at the right, or in the corner third-angle leaves empty — with the views centred in what is
 *  left. View sizes are in model mm (0 for a view that isn't drawn); everything else in paper units. Pure. */
export function sheetLayout(o: { sheet: { w: number; h: number }; margin: number; gap: number; titleH: number; tableH: number; views: { fW: number; fH: number; rW: number; tH: number } }): SheetLayout {
  const { sheet, margin: M, gap, titleH, tableH } = o;
  const { fW, fH, rW, tH } = o.views;
  const TW = CUT_LIST_COLUMN_W;
  const inner = { x: M, y: M + titleH, w: sheet.w - 2 * M, h: sheet.h - 2 * M - titleH };
  type Place = SheetLayout["table"]["place"];
  /** The views block's size at a scale (the table counted in for "corner"). */
  const block = (sc: number, place: Place) => {
    const topH = tH ? sc * tH : 0, rightW = rW ? sc * rW : 0;
    if (place === "corner") {
      const col = Math.max(rightW, TW), row = Math.max(topH, tableH);
      return { w: sc * fW + gap + col, h: sc * fH + gap + row, row };
    }
    return { w: sc * fW + (rW ? gap + rightW : 0), h: sc * fH + (tH ? gap + topH : 0), row: topH };
  };
  const areaOf = (place: Place) => place === "below" ? { ...inner, h: inner.h - tableH - gap } : place === "side" ? { ...inner, w: inner.w - TW - gap } : inner;
  /** The largest scale whose block fits the area (bisection: the block grows with the scale). */
  const fit = (place: Place) => {
    const area = areaOf(place);
    if (area.w <= 0 || area.h <= 0) return 0;
    let lo = 0, hi = 4;
    for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2, b = block(mid, place); if (b.w <= area.w && b.h <= area.h) lo = mid; else hi = mid; }
    return lo;
  };
  const sideFits = tableH <= inner.h;
  const options: Place[] = ["below", ...(sideFits ? (["side", "corner"] as Place[]) : [])];
  // the first that is clearly better wins: the list under the views stays the default
  let place: Place = "below", best = fit("below");
  for (const p of options.slice(1)) { const f = fit(p); if (f > best * 1.05) { best = f; place = p; } }
  const scale = best * 0.95;
  const area = areaOf(place), b = block(scale, place);
  const x0 = area.x + (area.w - b.w) / 2, y0 = area.y + (area.h - b.h) / 2;
  const topH = tH ? scale * tH : 0;
  const frontY = y0 + (tH || place === "corner" ? b.row + gap : 0);
  const front = { x: x0, y: frontY };
  const top = { x: x0, y: frontY - gap - topH };
  const right = { x: x0 + scale * fW + gap, y: frontY };
  const table = place === "below" ? { x: M, y: sheet.h - M - tableH + 18, w: sheet.w - 2 * M, place }
    : place === "side" ? { x: sheet.w - M - TW, y: inner.y + 18, w: TW, place }
    : { x: right.x, y: y0 + 18, w: TW, place };
  return { scale, front, top, right, table };
}

/** A full third-angle drawing sheet (SVG): front / top / right views, each with
 *  overall dimensions, a title block, and the cut list as a table. Pure string
 *  output — no DOM, no kernel beyond the geometry already evaluated. The bodies are built once (or passed in,
 *  `built`) and read by every view and the cut list. */
export function drawingSheetSVG(doc: CadDocument, scope: Scope, opts: SheetOptions = {}, built?: Record<string, SolidEval>): string {
  if (!built) placeComponentSketches(doc, scope);
  const solids = built ?? evaluateFeatures(doc, scope);
  const title = opts.title ?? "Drawing";
  const units = opts.units ?? "mm";
  const views: { dir: ViewDir; label: string; segs: Seg[]; box: Box2 }[] = (["front", "top", "right"] as ViewDir[])
    .map((dir) => { const segs = viewSegments(doc, scope, dir, solids); return { dir, label: dir[0].toUpperCase() + dir.slice(1), segs, box: boundsOf(segs) }; })
    .filter((v) => v.segs.length > 0 && Number.isFinite(v.box.minU));

  // sheet layout (mm of paper). A4 landscape-ish; the views are scaled to fit the drawing area and centred in
  // it. The cut list goes under the views or, when that leaves them bigger (a long list, a wide model), in a
  // column on the right: whichever uses the sheet better.
  const SHEET_W = 1120, SHEET_H = 790, M = 30, GAP = 40, TITLE_H = 44, ROW = 18;
  const cutRows = cutList(doc, scope, solids);
  const tableH = 18 + 24 + (cutRows.length + 1) * ROW + 10; // its heading, the header row, the rows
  // two columns (front+right side by side, top above front) → need ~ (frontW+rightW) x (frontH+topH)
  const front = views.find((v) => v.dir === "front")!;
  const top = views.find((v) => v.dir === "top");
  const right = views.find((v) => v.dir === "right");
  const fW = front.box.maxU - front.box.minU, fH = front.box.maxV - front.box.minV;
  const rW = right ? right.box.maxU - right.box.minU : 0;
  const tH = top ? top.box.maxV - top.box.minV : 0;
  const layout = sheetLayout({ sheet: { w: SHEET_W, h: SHEET_H }, margin: M, gap: GAP, titleH: TITLE_H, tableH, views: { fW, fH, rW, tH } });
  const scale = layout.scale;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SHEET_W} ${SHEET_H}" font-family="Helvetica,Arial,sans-serif">`);
  parts.push(`<rect x="0" y="0" width="${SHEET_W}" height="${SHEET_H}" fill="#ffffff"/>`);
  parts.push(`<rect x="8" y="8" width="${SHEET_W - 16}" height="${SHEET_H - 16}" fill="none" stroke="#111" stroke-width="2"/>`);

  // place a view: map model (u,v) → paper (x,y) with y flipped, return origin+drawn size
  const drawView = (v: { label: string; segs: Seg[]; box: Box2 }, ox: number, oy: number, dimH = false, dimV = false) => {
    const w = (v.box.maxU - v.box.minU) * scale, h = (v.box.maxV - v.box.minV) * scale;
    const X = (u: number) => ox + (u - v.box.minU) * scale;
    const Y = (vv: number) => oy + (v.box.maxV - vv) * scale; // flip
    const g: string[] = [`<g>`];
    for (const [[u1, vv1], [u2, vv2]] of v.segs) {
      g.push(`<line x1="${r1(X(u1))}" y1="${r1(Y(vv1))}" x2="${r1(X(u2))}" y2="${r1(Y(vv2))}" stroke="#111" stroke-width="0.6"/>`);
    }
    g.push(`<text x="${r1(ox)}" y="${r1(oy + h + 16)}" font-size="13" fill="#111" font-weight="bold">${esc(v.label)}</text>`);
    // overall dimensions
    const dim = (x1: number, y1: number, x2: number, y2: number, label: string, below: boolean) => {
      const off = 14; const vert = x1 === x2;
      if (vert) {
        const xx = x1 + (below ? off : -off);
        g.push(`<line x1="${r1(xx)}" y1="${r1(y1)}" x2="${r1(xx)}" y2="${r1(y2)}" stroke="#c00" stroke-width="0.5"/>`);
        g.push(`<text x="${r1(xx + 3)}" y="${r1((y1 + y2) / 2)}" font-size="11" fill="#c00" transform="rotate(90 ${r1(xx + 3)} ${r1((y1 + y2) / 2)})" text-anchor="middle">${esc(label)}</text>`);
      } else {
        const yy = y1 + (below ? off : -off);
        g.push(`<line x1="${r1(x1)}" y1="${r1(yy)}" x2="${r1(x2)}" y2="${r1(yy)}" stroke="#c00" stroke-width="0.5"/>`);
        g.push(`<text x="${r1((x1 + x2) / 2)}" y="${r1(yy - 3)}" font-size="11" fill="#c00" text-anchor="middle">${esc(label)}</text>`);
      }
    };
    if (dimH) dim(ox, oy + h, ox + w, oy + h, `${r1(v.box.maxU - v.box.minU)}`, true);
    if (dimV) dim(ox, oy, ox, oy + h, `${r1(v.box.maxV - v.box.minV)}`, false);
    g.push(`</g>`);
    return { svg: g.join(""), w, h };
  };

  // third-angle: top above front, right to the right of front; placed by sheetLayout
  const f = drawView(front, layout.front.x, layout.front.y, true, true);
  parts.push(f.svg);
  if (top) parts.push(drawView(top, layout.top.x, layout.top.y).svg);
  if (right) parts.push(drawView(right, layout.right.x, layout.right.y, false, true).svg);

  // ---- cut list table ----
  const tb = layout.table;
  const tY = tb.y;
  const colX = (tb.place !== "below" ? [0, 140, 172, 280, 330, 380] : [0, 222, 292, 412, 512, 632]).map((x) => tb.x + 8 + x);
  const heads = ["Part", "Qty", "Material", "Thick", "Width", "Length"];
  parts.push(`<text x="${tb.x + 8}" y="${tY - 6}" font-size="14" font-weight="bold" fill="#111">Cut list (${esc(units)})</text>`);
  parts.push(`<line x1="${tb.x}" y1="${tY}" x2="${tb.x + tb.w}" y2="${tY}" stroke="#111" stroke-width="1"/>`);
  heads.forEach((h, i) => parts.push(`<text x="${colX[i]}" y="${tY + 16}" font-size="12" font-weight="bold" fill="#111">${esc(h)}</text>`));
  parts.push(`<line x1="${tb.x}" y1="${tY + 22}" x2="${tb.x + tb.w}" y2="${tY + 22}" stroke="#111" stroke-width="0.5"/>`);
  cutRows.forEach((row, i) => {
    const y = tY + 22 + (i + 1) * ROW;
    const cells = [row.part, String(row.qty), row.material, `${r1(row.thickness)}`, `${r1(row.width)}`, `${r1(row.length)}`];
    cells.forEach((c, j) => parts.push(`<text x="${colX[j]}" y="${y}" font-size="11" fill="#222">${esc(c)}</text>`));
  });

  // ---- title block ----
  // the title block hangs from the right margin, so a wider font (a PDF rasteriser's) can't push it off the sheet
  parts.push(`<text x="${SHEET_W - M}" y="${M + 4}" text-anchor="end" font-size="18" font-weight="bold" fill="#111">${esc(title)}</text>`);
  parts.push(`<text x="${SHEET_W - M}" y="${M + 22}" text-anchor="end" font-size="11" fill="#555">Third-angle projection · units ${esc(units)} · generated from the parametric model</text>`);
  parts.push(`</svg>`);
  return parts.join("\n");
}
