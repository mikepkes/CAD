// Extract closed profiles (loops) from a solved sketch, for extrusion.
//
// Walks the line/arc graph to find closed loops; circles are their own loops.
// The largest-area loop is treated as the outer boundary and the rest as holes
// (a good default for typical parts). Output is in sketch (u,v) coordinates and
// is renderer/kernel-agnostic — the OCC kernel turns it into B-rep faces.

import { Sketch, SketchArc, SketchLine, SketchPoint, SketchSpline } from "../../sketch/types";
import { sampleSpline } from "./spline";

export interface Pt {
  x: number;
  y: number;
}
export type LoopSegment =
  | { kind: "line"; to: Pt }
  | { kind: "arc"; to: Pt; via: Pt } // `via` is a point on the arc (3-point arc)
  | { kind: "spline"; to: Pt; through: Pt[] }; // every through-point in traversal order, from the previous point to `to`

export interface Loop {
  start: Pt;
  segments: LoopSegment[];
  circle?: { center: Pt; r: number }; // set when the loop is a full circle
  ellipse?: { center: Pt; rx: number; ry: number; rotation: number }; // set when the loop is an ellipse
  area: number; // signed area (CCW positive)
}

export interface Profile {
  outer: Loop;
  holes: Loop[];
}

/** A closed region (outer boundary + holes) plus a point guaranteed inside it. */
export interface Region extends Profile {
  interior: Pt;
}

const P = (sk: Sketch, id: string): SketchPoint => sk.entities[id] as SketchPoint;

function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Midpoint on an arc swept from `from` to `to` about `center`, following ccw. */
function arcVia(center: Pt, from: Pt, to: Pt, ccw: boolean): Pt {
  const r = Math.hypot(from.x - center.x, from.y - center.y);
  const a0 = Math.atan2(from.y - center.y, from.x - center.x);
  let a1 = Math.atan2(to.y - center.y, to.x - center.x);
  if (ccw) {
    while (a1 <= a0) a1 += Math.PI * 2;
  } else {
    while (a1 >= a0) a1 -= Math.PI * 2;
  }
  const mid = (a0 + a1) / 2;
  return { x: center.x + r * Math.cos(mid), y: center.y + r * Math.sin(mid) };
}

/** Extract all closed profiles from a sketch. Returns null if none found. */
export function extractProfiles(sk: Sketch): Profile | null {
  const loops = collectLoops(sk);
  if (loops.length === 0) return null;
  loops.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  return { outer: loops[0], holes: loops.slice(1) };
}

