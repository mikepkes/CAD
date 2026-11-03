// Shop drawings from the parametric model: a builder's cut list and orthographic
// (third-angle) views, both derived straight from the component/geometry model so
// they stay in sync with the parameters. This is the foundation for producing
// buildable drawings — a flat SVG sheet, no rendering, so it is cheap and exact.
//
// Dimensions in the cut list are each part's OWN box (measured in the component's
// local frame), so a rotated part — a canted handle, a tilted brace — still
// reports true stock sizes. The views use the finished body edges in world space.
//
// On top of the automatic sheet go the annotations placed by hand (doc.drafting):
// dimensions that name the edges and vertices they measure, section views cut
// along a line on a view and cross-hatched, and enlarged details. Those read the
// model by name through the kernel (drawingModel); their 2D geometry and SVG are
// in drawingAnnotations.ts.
import { CadDocument, materialForComponent, type DimensionKind, type DrawingDimension, type DrawingRef } from "./document";
import { evaluateBodies, evaluateFeatures, GeometryCache, type SolidEval } from "./features";
import { placeComponentSketches, resolveComponentWorld } from "./recompute";
import { boundsOfShape, edgeLines, isKernelReady } from "./occ/kernel";
import { namedTopology, sectionOfShape, type NamedEdge, type NamedVertex } from "./occ/drawing";
import {
  ORTHO_FRAMES, DIM, HATCH_ANGLES, PAPER_PER_MM, angleArc, brokenDimSvg, clipToCircle, dimensionAnchor, dimensionSvg, dimensionText, edgeFeature,
  hatchSegments, linearDimSvg, measureDimension, projectTo, sectionFrame, sectionLineSvg,
  type Feature2, type Measured, type P2, type Seg, type ViewFrame,
} from "./drawingAnnotations";
import { invert, applyPoint, Rigid } from "../math/transform";
import type { Vec3 } from "../math/vec";
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
  /** Top-left of each extra view (sections, details), in rows under the front and right views. */
  extras: { x: number; y: number }[];
}

/** How much further than the gap between views the extra views' rows sit under the front view: room for its
 *  overall dimension and its name. */
const EXTRAS_DROP = 24;

/** The cut list's width when it is a column (part, qty, material, three dimensions). */
export const CUT_LIST_COLUMN_W = 440;

/** Where the views and the cut list go: whichever of three arrangements draws the views largest — the list under
 *  them, in a column at the right, or in the corner third-angle leaves empty — with the views centred in what is
 *  left. Extra views (sections, details: `extras`, each its size at the views' scale) go in rows under the front
 *  and right views, as many to a row as fit. View sizes are in model mm (0 for a view that isn't drawn);
 *  everything else in paper units. Pure. */
