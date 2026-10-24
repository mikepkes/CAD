// Snapping + constraint inference for sketch drawing.
//
// Given the cursor position (and, while drawing a line, the segment's start),
// this finds the best snap target and the constraints a click there should
// create — the behaviour that makes Fusion sketching feel alive. It is pure
// (no three.js / no store) so it can be unit-tested.

import { Sketch, SketchLine, SketchPoint } from "../sketch/types";

export interface InferResult {
  u: number;
  v: number;
  kind: "point" | "origin" | "midpoint" | "onLine" | "grid" | "free";
  /** Existing point to reuse (→ coincident). */
  ref?: string;
  /** Line id the new point should lie on (→ point-on-line). */
  onLine?: string;
  /** Line id the new point is the midpoint of (→ midpoint). */
  midpointOf?: string;
  /** Direction inference relative to the segment start. */
  axis?: "horizontal" | "vertical";
  parallelTo?: string;
  perpendicularTo?: string;
  /** Glyphs to show at the cursor. */
  markers: string[];
}

type XY = { x: number; y: number };
const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);

/** Smallest angle between two directions, treating reverse as equal (mod π). */
function dirDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

export function infer(
  sk: Sketch,
  cursor: XY,
  px: (pixels: number) => number,
  from?: { u: number; v: number; id?: string },
  grid?: { snap: boolean; size: number }
): InferResult {
  const res: InferResult = { u: cursor.x, v: cursor.y, kind: "free", markers: [] };
  const P = (id: string) => sk.entities[id] as SketchPoint;
  const lines = Object.values(sk.entities).filter((e) => e.kind === "line" && !e.construction) as SketchLine[];

  const pointThr = px(10);
  const snapThr = px(8);

  // 1) existing point (endpoint / circle center) — highest priority
  let best: { id: string; d: number } | null = null;
  for (const e of Object.values(sk.entities)) {
    if (e.kind !== "point") continue;
    if (from?.id && e.id === from.id) continue; // don't snap to the segment's own start
    const d = dist(e, cursor);
    if (d < pointThr && (!best || d < best.d)) best = { id: e.id, d };
  }
  if (best) {
    const p = P(best.id);
    res.u = p.x; res.v = p.y;
    res.ref = best.id;
    res.kind = best.id === sk.originPointId ? "origin" : "point";
    res.markers.push("◦");
    return finishDirection(res, from, lines, sk, px);
  }

  // 2) midpoint of a line
  for (const l of lines) {
    const a = P(l.p1), b = P(l.p2);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (dist(mid, cursor) < snapThr) {
      res.u = mid.x; res.v = mid.y;
      res.midpointOf = l.id;
      res.kind = "midpoint";
      res.markers.push("▷◁");
      return finishDirection(res, from, lines, sk, px);
    }
  }

  // 3) on a line (perpendicular projection within the segment)
  let onLine: { id: string; u: number; v: number; d: number } | null = null;
  for (const l of lines) {
    const a = P(l.p1), b = P(l.p2);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) continue;
    const t = ((cursor.x - a.x) * dx + (cursor.y - a.y) * dy) / len2;
    if (t < 0.02 || t > 0.98) continue; // keep clear of endpoints
    const px0 = a.x + t * dx, py0 = a.y + t * dy;
    const d = Math.hypot(cursor.x - px0, cursor.y - py0);
    if (d < snapThr && (!onLine || d < onLine.d)) onLine = { id: l.id, u: px0, v: py0, d };
  }
  if (onLine) {
    res.u = onLine.u; res.v = onLine.v;
    res.onLine = onLine.id;
    res.kind = "onLine";
    res.markers.push("⊢");
    return finishDirection(res, from, lines, sk, px, true);
  }

  // 4) grid — only when the user has grid snapping on; then every free cursor
  // position rounds to the nearest grid intersection (geometry snaps above win).
  if (grid?.snap && grid.size > 0) {
    const g = grid.size;
    res.u = Math.round(cursor.x / g) * g;
    res.v = Math.round(cursor.y / g) * g;
    res.kind = "grid";
  }

  return finishDirection(res, from, lines, sk, px);
}

/**
 * Direction inference: when drawing a segment in free/grid space, snap it to
 * horizontal/vertical or parallel/perpendicular to a nearby line. For hard
 * targets (point/midpoint) we skip repositioning but still record an exactly
 * horizontal/vertical axis if it happens to align.
 */
function finishDirection(
  res: InferResult,
  from: { u: number; v: number; id?: string } | undefined,
  lines: SketchLine[],
  sk: Sketch,
  px: (p: number) => number,
  hard = false
): InferResult {
  if (!from) return res;
  const dx = res.u - from.u, dy = res.v - from.v;
  const len = Math.hypot(dx, dy);
  if (len < px(4)) return res;

  const soft = res.kind === "free" || res.kind === "grid";
  const sinTol = Math.sin(0.06); // ~3.4°

  // Horizontal / vertical first.
  if (Math.abs(dy) / len < sinTol) {
    if (soft) res.v = from.v;
    if (soft || Math.abs(dy) < 1e-9) { res.axis = "horizontal"; res.markers.push("—"); }
    return res;
  }
  if (Math.abs(dx) / len < sinTol) {
    if (soft) res.u = from.u;
    if (soft || Math.abs(dx) < 1e-9) { res.axis = "vertical"; res.markers.push("|"); }
    return res;
  }
  if (!soft || hard) return res;

  // Parallel / perpendicular to a nearby existing line.
  const seg = Math.atan2(dy, dx);
  const P = (id: string) => sk.entities[id] as SketchPoint;
  for (const l of lines) {
    const a = P(l.p1), b = P(l.p2);
    const la = Math.atan2(b.y - a.y, b.x - a.x);
    const parD = dirDiff(seg, la);
    const perpD = dirDiff(seg, la + Math.PI / 2);
    if (parD < 0.06) {
      const dir = { x: Math.cos(la), y: Math.sin(la) };
      const t = dx * dir.x + dy * dir.y;
      res.u = from.u + dir.x * t; res.v = from.v + dir.y * t;
      res.parallelTo = l.id; res.markers.push("∥");
      return res;
    }
    if (perpD < 0.06) {
      const pa = la + Math.PI / 2;
      const dir = { x: Math.cos(pa), y: Math.sin(pa) };
      const t = dx * dir.x + dy * dir.y;
      res.u = from.u + dir.x * t; res.v = from.v + dir.y * t;
      res.perpendicularTo = l.id; res.markers.push("⊥");
      return res;
    }
  }
  return res;
}
