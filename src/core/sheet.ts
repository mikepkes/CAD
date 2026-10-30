// Sheet metal — and paper. A sheet is a flat blank plus fold lines, and its 3D
// shape is that blank folded: every fold turns the material on one side of
// its line about an axis along it. The flat state is the source of truth, so
// the flat pattern is exact by construction and flanges, hems, jogs and an
// origami crease pattern are all the same thing: more blank, more folds.
//
// Two kinds of fold:
//  - a bend (radius > 0): a zone of the blank, as wide as the bend allowance
//    BA = |θ|·(r + k·t), is wrapped onto a cylinder of inner radius r. The
//    neutral layer (k·t in from the inside) keeps its length, so the flat
//    length is Σ straights + Σ BA — the sheet-metal K-factor model.
//  - a crease (radius 0): a hinge with no width. Creases may cross at vertices
//    (origami); a vertex only folds if the rotations around it close up, so
//    creases left without an angle are solved from that closure (rigid
//    origami kinematics) given the ones that have one.
//
// This module is pure geometry: the blank's outline, fold placement, the fold
// graph and its kinematics, flat-pattern export. The OCC side (blank faces,
// splitting, the folded solid) lives in occ/sheet.ts.

import { loopPolygon, Profile, Pt } from "./geometry/profile";
import { Rigid, IDENTITY, compose, invert, rotationAbout, translation } from "../math/transform";

export type Seg = [Pt, Pt];

/** A named straight edge of the blank (for flanges): `out` is the unit normal pointing off the material. */
export interface SheetEdge { name: string; a: Pt; b: Pt; out: Pt }

/** A fold line in the flat. Positive angles fold toward the sheet's top (local
 *  +z: the side its thickness grows toward) — a valley seen from the top;
 *  negative ones fold away — a mountain. */
export interface SheetFold {
  id: string;
  a: Pt;
  b: Pt;
  /** Radians; undefined = solve it (creases only) from the vertices it meets. */
  angle?: number;
  /** Which way an unsolved fold goes: picks the branch the solver lands on. */
  direction: 1 | -1;
  /** Inner bend radius; 0 = a sharp crease. */
  radius: number;
  /** The bend runs across the whole face it's drawn on (to the blank's edge), not just between a and b. */
  extend?: boolean;
  /** The flat region this fold's flange owns (bend and straight): where two
   *  overlap at a corner, the overlap is cut away (a corner relief). */
  zone?: Pt[];
  /** A set-back flange's band inside the original edge (u ∈ [−setback, 0], long
   *  along the edge): a flange meeting it at a corner is trimmed out of it, so
   *  the two walls don't run into each other. */
  setbackBand?: Pt[];
}

/** Material added to (a flange) or cut from (a relief) the blank, in order. */
export interface BlankOp { op: "add" | "cut"; poly: Pt[] }

export interface SheetState {
  /** Flat → world: local x/y on the blank, z the sheet normal; material z ∈ [0, t]. */
  frame: Rigid;
  /** The blank: sketch regions, or a face read back from an edited flat (BREP text). */
  base: { regions: Profile[] } | { brep: string };
  ops: BlankOp[];
  edges: SheetEdge[];
  folds: SheetFold[];
  thickness: number;
  kFactor: number;
  /** Default inner bend radius for new folds. */
  radius: number;
  reliefWidth: number;
  /** A point (flat) on the panel that stays put. */
  fixed: Pt;
  /** Shown flat (sheet.unfold) instead of folded. */
  unfolded?: boolean;
  /** Another feature has changed the body since this state was built. */
  edited?: boolean;
  /** Derived by the last fold: each panel's placement (flat → local folded) and outline. */
  panels?: { T: Rigid; segs: Seg[] }[];
  /** Solved fold angles (radians) by fold id. */
  angles?: Record<string, number>;
  /** Derived: the flat pattern as last built. */
  pattern?: FlatPattern;
}

// ---- 2D helpers --------------------------------------------------------------

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const len = (a: Pt) => Math.hypot(a.x, a.y);
const unit = (a: Pt): Pt => mul(a, 1 / (len(a) || 1));
const left = (e: Pt): Pt => ({ x: -e.y, y: e.x });

/** Even–odd containment against an unordered set of boundary segments. */
export function insideSegs(p: Pt, segs: Seg[]): boolean {
  let inside = false;
  for (const [a, b] of segs) {
    if ((a.y > p.y) !== (b.y > p.y)) {
      const x = a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (x > p.x) inside = !inside;
    }
  }
  return inside;
}

/** Signed area of a polygon (CCW positive). */
export function polygonArea(poly: Pt[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; s += p.x * q.y - q.x * p.y; }
  return s / 2;
}

/** The part of convex polygon `subject` inside convex polygon `clip` (Sutherland–Hodgman). */
export function clipConvex(subject: Pt[], clip: Pt[]): Pt[] {
  const ccw = polygonArea(clip) >= 0 ? clip : [...clip].reverse();
  let out = subject;
  for (let i = 0; i < ccw.length && out.length; i++) {
    const a = ccw[i], b = ccw[(i + 1) % ccw.length];
    const inside = (p: Pt) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= -1e-12;
    const cut = (p: Pt, q: Pt): Pt => {
      const d1 = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      const d2 = (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x);
      return add(p, mul(sub(q, p), d1 / (d1 - d2)));
    };
    const next: Pt[] = [];
    for (let j = 0; j < out.length; j++) {
      const p = out[j], q = out[(j + 1) % out.length];
      if (inside(q)) { if (!inside(p)) next.push(cut(p, q)); next.push(q); }
      else if (inside(p)) next.push(cut(p, q));
    }
    out = next;
  }
  return out;
}

