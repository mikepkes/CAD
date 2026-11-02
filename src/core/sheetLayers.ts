// Layer order: which layer of folded paper lies on which, as data.
//
// Paper folded in steps (core/sheetSequence.ts) stacks its facets in planes a gap apart. Where two facets lie on
// each other, one is above the other — and that order is the thing that tells folds apart that put the paper in the
// same place: an inside reverse fold and a flap folded through land a point in the same plane, with the point's
// layers between the body's or outside them. The plan keeps that order first-class: after every step, for every
// pair of facets lying on each other, which is on the other's top side. The simple folds and collapses imply it
// (the flap lands on what it covers, in reverse order, a gap clear; layers that lay on each other stay on the same
// sides of each other); the fold operations declare it (an inside reverse fold: the point between). The heights
// the facets are drawn at are derived from it (a gap per rank), never the other way round.
//
// A stored order is checked, not searched for (finding one is NP-hard; Flat-Folder, J. Ku, does it with a SAT
// solver): the four conditions of Flat-Folder's layer-order model, in terms of the paper here —
//  - taco–tortilla: where a crease is folded flat (a taco: the facets either side lie on each other), no other
//    layer crossing that crease (a tortilla) lies between them — paper is continuous round the crease;
//  - taco–taco: two tacos at creases that lie on each other nest or lie apart; they never interleave;
//  - tortilla–tortilla: two unfolded creases lying on each other keep their sides in one order — the paper
//    doesn't cross through the other sheet;
//  - transitivity: within a stack the order is a total order (a height, so it holds by construction);
// A violation names the fold, the layers and the crease, where the old heuristics would have spaced the layers and
// said nothing. (Between the keyframes — a flap passing through a layer on its way — is the clash sweep's business,
// sequenceClashes: two facets can lie on each other at both ends of a step and swap sides legitimately, parting
// in between, so the orders at the ends alone can't tell.)

import type { Pt } from "./geometry/profile";
import type { Rigid } from "../math/transform";
import { applyPoint } from "../math/transform";

type V3 = { x: number; y: number; z: number };

const sub2 = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add2 = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const mul2 = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
const dot2 = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const len2 = (a: Pt) => Math.hypot(a.x, a.y);
const dot3 = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const sub3 = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross3 = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const unit3 = (a: V3): V3 => { const L = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / L, y: a.y / L, z: a.z / L }; };
const at3 = (p: Pt): V3 => ({ x: p.x, y: p.y, z: 0 });
const rad1 = Math.PI / 180;

export function polyArea(poly: Pt[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; s += p.x * q.y - q.x * p.y; }
  return s / 2;
}

/** Sutherland–Hodgman: the part of convex `subject` inside convex `clip` (either orientation). */
export function clipConvexPoly(subject: Pt[], clip: Pt[]): Pt[] {
  const ccw = polyArea(clip) >= 0 ? clip : [...clip].reverse();
  let out = subject;
  for (let i = 0; i < ccw.length && out.length; i++) {
    const a = ccw[i], b = ccw[(i + 1) % ccw.length];
    const side = (p: Pt) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    const next: Pt[] = [];
    for (let j = 0; j < out.length; j++) {
      const p = out[j], q = out[(j + 1) % out.length], dp = side(p), dq = side(q);
      if (dq >= 0) { if (dp < 0) next.push(add2(p, mul2(sub2(q, p), dp / (dp - dq)))); next.push(q); }
      else if (dp >= 0) next.push(add2(p, mul2(sub2(q, p), dp / (dp - dq))));
    }
    out = next;
  }
  return out;
}