export function sheetLayout(o: { sheet: { w: number; h: number }; margin: number; gap: number; titleH: number; tableH: number; views: { fW: number; fH: number; rW: number; tH: number }; extras?: { w: number; h: number }[] }): SheetLayout {
  const { sheet, margin: M, gap, titleH, tableH } = o;
  const { fW, fH, rW, tH } = o.views;
  const extras = o.extras ?? [];
  const TW = CUT_LIST_COLUMN_W;
  const inner = { x: M, y: M + titleH, w: sheet.w - 2 * M, h: sheet.h - 2 * M - titleH };
  type Place = SheetLayout["table"]["place"];
  /** The extra views in rows no wider than `maxW` (one to a row at least): each one's place from the rows'
   *  top-left, and the rows' size. */
  const rows = (sc: number, maxW: number) => {
    const at: { x: number; y: number }[] = [];
    let x = 0, y = 0, rowH = 0, w = 0;
    for (const e of extras) {
      const ew = sc * e.w, eh = sc * e.h;
      if (x > 0 && x + ew > maxW) { y += rowH + gap; x = 0; rowH = 0; }
      at.push({ x, y });
      x += ew + gap; rowH = Math.max(rowH, eh); w = Math.max(w, x - gap);
    }
    return { at, w, h: extras.length ? y + rowH : 0 };
  };
  /** The views block's size at a scale (the table counted in for "corner"; the extra views' rows under it). */
  const block = (sc: number, place: Place, maxW: number) => {
    const topH = tH ? sc * tH : 0, rightW = rW ? sc * rW : 0;
    const main = place === "corner"
      ? { w: sc * fW + gap + Math.max(rightW, TW), h: sc * fH + gap + Math.max(topH, tableH), row: Math.max(topH, tableH) }
      : { w: sc * fW + (rW ? gap + rightW : 0), h: sc * fH + (tH ? gap + topH : 0), row: topH };
    if (!extras.length) return { ...main, extras: rows(sc, maxW) };
    const ex = rows(sc, Math.max(maxW, main.w));
    return { w: Math.max(main.w, ex.w), h: main.h + gap + EXTRAS_DROP + ex.h, row: main.row, extras: ex };
  };
  const areaOf = (place: Place) => place === "below" ? { ...inner, h: inner.h - tableH - gap } : place === "side" ? { ...inner, w: inner.w - TW - gap } : inner;
  /** The largest scale whose block fits the area (bisection: the block grows with the scale). */
  const fit = (place: Place) => {
    const area = areaOf(place);
    if (area.w <= 0 || area.h <= 0) return 0;
    let lo = 0, hi = 4;
    for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2, b = block(mid, place, area.w); if (b.w <= area.w && b.h <= area.h) lo = mid; else hi = mid; }
    return lo;
  };
  const sideFits = tableH <= inner.h;
  const options: Place[] = ["below", ...(sideFits ? (["side", "corner"] as Place[]) : [])];
  // the first that is clearly better wins: the list under the views stays the default
  let place: Place = "below", best = fit("below");
  for (const p of options.slice(1)) { const f = fit(p); if (f > best * 1.05) { best = f; place = p; } }
  const scale = best * 0.95;
  const area = areaOf(place), b = block(scale, place, area.w);
  const x0 = area.x + (area.w - b.w) / 2, y0 = area.y + (area.h - b.h) / 2;
  const topH = tH ? scale * tH : 0;
  const frontY = y0 + (tH || place === "corner" ? b.row + gap : 0);
  const rowsY = frontY + scale * fH + gap + EXTRAS_DROP;
  const extraAt = b.extras.at.map((p) => ({ x: x0 + p.x, y: rowsY + p.y }));
  const front = { x: x0, y: frontY };
  const top = { x: x0, y: frontY - gap - topH };
  const right = { x: x0 + scale * fW + gap, y: frontY };
  const table = place === "below" ? { x: M, y: sheet.h - M - tableH + 18, w: sheet.w - 2 * M, place }
    : place === "side" ? { x: sheet.w - M - TW, y: inner.y + 18, w: TW, place }
    : { x: right.x, y: y0 + 18, w: TW, place };
  return { scale, front, top, right, table, extras: extraAt };
}


// ---- the model by name: what dimensions measure and sections cut ---------------

/** What the drawing's annotations need from the kernel: each body's edges and vertices by topological name
 *  (world space), and each section view's cut — per body, the half looked at (edge segments, flat xyz pairs)
 *  and the outlines of the faces the cut made. */
export interface DrawingModel {
  bodies: { id: string; edges: NamedEdge[]; vertices: NamedVertex[] }[];
  sections: Record<string, { id: string; edges: Float32Array; caps: Vec3[][] }[]>;
}

/** Sections cut before, by the body's content signature, where it sits and the plane (null: nothing of it is on
 *  the side looked at): drawing again — a dimension added, the drawing reopened — cuts only what changed. Bodies
 *  built without a cache have no signature and are cut every time. */
const SECTION_CUTS = new Map<string, { edges: Float32Array; caps: Vec3[][] } | null>();

/** The drawing model of a document (placed). The bodies come through `cache` when given, so the model on screen
 *  replays rather than rebuilds. That is a pass inside the evaluation that built it, not one of its own: it
 *  starts no cache generation, so it evicts nothing (the cached meshes it doesn't read stay). A section keeps a
 *  body wholly on the side it looks at whole and leaves out one wholly behind the cut; only a body the plane
 *  crosses is cut. Empty while the kernel isn't loaded. */
