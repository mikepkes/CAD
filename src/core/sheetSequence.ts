// Sequenced folding: paper folded step by step, the way origami is diagrammed.
//
// A crease pattern folded all at once (core/sheet.ts) only moves when every
// vertex closes up — rigid origami. Most models aren't folded like that: you
// fold the corners in, then fold the result in half, and the second fold goes
// through every layer the first one stacked up. Here each fold is a line drawn
// on the flat sheet (on whichever layer it is easiest to draw it on) and a
// step number. At its step the line is carried to where that layer lies, and:
//  - every layer stacked there that belongs to the flap is creased along it
//    (the line's image on each layer is a new crease of the flat pattern);
//  - the flap — the paper on the far side of the line from the held part,
//    joined to the layer the line was drawn on without crossing the line — turns
//    about it. Paper joined to the flap anywhere else would have to tear: that's
//    an error, as is a flap that would carry the held part;
//  - layers keep a small gap: a flat fold (180°) turns about an axis set so the
//    flap lands on (or under) the layers it covers, in reverse order, one gap
//    clear — so stacked layers never coincide or pass through each other, and
//    the outer layer wraps round the inner ones at the crease as real paper does.
// A "turn" step turns the whole model over (or up) about a line, creasing nothing.
//
// All of it is planned once, with every earlier step complete: the facets (the
// flat sheet cut by every crease), which folds carry each facet, and each fold's
// axis. A pose is then just the folds' angles: a facet's placement is the
// rotations of the folds that carry it, applied in order. With one `progress`
// value running the steps in turn (0 flat, k = step k done) at most one step is
// part-way at a time, so that composition is exact. Pure geometry, no kernel:
// the viewport poses a folding sheet without a rebuild.

import type { Pt } from "./geometry/profile";
import { Rigid, IDENTITY, compose, invert, rotationAbout, applyPoint, applyVec, translation } from "../math/transform";

type V3 = { x: number; y: number; z: number };

/** A fold of the sequence, as drawn on the flat sheet. */
export interface SeqFoldDef {
  id: string;
  /** The line, drawn on the flat sheet where it crosses one layer. */
  a: Pt;
  b: Pt;
  /** Radians when the step is done: + valley (toward the top of the layer the line is drawn on), − mountain. */
  angle: number;
  /** 1, 2, …: folds of one step move together. */
  step: number;
  /** Turn the whole model about the line (+ turns the line's left side toward the top) instead of folding. */
  turn?: boolean;
  /** Fold the side of the line the sheet is held by (the paper on the other side stays put). */
  flip?: boolean;
  /** One crease of a collapse: every fold of the step moves at once, sharing paper. The line is the crease on the
   *  flat sheet, end to end (it creases only the paper it crosses there); `angle` 0 frees an existing crease to move. */
  collapse?: boolean;
  /** In a collapse: turn together with this fold (by id) — a crease of a layer stacked with its layer, folded with it
   *  (the other way round where the layers face apart). Its own angle is then ignored. */
  with?: string;
  /** In a collapse: the angle is solved so the paper stays joined (from the driven folds); the sign of `angle` says
   *  which way it starts (0: either). A driven fold's `angle` is how far it's folded when done (a crease folded
   *  already turns from where it is). */
  solve?: boolean;
  /** In a collapse: the crease goes on through every layer stacked on the top ("up") or the bottom ("down") of the
   *  one it's drawn on, or both ("both"), where its segment crosses them — each turning with it (the other way
   *  where a layer faces the other way up, so they all move alike). */
  through?: "up" | "down" | "both";
  /** With `through`: how many layers on it reaches (one layer's spacing each); default every layer of the stack. */
  depth?: number;
}

export interface SeqFacet {
  /** The facet in the flat (CCW). */
  poly: Pt[];
  /** Indices of the folds that carry it, in order. */
  moves: number[];
  /** Per move: for a collapse's fold, which of its nodes the facet moves with (−1 for an ordinary fold). */
  nodes?: number[];
}

/** A step folded as one mechanism: its facets (as they were when it began) joined in a tree from the held one, each
 *  turning about the crease to its parent. The creases' angles along the way are solved so the paper stays joined
 *  across the creases off the tree too, sampled at even steps of the step's progress. */
export interface SeqCollapse {
  step: number;
  /** The fold whose angle runs the step (0 … its angle). */
  driver: number;
  /** Parents before children: the parent node (−1 for the held one), the crease's axis (sheet-local, as the step
   *  began: a point and a unit direction, + turning valley), and the variable that sets its angle (−1: rigid), times `k`. */
  nodes: { parent: number; p: V3; u: V3; v: number; k: number }[];
  /** The variables' angles (radians) at progress k / (rows − 1). */
  table: number[][];
  /** Each node's shift when done, spacing layers that land on each other — in its own frame (as the step began),
   *  so it turns with the paper: off the layer it lies on, all the way. */
  lift: V3[];
}

export interface SeqFold {
  id: string;
  step: number;
  /** Radians when done. */
  angle: number;
  turn: boolean;
  /** A crease of the collapse with this index (SheetSequence.collapses). */
  collapse?: number;
  /** Its axis (sheet-local coords, with every earlier step done): a point and a unit direction; + angles turn right-handed about it. */
  p: V3;
  u: V3;
}

export interface SeqCrease {
  /** The fold that made it (several, when a later fold runs along it). */
  folds: number[];
  /** Where it runs in the flat. */
  a: Pt;
  b: Pt;
  /** The facets either side. */
  facets: [number, number];
  /** Radians when folded, as seen from the paper's top here: + valley, − mountain. */
  angle: number;
}

export interface SheetSequence {
  facets: SeqFacet[];
  folds: SeqFold[];
  creases: SeqCrease[];
  /** Facet edges on the sheet's outline (cut edges). */
  outline: { facet: number; a: Pt; b: Pt }[];
  /** The last step. */
  steps: number;
  /** Space between stacked layers. */
  gap: number;
  /** The collapse steps. */
  collapses?: SeqCollapse[];
}

// ---- small vector helpers -----------------------------------------------------

const sub2 = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add2 = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const mul2 = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
const dot2 = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const len2 = (a: Pt) => Math.hypot(a.x, a.y);
const sub3 = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add3 = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul3 = (a: V3, k: number): V3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot3 = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross3 = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const unit3 = (a: V3): V3 => mul3(a, 1 / (Math.hypot(a.x, a.y, a.z) || 1));
const at3 = (p: Pt): V3 => ({ x: p.x, y: p.y, z: 0 });

export function polyArea(poly: Pt[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; s += p.x * q.y - q.x * p.y; }
  return s / 2;
}

const centroid = (poly: Pt[]): Pt => mul2(poly.reduce(add2, { x: 0, y: 0 }), 1 / poly.length);

/** Inside (or on, within tol) a convex CCW polygon. */
function inConvex(p: Pt, poly: Pt[], tol: number): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], e = sub2(b, a), L = len2(e) || 1;
    if ((e.x * (p.y - a.y) - e.y * (p.x - a.x)) / L < -tol) return false;
  }
  return true;
}

/** A convex polygon cut by a signed distance: the parts where it's ≥ 0 and ≤ 0 (either may be empty). */
function cutConvex(poly: Pt[], d: number[], tol: number): { pos: Pt[]; neg: Pt[]; chord?: [Pt, Pt] } {
  if (d.every((v) => v >= -tol)) return { pos: poly, neg: [] };
  if (d.every((v) => v <= tol)) return { pos: [], neg: poly };
  const pos: Pt[] = [], neg: Pt[] = [], cut: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length, p = poly[i], q = poly[j];
    const dp = Math.abs(d[i]) <= tol ? 0 : d[i], dq = Math.abs(d[j]) <= tol ? 0 : d[j];
    if (dp >= 0) pos.push(p);
    if (dp <= 0) neg.push(p);
    if (dp === 0) cut.push(p);
    if ((dp > 0 && dq < 0) || (dp < 0 && dq > 0)) {
      const x = add2(p, mul2(sub2(q, p), dp / (dp - dq)));
      pos.push(x); neg.push(x); cut.push(x);
    }
  }
  const clean = (ps: Pt[]) => ps.filter((p, i) => len2(sub2(p, ps[(i + 1) % ps.length])) > tol);
  const P = clean(pos), N = clean(neg);
  if (P.length < 3 || Math.abs(polyArea(P)) < tol * tol) return { pos: [], neg: poly };
  if (N.length < 3 || Math.abs(polyArea(N)) < tol * tol) return { pos: poly, neg: [] };
  return { pos: P, neg: N, chord: cut.length >= 2 ? [cut[0], cut[cut.length - 1]] : undefined };
}

