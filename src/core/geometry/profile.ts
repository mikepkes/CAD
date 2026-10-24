// Extract closed profiles (loops) from a solved sketch, for extrusion.
//
// Walks the line/arc graph to find closed loops; circles are their own loops.
// The largest-area loop is treated as the outer boundary and the rest as holes
// (a good default for typical parts). Output is in sketch (u,v) coordinates and
// is renderer/kernel-agnostic — the OCC kernel turns it into B-rep faces.

import { Sketch, SketchArc, SketchLine, SketchPoint } from "../../sketch/types";

export interface Pt {
  x: number;
  y: number;
}
export type LoopSegment =
  | { kind: "line"; to: Pt }
  | { kind: "arc"; to: Pt; via: Pt }; // `via` is a point on the arc (3-point arc)

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

  // Build adjacency over line/arc edges.
  interface Edge { id: string; a: string; b: string; ent: SketchLine | SketchArc; }
  const edges: Edge[] = [];
  for (const e of Object.values(sk.entities)) {
    if (e.construction) continue;
    if (e.kind === "line") edges.push({ id: e.id, a: e.p1, b: e.p2, ent: e });
    else if (e.kind === "arc") edges.push({ id: e.id, a: e.p1, b: e.p2, ent: e });
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
      // last segment's `to` is `first` — drop the duplicate point for area calc
      const ptsForArea = orderedPts.slice(0, -1);
      loops.push({
        start: { x: P(sk, startNode).x, y: P(sk, startNode).y },
        segments,
        area: signedArea(ptsForArea),
      });
    }
  }

  if (loops.length === 0) return null;
  loops.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  return { outer: loops[0], holes: loops.slice(1) };
}