export function drawingModel(doc: CadDocument, scope: Scope, cache?: GeometryCache): DrawingModel {
  const out: DrawingModel = { bodies: [], sections: {} };
  if (!isKernelReady()) return out;
  const bodies = evaluateBodies(doc, scope, cache).bodies;
  try {
    for (const b of bodies) {
      try { out.bodies.push({ id: b.id, ...namedTopology(b.shape, b.faceNames) }); } catch { out.bodies.push({ id: b.id, edges: [], vertices: [] }); }
    }
    for (const sec of doc.drafting?.sections ?? []) {
      const { origin, frame } = sectionFrame(ORTHO_FRAMES[sec.base], sec.from, sec.to, sec.flip);
      const n = frame.d, cut: DrawingModel["sections"][string] = [];
      const plane = [origin.x, origin.y, origin.z, n.x, n.y, n.z].map((v) => v.toFixed(6)).join(",");
      for (const b of bodies) {
        // a signature names the content in its own frame (the same body moved has the same one): the frame too
        const key = b.sig ? `${b.sig}|${JSON.stringify(b.frame ?? null, (_k, v) => (typeof v === "number" ? Number(v.toFixed(9)) : v))}|${plane}` : undefined;
        const known = key ? SECTION_CUTS.get(key) : undefined;
        if (known !== undefined) { if (known) cut.push({ id: b.id, ...known }); continue; }
        const remember = (c: { edges: Float32Array; caps: Vec3[][] } | null) => {
          if (!key) return;
          if (SECTION_CUTS.size >= 256) SECTION_CUTS.delete(SECTION_CUTS.keys().next().value!);
          SECTION_CUTS.set(key, c);
        };
        try {
          const bb = boundsOfShape(b.shape);
          let lo = Infinity, hi = -Infinity;
          for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) {
            const t = (x - origin.x) * n.x + (y - origin.y) * n.y + (z - origin.z) * n.z;
            lo = Math.min(lo, t); hi = Math.max(hi, t);
          }
          const tol = 1e-6 * Math.max(1, hi - lo);
          if (hi <= tol) { remember(null); continue; } // wholly behind the cut
          const c = lo >= -tol ? { edges: edgeLines(b.shape), caps: [] } : sectionOfShape(b.shape, origin, n);
          remember(c ?? null);
          if (c) cut.push({ id: b.id, ...c });
        } catch { /* a body the kernel can't cut is left out of the section */ }
      }
      out.sections[sec.id] = cut;
    }
  } finally {
    for (const b of bodies) { try { b.shape.delete(); } catch { /* already freed */ } }
  }
  return out;
}

// ---- the sheet -------------------------------------------------------------------

/** A view on the sheet: where its frame sits (paper) and how view coordinates map onto it:
 *  x = this.x + (u − minU)·scale, y = this.y + (maxV − v)·scale. */
export interface SheetViewInfo { id: string; label: string; kind: "ortho" | "section" | "detail"; base?: string; x: number; y: number; w: number; h: number; scale: number; minU: number; maxV: number }
/** Something a dimension can be placed on, as a view sees it. */
export interface PickTarget { ref: DrawingRef; f: Feature2 }
/** A placed dimension as drawn: its value and text, or why it is broken. */
export interface DimensionStatus { id: string; view: string; kind: DimensionKind; value?: number; text?: string; broken?: string }
/** What the app needs to place annotations on the drawn sheet: the views, what can be picked in each, and each
 *  dimension's state. */
export interface SheetInfo { views: SheetViewInfo[]; picks: Record<string, PickTarget[]>; dimensions: DimensionStatus[] }
/** A shop drawing as the geometry backend returns it: the sheet, the cut list, and the sheet's annotation info. */
export interface ShopDrawing { svg: string; parts: CutPart[]; sheet: SheetInfo }

/** A view before it is placed. Detail views carry their base view's lines and caps, unclipped, and `clip`. */
interface ViewDraft {
  id: string; label: string; kind: SheetViewInfo["kind"]; base?: string;
  frame: ViewFrame;
  segs: Seg[];
  /** The faces a section cut, by part: outlines, hatched at the part's angle. */
  caps: { part: number; segs: Seg[] }[];
  /** The geometry's extent, and the frame placed on the sheet (the geometry and its dimensions). */
  box: Box2; frameBox: Box2;
  zoom: number;
  clip?: { c: P2; r: number };
  /** A section's side: whether a model point is in what it shows. */
  keeps?: (p: Vec3) => boolean;
}

