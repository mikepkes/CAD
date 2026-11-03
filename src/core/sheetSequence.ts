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
import { meshFacets, meshHinges, dihedral, bendPath, hingeStiffness, fitPanel, type BendHinge } from "./sheetBend";
import { polyArea, clipConvexPoly, inset, layerOrderOf, layerRanks, layerFamilies, validateLayers, panelPieces, type LayerOrder, type LayerCrease } from "./sheetLayers";
export { polyArea } from "./sheetLayers";

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
  /** In a collapse: the paper may bend (on any fold of the step, for the whole step). It's meshed into small panels
   *  that move by least energy (core/sheetBend.ts) instead of rigidly: faces bend a little, old creases ease open
   *  (more easily), the step's solved and `with` creases more easily still, while the driven ones fold to their
   *  angle. For folds paper only makes by giving: an inside reverse fold, a flap folded through layers tied in. */
  bend?: boolean;
  /** A reverse fold (an operation of its own step, with every other fold of the step a reverse fold too — two make a
   *  crimp): the line is the crease across a point of the model, carried through every layer of the point's stack;
   *  each layer's part beyond it folds back on itself (the point reflected across the line), with the point's layers
   *  landing between the stack's layers — inside, the spine beyond the crease reversed — or wrapped round the outside.
   *  Where the point lands is declared by the operation, not found; paper only makes the move by giving, so between
   *  its keyframes the point swings as one (or bends, with `bend`). */
  reverse?: "inside" | "outside";
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
  /** A bending step (no tree, no table): each node is a triangle of the mesh, placed by fitting its three vertices,
   *  at each sample of the path, relative to where it fitted at the start. */
  bend?: { verts: Pt[]; tris: [number, number, number][]; path: number[][];
    /** A transition between keyframes: each triangle's exact motion when the step is done (the path's last sample
     *  averages shared vertices across a crease, a layer's spacing off). */
    end?: Rigid[] };
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
  /** A seam between panels of paper that bent (a bending step's mesh), not a fold: no line is drawn there. */
  bend?: true;
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
  /** The layer order after each step (core/sheetLayers.ts): layers[k − 1] once step k is done. */
  layers?: LayerOrder[];
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
  const chords: Chord[] = [];
  const collapses: SeqCollapse[] = [];

  const held = () => { const k = work.findIndex((w) => inConvex(fixed, w.poly, tol)); return k < 0 ? 0 : k; };
  const facetAt = (p: Pt) => work.findIndex((w) => inConvex(p, w.poly, -tol)) >= 0 ? work.findIndex((w) => inConvex(p, w.poly, -tol)) : work.findIndex((w) => inConvex(p, w.poly, tol));

  for (let s = 0; s < order.length;) {
    const step = order[s].step;
    const group: SeqFoldDef[] = [];
    while (s < order.length && order[s].step === step) group.push(order[s++]);
    if (group.some((d) => d.reverse)) {
      if (!group.every((d) => d.reverse && !d.turn)) throw new Error(`step ${step}: a reverse fold is a step of its own (every fold of it a reverse fold — two make a crimp — none a turn)`);
      work = reverseStep(work, group, step, fixed, folds, chords, collapses, gap, scale, tol);
      continue;
    }
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
    creases.push({ folds: [...new Set(on.map((c) => c.fold))].sort((x, y) => x - y), a, b, facets: [i, j], angle: last.angle, ...(on.every((c) => c.bend) ? { bend: true as const } : {}) });
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
  const seq: SheetSequence = { facets, folds, creases, outline, steps: Math.max(0, ...folds.map((f) => f.step)), gap, ...(collapses.length ? { collapses } : {}) };
  seq.layers = checkLayers(seq, scale);
  return seq;
}

/** The layer order after every step, each checked (core/sheetLayers.ts): the conditions a stack of paper must meet.
 *  The first violations are the plan's error. */
function checkLayers(seq: SheetSequence, scale: number): LayerOrder[] {
  const polys = seq.facets.map((f) => f.poly);
  const out: LayerOrder[] = [];
  for (let k = 1; k <= seq.steps; k++) {
    const angles = sequenceAngles(seq, k), T = poseSequence(seq, angles);
    const order = layerOrderOf(polys, T, seq.gap, scale, k);
    // paper that bent isn't a stack of planes: from a bending step on, there's no order to check
    if ((seq.collapses ?? []).some((c) => c.bend && c.step <= k)) { out.push(order); continue; }
    const creases: LayerCrease[] = seq.creases.map((c) => ({ facets: c.facets, a: c.a, b: c.b, fold: `"${seq.folds[c.folds[c.folds.length - 1]].id}"`, made: creaseMade(c, angles, seq) }));
    const names = seq.folds.filter((f) => f.step === k).map((f) => `"${f.id}"`);
    const errs = validateLayers(polys, T, order, creases, seq.gap, scale, `step ${k} (fold ${names.slice(0, 2).join(", ")}${names.length > 2 ? ", …" : ""})`);
    if (errs.length) throw new Error(errs.slice(0, 3).join("; ") + (errs.length > 3 ? ` (and ${errs.length - 3} more)` : ""));
    out.push(order);
  }
  return out;
}


// ---- collapses --------------------------------------------------------------------