/** Collect every closed loop in a sketch (circles, ellipses, line/arc cycles). */
function collectLoops(sk: Sketch): Loop[] {
  const loops: Loop[] = [];

  // Full circles and ellipses are standalone loops.
  for (const e of Object.values(sk.entities)) {
    if (e.kind === "circle" && !e.construction) {
      const c = P(sk, e.center);
      loops.push({
        start: { x: c.x + e.r, y: c.y },
        segments: [],
        circle: { center: { x: c.x, y: c.y }, r: e.r },
        area: Math.PI * e.r * e.r,
      });
    } else if (e.kind === "ellipse" && !e.construction) {
      const c = P(sk, e.center);
      loops.push({
        start: { x: c.x + e.rx * Math.cos(e.rotation), y: c.y + e.rx * Math.sin(e.rotation) },
        segments: [],
        ellipse: { center: { x: c.x, y: c.y }, rx: e.rx, ry: e.ry, rotation: e.rotation },
        area: Math.PI * e.rx * e.ry,
      });
    }
  }

  // Build adjacency over line/arc/spline edges.
  interface Edge { id: string; a: string; b: string; ent: SketchLine | SketchArc | SketchSpline; }
  const edges: Edge[] = [];
  for (const e of Object.values(sk.entities)) {
    if (e.construction) continue;
    if (e.kind === "line") edges.push({ id: e.id, a: e.p1, b: e.p2, ent: e });
    else if (e.kind === "arc") edges.push({ id: e.id, a: e.p1, b: e.p2, ent: e });
    else if (e.kind === "spline" && e.points.length >= 2) edges.push({ id: e.id, a: e.points[0], b: e.points[e.points.length - 1], ent: e });
  }
  const adj = new Map<string, Edge[]>();
  for (const ed of edges) {
    (adj.get(ed.a) ?? adj.set(ed.a, []).get(ed.a)!).push(ed);
    (adj.get(ed.b) ?? adj.set(ed.b, []).get(ed.b)!).push(ed);
  }

  const usedEdge = new Set<string>();
  const segFor = (ed: Edge, fromId: string, toId: string): LoopSegment => {
    const to = { x: P(sk, toId).x, y: P(sk, toId).y };
    if (ed.ent.kind === "line") return { kind: "line", to };
    if (ed.ent.kind === "spline") {
      const ids = fromId === ed.ent.points[0] ? ed.ent.points : [...ed.ent.points].reverse();
      return { kind: "spline", to, through: ids.map((id) => ({ x: P(sk, id).x, y: P(sk, id).y })) };
    }
    const arc = ed.ent as SketchArc;
    const center = { x: P(sk, arc.center).x, y: P(sk, arc.center).y };
    const from = { x: P(sk, fromId).x, y: P(sk, fromId).y };
    // sweep direction relative to traversal: arc.ccw is defined p1->p2
    const forward = fromId === arc.p1;
    const via = arcVia(center, from, to, forward ? arc.ccw : !arc.ccw);
    return { kind: "arc", to, via };
  };

  for (const start of edges) {
    if (usedEdge.has(start.id)) continue;
    // Walk a loop starting from this edge.
    const startNode = start.a;
    let prevEdge = start;
    let cur = start.b;
    const first = start.a;
    const orderedPts: Pt[] = [{ x: P(sk, start.a).x, y: P(sk, start.a).y }];
    const segments: LoopSegment[] = [segFor(start, start.a, start.b)];
    usedEdge.add(start.id);
    orderedPts.push({ x: P(sk, start.b).x, y: P(sk, start.b).y });
    let closed = false;
    for (let guard = 0; guard < edges.length + 1; guard++) {
      if (cur === first) { closed = true; break; }
      const candidates = (adj.get(cur) ?? []).filter((e) => e.id !== prevEdge.id && !usedEdge.has(e.id));
      if (candidates.length === 0) break;
      const next = candidates[0];
      const toId = next.a === cur ? next.b : next.a;
      segments.push(segFor(next, cur, toId));
      orderedPts.push({ x: P(sk, toId).x, y: P(sk, toId).y });
      usedEdge.add(next.id);
      prevEdge = next;
      cur = toId;
    }
    if (closed && segments.length >= 2) {
      const loop: Loop = { start: { x: P(sk, startNode).x, y: P(sk, startNode).y }, segments, area: 0 };
      // Signed area over the sampled boundary (curved segments included); the
      // last sample repeats the start, so drop it.
      loop.area = signedArea(loopPolygon(loop).slice(0, -1));
      loops.push(loop);
    }
  }

  return loops;
}

/** Sample a loop's boundary as a polygon (for containment / interior tests). */
export function loopPolygon(loop: Loop): Pt[] {
  if (loop.circle) {
    const { center, r } = loop.circle;
    return Array.from({ length: 48 }, (_, i) => {
      const a = (i / 48) * Math.PI * 2;
      return { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) };
    });
  }
  if (loop.ellipse) {
    const { center, rx, ry, rotation } = loop.ellipse;
    return Array.from({ length: 64 }, (_, i) => {
      const t = (i / 64) * Math.PI * 2;
      const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
      return { x: center.x + ex * Math.cos(rotation) - ey * Math.sin(rotation), y: center.y + ex * Math.sin(rotation) + ey * Math.cos(rotation) };
    });
  }
  const pts: Pt[] = [{ x: loop.start.x, y: loop.start.y }];
  for (const s of loop.segments) {
    if (s.kind === "spline") {
      pts.push(...sampleSpline(s.through, 6).slice(1));
      continue;
    }
    if (s.kind === "arc") {
      const prev = pts[pts.length - 1];
      const c = circleFrom3(prev, s.via, s.to);
      if (c) {
        const a0 = Math.atan2(prev.y - c.y, prev.x - c.x);
        const am = Math.atan2(s.via.y - c.y, s.via.x - c.x);
        const a1 = Math.atan2(s.to.y - c.y, s.to.x - c.x);
        const norm = (a: number) => { while (a < -Math.PI) a += 2 * Math.PI; while (a > Math.PI) a -= 2 * Math.PI; return a; };
        const ccw = norm(am - a0) > 0;
        let span = a1 - a0; if (ccw && span < 0) span += 2 * Math.PI; if (!ccw && span > 0) span -= 2 * Math.PI;
        for (let i = 1; i <= 10; i++) pts.push({ x: c.x + c.r * Math.cos(a0 + span * (i / 10)), y: c.y + c.r * Math.sin(a0 + span * (i / 10)) });
        continue;
      }
    }
    pts.push({ x: s.to.x, y: s.to.y });
  }
  return pts;
}