/** The stretch two segments share, if they lie on one line and overlap. */
function sharedSpan(a0: Pt, a1: Pt, b0: Pt, b1: Pt, tol: number): [Pt, Pt] | undefined {
  const e = sub2(a1, a0), L = len2(e);
  if (L < tol) return undefined;
  const u = mul2(e, 1 / L), n = { x: -u.y, y: u.x };
  if (Math.abs(dot2(sub2(b0, a0), n)) > tol || Math.abs(dot2(sub2(b1, a0), n)) > tol) return undefined;
  const s0 = dot2(sub2(b0, a0), u), s1 = dot2(sub2(b1, a0), u);
  const lo = Math.max(0, Math.min(s0, s1)), hi = Math.min(L, Math.max(s0, s1));
  if (hi - lo <= tol) return undefined;
  return [add2(a0, mul2(u, lo)), add2(a0, mul2(u, hi))];
}

interface Work { poly: Pt[]; T: Rigid; moves: number[]; nodes: number[] }

/** Every stretch of edge two facets share: [i, j, a, b]. */
function adjacency(fs: { poly: Pt[] }[], tol: number): [number, number, Pt, Pt][] {
  const out: [number, number, Pt, Pt][] = [];
  const box = fs.map((f) => ({ x0: Math.min(...f.poly.map((p) => p.x)) - tol, x1: Math.max(...f.poly.map((p) => p.x)) + tol, y0: Math.min(...f.poly.map((p) => p.y)) - tol, y1: Math.max(...f.poly.map((p) => p.y)) + tol }));
  for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) {
    const A = box[i], B = box[j];
    if (A.x1 < B.x0 || B.x1 < A.x0 || A.y1 < B.y0 || B.y1 < A.y0) continue;
    const P = fs[i].poly, Q = fs[j].poly;
    for (let a = 0; a < P.length; a++) for (let b = 0; b < Q.length; b++) {
      const s = sharedSpan(P[a], P[(a + 1) % P.length], Q[b], Q[(b + 1) % Q.length], tol);
      if (s) out.push([i, j, s[0], s[1]]);
    }
  }
  return out;
}

