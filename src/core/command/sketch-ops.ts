// Sketch-editing algorithms used by the modify commands (trim / extend / offset /
// fillet / chamfer / pattern). Pure geometry over a Sketch — extracted from the
// command registry so builtins stays a flat list of command definitions.

import { Sketch, SketchPoint, SketchLine } from "../../sketch/types";
import { CommandContext, CommandApplyInfo } from "./types";
import { ICurve, intersect, paramOf, pointAt } from "../geometry/intersect";

export type Vec = { x: number; y: number };

/** Copy entities, mapping each point through `tf`. Shared by the pattern tools. */
export function copyEntities(sk: Sketch, ids: string[], ctx: CommandContext, tf: (p: Vec) => Vec): string[] {
  const map = new Map<string, string>();
  const mp = (id: string): string => {
    if (map.has(id)) return map.get(id)!;
    const o = sk.entities[id] as SketchPoint;
    const t = tf({ x: o.x, y: o.y });
    const nid = ctx.alloc("pt");
    sk.entities[nid] = { id: nid, kind: "point", x: t.x, y: t.y, construction: o.construction };
    map.set(id, nid);
    return nid;
  };
  const created: string[] = [];
  for (const eid of ids) {
    const e = sk.entities[eid];
    if (!e) continue;
    if (e.kind === "point") created.push(mp(eid));
    else if (e.kind === "line") { const nid = ctx.alloc("ln"); sk.entities[nid] = { id: nid, kind: "line", p1: mp(e.p1), p2: mp(e.p2), construction: e.construction }; created.push(nid); }
    else if (e.kind === "circle") { const nid = ctx.alloc("ci"); sk.entities[nid] = { id: nid, kind: "circle", center: mp(e.center), r: e.r, construction: e.construction }; created.push(nid); }
    else if (e.kind === "arc") { const nid = ctx.alloc("ar"); sk.entities[nid] = { id: nid, kind: "arc", center: mp(e.center), p1: mp(e.p1), p2: mp(e.p2), r: e.r, ccw: e.ccw, construction: e.construction }; created.push(nid); }
  }
  return created;
}

function toICurve(sk: Sketch, e: { kind: string } & Record<string, unknown>): ICurve | null {
  const P = (id: string) => sk.entities[id] as SketchPoint;
  if (e.kind === "line") { const a = P(e.p1 as string), b = P(e.p2 as string); return { kind: "line", a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } }; }
  if (e.kind === "circle") { const c = P(e.center as string); return { kind: "circle", c: { x: c.x, y: c.y }, r: e.r as number }; }
  if (e.kind === "arc") {
    const c = P(e.center as string), s = P(e.p1 as string), t = P(e.p2 as string);
    return { kind: "arc", c: { x: c.x, y: c.y }, r: e.r as number, a0: Math.atan2(s.y - c.y, s.x - c.x), a1: Math.atan2(t.y - c.y, t.x - c.x), ccw: e.ccw as boolean };
  }
  return null;
}

/** Remove orphaned points and any constraints that reference missing entities. */
function pruneSketch(sk: Sketch) {
  const used = new Set<string>();
  for (const e of Object.values(sk.entities)) {
    if (e.kind === "line") { used.add(e.p1); used.add(e.p2); }
    else if (e.kind === "circle") used.add(e.center);
    else if (e.kind === "arc") { used.add(e.center); used.add(e.p1); used.add(e.p2); }
  }
  for (const [id, e] of Object.entries(sk.entities)) {
    if (e.kind === "point" && id !== sk.originPointId && !used.has(id)) delete sk.entities[id];
  }
  for (const [cid, c] of Object.entries(sk.constraints) as [string, Record<string, unknown>][]) {
    for (const [k, v] of Object.entries(c)) {
      if (typeof v === "string" && k !== "id" && k !== "type" && k !== "expr" && !sk.entities[v]) { delete sk.constraints[cid]; break; }
    }
  }
}