// ---- rules --------------------------------------------------------------------

/** Length of blank a fold consumes: the neutral arc |θ|·(r + k·t); 0 for a crease. */
export function bendAllowance(angle: number, radius: number, s: Pick<SheetState, "thickness" | "kFactor">): number {
  return radius > 0 ? Math.abs(angle) * (radius + s.kFactor * s.thickness) : 0;
}

/** Bend deduction: how much shorter the flat is than the two flanges measured to their outside virtual sharp. */
export function bendDeduction(angle: number, radius: number, s: Pick<SheetState, "thickness" | "kFactor">): number {
  const a = Math.abs(angle);
  return 2 * (radius + s.thickness) * Math.tan(Math.min(a, Math.PI * 0.999) / 2) - bendAllowance(angle, radius, s);
}

// ---- building blanks ------------------------------------------------------------

/** Named edges of a blank: each sketch line that bounds the material, with its outward normal. */
export function blankEdges(regions: Profile[], lines: { id: string; a: Pt; b: Pt }[]): SheetEdge[] {
  const polys = regions.map((r) => ({ outer: loopPolygon(r.outer), holes: r.holes.map(loopPolygon) }));
  const segsOf = (poly: Pt[]): Seg[] => poly.map((p, i) => [p, poly[(i + 1) % poly.length]] as Seg);
  const material = polys.map((r) => [...segsOf(r.outer), ...r.holes.flatMap(segsOf)]);
  const inside = (p: Pt) => material.some((m) => insideSegs(p, m));
  const out: SheetEdge[] = [];
  for (const l of lines) {
    const L = len(sub(l.b, l.a));
    if (L < 1e-9) continue;
    const e = unit(sub(l.b, l.a)), n = left(e), m = mul(add(l.a, l.b), 0.5), d = Math.min(1e-3 * L, 1e-2);
    const inL = inside(add(m, mul(n, d))), inR = inside(sub(m, mul(n, d)));
    if (inL === inR) continue; // not on the boundary
    out.push({ name: l.id, a: l.a, b: l.b, out: inL ? mul(n, -1) : n });
  }
  return out;
}

export interface FlangeSpec {
  id: string;
  /** Straight length past the bend. */
  length: number;
  angle: number;
  radius: number;
  /** Where the bend sits relative to the edge: starting at it (default), or set
   *  back so the flange's outside (materialInside) or inside (materialOutside)
   *  face lines up with the edge. */
  position?: "bendOutside" | "materialInside" | "materialOutside";
  /** Distance from each end of the edge left without flange. */
  inset?: [number, number];
}

/** Add an edge flange (or hem): extend the blank off the edge and fold it there. */
export function addFlange(s: SheetState, edgeName: string, f: FlangeSpec): SheetState {
  const edge = s.edges.find((e) => e.name === edgeName);
  if (!edge) throw new Error(`no edge "${edgeName}" on the sheet (its edges: ${s.edges.map((e) => e.name).join(", ") || "none"})`);
  const L = len(sub(edge.b, edge.a));
  const e = unit(sub(edge.b, edge.a));
  // flange frame: s along the edge from a, u outward
  const m = edge.out;
  const at = (ss: number, u: number) => add(edge.a, add(mul(e, ss), mul(m, u)));
  const [i1, i2] = f.inset ?? [0, 0];
  const s0 = i1, s1 = L - i2;
  if (!(s1 - s0 > 1e-6)) throw new Error(`the flange's insets (${i1}, ${i2}) leave nothing of the ${L.toFixed(2)} mm edge`);
  if (!(f.length > 0)) throw new Error("a flange needs a positive length");
  if (Math.abs(f.angle) > Math.PI + 1e-9) throw new Error("a flange angle is at most 180°");
  const t = s.thickness, r = f.radius, th = Math.abs(f.angle);
  const BA = bendAllowance(f.angle, r, s);
  const setback = (R: number) => R * Math.tan(Math.min(th, Math.PI / 2) / 2);
  const shift = f.position === "materialInside" ? setback(r + t) : f.position === "materialOutside" ? setback(r) : 0;
  const uEnd = -shift + BA + f.length;
  if (!(uEnd > 1e-6)) throw new Error("the flange is too short to clear its bend");
  const rect = (a: number, b: number, u0: number, u1: number) => [at(a, u0), at(b, u0), at(b, u1), at(a, u1)];
  const ops: BlankOp[] = [{ op: "add", poly: rect(s0, s1, 0, uEnd) }];
  // a set-back bend runs into the material: relief slots at partial ends stop it tearing the rest
  if (shift > 1e-9) {
    const w = s.reliefWidth, depth = shift + w;
    if (i1 > 1e-9) ops.push({ op: "cut", poly: rect(s0 - w, s0, -depth, w) });
    if (i2 > 1e-9) ops.push({ op: "cut", poly: rect(s1, s1 + w, -depth, w) });
  }
  const uc = -shift + BA / 2;
  const fold: SheetFold = {
    id: f.id, a: at(s0, uc), b: at(s1, uc), angle: f.angle, direction: f.angle < 0 ? -1 : 1, radius: r,
    zone: rect(s0, s1, -shift, uEnd),
    ...(shift > 1e-9 ? { setbackBand: rect(-1e5, 1e5, -shift, 0) } : {}),
  };
  const edges: SheetEdge[] = [
    { name: `${f.id}:tip`, a: at(s0, uEnd), b: at(s1, uEnd), out: m },
    { name: `${f.id}:side1`, a: at(s0, 0), b: at(s0, uEnd), out: mul(e, -1) },
    { name: `${f.id}:side2`, a: at(s1, 0), b: at(s1, uEnd), out: e },
  ];
  return { ...s, ops: [...s.ops, ...ops], folds: [...s.folds, fold], edges: [...s.edges, ...edges], unfolded: false };
}