type Chord = { fold: number; a: Pt; b: Pt; angle: number; bend?: boolean };

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
  if (group.some((d) => d.bend)) return bendStep(work, group, joins, step, fixed, folds, chords, collapses, gap, scale, tol, first + driverAt);

  // the tree, from the held facet: 0-1 breadth first, rigid joins before creases — paper joined rigidly (no crease of
  // the step between) moves as one piece, so a facet reached across a solved crease that a rigid join also reaches,
  // as far from the root, joins its piece by the rigid join instead (else a piece reached across several solved
  // creases at once would hang from each, its rigid joins left as loops to tear); a driven crease, or one turning
  // with it, carries the step's motion exactly and stays the way in
  const n = work.length, links = work.map(() => [] as number[]);
  joins.forEach((J, k) => { links[J.i].push(k); links[J.j].push(k); });
  const root = Math.max(0, work.findIndex((w) => inConvex(fixed, w.poly, tol)));
  const dist = new Array(n).fill(Infinity), via = new Array(n).fill(-1), done = new Array(n).fill(false), order: number[] = [];
  const loose = new Array(n).fill(false); // reached across a solved crease (its piece's way in), not a driven one
  const follows = (q: number) => !!group[q].solve; // a crease solved to follow the driven ones
  dist[root] = 0;
  for (const dq: number[] = [root]; dq.length;) {
    const f = dq.shift()!;
    if (done[f]) continue;
    done[f] = true; order.push(f);
    for (const k of links[f]) {
      const J = joins[k], g = J.i === f ? J.j : J.i, d = dist[f] + (J.def >= 0 ? 1 : 0);
      const closer = d < dist[g] || (d === dist[g] && J.def < 0 && !done[g] && via[g] >= 0 && joins[via[g]].def >= 0 && follows(joins[via[g]].def) && !loose[f]);
      if (!closer) continue;
      dist[g] = d; via[g] = k; loose[g] = J.def >= 0 ? follows(J.def) : loose[f];
      if (J.def >= 0) dq.push(g); else dq.unshift(g);
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
    if (Math.abs(th) < Math.PI - 3 * rad1) return th; // (nearly flat: which side the far facet lies, not the angle — its sign is a hair from flipping)
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
        /** Least squares from a start (the solved angles, also the anchor the regularisation pulls toward). */
        const solve = (start: number[], maxIt: number) => {
          const F = (y: number[]) => [...residual(put(y)), ...y.map((v, q) => Math.sqrt(mu) * (v - start[q]))];
          let y = [...start], f = F(y), cost = f.reduce((a, v) => a + v * v, 0);
          for (let it = 0; it < maxIt; it++) {
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
          return { y, cost };
        };
        const best = solve(free.map((i) => x[i]), 60);
        // paper folded flat can't fold further: a solved crease stops there (rather than pass the layers through each other)
        x = put(best.y).map((v, i) => (solved[i] ? Math.min(Math.PI, Math.max(-Math.PI, now[i] + v)) - now[i] : v));
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
  /** Facets joined by a crease folded flat when the step is done: which side of a's top b lies (±1), else 0. */
  const foldedFlat = (fa: number, fb: number): number => {
    const q = joins.findIndex((J) => (J.i === fa && J.j === fb) || (J.i === fb && J.j === fa));
    if (q < 0) return 0;
    const J = joins[q], v = varOf[q], fold = folded(J) + (v.v >= 0 ? v.k * final[v.v] : 0), flat = Math.round(fold / Math.PI);
    if (flat === 0 || Math.abs(fold - flat * Math.PI) > 3 * rad1) return 0;
    return Math.sign(flat); // valley: the far side lands on the near one's top (either way round)
  };
  const creaseOf = (fa: number, fb: number): [Pt, Pt] | undefined => { const J = joins.find((K) => (K.i === fa && K.j === fb) || (K.i === fb && K.j === fa)); return J ? [J.a, J.b] : undefined; };
  const spaced = spaceLayers(work, end, near, work.map((_, f) => !nodePath(nodes, nodeOf[f])), foldedFlat, creaseOf, gap, scale);
  const lift = order.map((f) => spaced[f]);
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

// ---- reverse folds ------------------------------------------------------------------

/** A reverse-fold step: one crease (an inside or outside reverse fold) or two (a crimp), made one after the other. */
function reverseStep(work: Work[], group: SeqFoldDef[], step: number, fixed: Pt, folds: SeqFold[], chords: Chord[], collapses: SeqCollapse[], gap: number, scale: number, tol: number): Work[] {
  for (const def of group) work = reverseOne(work, def, step, fixed, folds, chords, collapses, gap, scale, tol);
  return work;
}

/** One reverse fold. The crease is carried through every layer of the point's stack it crosses and cuts them; the
 *  point (each layer's part beyond the line, away from the held paper) ends as its mirror image across the line,
 *  every crease on it reversed, and the layers of the point land where the operation says: inside, between the
 *  stack's two halves (the halves meet at the spine, the innermost crease joining two of the point's layers), each
 *  half's layers nested in reverse; outside, wrapped round the stack. That order is declared, then the heights follow
 *  from it (a gap per rank, core/sheetLayers.ts). The motion between: the point swings about the drawn layer's line
 *  as one stack, drifting to its heights (paper does it by giving, which a rigid plan can't show; `bend` on the fold
 *  bends the point's paper instead — core/sheetBend.ts). */
function reverseOne(work: Work[], def: SeqFoldDef, step: number, fixed: Pt, folds: SeqFold[], chords: Chord[], collapses: SeqCollapse[], gap: number, scale: number, tol: number): Work[] {
  const wtol = 1e-5 * scale, ci = collapses.length, first = folds.length;
  const name = `fold "${def.id}" (step ${step})`;
  const L = len2(sub2(def.b, def.a));
  if (L < tol) throw new Error(`${name}: its line has no length`);
  const mid = mul2(add2(def.a, def.b), 0.5), ref = work.find((w) => inConvex(mid, w.poly, wtol));
  if (!ref) throw new Error(`${name}: its line isn't on the sheet`);
  const P = applyPoint(ref.T, at3(def.a)), e = unit3(sub3(applyPoint(ref.T, at3(def.b)), P)), n = ref.T.z;
  const hw = work[Math.max(0, work.findIndex((w) => inConvex(fixed, w.poly, tol)))], hc = applyPoint(hw.T, at3(inConvex(fixed, hw.poly, tol) ? fixed : centroid(hw.poly)));
  let sigma = dot3(sub3(hc, P), cross3(n, e)) > wtol ? -1 : 1;
  if (def.flip) sigma = -sigma;
  const m = mul3(cross3(n, e), sigma);
  const swing = Math.sign(def.angle) || 1;
  const axis = { p: P, u: mul3(e, (dot3(cross3(e, m), n) > 0 ? 1 : -1) * swing) };
  // the stack: every layer lying with the drawn one that the crease's segment crosses, cut there
  const next: Work[] = [], stack: { still: Work; tip: Work; h: number; chord: [Pt, Pt] }[] = [];
  for (const w of work) {
    const h = dot3(sub3(w.T.origin, P), n);
    if (Math.abs(dot3(w.T.z, n)) < Math.cos(rad1) || Math.abs(h) > gap * STACK) { next.push(w); continue; }
    const dist = (p: Pt) => dot3(sub3(applyPoint(w.T, at3(p)), P), m);
    const c = cutConvex(w.poly, w.poly.map(dist), wtol);
    if (!c.pos.length || !c.neg.length || !c.chord) { next.push(w); continue; }
    const t0 = dot3(sub3(applyPoint(w.T, at3(c.chord[0])), P), e), t1 = dot3(sub3(applyPoint(w.T, at3(c.chord[1])), P), e);
    if (Math.max(t0, t1) <= wtol || Math.min(t0, t1) >= L - wtol) { next.push(w); continue; }
    if (w === hw && inConvex(fixed, c.pos, -tol)) throw new Error(`${name}: the point holds the part the sheet is held by — hold it elsewhere (fixed) or flip the fold`);
    const tip: Work = { poly: c.pos, T: w.T, moves: [...w.moves], nodes: [...w.nodes] }, still: Work = { poly: c.neg, T: w.T, moves: [...w.moves], nodes: [...w.nodes] };
    next.push(still, tip);
    stack.push({ still, tip, h, chord: c.chord });
  }
  if (!stack.length) throw new Error(`${name}: nothing to fold beyond its line`);
  stack.sort((a, b) => a.h - b.h);
  work = next;
  // the spine: the crease joining two of the point's layers where the halves meet — a crease of this step first (a
  // crimp's second fold reverses the first's), else the one nearest the middle of the stack (a point of several
  // layers, a narrowed leg, has other creases joining its layers in pairs nearer its faces: the flaps folded over it,
  // which stay nested within their half)
  let p = stack.length - 1, best = Infinity;
  const middle = (stack.length - 1) / 2, stepFirst = folds.findIndex((f) => f.step === step);
  for (let i = 0; i < stack.length; i++) for (let j = i + 1; j < stack.length; j++) {
    const A = stack[i].tip.poly, B = stack[j].tip.poly;
    let joined = false, fresh = false;
    for (let a = 0; a < A.length; a++) for (let b = 0; b < B.length; b++) {
      const sp = sharedSpan(A[a], A[(a + 1) % A.length], B[b], B[(b + 1) % B.length], wtol);
      if (!sp || len2(sub2(sp[1], sp[0])) <= 10 * wtol) continue;
      for (const c of chords) if (sharedSpan(c.a, c.b, sp[0], sp[1], wtol)) { joined = true; if (stepFirst >= 0 && c.fold >= stepFirst) fresh = true; }
    }
    const score = fresh ? (j - i) + i / stack.length : stack.length * stack.length + Math.abs((i + j) / 2 - middle) * stack.length + (j - i);
    if (joined && score < best) { best = score; p = i; }
  }
  if (def.reverse === "inside" && !Number.isFinite(best)) throw new Error(`${name}: an inside reverse fold needs a point of layers joined at a spine (one layer folds back on itself: use a plain fold)`);
  // each layer's part beyond the line goes toward the inside (its half's inner side) or away from it: its crease
  const tipSet = new Set(stack.map((s) => s.tip));
  stack.forEach((s, i) => {
    const inward = i <= p ? 1 : -1, up = def.reverse === "inside" ? inward : -inward;
    chords.push({ fold: first, a: s.chord[0], b: s.chord[1], angle: Math.PI * up * Math.sign(dot3(s.still.T.z, n)) });
  });
  folds.push({ id: def.id, step, angle: swing * Math.PI, turn: false, collapse: ci, p: P, u: axis.u });
  // the point reflected: every crease on it reverses (the creases between its layers, the spine among them)
  for (const [i, j, a, b] of adjacency(work, tol)) {
    if (!tipSet.has(work[i]) || !tipSet.has(work[j]) || work[i].T === work[j].T) continue;
    const was = [...chords].reverse().find((c) => sharedSpan(c.a, c.b, a, b, wtol) && c.fold < first);
    if (was) chords.push({ fold: first, a, b, angle: -was.angle });
  }
  // the end: each tip turned over about the axis (one swing as a stack, every layer alike)
  const R = rotationAbout(axis.u, Math.PI, axis.p);
  const end = work.map((w) => (tipSet.has(w) ? compose(R, w.T) : w.T));
  const idx = new Map<Work, number>();
  work.forEach((w, k) => idx.set(w, k));
  // the order declared, bottom to top along the stack's normal: the still layers as they lie, the point's layers
  // between the halves (inside) or round the outside, each half's in reverse
  // (along the drawn layer's normal, the way the stack was sorted: its lowest layer may face the other way)
  const nn = n, H = (k: number) => dot3(end[k].origin, nn);
  const lower = stack.slice(0, p + 1), upper = stack.slice(p + 1);
  const order: Work[] = def.reverse === "inside"
    ? [...lower.map((s) => s.still), ...[...lower].reverse().map((s) => s.tip), ...[...upper].reverse().map((s) => s.tip), ...upper.map((s) => s.still)]
    : [...[...lower].reverse().map((s) => s.tip), ...lower.map((s) => s.still), ...upper.map((s) => s.still), ...[...upper].reverse().map((s) => s.tip)];
  const slot = new Map<number, number>();
  order.forEach((w, i) => slot.set(idx.get(w)!, i));
  // pairs (low, high along nn): the paper not in the point as it lies now; the point's layers against the stack by
  // their slots, and against anything else lying in the stack's gaps by the still layer it lies nearest
  const polys = work.map((w) => w.poly);
  const base = layerOrderOf(polys, end, gap, scale, step);
  const famOf = new Map<number, number>();
  base.families.forEach((F, q) => F.facets.forEach((f) => famOf.set(f, q)));
  const famK = famOf.get(idx.get(stack[0].still)!)!, famN = base.families[famK].n, flipN = dot3(famN, nn) < 0;
  const fam = base.families[famK].facets;
  const pairs: [number, number][] = base.above.filter(([a, b]) => !tipSet.has(work[a]) && !tipSet.has(work[b])).map(([a, b]) => (flipN ? [b, a] : [a, b]));
  const margin = Math.max(gap, 1e-4 * scale);
  const U = unit3(Math.abs(nn.x) < 0.9 ? cross3(nn, { x: 1, y: 0, z: 0 }) : cross3(nn, { x: 0, y: 1, z: 0 })), V = cross3(nn, U);
  const shape = new Map<number, Pt[]>();
  for (const k of fam) shape.set(k, inset(polys[k], margin).map((q) => { const w = applyPoint(end[k], at3(q)); return { x: dot3(w, U), y: dot3(w, V) }; }));
  const overlap = (a: number, b: number) => { const o = clipConvexPoly(shape.get(a)!, shape.get(b)!); return o.length >= 3 && Math.abs(polyArea(o)) > margin * margin; };
  const stills = stack.map((s) => idx.get(s.still)!);
  const slotOf = (k: number): number => {
    if (slot.has(k)) return slot.get(k)!;
    const h = H(k);
    let lo = -1, hi = -1;
    for (const s of stills) { if (H(s) <= h) lo = s; else if (hi < 0) hi = s; }
    if (lo < 0) return slot.get(hi)! - 0.5;
    if (hi < 0) return slot.get(lo)! + 0.5;
    return h - H(lo) <= H(hi) - h ? slot.get(lo)! + 0.5 : slot.get(hi)! - 0.5;
  };
  for (const s of stack) {
    const k = idx.get(s.tip)!;
    for (const o of fam) {
      if (o === k || !overlap(k, o)) continue;
      const a = slotOf(k), b = slotOf(o);
      if (a < b) pairs.push([k, o]); else if (a > b) pairs.push([o, k]);
    }
  }
  const ranks = layerRanks({ step, families: base.families, above: pairs }, work.length);
  // heights from the ranks: each connected stack from its lowest layer, a gap a rank
  const comp = work.map((_, k) => k), find = (k: number): number => (comp[k] === k ? k : (comp[k] = find(comp[k])));
  for (const [a, b] of pairs) comp[find(a)] = find(b);
  const baseH = new Map<number, number>();
  for (const [a, b] of pairs) for (const k of [a, b]) { const r = find(k); baseH.set(r, Math.min(baseH.get(r) ?? Infinity, H(k) - ranks[k] * gap)); }
  const lift: V3[] = work.map((_w, k) => {
    if (!baseH.has(find(k))) return { x: 0, y: 0, z: 0 };
    const dh = baseH.get(find(k))! + ranks[k] * gap - H(k);
    return Math.abs(dh) > 1e-12 ? mul3(nn, dh) : { x: 0, y: 0, z: 0 };
  });
  // the collapse: the held facet the root, every tip a node turning about the axis, the rest lifted only
  const root = Math.max(0, work.findIndex((w) => inConvex(fixed, w.poly, tol)));
  const nodes: SeqCollapse["nodes"] = [{ parent: -1, p: { x: 0, y: 0, z: 0 }, u: { x: 0, y: 0, z: 1 }, v: -1, k: 1 }];
  const nodeOf = work.map(() => -1);
  nodeOf[root] = 0;
  work.forEach((w, k) => {
    if (k === root) return;
    nodeOf[k] = nodes.length;
    nodes.push(tipSet.has(w) ? { parent: 0, p: axis.p, u: axis.u, v: 0, k: 1 } : { parent: 0, p: { x: 0, y: 0, z: 0 }, u: { x: 0, y: 0, z: 1 }, v: -1, k: 1 });
  });
  const keyframe = work.map((_w, k) => compose(translation(lift[k]), end[k]));
  if (def.bend) {
    const patch = new Set<number>([...stack.map((st) => idx.get(st.tip)!), ...stack.map((st) => idx.get(st.still)!)]);
    return bendTransition(work, keyframe, patch, fixed, chords, collapses, step, first, gap, scale, tol);
  }
  const Mend = collapseMotion(nodes, [Math.PI]);
  collapses.push({ step, driver: first, nodes, table: [[0], [Math.PI]], lift: nodes.map((_, j) => applyVec(invert(Mend[j]), lift[nodeOf.indexOf(j)])) });
  work.forEach((w, k) => {
    if (!tipSet.has(w) && Math.hypot(lift[k].x, lift[k].y, lift[k].z) <= 1e-12) return;
    w.T = keyframe[k];
    w.moves.push(first); w.nodes.push(nodeOf[k]);
  });
  return work;
}

/** The pairs the sure ones imply (ranks −1 and 0 in `pairs`: creases folded flat this step, layers that lay on each
 *  other before), added at rank −½ so they decide before any guess: `up` is a above b along the family normal.
 *  `taco(a, b)` is ±1 where a crease folded flat joins them, `seg(a, b)` that crease in the family plane, `top(k)`
 *  which way facet k's top faces along the normal. */
function impliedPairs(fam: number[], pairs: { a: number; b: number; up: boolean; rank: number }[], cell: Map<number, Pt[]>[], beforeOf: Map<number, number>[], taco: (a: number, b: number) => number, seg: (a: number, b: number) => [Pt, Pt] | undefined, top: (k: number) => number, margin: number): void {
  const n = fam.length;
  const known = new Map<string, boolean>(); // "a,b" → a above b
  const set = (a: number, b: number, up: boolean) => { known.set(`${a},${b}`, up); known.set(`${b},${a}`, !up); };
  for (const p of pairs) if (p.rank <= 0) set(p.a, p.b, p.up);
  const get = (a: number, b: number) => known.get(`${a},${b}`);
  const area = (o: Pt[]) => (o.length >= 3 ? Math.abs(polyArea(o)) : 0);
  const tacos: { a: number; b: number; s: [Pt, Pt] }[] = [];
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    if (!cell[a].has(b) || !taco(a, b)) continue;
    const s2 = seg(a, b);
    if (s2) tacos.push({ a, b, s: s2 });
  }
  const onEachOther = (p: [Pt, Pt], q: [Pt, Pt]) => {
    const e = sub2(p[1], p[0]), L = len2(e) || 1, u = mul2(e, 1 / L), nn = { x: -u.y, y: u.x };
    if (Math.abs(dot2(sub2(q[0], p[0]), nn)) > 4 * margin || Math.abs(dot2(sub2(q[1], p[0]), nn)) > 4 * margin) return false;
    const s0 = dot2(sub2(q[0], p[0]), u), s1 = dot2(sub2(q[1], p[0]), u);
    return Math.min(L, Math.max(s0, s1)) - Math.max(0, Math.min(s0, s1)) > 4 * margin;
  };
  const added: { a: number; b: number; up: boolean }[] = [];
  const add = (a: number, b: number, up: boolean) => { if (get(a, b) != null) return false; set(a, b, up); added.push({ a, b, up }); return true; };
  // a flap landing on a layer (a crease folded flat this step) lands beyond what lay on that side of the layer before
  for (const t of tacos) for (const [A, B] of [[t.a, t.b], [t.b, t.a]]) {
    const upB = get(A, B); // A above B?
    if (upB == null) continue;
    for (const [X, side] of beforeOf[A]) {
      // B lands on A's top when B is above A and A's top faces up (or both the other way)
      const bOnTop = (upB ? -1 : 1) * top(A) > 0;
      if ((side > 0) !== bOnTop || X === B || !cell[X].has(B)) continue;
      add(B, X, !upB); // B beyond X: on the same side of A as X, further out
    }
  }
  for (let guard = 0; guard < 50; guard++) {
    let grew = false;
    for (const t of tacos) {
      const { a: A, b: B } = t, ab = cell[A].get(B)!;
      // taco–tortilla: a layer crossing the crease lies outside the taco
      for (let C = 0; C < n; C++) {
        if (C === A || C === B || !cell[C].has(A) || !cell[C].has(B)) continue;
        const sc = cell[C].get(A)!;
        const mid = mul2(add2(t.s[0], t.s[1]), 0.5);
        if (!inConvex(mid, sc, -margin) || area(clipConvexPoly(ab, sc)) <= margin * margin) continue;
        const ca = get(C, A), cb = get(C, B);
        if (ca != null && cb == null) grew = add(C, B, ca) || grew;
        else if (cb != null && ca == null) grew = add(C, A, cb) || grew;
      }
      // taco–taco: another taco at the same crease nests inside or lies outside, as one of its layers already does
      for (const u of tacos) {
        if (u === t || [u.a, u.b].includes(A) || [u.a, u.b].includes(B) || !onEachOther(t.s, u.s)) continue;
        if (!cell[u.a].has(u.b) || area(clipConvexPoly(ab, cell[u.a].get(u.b)!)) <= margin * margin) continue;
        for (const [C, D] of [[u.a, u.b], [u.b, u.a]]) {
          const ca = get(C, A), cb = get(C, B);
          if (ca == null || cb == null) continue;
          // C between A and B: so is D; C outside: D on the same side
          if (cell[D].has(A) && get(D, A) == null) grew = add(D, A, ca) || grew;
          if (cell[D].has(B) && get(D, B) == null) grew = add(D, B, ca !== cb ? cb : ca) || grew;
        }
      }
    }
    if (!grew) break;
  }
  for (const p of added) {
    const k = pairs.findIndex((q) => (q.a === p.a && q.b === p.b) || (q.a === p.b && q.b === p.a));
    if (k >= 0) { pairs[k].up = pairs[k].a === p.a ? p.up : !p.up; pairs[k].rank = -0.5; } else pairs.push({ a: p.a, b: p.b, up: p.up, rank: -0.5 });
  }
}

/** Space the layers a step lands on each other a gap apart (each facet's shift, world, when the step is done), in
 *  the order they lie or come in: `end` and `near` where each facet is when done and just before (APPROACH), `still`
 *  the facets the step doesn't move (a stack goes whichever way moves those least), `foldedFlat(a, b)` which side of
 *  a's top b lands on when a crease between them is folded flat (±1, else 0). */
function spaceLayers(work: Work[], end: Rigid[], near: Rigid[], stillAll: boolean[], foldedFlat: (fa: number, fb: number) => number, creaseOf: (fa: number, fb: number) => [Pt, Pt] | undefined, gap: number, scale: number): V3[] {
  const n = work.length;
  const lift = work.map(() => ({ x: 0, y: 0, z: 0 }));
  const fams: number[][] = [];
  for (let f = 0; f < n; f++) {
    const fam = fams.find((F) => Math.abs(dot3(end[F[0]].z, end[f].z)) > Math.cos(rad1)); // within a degree: lying on each other
    if (fam) fam.push(f); else fams.push([f]);
  }
  const margin = Math.max(gap, 1e-4 * scale);
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
    const cell = fam.map(() => new Map<number, Pt[]>()); // cell[a].get(b): where a and b lie on each other (2D)
    const beforeOf = fam.map(() => new Map<number, number>()); // beforeOf[a].get(b): which side of b's top a was
    for (let a = 0; a < fam.length; a++) for (let b = a + 1; b < fam.length; b++) {
      if (!shape[a].length || !shape[b].length || Math.abs(h[a] - h[b]) > gap * Math.min(fam.length + 2, STACK)) continue; // apart: no stack
      const o = clipConvexPoly(shape[a], shape[b]);
      if (o.length < 3 || Math.abs(polyArea(o)) < margin * margin) continue;
      cell[a].set(b, o); cell[b].set(a, o);
      // layers that lay on each other already stay on the same sides of each other (paper doesn't pass through
      // paper); a layer coming in lands on the side it comes from, beyond the paper already there; layers that
      // come in together keep their order
      const before = stackedBefore(work[fam[a]], work[fam[b]]);
      if (before) { beforeOf[a].set(b, before); beforeOf[b].set(a, -before); }
      const q = centroid(o), da = nearAt(a, q) - h[a], db = nearAt(b, q) - h[b];
      const wrap = foldedFlat(fam[a], fam[b]);
      if (wrap) pairs.push({ a, b, up: wrap * dot3(end[fam[a]].z, N) < 0, rank: -1 });
      else if (before) pairs.push({ a, b, up: before * dot3(end[fam[b]].z, N) > 0, rank: 0 });
      else if (Math.abs(da - db) > 0.5 * gap) pairs.push({ a, b, up: da > db, rank: 1 + 1 / Math.abs(da - db) });
      else pairs.push({ a, b, up: h[a] > h[b], rank: 3 });
    }
    // what the sure pairs imply (core/sheetLayers.ts: the order is maintained, not searched for) — a flap landing
    // on a layer lands beyond what lay there already; two folds flat at one crease nest, never interleave; a layer
    // crossing a crease folded flat lies outside it — decided before any guess from how the layers come in
    impliedPairs(fam, pairs, cell, beforeOf, (a, b) => foldedFlat(fam[a], fam[b]), (a, b) => { const c = creaseOf(fam[a], fam[b]); return c && (to2(end[fam[a]], c) as [Pt, Pt]); }, (k) => dot3(end[fam[k]].z, N), margin);
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
    const still = fam.map((f) => stillAll[f]);
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
    fam.forEach((f, k) => { if (Math.abs(H[k] - h[k]) > 1e-12) lift[f] = mul3(N, H[k] - h[k]); });
  }
  return lift;
}

/** Samples of a bending step's path; its mesh's panels, at most this fraction of the sheet's size across; and how
 *  stiff, next to flat paper, are an old crease and a crease the step frees (creased paper is weaker along the line),
 *  and the step's driven creases (held to their angle). */
const BEND_SAMPLES = 16, BEND_SIZE = 1 / 6, OLD_CREASE = 0.2, FREE_CREASE = 0.02, DRIVEN = 1000;

/** A collapse whose paper bends: mesh the facets into triangles, give every edge between two a hinge (stiff across a
 *  face, softer along an old crease, softer still along a crease the step frees, driven along the driven ones), solve
 *  the least-energy shape along the way (core/sheetBend.ts), and place each triangle by fitting its corners. The
 *  triangles are the step's facets from here on; the edges between them that bent are seams (creases drawn as none). */
function bendStep(work: Work[], group: SeqFoldDef[], joins: { i: number; j: number; a: Pt; b: Pt; def: number }[], step: number, fixed: Pt, folds: SeqFold[], chords: Chord[], collapses: SeqCollapse[], gap: number, scale: number, tol: number, driver: number): Work[] {
  const wtol = 1e-5 * scale, first = folds.findIndex((f) => f.step === step);
  const mesh = meshFacets(work.map((w) => w.poly), BEND_SIZE * scale, tol);
  const nv = mesh.verts.length;
  // where each vertex is as the step begins: the facets it's on agree up to the layers' spacing at a crease
  const x0 = new Float64Array(3 * nv), count = new Float64Array(nv);
  mesh.tris.forEach((T, t) => { for (const v of T) { const q = applyPoint(work[mesh.owner[t]].T, at3(mesh.verts[v])); x0[3 * v] += q.x; x0[3 * v + 1] += q.y; x0[3 * v + 2] += q.z; count[v]++; } });
  for (let v = 0; v < nv; v++) for (let p = 0; p < 3; p++) x0[3 * v + p] /= count[v];
  // each hinge: which triangles, what's between them
  const left = new Map<string, number>();
  mesh.tris.forEach((T, t) => { for (let i = 0; i < 3; i++) left.set(`${T[i]},${T[(i + 1) % 3]}`, t); });
  const driven = (d: SeqFoldDef) => !d.with && !d.solve && Math.abs(d.angle) > 1e-9;
  const onSpan = (a: Pt, b: Pt, p: Pt, q: Pt) => { const sp = sharedSpan(p, q, a, b, wtol); return !!sp && len2(sub2(sp[1], sp[0])) > len2(sub2(b, a)) - 2 * wtol; };
  const kinds: ("face" | "old" | "crease")[] = [];
  const hinges: BendHinge[] = meshHinges(mesh.tris).map((h) => {
    const A = mesh.verts[h.a], B = mesh.verts[h.b], fa = mesh.owner[left.get(`${h.a},${h.b}`)!], fb = mesh.owner[left.get(`${h.b},${h.a}`)!];
    const k0 = hingeStiffness(mesh.verts, h, BEND_SIZE * scale / 6);
    // how far it's folded as the step begins: from the facets either side (not the averaged vertices, which the
    // layers' spacing at a crease leaves a little askew), a fold pressed flat the way the far facet lies
    const was = [...chords].reverse().find((c) => onSpan(A, B, c.a, c.b));
    const Ta = work[fa].T, Tb = work[fb].T, P = applyPoint(Ta, at3(A)), e = unit3(sub3(applyPoint(Ta, at3(B)), P));
    let rest = -Math.atan2(dot3(cross3(Ta.z, Tb.z), e), dot3(Ta.z, Tb.z));
    if (Math.abs(rest) > Math.PI - 1e-3) rest = Math.PI * (Math.sign(dot3(sub3(applyPoint(Tb, at3(centroid(work[fb].poly))), P), Ta.z)) || 1);
    const J = fa === fb ? undefined : joins.find((K) => ((K.i === fa && K.j === fb) || (K.i === fb && K.j === fa)) && onSpan(A, B, K.a, K.b));
    if (J && J.def >= 0) {
      kinds.push("crease");
      const d = group[J.def];
      return driven(d) ? { ...h, k: k0 * DRIVEN, rest, to: d.angle } : { ...h, k: k0 * FREE_CREASE, rest };
    }
    kinds.push(was ? "old" : "face");
    // uncreased paper rests flat (where layers stacked at a crease start it tilted a little, it straightens)
    return { ...h, k: k0 * (was ? OLD_CREASE : 1), rest: was ? rest : 0 };
  });
  if (!hinges.some((h) => h.to != null)) throw new Error(`step ${step}: a bending collapse needs a crease driven through an angle`);
  // held: the triangle the sheet is held by
  const heldTri = Math.max(0, mesh.tris.findIndex((T) => inConvex(fixed, T.map((v) => mesh.verts[v]), tol)));
  const path = bendPath({ flat: mesh.verts, tris: mesh.tris, x0, hinges, fixed: [...mesh.tris[heldTri]], thickness: gap }, BEND_SAMPLES);
  const fit = (x: Float64Array, T: [number, number, number]) => fitPanel([mesh.verts[T[0]], mesh.verts[T[1]], mesh.verts[T[2]]], T.map((v) => ({ x: x[3 * v], y: x[3 * v + 1], z: x[3 * v + 2] })) as [V3, V3, V3]);
  const start = mesh.tris.map((T) => invert(fit(path[0], T)));
  const motion = (x: Float64Array) => mesh.tris.map((T, t) => compose(fit(x, T), start[t]));
  const Mend = motion(path[path.length - 1]), Mnear = motion(path[Math.round((1 - APPROACH) * BEND_SAMPLES)]);
  const panels: Work[] = mesh.tris.map((T, t) => {
    const w = work[mesh.owner[t]];
    return { poly: T.map((v) => mesh.verts[v]), T: w.T, moves: [...w.moves], nodes: [...w.nodes] };
  });
  const end = panels.map((w, t) => compose(Mend[t], w.T)), near = panels.map((w, t) => compose(Mnear[t], w.T));
  // the hinges' angles when done, and the creases they make: the step's creases, and seams where the paper bent
  const final = path[path.length - 1];
  const th = hinges.map((h) => dihedral(final, h, h.to ?? h.rest).th);
  const flatBetween = new Map<string, number>(), segBetween = new Map<string, [Pt, Pt]>();
  hinges.forEach((h, q) => {
    const A = mesh.verts[h.a], B = mesh.verts[h.b], ta = left.get(`${h.a},${h.b}`)!, tb = left.get(`${h.b},${h.a}`)!;
    const flat = Math.round(th[q] / Math.PI);
    segBetween.set(`${ta},${tb}`, [A, B]); segBetween.set(`${tb},${ta}`, [A, B]);
    if (flat !== 0 && Math.abs(th[q] - flat * Math.PI) <= 3 * rad1) { flatBetween.set(`${ta},${tb}`, Math.sign(flat)); flatBetween.set(`${tb},${ta}`, Math.sign(flat)); }
    if (kinds[q] === "crease") {
      const J = joins.find((K) => K.def >= 0 && onSpan(A, B, K.a, K.b))!;
      chords.push({ fold: first + J.def, a: A, b: B, angle: th[q] });
    } else if (kinds[q] === "face") chords.push({ fold: driver, a: A, b: B, angle: th[q], bend: true }); // a seam: the panels apart from here on
    else if (Math.abs(th[q] - h.rest) > 1e-4) chords.push({ fold: driver, a: A, b: B, angle: th[q] }); // an old crease, moved
  });
  const moved = (M: Rigid) => Math.hypot(M.origin.x, M.origin.y, M.origin.z) > 1e-9 * scale || Math.abs(M.x.x - 1) + Math.abs(M.y.y - 1) + Math.abs(M.z.z - 1) > 1e-9;
  const stillAt = panels.map((_, t) => path.every((x) => !moved(compose(fit(x, mesh.tris[t]), start[t]))));
  const lift = spaceLayers(panels, end, near, stillAt, (a, b) => flatBetween.get(`${a},${b}`) ?? 0, (a, b) => segBetween.get(`${a},${b}`), gap, scale);
  collapses.push({ step, driver, nodes: [], table: [], lift: lift.map((l, t) => applyVec(invert(Mend[t]), l)), bend: { verts: mesh.verts, tris: mesh.tris, path: path.map((x) => [...x]) } });
  panels.forEach((w, t) => {
    if (stillAt[t] && Math.hypot(lift[t].x, lift[t].y, lift[t].z) <= 1e-12) return;
    w.T = compose(translation(lift[t]), end[t]);
    w.moves.push(driver); w.nodes.push(t);
  });
  return panels;
}

/** Samples of a bending transition, and how many of them at its end blend to the keyframe. */
const TRANSITION_SAMPLES = 16, SNAP_SAMPLES = 3;

/** A bending transition between two rigid keyframes (core/sheetBend.ts): the step's end is known (`keyframe`: every
 *  facet's placement when done, order and spacing included), and only the patch — the operation's point and the
 *  layers it folds against, one ring of neighbours — is meshed and moved. Every hinge of the mesh knows where it
 *  starts and where it ends (its dihedral in the two keyframes), so the solver only finds the way between: faces
 *  bend a little, old creases ease (the spine the point goes through opens), the step's creases fold to their angle.
 *  The last samples blend to the keyframe exactly, so the patch ends rigid: the mesh's triangles lie flat in their
 *  facets again and their seams merge back (a seam is a crease only while the step runs), the face count what the
 *  rigid plan had. Vertices on the patch's edge with the rest of the paper are held. */
function bendTransition(work: Work[], keyframe: Rigid[], patch: Set<number>, fixed: Pt, chords: Chord[], collapses: SeqCollapse[], step: number, driver: number, gap: number, scale: number, tol: number): Work[] {
  const wtol = 1e-5 * scale;
  const members = [...patch].sort((a, b) => a - b);
  const mesh = meshFacets(members.map((k) => work[k].poly), BEND_SIZE * scale, tol);
  const nv = mesh.verts.length;
  const owner = mesh.owner.map((o) => members[o]);
  // a vertex's place in a keyframe: the facets it's on agree up to the layers' spacing at a crease (averaged)
  const place = (T: (k: number) => Rigid) => {
    const x = new Float64Array(3 * nv), count = new Float64Array(nv);
    mesh.tris.forEach((tri, t) => { for (const v of tri) { const q = applyPoint(T(owner[t]), at3(mesh.verts[v])); x[3 * v] += q.x; x[3 * v + 1] += q.y; x[3 * v + 2] += q.z; count[v]++; } });
    for (let v = 0; v < nv; v++) for (let p2 = 0; p2 < 3; p2++) x[3 * v + p2] /= count[v];
    return x;
  };
  const x0 = place((k) => work[k].T), x1 = place((k) => keyframe[k]);
  // held: vertices on an edge the patch shares with paper outside it, and the held facet's if it's in the patch
  const outside = work.map((_, k) => k).filter((k) => !patch.has(k));
  const held = new Set<number>();
  mesh.verts.forEach((v, i) => {
    for (const k of outside) {
      const P = work[k].poly;
      for (let a = 0; a < P.length; a++) { const A = P[a], B = P[(a + 1) % P.length]; if (distToSeg2(v, A, B) <= wtol) { held.add(i); return; } }
    }
  });
  const heldTri = mesh.tris.findIndex((tri) => inConvex(fixed, tri.map((v) => mesh.verts[v]), tol));
  if (heldTri >= 0) for (const v of mesh.tris[heldTri]) held.add(v);
  if (!held.size) for (const v of mesh.tris[0]) held.add(v);
  // the hinges: each from its dihedral at the start to its dihedral at the end
  const left = new Map<string, number>();
  mesh.tris.forEach((tri, t) => { for (let i = 0; i < 3; i++) left.set(`${tri[i]},${tri[(i + 1) % 3]}`, t); });
  const dihedralOf = (x: Float64Array, h: { a: number; b: number; c: number; d: number }, near: number) => dihedral(x, h, near).th;
  const hinges: BendHinge[] = meshHinges(mesh.tris).map((h) => {
    const A = mesh.verts[h.a], B = mesh.verts[h.b], fa = owner[left.get(`${h.a},${h.b}`)!], fb = owner[left.get(`${h.b},${h.a}`)!];
    const k0 = hingeStiffness(mesh.verts, h, (BEND_SIZE * scale) / 6);
    // the end angle, from the keyframe's facets (exact: the mesh's averaged vertices are a layer's spacing off)
    const angleBetween = (Ta: Rigid, Tb: Rigid) => {
      const P = applyPoint(Ta, at3(A)), e = unit3(sub3(applyPoint(Ta, at3(B)), P));
      let th = -Math.atan2(dot3(cross3(Ta.z, Tb.z), e), dot3(Ta.z, Tb.z));
      if (Math.abs(th) > Math.PI - 3 * rad1) th = Math.PI * (Math.sign(dot3(sub3(applyPoint(Tb, at3(centroid(work[fb].poly))), P), Ta.z)) || 1);
      return th;
    };
    const rest = fa === fb ? 0 : angleBetween(work[fa].T, work[fb].T), to = fa === fb ? 0 : angleBetween(keyframe[fa], keyframe[fb]);
    if (fa === fb) return { ...h, k: k0, rest: 0, to: 0 };
    const was = [...chords].reverse().find((c) => { const sp = sharedSpan(A, B, c.a, c.b, wtol); return !!sp && len2(sub2(sp[1], sp[0])) > len2(sub2(B, A)) - 2 * wtol; });
    // a crease of this step is driven to its angle; one that moves is eased; one that stays is an old crease
    const mine = was && was.fold === driver;
    return { ...h, k: k0 * (mine ? DRIVEN : Math.abs(to - rest) > 1e-6 ? FREE_CREASE : OLD_CREASE), rest, to };
  });
  void dihedralOf;
  const path = bendPath({ flat: mesh.verts, tris: mesh.tris, x0, hinges, fixed: [...held], thickness: gap }, TRANSITION_SAMPLES);
  // the snap: the last samples blend to the keyframe, which ends the path exactly
  const last = path[path.length - 1];
  for (let q = 1; q <= SNAP_SAMPLES; q++) {
    const t = q / SNAP_SAMPLES, x = new Float64Array(3 * nv);
    for (let i = 0; i < x.length; i++) x[i] = last[i] + (x1[i] - last[i]) * t;
    path.push(x);
  }
  // the panels: the patch's facets become the mesh's triangles, placed exactly by the keyframe when done
  const next: Work[] = work.filter((_, k) => !patch.has(k));
  const panels: Work[] = mesh.tris.map((tri, t) => {
    const w = work[owner[t]];
    return { poly: tri.map((v) => mesh.verts[v]), T: keyframe[owner[t]], moves: [...w.moves, driver], nodes: [...w.nodes, t] };
  });
  // seams between the panels of one facet: creases only while the step runs (they merge back when it's done)
  hinges.forEach((h) => {
    const fa = owner[left.get(`${h.a},${h.b}`)!], fb = owner[left.get(`${h.b},${h.a}`)!];
    if (fa === fb) chords.push({ fold: driver, a: mesh.verts[h.a], b: mesh.verts[h.b], angle: 0, bend: true });
  });
  const endMotion = mesh.tris.map((_, t) => compose(keyframe[owner[t]], invert(work[owner[t]].T)));
  collapses.push({ step, driver, nodes: [], table: [], lift: mesh.tris.map(() => ({ x: 0, y: 0, z: 0 })), bend: { verts: mesh.verts, tris: mesh.tris, path: path.map((x) => [...x]), end: endMotion } });
  return [...next, ...panels];
}

function distToSeg2(p: Pt, a: Pt, b: Pt): number {
  const ab = sub2(b, a), L2 = dot2(ab, ab);
  const k = L2 > 0 ? Math.max(0, Math.min(1, dot2(sub2(p, a), ab) / L2)) : 0;
  return len2(sub2(p, add2(a, mul2(ab, k))));
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
  const M = c.bend ? (c.bend.end && s >= 1 - 1e-9 ? c.bend.end : bendMotion(c.bend, s)) : collapseMotion(c.nodes, collapseAngles(c.table, s));
  return M.map((m, k) => { const l = c.lift[k]; return l.x || l.y || l.z ? compose(translation(mul3(applyVec(m, l), s)), m) : m; });
}

/** A bending step's panel motions at progress `s` (0 … 1): the vertices between their samples, each triangle fitted
 *  there, relative to its fit at the start. */
function bendMotion(b: NonNullable<SeqCollapse["bend"]>, s: number): Rigid[] {
  const rows = b.path.length, k = Math.min(rows - 2, Math.max(0, Math.floor(s * (rows - 1)))), t = Math.min(1, Math.max(0, s * (rows - 1) - k));
  const A = b.path[k], B = b.path[k + 1], P0 = b.path[0];
  const pt = (x: (i: number) => number, v: number): V3 => ({ x: x(3 * v), y: x(3 * v + 1), z: x(3 * v + 2) });
  const now = (i: number) => A[i] + (B[i] - A[i]) * t, zero = (i: number) => P0[i];
  return b.tris.map((T) => {
    const flat = T.map((v) => b.verts[v]) as [Pt, Pt, Pt];
    return compose(fitPanel(flat, T.map((v) => pt(now, v)) as [V3, V3, V3]), invert(fitPanel(flat, T.map((v) => pt(zero, v)) as [V3, V3, V3])));
  });
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

/** A crease shows once its fold has started — a fold of a collapse with no angle of its own (a crease turning with
 *  another, a crease carried through the layers, one freed to be solved) once the collapse's driving fold has. A
 *  bending transition's seam (flat when its step is done) is one only while the step runs: then the panels lie flat
 *  in their facet again, and the seam merges back. */
export const creaseMade = (c: SeqCrease, angles: number[], seq?: Pick<SheetSequence, "folds" | "collapses">) => {
  const started = (j: number) => {
    if (Math.abs(angles[j]) > 1e-9) return true;
    const f = seq?.folds[j];
    return !!f && f.collapse != null && Math.abs(f.angle) < 1e-9 && Math.abs(angles[seq!.collapses![f.collapse].driver]) > 1e-9;
  };
  const folds = seq?.folds;
  return c.folds.some(started) && !(c.bend && Math.abs(c.angle) < 1e-9 && folds && c.folds.every((j) => Math.abs(angles[j]) < 1e-9 || Math.abs(angles[j]) > Math.abs(folds[j].angle) - 1e-9));
};

/** A triangle mesh of the sheet posed at `angles` (world = frame ∘ facet placement): the
 *  facets fanned (front faces on the paper's top), their flat coordinates as uvs, and as
 *  edges the outline plus every crease made so far. */
export function sequenceMesh(seq: SheetSequence, angles: number[], frame: Rigid, bend?: number): { positions: Float32Array; normals: Float32Array; indices: Uint32Array; uvs: Float32Array; edges: Float32Array; paper: PaperOverlay } {
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
  const segs: [Rigid, Pt, Pt][] = [...seq.outline.map((o) => [T[o.facet], o.a, o.b] as [Rigid, Pt, Pt]), ...seq.creases.filter((c) => !c.bend && creaseMade(c, angles, seq)).map((c) => [T[c.facets[0]], c.a, c.b] as [Rigid, Pt, Pt])];
  const edges = new Float32Array(6 * segs.length);
  segs.forEach(([M, a, b], i) => { const p = applyPoint(M, at3(a)), q = applyPoint(M, at3(b)); edges.set([p.x, p.y, p.z, q.x, q.y, q.z], 6 * i); });
  return { positions, normals, indices, uvs, edges, paper: sequencePaper(seq, angles, frame, { radius: bend }) };
}

/** What makes folded paper readable on screen, besides its surface: its raw cut edges (the outline, not the
 *  creases: a flap folded back onto a layer is the same colour, with the same normal, so its edge would vanish),
 *  and the soft shadow a flap casts on the layer it lies on along that edge, as real paper does. */
export interface PaperOverlay {
  /** The outline's segments, world (xyz pairs). */
  outline: Float32Array;
  /** Contact shadows: triangles on the layers under (or over) a flap's edge, just off the layer, darkest at the
   *  edge and fading `width` away from it — positions (world), colours (rgba, the alpha the fade), indices. */
  shadow: { positions: Float32Array; colors: Float32Array; indices: Uint32Array };
  /** The bends: a rounded strip over every crease folded past a few degrees — a circular arc of the sheet's bend
   *  radius between the two facets, or, where the facets' edges lie apart (a flap folded flat sits a gap or more
   *  off its layer, the outer layers of a nested fold further), the arc that joins the two edges — shaded like the
   *  paper (positions, normals, sheet coordinates (x, y, 1), indices; the front face the paper's top). Display only:
   *  the facets underneath stay the sharp hinges the plan poses. */
  bends: { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array;
    /** Per vertex, the crease (index into the sequence's creases) its strip rounds. */
    crease: Uint32Array };
  /** Crease marks, as line segments (world): `dark` along valleys lying flat or nearly so (a pre-crease, a shallow
   *  fold: the trough of the crease), `light` along mountains lying flat and along the crest of every sharp fold
   *  (the stress whitening of a folded sheet). A crease not made yet leaves nothing. */
  marks: { dark: Float32Array; light: Float32Array;
    /** Per segment of `dark` / `light`, the crease it marks. */
    darkCrease: Uint32Array; lightCrease: Uint32Array };
}

const ARC_SEGS = 8;

/** The paper overlay (PaperOverlay) of the sheet posed at `angles`: read from the layer stack — for every raw edge
 *  of a facet, the facets lying with it within a few gaps that the strip `width` beyond the edge falls on. */
export function sequencePaper(seq: SheetSequence, angles: number[], frame: Rigid, opts: { width?: number; radius?: number } = {}): PaperOverlay {
  const T = poseSequence(seq, angles), W = T.map((t) => compose(frame, t));
  const width = opts.width, radius = opts.radius ?? 4 * seq.gap;
  const outline = new Float32Array(6 * seq.outline.length);
  seq.outline.forEach((o, i) => { const p = applyPoint(W[o.facet], at3(o.a)), q = applyPoint(W[o.facet], at3(o.b)); outline.set([p.x, p.y, p.z, q.x, q.y, q.z], 6 * i); });
  const scale = Math.max(1, ...seq.facets.flatMap((f) => f.poly.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y)))));
  const w = width ?? Math.max(8 * seq.gap, 0.01 * scale), DARK = 0.2, NEAR = 3.5 * seq.gap;
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const fams = layerFamilies(T);
  for (const fam of fams) {
    if (fam.facets.length < 2) continue;
    const inFam = new Set(fam.facets);
    const to2 = (k: number, p: Pt) => { const q = applyPoint(T[k], at3(p)); return { x: dot3(q, fam.u), y: dot3(q, fam.v) }; };
    const shape = new Map<number, Pt[]>(), h = new Map<number, number>();
    for (const k of fam.facets) { shape.set(k, seq.facets[k].poly.map((p) => to2(k, p))); h.set(k, dot3(T[k].origin, fam.n)); }
    for (const o of seq.outline) {
      const f = o.facet;
      if (!inFam.has(f)) continue;
      const a = to2(f, o.a), b = to2(f, o.b), e = sub2(b, a), L = len2(e);
      if (L < 1e-9) continue;
      const c = centroid(shape.get(f)!);
      let m = { x: -e.y / L, y: e.x / L };
      if (dot2(sub2(c, a), m) > 0) m = mul2(m, -1); // outward: away from the facet
      const strip = [a, b, add2(b, mul2(m, w)), add2(a, mul2(m, w))];
      for (const g of fam.facets) {
        if (g === f) continue;
        const dh = h.get(f)! - h.get(g)!;
        if (Math.abs(dh) < 1e-9 || Math.abs(dh) > NEAR) continue;
        const poly = clipConvexPoly(strip, shape.get(g)!);
        if (poly.length < 3 || Math.abs(polyArea(poly)) < 1e-6 * w * w) continue;
        const z = h.get(g)! + Math.sign(dh) * 0.15 * seq.gap; // a hair off the layer, toward the flap
        const base = pos.length / 3;
        for (const q of poly) {
          const P = add3(add3(mul3(fam.u, q.x), mul3(fam.v, q.y)), mul3(fam.n, z)), Wp = applyPoint(frame, P);
          const d = Math.max(0, Math.min(w, dot2(sub2(q, a), m)));
          pos.push(Wp.x, Wp.y, Wp.z); col.push(0, 0, 0, DARK * (1 - d / w));
        }
        for (let i = 1; i + 1 < poly.length; i++) idx.push(base, base + i, base + i + 1);
      }
    }
  }
  // the bends and the crease marks
  const bp: number[] = [], bn: number[] = [], bu: number[] = [], bi: number[] = [], bc: number[] = [], dark: number[] = [], light: number[] = [], dc: number[] = [], lc: number[] = [];
  const unit = (v: V3) => unit3(v);
  /** Into facet k from its edge a→b: the direction in its plane (world) and on the flat sheet. */
  const inward = (k: number, a: Pt, b: Pt) => {
    const e = sub2(b, a), L = len2(e) || 1, c = centroid(seq.facets[k].poly), m = sub2(c, mul2(add2(a, b), 0.5));
    const off = dot2(m, e) / (L * L), perp = sub2(m, mul2(e, off)), Lp = len2(perp) || 1, dir = mul2(perp, 1 / Lp);
    return { m: unit(applyVec(W[k], at3(dir))), dir };
  };
  /** How far a ray from p along dir stays inside convex facet k (flat): the back-off along it can't go further. */
  const exit = (k: number, p: Pt, dir: Pt) => {
    const poly = seq.facets[k].poly, ccw = polyArea(poly) >= 0 ? poly : [...poly].reverse();
    let t = Infinity;
    for (let i = 0; i < ccw.length; i++) {
      const a = ccw[i], b = ccw[(i + 1) % ccw.length], ex = b.x - a.x, ey = b.y - a.y;
      const den = ex * dir.y - ey * dir.x; // leaving across this edge (the ray turns clockwise to it)
      if (den >= -1e-12) continue;
      const tt = (ex * (p.y - a.y) - ey * (p.x - a.x)) / den;
      if (tt >= 0) t = Math.min(t, tt);
    }
    return Number.isFinite(t) ? t : 0;
  };
  const bez = (P0: V3, P1: V3, P2: V3, P3: V3, u: number) => { const v = 1 - u; return add3(add3(mul3(P0, v * v * v), mul3(P1, 3 * v * v * u)), add3(mul3(P2, 3 * v * u * u), mul3(P3, u * u * u))); };
  const dbez = (P0: V3, P1: V3, P2: V3, P3: V3, u: number) => { const v = 1 - u; return add3(add3(mul3(sub3(P1, P0), 3 * v * v), mul3(sub3(P2, P1), 6 * v * u)), mul3(sub3(P3, P2), 3 * u * u)); };
  seq.creases.forEach((c, ci) => {
    if (c.bend || !creaseMade(c, angles, seq)) return;
    const [A, B] = c.facets, nA = W[A].z, nB = W[B].z;
    const phi = Math.acos(Math.max(-1, Math.min(1, dot3(nA, nB)))); // how far folded: 0 flat … π folded flat
    const PA = [applyPoint(W[A], at3(c.a)), applyPoint(W[A], at3(c.b))], PB = [applyPoint(W[B], at3(c.a)), applyPoint(W[B], at3(c.b))];
    const e = unit(sub3(PA[1], PA[0]));
    if (phi < 20 * rad1) {
      // lying flat (a pre-crease, a shallow fold): the trough of a valley, the ridge of a mountain
      const seg = [PA[0], PA[1]].flatMap((q) => [q.x, q.y, q.z]);
      if (c.angle >= 0) { dark.push(...seg); dc.push(ci); } else { light.push(...seg); lc.push(ci); }
      if (phi < 8 * rad1) return;
    }
    const inA = inward(A, c.a, c.b), inB = inward(B, c.a, c.b), mA = inA.m, mB = inB.m;
    // a join the plan leaves open wider than a nested fold's layers could be apart isn't a bend (a reverse fold
    // settling, a corner the plan can't close): no strip, or it would arc out across the gap
    const apart = Math.max(...[0, 1].map((end) => { const g = sub3(PB[end], PA[end]); return Math.hypot(g.x, g.y, g.z); }));
    if (apart > 2 * radius) return;
    const ends: V3[][] = [];
    for (let end = 0; end < 2; end++) {
      const P = PA[end], Q = PB[end], ch = sub3(Q, P), v = sub3(mB, mA), Lv = Math.hypot(v.x, v.y, v.z);
      // how far each facet runs back from this end of the crease (a facet may come to a point here): the back-off
      // never passes half way across either
      const q2 = end === 0 ? c.a : c.b, deep = Math.min(exit(A, q2, inA.dir), exit(B, q2, inB.dir));
      // back along each facet by s, so the arc between them has the bend radius — never further than twice the
      // radius, and nothing at all as the fold closes flat (the two facets' inward directions meet, and the back-off
      // that would keep the radius runs away; from 150° on it blends out), where the arc joining the two edges
      // takes over: a flap lying flat has its edges a gap or more apart, and nothing may leave the facets it joins
      const need = 2 * radius * Math.sin(phi / 2), room = 2 * radius * Math.min(1, Math.max(0, (Math.PI - phi) / (30 * rad1)));
      const s = Lv > 1e-9 ? Math.min(room, 0.5 * deep, Math.max(0, (need - Math.hypot(ch.x, ch.y, ch.z)) / Lv)) : 0;
      const P0 = add3(P, mul3(mA, s)), Q0 = add3(Q, mul3(mB, s)), chord = sub3(Q0, P0), d = Math.hypot(chord.x, chord.y, chord.z);
      if (d < 1e-6 * scale) { ends.length = 0; break; }
      // (the arc's radius follows from the chord: the bend radius where there's room, the half-gap closing flat)
      const r = d / (2 * Math.sin(Math.max(phi, 1e-3) / 2)), k = (4 / 3) * Math.tan(phi / 4) * r;
      ends.push([P0, add3(P0, mul3(mA, -k)), sub3(Q0, mul3(mB, k)), Q0]);
    }
    if (!ends.length) return;
    // the strip: the arc at each end, ruled between; the front face the paper's top (A's top side)
    const base = bp.length / 3;
    let flip = false;
    for (let end = 0; end < 2; end++) {
      const [P0, P1, P2, P3] = ends[end];
      for (let j = 0; j <= ARC_SEGS; j++) {
        const u = j / ARC_SEGS, p = bez(P0, P1, P2, P3, u), t = unit(dbez(P0, P1, P2, P3, u));
        let n = unit(cross3(e, t));
        if (end === 0 && j === 0) flip = dot3(n, nA) < 0;
        if (flip) n = mul3(n, -1);
        bp.push(p.x, p.y, p.z); bn.push(n.x, n.y, n.z); bc.push(ci);
        const q = end === 0 ? c.a : c.b;
        bu.push(q.x, q.y, 1);
        if (j === Math.floor(ARC_SEGS / 2) && phi > 150 * rad1) { light.push(p.x, p.y, p.z); if (end === 1) lc.push(ci); } // the crest of a sharp fold: its stress mark, end to end
      }
    }
    for (let j = 0; j < ARC_SEGS; j++) {
      const a0 = base + j, a1 = base + j + 1, b0 = base + ARC_SEGS + 1 + j, b1 = base + ARC_SEGS + 2 + j;
      // wound so the front face is the side the normals point to (the paper's top, continuing facet A's)
      if (flip) bi.push(a0, a1, b0, a1, b1, b0); else bi.push(a0, b0, a1, a1, b0, b1);
    }
  });
  return {
    outline, shadow: { positions: new Float32Array(pos), colors: new Float32Array(col), indices: new Uint32Array(idx) },
    bends: { positions: new Float32Array(bp), normals: new Float32Array(bn), uvs: new Float32Array(bu), indices: new Uint32Array(bi), crease: new Uint32Array(bc) },
    marks: { dark: new Float32Array(dark), light: new Float32Array(light), darkCrease: new Uint32Array(dc), lightCrease: new Uint32Array(lc) },
  };
}