export function trimCurve(sk: Sketch, targetId: string, u: number, v: number, ctx: CommandContext): CommandApplyInfo {
  const tgt = sk.entities[targetId];
  if (!tgt || tgt.kind === "point") throw new Error("trim target must be a line, circle or arc");
  const tc = toICurve(sk, tgt as any)!;
  const EPS = 1e-4;
  const mkPt = (pt: Vec): string => { const id = ctx.alloc("pt"); sk.entities[id] = { id, kind: "point", x: pt.x, y: pt.y }; return id; };

  // Intersection parameters along the target from every other curve.
  const cuts: number[] = [];
  for (const e of Object.values(sk.entities)) {
    if (e.id === targetId || e.kind === "point") continue;
    const oc = toICurve(sk, e as any);
    if (!oc) continue;
    for (const pt of intersect(tc, oc)) cuts.push(paramOf(tc, pt));
  }
  const click = paramOf(tc, { x: u, y: v });
  const created: string[] = [];

  if (tgt.kind === "line" || tgt.kind === "arc") {
    const cu = Math.max(0, Math.min(1, click));
    const inside = cuts.filter((c) => c > EPS && c < 1 - EPS).sort((a, b) => a - b);
    let lo = 0, hi = 1;
    for (const c of inside) if (c <= cu) lo = c;
    for (const c of inside) if (c >= cu) { hi = c; break; }
    const pieces: [number, number][] = [];
    if (lo > EPS) pieces.push([0, lo]);
    if (hi < 1 - EPS) pieces.push([hi, 1]);
    const origP1 = (tgt as { p1: string }).p1;
    const origP2 = (tgt as { p2: string }).p2;

    if (pieces.length === 0) {
      delete sk.entities[targetId];
    } else {
      pieces.forEach(([s, e], i) => {
        const startId = s <= EPS ? origP1 : mkPt(pointAt(tc, s));
        const endId = e >= 1 - EPS ? origP2 : mkPt(pointAt(tc, e));
        if (startId !== origP1 && s > EPS) created.push(startId);
        if (endId !== origP2 && e < 1 - EPS) created.push(endId);
        if (i === 0) {
          (tgt as { p1: string }).p1 = startId;
          (tgt as { p2: string }).p2 = endId;
        } else {
          const nid = ctx.alloc(tgt.kind === "arc" ? "ar" : "ln");
          sk.entities[nid] = tgt.kind === "arc"
            ? { id: nid, kind: "arc", center: (tgt as any).center, p1: startId, p2: endId, r: (tgt as any).r, ccw: (tgt as any).ccw }
            : { id: nid, kind: "line", p1: startId, p2: endId };
          created.push(nid);
        }
      });
    }
  } else {
    // circle → arc (or delete if the click isn't bounded on both sides)
    const inside = cuts.map((c) => ((c % 1) + 1) % 1).sort((a, b) => a - b);
    if (inside.length < 2) {
      delete sk.entities[targetId];
    } else {
      const cu = ((click % 1) + 1) % 1;
      const below = inside.filter((c) => c <= cu);
      const above = inside.filter((c) => c > cu);
      const lo = below.length ? below[below.length - 1] : inside[inside.length - 1];
      const hi = above.length ? above[0] : inside[0];
      const startId = mkPt(pointAt(tc, hi));
      const endId = mkPt(pointAt(tc, lo));
      const arcId = ctx.alloc("ar");
      sk.entities[arcId] = { id: arcId, kind: "arc", center: (tgt as any).center, p1: startId, p2: endId, r: (tgt as any).r, ccw: true };
      delete sk.entities[targetId];
      created.push(arcId, startId, endId);
    }
  }

  pruneSketch(sk);
  return { createdIds: created, affectedSketchId: sk.id, message: "Trimmed" };
}

const TAU = Math.PI * 2;
const normAng = (a: number) => ((a % TAU) + TAU) % TAU;