/** A contour flange: an open polyline (sketch coords) of straight lines,
 *  unrolled into a strip `width` wide with a bend at every corner. The sketch
 *  line is the sheet's bottom face (its virtual sharps); the material lies on
 *  the polyline's right (or left, `flip`), the width along +sketch normal. */
export function contourBlank(pts: Pt[], lineIds: string[], width: number, flip: boolean, s: Pick<SheetState, "thickness" | "kFactor" | "radius">, featureId: string):
  { regions: Profile[]; folds: SheetFold[]; edges: SheetEdge[]; fixed: Pt; y0: number; startDir: Pt } {
  if (pts.length < 2) throw new Error("a contour flange needs at least one line");
  const segs = pts.slice(1).map((p, i) => ({ d: sub(p, pts[i]), L: len(sub(p, pts[i])) }));
  const t = s.thickness, r = s.radius;
  // turn at each corner (CCW about the sketch normal positive) → fold angle
  const angles = segs.slice(1).map((sg, i) => {
    const a = segs[i].d, b = sg.d;
    const turn = Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
    return flip ? turn : -turn; // material right of travel: a right (CW) turn folds toward it (valley)
  });
  for (const a of angles) if (Math.abs(a) > Math.PI * 0.999) throw new Error("a contour corner can't turn back on itself (180°)");
  const setback = angles.map((a) => (a > 0 ? r + t : r) * Math.tan(Math.abs(a) / 2));
  const BA = angles.map((a) => bendAllowance(a, r, s));
  const straight = segs.map((sg, i) => sg.L - (i > 0 ? setback[i - 1] : 0) - (i < angles.length ? setback[i] : 0));
  straight.forEach((L, i) => { if (L < -1e-9) throw new Error(`line ${lineIds[i]} is too short for its bends (${segs[i].L.toFixed(2)} mm, needs ${(segs[i].L - L).toFixed(2)})`); });
  const y0 = flip ? -width : 0, y1 = y0 + width;
  const folds: SheetFold[] = [], edges: SheetEdge[] = [];
  let x = 0;
  straight.forEach((L, i) => {
    edges.push({ name: `${lineIds[i]}:side1`, a: { x, y: y0 }, b: { x: x + L, y: y0 }, out: { x: 0, y: -1 } });
    edges.push({ name: `${lineIds[i]}:side2`, a: { x, y: y1 }, b: { x: x + L, y: y1 }, out: { x: 0, y: 1 } });
    x += Math.max(0, L);
    if (i < angles.length) {
      const c = x + BA[i] / 2;
      folds.push({ id: `${featureId}:${lineIds[i]}`, a: { x: c, y: y0 }, b: { x: c, y: y1 }, angle: angles[i], direction: angles[i] < 0 ? -1 : 1, radius: r });
      x += BA[i];
    }
  });
  const X = x;
  edges.push({ name: `${featureId}:start`, a: { x: 0, y: y0 }, b: { x: 0, y: y1 }, out: { x: -1, y: 0 } });
  edges.push({ name: `${featureId}:end`, a: { x: X, y: y0 }, b: { x: X, y: y1 }, out: { x: 1, y: 0 } });
  const corners = [{ x: 0, y: y0 }, { x: X, y: y0 }, { x: X, y: y1 }, { x: 0, y: y1 }];
  const outer = { start: corners[0], segments: [...corners.slice(1), corners[0]].map((to) => ({ kind: "line" as const, to })), area: X * width };
  return { regions: [{ outer, holes: [] }], folds, edges, fixed: { x: Math.max(1e-3, straight[0] / 2), y: y0 + width / 2 }, y0, startDir: unit(segs[0].d) };
}

/** Two folds a jog apart: the material past `line` (on its left, or right
 *  with `flip`) steps by `offset` (toward the top for positive) and carries
 *  on parallel. `angle` is how steep the step is. */