const fmtPt = (p: Pt) => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`;

/**
 * Plan a sequenced fold of the convex blank `sheet` (CCW, flat coords): the
 * folds in step order (a step's folds in the order given), the sheet held at
 * `fixed`, layers `gap` apart.
 */
export function planSequence(sheet: Pt[], defs: SeqFoldDef[], fixed: Pt, gap: number): SheetSequence {
  if (sheet.length < 3) throw new Error("the sheet needs a blank to fold");
  const blank = polyArea(sheet) < 0 ? [...sheet].reverse() : sheet;
  for (let i = 0; i < blank.length; i++) {
    const a = blank[i], b = blank[(i + 1) % blank.length], c = blank[(i + 2) % blank.length];
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) < -1e-9 * len2(sub2(b, a)) * len2(sub2(c, b))) throw new Error("folding in steps needs a convex sheet (a square, a rectangle, any convex outline)");
  }
  const scale = Math.max(1, ...blank.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))));
  const tol = 1e-7 * scale, wtol = 1e-5 * scale;
  let work: Work[] = [{ poly: blank, T: IDENTITY, moves: [], nodes: [] }];
  const order = defs.map((d, i) => ({ d, i })).sort((x, y) => x.d.step - y.d.step || x.i - y.i).map((x) => x.d);
  const folds: SeqFold[] = [];
  const chords: { fold: number; a: Pt; b: Pt; angle: number }[] = [];
  const collapses: SeqCollapse[] = [];

  const held = () => { const k = work.findIndex((w) => inConvex(fixed, w.poly, tol)); return k < 0 ? 0 : k; };
  const facetAt = (p: Pt) => work.findIndex((w) => inConvex(p, w.poly, -tol)) >= 0 ? work.findIndex((w) => inConvex(p, w.poly, -tol)) : work.findIndex((w) => inConvex(p, w.poly, tol));

  for (let s = 0; s < order.length;) {
    const step = order[s].step;
    const group: SeqFoldDef[] = [];
    while (s < order.length && order[s].step === step) group.push(order[s++]);
    if (group.some((d) => d.collapse)) {
      if (!group.every((d) => d.collapse && !d.turn)) throw new Error(`step ${step}: a collapse is a step of its own (every fold of it marked collapse, none a turn)`);
      work = collapseStep(work, group, step, fixed, folds, chords, collapses, gap, scale, tol);
      continue;
    }
    const pending: { fold: number; members: Set<Work> }[] = [];
    for (const def of group) {
      const name = `fold "${def.id}" (step ${step})`;
      const L = len2(sub2(def.b, def.a));
      if (L < tol) throw new Error(`${name}: its line has no length`);
      const mid = mul2(add2(def.a, def.b), 0.5), left = mul2({ x: -(def.b.y - def.a.y), y: def.b.x - def.a.x }, 1 / L);
      const probe = Math.min(1e-3 * scale, L / 4);
      let ri = facetAt(add2(mid, mul2(left, probe)));
      if (ri < 0) ri = facetAt(sub2(mid, mul2(left, probe)));
      if (ri < 0) throw new Error(`${name}: its line isn't on the sheet`);
      const ref = work[ri];
      const P = applyPoint(ref.T, at3(def.a)), e = unit3(sub3(applyPoint(ref.T, at3(def.b)), P)), n = ref.T.z;
      const heightOf = (w: Work) => dot3(sub3(w.T.origin, P), n);
      const parallel = (w: Work) => Math.abs(dot3(w.T.z, n)) > 1 - 1e-6;

      if (def.turn) {
        const hs = work.filter(parallel).map(heightOf);
        const h = hs.length ? (Math.min(...hs) + Math.max(...hs)) / 2 : 0;
        folds.push({ id: def.id, step, angle: def.angle, turn: true, p: add3(P, mul3(n, h)), u: e });
        pending.push({ fold: folds.length - 1, members: new Set(work) });
        continue;
      }

      // the moving side: away from the held part (or toward it, flipped)
      const hw = work[held()];
      const hc = applyPoint(hw.T, at3(inConvex(fixed, hw.poly, tol) ? fixed : centroid(hw.poly)));
      const side = dot3(sub3(hc, P), cross3(n, e));
      let sigma = side > wtol ? -1 : 1;
      if (def.flip) sigma = -sigma;
      const m = mul3(cross3(n, e), sigma);
      const dist = (w: Work, p: Pt) => dot3(sub3(applyPoint(w.T, at3(p)), P), m);

      // cut every layer the line crosses (tentatively: only the flap's layers keep the cut)
      type Piece = { w: Work; poly: Pt[]; from: number; side: 1 | -1 | 0; chord?: [Pt, Pt] };
      const pieces: Piece[] = [];
      work.forEach((w, k) => {
        if (!parallel(w)) { pieces.push({ w, poly: w.poly, from: k, side: dist(w, centroid(w.poly)) > 0 ? 1 : -1 }); return; }
        const c = cutConvex(w.poly, w.poly.map((p) => dist(w, p)), wtol);
        if (c.pos.length && c.neg.length) {
          pieces.push({ w, poly: c.pos, from: k, side: 1, chord: c.chord }, { w, poly: c.neg, from: k, side: -1, chord: c.chord });
        } else pieces.push({ w, poly: w.poly, from: k, side: c.pos.length ? 1 : -1 });
      });
      // the flap: what's joined to the moving side of the drawn layer without crossing the line
      const mflat = (() => { const v = applyVec(invert(ref.T), m); return mul2({ x: v.x, y: v.y }, 1 / (Math.hypot(v.x, v.y) || 1)); })();
      const seedPt = add2(mid, mul2(mflat, probe));
      const seed = pieces.findIndex((pc) => inConvex(seedPt, pc.poly, tol) && pc.side === 1);
      if (seed < 0) throw new Error(`${name}: nothing to fold on that side of its line`);
      const adj = adjacency(pieces, tol);
      const onLine = (pc: Piece, a: Pt, b: Pt) => Math.abs(dist(pc.w, a)) < wtol && Math.abs(dist(pc.w, b)) < wtol;
      const links = pieces.map(() => [] as number[]);
      for (const [i, j, a, b] of adj) {
        if (onLine(pieces[i], a, b) && onLine(pieces[j], a, b)) continue;
        links[i].push(j); links[j].push(i);
      }
      // ... and every layer the flap would have to pass through: on its side of the line,
      // over it (toward where it folds), wherever they overlap — those come along, as a
      // flap's inner layers do when you fold it
      const toward = Math.sign(def.angle) || 1;
      const flatIn = pieces.map((pc) => pc.poly.map((p) => { const X = sub3(applyPoint(pc.w.T, at3(p)), P); return { x: dot3(X, e), y: dot3(X, m) }; }));
      const hgt = pieces.map((pc) => heightOf(pc.w));
      const flap = new Set([seed]);
      for (let grew = true; grew;) {
        grew = false;
        for (const q = [...flap]; q.length;) for (const j of links[q.pop()!]) if (!flap.has(j)) { flap.add(j); q.push(j); grew = true; }
        pieces.forEach((pc, j) => {
          if (flap.has(j) || pc.side !== 1 || !parallel(pc.w)) return;
          for (const i of flap) {
            if (!parallel(pieces[i].w) || toward * (hgt[j] - hgt[i]) <= wtol) continue;
            const o = clipConvexPoly(flatIn[j], flatIn[i]);
            if (o.length >= 3 && Math.abs(polyArea(o)) > 1e-4 * scale) { flap.add(j); grew = true; return; }
          }
        });
      }
      for (const i of flap) {
        if (pieces[i].side !== 1) {
          const p = pieces[i].poly[0];
          throw new Error(`${name}: the paper is joined across the line near ${fmtPt(p)}, so it would tear — fold those layers too, or draw the line where the flap comes free`);
        }
      }
      const hk = held();
      if ([...flap].some((i) => pieces[i].from === hk && inConvex(fixed, pieces[i].poly, -tol))) throw new Error(`${name}: the flap holds the part the sheet is held by — hold it elsewhere (fixed) or flip the fold`);

      // keep the cuts through the flap's layers; mend the rest
      const next: Work[] = [], members = new Set<Work>();
      const splitKept = new Set<number>();
      for (const i of flap) if (pieces[i].chord) splitKept.add(pieces[i].from);
      const replaced = new Map<Work, Work[]>();
      pieces.forEach((pc, i) => {
        if (pc.chord && !splitKept.has(pc.from)) { if (pc.side === 1) next.push(pc.w); return; } // the uncut layer, once
        const w: Work = pc.chord ? { poly: pc.poly, T: pc.w.T, moves: [...pc.w.moves], nodes: [...pc.w.nodes] } : pc.w;
        if (pc.chord) replaced.set(pc.w, [...(replaced.get(pc.w) ?? []), w]);
        next.push(w);
        if (flap.has(i)) members.add(w);
      });
      // an earlier fold of this step keeps the pieces of what it moves (so the overlap check below sees them)
      for (const pd of pending) for (const [old, parts] of replaced) if (pd.members.delete(old)) for (const p of parts) pd.members.add(p);
      // the crease on each layer it cuts, as seen from that layer's top
      const dir = Math.sign(def.angle) || 1;
      for (const k of splitKept) {
        const c = pieces.find((pc) => pc.from === k && pc.chord)!;
        chords.push({ fold: folds.length, a: c.chord![0], b: c.chord![1], angle: def.angle * Math.sign(dot3(c.w.T.z, n)) });
      }
      // a fold along an existing crease or edge refolds it
      for (const [i, j, a, b] of adj) {
        if (!onLine(pieces[i], a, b) || !onLine(pieces[j], a, b)) continue;
        if (flap.has(i) === flap.has(j) || (pieces[i].chord && pieces[j].chord && pieces[i].from === pieces[j].from)) continue;
        const still = flap.has(i) ? pieces[j] : pieces[i];
        chords.push({ fold: folds.length, a, b, angle: def.angle * Math.sign(dot3(still.w.T.z, n)) });
      }

      // the axis: a flat fold lands the flap a gap clear of what it covers; a part fold hinges on the flap's inside face
      const flat = Math.abs(Math.abs(def.angle) - Math.PI) < 1e-3;
      const movingW = [...members], stillW = next.filter((w) => !members.has(w) && parallel(w));
      const hs = movingW.filter(parallel).map(heightOf);
      let H = dir > 0 ? Math.max(...hs) : Math.min(...hs);
      if (flat) {
        const plane = (w: Work, mirror: boolean) => w.poly.map((p) => { const X = sub3(applyPoint(w.T, at3(p)), P); return { x: dot3(X, e), y: (mirror ? -1 : 1) * dot3(X, m) }; });
        const stillP = stillW.map((w) => ({ h: heightOf(w), poly: plane(w, false) }));
        for (const w of movingW.filter(parallel)) {
          const img = plane(w, true), hf = heightOf(w);
          for (const g of stillP) {
            const o = clipConvexPoly(img, g.poly);
            if (o.length < 3 || Math.abs(polyArea(o)) < 1e-4 * scale) continue;
            H = dir > 0 ? Math.max(H, (g.h + hf + gap) / 2) : Math.min(H, (g.h + hf - gap) / 2);
          }
        }
      }
      if (!Number.isFinite(H)) H = 0;
      folds.push({ id: def.id, step, angle: def.angle, turn: false, p: add3(P, mul3(n, H)), u: unit3(cross3(m, n)) });
      pending.push({ fold: folds.length - 1, members });
      work = next;
    }
    // a step's folds move apart: no facet in two of them
    for (let i = 0; i < pending.length; i++) for (let j = i + 1; j < pending.length; j++) {
      if (folds[pending[i].fold].turn || folds[pending[j].fold].turn) throw new Error(`step ${step}: a turn is a step of its own`);
      for (const w of pending[i].members) if (pending[j].members.has(w)) throw new Error(`step ${step}: folds "${folds[pending[i].fold].id}" and "${folds[pending[j].fold].id}" move the same paper — make them separate steps`);
    }
    // then the step is done: its folds' flaps turn
    for (const { fold, members } of pending) {
      const f = folds[fold], R = rotationAbout(f.u, f.angle, f.p);
      for (const w of members) { w.T = compose(R, w.T); w.moves.push(fold); w.nodes.push(-1); }
    }
  }

  // the creases and the outline, on the final facets
  const facets: SeqFacet[] = work.map((w) => ({ poly: w.poly, moves: w.moves, ...(w.nodes.some((k) => k >= 0) ? { nodes: w.nodes } : {}) }));
  const adj = adjacency(facets, tol);
  const creases: SeqCrease[] = [];
  for (const [i, j, a, b] of adj) {
    const on = chords.filter((c) => sharedSpan(c.a, c.b, a, b, wtol));
    if (!on.length) continue;
    const last = on[on.length - 1];
    creases.push({ folds: [...new Set(on.map((c) => c.fold))].sort((x, y) => x - y), a, b, facets: [i, j], angle: last.angle });
  }
  const outline: SheetSequence["outline"] = [];
  facets.forEach((f, k) => {
    for (let i = 0; i < f.poly.length; i++) {
      const a = f.poly[i], b = f.poly[(i + 1) % f.poly.length], L = len2(sub2(b, a));
      if (L < tol) continue;
      const u = mul2(sub2(b, a), 1 / L);
      const covered = adj.filter(([x, y]) => x === k || y === k).map(([, , p, q]) => sharedSpan(a, b, p, q, tol)).filter((s): s is [Pt, Pt] => !!s)
        .map(([p, q]) => [dot2(sub2(p, a), u), dot2(sub2(q, a), u)].sort((x, y) => x - y)).sort((x, y) => x[0] - y[0]);
      let t = 0;
      for (const [lo, hi] of covered) { if (lo > t + tol) outline.push({ facet: k, a: add2(a, mul2(u, t)), b: add2(a, mul2(u, lo)) }); t = Math.max(t, hi); }
      if (t < L - tol) outline.push({ facet: k, a: add2(a, mul2(u, t)), b });
    }
  });
  return { facets, folds, creases, outline, steps: Math.max(0, ...folds.map((f) => f.step)), gap, ...(collapses.length ? { collapses } : {}) };
}