function circleFrom3(a: Pt, b: Pt, c: Pt): { x: number; y: number; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { x: ux, y: uy, r: Math.hypot(a.x - ux, a.y - uy) };
}

function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** A point guaranteed inside `outer` but outside every `hole`. */
function interiorPoint(outer: Pt[], holes: Pt[][]): Pt {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of outer) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const ok = (p: Pt) => pointInPolygon(p, outer) && !holes.some((h) => pointInPolygon(p, h));
  if (ok({ x: cx, y: cy })) return { x: cx, y: cy };
  for (let gy = 1; gy < 12; gy++) for (let gx = 1; gx < 12; gx++) {
    const p = { x: minX + ((maxX - minX) * gx) / 12, y: minY + ((maxY - minY) * gy) / 12 };
    if (ok(p)) return p;
  }
  return { x: cx, y: cy };
}

/**
 * Decompose a sketch into independent closed regions. Disjoint boundaries
 * become separate regions; a loop nested (odd depth) inside another is a hole
 * of the region it sits in. Each region carries a point guaranteed inside it.
 */
/**
 * Walk an OPEN chain of line/arc entities into an ordered path (for sweep spines).
 * Returns null if the sketch has no open chain (empty, closed loop, or branching).
 */
export function extractOpenPath(sk: Sketch): { start: Pt; segments: LoopSegment[] } | null {
  type E = { id: string; a: string; b: string; kind: "line" | "arc"; center?: string; ccw?: boolean };
  const curves: E[] = [];
  for (const e of Object.values(sk.entities)) {
    if (e.construction) continue;
    if (e.kind === "line") curves.push({ id: e.id, a: e.p1, b: e.p2, kind: "line" });
    else if (e.kind === "arc") curves.push({ id: e.id, a: e.p1, b: e.p2, kind: "arc", center: e.center, ccw: e.ccw });
  }
  if (!curves.length) return null;
  const inc = new Map<string, E[]>();
  for (const c of curves) for (const v of [c.a, c.b]) { const l = inc.get(v) ?? []; l.push(c); inc.set(v, l); }
  // An open chain starts at a degree-1 vertex; bail on closed loops or branches.
  let start: string | undefined;
  for (const [v, l] of inc) { if (l.length > 2) return null; if (l.length === 1 && !start) start = v; }
  if (!start) return null;

  const used = new Set<string>();
  const segs: LoopSegment[] = [];
  let cur = start;
  const startPt: Pt = { x: P(sk, cur).x, y: P(sk, cur).y };
  for (let guard = 0; guard <= curves.length; guard++) {
    const next = (inc.get(cur) ?? []).find((c) => !used.has(c.id));
    if (!next) break;
    used.add(next.id);
    const toId = next.a === cur ? next.b : next.a;
    const to: Pt = { x: P(sk, toId).x, y: P(sk, toId).y };
    if (next.kind === "line") segs.push({ kind: "line", to });
    else {
      const c = P(sk, next.center!);
      const forward = next.a === cur;
      const ccw = forward ? !!next.ccw : !next.ccw;
      const via = arcVia({ x: c.x, y: c.y }, { x: P(sk, cur).x, y: P(sk, cur).y }, to, ccw);
      segs.push({ kind: "arc", to, via });
    }
    cur = toId;
  }
  return segs.length ? { start: startPt, segments: segs } : null;
}

/** A connected run of sketch curves for a surface: open (a path) or closed
 *  (a loop — including a full circle or ellipse). */
export interface Chain { closed: boolean; loop: Loop }

/**
 * Every connected chain of non-construction curves in a sketch — lines, arcs
 * and splines joined end to end, plus circles and ellipses on their own. Unlike
 * regions, a chain needn't be closed: an open profile extrudes to a surface.
 * A branching junction (three curves at one point) splits into separate runs.
 */