export function jogFolds(a: Pt, b: Pt, offset: number, angle: number, radius: number, flip: boolean, s: Pick<SheetState, "thickness" | "kFactor">, id: string): SheetFold[] {
  const th = Math.abs(angle);
  if (!(th > 1e-6 && th <= Math.PI / 2 + 1e-9)) throw new Error("a jog angle is between 0° and 90°");
  const h = Math.abs(offset), t = s.thickness;
  const m = (h - (2 * radius + t) * (1 - Math.cos(th))) / Math.sin(th);
  if (m < -1e-9) throw new Error(`the jog offset is too small for its bends (needs at least ${((2 * radius + t) * (1 - Math.cos(th))).toFixed(2)} mm)`);
  const BA = bendAllowance(th, radius, s);
  const e = unit(sub(b, a)), n = mul(left(e), flip ? -1 : 1);
  const D = BA + Math.max(0, m); // centre to centre: half of each bend plus the straight between
  const sign = offset < 0 ? -1 : 1;
  // valley then mountain lifts the side past the second fold (folds are side-symmetric, so flip only moves that fold)
  const first = sign * th;
  return [
    { id: `${id}:1`, a, b, angle: first, direction: first < 0 ? -1 : 1, radius, extend: true },
    { id: `${id}:2`, a: add(a, mul(n, D)), b: add(b, mul(n, D)), angle: -first, direction: first < 0 ? 1 : -1, radius, extend: true },
  ];
}

/** Corner reliefs: where two flanges' zones overlap (set-back flanges meeting
 *  at a corner), cut away the overlap and each flange's end inside the other's
 *  setback — an open corner, so the walls clear each other. */
export function cornerReliefs(folds: SheetFold[]): BlankOp[] {
  const zoned = folds.filter((f) => f.zone);
  const out: BlankOp[] = [];
  const cut = (poly: Pt[]) => { if (poly.length >= 3 && Math.abs(polygonArea(poly)) > 1e-6) out.push({ op: "cut", poly }); };
  for (let i = 0; i < zoned.length; i++) for (let j = i + 1; j < zoned.length; j++) {
    const A = zoned[i], B = zoned[j];
    const o = clipConvex(A.zone!, B.zone!);
    if (o.length < 3 || Math.abs(polygonArea(o)) <= 1e-6) continue;
    cut(o);
    if (B.setbackBand) cut(clipConvex(A.zone!, B.setbackBand));
    if (A.setbackBand) cut(clipConvex(B.zone!, A.setbackBand));
  }
  return out;
}

// ---- the fold graph and its kinematics -----------------------------------------

/** One fold as the planner sees it: its line, the half-width of its bend zone, its angle. */
interface FoldGeo { id: string; O: Pt; e: Pt; d: Pt; length: number; half: number; angle: number; radius: number; free: boolean; direction: 1 | -1 }

export interface FoldLink {
  fold: number;
  /** Panels on the fold's −d (minus) and +d (plus) side. */
  minus: number;
  plus: number;
  /** Bend piece between them (bends), or −1 (creases). */
  piece: number;
  /** Where along the fold line (from its first point) the link runs. */
  s0: number;
  s1: number;
}

export interface FoldPlan {
  /** Flat → folded placement of each panel (local sheet coords). */
  panelT: Rigid[];
  /** Fold angles used, per fold (radians; solved ones filled in). */
  angles: number[];
  links: FoldLink[];
  /** Per fold: line origin, direction, normal (+d side), bend zone half-width. */
  geo: { O: Pt; e: Pt; d: Pt; half: number }[];
  /** Panel the sheet is held by. */
  root: number;
  warnings: string[];
}

const TOL = 1e-4;

/**
 * Plan a fold: link panels across folds, hold the panel at `s.fixed`, place
 * every other one by composing fold motions out from it, and check (or, for
 * creases without an angle, solve) that every loop of panels closes up.
 * `panels` / `pieces` are outlines in the flat; `folds` are the folds in play
 * (those with a zero angle are left out by the caller).
 */