// ---- collapses --------------------------------------------------------------------

type Chord = { fold: number; a: Pt; b: Pt; angle: number };

/** Samples of a collapse's motion, and how far before its end to look at which way layers come in to land. */
const COLLAPSE_SAMPLES = 40, APPROACH = 0.1, rad1 = Math.PI / 180;
/** The most layers a stack of paper runs to: layers further apart than this many gaps aren't lying on each other. */
const STACK = 30;

/** A collapse: the step's creases all move at once. Cut the facets along each crease (on the flat sheet, end to
 *  end, and on every layer a crease is carried `through`); join every facet to the held one in a tree, through paper
 *  that doesn't bend first, so each rigid piece moves as one; turn the driven creases steadily and solve the rest
 *  so the joins off the tree hold too (a sample at a time, each from where the last ones point); then space the
 *  layers that land on each other a gap apart, in the order they lie or come in. */
function collapseStep(work: Work[], group: SeqFoldDef[], step: number, fixed: Pt, folds: SeqFold[], chords: Chord[], collapses: SeqCollapse[], gap: number, scale: number, tol: number): Work[] {
  const wtol = 1e-5 * scale, ci = collapses.length, first = folds.length;
  // a crease through the layers: the same segment, where it lies on each layer of the stack, turning with it
  const only = new Map<SeqFoldDef, Rigid>();
  const copies: SeqFoldDef[] = [];
  for (const def of group) {
    if (!def.through) continue;
    const mid = mul2(add2(def.a, def.b), 0.5), ref = work.find((w) => inConvex(mid, w.poly, wtol));
    if (!ref) throw new Error(`fold "${def.id}" (step ${step}): its line isn't on the sheet`);
    const A = applyPoint(ref.T, at3(def.a)), B = applyPoint(ref.T, at3(def.b)), n = ref.T.z, sg = def.through === "up" ? 1 : def.through === "down" ? -1 : 0;
    const seen = new Set<Rigid>([ref.T]);
    work.forEach((w) => {
      if (seen.has(w.T) || Math.abs(dot3(w.T.z, n)) < Math.cos(rad1)) return;
      const d = dot3(sub3(applyPoint(w.T, at3(centroid(w.poly))), A), n), h = sg ? sg * d : Math.abs(d);
      if (h < 0.25 * gap || h > gap * (def.depth != null ? def.depth + 0.5 : work.length + 2)) return;
      const inv = invert(w.T), a2 = applyPoint(inv, A), b2 = applyPoint(inv, B), a = { x: a2.x, y: a2.y }, b = { x: b2.x, y: b2.y };
      // does the segment cross this layer?
      const L = len2(sub2(b, a)), u = mul2(sub2(b, a), 1 / (L || 1)), nrm = { x: -u.y, y: u.x };
      const c = cutConvex(w.poly, w.poly.map((p) => dot2(sub2(p, a), nrm)), wtol);
      // it crosses the layer, or runs along one of its edges (a crease there already, now turning with it)
      const along = w.poly.some((p, i) => { const sp = sharedSpan(a, b, p, w.poly[(i + 1) % w.poly.length], wtol); return !!sp && len2(sub2(sp[1], sp[0])) > 10 * wtol; });
      if (!along) {
        if (!c.chord || !c.pos.length || !c.neg.length) return;
        const t0 = dot2(sub2(c.chord[0], a), u), t1 = dot2(sub2(c.chord[1], a), u);
        if (Math.max(t0, t1) <= wtol || Math.min(t0, t1) >= L - wtol) return;
      }
      seen.add(w.T);
      const copy: SeqFoldDef = { id: `${def.id}~${copies.length + 1}`, a, b, angle: 0, step, collapse: true, with: def.id };
      only.set(copy, w.T);
      copies.push(copy);
    });
  }
  group = [...group, ...copies];
  for (const def of group) {
    const name = `fold "${def.id}" (step ${step})`;
    const L = len2(sub2(def.b, def.a));
    if (L < tol) throw new Error(`${name}: its line has no length`);
    const u = mul2(sub2(def.b, def.a), 1 / L), nrm = { x: -u.y, y: u.x };
    const next: Work[] = [];
    for (const w of work) {
      if (only.has(def) && only.get(def) !== w.T) { next.push(w); continue; } // a copy on its own layer only
      const c = cutConvex(w.poly, w.poly.map((p) => dot2(sub2(p, def.a), nrm)), wtol);
      if (!c.pos.length || !c.neg.length || !c.chord) { next.push(w); continue; }
      const t0 = dot2(sub2(c.chord[0], def.a), u), t1 = dot2(sub2(c.chord[1], def.a), u), lo = Math.min(t0, t1), hi = Math.max(t0, t1);
      if (hi <= wtol || lo >= L - wtol) { next.push(w); continue; } // the crease doesn't reach this facet
      // (a crease that stops inside the facet cuts it right across: past its end the paper stays joined, unfolded —
      // usually another crease of the step carries on from there, meeting it at a vertex)
      next.push({ poly: c.pos, T: w.T, moves: [...w.moves], nodes: [...w.nodes] }, { poly: c.neg, T: w.T, moves: [...w.moves], nodes: [...w.nodes] });
    }
    work = next;
    const on = work.find((w) => inConvex(mul2(add2(def.a, def.b), 0.5), w.poly, wtol)) ?? work[0];
    const P = applyPoint(on.T, at3(def.a));
    folds.push({ id: def.id, step, angle: def.angle, turn: false, collapse: ci, p: P, u: unit3(sub3(applyPoint(on.T, at3(def.b)), P)) });
  }
  const driverAt = group.findIndex((d) => Math.abs(d.angle) > 1e-9 && !d.with && !d.solve);
  if (driverAt < 0) throw new Error(`step ${step}: a collapse needs a crease driven through an angle (not solved, not 0)`);

  // the joins: every stretch of edge two facets share; a crease of the step where it runs along one's line
  const joins = adjacency(work, tol).map(([i, j, a, b]) => {
    // the fold whose crease runs along it furthest (a crease cut right across a facet owns the whole cut)
    let k = -1, best = 2 * wtol;
    group.forEach((d, q) => {
      if (only.has(d) && only.get(d) !== work[i].T && only.get(d) !== work[j].T) return;
      const sp = sharedSpan(a, b, d.a, d.b, wtol), len = sp ? len2(sub2(sp[1], sp[0])) : 0;
      if (len > best) { best = len; k = q; }
    });
    return { i, j, a, b, def: k };
  });
  // (a crease carried through the layers that only meets a layer's raw edge creases nothing there)
  group.forEach((d, k) => { if (!only.has(d) && !joins.some((J) => J.def === k)) throw new Error(`fold "${d.id}" (step ${step}): its crease doesn't run between two pieces of paper`); });

  // the tree, from the held facet: 0-1 breadth first, rigid joins before creases
  const n = work.length, links = work.map(() => [] as number[]);
  joins.forEach((J, k) => { links[J.i].push(k); links[J.j].push(k); });
  const root = Math.max(0, work.findIndex((w) => inConvex(fixed, w.poly, tol)));
  const dist = new Array(n).fill(Infinity), via = new Array(n).fill(-1), done = new Array(n).fill(false), order: number[] = [];
  dist[root] = 0;
  for (const dq: number[] = [root]; dq.length;) {
    const f = dq.shift()!;
    if (done[f]) continue;
    done[f] = true; order.push(f);
    for (const k of links[f]) {
      const J = joins[k], g = J.i === f ? J.j : J.i, d = dist[f] + (J.def >= 0 ? 1 : 0);
      if (d < dist[g]) { dist[g] = d; via[g] = k; if (J.def >= 0) dq.push(g); else dq.unshift(g); }
    }
  }
  if (order.length !== n) throw new Error(`step ${step}: the paper isn't in one piece`);
  // one variable per fold; a fold `with` another turns by its variable: the same turn of the paper, each side of it
  // going with the side of the other it lies against (a point a little way into each side, beside the crease's middle)
  const beside = (J: (typeof joins)[number], f: number) => {
    const e = sub2(J.b, J.a), L = len2(e) || 1, mid = mul2(add2(J.a, J.b), 0.5), c = centroid(work[f].poly);
    const nrm = mul2({ x: -e.y, y: e.x }, (Math.sign(-e.y * (c.x - mid.x) + e.x * (c.y - mid.y)) || 1) / L);
    return applyPoint(work[f].T, at3(add2(mid, mul2(nrm, Math.min(0.02 * scale, 0.25 * L)))));
  };
  const turnAlike = (q: number, L: number): number => {
    const A = joins.find((K) => K.def === q), B = joins.find((K) => K.def === L);
    if (!A || !B) return 1;
    // creases apart (not one stacked on the other): turning alike is folding alike — the same angle
    const line = (J: (typeof joins)[number]) => { const T = work[J.i].T, a = applyPoint(T, at3(J.a)); return { a, e: unit3(sub3(applyPoint(T, at3(J.b)), a)) }; };
    const la = line(A), lb = line(B), off = sub3(la.a, lb.a), across = sub3(off, mul3(lb.e, dot3(off, lb.e)));
    if (Math.abs(dot3(la.e, lb.e)) < Math.cos(rad1) || Math.hypot(across.x, across.y, across.z) > gap * STACK) return 1;
    const d = (x: V3, y: V3) => Math.hypot(x.x - y.x, x.y - y.y, x.z - y.z);
    const same = d(beside(A, A.i), beside(B, B.i)) + d(beside(A, A.j), beside(B, B.j)) <= d(beside(A, A.i), beside(B, B.j)) + d(beside(A, A.j), beside(B, B.i));
    // each turns its j side about its axis as seen from its i side (as hinge() does)
    const axis = (J: (typeof joins)[number]) => {
      const T = work[J.i].T, e = sub2(J.b, J.a), c = centroid(work[J.j].poly), side = Math.sign(e.x * (c.y - J.a.y) - e.y * (c.x - J.a.x)) || 1;
      return cross3(applyVec(T, at3(mul2({ x: -e.y, y: e.x }, side / (len2(e) || 1)))), T.z);
    };
    return (dot3(axis(A), axis(B)) < 0 ? -1 : 1) * (same ? 1 : -1);
  };
  const lead = group.map((d, k) => {
    if (!d.with) return { k, r: 1 };
    const L = group.findIndex((e) => e.id === d.with && e !== d);
    if (L < 0 || group[L].with) throw new Error(`fold "${d.id}" (step ${step}): it turns with "${d.with}", which isn't a fold of this step turning on its own`);
    return { k: L, r: turnAlike(k, L) };
  });
  const vars: number[] = [], varIdx = group.map((d, k) => (d.with ? -1 : vars.push(k) - 1));
  const varOf = joins.map((J) => (J.def >= 0 ? { v: varIdx[lead[J.def].k], k: lead[J.def].r } : { v: -1, k: 1 }));
  const nodeOf = new Array(n).fill(-1);
  order.forEach((f, k) => (nodeOf[f] = k));
  /** A join's hinge, as seen from facet `from`: a point, and the axis turning the other side valley-positive. */
  const hinge = (J: (typeof joins)[number], from: number): { p: V3; u: V3 } => {
    const to = from === J.i ? J.j : J.i, T = work[from].T, e = sub2(J.b, J.a), c = centroid(work[to].poly);
    const side = Math.sign(e.x * (c.y - J.a.y) - e.y * (c.x - J.a.x)) || 1;
    const m = applyVec(T, at3(mul2({ x: -e.y, y: e.x }, side / (len2(e) || 1))));
    // a crease carried through a stack turns about its drawn layer's line: the stack folds as one, the layers
    // keeping their order (each about its own line, they'd pass through each other part-way)
    const d = J.def >= 0 ? group[J.def] : undefined, Jl = d && only.has(d) ? joins.find((K) => K.def === lead[J.def].k) : undefined;
    return { p: Jl ? applyPoint(work[Jl.i].T, at3(Jl.a)) : applyPoint(T, at3(J.a)), u: unit3(cross3(m, T.z)) };
  };
  const nodes: SeqCollapse["nodes"] = order.map((f) => {
    if (via[f] < 0) return { parent: -1, p: { x: 0, y: 0, z: 0 }, u: { x: 0, y: 0, z: 1 }, v: -1, k: 1 };
    const J = joins[via[f]], from = J.i === f ? J.j : J.i;
    return { parent: nodeOf[from], ...hinge(J, from), ...varOf[via[f]] };
  });
  /** How far a join is folded now (radians, + valley as seen from facet i's top; a flat fold's way from where j lies). */
  const folded = (J: (typeof joins)[number]) => {
    const { p: P0, u } = hinge(J, J.i), ni = work[J.i].T.z, nj = work[J.j].T.z;
    const th = Math.atan2(dot3(cross3(ni, nj), u), dot3(ni, nj));
    if (Math.abs(th) < Math.PI - 1e-3) return th;
    return Math.PI * (Math.sign(dot3(sub3(applyPoint(work[J.j].T, at3(centroid(work[J.j].poly))), P0), ni)) || 1);
  };
  // a driven crease turns to its angle (from however far it's folded already); a solved one starts its way
  const target = vars.map((k) => (group[k].solve ? group[k].angle : group[k].angle - folded(joins.find((J) => J.def === k)!)));
  const loops = joins.map((J, k) => ({ J, k })).filter(({ J, k }) => via[J.i] !== k && via[J.j] !== k)
    .map(({ J, k }) => ({ i: nodeOf[J.i], j: nodeOf[J.j], ...hinge(J, J.i), ...varOf[k], pts: [J.a, J.b, centroid(work[J.j].poly)].map((q) => applyPoint(work[J.j].T, at3(q))) }));

  const fk = (x: number[]) => collapseMotion(nodes, x);
  const residual = (x: number[]) => {
    const M = fk(x), r: number[] = [];
    for (const L of loops) {
      const pred = L.v < 0 ? M[L.i] : compose(M[L.i], rotationAbout(L.u, L.k * x[L.v], L.p));
      for (const q of L.pts) { const a = applyPoint(M[L.j], q), b = applyPoint(pred, q); r.push(a.x - b.x, a.y - b.y, a.z - b.z); }
    }
    return r;
  };
  // the path: the driven creases turn steadily; the solved ones follow so every join holds (least squares, each
  // sample started from where the last two point, the first from the way each is meant to go)
  const solved = vars.map((k) => !!group[k].solve), free = solved.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  const now = vars.map((k) => folded(joins.find((J) => J.def === k)!));
  const table: number[][] = [vars.map(() => 0)];
  {
    const mu = (5e-3 * scale) ** 2;
    let x = vars.map(() => 0), prev = x;
    for (let k = 1; k <= COLLAPSE_SAMPLES; k++) {
      const sk = k / COLLAPSE_SAMPLES;
      const guess = x.map((v, i) => (solved[i] ? (k === 1 ? Math.sign(target[i]) * 0.05 : v + (v - prev[i])) : sk * target[i]));
      prev = x;
      x = guess;
      if (free.length && loops.length) {
        const put = (y: number[]) => { const z = [...x]; free.forEach((i, q) => (z[i] = y[q])); return z; };
        const F = (y: number[]) => [...residual(put(y)), ...y.map((v, q) => Math.sqrt(mu) * (v - guess[free[q]]))];
        let y = free.map((i) => x[i]), f = F(y), cost = f.reduce((a, v) => a + v * v, 0);
        for (let it = 0; it < 60; it++) {
          const h = 1e-7, Jc = y.map((_, c) => { const z = [...y]; z[c] += h; return F(z).map((v, i) => (v - f[i]) / h); });
          const A = y.map((_, a) => y.map((_, b) => Jc[a].reduce((s2, v, i) => s2 + v * Jc[b][i], 0) + (a === b ? 1e-12 : 0)));
          const g = y.map((_, a) => -Jc[a].reduce((s2, v, i) => s2 + v * f[i], 0));
          const dy = solveSmall(A, g);
          if (!dy) break;
          const big = Math.max(...dy.map(Math.abs));
          let t = big > 0.15 ? 0.15 / big : 1, better = false; // a short way at a time: past a singular pose there are other branches
          for (let tries = 0; tries < 16; tries++, t /= 2) {
            const z = y.map((v, i) => v + t * dy[i]), fz = F(z), cz = fz.reduce((a, v) => a + v * v, 0);
            if (cz < cost) { y = z; f = fz; better = cost - cz > 1e-16 * (1 + cost); cost = cz; break; }
          }
          if (!better || Math.max(...dy.map(Math.abs)) * t < 1e-12) break;
        }
        // paper folded flat can't fold further: a solved crease stops there (rather than pass the layers through each other)
        x = put(y).map((v, i) => (solved[i] ? Math.min(Math.PI, Math.max(-Math.PI, now[i] + v)) - now[i] : v));
      } else free.forEach((i) => (x[i] = 0));
      table.push(x);
    }
  }
  // done: a solved crease that ends within a few degrees of flat (or folded flat) lands exactly so, as paper
  // pressed flat does — the misfit it leaves is the layers' own spacing
  const final = table[table.length - 1];
  free.forEach((i) => {
    const abs = now[i] + final[i], flat = Math.round(abs / Math.PI) * Math.PI;
    if (Math.abs(abs - flat) < 3 * rad1) final[i] = flat - now[i];
  });
  joins.forEach((J, q) => { if (J.def >= 0 && Math.abs(final[varOf[q].v]) > 1e-9) chords.push({ fold: first + J.def, a: J.a, b: J.b, angle: varOf[q].k * final[varOf[q].v] }); });
  const at = (s2: number) => collapseAngles(table, s2);
  const Mend = fk(final), Mnear = fk(at(1 - APPROACH));

  // layers that land on each other: in the order they come in, each a gap above what it covers
  const end = work.map((w, f) => compose(Mend[nodeOf[f]], w.T)), near = work.map((w, f) => compose(Mnear[nodeOf[f]], w.T));
  const lift = order.map(() => ({ x: 0, y: 0, z: 0 }));
  const fams: number[][] = [];
  for (let f = 0; f < n; f++) {
    const fam = fams.find((F) => Math.abs(dot3(end[F[0]].z, end[f].z)) > Math.cos(rad1)); // within a degree: lying on each other
    if (fam) fam.push(f); else fams.push([f]);
  }
  const margin = Math.max(gap, 1e-4 * scale);
  /** Facets joined by a crease folded flat when the step is done: which side of a's top b lies (±1), else 0. */
  const foldedFlat = (fa: number, fb: number): number => {
    const q = joins.findIndex((J) => (J.i === fa && J.j === fb) || (J.i === fb && J.j === fa));
    if (q < 0) return 0;
    const J = joins[q], v = varOf[q], fold = folded(J) + (v.v >= 0 ? v.k * final[v.v] : 0), flat = Math.round(fold / Math.PI);
    if (flat === 0 || Math.abs(fold - flat * Math.PI) > 3 * rad1) return 0;
    return Math.sign(flat); // valley: the far side lands on the near one's top (either way round)
  };
  /** Facets lying on each other when the step began: which side of b's top a was (±1), else 0. */
  const stackedBefore = (A: Work, B: Work): number => {
    const nb = B.T.z;
    if (Math.abs(dot3(A.T.z, nb)) < Math.cos(rad1)) return 0;
    const d = dot3(sub3(A.T.origin, B.T.origin), nb);
    if (Math.abs(d) > gap * (n + 2) || Math.abs(d) < 0.25 * gap) return 0;
    const U = unit3(Math.abs(nb.x) < 0.9 ? cross3(nb, { x: 1, y: 0, z: 0 }) : cross3(nb, { x: 0, y: 1, z: 0 })), V = cross3(nb, U);
    const flat = (W: Work) => { const p2 = inset(W.poly, margin); return p2.map((q) => { const w3 = applyPoint(W.T, at3(q)); return { x: dot3(w3, U), y: dot3(w3, V) }; }); };
    const pa = flat(A), pb = flat(B);
    if (pa.length < 3 || pb.length < 3) return 0;
    const o = clipConvexPoly(pa, pb);
    return o.length >= 3 && Math.abs(polyArea(o)) > margin * margin ? Math.sign(d) : 0;
  };
  for (const fam of fams) {
    if (fam.length < 2) continue;
    const N = end[fam[0]].z, U = unit3(Math.abs(N.x) < 0.9 ? cross3(N, { x: 1, y: 0, z: 0 }) : cross3(N, { x: 0, y: 1, z: 0 })), V = cross3(N, U);
    const to2 = (T: Rigid, poly: Pt[]) => poly.map((q) => { const w3 = applyPoint(T, at3(q)); return { x: dot3(w3, U), y: dot3(w3, V) }; });
    const shape = fam.map((f) => { const p2 = inset(work[f].poly, margin); return p2.length ? to2(end[f], p2) : []; });
    const h = fam.map((f) => dot3(applyPoint(end[f], at3(centroid(work[f].poly))), N));
    /** Height of facet k's plane just before landing, over the 2D point q. */
    const nearAt = (k: number, q: Pt) => {
      const T = near[fam[k]], nz = dot3(T.z, N);
      const P0 = { x: U.x * q.x + V.x * q.y, y: U.y * q.x + V.y * q.y, z: U.z * q.x + V.z * q.y };
      return Math.abs(nz) < 1e-6 ? dot3(T.origin, N) : dot3(P0, N) + dot3(sub3(T.origin, P0), T.z) / nz;
    };
    const over = fam.map(() => [] as number[]); // over[k]: the facets k must lie above
    const pairs: { a: number; b: number; up: boolean; rank: number }[] = [];
    for (let a = 0; a < fam.length; a++) for (let b = a + 1; b < fam.length; b++) {
      if (!shape[a].length || !shape[b].length || Math.abs(h[a] - h[b]) > gap * Math.min(fam.length + 2, STACK)) continue; // apart: no stack
      const o = clipConvexPoly(shape[a], shape[b]);
      if (o.length < 3 || Math.abs(polyArea(o)) < margin * margin) continue;
      // layers that lay on each other already stay on the same sides of each other (paper doesn't pass through
      // paper); a layer coming in lands on the side it comes from, beyond the paper already there; layers that
      // come in together keep their order
      const before = stackedBefore(work[fam[a]], work[fam[b]]);
      const q = centroid(o), da = nearAt(a, q) - h[a], db = nearAt(b, q) - h[b];
      const wrap = foldedFlat(fam[a], fam[b]);
      if (wrap) pairs.push({ a, b, up: wrap * dot3(end[fam[a]].z, N) < 0, rank: -1 });
      else if (before) pairs.push({ a, b, up: before * dot3(end[fam[b]].z, N) > 0, rank: 0 });
      else if (Math.abs(da - db) > 0.5 * gap) pairs.push({ a, b, up: da > db, rank: 1 + 1 / Math.abs(da - db) });
      else pairs.push({ a, b, up: h[a] > h[b], rank: 3 });
    }
    // the surest first; one that would contradict them (a loop) goes the way they already imply
    const above = (x: number, y: number) => { const seen = new Set<number>(); for (const st = [x]; st.length;) { const k = st.pop()!; if (k === y) return true; if (seen.has(k)) continue; seen.add(k); st.push(...over[k]); } return false; };
    for (const pr of pairs.sort((u, v) => u.rank - v.rank)) {
      const [hi, lo] = pr.up ? [pr.a, pr.b] : [pr.b, pr.a];
      if (above(lo, hi)) over[lo].push(hi); else over[hi].push(lo);
    }
    const under = fam.map((_, k) => fam.map((__, c) => c).filter((c) => over[c].includes(k)));
    /** Place a stack bottom up (`up`) or top down: each at least a gap clear of everything already placed it lies on. */
    const place = (stack: number[], up: boolean) => {
      const below = up ? over : under, sg = up ? 1 : -1, placed = new Set<number>(), H = [...h];
      for (let left = stack.length; left > 0; left--) {
        let k = -1;
        for (const c of stack) if (!placed.has(c) && below[c].every((b) => placed.has(b)) && (k < 0 || sg * h[c] < sg * h[k])) k = c;
        if (k < 0) for (const c of stack) if (!placed.has(c) && (k < 0 || sg * h[c] < sg * h[k])) k = c; // a cycle
        for (const b of below[k]) if (placed.has(b)) H[k] = up ? Math.max(H[k], H[b] + gap) : Math.min(H[k], H[b] - gap);
        placed.add(k);
      }
      return H;
    };
    // each stack whichever way moves the paper that hasn't moved this step least (then the rest)
    const still = fam.map((f) => !nodePath(nodes, nodeOf[f]));
    const cost = (H: number[], stack: number[]) => stack.reduce((a, k) => a + Math.abs(H[k] - h[k]) * (still[k] ? 1000 : 1), 0);
    const H = [...h], seen = new Set<number>();
    for (let k0 = 0; k0 < fam.length; k0++) {
      if (seen.has(k0)) continue;
      const stack: number[] = [];
      for (const q = [k0]; q.length;) { const k = q.pop()!; if (seen.has(k)) continue; seen.add(k); stack.push(k); q.push(...over[k], ...under[k]); }
      if (stack.length < 2) continue;
      const Hu = place(stack, true), Hd = place(stack, false), best = cost(Hd, stack) < cost(Hu, stack) ? Hd : Hu;
      for (const k of stack) H[k] = best[k];
    }
    fam.forEach((f, k) => { if (Math.abs(H[k] - h[k]) > 1e-12) lift[nodeOf[f]] = mul3(N, H[k] - h[k]); });
  }
  // a node moves if a crease on its way to the held facet turns, or it's lifted
  const moving = nodes.map(() => false);
  nodes.forEach((nd, k) => { moving[k] = (nd.parent >= 0 && (moving[nd.parent] || nd.v >= 0)) || Math.hypot(lift[k].x, lift[k].y, lift[k].z) > 1e-12; });
  collapses.push({ step, driver: first + driverAt, nodes, table, lift: lift.map((l, k) => applyVec(invert(Mend[k]), l)) });
  work.forEach((w, f) => {
    const k = nodeOf[f];
    if (!moving[k]) return;
    w.T = compose(translation(lift[k]), end[f]);
    w.moves.push(first + driverAt); w.nodes.push(k);
  });
  return work;
}