export function extendCurve(sk: Sketch, targetId: string, u: number, v: number): CommandApplyInfo {
  const tgt = sk.entities[targetId];
  if (!tgt || (tgt.kind !== "line" && tgt.kind !== "arc")) throw new Error("extend works on lines and arcs");
  const P = (id: string) => sk.entities[id] as SketchPoint;
  const click = { x: u, y: v };
  const others = Object.values(sk.entities).filter((e) => e.id !== targetId && e.kind !== "point");
  const dist = (p: Vec, q: Vec) => Math.hypot(p.x - q.x, p.y - q.y);
  const EPS = 1e-4;

  if (tgt.kind === "line") {
    const a = P(tgt.p1), b = P(tgt.p2);
    const endIsB = dist(click, b) <= dist(click, a);
    const dir = { x: b.x - a.x, y: b.y - a.y };
    const dl = Math.hypot(dir.x, dir.y) || 1; dir.x /= dl; dir.y /= dl;
    const BIG = 1e5;
    const longLine: ICurve = { kind: "line", a: { x: a.x - dir.x * BIG, y: a.y - dir.y * BIG }, b: { x: b.x + dir.x * BIG, y: b.y + dir.y * BIG } };
    const orig: ICurve = { kind: "line", a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };
    let bestT: number | null = null;
    for (const o of others) {
      const oc = toICurve(sk, o as any); if (!oc) continue;
      for (const pt of intersect(longLine, oc)) {
        const t = paramOf(orig, pt);
        if (endIsB && t > 1 + EPS) { if (bestT === null || t < bestT) bestT = t; }
        else if (!endIsB && t < -EPS) { if (bestT === null || t > bestT) bestT = t; }
      }
    }
    if (bestT === null) throw new Error("nothing to extend to in that direction");
    const np = pointAt(orig, bestT);
    const ep = endIsB ? P(tgt.p2) : P(tgt.p1);
    ep.x = np.x; ep.y = np.y;
    return { affectedSketchId: sk.id, message: "Extended" };
  }

  // arc
  const c = P(tgt.center), s = P(tgt.p1), e = P(tgt.p2);
  const a0 = Math.atan2(s.y - c.y, s.x - c.x);
  const a1 = Math.atan2(e.y - c.y, e.x - c.x);
  const endIsEnd = dist(click, e) <= dist(click, s);
  const full: ICurve = { kind: "circle", c: { x: c.x, y: c.y }, r: (tgt as any).r };
  let best: { ang: number; d: number } | null = null;
  for (const o of others) {
    const oc = toICurve(sk, o as any); if (!oc) continue;
    for (const pt of intersect(full, oc)) {
      const ang = Math.atan2(pt.y - c.y, pt.x - c.x);
      let d: number;
      if (endIsEnd) d = tgt.ccw ? normAng(ang - a1) : normAng(a1 - ang);
      else d = tgt.ccw ? normAng(a0 - ang) : normAng(ang - a0);
      if (d > EPS && (best === null || d < best.d)) best = { ang, d };
    }
  }
  if (!best) throw new Error("nothing to extend to");
  const np = { x: c.x + (tgt as any).r * Math.cos(best.ang), y: c.y + (tgt as any).r * Math.sin(best.ang) };
  const ep = endIsEnd ? P(tgt.p2) : P(tgt.p1);
  ep.x = np.x; ep.y = np.y;
  return { affectedSketchId: sk.id, message: "Extended" };
}

export function offsetCurve(sk: Sketch, targetId: string, d: number, ctx: CommandContext): CommandApplyInfo {
  const tgt = sk.entities[targetId];
  if (!tgt || tgt.kind === "point") throw new Error("offset works on a line, circle or arc");
  const P = (id: string) => sk.entities[id] as SketchPoint;
  const mkPt = (x: number, y: number): string => { const id = ctx.alloc("pt"); sk.entities[id] = { id, kind: "point", x, y }; return id; };

  if (tgt.kind === "line") {
    const a = P(tgt.p1), b = P(tgt.p2);
    let nx = -(b.y - a.y), ny = b.x - a.x;
    const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    const p1 = mkPt(a.x + nx * d, a.y + ny * d);
    const p2 = mkPt(b.x + nx * d, b.y + ny * d);
    const id = ctx.alloc("ln");
    sk.entities[id] = { id, kind: "line", p1, p2, construction: tgt.construction };
    return { createdIds: [id, p1, p2], affectedSketchId: sk.id, message: "Offset line" };
  }
  if (tgt.kind === "circle") {
    const c = P(tgt.center);
    const r = tgt.r + d;
    if (r <= 1e-6) throw new Error("offset distance collapses the circle");
    const ctr = mkPt(c.x, c.y);
    const id = ctx.alloc("ci");
    sk.entities[id] = { id, kind: "circle", center: ctr, r, construction: tgt.construction };
    return { createdIds: [id, ctr], affectedSketchId: sk.id, message: "Offset circle" };
  }
  // arc
  if (tgt.kind !== "arc") throw new Error("offset supports lines, circles and arcs");
  const c = P(tgt.center), s = P(tgt.p1), e = P(tgt.p2);
  const r = tgt.r + d;
  if (r <= 1e-6) throw new Error("offset distance collapses the arc");
  const a0 = Math.atan2(s.y - c.y, s.x - c.x);
  const a1 = Math.atan2(e.y - c.y, e.x - c.x);
  const ctr = mkPt(c.x, c.y);
  const p1 = mkPt(c.x + r * Math.cos(a0), c.y + r * Math.sin(a0));
  const p2 = mkPt(c.x + r * Math.cos(a1), c.y + r * Math.sin(a1));
  const id = ctx.alloc("ar");
  sk.entities[id] = { id, kind: "arc", center: ctr, p1, p2, r, ccw: (tgt as any).ccw, construction: tgt.construction };
  return { createdIds: [id, ctr, p1, p2], affectedSketchId: sk.id, message: "Offset arc" };
}