export function planFold(s: SheetState, folds: SheetFold[], panels: Seg[][], pieces: { fold: number; segs: Seg[] }[]): FoldPlan {
  const t = s.thickness;
  const driven = folds.filter((f) => f.angle != null).map((f) => Math.abs(f.angle!));
  const guess = driven.length ? driven.reduce((a, b) => a + b, 0) / driven.length : NaN;
  const geo: FoldGeo[] = folds.map((f) => {
    const e = unit(sub(f.b, f.a));
    const free = f.angle == null;
    if (free && f.radius > 0) throw new Error(`bend "${f.id}" needs an angle (only sharp creases are solved)`);
    if (free && !Number.isFinite(guess)) throw new Error("give at least one fold an angle — the others are solved from it");
    const angle = free ? f.direction * guess : f.angle!;
    return { id: f.id, O: f.a, e, d: left(e), length: len(sub(f.b, f.a)), half: bendAllowance(angle, f.radius, s) / 2, angle, radius: f.radius, free, direction: f.direction };
  });
  const scale = Math.max(1, ...panels.flat(2).map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))));

  // contacts: stretches of panel / piece outline lying along a fold's zone boundary
  type Contact = { who: number; s0: number; s1: number };
  const contacts = (segs: Seg[], g: FoldGeo, u: number): { s0: number; s1: number }[] => {
    const out: { s0: number; s1: number }[] = [];
    for (const [a, b] of segs) {
      const ua = dot(sub(a, g.O), g.d), ub = dot(sub(b, g.O), g.d);
      if (Math.abs(ua - u) > TOL || Math.abs(ub - u) > TOL) continue;
      const sa = dot(sub(a, g.O), g.e), sb = dot(sub(b, g.O), g.e);
      if (Math.abs(sa - sb) < 1e-9) continue;
      out.push({ s0: Math.min(sa, sb), s1: Math.max(sa, sb) });
    }
    return out;
  };
  const overlap = (a: { s0: number; s1: number }, b: { s0: number; s1: number }) => Math.min(a.s1, b.s1) - Math.max(a.s0, b.s0);
  const links: FoldLink[] = [];
  geo.forEach((g, fi) => {
    const minus: Contact[] = [], plus: Contact[] = [];
    if (g.half > 0) {
      panels.forEach((segs, p) => {
        for (const c of contacts(segs, g, -g.half)) minus.push({ who: p, ...c });
        for (const c of contacts(segs, g, g.half)) plus.push({ who: p, ...c });
      });
      const mine = pieces.map((pc, k) => ({ pc, k })).filter((x) => x.pc.fold === fi);
      if (!mine.length) throw new Error(`bend "${g.id}" doesn't cross the sheet`);
      for (const { pc, k } of mine) {
        const best = (side: Contact[], u: number) => {
          let pick: { who: number; ov: number } | undefined;
          for (const r of contacts(pc.segs, g, u)) for (const c of side) { const ov = overlap(r, c); if (ov > TOL && (!pick || ov > pick.ov)) pick = { who: c.who, ov }; }
          return pick?.who;
        };
        const mi = best(minus, -g.half), pl = best(plus, g.half);
        if (mi == null || pl == null) throw new Error(`bend "${g.id}" doesn't join two panels — its line must run across the sheet, edge to edge`);
        const range = contacts(pc.segs, g, -g.half).concat(contacts(pc.segs, g, g.half));
        links.push({ fold: fi, minus: mi, plus: pl, piece: k, s0: Math.min(...range.map((r) => r.s0)), s1: Math.max(...range.map((r) => r.s1)) });
      }
    } else {
      panels.forEach((segs, p) => {
        for (const c of contacts(segs, g, 0)) {
          if (c.s1 < -TOL || c.s0 > g.length + TOL) continue;
          const mid = add(g.O, mul(g.e, (c.s0 + c.s1) / 2)), probe = Math.min(1e-3, (c.s1 - c.s0) / 4);
          const onPlus = insideSegs(add(mid, mul(g.d, probe)), segs), onMinus = insideSegs(sub(mid, mul(g.d, probe)), segs);
          if (onPlus && onMinus) throw new Error(`crease "${g.id}" stops inside the paper — it must end at the edge or at another crease`);
          (onPlus ? plus : minus).push({ who: p, ...c });
        }
      });
      for (const m of minus) for (const p of plus) {
        const ov = overlap(m, p);
        if (ov > TOL) links.push({ fold: fi, minus: m.who, plus: p.who, piece: -1, s0: Math.max(m.s0, p.s0), s1: Math.min(m.s1, p.s1) });
      }
      if (!links.some((l) => l.fold === fi)) throw new Error(`crease "${g.id}" doesn't separate the paper — it must run edge to edge or meet other creases`);
    }
  });

  // hold the panel under `fixed`; a spanning tree of links places the rest
  let root = panels.findIndex((segs) => insideSegs(s.fixed, segs));
  if (root < 0) root = 0;
  const order: { link: number; from: number; to: number }[] = [];
  const seen = new Set([root]);
  const tree = new Set<number>();
  for (let grew = true; grew;) {
    grew = false;
    links.forEach((l, i) => {
      if (tree.has(i)) return;
      const a = seen.has(l.minus), b = seen.has(l.plus);
      if (a === b) return;
      order.push({ link: i, from: a ? l.minus : l.plus, to: a ? l.plus : l.minus });
      seen.add(a ? l.plus : l.minus);
      tree.add(i);
      grew = true;
    });
  }
  if (seen.size < panels.length) {
    const lost = panels.findIndex((_, i) => !seen.has(i));
    const p = panels[lost][0]?.[0] ?? { x: 0, y: 0 };
    throw new Error(`part of the sheet near (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) isn't attached to the rest`);
  }
  const loops = links.map((_, i) => i).filter((i) => !tree.has(i));

  // motion of the plus side relative to the minus side, about the fold's axis
  const motion = (g: FoldGeo, angle: number): Rigid => {
    const axis = { x: g.e.x, y: g.e.y, z: 0 };
    const at = (p: Pt, z: number) => ({ x: p.x, y: p.y, z });
    if (g.half > 0) {
      // the bend starts at u = −half; its axis sits r off the inside face
      const hz = angle > 0 ? t + g.radius : -g.radius;
      const A = at(add(g.O, mul(g.d, -g.half)), hz);
      const R = rotationAbout(axis, angle, A);
      return compose(R, translation({ x: -2 * g.half * g.d.x, y: -2 * g.half * g.d.y, z: 0 }));
    }
    // a crease hinges on its inside face (the wedge outside it is filled in)
    return rotationAbout(axis, angle, at(g.O, angle > 0 ? t : 0));
  };
  const place = (angles: number[]): Rigid[] => {
    const T: Rigid[] = panels.map(() => IDENTITY);
    for (const o of order) {
      const l = links[o.link], M = motion(geo[l.fold], angles[l.fold]);
      T[o.to] = o.from === l.minus ? compose(T[o.from], M) : compose(T[o.from], invert(M));
    }
    return T;
  };
  const residual = (angles: number[]): number[] => {
    const T = place(angles), r: number[] = [];
    for (const i of loops) {
      const l = links[i];
      const D = compose(invert(T[l.plus]), compose(T[l.minus], motion(geo[l.fold], angles[l.fold])));
      r.push((D.x.x - 1) * scale, D.x.y * scale, D.x.z * scale, D.y.x * scale, (D.y.y - 1) * scale, D.y.z * scale, D.origin.x, D.origin.y, D.origin.z);
    }
    return r;
  };
  const norm = (v: number[]) => Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  const angles = geo.map((g) => g.angle);
  const free = geo.map((g, i) => (g.free ? i : -1)).filter((i) => i >= 0);
  const warnings: string[] = [];
  const closeTol = 1e-6 * scale;
  if (free.length && loops.length) solveFree(angles, free, residual);
  const r = residual(angles);
  if (norm(r) > Math.max(closeTol, 1e-7)) {
    // name the loop that fails worst
    let worst = 0, wi = 0;
    loops.forEach((li, k) => { const v = norm(r.slice(9 * k, 9 * k + 9)); if (v > worst) { worst = v; wi = li; } });
    // the loop closes round a vertex: the end of the failing link where most folds meet
    const l = links[wi], g = geo[l.fold];
    const ends = [add(g.O, mul(g.e, l.s0)), add(g.O, mul(g.e, l.s1))];
    const meeting = (q: Pt) => folds.filter((f) => len(sub(f.a, q)) < 1e-6 || len(sub(f.b, q)) < 1e-6).length;
    const p = meeting(ends[1]) > meeting(ends[0]) ? ends[1] : ends[0];
    throw new Error(`the folds around (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) don't close up — those angles can't all be folded at once (it isn't rigidly foldable there); leave some creases' angles out to have them solved`);
  }
  for (const i of free) {
    if (Math.sign(angles[i]) !== geo[i].direction && Math.abs(angles[i]) > 1e-6) warnings.push(`crease "${geo[i].id}" solved to fold the other way (${((angles[i] * 180) / Math.PI).toFixed(1)}°)`);
  }
  return { panelT: place(angles), angles, links, geo: geo.map((g) => ({ O: g.O, e: g.e, d: g.d, half: g.half })), root, warnings };
}

