// The geometry of a shop drawing's annotations, in two dimensions and free of the
// kernel: what a placed dimension measures in a view and where its lines go, the
// cross-hatching of a section's cut faces, a detail's clipping circle, and the
// SVG for each (arrows, extension lines and text at a standard size).
//
// Coordinates come in two kinds. View coordinates are model mm in a view's plane
// (u right, v up), what the document stores. Paper coordinates are the sheet's
// SVG units (y down); a view maps one to the other by a scale and an origin, and
// every size here that is not geometry (arrow, gap, text) is in paper units, so a
// dimension reads the same at any scale.

import type { DimensionKind, DrawingRef, ViewPoint } from "./document";
import type { Vec3 } from "../math/vec";

export type P2 = [number, number];
export type Seg = [P2, P2];

/** What a ref is in a view: a point (a vertex, or an edge seen end-on), a straight segment, or a curve
 *  (a circle or an arc carries its centre, its true radius, and whether it is seen square on). */
export type Feature2 =
  | { kind: "point"; p: P2 }
  | { kind: "segment"; a: P2; b: P2 }
  | { kind: "curve"; pts: P2[]; circle?: { c: P2; r: number; faceOn: boolean } };

/** A view's projection: world points onto (u, v), looking along `d` (into the paper). */
export interface ViewFrame { u: Vec3; v: Vec3; d: Vec3 }

const dot3 = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const scale3 = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const unit3 = (a: Vec3): Vec3 => scale3(a, 1 / (Math.hypot(a.x, a.y, a.z) || 1));

/** Third-angle: the front view looks along +Y (x right, z up), the top down −Z (x right, y up), the right view
 *  along −X (y right, z up). */
export const ORTHO_FRAMES: Record<"front" | "top" | "right", ViewFrame> = {
  front: { u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 }, d: { x: 0, y: 1, z: 0 } },
  top: { u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, d: { x: 0, y: 0, z: -1 } },
  right: { u: { x: 0, y: 1, z: 0 }, v: { x: 0, y: 0, z: 1 }, d: { x: -1, y: 0, z: 0 } },
};

export const projectTo = (f: ViewFrame, p: Vec3): P2 => [dot3(p, f.u), dot3(p, f.v)];

/** A section's cutting plane and the frame it is seen in. Unflipped it looks to the left of the line from
 *  `from` to `to` on the base view (`d`: the way it looks, the plane's normal). Up is the world's up when that
 *  lies in the plane (a cut down through a plan reads as an elevation), else the base view's up, else its
 *  depth (a level cut across the front view looks down on the model like the top view). */
export function sectionFrame(base: ViewFrame, from: ViewPoint, to: ViewPoint, flip = false): { origin: Vec3; frame: ViewFrame } {
  const L = Math.hypot(to.u - from.u, to.v - from.v) || 1;
  const t = unit3({ x: base.u.x * (to.u - from.u) / L + base.v.x * (to.v - from.v) / L, y: base.u.y * (to.u - from.u) / L + base.v.y * (to.v - from.v) / L, z: base.u.z * (to.u - from.u) / L + base.v.z * (to.v - from.v) / L });
  let d = unit3(cross3(t, base.d));
  if (flip) d = scale3(d, -1);
  const inPlane = (w: Vec3): Vec3 => ({ x: w.x - d.x * dot3(w, d), y: w.y - d.y * dot3(w, d), z: w.z - d.z * dot3(w, d) });
  const big = (w: Vec3) => Math.hypot(w.x, w.y, w.z) > 0.5;
  const up = unit3([inPlane({ x: 0, y: 0, z: 1 }), inPlane(base.v)].find(big) ?? inPlane(base.d));
  const right = unit3(cross3(d, up));
  const origin = { x: base.u.x * from.u + base.v.x * from.v, y: base.u.y * from.u + base.v.y * from.v, z: base.u.z * from.u + base.v.z * from.v };
  return { origin, frame: { u: right, v: up, d } };
}

