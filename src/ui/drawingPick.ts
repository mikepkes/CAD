// Placing annotations on the shop drawing by picking on the sheet: which view a
// point on the paper is in, the model edge or corner nearest it there, and the
// drawing.* command a finished pick makes. Pure (paper and view coordinates in,
// command params out), so DrawingView only turns pointer events into points.

import type { SheetViewInfo, PickTarget } from "../core/drawings";
import { dimensionAnchor, type Feature2, type P2 } from "../core/drawingAnnotations";
import type { DimensionKind, DrawingRef } from "../core/document";

/** What the sheet's tool places. "linear" is horizontal or vertical, whichever way the dimension is pulled. */
export type DrawingTool = "linear" | "aligned" | "radius" | "diameter" | "angle" | "section" | "detail";

export const TOOLS: { id: DrawingTool; label: string; hint: string }[] = [
  { id: "linear", label: "Linear", hint: "Pick two corners or edges, then where the dimension goes: above or below for a horizontal one, beside for a vertical one" },
  { id: "aligned", label: "Aligned", hint: "Pick two corners or edges, then where the dimension goes; it measures straight between them (square to the edges)" },
  { id: "radius", label: "Radius", hint: "Pick a circle or an arc, then where the text goes" },
  { id: "diameter", label: "Diameter", hint: "Pick a circle or an arc, then where the text goes" },
  { id: "angle", label: "Angle", hint: "Pick two straight edges, then the side of the angle to measure" },
  { id: "section", label: "Section", hint: "On the front, top or right view, click two points on the cutting line; the section looks to the left of it (flip it after)" },
  { id: "detail", label: "Detail", hint: "Click the middle of the region to enlarge, then how far it reaches" },
];

/** How many model refs a tool picks before it is placed (sections and details pick points instead). */
export const refsWanted = (tool: DrawingTool): number => (tool === "radius" || tool === "diameter" ? 1 : tool === "section" || tool === "detail" ? 0 : 2);

/** A view coordinate from a paper point, and back. */
export const toView = (v: SheetViewInfo, [x, y]: P2): P2 => [v.minU + (x - v.x) / v.scale, v.maxV - (y - v.y) / v.scale];
export const toPaper = (v: SheetViewInfo, [u, w]: P2): P2 => [v.x + (u - v.minU) * v.scale, v.y + (v.maxV - w) * v.scale];

/** The view a paper point is over (or within `margin` of: a dimension sits outside its view), the smallest
 *  first when they overlap. */
export function viewAt(views: SheetViewInfo[], [x, y]: P2, margin = 0): SheetViewInfo | undefined {
  const hits = views.filter((v) => x >= v.x - margin && x <= v.x + v.w + margin && y >= v.y - margin && y <= v.y + v.h + margin);
  return hits.sort((a, b) => a.w * a.h - b.w * b.h)[0];
}