/** Damped least squares (Levenberg–Marquardt) on the free angles, in place. */
function solveFree(angles: number[], free: number[], residual: (a: number[]) => number[]) {
  const cost = (a: number[]) => residual(a).reduce((s, v) => s + v * v, 0);
  let c = cost(angles), lambda = 1e-3;
  for (let it = 0; it < 200 && c > 1e-24; it++) {
    const r0 = residual(angles);
    const J = free.map((i) => {
      const h = 1e-7, a = angles.slice();
      a[i] += h;
      const r1 = residual(a);
      return r1.map((v, k) => (v - r0[k]) / h);
    }); // J[j][k] = ∂r_k/∂x_j
    const n = free.length;
    const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => J[i].reduce((s, v, k) => s + v * J[j][k], 0)));
    const g = J.map((row) => row.reduce((s, v, k) => s + v * r0[k], 0));
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const M = A.map((row, i) => row.map((v, j) => v + (i === j ? lambda * (A[i][i] + 1e-9) : 0)));
      const step = solveLinear(M, g.map((v) => -v));
      if (!step) { lambda *= 10; continue; }
      const next = angles.slice();
      free.forEach((i, j) => { next[i] += step[j]; });
      const c1 = cost(next);
      if (c1 < c) { for (const i of free) angles[i] = next[i]; c = c1; lambda = Math.max(1e-12, lambda / 3); improved = true; break; }
      lambda *= 4;
    }
    if (!improved) break;
  }
}

function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      if (k) for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

// ---- mapping onto the folded sheet ------------------------------------------------

/** Where a world point sits on the folded sheet: the panel it lies on (top or bottom face) and its flat position. */
export function flatPointOf(s: SheetState, p: { x: number; y: number; z: number }, tol = 1e-3): { panel: number; flat: Pt } | undefined {
  for (const [i, pn] of (s.panels ?? []).entries()) {
    const q = applyInverse(compose(s.frame, pn.T), p);
    if (Math.abs(q.z) > tol && Math.abs(q.z - s.thickness) > tol) continue;
    const f = { x: q.x, y: q.y };
    if (insideSegs(f, pn.segs) || pn.segs.some(([a, b]) => distToSeg(f, a, b) < tol)) return { panel: i, flat: f };
  }
  return undefined;
}

const applyInverse = (T: Rigid, p: { x: number; y: number; z: number }) => {
  const d = { x: p.x - T.origin.x, y: p.y - T.origin.y, z: p.z - T.origin.z };
  return { x: d.x * T.x.x + d.y * T.x.y + d.z * T.x.z, y: d.x * T.y.x + d.y * T.y.y + d.z * T.y.z, z: d.x * T.z.x + d.y * T.z.y + d.z * T.z.z };
};

function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const ab = sub(b, a), L2 = dot(ab, ab);
  const k = L2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / L2)) : 0;
  return len(sub(p, add(a, mul(ab, k))));
}