/** An edge as a view sees it. A straight edge seen end-on is a point. */
export function edgeFeature(f: ViewFrame, e: { type: string; pts: Vec3[]; circle?: { center: Vec3; radius: number; normal: Vec3 } }): Feature2 {
  if (e.type === "line") {
    const a = projectTo(f, e.pts[0]), b = projectTo(f, e.pts[e.pts.length - 1]);
    return Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6 ? { kind: "point", p: a } : { kind: "segment", a, b };
  }
  const pts = e.pts.map((p) => projectTo(f, p));
  return e.circle ? { kind: "curve", pts, circle: { c: projectTo(f, e.circle.center), r: e.circle.radius, faceOn: Math.abs(dot3(unit3(e.circle.normal), f.d)) > 0.999 } } : { kind: "curve", pts };
}

export const refKey = (r: DrawingRef) => ("edge" in r ? `${r.body}/e/${r.edge}` : `${r.body}/v/${r.vertex}`);

// ---- measuring ----------------------------------------------------------------

/** A dimension's geometry in view coordinates, or why it can't be drawn. */
export type DimGeom =
  | { kind: "linear"; value: number; feet: [P2, P2]; ends: [P2, P2] }
  | { kind: "radius" | "diameter"; value: number; c: P2; tip: P2; tip2?: P2; at: P2 }
  | { kind: "angle"; value: number; vertex: P2; a: P2; b: P2; R: number; spans: [[number, number], [number, number]] };

export type Measured = { ok: true; geom: DimGeom } | { ok: false; reason: string; at?: P2 };

const sub2 = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const add2 = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
const mul2 = (a: P2, s: number): P2 => [a[0] * s, a[1] * s];
const dot2 = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
const cross2 = (a: P2, b: P2) => a[0] * b[1] - a[1] * b[0];
const len2 = (a: P2) => Math.hypot(a[0], a[1]);
const norm2 = (a: P2): P2 => { const l = len2(a) || 1; return [a[0] / l, a[1] / l]; };
const mid2 = (a: P2, b: P2): P2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** Where a feature sits, for a linear dimension: a circle at its centre; a freeform curve has no place. */
function linearPart(f: Feature2): { kind: "point"; p: P2 } | { kind: "segment"; a: P2; b: P2 } | undefined {
  if (f.kind !== "curve") return f;
  return f.circle ? { kind: "point", p: f.circle.c } : undefined;
}
const centreOf = (f: { kind: "point"; p: P2 } | { kind: "segment"; a: P2; b: P2 }): P2 => (f.kind === "point" ? f.p : mid2(f.a, f.b));

/** The point a dimension's offset is measured from: the midpoint between the two features, the circle's centre,
 *  or where the angle's two edges meet. Undefined when the features can't make that dimension. */
export function dimensionAnchor(kind: DimensionKind, fs: Feature2[]): P2 | undefined {
  if (kind === "radius" || kind === "diameter") return fs[0]?.kind === "curve" ? fs[0].circle?.c : undefined;
  if (kind === "angle") {
    if (fs.length < 2 || fs[0].kind !== "segment" || fs[1].kind !== "segment") return undefined;
    return lineMeet(fs[0].a, fs[0].b, fs[1].a, fs[1].b);
  }
  const a = fs[0] && linearPart(fs[0]), b = fs[1] && linearPart(fs[1]);
  return a && b ? mid2(centreOf(a), centreOf(b)) : undefined;
}

function lineMeet(a1: P2, b1: P2, a2: P2, b2: P2): P2 | undefined {
  const d1 = sub2(b1, a1), d2 = sub2(b2, a2), den = cross2(d1, d2);
  if (Math.abs(den) < 1e-9 * len2(d1) * len2(d2)) return undefined;
  const t = cross2(sub2(a2, a1), d2) / den;
  return add2(a1, mul2(d1, t));
}