/** A convex polygon with every edge moved in by `d` (empty if it vanishes). */
export function inset(poly: Pt[], d: number): Pt[] {
  const n = poly.length, lines = poly.map((p, i) => {
    const q = poly[(i + 1) % n], e = sub2(q, p), L = len2(e) || 1, nn = { x: -e.y / L, y: e.x / L };
    return { p: add2(p, mul2(nn, d)), e };
  });
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const A = lines[(i + n - 1) % n], B = lines[i], den = A.e.x * B.e.y - A.e.y * B.e.x;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((B.p.x - A.p.x) * B.e.y - (B.p.y - A.p.y) * B.e.x) / den;
    out.push(add2(A.p, mul2(A.e, t)));
  }
  if (out.length !== n || polyArea(out) <= 0) return [];
  for (let i = 0; i < n; i++) if (dot2(sub2(out[(i + 1) % n], out[i]), lines[i].e) <= 0) return [];
  return out;
}

/** Facets lying in one plane direction (within a degree), with 2D axes across it. */
export interface LayerFamily { n: V3; u: V3; v: V3; facets: number[] }

/** The layer order after a step: for every pair of facets lying on each other (same family, overlapping), which
 *  is above the other along their family's normal: `above[k] = [a, b]` — b above a. (Which side of a's own top that
 *  is follows from the way a faces: `sideMap`.) */
export interface LayerOrder {
  step: number;
  families: LayerFamily[];
  above: [number, number][];
}

/** How far apart (in gaps) two facets' planes can be and still count as lying on each other. */
export const STACK = 30;

const axesOf = (n: V3) => { const u = unit3(Math.abs(n.x) < 0.9 ? cross3(n, { x: 1, y: 0, z: 0 }) : cross3(n, { x: 0, y: 1, z: 0 })); return { u, v: cross3(n, u) }; };

/** Group posed facets by plane direction. */
export function layerFamilies(T: Rigid[]): LayerFamily[] {
  const fams: LayerFamily[] = [];
  T.forEach((t, f) => {
    const fam = fams.find((F) => Math.abs(dot3(F.n, t.z)) > Math.cos(rad1));
    if (fam) fam.facets.push(f); else fams.push({ n: t.z, ...axesOf(t.z), facets: [f] });
  });
  return fams;
}

/** The facets' outlines (inset by `margin`) in a family's plane, and each one's height along its normal. */
function flatten(fam: LayerFamily, polys: Pt[][], T: Rigid[], margin: number) {
  const shape = new Map<number, Pt[]>(), h = new Map<number, number>();
  for (const f of fam.facets) {
    const p2 = inset(polys[f], margin);
    shape.set(f, p2.map((q) => { const w = applyPoint(T[f], at3(q)); return { x: dot3(w, fam.u), y: dot3(w, fam.v) }; }));
    h.set(f, dot3(T[f].origin, fam.n));
  }
  /** Height of facet f's plane over the 2D point q (a facet a shade off the family's plane is ordered where it lies). */
  const hAt = (f: number, q: Pt) => {
    const t = T[f], nz = dot3(t.z, fam.n);
    const P0 = { x: fam.u.x * q.x + fam.v.x * q.y, y: fam.u.y * q.x + fam.v.y * q.y, z: fam.u.z * q.x + fam.v.z * q.y };
    return Math.abs(nz) < 1e-6 ? h.get(f)! : dot3(P0, fam.n) + dot3(sub3(t.origin, P0), t.z) / nz;
  };
  return { shape, h, hAt };
}

/** Where posed facets overlap, which lies on which: read from where they are (what the plan put there). */
export function layerOrderOf(polys: Pt[][], T: Rigid[], gap: number, scale: number, step: number): LayerOrder {
  const margin = Math.max(gap, 1e-4 * scale), families = layerFamilies(T);
  const above: [number, number][] = [];
  for (const fam of families) {
    if (fam.facets.length < 2) continue;
    const { shape, h, hAt } = flatten(fam, polys, T, margin);
    for (let i = 0; i < fam.facets.length; i++) for (let j = i + 1; j < fam.facets.length; j++) {
      const a = fam.facets[i], b = fam.facets[j], sa = shape.get(a)!, sb = shape.get(b)!;
      if (sa.length < 3 || sb.length < 3 || Math.abs(h.get(a)! - h.get(b)!) > gap * STACK) continue;
      const o = clipConvexPoly(sa, sb);
      if (o.length < 3 || Math.abs(polyArea(o)) < margin * margin) continue;
      const q = centroid(o);
      above.push(hAt(b, q) > hAt(a, q) ? [a, b] : [b, a]);
    }
  }
  return { step, families, above };
}