/** The chord of the line through a→b across a panel outline: the stretch containing the midpoint of a→b. */
export function chordAcross(a: Pt, b: Pt, segs: Seg[]): [Pt, Pt] {
  const e = unit(sub(b, a)), n = left(e), mid = mul(add(a, b), 0.5);
  const hits: number[] = [];
  for (const [p, q] of segs) {
    const up = dot(sub(p, mid), n), uq = dot(sub(q, mid), n);
    if ((up > 0) === (uq > 0) || up === uq) continue;
    const k = up / (up - uq);
    hits.push(dot(sub(add(p, mul(sub(q, p), k)), mid), e));
  }
  const lo = Math.max(...hits.filter((h) => h <= 1e-9), -Infinity), hi = Math.min(...hits.filter((h) => h >= -1e-9), Infinity);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [a, b];
  return [add(mid, mul(e, lo)), add(mid, mul(e, hi))];
}

// ---- flat pattern ---------------------------------------------------------------------

/** A piece of the blank's outline: a line, a circular arc (CCW from a0 to a1, radians), a full circle, or a polyline. */
export type OutlineItem =
  | { kind: "line"; a: Pt; b: Pt }
  | { kind: "arc"; c: Pt; r: number; a0: number; a1: number }
  | { kind: "circle"; c: Pt; r: number }
  | { kind: "poly"; pts: Pt[] };

export interface FlatFoldLine {
  id: string;
  /** Centre line (where it crosses the blank). */
  a: Pt;
  b: Pt;
  /** Degrees: + up (valley seen from the top), − down. */
  angle: number;
  radius: number;
  /** Bend allowance (0 for a crease). */
  allowance: number;
}

export interface FlatPattern {
  outline: OutlineItem[];
  folds: FlatFoldLine[];
  min: Pt;
  max: Pt;
  thickness: number;
  kFactor: number;
}

/** An edge sampled by the kernel (its OCC type and points along it) as an outline item. */
export function outlineItem(type: string, pts: Pt[]): OutlineItem {
  if (type === "LINE" && pts.length >= 2) return { kind: "line", a: pts[0], b: pts[pts.length - 1] };
  if (type === "CIRCLE" && pts.length >= 3) {
    const p = pts[0], q = pts[Math.floor(pts.length / 2)], z = pts[pts.length - 1];
    const closed = len(sub(p, z)) < 1e-7;
    const c = circumcentre(p, q, closed ? pts[Math.floor(pts.length / 4)] : z);
    if (c) {
      const r = len(sub(p, c));
      if (closed) return { kind: "circle", c, r };
      const ang = (w: Pt) => Math.atan2(w.y - c.y, w.x - c.x);
      // CCW from the start through the middle?
      const a0 = ang(p), am = ang(q), a1 = ang(z);
      const ccwSpan = (from: number, to: number) => { let d = to - from; while (d < 0) d += 2 * Math.PI; return d; };
      return ccwSpan(a0, am) < ccwSpan(a0, a1) ? { kind: "arc", c, r, a0, a1 } : { kind: "arc", c, r, a0: a1, a1: a0 };
    }
  }
  return { kind: "poly", pts };
}

function circumcentre(a: Pt, b: Pt, c: Pt): Pt | undefined {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return undefined;
  const a2 = dot(a, a), b2 = dot(b, b), c2 = dot(c, c);
  return { x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d };
}

const outlinePoints = (o: OutlineItem): Pt[] => {
  if (o.kind === "line") return [o.a, o.b];
  if (o.kind === "poly") return o.pts;
  const a0 = o.kind === "arc" ? o.a0 : 0;
  let a1 = o.kind === "arc" ? o.a1 : 2 * Math.PI;
  while (a1 <= a0) a1 += 2 * Math.PI;
  return Array.from({ length: 33 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / 32; return { x: o.c.x + o.r * Math.cos(a), y: o.c.y + o.r * Math.sin(a) }; });
};