const grow = (b: Box2, [u, v]: P2) => { b.minU = Math.min(b.minU, u); b.maxU = Math.max(b.maxU, u); b.minV = Math.min(b.minV, v); b.maxV = Math.max(b.maxV, v); };
const flatSegs = (e: Float32Array, frame: ViewFrame): Seg[] => {
  const out: Seg[] = [];
  for (let i = 0; i + 5 < e.length; i += 6) out.push([projectTo(frame, { x: e[i], y: e[i + 1], z: e[i + 2] }), projectTo(frame, { x: e[i + 3], y: e[i + 4], z: e[i + 5] })]);
  return out;
};
const polySegs = (pts: P2[]): Seg[] => pts.slice(1).map((p, i) => [pts[i], p] as Seg);
/** Hatch line spacing on paper (2.5 mm). */
const HATCH_PAPER = 2.5 * PAPER_PER_MM;

/** A full third-angle drawing sheet (SVG): front / top / right views, each with
 *  overall dimensions, a title block, and the cut list as a table. Pure string
 *  output — no DOM, no kernel beyond the geometry already evaluated. The bodies are built once (or passed in,
 *  `built`) and read by every view and the cut list. The drawing's placed dimensions, section and detail views
 *  read `model` (made here, without a cache, when the document has any and none is given). */
export function drawingSheetSVG(doc: CadDocument, scope: Scope, opts: SheetOptions = {}, built?: Record<string, SolidEval>, model?: DrawingModel): string {
  return drawingSheet(doc, scope, opts, built, model).svg;
}