/** How far any bend-strip vertex or crease mark of the overlay lies outside the bounds of the two facets its crease
 *  joins (posed, world), beyond `slack` — 0 when every one stays within them (what the display must never break:
 *  a strip that leaves its facets is a fly-away on screen). */
export function paperOverlayStray(seq: SheetSequence, angles: number[], frame: Rigid, p: PaperOverlay, slack: number): number {
  const W = poseSequence(seq, angles).map((t) => compose(frame, t));
  const box = new Map<number, { lo: V3; hi: V3 }>();
  const boundsOf = (ci: number) => {
    let b = box.get(ci);
    if (b) return b;
    b = { lo: { x: Infinity, y: Infinity, z: Infinity }, hi: { x: -Infinity, y: -Infinity, z: -Infinity } };
    for (const f of seq.creases[ci].facets) for (const q of seq.facets[f].poly) {
      const w = applyPoint(W[f], at3(q));
      b.lo = { x: Math.min(b.lo.x, w.x), y: Math.min(b.lo.y, w.y), z: Math.min(b.lo.z, w.z) }; b.hi = { x: Math.max(b.hi.x, w.x), y: Math.max(b.hi.y, w.y), z: Math.max(b.hi.z, w.z) };
    }
    box.set(ci, b);
    return b;
  };
  let worst = 0;
  const check = (x: number, y: number, z: number, ci: number) => {
    const b = boundsOf(ci);
    worst = Math.max(worst, b.lo.x - x - slack, x - b.hi.x - slack, b.lo.y - y - slack, y - b.hi.y - slack, b.lo.z - z - slack, z - b.hi.z - slack);
  };
  const B = p.bends.positions;
  for (let i = 0; i < B.length / 3; i++) check(B[3 * i], B[3 * i + 1], B[3 * i + 2], p.bends.crease[i]);
  for (const [segs, cr] of [[p.marks.dark, p.marks.darkCrease], [p.marks.light, p.marks.lightCrease]] as const) for (let i = 0; i < segs.length / 6; i++) for (let e = 0; e < 2; e++) check(segs[6 * i + 3 * e], segs[6 * i + 3 * e + 1], segs[6 * i + 3 * e + 2], cr[i]);
  return Math.max(0, worst);
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

/** Where panels folded all at once (a pop-up card at some opening) pass through each other, ignoring a band
 *  `margin` wide along every edge: pairs of panel indices. */
export function panelClashes(panels: { T: Rigid; segs: [Pt, Pt][] }[], margin: number): [number, number][] {
  const { polys, panel } = panelPieces(panels);
  const posed = polys.map((poly, k) => inset(poly, margin).map((p) => applyPoint(panels[panel[k]].T, at3(p))));
  const out: [number, number][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < posed.length; i++) for (let j = i + 1; j < posed.length; j++) {
    if (panel[i] === panel[j] || posed[i].length < 3 || posed[j].length < 3) continue;
    const key = `${panel[i]},${panel[j]}`;
    if (seen.has(key)) continue;
    if (facetsMeet(posed[i], panels[panel[i]].T.z, posed[j], panels[panel[j]].T.z, 1e-6)) { seen.add(key); out.push([panel[i], panel[j]]); }
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
  for (const c of seq.creases) if (!creaseMade(c, angles, seq)) parent[find(c.facets[0])] = find(c.facets[1]);
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