/** The first point where a ray from `c` along `dir` crosses a polyline (its farthest point when it misses). */
function rayHit(c: P2, dir: P2, pts: P2[]): P2 {
  let best: { t: number; p: P2 } | undefined;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], e = sub2(pts[i + 1], a), den = cross2(dir, e);
    if (Math.abs(den) < 1e-12) continue;
    const w = sub2(a, c), t = cross2(w, e) / den, s = cross2(w, dir) / den;
    if (t > 1e-9 && s >= -1e-9 && s <= 1 + 1e-9 && (!best || t < best.t)) best = { t, p: add2(c, mul2(dir, t)) };
  }
  if (best) return best.p;
  let far = pts[0] ?? c;
  for (const p of pts) if (dot2(sub2(p, c), dir) > dot2(sub2(far, c), dir)) far = p;
  return far;
}

const ALONG_TOL = 1e-3;

/**
 * Measure a dimension in a view. `fs` are its refs as the view sees them; `size` is the view's extent (for the
 * automatic placement of one without an offset) and `centre` the middle of its geometry (an automatic linear
 * dimension goes on the side away from it).
 */
export function measureDimension(kind: DimensionKind, fs: Feature2[], offset: ViewPoint | undefined, size: number, centre: P2): Measured {
  if (kind === "radius" || kind === "diameter") {
    const f = fs[0];
    if (!f || f.kind !== "curve" || !f.circle) return { ok: false, reason: "not a circle or an arc" };
    const { c, r, faceOn } = f.circle;
    const off: P2 = offset ? [offset.u, offset.v] : mul2([Math.SQRT1_2, Math.SQRT1_2], r * 1.6 + size * 0.04);
    const dir = len2(off) > 1e-9 ? norm2(off) : ([1, 0] as P2);
    const tip = faceOn ? add2(c, mul2(dir, r)) : rayHit(c, dir, f.pts);
    const tip2 = kind === "diameter" ? (faceOn ? add2(c, mul2(dir, -r)) : rayHit(c, mul2(dir, -1), f.pts)) : undefined;
    return { ok: true, geom: { kind, value: kind === "radius" ? r : 2 * r, c, tip, ...(tip2 ? { tip2 } : {}), at: add2(c, off) } };
  }
  if (kind === "angle") {
    const [f1, f2] = fs;
    if (!f1 || !f2 || f1.kind !== "segment" || f2.kind !== "segment") return { ok: false, reason: "an angle is between two straight edges" };
    const V = lineMeet(f1.a, f1.b, f2.a, f2.b);
    if (!V) return { ok: false, reason: "the edges are parallel", at: mid2(mid2(f1.a, f1.b), mid2(f2.a, f2.b)) };
    const d1 = norm2(sub2(f1.b, f1.a)), d2 = norm2(sub2(f2.b, f2.a));
    // automatic: between the two edges, towards their middles
    const toward = (f: { a: P2; b: P2 }, d: P2): P2 => { const m = sub2(mid2(f.a, f.b), V); return len2(m) > 1e-9 ? norm2(m) : d; };
    let off: P2;
    if (offset) off = [offset.u, offset.v];
    else {
      const m1 = toward(f1, d1), m2 = toward(f2, d2), bis = add2(m1, m2);
      const reach = Math.min(...[f1, f2].map((f) => Math.max(len2(sub2(f.a, V)), len2(sub2(f.b, V)))));
      off = mul2(len2(bis) > 1e-9 ? norm2(bis) : m1, Math.max(reach * 0.6, size * 0.05));
    }
    const R = len2(off), w = R > 1e-9 ? norm2(off) : d1;
    const ang = (p: P2, q: P2) => Math.acos(Math.max(-1, Math.min(1, dot2(p, q))));
    let pick: { a: P2; b: P2; t: number } | undefined;
    for (const sa of [1, -1]) for (const sb of [1, -1]) {
      const a = mul2(d1, sa), b = mul2(d2, sb), t = ang(a, b);
      if (Math.abs(ang(a, w) + ang(w, b) - t) < 1e-6 && (!pick || t < pick.t)) pick = { a, b, t };
    }
    if (!pick) return { ok: false, reason: "could not place the angle" };
    const span = (f: { a: P2; b: P2 }, dir: P2): [number, number] => { const s = [dot2(sub2(f.a, V), dir), dot2(sub2(f.b, V), dir)]; return [Math.min(...s), Math.max(...s)]; };
    return { ok: true, geom: { kind: "angle", value: (pick.t * 180) / Math.PI, vertex: V, a: pick.a, b: pick.b, R: R || size * 0.05, spans: [span(f1, pick.a), span(f2, pick.b)] } };
  }
  // linear
  const p1 = fs[0] && linearPart(fs[0]), p2 = fs[1] && linearPart(fs[1]);
  if (!p1 || !p2) return { ok: false, reason: "a freeform curve has no position to measure from" };
  let m: P2;
  if (kind === "horizontal") m = [1, 0];
  else if (kind === "vertical") m = [0, 1];
  else {
    const seg = [p1, p2].find((f) => f.kind === "segment") as { a: P2; b: P2 } | undefined;
    if (seg) { const t = norm2(sub2(seg.b, seg.a)); m = [-t[1], t[0]]; }
    else {
      const d = sub2(centreOf(p2), centreOf(p1));
      if (len2(d) < 1e-9) return { ok: false, reason: "the two points coincide in this view", at: centreOf(p1) };
      m = norm2(d);
    }
  }
  for (const f of [p1, p2]) {
    if (f.kind === "segment" && Math.abs(dot2(norm2(sub2(f.b, f.a)), m)) > ALONG_TOL) {
      return { ok: false, reason: kind === "aligned" ? "the edges are not parallel" : `an edge is not square to the ${kind} measurement`, at: mid2(centreOf(p1), centreOf(p2)) };
    }
  }
  const n: P2 = [-m[1], m[0]];
  const anchor = mid2(centreOf(p1), centreOf(p2));
  let off: P2;
  if (offset) off = [offset.u, offset.v];
  else {
    // automatic: outside the two features, on the side away from the view's middle
    const side = Math.sign(dot2(sub2(anchor, centre), n)) || 1;
    const reach = Math.max(...[p1, p2].flatMap((f) => (f.kind === "point" ? [f.p] : [f.a, f.b])).map((p) => side * dot2(sub2(p, anchor), n)));
    off = mul2(n, side * (Math.max(0, reach) + size * 0.06));
  }
  const s = dot2(add2(anchor, off), n);
  const foot = (f: typeof p1): P2 => (f.kind === "point" ? f.p : Math.abs(dot2(f.a, n) - s) <= Math.abs(dot2(f.b, n) - s) ? f.a : f.b);
  const feet: [P2, P2] = [foot(p1), foot(p2)];
  const ends = feet.map((F) => add2(F, mul2(n, s - dot2(F, n)))) as [P2, P2];
  return { ok: true, geom: { kind: "linear", value: Math.abs(dot2(sub2(feet[1], feet[0]), m)), feet, ends } };
}