/** Find the point id two lines share, with each line's far endpoint. */
function sharedCorner(l1: SketchLine, l2: SketchLine): { c: string; a: string; b: string; l1End: "p1" | "p2"; l2End: "p1" | "p2" } | null {
  const e1: ["p1" | "p2", string][] = [["p1", l1.p1], ["p2", l1.p2]];
  const e2: ["p1" | "p2", string][] = [["p1", l2.p1], ["p2", l2.p2]];
  for (const [k1, c1] of e1) for (const [k2, c2] of e2) {
    if (c1 === c2) return { c: c1, a: k1 === "p1" ? l1.p2 : l1.p1, b: k2 === "p1" ? l2.p2 : l2.p1, l1End: k1, l2End: k2 };
  }
  return null;
}

/** Shared implementation of fillet (tangent arc) and chamfer (straight bevel). */
export function blendCorner(sk: Sketch, l1id: string, l2id: string, size: number, ctx: CommandContext, mode: "fillet" | "chamfer"): CommandApplyInfo {
  const L1 = sk.entities[l1id];
  const L2 = sk.entities[l2id];
  if (!L1 || L1.kind !== "line" || !L2 || L2.kind !== "line") throw new Error("fillet/chamfer needs two lines");
  const sc = sharedCorner(L1, L2);
  if (!sc) throw new Error("the two lines must share a corner");
  const P = (id: string) => sk.entities[id] as SketchPoint;
  const C = P(sc.c), A = P(sc.a), B = P(sc.b);
  const n = (v: Vec): Vec => { const m = Math.hypot(v.x, v.y) || 1; return { x: v.x / m, y: v.y / m }; };
  const u1 = n({ x: A.x - C.x, y: A.y - C.y });
  const u2 = n({ x: B.x - C.x, y: B.y - C.y });
  const len1 = Math.hypot(A.x - C.x, A.y - C.y);
  const len2 = Math.hypot(B.x - C.x, B.y - C.y);
  const cosT = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y));
  const theta = Math.acos(cosT);
  if (theta < 1e-3 || Math.PI - theta < 1e-3) throw new Error("the lines are collinear — no corner to blend");

  // Setback distance t along each edge from the corner.
  const t = mode === "fillet" ? size / Math.tan(theta / 2) : size;
  if (t > len1 - 1e-6 || t > len2 - 1e-6) throw new Error(`${mode} is too large for these edges`);

  const T1 = { x: C.x + u1.x * t, y: C.y + u1.y * t };
  const T2 = { x: C.x + u2.x * t, y: C.y + u2.y * t };
  const t1id = ctx.alloc("pt"); sk.entities[t1id] = { id: t1id, kind: "point", x: T1.x, y: T1.y };
  const t2id = ctx.alloc("pt"); sk.entities[t2id] = { id: t2id, kind: "point", x: T2.x, y: T2.y };

  let created: string[];
  let message: string;
  if (mode === "fillet") {
    const bis = n({ x: u1.x + u2.x, y: u1.y + u2.y });
    const dCenter = size / Math.sin(theta / 2);
    const center = { x: C.x + bis.x * dCenter, y: C.y + bis.y * dCenter };
    const cid = ctx.alloc("pt"); sk.entities[cid] = { id: cid, kind: "point", x: center.x, y: center.y };
    const arcId = ctx.alloc("ar");
    const v1 = { x: T1.x - center.x, y: T1.y - center.y };
    const v2 = { x: T2.x - center.x, y: T2.y - center.y };
    const ccw = v1.x * v2.y - v1.y * v2.x > 0; // minor arc T1→T2
    sk.entities[arcId] = { id: arcId, kind: "arc", center: cid, p1: t1id, p2: t2id, r: size, ccw };
    created = [arcId, cid, t1id, t2id];
    message = "Filleted corner";
  } else {
    const lnId = ctx.alloc("ln");
    sk.entities[lnId] = { id: lnId, kind: "line", p1: t1id, p2: t2id };
    created = [lnId, t1id, t2id];
    message = "Chamfered corner";
  }

  // Trim both edges back to their tangent points.
  (L1 as SketchLine)[sc.l1End] = t1id;
  (L2 as SketchLine)[sc.l2End] = t2id;

  // Rehome constraints that used the old corner onto the correct trimmed edge
  // (so e.g. each edge keeps its horizontal/vertical); drop any that can't map.
  for (const con of Object.values(sk.constraints) as Record<string, unknown>[]) {
    const vals = Object.values(con);
    if (!vals.includes(sc.c)) continue;
    const to = vals.includes(sc.a) ? t1id : vals.includes(sc.b) ? t2id : null;
    if (to) { for (const k of Object.keys(con)) if (con[k] === sc.c) con[k] = to; }
    else delete sk.constraints[con.id as string];
  }
  delete sk.entities[sc.c];

  return { createdIds: created, affectedSketchId: sk.id, message };
}