/** A node turns in its collapse: a crease that turns lies on its way to the held facet. */
function nodePath(nodes: SeqCollapse["nodes"], k: number): boolean {
  for (let q = k; q >= 0 && nodes[q].parent >= 0; q = nodes[q].parent) if (nodes[q].v >= 0) return true;
  return false;
}

/** A collapse's variables at progress `s` (0 … 1), between its samples. */
function collapseAngles(table: number[][], s: number): number[] {
  const k = Math.min(table.length - 2, Math.max(0, Math.floor(s * (table.length - 1)))), t = Math.min(1, Math.max(0, s * (table.length - 1) - k));
  return table[k].map((v, i) => v + (table[k + 1][i] - v) * t);
}

/** Each node's motion at these crease angles: its parent's, then a turn about the crease between them. */
function collapseMotion(nodes: SeqCollapse["nodes"], x: number[]): Rigid[] {
  const M: Rigid[] = [];
  for (const nd of nodes) M.push(nd.parent < 0 ? IDENTITY : nd.v < 0 || Math.abs(x[nd.v]) < 1e-15 ? M[nd.parent] : compose(M[nd.parent], rotationAbout(nd.u, (nd.k ?? 1) * x[nd.v], nd.p)));
  return M;
}

/** A collapse's node motions at progress `s` (0 … 1): the solved angles, then each node's lift. */
export function collapsePose(c: SeqCollapse, s: number): Rigid[] {
  const M = collapseMotion(c.nodes, collapseAngles(c.table, s));
  return M.map((m, k) => { const l = c.lift[k]; return l.x || l.y || l.z ? compose(translation(mul3(applyVec(m, l), s)), m) : m; });
}