/** A dimension's text: "1700", "R12.5", "Ø32", "45°" (to 0.1). */
export function dimensionText(kind: DimensionKind, value: number, prefix = ""): string {
  const r = Math.round(value * 10) / 10;
  const n = Object.is(r, -0) ? "0" : String(r);
  return prefix + (kind === "radius" ? `R${n}` : kind === "diameter" ? `Ø${n}` : kind === "angle" ? `${n}°` : n);
}

// ---- hatching and clipping ------------------------------------------------------

/** Section hatch angles (degrees), part by part: the drafting 45° and 135° first, then 60°/120° and 30°/150°.
 *  The viewport's section caps use the same, so a part reads alike on screen and on paper. */
export const HATCH_ANGLES = [45, 135, 60, 120, 30, 150];

/** Hatch lines across a region: lines at `angleDeg` (counter-clockwise from +u), `spacing` apart, kept where
 *  they are inside the region by the even-odd rule. `boundary` is the region's outline as segments, in any
 *  order (closed loops: an outer boundary and its holes). */
export function hatchSegments(boundary: Seg[], angleDeg: number, spacing: number): Seg[] {
  if (!(spacing > 0) || !boundary.length) return [];
  const a = (angleDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  // rotate so the hatch lines run along x'
  const rot = ([x, y]: P2): P2 => [c * x + s * y, -s * x + c * y];
  const back = ([x, y]: P2): P2 => [c * x - s * y, s * x + c * y];
  const segs = boundary.map(([p, q]) => [rot(p), rot(q)] as Seg);
  let lo = Infinity, hi = -Infinity;
  for (const [p, q] of segs) { lo = Math.min(lo, p[1], q[1]); hi = Math.max(hi, p[1], q[1]); }
  const out: Seg[] = [];
  for (let k = Math.ceil(lo / spacing - 0.5); (k + 0.5) * spacing < hi; k++) {
    const y = (k + 0.5) * spacing;
    const xs: number[] = [];
    for (const [p, q] of segs) {
      if ((p[1] <= y && q[1] > y) || (q[1] <= y && p[1] > y)) xs.push(p[0] + ((y - p[1]) / (q[1] - p[1])) * (q[0] - p[0]));
    }
    xs.sort((u, v) => u - v);
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 1e-9) out.push([back([xs[i], y]), back([xs[i + 1], y])]);
  }
  return out;
}

