// Project 3D B-rep edges onto a sketch plane, producing 2D sketch curves.
// Pure geometry: lines stay lines; circles/arcs whose plane is parallel to the
// sketch plane stay circular, otherwise they degrade to polylines. Overlapping
// results (e.g. a box's top and bottom faces onto the same plane) are deduped.

import { to2d, WorkPlane } from "../../geometry/plane";
import { Edge3D } from "../occ/kernel";

export type XY = { x: number; y: number };

export type ProjectedCurve =
  | { kind: "line"; a: XY; b: XY }
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "arc"; cx: number; cy: number; r: number; a: XY; b: XY; ccw: boolean }
  | { kind: "poly"; pts: XY[] };

function circleFrom3(a: XY, b: XY, c: XY): { x: number; y: number; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { x: ux, y: uy, r: Math.hypot(a.x - ux, a.y - uy) };
}

const dist2 = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);

export function projectEdges(edges: Edge3D[], plane: WorkPlane): ProjectedCurve[] {
  const out: ProjectedCurve[] = [];
  for (const e of edges) {
    const pts = e.pts.map((p) => {
      const uv = to2d(plane, p);
      return { x: uv.u, y: uv.v };
    });
    if (pts.length < 2) continue;

    if (e.type === "line") {
      if (dist2(pts[0], pts[pts.length - 1]) > 1e-6) out.push({ kind: "line", a: pts[0], b: pts[pts.length - 1] });
      continue;
    }

    // circle / arc: try to fit a circle in the projection.
    const n = pts.length;
    const fit = circleFrom3(pts[0], pts[Math.floor(n / 3)], pts[Math.floor((2 * n) / 3)]);
    let circular = false;
    if (fit && fit.r > 1e-4) {
      const tol = Math.max(1e-4, fit.r * 2e-3);
      circular = pts.every((p) => Math.abs(Math.hypot(p.x - fit.x, p.y - fit.y) - fit.r) < tol);
    }
    if (circular && fit) {
      if (e.closed || dist2(pts[0], pts[n - 1]) < Math.max(1e-4, fit.r * 1e-3)) {
        out.push({ kind: "circle", cx: fit.x, cy: fit.y, r: fit.r });
      } else {
        const mid = pts[Math.floor(n / 2)];
        const cr = (p: XY) => (p.x - fit.x) * (mid.y - fit.y) - (p.y - fit.y) * (mid.x - fit.x);
        const ccw = cr(pts[0]) < 0; // start→mid turning direction
        out.push({ kind: "arc", cx: fit.x, cy: fit.y, r: fit.r, a: pts[0], b: pts[n - 1], ccw });
      }
    } else {
      out.push({ kind: "poly", pts });
    }
  }
  return dedupe(out);
}

const TAU = Math.PI * 2;
const norm = (a: number) => ((a % TAU) + TAU) % TAU;

function arcSpan(c: { cx: number; cy: number; r: number; a: XY; b: XY; ccw: boolean }): number {
  const aa = Math.atan2(c.a.y - c.cy, c.a.x - c.cx);
  const ab = Math.atan2(c.b.y - c.cy, c.b.x - c.cx);
  const s = c.ccw ? norm(ab - aa) : norm(aa - ab);
  return s < 1e-6 ? TAU : s;
}

function dedupe(curves: ProjectedCurve[]): ProjectedCurve[] {
  const T = 1e-3;
  const out: ProjectedCurve[] = [];
  const sameLine = (a: ProjectedCurve, b: ProjectedCurve) =>
    a.kind === "line" && b.kind === "line" &&
    ((dist2(a.a, b.a) < T && dist2(a.b, b.b) < T) || (dist2(a.a, b.b) < T && dist2(a.b, b.a) < T));
  const sameCircle = (a: ProjectedCurve, b: ProjectedCurve) =>
    a.kind === "circle" && b.kind === "circle" && Math.abs(a.cx - b.cx) < T && Math.abs(a.cy - b.cy) < T && Math.abs(a.r - b.r) < T;

  // Group arcs by center+radius; dedupe identical copies; merge a full turn → circle.
  const arcs = curves.filter((c): c is Extract<ProjectedCurve, { kind: "arc" }> => c.kind === "arc");
  const others = curves.filter((c) => c.kind !== "arc");
  const groups = new Map<string, Extract<ProjectedCurve, { kind: "arc" }>[]>();
  for (const a of arcs) {
    const key = `${a.cx.toFixed(3)},${a.cy.toFixed(3)},${a.r.toFixed(3)}`;
    const g = groups.get(key) ?? [];
    // skip a copy identical in endpoints AND direction (same edge at another z).
    if (g.some((o) => dist2(o.a, a.a) < T && dist2(o.b, a.b) < T && o.ccw === a.ccw)) continue;
    g.push(a);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const total = g.reduce((s, a) => s + arcSpan(a), 0);
    if (g.length >= 2 && total >= TAU - 0.02) out.push({ kind: "circle", cx: g[0].cx, cy: g[0].cy, r: g[0].r });
    else out.push(...g);
  }

  for (const c of others) {
    if (out.some((o) => sameLine(c, o) || sameCircle(c, o))) continue;
    out.push(c);
  }
  return out;
}