/** The drawing sheet (see drawingSheetSVG) and what the app needs to place annotations on it. */
export function drawingSheet(doc: CadDocument, scope: Scope, opts: SheetOptions = {}, built?: Record<string, SolidEval>, model?: DrawingModel): { svg: string; sheet: SheetInfo } {
  if (!built) placeComponentSketches(doc, scope);
  const drafting = doc.drafting;
  const annotated = !!drafting && (drafting.dimensions.length + drafting.sections.length + drafting.details.length) > 0;
  // building both the bodies and the model here: the model replays the bodies' build
  const once = !built && !model && annotated ? new GeometryCache() : undefined;
  let solids: Record<string, SolidEval>, m: DrawingModel;
  try {
    solids = built ?? evaluateFeatures(doc, scope, once);
    m = model ?? (annotated ? drawingModel(doc, scope, once) : { bodies: [], sections: {} });
  } finally { once?.clear(); }
  const title = opts.title ?? "Drawing";
  const units = opts.units ?? "mm";

  // ---- the views, before they are placed ----
  const drafts: ViewDraft[] = [];
  for (const dir of ["front", "top", "right"] as ViewDir[]) {
    const segs = viewSegments(doc, scope, dir, solids), box = boundsOf(segs);
    if (segs.length && Number.isFinite(box.minU)) drafts.push({ id: dir, label: dir[0].toUpperCase() + dir.slice(1), kind: "ortho", frame: ORTHO_FRAMES[dir], segs, caps: [], box, frameBox: { ...box }, zoom: 1 });
  }
  const byId = (id: string) => drafts.find((v) => v.id === id);
  for (const sec of drafting?.sections ?? []) {
    if (!byId(sec.base)) continue;
    const { origin, frame } = sectionFrame(ORTHO_FRAMES[sec.base], sec.from, sec.to, sec.flip);
    const cut = m.sections[sec.id] ?? [];
    const segs = cut.flatMap((c) => flatSegs(c.edges, frame));
    // each part the plane cut, hatched at the next angle (so parts that touch read apart)
    const caps = cut.filter((c) => c.caps.length).map((c, part) => ({ part, segs: c.caps.flatMap((loop) => polySegs(loop.map((p) => projectTo(frame, p)))) }));
    const box = boundsOf([...segs, ...caps.flatMap((c) => c.segs)]);
    if (!Number.isFinite(box.minU)) continue;
    const span = Math.max(box.maxU - box.minU, box.maxV - box.minV);
    const keeps = (p: Vec3) => (p.x - origin.x) * frame.d.x + (p.y - origin.y) * frame.d.y + (p.z - origin.z) * frame.d.z >= -1e-6 * Math.max(1, span);
    drafts.push({ id: sec.id, label: `SECTION ${sec.label}–${sec.label}`, kind: "section", base: sec.base, frame, segs, caps, box, frameBox: { ...box }, zoom: 1, keeps });
  }
  for (const det of drafting?.details ?? []) {
    const base = byId(det.base);
    if (!base || base.kind === "detail") continue;
    const c: P2 = [det.center.u, det.center.v], r = det.radius;
    const box = { minU: c[0] - r, maxU: c[0] + r, minV: c[1] - r, maxV: c[1] + r };
    drafts.push({ id: det.id, label: `DETAIL ${det.label} (${r1(det.scale)}×)`, kind: "detail", base: base.id, frame: base.frame, segs: base.segs, caps: base.caps, box, frameBox: { ...box }, zoom: det.scale, clip: { c, r }, keeps: base.keeps });
  }

  // ---- what can be picked in each view, and so what each dimension measures ----
  const named = new Map(m.bodies.map((b) => [b.id, { edges: new Map(b.edges.map((e) => [e.name, e])), vertices: new Map(b.vertices.map((v) => [v.name, v])) }]));
  const featureOf = (view: ViewDraft, ref: DrawingRef): Feature2 | string => {
    const b = named.get(ref.body);
    if (!b) return m.bodies.length ? `there is no body ${ref.body}` : "the model's edges aren't known (the kernel isn't loaded)";
    if ("edge" in ref) { const e = b.edges.get(ref.edge); return e ? edgeFeature(view.frame, e) : `${ref.body} has no edge ${ref.edge}`; }
    const v = b.vertices.get(ref.vertex);
    return v ? { kind: "point", p: projectTo(view.frame, v.at) } : `${ref.body} has no vertex ${ref.vertex}`;
  };
  const picks: Record<string, PickTarget[]> = {};
  for (const view of drafts) {
    const list: PickTarget[] = [];
    const inClip = (f: Feature2) => {
      if (!view.clip) return true;
      const { c, r } = view.clip;
      const inside = (p: P2) => Math.hypot(p[0] - c[0], p[1] - c[1]) <= r;
      return f.kind === "point" ? inside(f.p) : f.kind === "segment" ? !!clipToCircle([f.a, f.b], c, r) : f.pts.some(inside);
    };
    for (const b of m.bodies) {
      for (const e of b.edges) {
        if (view.keeps && !e.pts.some(view.keeps)) continue;
        const f = edgeFeature(view.frame, e);
        if (inClip(f)) list.push({ ref: { body: b.id, edge: e.name }, f });
      }
      for (const v of b.vertices) {
        if (view.keeps && !view.keeps(v.at)) continue;
        const f: Feature2 = { kind: "point", p: projectTo(view.frame, v.at) };
        if (inClip(f)) list.push({ ref: { body: b.id, vertex: v.name }, f });
      }
    }
    picks[view.id] = list;
  }

  type Placed = { dim: DrawingDimension; view?: ViewDraft; measured: Measured; text?: string };
  const placed: Placed[] = (drafting?.dimensions ?? []).map((dim) => {
    const view = byId(dim.view);
    if (!view) return { dim, measured: { ok: false, reason: `there is no view ${dim.view}` } };
    const fs = dim.refs.map((r) => featureOf(view, r));
    const missing = fs.find((f): f is string => typeof f === "string");
    const size = Math.max(view.box.maxU - view.box.minU, view.box.maxV - view.box.minV);
    const centre: P2 = [(view.box.minU + view.box.maxU) / 2, (view.box.minV + view.box.maxV) / 2];
    if (missing) {
      // drawn where it was, as near as what is left of it says
      const left = fs.filter((f): f is Feature2 => typeof f !== "string");
      const first = left[0];
      const anchor = dimensionAnchor(dim.kind, left) ?? (first ? (first.kind === "point" ? first.p : first.kind === "segment" ? first.a : first.pts[0]) : undefined);
      return { dim, view, measured: { ok: false, reason: missing, ...(anchor ? { at: [anchor[0] + (dim.offset?.u ?? 0), anchor[1] + (dim.offset?.v ?? 0)] as P2 } : {}) } };
    }
    const measured = measureDimension(dim.kind, fs as Feature2[], dim.offset, size, centre);
    return { dim, view, measured, ...(measured.ok ? { text: dimensionText(dim.kind, measured.geom.value, dim.prefix) } : {}) };
  });
  // a dimension's lines widen its view's frame (not a detail's: that is its circle)
  for (const p of placed) {
    const view = p.view;
    if (!view || view.kind === "detail") continue;
    if (!p.measured.ok) { if (p.measured.at) grow(view.frameBox, p.measured.at); continue; }
    const g = p.measured.geom;
    if (g.kind === "linear") g.ends.forEach((e) => grow(view.frameBox, e));
    else if (g.kind === "angle") angleArc(g.vertex, g.a, g.b, g.R, 8).forEach((q) => grow(view.frameBox, q));
    else grow(view.frameBox, g.at);
  }
  // third-angle alignment: the front and top views share across, the front and right views share up
  const front = byId("front")!, top = byId("top"), right = byId("right");
  if (top) { const lo = Math.min(front.frameBox.minU, top.frameBox.minU), hi = Math.max(front.frameBox.maxU, top.frameBox.maxU); front.frameBox.minU = top.frameBox.minU = lo; front.frameBox.maxU = top.frameBox.maxU = hi; }
  if (right) { const lo = Math.min(front.frameBox.minV, right.frameBox.minV), hi = Math.max(front.frameBox.maxV, right.frameBox.maxV); front.frameBox.minV = right.frameBox.minV = lo; front.frameBox.maxV = right.frameBox.maxV = hi; }

  // sheet layout (mm of paper). A4 landscape-ish; the views are scaled to fit the drawing area and centred in
  // it. The cut list goes under the views or, when that leaves them bigger (a long list, a wide model), in a
  // column on the right: whichever uses the sheet better. Sections and details go in rows under the front view.
  const SHEET_W = 1120, SHEET_H = 790, M = 30, GAP = 40, TITLE_H = 44, ROW = 18;
  const cutRows = cutList(doc, scope, solids);
  const tableH = 18 + 24 + (cutRows.length + 1) * ROW + 10; // its heading, the header row, the rows
  const W = (v: ViewDraft) => v.frameBox.maxU - v.frameBox.minU, H = (v: ViewDraft) => v.frameBox.maxV - v.frameBox.minV;
  const extras = drafts.filter((v) => v.kind !== "ortho");
  const layout = sheetLayout({
    sheet: { w: SHEET_W, h: SHEET_H }, margin: M, gap: GAP, titleH: TITLE_H, tableH,
    views: { fW: W(front), fH: H(front), rW: right ? W(right) : 0, tH: top ? H(top) : 0 },
    extras: extras.map((v) => ({ w: W(v) * v.zoom, h: H(v) * v.zoom })),
  });
  const origin = new Map<string, { x: number; y: number }>([["front", layout.front], ["top", layout.top], ["right", layout.right]]);
  extras.forEach((v, i) => origin.set(v.id, layout.extras[i]));
  const views: SheetViewInfo[] = drafts.map((v) => {
    const o = origin.get(v.id)!, sc = layout.scale * v.zoom;
    return { id: v.id, label: v.label, kind: v.kind, ...(v.base ? { base: v.base } : {}), x: o.x, y: o.y, w: W(v) * sc, h: H(v) * sc, scale: sc, minU: v.frameBox.minU, maxV: v.frameBox.maxV };
  });
  const info = new Map(views.map((v) => [v.id, v]));
  const toPaper = (id: string) => { const v = info.get(id)!; return (p: P2): P2 => [v.x + (p[0] - v.minU) * v.scale, v.y + (v.maxV - p[1]) * v.scale]; };

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SHEET_W} ${SHEET_H}" font-family="Helvetica,Arial,sans-serif">`);
  parts.push(`<rect x="0" y="0" width="${SHEET_W}" height="${SHEET_H}" fill="#ffffff"/>`);
  parts.push(`<rect x="8" y="8" width="${SHEET_W - 16}" height="${SHEET_H - 16}" fill="none" stroke="#111" stroke-width="2"/>`);

  for (const v of drafts) {
    const at = info.get(v.id)!, P = toPaper(v.id);
    const clip = (segs: Seg[]) => (v.clip ? segs.flatMap((sg) => { const c = clipToCircle(sg, v.clip!.c, v.clip!.r); return c ? [c] : []; }) : segs);
    const line = ([a, b]: Seg, w: number) => { const [p, q] = [P(a), P(b)]; return `<line x1="${r1(p[0])}" y1="${r1(p[1])}" x2="${r1(q[0])}" y2="${r1(q[1])}" stroke="#111" stroke-width="${w}"/>`; };
    const g: string[] = [`<g class="view" data-view="${esc(v.id)}">`];
    for (const sg of clip(v.segs)) g.push(line(sg, 0.6));
    for (const c of v.caps) {
      g.push(`<g class="hatch" data-part="${c.part}">`);
      for (const h of clip(hatchSegments(c.segs, HATCH_ANGLES[c.part % HATCH_ANGLES.length], HATCH_PAPER / at.scale))) g.push(line(h, 0.3));
      g.push(`</g>`);
      for (const sg of clip(c.segs)) g.push(line(sg, 0.9));
    }
    if (v.clip) { const c = P(v.clip.c); g.push(`<circle cx="${r1(c[0])}" cy="${r1(c[1])}" r="${r1(v.clip.r * at.scale)}" fill="none" stroke="#111" stroke-width="0.4"/>`); }
    // the overall dimensions: across under the front view, up beside the front and right views
    const bx = v.box, fb = v.frameBox;
    if (v.id === "front") {
      const y = P([0, fb.minV])[1] + 18;
      const feet: [P2, P2] = [P([bx.minU, bx.minV]), P([bx.maxU, bx.minV])];
      g.push(`<g class="dim dim-overall">${linearDimSvg(feet, [[feet[0][0], y], [feet[1][0], y]], dimensionText("horizontal", bx.maxU - bx.minU))}</g>`);
    }
    if (v.id === "front" || v.id === "right") {
      const x = P([fb.minU, 0])[0] - 18;
      const feet: [P2, P2] = [P([bx.minU, bx.minV]), P([bx.minU, bx.maxV])];
      g.push(`<g class="dim dim-overall">${linearDimSvg(feet, [[x, feet[0][1]], [x, feet[1][1]]], dimensionText("vertical", bx.maxV - bx.minV))}</g>`);
    }
    g.push(`<text x="${r1(at.x)}" y="${r1(at.y + at.h + (v.id === "front" ? 38 : 16))}" font-size="13" fill="#111" font-weight="bold">${esc(v.label)}</text>`);
    // the section lines and detail circles drawn on this view
    for (const sec of drafting?.sections ?? []) {
      if (sec.base !== v.id || v.kind !== "ortho" || !byId(sec.id)) continue;
      const { frame } = sectionFrame(v.frame, sec.from, sec.to, sec.flip);
      const look = projectTo(v.frame, frame.d);
      g.push(sectionLineSvg(P([sec.from.u, sec.from.v]), P([sec.to.u, sec.to.v]), [look[0], -look[1]], sec.label, sec.id));
    }
    for (const det of drafting?.details ?? []) {
      if (det.base !== v.id || !byId(det.id)) continue;
      const c = P([det.center.u, det.center.v]), R = det.radius * at.scale;
      g.push(`<g class="detail-circle" data-detail="${esc(det.id)}"><circle cx="${r1(c[0])}" cy="${r1(c[1])}" r="${r1(R)}" fill="none" stroke="#111" stroke-width="0.5"/>` +
        `<text x="${r1(c[0] + R * 0.75 + 4)}" y="${r1(c[1] - R * 0.75 - 4)}" font-size="${r1(DIM.text * 1.25)}" font-weight="bold" fill="#111">${esc(det.label)}</text></g>`);
    }
    g.push(`</g>`);
    parts.push(g.join(""));
  }

  // ---- the placed dimensions ----
  const statuses: DimensionStatus[] = [];
  const stack = new Map<string, number>(); // broken ones with nowhere to go, listed down a view's corner
  for (const p of placed) {
    const { dim, measured } = p;
    if (!measured.ok) {
      statuses.push({ id: dim.id, view: dim.view, kind: dim.kind, broken: measured.reason });
      if (!p.view) continue;
      const v = info.get(p.view.id)!;
      let at: P2;
      if (measured.at) at = toPaper(p.view.id)(measured.at);
      else { const k = stack.get(v.id) ?? 0; stack.set(v.id, k + 1); at = [v.x + 40, v.y + 12 + k * (DIM.text + 8)]; }
      parts.push(brokenDimSvg(at, dim.id, measured.reason));
      continue;
    }
    statuses.push({ id: dim.id, view: dim.view, kind: dim.kind, value: measured.geom.value, text: p.text });
    parts.push(`<g class="dim" data-dim="${esc(dim.id)}">${dimensionSvg(measured.geom, toPaper(p.view!.id), p.text!)}</g>`);
  }

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
  return { svg: parts.join("\n"), sheet: { views, picks, dimensions: statuses } };
}