/** The part of a segment inside a circle, or undefined. */
export function clipToCircle([p, q]: Seg, c: P2, r: number): Seg | undefined {
  const d = sub2(q, p), f = sub2(p, c);
  const A = dot2(d, d), B = 2 * dot2(f, d), C = dot2(f, f) - r * r;
  if (A < 1e-18) return C <= 0 ? [p, q] : undefined;
  const disc = B * B - 4 * A * C;
  if (disc <= 0) return undefined;
  const sq = Math.sqrt(disc);
  const t0 = Math.max(0, (-B - sq) / (2 * A)), t1 = Math.min(1, (-B + sq) / (2 * A));
  if (t1 - t0 <= 1e-12) return undefined;
  return [add2(p, mul2(d, t0)), add2(p, mul2(d, t1))];
}

// ---- SVG ---------------------------------------------------------------------------

/** Paper units per millimetre of an A4 landscape sheet 1120 units wide. */
export const PAPER_PER_MM = 1120 / 297;
/** Drafting sizes (paper units): text 3 mm high, arrowheads 3 mm long at 1:3, extension lines starting 1 mm
 *  off the geometry and running 2 mm past the dimension line. */
export const DIM = { text: 3 * PAPER_PER_MM, arrow: 3 * PAPER_PER_MM, gap: 1 * PAPER_PER_MM, over: 2 * PAPER_PER_MM, line: 0.35, color: "#1d3a8a", broken: "#c0158f" };