/** Solve a small dense system (Gaussian elimination, partial pivoting); undefined if singular. */
function solveSmall(A: number[][], b: number[]): number[] | undefined {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-18) return undefined;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const k = M[r][c] / M[c][c]; for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let v = M[r][n]; for (let j = r + 1; j < n; j++) v -= M[r][j] * x[j]; x[r] = v / M[r][r]; }
  return x;
}

/** Sutherland–Hodgman: the part of convex `subject` inside convex `clip` (either orientation). */
function clipConvexPoly(subject: Pt[], clip: Pt[]): Pt[] {
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

// ---- posing ---------------------------------------------------------------------

const smooth = (k: number) => k * k * (3 - 2 * k);

/** Each fold's angle (radians) with `progress` steps done (0 flat; 2.5 = step 2 done, step 3 half way; eased
 *  so each step starts and settles gently). No progress: every step done. */
export function sequenceAngles(seq: Pick<SheetSequence, "folds">, progress?: number): number[] {
  return seq.folds.map((f) => (progress == null ? f.angle : f.angle * smooth(Math.min(1, Math.max(0, progress - (f.step - 1))))));
}

/** Each facet's placement (flat → sheet-local) at these fold angles. */
export function poseSequence(seq: Pick<SheetSequence, "facets" | "folds" | "collapses">, angles: number[]): Rigid[] {
  const R = seq.folds.map((f, j) => (f.collapse == null && Math.abs(angles[j]) > 1e-12 ? rotationAbout(f.u, angles[j], f.p) : null));
  // a collapse runs as far as its driving fold has (0 … 1)
  const C = (seq.collapses ?? []).map((c) => { const s = angles[c.driver] / seq.folds[c.driver].angle; return s > 1e-12 ? collapsePose(c, Math.min(1, s)) : null; });
  return seq.facets.map((fc) => {
    let T = IDENTITY;
    fc.moves.forEach((j, k) => {
      const ci = seq.folds[j].collapse, M = ci == null ? R[j] : C[ci]?.[fc.nodes![k]];
      if (M) T = compose(M, T);
    });
    return T;
  });
}

/** A crease shows once its fold has started. */
export const creaseMade = (c: SeqCrease, angles: number[]) => c.folds.some((j) => Math.abs(angles[j]) > 1e-9);

/** A triangle mesh of the sheet posed at `angles` (world = frame ∘ facet placement): the
 *  facets fanned (front faces on the paper's top), their flat coordinates as uvs, and as
 *  edges the outline plus every crease made so far. */
export function sequenceMesh(seq: SheetSequence, angles: number[], frame: Rigid): { positions: Float32Array; normals: Float32Array; indices: Uint32Array; uvs: Float32Array; edges: Float32Array } {
  const T = poseSequence(seq, angles).map((t) => compose(frame, t));
  const nv = seq.facets.reduce((s, f) => s + f.poly.length, 0), nt = seq.facets.reduce((s, f) => s + f.poly.length - 2, 0);
  const positions = new Float32Array(3 * nv), normals = new Float32Array(3 * nv), uvs = new Float32Array(2 * nv), indices = new Uint32Array(3 * nt);
  let v = 0, t = 0;
  seq.facets.forEach((f, k) => {
    const n = T[k].z, base = v;
    for (const p of f.poly) {
      const w = applyPoint(T[k], at3(p));
      positions.set([w.x, w.y, w.z], 3 * v); normals.set([n.x, n.y, n.z], 3 * v); uvs.set([p.x, p.y], 2 * v); v++;
    }
    for (let i = 1; i + 1 < f.poly.length; i++) indices.set([base, base + i, base + i + 1], 3 * t++);
  });
  const segs: [Rigid, Pt, Pt][] = [...seq.outline.map((o) => [T[o.facet], o.a, o.b] as [Rigid, Pt, Pt]), ...seq.creases.filter((c) => creaseMade(c, angles)).map((c) => [T[c.facets[0]], c.a, c.b] as [Rigid, Pt, Pt])];
  const edges = new Float32Array(6 * segs.length);
  segs.forEach(([M, a, b], i) => { const p = applyPoint(M, at3(a)), q = applyPoint(M, at3(b)); edges.set([p.x, p.y, p.z, q.x, q.y, q.z], 6 * i); });
  return { positions, normals, indices, uvs, edges };
}

/** Flat coordinates (mm) for each vertex of a mesh of the posed sheet (world coords): the facet it lies on, unfolded. */
export function sequenceUVs(seq: SheetSequence, angles: number[], frame: Rigid, positions: ArrayLike<number>, tol = 1e-3): Float32Array {
  const T = poseSequence(seq, angles).map((t) => invert(compose(frame, t)));
  const uvs = new Float32Array((positions.length / 3) * 2);
  let last = 0;
  for (let i = 0; i < positions.length / 3; i++) {
    const p = { x: positions[3 * i], y: positions[3 * i + 1], z: positions[3 * i + 2] };
    // vertices come in runs on one face: try the facet that took the last one first
    for (let k0 = 0; k0 < T.length; k0++) {
      const k = (last + k0) % T.length, q = applyPoint(T[k], p);
      if (Math.abs(q.z) > tol || !inConvex({ x: q.x, y: q.y }, seq.facets[k].poly, tol)) continue;
      uvs[2 * i] = q.x; uvs[2 * i + 1] = q.y; last = k;
      break;
    }
  }
  return uvs;
}

// ---- checking -----------------------------------------------------------------------

/** A convex polygon with every edge moved in by `d` (empty if it vanishes). */
function inset(poly: Pt[], d: number): Pt[] {
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
  // vanished (or turned inside out): an edge reversed against the original
  if (out.length !== n || polyArea(out) <= 0) return [];
  for (let i = 0; i < n; i++) if (dot2(sub2(out[(i + 1) % n], out[i]), lines[i].e) <= 0) return [];
  return out;
}

/** Where two posed facets pass through (or lie in) each other, ignoring a band `margin` wide along
 *  every facet edge (creases touch there by design): pairs of facet indices. */
export function sequenceClashes(seq: SheetSequence, angles: number[], margin: number): [number, number][] {
  const T = poseSequence(seq, angles);
  const polys = seq.facets.map((f, k) => inset(f.poly, margin).map((p) => applyPoint(T[k], at3(p))));
  const out: [number, number][] = [];
  for (let i = 0; i < polys.length; i++) for (let j = i + 1; j < polys.length; j++) {
    if (polys[i].length < 3 || polys[j].length < 3) continue;
    if (facetsMeet(polys[i], T[i].z, polys[j], T[j].z, 1e-6)) out.push([i, j]);
  }
  return out;
}

/** Two planar convex polygons (3D) intersect: through each other, or overlapping in one plane. */
function facetsMeet(A: V3[], na: V3, B: V3[], nb: V3, eps: number): boolean {
  const lo = (P: V3[]) => P.reduce((m, p) => ({ x: Math.min(m.x, p.x), y: Math.min(m.y, p.y), z: Math.min(m.z, p.z) }), P[0]);
  const hi = (P: V3[]) => P.reduce((m, p) => ({ x: Math.max(m.x, p.x), y: Math.max(m.y, p.y), z: Math.max(m.z, p.z) }), P[0]);
  const a0 = lo(A), a1 = hi(A), b0 = lo(B), b1 = hi(B);
  if (a1.x < b0.x - eps || b1.x < a0.x - eps || a1.y < b0.y - eps || b1.y < a0.y - eps || a1.z < b0.z - eps || b1.z < a0.z - eps) return false;
  const dA = B.map((p) => dot3(sub3(p, A[0]), na)), dB = A.map((p) => dot3(sub3(p, B[0]), nb));
  const nx = cross3(na, nb);
  const flush = dA.every((d) => Math.abs(d) <= eps) && dB.every((d) => Math.abs(d) <= eps);
  if (flush || Math.hypot(nx.x, nx.y, nx.z) < 1e-9) {
    if (!flush) return false; // parallel planes apart
    // one plane: overlap in 2D
    const u = unit3(sub3(A[1], A[0])), v = cross3(na, u);
    const to2 = (P: V3[]) => P.map((p) => ({ x: dot3(sub3(p, A[0]), u), y: dot3(sub3(p, A[0]), v) }));
    const o = clipConvexPoly(to2(A), to2(B));
    return o.length >= 3 && Math.abs(polyArea(o)) > eps;
  }
  if (dA.every((d) => d > eps) || dA.every((d) => d < -eps) || dB.every((d) => d > eps) || dB.every((d) => d < -eps)) return false;
  // both cross the line where the planes meet: do their stretches along it overlap?
  const dir = unit3(nx);
  const span = (P: V3[], d: number[]) => {
    const ts: number[] = [];
    for (let i = 0; i < P.length; i++) {
      const j = (i + 1) % P.length;
      if (Math.abs(d[i]) <= eps) ts.push(dot3(P[i], dir));
      if ((d[i] > eps && d[j] < -eps) || (d[i] < -eps && d[j] > eps)) ts.push(dot3(add3(P[i], mul3(sub3(P[j], P[i]), d[i] / (d[i] - d[j]))), dir));
    }
    return ts.length ? [Math.min(...ts), Math.max(...ts)] : null;
  };
  const sa = span(A, dB), sb = span(B, dA);
  if (!sa || !sb) return false;
  return Math.min(sa[1], sb[1]) - Math.max(sa[0], sb[0]) > eps;
}

// ---- faces for the kernel ------------------------------------------------------------

/** The sheet as flat faces at these angles: facets joined across creases not made yet (paper
 *  not folded there is one piece, with no line across it), each face's boundary loops (flat
 *  coords: the outer CCW, holes CW) and the facets it covers (all placed alike). */
export function sequenceFaces(seq: SheetSequence, angles: number[]): { loops: Pt[][]; facets: number[] }[] {
  const parent = seq.facets.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const c of seq.creases) if (!creaseMade(c, angles)) parent[find(c.facets[0])] = find(c.facets[1]);
  const groups = new Map<number, number[]>();
  seq.facets.forEach((_, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), i]); });
  const scale = Math.max(1, ...seq.facets.flatMap((f) => f.poly.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y)))));
  const tol = 1e-6 * scale;
  const out: { loops: Pt[][]; facets: number[] }[] = [];
  for (const members of groups.values()) {
    if (members.length === 1) { out.push({ loops: [seq.facets[members[0]].poly], facets: members }); continue; }
    const loops = unionLoops(members.map((i) => seq.facets[i].poly), tol);
    if (loops) out.push({ loops, facets: members });
    else for (const i of members) out.push({ loops: [seq.facets[i].poly], facets: [i] }); // couldn't trace: leave them apart
  }
  return out;
}