/** Each facet's rank in its stack (0 at the bottom along the family normal): the longest chain of layers under it.
 *  Heights derived from an order: a gap per rank. Pairs that would make a loop (an order that isn't one) are skipped. */
export function layerRanks(order: LayerOrder, n: number): number[] {
  const rank = new Array<number>(n).fill(0);
  const over = Array.from({ length: n }, () => [] as number[]); // over[k]: facets k lies above (along the family normal)
  for (const [a, b] of order.above) over[b].push(a);
  const state = new Uint8Array(n);
  const visit = (k: number): number => {
    if (state[k] === 2) return rank[k];
    if (state[k] === 1) return -1; // a loop
    state[k] = 1;
    let r = 0;
    for (const u of over[k]) { const ru = visit(u); if (ru >= 0) r = Math.max(r, ru + 1); }
    rank[k] = r; state[k] = 2;
    return r;
  };
  for (let k = 0; k < n; k++) visit(k);
  return rank;
}

/** A crease between two facets, for the checks: its flat segment and the fold that made it. */
export interface LayerCrease { facets: [number, number]; a: Pt; b: Pt; fold: string; made: boolean }

const fmtPt = (p: Pt) => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`;
const centroid = (poly: Pt[]): Pt => mul2(poly.reduce(add2, { x: 0, y: 0 }), 1 / poly.length);

/**
 * Check a layer order (Flat-Folder's conditions). Returns the violations, each naming the fold, the layers (by a
 * point of each on the flat sheet) and the crease.
 */
export function validateLayers(polys: Pt[][], T: Rigid[], order: LayerOrder, creases: LayerCrease[], gap: number, scale: number, foldName = `step ${order.step}`): string[] {
  const out: string[] = [];
  const margin = Math.max(gap, 1e-4 * scale);
  const side = sideMap(order, T);
  const stacked = (a: number, b: number) => side.get(`${a},${b}`);
  const name = (f: number) => `the layer at ${fmtPt(centroid(polys[f]))}`;
  for (const fam of order.families) {
    if (fam.facets.length < 2) continue;
    const { shape, hAt } = flatten(fam, polys, T, margin);
    const inFam = new Set(fam.facets);
    const area = (o: Pt[]) => (o.length >= 3 ? Math.abs(polyArea(o)) : 0);
    const cellOf = (a: number, b: number) => clipConvexPoly(shape.get(a)!, shape.get(b)!);
    // coincident layers: lying on each other at one height
    for (let i = 0; i < fam.facets.length; i++) for (let j = i + 1; j < fam.facets.length; j++) {
      const a = fam.facets[i], b = fam.facets[j];
      if (stacked(a, b) == null) continue;
      const o = cellOf(a, b);
      if (area(o) <= margin * margin) continue;
      const q = centroid(o);
      if (Math.abs(hAt(a, q) - hAt(b, q)) > 0.25 * gap) continue;
      out.push(`${foldName}: ${name(a)} and ${name(b)} lie in each other`);
    }
    // the creases of this family: tacos (folded flat, the facets on each other) and tortillas (unfolded: coplanar)
    const segOf = (c: LayerCrease) => [c.a, c.b].map((q) => { const w = applyPoint(T[c.facets[0]], at3(q)); return { x: dot3(w, fam.u), y: dot3(w, fam.v) }; }) as [Pt, Pt];
    const tacos = creases.filter((c) => inFam.has(c.facets[0]) && inFam.has(c.facets[1]) && c.made && stacked(c.facets[0], c.facets[1]) != null).map((c) => ({ c, seg: segOf(c) }));
    // (a tortilla's two facets face the same way in one plane; a fold's meet at the crease but face apart)
    const tortillas = creases.filter((c) => { const [A, B] = c.facets; if (!inFam.has(A) || !inFam.has(B) || dot3(T[A].z, T[B].z) < Math.cos(rad1)) return false; const q = mul2(add2(...segOf(c)), 0.5); return Math.abs(hAt(A, q) - hAt(B, q)) < 0.25 * gap; }).map((c) => ({ c, seg: segOf(c) }));
    /** x's plane between a's and b's, over the point q. */
    const between = (x: number, a: number, b: number, q: Pt) => (hAt(x, q) - hAt(a, q)) * (hAt(x, q) - hAt(b, q)) < 0;
    /** The crease segment's middle lies inside the facet's outline (in the family plane). */
    const crosses = (seg: [Pt, Pt], f: number) => { const s = shape.get(f)!; return s.length >= 3 && inConvex(mul2(add2(seg[0], seg[1]), 0.5), s, -margin); };
    /** Two crease segments lie on each other (collinear within the margin, overlapping). */
    const onEachOther = (p: [Pt, Pt], q: [Pt, Pt]) => {
      const e = sub2(p[1], p[0]), L = len2(e) || 1, u = mul2(e, 1 / L), nn = { x: -u.y, y: u.x };
      if (Math.abs(dot2(sub2(q[0], p[0]), nn)) > 4 * margin || Math.abs(dot2(sub2(q[1], p[0]), nn)) > 4 * margin) return false;
      const s0 = dot2(sub2(q[0], p[0]), u), s1 = dot2(sub2(q[1], p[0]), u);
      return Math.min(L, Math.max(s0, s1)) - Math.max(0, Math.min(s0, s1)) > 4 * margin;
    };
    // taco–tortilla: a layer crossing the crease, in the taco's cell, between its two sides
    for (const { c, seg } of tacos) {
      const [A, B] = c.facets, cell = cellOf(A, B);
      if (area(cell) <= margin * margin) continue;
      for (const C of fam.facets) {
        if (C === A || C === B || !crosses(seg, C)) continue;
        const o = clipConvexPoly(cell, shape.get(C)!);
        if (area(o) <= margin * margin) continue;
        if (between(C, A, B, centroid(o))) out.push(`${foldName}: ${name(C)} would pass through the paper at crease ${c.fold} (between ${name(A)} and ${name(B)}, which it joins)`);
      }
    }
    // taco–taco: two tacos at creases on each other, sharing a cell, interleaved
    for (let i = 0; i < tacos.length; i++) for (let j = i + 1; j < tacos.length; j++) {
      const p = tacos[i], q = tacos[j];
      if (!onEachOther(p.seg, q.seg)) continue;
      const [A, B] = p.c.facets, [C, D] = q.c.facets;
      if ([A, B].some((x) => [C, D].includes(x))) continue;
      const o = clipConvexPoly(cellOf(A, B), cellOf(C, D));
      if (area(o) <= margin * margin) continue;
      const m = centroid(o), inPQ = (x: number) => between(x, A, B, m), inQP = (x: number) => between(x, C, D, m);
      if (inPQ(C) !== inPQ(D) && inQP(A) !== inQP(B)) out.push(`${foldName}: the fold at crease ${p.c.fold} (${name(A)} onto ${name(B)}) and the fold at crease ${q.c.fold} (${name(C)} onto ${name(D)}) would pass through each other`);
    }
    // tortilla–tortilla: two unfolded creases on each other, their sides in one order
    for (let i = 0; i < tortillas.length; i++) for (let j = i + 1; j < tortillas.length; j++) {
      const p = tortillas[i], q = tortillas[j];
      if (!onEachOther(p.seg, q.seg)) continue;
      const [A, B] = p.c.facets, [C, D] = q.c.facets;
      if ([A, B].some((x) => [C, D].includes(x))) continue;
      // (A and B are coplanar, their tops alike: "on A's top" and "on B's top" mean the same side)
      const s1 = stacked(A, C), s2 = stacked(B, D), s3 = stacked(A, D), s4 = stacked(B, C);
      if ((s1 != null && s2 != null && s1 !== s2) || (s3 != null && s4 != null && s3 !== s4)) out.push(`${foldName}: the paper across crease ${p.c.fold} and the paper across crease ${q.c.fold} would cross through each other`);
    }
  }
  return out;
}

/** Which side of each facet's top the other lies: "a,b" → +1 when b is on a's top side, −1 on its bottom. (A turn
 *  of a whole stack keeps every entry as it is.) */
export function sideMap(order: LayerOrder, T: Rigid[]): Map<string, number> {
  const side = new Map<string, number>(), famOf = new Map<number, LayerFamily>();
  for (const F of order.families) for (const f of F.facets) famOf.set(f, F);
  for (const [a, b] of order.above) {
    const n = famOf.get(a)!.n; // b above a along n
    side.set(`${a},${b}`, dot3(T[a].z, n) > 0 ? 1 : -1);
    side.set(`${b},${a}`, dot3(T[b].z, n) > 0 ? -1 : 1);
  }
  return side;
}

/** The convex hull of points (Andrew's monotone chain), CCW. */
export function convexHull(pts: Pt[]): Pt[] {
  const P = [...pts].sort((a, b) => a.x - b.x || a.y - b.y).filter((p, i, all) => !i || Math.abs(p.x - all[i - 1].x) > 1e-12 || Math.abs(p.y - all[i - 1].y) > 1e-12);
  if (P.length < 3) return P;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [], upper: Pt[] = [];
  for (const p of P) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of [...P].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** A panel's outline from its unordered segments: the loop enclosing the most area (a slit's slot is a notch in
 *  it; a hole's loop is dropped), CCW. */
export function panelOutline(segs: [Pt, Pt][]): Pt[] {
  const pts = segs.flat(), scale = Math.max(1, ...pts.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y)))), tol = 1e-6 * scale;
  const verts: Pt[] = [];
  const id = (p: Pt) => { let k = verts.findIndex((v) => Math.abs(v.x - p.x) <= tol && Math.abs(v.y - p.y) <= tol); if (k < 0) { k = verts.length; verts.push(p); } return k; };
  const edges = segs.map(([a, b]) => [id(a), id(b)]).filter(([a, b]) => a !== b);
  const nbr = new Map<number, number[]>();
  for (const [a, b] of edges) { nbr.set(a, [...(nbr.get(a) ?? []), b]); nbr.set(b, [...(nbr.get(b) ?? []), a]); }
  const used = new Set<string>(), loops: Pt[][] = [];
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (const [a0, b0] of edges) {
    if (used.has(key(a0, b0))) continue;
    const ring = [a0];
    let prev = a0, cur = b0;
    used.add(key(a0, b0));
    for (let guard = 0; guard < edges.length && cur !== a0; guard++) {
      ring.push(cur);
      const next = (nbr.get(cur) ?? []).find((n) => n !== prev && !used.has(key(cur, n)));
      if (next == null) break;
      used.add(key(cur, next));
      prev = cur; cur = next;
    }
    if (ring.length >= 3) loops.push(ring.map((k) => verts[k]));
  }
  if (!loops.length) return convexHull(pts);
  const best = loops.reduce((a, b) => (Math.abs(polyArea(b)) > Math.abs(polyArea(a)) ? b : a));
  const clean = best.filter((p, i, all) => { const q = all[(i + all.length - 1) % all.length], r = all[(i + 1) % all.length]; const e1 = sub2(p, q), e2 = sub2(r, p); return Math.abs(e1.x * e2.y - e1.y * e2.x) > tol * (len2(e1) + len2(e2)); });
  return polyArea(clean) < 0 ? clean.reverse() : clean;
}

/** A simple polygon (CCW, maybe concave) cut into triangles (ear clipping). */
export function earClip(poly: Pt[]): Pt[][] {
  const out: Pt[][] = [];
  const ring = [...poly];
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  let guard = 0;
  while (ring.length > 3 && guard++ < 10000) {
    let cut = false;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
      if (cross(a, b, c) <= 1e-12) continue; // reflex (or flat)
      const tri = [a, b, c];
      const inside = ring.some((p) => p !== a && p !== b && p !== c && inConvex(p, tri, -1e-9));
      if (inside) continue;
      out.push(tri); ring.splice(i, 1); cut = true;
      break;
    }
    if (!cut) break;
  }
  if (ring.length === 3) out.push([...ring]);
  return out;
}

/** Panels of a sheet folded all at once (rigid origami, a pop-up card) as convex pieces: each panel's outline cut
 *  into triangles, with the panel each piece belongs to. */
export function panelPieces(panels: { segs: [Pt, Pt][] }[]): { polys: Pt[][]; panel: number[] } {
  const polys: Pt[][] = [], panel: number[] = [];
  panels.forEach((p, k) => { for (const t of earClip(panelOutline(p.segs))) { polys.push(t); panel.push(k); } });
  return { polys, panel };
}

/** Check the layer order of panels folded flat (a pop-up card closed): where they lie on each other, which is on
 *  which, and whether that stack is one paper can make (Flat-Folder's conditions). Creases are the stretches two
 *  panels' outlines share; a crease is folded where its panels lie on each other. Returns the violations. */
export function checkPanelLayers(panels: { T: Rigid; segs: [Pt, Pt][] }[], gap: number, foldName = "closed"): string[] {
  const { polys, panel } = panelPieces(panels), T = panel.map((k) => panels[k].T);
  const scale = Math.max(1, ...polys.flat().map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))));
  const order = layerOrderOf(polys, T, gap, scale, 0);
  const stacked = new Set(order.above.map(([a, b]) => `${Math.min(panel[a], panel[b])},${Math.max(panel[a], panel[b])}`));
  const creases: LayerCrease[] = [];
  const tol = 1e-5 * scale;
  const outlines = panels.map((p) => panelOutline(p.segs));
  for (let i = 0; i < polys.length; i++) for (let j = i + 1; j < polys.length; j++) {
    const pi = panel[i], pj = panel[j];
    const A = polys[i], B = polys[j];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
      const a0 = A[a], a1 = A[(a + 1) % 3], b0 = B[b], b1 = B[(b + 1) % 3];
      const e = sub2(a1, a0), L = len2(e);
      if (L < tol) continue;
      const u = mul2(e, 1 / L), nn = { x: -u.y, y: u.x };
      if (Math.abs(dot2(sub2(b0, a0), nn)) > tol || Math.abs(dot2(sub2(b1, a0), nn)) > tol) continue;
      const s0 = dot2(sub2(b0, a0), u), s1 = dot2(sub2(b1, a0), u), lo = Math.max(0, Math.min(s0, s1)), hi = Math.min(L, Math.max(s0, s1));
      if (hi - lo <= tol) continue;
      creases.push({ facets: [i, j], a: add2(a0, mul2(u, lo)), b: add2(a0, mul2(u, hi)), fold: pi === pj ? "(within a panel)" : `between the panels at ${fmtPt(centroid(outlines[pi]))} and ${fmtPt(centroid(outlines[pj]))}`, made: pi !== pj && stacked.has(`${Math.min(pi, pj)},${Math.max(pi, pj)}`) });
    }
  }
  return validateLayers(polys, T, order, creases, gap, scale, foldName);
}

/** Inside (or on, within tol) a convex polygon (either orientation). */
export function inConvex(p: Pt, poly: Pt[], tol: number): boolean {
  const ccw = polyArea(poly) >= 0 ? poly : [...poly].reverse();
  for (let i = 0; i < ccw.length; i++) {
    const a = ccw[i], b = ccw[(i + 1) % ccw.length], e = sub2(b, a), L = len2(e) || 1;
    if ((e.x * (p.y - a.y) - e.y * (p.x - a.x)) / L < -tol) return false;
  }
  return true;
}

/** A point's height along a facet's normal over its plane (the facet's top side positive). */
export const heightOver = (T: Rigid, p: V3) => dot3(sub3(p, T.origin), T.z);