const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function segDist(p: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** How far a view point is from a feature (view mm). */
export function featureDistance(f: Feature2, p: P2): number {
  if (f.kind === "point") return dist(f.p, p);
  if (f.kind === "segment") return segDist(p, f.a, f.b);
  let d = Infinity;
  for (let i = 0; i + 1 < f.pts.length; i++) d = Math.min(d, segDist(p, f.pts[i], f.pts[i + 1]));
  return d;
}

/** Whether a tool can use a target: a radius or diameter a circle or arc, an angle a straight edge, a linear
 *  dimension anything with a place (not a freeform curve). */
export function accepts(tool: DrawingTool, t: PickTarget): boolean {
  if (tool === "radius" || tool === "diameter") return t.f.kind === "curve" && !!t.f.circle;
  if (tool === "angle") return t.f.kind === "segment";
  if (tool === "linear" || tool === "aligned") return t.f.kind !== "curve" || !!t.f.circle;
  return false;
}

/** The target nearest a view point within `tol` (view mm) that the tool takes: a corner wins over an edge it
 *  ends (within the same reach), so corners can be picked where edges meet. */
export function nearestTarget(picks: PickTarget[], p: P2, tol: number, tool: DrawingTool): PickTarget | undefined {
  let best: { t: PickTarget; d: number } | undefined;
  for (const t of picks) {
    if (!accepts(tool, t)) continue;
    const d = featureDistance(t.f, p) - (t.f.kind === "point" ? tol * 0.6 : 0); // corners are small: favour them
    if (d <= tol && (!best || d < best.d)) best = { t, d };
  }
  return best?.t;
}

export const sameRef = (a: DrawingRef, b: DrawingRef) => a.body === b.body && ("edge" in a ? "edge" in b && a.edge === b.edge : "vertex" in b && a.vertex === b.vertex);

/** A linear dimension's kind from where it is pulled to: past the features' extent across → vertical, up or
 *  down → horizontal. */
export function linearKind(fs: Feature2[], p: P2): "horizontal" | "vertical" {
  const pts = fs.flatMap((f) => (f.kind === "point" ? [f.p] : f.kind === "segment" ? [f.a, f.b] : f.circle ? [f.circle.c] : f.pts));
  const lo = [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1]))], hi = [Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))];
  const outU = Math.max(lo[0] - p[0], p[0] - hi[0], 0), outV = Math.max(lo[1] - p[1], p[1] - hi[1], 0);
  return outU > outV ? "vertical" : "horizontal";
}

/** The drawing.addDimension params for targets picked on a view and the view point it is placed at; undefined
 *  when they don't make that dimension. */
export function dimensionCommand(tool: DrawingTool, view: string, targets: PickTarget[], at: P2): { view: string; kind: DimensionKind; refs: DrawingRef[]; offset: { u: number; v: number } } | undefined {
  const fs = targets.map((t) => t.f);
  const kind: DimensionKind | undefined = tool === "linear" ? linearKind(fs, at) : tool === "section" || tool === "detail" ? undefined : tool;
  if (!kind) return undefined;
  const anchor = dimensionAnchor(kind, fs);
  if (!anchor) return undefined;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return { view, kind, refs: targets.map((t) => t.ref), offset: { u: r3(at[0] - anchor[0]), v: r3(at[1] - anchor[1]) } };
}

/** A section line through two view points, snapped square to the view within 6°, and drawn across the whole
 *  view (a little past its edges) so the cut reads as a plane. */
export function sectionLine(v: SheetViewInfo, a: P2, b: P2): { from: { u: number; v: number }; to: { u: number; v: number } } | undefined {
  let dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy);
  if (L < 1e-6) return undefined;
  const ang = Math.atan2(dy, dx), snap = (6 * Math.PI) / 180;
  const near = (t: number) => Math.abs(Math.atan2(Math.sin(ang - t), Math.cos(ang - t))) < snap;
  if ([0, Math.PI].some(near)) { dx = Math.sign(Math.cos(ang)) * L; dy = 0; }
  else if ([Math.PI / 2, -Math.PI / 2].some(near)) { dx = 0; dy = Math.sign(Math.sin(ang)) * L; }
  const d: P2 = [dx / L, dy / L];
  // the view's corners along the line: how far it reaches either way from `a`
  const w = v.w / v.scale, h = v.h / v.scale, maxV = v.maxV, minU = v.minU;
  const ts = [[minU, maxV - h], [minU + w, maxV - h], [minU, maxV], [minU + w, maxV]].map(([u, y]) => (u - a[0]) * d[0] + (y - a[1]) * d[1]);
  const pad = 0.05 * Math.max(w, h);
  const t0 = Math.min(...ts) - pad, t1 = Math.max(...ts) + pad;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return { from: { u: r3(a[0] + d[0] * t0), v: r3(a[1] + d[1] * t0) }, to: { u: r3(a[0] + d[0] * t1), v: r3(a[1] + d[1] * t1) } };
}