export function extractChains(sk: Sketch): Chain[] {
  type E = { id: string; a: string; b: string; kind: "line" | "arc" | "spline"; center?: string; ccw?: boolean; points?: string[] };
  const curves: E[] = [];
  const out: Chain[] = [];
  for (const e of Object.values(sk.entities)) {
    if (e.construction) continue;
    if (e.kind === "line") curves.push({ id: e.id, a: e.p1, b: e.p2, kind: "line" });
    else if (e.kind === "arc") curves.push({ id: e.id, a: e.p1, b: e.p2, kind: "arc", center: e.center, ccw: e.ccw });
    else if (e.kind === "spline" && e.points.length >= 2) curves.push({ id: e.id, a: e.points[0], b: e.points[e.points.length - 1], kind: "spline", points: e.points });
    else if (e.kind === "circle") {
      const c = P(sk, e.center);
      if (c && e.r > 0) out.push({ closed: true, loop: { start: { x: c.x + e.r, y: c.y }, segments: [], circle: { center: { x: c.x, y: c.y }, r: e.r }, area: Math.PI * e.r * e.r } });
    } else if (e.kind === "ellipse") {
      const c = P(sk, e.center);
      if (c) out.push({ closed: true, loop: { start: { x: c.x, y: c.y }, segments: [], ellipse: { center: { x: c.x, y: c.y }, rx: e.rx, ry: e.ry, rotation: e.rotation }, area: Math.PI * e.rx * e.ry } });
    }
  }
  const inc = new Map<string, E[]>();
  for (const c of curves) for (const v of [c.a, c.b]) { const l = inc.get(v) ?? []; l.push(c); inc.set(v, l); }
  const used = new Set<string>();
  const pt = (id: string): Pt => ({ x: P(sk, id).x, y: P(sk, id).y });
  const walk = (start: string): Chain | null => {
    const segs: LoopSegment[] = [];
    let cur = start;
    for (;;) {
      const next = (inc.get(cur) ?? []).find((c) => !used.has(c.id));
      if (!next) break;
      used.add(next.id);
      const forward = next.a === cur;
      const toId = forward ? next.b : next.a;
      const to = pt(toId);
      if (next.kind === "line") segs.push({ kind: "line", to });
      else if (next.kind === "arc") segs.push({ kind: "arc", to, via: arcVia(pt(next.center!), pt(cur), to, forward ? !!next.ccw : !next.ccw) });
      else {
        const ids = forward ? next.points! : [...next.points!].reverse();
        segs.push({ kind: "spline", to, through: ids.map(pt) });
      }
      cur = toId;
      if ((inc.get(cur)?.length ?? 0) > 2) break; // a branch: end this run here
    }
    if (!segs.length) return null;
    const closed = cur === start;
    const s0 = pt(start);
    const poly = [s0, ...segs.map((g) => g.to)];
    return { closed, loop: { start: s0, segments: segs, area: closed ? signedArea(poly) : 0 } };
  };
  // open runs first (from their free ends), then whatever is left is loops
  for (const [v, l] of inc) if (l.length !== 2 && l.some((c) => !used.has(c.id))) { const c = walk(v); if (c) out.push(c); }
  for (const c of curves) if (!used.has(c.id)) { const ch = walk(c.a); if (ch) out.push(ch); }
  return out;
}

export function extractRegions(sk: Sketch): Region[] {
  const loops = collectLoops(sk);
  if (loops.length === 0) return [];
  const polys = loops.map(loopPolygon);
  const depth = loops.map((_, i) => {
    let d = 0;
    for (let j = 0; j < loops.length; j++) {
      if (i === j) continue;
      if (Math.abs(loops[j].area) > Math.abs(loops[i].area) && pointInPolygon(polys[i][0], polys[j])) d++;
    }
    return d;
  });
  const regions: Region[] = [];
  for (let i = 0; i < loops.length; i++) {
    if (depth[i] % 2 !== 0) continue; // odd depth => hole
    const holeIdx = loops
      .map((_, j) => j)
      .filter((j) => j !== i && depth[j] === depth[i] + 1 && pointInPolygon(polys[j][0], polys[i]));
    regions.push({ outer: loops[i], holes: holeIdx.map((j) => loops[j]), interior: interiorPoint(polys[i], holeIdx.map((j) => polys[j])) });
  }
  regions.sort((a, b) => Math.abs(b.outer.area) - Math.abs(a.outer.area));
  return regions;
}

/** The region whose interior contains `p` (for click-to-select). */
export function regionAt(sk: Sketch, p: Pt): Region | null {
  const regions = extractRegions(sk);
  for (const r of regions) {
    if (pointInPolygon(p, loopPolygon(r.outer)) && !r.holes.some((h) => pointInPolygon(p, loopPolygon(h)))) return r;
  }
  return null;
}