/** The boundary of edge-to-edge polygons (T-junctions allowed): their edges, split where another's
 *  corner sits on them, less every edge run both ways; chained into loops, straight runs merged. */
function unionLoops(polys: Pt[][], tol: number): Pt[][] | undefined {
  const verts: Pt[] = [];
  const id = (p: Pt) => { let k = verts.findIndex((v) => Math.abs(v.x - p.x) <= tol && Math.abs(v.y - p.y) <= tol); if (k < 0) { k = verts.length; verts.push(p); } return k; };
  const ids = polys.map((poly) => poly.map(id));
  const edges: [number, number][] = [];
  for (const ring of ids) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    if (a === b) continue;
    const A = verts[a], B = verts[b], e = sub2(B, A), L = len2(e), u = mul2(e, 1 / L), nn = { x: -u.y, y: u.x };
    const on = verts.map((v, k) => ({ k, s: dot2(sub2(v, A), u), d: Math.abs(dot2(sub2(v, A), nn)) }))
      .filter((x) => x.k !== a && x.k !== b && x.d <= tol && x.s > tol && x.s < L - tol).sort((x, y) => x.s - y.s);
    const chain = [a, ...on.map((x) => x.k), b];
    for (let j = 0; j + 1 < chain.length; j++) edges.push([chain[j], chain[j + 1]]);
  }
  const key = (a: number, b: number) => `${a}>${b}`;
  const count = new Map<string, number>();
  for (const [a, b] of edges) count.set(key(a, b), (count.get(key(a, b)) ?? 0) + 1);
  const rest = edges.filter(([a, b]) => !count.has(key(b, a)));
  const from = new Map<number, number[]>();
  for (const [a, b] of rest) from.set(a, [...(from.get(a) ?? []), b]);
  if ([...from.values()].some((v) => v.length !== 1)) return undefined; // touching at a corner: not a simple boundary
  const used = new Set<number>(), loops: Pt[][] = [];
  for (const [a0] of rest) {
    if (used.has(a0)) continue;
    const ring: number[] = [];
    for (let a = a0; !used.has(a);) { used.add(a); ring.push(a); const nx = from.get(a)?.[0]; if (nx == null) return undefined; a = nx; }
    // drop corners on a straight run
    const pts = ring.map((k) => verts[k]).filter((p, i, all) => {
      const q = all[(i + all.length - 1) % all.length], r = all[(i + 1) % all.length];
      const e1 = sub2(p, q), e2 = sub2(r, p);
      return Math.abs(e1.x * e2.y - e1.y * e2.x) > tol * (len2(e1) + len2(e2));
    });
    if (pts.length >= 3) loops.push(pts);
  }
  return loops.length ? loops.sort((x, y) => polyArea(y) - polyArea(x)) : undefined;
}