const f1 = (v: number) => Math.round(v * 10) / 10;
const pt = (p: P2) => `${f1(p[0])} ${f1(p[1])}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const textW = (s: string) => s.length * DIM.text * 0.58;

/** A filled arrowhead with its tip at `tip`, pointing along `dir` (paper). */
export function arrowSvg(tip: P2, dir: P2, color = DIM.color): string {
  const d = norm2(dir), w: P2 = [-d[1], d[0]], A = DIM.arrow, h = A / 6;
  const base = sub2(tip, mul2(d, A));
  return `<path d="M${pt(tip)} L${pt(add2(base, mul2(w, h)))} L${pt(add2(base, mul2(w, -h)))} Z" fill="${color}"/>`;
}
const lineSvg = (a: P2, b: P2, color = DIM.color, width = DIM.line) => `<line x1="${f1(a[0])}" y1="${f1(a[1])}" x2="${f1(b[0])}" y2="${f1(b[1])}" stroke="${color}" stroke-width="${width}"/>`;
function textSvg(at: P2, s: string, angle = 0, color = DIM.color, anchor = "middle"): string {
  const rot = Math.abs(angle) > 1e-6 ? ` transform="rotate(${f1(angle)} ${pt(at)})"` : "";
  return `<text x="${f1(at[0])}" y="${f1(at[1])}" font-size="${f1(DIM.text)}" fill="${color}" text-anchor="${anchor}"${rot}>${esc(s)}</text>`;
}

/** A linear dimension in paper coordinates: extension lines from the feet to the dimension line, the line with
 *  an arrow at each end (outside when there's no room between them), and the text above its middle (or past
 *  its end when it doesn't fit), reading from the bottom or the right. */
export function linearDimSvg(feet: [P2, P2], ends: [P2, P2], text: string, color = DIM.color): string {
  const out: string[] = [];
  for (let i = 0; i < 2; i++) {
    const v = sub2(ends[i], feet[i]), L = len2(v);
    if (L > DIM.gap) { const u = mul2(v, 1 / L); out.push(lineSvg(add2(feet[i], mul2(u, DIM.gap)), add2(ends[i], mul2(u, DIM.over)), color)); }
  }
  const [E1, E2] = ends, span = len2(sub2(E2, E1));
  const dir: P2 = span > 1e-9 ? norm2(sub2(E2, E1)) : [1, 0];
  const tw = textW(text);
  const inside = span >= 2 * DIM.arrow + 2;
  if (inside) {
    out.push(lineSvg(E1, E2, color), arrowSvg(E1, mul2(dir, -1), color), arrowSvg(E2, dir, color));
  } else {
    // arrows outside, pointing in, on short tails
    out.push(lineSvg(sub2(E1, mul2(dir, DIM.arrow * 2)), add2(E2, mul2(dir, DIM.arrow * 2)), color), arrowSvg(E1, dir, color), arrowSvg(E2, mul2(dir, -1), color));
  }
  let angle = (Math.atan2(dir[1], dir[0]) * 180) / Math.PI;
  if (angle >= 90 - 1e-6) angle -= 180;
  if (angle < -90 - 1e-6) angle += 180;
  const a = (angle * Math.PI) / 180;
  const up: P2 = [Math.sin(a), -Math.cos(a)], along: P2 = [Math.cos(a), Math.sin(a)];
  let at = add2(mid2(E1, E2), mul2(up, 2.5));
  if (tw + 2 * DIM.arrow + 4 > span) {
    // past the end of the line that comes later along the text
    const later = dot2(sub2(E2, E1), along) >= 0 ? E2 : E1;
    at = add2(add2(later, mul2(along, DIM.arrow * (inside ? 1 : 2) + 3 + tw / 2)), mul2(up, 2.5));
  }
  out.push(textSvg(at, text, angle, color));
  return out.join("");
}

/** A radius or diameter in paper coordinates: a leader from the centre (or across the circle) with arrows on
 *  the curve, and the text on a shoulder at `at`. */
export function radialDimSvg(c: P2, tip: P2, tip2: P2 | undefined, at: P2, text: string, color = DIM.color): string {
  const out: string[] = [];
  const far = len2(sub2(at, c)) > len2(sub2(tip, c)) ? at : tip;
  out.push(lineSvg(tip2 ?? c, far, color));
  out.push(arrowSvg(tip, sub2(tip, c), color));
  if (tip2) out.push(arrowSvg(tip2, sub2(tip2, c), color));
  const side = at[0] >= c[0] ? 1 : -1, tw = textW(text);
  const shoulderEnd: P2 = [at[0] + side * (tw + 4), at[1]];
  if (far === at) out.push(lineSvg(at, shoulderEnd, color));
  out.push(textSvg([at[0] + side * (tw / 2 + 2), at[1] - 2.5], text, 0, color));
  return out.join("");
}

/** An angle in paper coordinates: the arc (sampled, `arc`), arrows at its ends, extension lines from the edges
 *  out to it, and the text beyond its middle. */
export function angleDimSvg(vertex: P2, arc: P2[], exts: Seg[], text: string, color = DIM.color): string {
  const out: string[] = [];
  for (const [p, q] of exts) out.push(lineSvg(p, q, color));
  out.push(`<polyline points="${arc.map(pt).join(" ")}" fill="none" stroke="${color}" stroke-width="${DIM.line}"/>`);
  const n = arc.length;
  if (n >= 2) {
    let L = 0;
    for (let i = 0; i + 1 < n; i++) L += len2(sub2(arc[i + 1], arc[i]));
    const t0 = norm2(sub2(arc[0], arc[1])), t1 = norm2(sub2(arc[n - 1], arc[n - 2]));
    if (L >= 2 * DIM.arrow + 4) out.push(arrowSvg(arc[0], t0, color), arrowSvg(arc[n - 1], t1, color));
    else {
      // no room between them: the arrows outside, pointing in, on tangent tails
      out.push(lineSvg(arc[0], add2(arc[0], mul2(t0, DIM.arrow * 2)), color), lineSvg(arc[n - 1], add2(arc[n - 1], mul2(t1, DIM.arrow * 2)), color));
      out.push(arrowSvg(arc[0], mul2(t0, -1), color), arrowSvg(arc[n - 1], mul2(t1, -1), color));
    }
    const m = arc[Math.floor(n / 2)], dir = norm2(sub2(m, vertex));
    const at = add2(m, mul2(dir, DIM.text * 0.9 + textW(text) * 0.5 * Math.abs(dir[0])));
    out.push(textSvg([at[0], at[1] + DIM.text * 0.35], text, 0, color));
  }
  return out.join("");
}

/** A dimension that can't be measured: a marked label with the reason as its tooltip. */
export function brokenDimSvg(at: P2, id: string, reason: string): string {
  const label = `${id}: broken`;
  const tw = textW(label);
  return `<g class="dim dim-broken" data-dim="${esc(id)}" data-broken="${esc(reason)}"><title>${esc(`${id}: ${reason}`)}</title>` +
    `<rect x="${f1(at[0] - tw / 2 - 3)}" y="${f1(at[1] - DIM.text - 1)}" width="${f1(tw + 6)}" height="${f1(DIM.text + 5)}" fill="#fff" stroke="${DIM.broken}" stroke-width="0.6" stroke-dasharray="3 2"/>` +
    textSvg([at[0], at[1]], label, 0, DIM.broken) + `</g>`;
}

/** A section line on its base view (paper): a thin chain line, thick at its ends, arrows at the ends pointing
 *  the way the section looks (`look`, paper), and the letter by each arrow. */
export function sectionLineSvg(from: P2, to: P2, look: P2, label: string, id = ""): string {
  const dir = norm2(sub2(to, from)), n = norm2(look), T = DIM.arrow * 1.2;
  const out = [`<g class="section-line" data-section="${esc(id)}" data-label="${esc(label)}">`, `<line x1="${f1(from[0])}" y1="${f1(from[1])}" x2="${f1(to[0])}" y2="${f1(to[1])}" stroke="#111" stroke-width="0.4" stroke-dasharray="16 3 2 3"/>`];
  for (const [e, inward] of [[from, dir], [to, mul2(dir, -1)]] as [P2, P2][]) {
    out.push(lineSvg(e, add2(e, mul2(inward, T * 1.1)), "#111", 1.6));
    const tip = add2(e, mul2(n, T * 1.6));
    out.push(lineSvg(e, tip, "#111", 0.6), arrowSvg(tip, n, "#111"));
    const at = add2(tip, mul2(n, DIM.text * 0.9));
    out.push(`<text x="${f1(at[0])}" y="${f1(at[1] + DIM.text * 0.45)}" font-size="${f1(DIM.text * 1.25)}" font-weight="bold" fill="#111" text-anchor="middle">${esc(label)}</text>`);
  }
  out.push(`</g>`);
  return out.join("");
}

/** The arc of an angle dimension sampled in view coordinates, from ray `a` to ray `b` about `vertex` at `R`. */
export function angleArc(vertex: P2, a: P2, b: P2, R: number, n = 32): P2[] {
  const t0 = Math.atan2(a[1], a[0]);
  let dt = Math.atan2(b[1], b[0]) - t0;
  while (dt > Math.PI) dt -= 2 * Math.PI;
  while (dt < -Math.PI) dt += 2 * Math.PI;
  const out: P2[] = [];
  for (let i = 0; i <= n; i++) { const t = t0 + (dt * i) / n; out.push([vertex[0] + R * Math.cos(t), vertex[1] + R * Math.sin(t)]); }
  return out;
}