export function flatBounds(outline: OutlineItem[]): { min: Pt; max: Pt } {
  const pts = outline.flatMap(outlinePoints);
  if (!pts.length) return { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
  return { min: { x: Math.min(...pts.map((p) => p.x)), y: Math.min(...pts.map((p) => p.y)) }, max: { x: Math.max(...pts.map((p) => p.x)), y: Math.max(...pts.map((p) => p.y)) } };
}

const fmt = (v: number) => (Math.abs(v) < 5e-7 ? "0" : String(Math.round(v * 1e6) / 1e6));

/** The flat pattern as SVG (mm; y up): cut lines black, valley folds dashed blue, mountain folds dash-dotted red. */
export function flatPatternSvg(fp: FlatPattern): string {
  const m = 5, w = fp.max.x - fp.min.x + 2 * m, h = fp.max.y - fp.min.y + 2 * m;
  const X = (x: number) => fmt(x - fp.min.x + m), Y = (y: number) => fmt(fp.max.y - y + m);
  const path = (pts: Pt[]) => `M${pts.map((p) => `${X(p.x)} ${Y(p.y)}`).join(" L")}`;
  const cut = fp.outline.map((o) => {
    if (o.kind === "circle") return `<circle cx="${X(o.c.x)}" cy="${Y(o.c.y)}" r="${fmt(o.r)}"/>`;
    if (o.kind === "arc") {
      let sweep = o.a1 - o.a0; while (sweep <= 0) sweep += 2 * Math.PI;
      const s = { x: o.c.x + o.r * Math.cos(o.a0), y: o.c.y + o.r * Math.sin(o.a0) }, e = { x: o.c.x + o.r * Math.cos(o.a1), y: o.c.y + o.r * Math.sin(o.a1) };
      // CCW in model space is clockwise once y is flipped: sweep flag 0
      return `<path d="M${X(s.x)} ${Y(s.y)} A${fmt(o.r)} ${fmt(o.r)} 0 ${sweep > Math.PI ? 1 : 0} 0 ${X(e.x)} ${Y(e.y)}"/>`;
    }
    return `<path d="${path(outlinePoints(o))}"/>`;
  });
  const folds = fp.folds.map((f) => {
    const valley = f.angle > 0;
    return `<line class="${valley ? "valley" : "mountain"}" x1="${X(f.a.x)}" y1="${Y(f.a.y)}" x2="${X(f.b.x)}" y2="${Y(f.b.y)}"><title>${f.id}: ${valley ? "up" : "down"} ${Math.abs(f.angle).toFixed(1)}°${f.radius > 0 ? ` R${fmt(f.radius)}` : ""}</title></line>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}mm" height="${fmt(h)}mm" viewBox="0 0 ${fmt(w)} ${fmt(h)}">`,
    `<style>.cut{fill:none;stroke:#000;stroke-width:0.2}.valley{stroke:#1f5fd6;stroke-width:0.2;stroke-dasharray:3 1.5}.mountain{stroke:#d62f1f;stroke-width:0.2;stroke-dasharray:4 1 0.6 1}</style>`,
    `<g class="cut">${cut.join("")}</g>`,
    `<g>${folds.join("")}</g>`,
    `</svg>`,
  ].join("\n");
}

/** The flat pattern as DXF (R12, mm): layer CUT for the outline, BEND_UP / BEND_DOWN for fold lines. */
export function flatPatternDxf(fp: FlatPattern): string {
  const out: string[] = [];
  const g = (code: number, v: string | number) => out.push(String(code), typeof v === "number" ? fmt(v) : v);
  g(0, "SECTION"); g(2, "HEADER"); g(9, "$ACADVER"); g(1, "AC1009"); g(9, "$EXTMIN"); g(10, fp.min.x); g(20, fp.min.y); g(9, "$EXTMAX"); g(10, fp.max.x); g(20, fp.max.y); g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "TABLES"); g(0, "TABLE"); g(2, "LAYER"); g(70, 3);
  for (const [name, color] of [["CUT", 7], ["BEND_UP", 5], ["BEND_DOWN", 1]] as const) { g(0, "LAYER"); g(2, name); g(70, 0); g(62, color); g(6, "CONTINUOUS"); }
  g(0, "ENDTAB"); g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "ENTITIES");
  const line = (layer: string, a: Pt, b: Pt) => { g(0, "LINE"); g(8, layer); g(10, a.x); g(20, a.y); g(30, 0); g(11, b.x); g(21, b.y); g(31, 0); };
  for (const o of fp.outline) {
    if (o.kind === "line") line("CUT", o.a, o.b);
    else if (o.kind === "circle") { g(0, "CIRCLE"); g(8, "CUT"); g(10, o.c.x); g(20, o.c.y); g(30, 0); g(40, o.r); }
    else if (o.kind === "arc") { g(0, "ARC"); g(8, "CUT"); g(10, o.c.x); g(20, o.c.y); g(30, 0); g(40, o.r); g(50, (o.a0 * 180) / Math.PI); g(51, (o.a1 * 180) / Math.PI); }
    else for (let i = 0; i + 1 < o.pts.length; i++) line("CUT", o.pts[i], o.pts[i + 1]);
  }
  for (const f of fp.folds) line(f.angle > 0 ? "BEND_UP" : "BEND_DOWN", f.a, f.b);
  g(0, "ENDSEC"); g(0, "EOF");
  return out.join("\n") + "\n";
}

/** What a sheet body reports (its evaluation row): rules, solved fold angles (degrees), blank edges, flat pattern. */
export interface SheetRow {
  thickness: number;
  kFactor: number;
  unfolded: boolean;
  /** Changed by another feature while folded: the flat pattern no longer matches. */
  stale?: boolean;
  angles: Record<string, number>;
  edges: string[];
  flat: FlatPattern;
}

/** A sheet's flat pattern in brief (for agents): size, folds, edges. */
export function sheetSummary(body: string, name: string, s: SheetRow) {
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return {
    body, name, thickness: s.thickness, kFactor: s.kFactor, unfolded: s.unfolded, ...(s.stale ? { stale: true } : {}),
    flatSize: { x: r(s.flat.max.x - s.flat.min.x), y: r(s.flat.max.y - s.flat.min.y) },
    folds: s.flat.folds.map((f) => ({ id: f.id, angle: r(f.angle), radius: r(f.radius), allowance: r(f.allowance), kind: f.radius > 0 ? "bend" : "crease", direction: f.angle > 0 ? "up (valley)" : "down (mountain)" })),
    edges: s.edges,
  };
}
