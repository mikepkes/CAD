// The OCC side of 3D gears (see core/geometry/gear.ts for the tooth maths):
// one involute outline turned into the solid a 3D-printing user expects —
// straight, helical (a true helical sweep), herringbone (two mirrored helical
// halves), internal ring gears (a rim around a toothed bore), racks
// (straight / slanted / chevron), straight bevel gears (the outline tapered to
// the pitch-cone apex: every flank is a cone through the apex) and worms (the
// rack-section thread's transverse section, swept turning once per lead).
// Printable extras — a bore with a D-flat or keyway and spoked windows — are
// holes in the swept region (they don't twist); a hub is joined last.
//
// Built in the gear's own frame: axis +Z, the gear from z = 0 to its face
// width (a bevel gear's heel at z = 0, its apex up the axis; a rack along X
// with teeth toward +Y; a worm along +Z). The feature places it.

import { getOC, makeLine, makeCircle, makeThreePointArc, makeBezierCurve, assembleWire, makeFace, makeSolid, makePolygon, makeCompound, revolution, twistExtrude, loft, makeBox, type Shape3D, type Wire, type Edge } from "replicad";
import { gearOutline, bevelOutline, GearOutline, GearType, OutlineEdge, wormGeometry } from "../geometry/gear";
import type { Pt } from "../geometry/spline";
import type { Rigid } from "../../math/transform";
import { fuseShapes, cutShapes, intersectShapes, translateShape, volumeOfShape, castOwned } from "./kernel";

export type GearSolidType = "spur" | "helical" | "herringbone" | "ring" | "rack" | "bevel" | "worm";

export interface GearSolidSpec {
  type: GearSolidType;
  module: number;
  /** Tooth count (a worm: its number of starts). */
  teeth: number;
  /** Axial face width (rack: its depth along Z; worm: its length; bevel: the tooth length along the cone). */
  faceWidth: number;
  pressureAngle?: number;
  /** Helix angle at the pitch circle, degrees; + = right hand. helical / herringbone, and a ring or rack. */
  helixAngle?: number;
  /** Ring or rack: double helical (a chevron). */
  herringbone?: boolean;
  backlash?: number;
  addendum?: number;
  dedendum?: number;
  rootFillet?: number;
  /** Ring: rim thickness outside the root circle (mm). Rack: body depth below the roots (mm). Spoked gear: rim inside the roots (mm). */
  rim?: number;
  /** Bevel: the mating gear's tooth count (pitch cone angle atan(teeth/mateTeeth), shafts at 90°). */
  mateTeeth?: number;
  /** Worm: its pitch diameter (mm). */
  wormDiameter?: number;
  /** Bore diameter (0 = none). */
  bore?: number;
  /** D-shaft: the bore's across-flat size (mm; 0 = round). */
  dFlat?: number;
  /** Keyway width (mm; 0 = none) and depth beyond the bore wall (default width / 2). */
  keyway?: number;
  keywayDepth?: number;
  /** Hub: diameter and length beyond the gear's back face (0 = none). */
  hubDiameter?: number;
  hubLength?: number;
  /** Spokes: cut this many windows through the web between the hub and the rim (0 = solid). */
  spokes?: number;
  /** Break the edges: a small chamfer (see chamferSize) all round the teeth at each end face, a round
   *  bore, a ring's rim and a hub's end — so the edges catch the light. Off when absent. */
  chamfer?: boolean;
}

const DEG = Math.PI / 180;
type P3 = [number, number, number];
type OcAny = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const raw = (s: { wrapped: unknown } | Shape3D | Wire): OcAny => (s as unknown as { wrapped: OcAny }).wrapped;
const free = (...xs: ({ delete?(): void } | undefined)[]) => { for (const x of xs) { try { x?.delete?.(); } catch { /* already freed */ } } };

/** A prism of a face (a solid) or a wire (a shell) along v. */
function prism(shape: Shape3D | Wire, v: P3): Shape3D {
  const oc = getOC() as OcAny;
  const vec = new oc.gp_Vec(v[0], v[1], v[2]);
  const b = new oc.BRepPrimAPI_MakePrism(raw(shape), vec, false, true);
  try { b.Build(); return castOwned(b.Shape()); } finally { b.delete(); vec.delete(); }
}

/** A planar face bounded by `outer` with `holes`, its loops oriented properly whatever their winding. */
function capFace(outer: Wire, holes: Wire[] = []): Shape3D {
  const oc = getOC() as OcAny;
  const f = makeFace(outer, holes);
  const fix = new oc.ShapeFix_Face(raw(f));
  try {
    fix.FixOrientation();
    return castOwned(fix.Face());
  } finally { fix.delete(); free(f); }
}

// ---- outline → wire --------------------------------------------------------------

/** A least-squares cubic Bézier through `pts` (ends fixed, chord-length parameters, two refinement passes). */
function fitCubic(pts: Pt[]): [Pt, Pt, Pt, Pt] {
  const n = pts.length;
  const P0 = pts[0], P3 = pts[n - 1];
  if (n <= 2) return [P0, lerp(P0, P3, 1 / 3), lerp(P0, P3, 2 / 3), P3];
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  let t = cum.map((c) => c / (cum[n - 1] || 1));
  let ctrl: [Pt, Pt, Pt, Pt] = [P0, lerp(P0, P3, 1 / 3), lerp(P0, P3, 2 / 3), P3];
  for (let pass = 0; pass < 3; pass++) {
    // Solve for P1, P2: Σ (b1 P1 + b2 P2 − (P − b0 P0 − b3 P3))² → 2×2 normal equations per coordinate.
    let a11 = 0, a12 = 0, a22 = 0, rx1 = 0, rx2 = 0, ry1 = 0, ry2 = 0;
    for (let i = 0; i < n; i++) {
      const s = t[i], u = 1 - s;
      const b0 = u * u * u, b1 = 3 * u * u * s, b2 = 3 * u * s * s, b3 = s * s * s;
      const qx = pts[i].x - b0 * P0.x - b3 * P3.x, qy = pts[i].y - b0 * P0.y - b3 * P3.y;
      a11 += b1 * b1; a12 += b1 * b2; a22 += b2 * b2;
      rx1 += b1 * qx; rx2 += b2 * qx; ry1 += b1 * qy; ry2 += b2 * qy;
    }
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-18) break;
    ctrl = [P0, { x: (a22 * rx1 - a12 * rx2) / det, y: (a22 * ry1 - a12 * ry2) / det }, { x: (a11 * rx2 - a12 * rx1) / det, y: (a11 * ry2 - a12 * ry1) / det }, P3];
    // Newton step on each parameter toward the closest point.
    t = t.map((s, i) => {
      if (i === 0 || i === n - 1) return s;
      const B = bez(ctrl, s), d1 = bezD(ctrl, s), d2 = bezDD(ctrl, s);
      const ex = B.x - pts[i].x, ey = B.y - pts[i].y;
      const num = ex * d1.x + ey * d1.y, den = d1.x * d1.x + d1.y * d1.y + ex * d2.x + ey * d2.y;
      return Math.abs(den) > 1e-18 ? Math.min(1, Math.max(0, s - num / den)) : s;
    });
  }
  return ctrl;
}
const lerp = (a: Pt, b: Pt, s: number): Pt => ({ x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s });
function bez(c: Pt[], s: number): Pt {
  const u = 1 - s;
  return { x: u * u * u * c[0].x + 3 * u * u * s * c[1].x + 3 * u * s * s * c[2].x + s * s * s * c[3].x, y: u * u * u * c[0].y + 3 * u * u * s * c[1].y + 3 * u * s * s * c[2].y + s * s * s * c[3].y };
}
function bezD(c: Pt[], s: number): Pt {
  const u = 1 - s;
  return { x: 3 * u * u * (c[1].x - c[0].x) + 6 * u * s * (c[2].x - c[1].x) + 3 * s * s * (c[3].x - c[2].x), y: 3 * u * u * (c[1].y - c[0].y) + 6 * u * s * (c[2].y - c[1].y) + 3 * s * s * (c[3].y - c[2].y) };
}
function bezDD(c: Pt[], s: number): Pt {
  const u = 1 - s;
  return { x: 6 * u * (c[2].x - 2 * c[1].x + c[0].x) + 6 * s * (c[3].x - 2 * c[2].x + c[1].x), y: 6 * u * (c[2].y - 2 * c[1].y + c[0].y) + 6 * s * (c[3].y - 2 * c[2].y + c[1].y) };
}
/** Largest distance from the points to the cubic (sampled). */
function fitError(c: Pt[], pts: Pt[]): number {
  const samples = Array.from({ length: 65 }, (_, i) => bez(c, i / 64));
  let worst = 0;
  for (const p of pts) worst = Math.max(worst, Math.min(...samples.map((q) => Math.hypot(q.x - p.x, q.y - p.y))));
  return worst;
}

/** One planar piece of an outline: a line, a circular arc (via its midpoint) or a cubic. */
type Piece = { kind: "line"; a: Pt; b: Pt } | { kind: "arc"; a: Pt; m: Pt; b: Pt } | { kind: "cubic"; c: [Pt, Pt, Pt, Pt] };

/** A tangent fillet of radius r at corner `c` between lines (a→c) and (c→b): the trimmed ends and the arc. */
function cornerFillet(a: Pt, c: Pt, b: Pt, r: number): { t1: Pt; mid: Pt; t2: Pt } | null {
  const d1 = norm({ x: c.x - a.x, y: c.y - a.y }), d2 = norm({ x: b.x - c.x, y: b.y - c.y });
  const cos = Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y));
  const turn = Math.acos(cos);
  if (turn < 1e-6 || turn > Math.PI - 1e-6) return null;
  const s = r * Math.tan(turn / 2);
  const t1 = { x: c.x - d1.x * s, y: c.y - d1.y * s }, t2 = { x: c.x + d2.x * s, y: c.y + d2.y * s };
  const left = d1.x * d2.y - d1.y * d2.x > 0; // turning left → the centre is on the left of d1
  const n1 = left ? { x: -d1.y, y: d1.x } : { x: d1.y, y: -d1.x };
  const o = { x: t1.x + n1.x * r, y: t1.y + n1.y * r };
  const w = norm({ x: c.x - o.x, y: c.y - o.y });
  return { t1, mid: { x: o.x + w.x * r, y: o.y + w.y * r }, t2 };
}
const norm = (v: Pt): Pt => { const L = Math.hypot(v.x, v.y) || 1; return { x: v.x / L, y: v.y / L }; };

/** The outline's closed loop as planar pieces (splines fitted by cubics, rack fillets resolved). */
function outlinePieces(o: GearOutline): Piece[] {
  // First the raw chain of (line | arc | point-list) pieces, sharing endpoints.
  type Raw = { kind: "line"; a: Pt; b: Pt; fillet?: number } | { kind: "arc"; a: Pt; b: Pt; r: number; ccw: boolean } | { kind: "spline"; pts: Pt[] };
  const raw: Raw[] = [];
  let cur = o.start;
  o.edges.forEach((e: OutlineEdge, i) => {
    const last = i === o.edges.length - 1;
    if (e.kind === "spline") {
      const pts = [cur, ...e.through];
      if (last) pts[pts.length - 1] = o.start;
      raw.push({ kind: "spline", pts });
      cur = pts[pts.length - 1];
    } else {
      const to = last ? o.start : e.to;
      raw.push(e.kind === "line" ? { kind: "line", a: cur, b: to, fillet: e.filletAtEnd } : { kind: "arc", a: cur, b: to, r: e.r, ccw: e.ccw });
      cur = to;
    }
  });
  // Rack fillets: trim each filleted line's end and the next line's start, insert the arc.
  const pieces: Piece[] = [];
  const starts: (Pt | undefined)[] = raw.map(() => undefined);
  const fillets: ({ t1: Pt; mid: Pt; t2: Pt } | null)[] = raw.map((r, i) => {
    if (r.kind !== "line" || !r.fillet) return null;
    const nx = raw[(i + 1) % raw.length];
    if (nx.kind !== "line") return null;
    const f = cornerFillet(r.a, r.b, nx.b, r.fillet);
    if (f) starts[(i + 1) % raw.length] = f.t2;
    return f;
  });
  raw.forEach((r, i) => {
    if (r.kind === "line") {
      const a = starts[i] ?? r.a, f = fillets[i];
      const b = f ? f.t1 : r.b;
      if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-9) pieces.push({ kind: "line", a, b });
      if (f) pieces.push({ kind: "arc", a: f.t1, m: f.mid, b: f.t2 });
    } else if (r.kind === "arc") {
      // centre at the gear axis (all outline arcs are concentric with it)
      let a0 = Math.atan2(r.a.y, r.a.x), a1 = Math.atan2(r.b.y, r.b.x);
      if (r.ccw) { while (a1 <= a0) a1 += 2 * Math.PI; } else { while (a1 >= a0) a1 -= 2 * Math.PI; }
      const am = (a0 + a1) / 2;
      pieces.push({ kind: "arc", a: r.a, m: { x: r.r * Math.cos(am), y: r.r * Math.sin(am) }, b: r.b });
    } else {
      const c = fitCubic(r.pts);
      // split in two if one cubic can't hold the curve (deep undercut loops)
      const scale = Math.hypot(r.pts[0].x - r.pts[r.pts.length - 1].x, r.pts[0].y - r.pts[r.pts.length - 1].y);
      if (r.pts.length >= 5 && fitError(c, r.pts) > Math.max(1e-4, 2e-3 * scale)) {
        const k = Math.floor(r.pts.length / 2);
        pieces.push({ kind: "cubic", c: fitCubic(r.pts.slice(0, k + 1)) }, { kind: "cubic", c: fitCubic(r.pts.slice(k)) });
      } else pieces.push({ kind: "cubic", c });
    }
  });
  return pieces;
}

/** The pieces as an OCC wire at height z, scaled by k about the axis. */
function piecesWire(pieces: Piece[], z: number, k = 1): Wire {
  const P = (p: Pt): P3 => [p.x * k, p.y * k, z];
  const edges: Edge[] = pieces.map((p) =>
    p.kind === "line" ? makeLine(P(p.a), P(p.b))
      : p.kind === "arc" ? makeThreePointArc(P(p.a), P(p.m), P(p.b))
        : makeBezierCurve(p.c.map(P)));
  const w = assembleWire(edges);
  free(...edges);
  return w;
}

// ---- toothed bodies -------------------------------------------------------------------
//
// A planar region (an outer loop and holes) carried from z0 to z1: straight, as
// a prism; helical, each loop swept along the axis while following an auxiliary
// helix (replicad's twisted extrude) and capped; herringbone, the lower half
// swept to the middle and mirrored for the upper half. Helical and herringbone
// bodies are sewn from their shells and caps rather than fused — a boolean
// between two sweeps of a hundred flanks takes seconds, sewing coincident
// edges takes milliseconds.
//
// Edge breaks (`chamfer`) are built in the same way, not cut: a broken loop's
// section is offset into the material by c at the end face (see offsetPieces)
// and joined by a ruled band to the full section 1.25·c in from it — a chamfer
// all round the loop's edge, a little steeper than 45° (CHAMFER_DEPTH) — and
// the sweep runs between the bands. Cutting the chamfer afterwards (a boolean
// with revolved cutters, or OCC's own chamfer, which also fails on a worm)
// costs seconds a gear, as each of the hundred flanks is intersected with the
// cutter; built in, it costs a ruled loft and a sewing. The bands only take
// material off within 1.25·c of an end face: the sections in between — the
// pitch circle, the involute — are the sharp gear's.

/** A loop of the region: gear pieces (which twist, unless `fixed`: a bore or a window) or a plain circle about the axis. */
type RegionLoop = { pieces: Piece[]; fixed?: boolean; unbroken?: number[] } | { circle: number };

function loopWire(l: RegionLoop, z: number): Wire {
  if ("circle" in l) {
    const e = makeCircle(l.circle, [0, 0, z], [0, 0, 1]);
    try { return assembleWire([e]); } finally { free(e); }
  }
  return piecesWire(l.pieces, z);
}

const mapPiece = (p: Piece, f: (q: Pt) => Pt): Piece =>
  p.kind === "line" ? { kind: "line", a: f(p.a), b: f(p.b) }
    : p.kind === "arc" ? { kind: "arc", a: f(p.a), m: f(p.m), b: f(p.b) }
      : { kind: "cubic", c: p.c.map(f) as [Pt, Pt, Pt, Pt] };

/** A loop turned `a` radians about the axis. */
function turnLoop(l: RegionLoop, a: number): RegionLoop {
  if ("circle" in l || Math.abs(a) < 1e-12) return l;
  const c = Math.cos(a), s = Math.sin(a);
  return { ...l, pieces: l.pieces.map((p) => mapPiece(p, (q) => ({ x: c * q.x - s * q.y, y: s * q.x + c * q.y }))) };
}

/** Whether a loop turns along a helical sweep. */
const turns = (l: RegionLoop, twistPerMm: number) => Math.abs(twistPerMm) > 1e-12 && "pieces" in l && !l.fixed;

/** One loop carried from z0 to z1 as an open shell, with its start and end wires; a turning loop
 *  starts turned a0. A loop that doesn't turn (a rim, a bore, a window) is a prism — exact planes
 *  and cylinders; one that turns follows an auxiliary helix (replicad's twisted extrude). */
function sweptLoop(l: RegionLoop, z0: number, z1: number, twistPerMm: number, a0 = 0): [Shape3D, Wire, Wire] {
  const h = z1 - z0;
  const turn = turns(l, twistPerMm) ? twistPerMm * h : 0; // radians
  const w = loopWire(turnLoop(l, turn ? a0 : 0), z0);
  if (Math.abs(turn) < 1e-9) {
    return [prism(w, [0, 0, h]), w, translateShape(w as unknown as Shape3D, { x: 0, y: 0, z: h }) as unknown as Wire];
  }
  try {
    return twistExtrude(w, turn / DEG, [0, 0, z0], [0, 0, h], undefined, true) as unknown as [Shape3D, Wire, Wire];
  } finally { free(w); }
}

/** A ruled shell between two wires of matching edges (edge i to edge i). */
function ruledShell(a: Wire, b: Wire): Shape3D {
  const oc = getOC() as OcAny;
  const t = new oc.BRepOffsetAPI_ThruSections(false, true, 1e-6);
  try {
    t.AddWire(raw(a)); t.AddWire(raw(b));
    t.CheckCompatibility(false);
    t.Build();
    if (!t.IsDone()) throw new Error("the chamfer band did not loft");
    return castOwned(t.Shape());
  } finally { t.delete(); }
}

/** Edge breaks at a region's ends: per loop (in the order of `loops`), the chamfer at its bottom and at
 *  its top, mm (0 = sharp). */
type Breaks = { lo: number[]; hi: number[] };

/** The region from z0 to z1, straight (twist 0), helical, or herringbone (see above), its loops' edges
 *  broken as `breaks` says (a herringbone gear's upper half is a mirrored lower half, broken as `hi`). */
function regionBody(loops: RegionLoop[], z0: number, z1: number, twistPerMm: number, herringbone: boolean, breaks?: Breaks): Shape3D {
  const twists = loops.some((l) => turns(l, twistPerMm));
  const none = loops.map(() => 0);
  const lo = breaks?.lo ?? none, hi = breaks?.hi ?? none;
  if (!twists && ![...lo, ...hi].some((c) => c > 0)) {
    const wires = loops.map((l) => loopWire(l, z0));
    const face = capFace(wires[0], wires.slice(1));
    try { return prism(face, [0, 0, z1 - z0]); } finally { free(face, ...wires); }
  }
  const zEnd = herringbone ? (z0 + z1) / 2 : z1;
  const pieces = regionShells(loops, z0, zEnd, twistPerMm, lo, herringbone ? none : hi, !herringbone);
  const owned = [...pieces];
  if (herringbone) {
    const same = lo.every((c, i) => c === hi[i]);
    const upper = same ? pieces : regionShells(loops, z0, zEnd, twistPerMm, hi, none, false);
    if (!same) owned.push(...upper);
    const mirrored = upper.map((x) => mirrorZ(x, zEnd));
    pieces.push(...mirrored);
    owned.push(...mirrored);
  }
  try {
    const solid = makeSolid(pieces as never) as unknown as Shape3D;
    if (!(volumeOfShape(solid) > 0)) { free(solid); throw new Error("the helical sweep did not close into a solid"); }
    return solid;
  } finally { free(...owned); }
}

/** The faces and shells that bound a region from za to zb — the cap at za, and at zb when `capTop` —
 *  each loop broken by lo[i] at za and hi[i] at zb (see above). A turning loop is at its za angle at za. */
function regionShells(loops: RegionLoop[], za: number, zb: number, twistPerMm: number, lo: number[], hi: number[], capTop: boolean): Shape3D[] {
  const shells: Shape3D[] = [];
  const bottoms: Wire[] = [], tops: Wire[] = [], wires = new Set<Wire>();
  try {
    loops.forEach((l, i) => {
      const tw = turns(l, twistPerMm) ? twistPerMm : 0;
      const zs = za + CHAMFER_DEPTH * lo[i], ze = zb - CHAMFER_DEPTH * hi[i];
      const [shell, ws, we] = sweptLoop(l, zs, ze, tw, tw * (zs - za));
      shells.push(shell); wires.add(ws); wires.add(we);
      let wb = ws, wt = we;
      if (lo[i] > 0) { wb = loopWire(offsetLoop(l, lo[i], i === 0), za); wires.add(wb); shells.push(ruledShell(wb, ws)); }
      if (hi[i] > 0) { wt = loopWire(turnLoop(offsetLoop(l, hi[i], i === 0), tw * (zb - za)), zb); wires.add(wt); shells.push(ruledShell(we, wt)); }
      bottoms.push(wb); tops.push(wt);
    });
    const out = [capFace(bottoms[0], bottoms.slice(1)), ...shells];
    if (capTop) out.push(capFace(tops[0], tops.slice(1)));
    return out;
  } catch (e) { free(...shells); throw e; } finally { free(...wires); }
}

/** Mirror a shape in the plane z = c (a copy). */
function mirrorZ(shape: Shape3D, c: number): Shape3D {
  const copy = (shape as unknown as { clone: () => Shape3D }).clone();
  return (copy as unknown as { mirror: (n: P3, o: P3) => Shape3D }).mirror([0, 0, 1], [0, 0, c]);
}

// ---- offsetting a section into the material (for the edge breaks) ----------------------------

/** A circular arc through a, m, b: its centre, radius, start angle, signed sweep. */
function arcOf(a: Pt, m: Pt, b: Pt) {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  const sq = (p: Pt) => p.x * p.x + p.y * p.y;
  const o = { x: (sq(a) * (m.y - b.y) + sq(m) * (b.y - a.y) + sq(b) * (a.y - m.y)) / d, y: (sq(a) * (b.x - m.x) + sq(m) * (a.x - b.x) + sq(b) * (m.x - a.x)) / d };
  const ccw = (m.x - a.x) * (b.y - a.y) - (m.y - a.y) * (b.x - a.x) > 0; // a → m → b turns left: counter-clockwise
  const a0 = Math.atan2(a.y - o.y, a.x - o.x);
  let a1 = Math.atan2(b.y - o.y, b.x - o.x);
  if (ccw) { while (a1 <= a0) a1 += 2 * Math.PI; } else { while (a1 >= a0) a1 -= 2 * Math.PI; }
  return { o, r: Math.hypot(a.x - o.x, a.y - o.y), a0, sweep: a1 - a0 };
}

/** Points along a piece and the unit tangent (direction of travel) at each. */
function sampled(p: Piece): { pts: Pt[]; tan: Pt[] } {
  if (p.kind === "line") { const t = norm({ x: p.b.x - p.a.x, y: p.b.y - p.a.y }); return { pts: [p.a, p.b], tan: [t, t] }; }
  const n = 16;
  if (p.kind === "cubic") {
    const pts: Pt[] = [], tan: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      pts.push(bez(p.c, s));
      let d = bezD(p.c, s);
      if (Math.hypot(d.x, d.y) < 1e-12) d = bezD(p.c, Math.min(1, Math.max(0, s + (i === 0 ? 1e-3 : -1e-3))));
      tan.push(norm(d));
    }
    return { pts, tan };
  }
  const g = arcOf(p.a, p.m, p.b), sgn = Math.sign(g.sweep);
  const pts: Pt[] = [], tan: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = g.a0 + (g.sweep * i) / n;
    pts.push(i === 0 ? p.a : i === n ? p.b : { x: g.o.x + g.r * Math.cos(t), y: g.o.y + g.r * Math.sin(t) });
    tan.push({ x: -Math.sin(t) * sgn, y: Math.cos(t) * sgn });
  }
  return { pts, tan };
}

/** Twice the signed area of a closed polygon (positive counter-clockwise). */
const area2 = (pts: Pt[]) => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p.x * q.y - q.x * p.y; }, 0);

/** A loop's section offset by d into the material: an outer loop inward, a hole outward (but for its
 *  `unbroken` pieces, which stay put, their neighbours meeting them). */
function offsetLoop(l: RegionLoop, d: number, outer: boolean): RegionLoop {
  if ("circle" in l) return { circle: outer ? l.circle - d : l.circle + d };
  const ccw = area2(l.pieces.flatMap((p) => sampled(p).pts.slice(0, -1))) > 0;
  return { ...l, pieces: offsetPieces(l.pieces, ccw === outer ? d : -d, l.unbroken) };
}

/**
 * A closed chain of pieces offset sideways by d (to the left of travel; negative to the right), piece
 * for piece — the same count, so a ruled loft joins each to its original. Each piece is offset along
 * its normals (a line stays a line, an arc a concentric arc, a cubic is refitted); where two met
 * smoothly their offsets still meet, and at a corner the two offsets are trimmed back to where they
 * cross (a convex corner) or carried on along their tangents until they do (a concave one). Throws
 * if a piece is trimmed away entirely (a tooth tip narrower than the chamfer). The pieces listed in
 * `keep` aren't offset (the rest meet them as they would each other).
 */
function offsetPieces(pieces: Piece[], d: number, keep: number[] = []): Piece[] {
  const n = pieces.length, L = 6 * Math.abs(d);
  const off = pieces.map((p, k) => {
    const { pts, tan } = sampled(p), dk = keep.includes(k) ? 0 : d;
    return { pts: pts.map((q, i) => ({ x: q.x - dk * tan[i].y, y: q.y + dk * tan[i].x })), t0: tan[0], t1: tan[tan.length - 1] };
  });
  // smooth joints: the offsets' ends coincide (to the fit), so meet them in the middle
  const smooth = off.map((A, i) => {
    const B = off[(i + 1) % n], a = A.pts[A.pts.length - 1], b = B.pts[0];
    if (Math.hypot(a.x - b.x, a.y - b.y) > 0.05 * Math.abs(d) + 1e-9) return false;
    const m = lerp(a, b, 0.5);
    A.pts[A.pts.length - 1] = m; B.pts[0] = m;
    return true;
  });
  // each offset as a polyline carried on L past both ends, and arc-length positions along it
  const ext = off.map((A) => {
    const a = A.pts[0], b = A.pts[A.pts.length - 1];
    const pts = [{ x: a.x - A.t0.x * L, y: a.y - A.t0.y * L }, ...A.pts, { x: b.x + A.t1.x * L, y: b.y + A.t1.y * L }];
    const s = [0];
    for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    return { pts, s, from: L, to: s[s.length - 1] - L };
  });
  const cut0 = ext.map((e) => e.from), cut1 = ext.map((e) => e.to);
  for (let i = 0; i < n; i++) {
    if (smooth[i]) continue;
    const A = ext[i], j = (i + 1) % n, B = ext[j];
    let best: { sa: number; sb: number; cost: number } | null = null;
    for (let u = 0; u < A.pts.length - 1; u++) {
      for (let v = 0; v < B.pts.length - 1; v++) {
        const x = segX(A.pts[u], A.pts[u + 1], B.pts[v], B.pts[v + 1]);
        if (!x) continue;
        const sa = A.s[u] + x.t * (A.s[u + 1] - A.s[u]), sb = B.s[v] + x.w * (B.s[v + 1] - B.s[v]);
        const cost = Math.abs(sa - A.to) + Math.abs(sb - B.from);
        if (!best || cost < best.cost) best = { sa, sb, cost };
      }
    }
    if (!best) throw new Error("the chamfer's offset corner did not close");
    cut1[i] = best.sa; cut0[j] = best.sb;
  }
  return pieces.map((p, i) => {
    const e = ext[i];
    if (!(cut1[i] - cut0[i] > 1e-6)) throw new Error("the chamfer is wider than a tooth tip");
    const poly = slicePoly(e.pts, e.s, cut0[i], cut1[i]);
    if (p.kind === "line") return { kind: "line", a: poly[0], b: poly[poly.length - 1] };
    if (p.kind === "arc") return { kind: "arc", a: poly[0], m: slicePoly(e.pts, e.s, (cut0[i] + cut1[i]) / 2, (cut0[i] + cut1[i]) / 2)[0], b: poly[poly.length - 1] };
    return { kind: "cubic", c: fitCubic(poly) };
  });
}

/** Where segments p0p1 and q0q1 cross: their parameters, or null. */
function segX(p0: Pt, p1: Pt, q0: Pt, q1: Pt): { t: number; w: number } | null {
  const rx = p1.x - p0.x, ry = p1.y - p0.y, sx = q1.x - q0.x, sy = q1.y - q0.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-18) return null;
  const qx = q0.x - p0.x, qy = q0.y - p0.y;
  const t = (qx * sy - qy * sx) / den, w = (qx * ry - qy * rx) / den;
  return t >= -1e-9 && t <= 1 + 1e-9 && w >= -1e-9 && w <= 1 + 1e-9 ? { t, w } : null;
}

/** The part of a polyline (with arc-length positions s) from position a to b. */
function slicePoly(pts: Pt[], s: number[], a: number, b: number): Pt[] {
  const at = (x: number): Pt => {
    let k = 0;
    while (k < s.length - 2 && s[k + 1] < x) k++;
    const f = s[k + 1] > s[k] ? (x - s[k]) / (s[k + 1] - s[k]) : 0;
    return lerp(pts[k], pts[k + 1], Math.min(1, Math.max(0, f)));
  };
  const out = [at(a)];
  for (let k = 0; k < pts.length; k++) if (s[k] > a + 1e-9 && s[k] < b - 1e-9) out.push(pts[k]);
  out.push(at(b));
  return out;
}

// ---- the printable extras ---------------------------------------------------------------

const polarPt = (r: number, a: number): Pt => ({ x: r * Math.cos(a), y: r * Math.sin(a) });

/** The bore as a loop: round, D-flat (the flat toward +Y) or keyed (the key slot toward +Y). */
function boreLoop(s: GearSolidSpec): RegionLoop | null {
  const d = s.bore ?? 0;
  if (!(d > 0)) return null;
  const r = d / 2;
  const flat = s.dFlat ?? 0, key = s.keyway ?? 0;
  if (flat > 0 && flat < d) {
    // the circle cut by a chord (flat − r) from the axis
    const yf = flat - r, xf = Math.sqrt(Math.max(0, r * r - yf * yf));
    const a = { x: xf, y: yf }, b = { x: -xf, y: yf };
    return { fixed: true, pieces: [{ kind: "line", a, b }, { kind: "arc", a: b, m: { x: 0, y: -r }, b: a }] };
  }
  if (key > 0 && key < d) {
    // the circle plus a slot of width `key`, `keywayDepth` beyond the wall
    const kd = s.keywayDepth ?? key / 2, hw = key / 2, yk = Math.sqrt(r * r - hw * hw);
    const p0 = { x: hw, y: yk }, p1 = { x: hw, y: r + kd }, p2 = { x: -hw, y: r + kd }, p3 = { x: -hw, y: yk };
    return { fixed: true, pieces: [{ kind: "line", a: p0, b: p1 }, { kind: "line", a: p1, b: p2 }, { kind: "line", a: p2, b: p3 }, { kind: "arc", a: p3, m: { x: 0, y: -r }, b: p0 }] };
  }
  return { circle: r };
}

/** Windows through the web: `n` annular sectors between radii r0 and r1, leaving spokes `spoke` wide. */
function spokeLoops(n: number, r0: number, r1: number, spoke: number): RegionLoop[] {
  if (n < 2 || r1 - r0 < 1.5) return [];
  const halfIn = Math.asin(Math.min(0.9, spoke / 2 / r0)), halfOut = Math.asin(Math.min(0.9, spoke / 2 / r1));
  const step = (2 * Math.PI) / n;
  const out: RegionLoop[] = [];
  for (let i = 0; i < n; i++) {
    const c = i * step + step / 2;
    const a0 = c - step / 2 + halfIn, a1 = c + step / 2 - halfIn, b0 = c - step / 2 + halfOut, b1 = c + step / 2 - halfOut;
    if (a1 - a0 < 0.05 || b1 - b0 < 0.05) return [];
    const p = [polarPt(r0, a0), polarPt(r1, b0), polarPt(r1, b1), polarPt(r0, a1)];
    out.push({ fixed: true, pieces: [
      { kind: "line", a: p[0], b: p[1] }, { kind: "arc", a: p[1], m: polarPt(r1, c), b: p[2] },
      { kind: "line", a: p[2], b: p[3] }, { kind: "arc", a: p[3], m: polarPt(r0, c), b: p[0] },
    ] });
  }
  return out;
}

/** The holes a round gear's web carries: the bore (first, if any) and, with spokes, the windows
 *  between the hub and a rim `rim` inside `rInner` (the root circle). */
function webHoles(s: GearSolidSpec, rInner: number): RegionLoop[] {
  const holes: RegionLoop[] = [];
  const bore = boreLoop(s);
  if (bore) holes.push(bore);
  const spokes = Math.round(s.spokes ?? 0);
  if (spokes >= 2) {
    const hubD = s.hubDiameter ?? 0;
    const boreR = Math.max((s.bore ?? 0) / 2, s.keyway ? (s.bore ?? 0) / 2 + (s.keywayDepth ?? s.keyway / 2) : 0);
    const r0 = Math.max(hubD / 2, boreR + 1.5 * s.module, 2 * s.module) + 0.5 * s.module;
    const r1 = rInner - (s.rim ?? 1.5 * s.module);
    holes.push(...spokeLoops(spokes, r0, r1, Math.max(1.5 * s.module, (r1 - r0) * 0.35)));
  }
  return holes;
}

const hasHub = (s: GearSolidSpec) => (s.hubDiameter ?? 0) > 0 && (s.hubLength ?? 0) > 0;
/** The edge break a round bore gets, in a wall `wall` thick (a D-flat or keyed bore stays sharp). */
const boreBreak = (s: GearSolidSpec, c: number, wall: number) => (c > 0 && boreLoop(s) && "circle" in boreLoop(s)! ? Math.min(c, wall / 4) : 0);

/** A hub of diameter `hubDiameter`, `hubLength` beyond the face at z (upward when dir = 1), bored like
 *  the gear; its far end broken by c (outside and a round bore). */
function hubSolid(s: GearSolidSpec, z: number, dir: 1 | -1, c = 0): Shape3D | null {
  const d = s.hubDiameter ?? 0, L = s.hubLength ?? 0;
  if (!(d > 0 && L > 0)) return null;
  const bore = boreLoop(s);
  // overlap the gear by a hair so the fuse has volume to merge
  const z0 = dir > 0 ? z - 1e-3 : z - L, z1 = dir > 0 ? z + L : z + 1e-3;
  const wall = d / 2 - (s.bore ?? 0) / 2;
  const far = [Math.min(c, wall / 4), boreBreak(s, c, wall)].slice(0, bore ? 2 : 1), near = far.map(() => 0);
  return regionBody([{ circle: d / 2 }, ...(bore ? [bore] : [])], z0, z1, 0, false, c > 0 ? (dir > 0 ? { lo: near, hi: far } : { lo: far, hi: near }) : undefined);
}

/** Join a hub onto a gear body (consumes the body). */
function withHub(body: Shape3D, hub: Shape3D | null): Shape3D {
  if (!hub) return body;
  try { return fuseShapes(body, hub); } finally { free(body, hub); }
}

// ---- the gear types ---------------------------------------------------------------------
//
// Each takes the edge break c (0 = sharp; see buildGearSolid).

const profileSpec = (s: GearSolidSpec, type: GearType, teeth = s.teeth) => ({
  type, module: s.module, teeth, pressureAngle: s.pressureAngle, addendum: s.addendum, dedendum: s.dedendum,
  backlash: s.backlash, rootFillet: s.rootFillet, samples: 10,
  ...(type === "rack" ? { rackHeight: s.rim } : {}),
});

/** Twist rate (rad/mm) of a helical gear of pitch radius rp: a tooth advances tan β per mm along the axis. */
const twistRate = (helixDeg: number, rp: number) => Math.tan(helixDeg * DEG) / rp;

function cylindricalGear(s: GearSolidSpec, c: number): Shape3D {
  const o = gearOutline(profileSpec(s, "external"));
  const holes = webHoles(s, o.radii!.root);
  // the teeth broken at both faces, a round bore at both unless the hub carries it on (windows stay sharp)
  const cb = boreBreak(s, c, o.radii!.root - (s.bore ?? 0) / 2);
  const lo = [c, ...holes.map((_, i) => (i === 0 ? cb : 0))], hi = [c, ...holes.map((_, i) => (i === 0 && !hasHub(s) ? cb : 0))];
  const body = regionBody([{ pieces: outlinePieces(o) }, ...holes], 0, s.faceWidth, twistRate(s.type === "spur" ? 0 : (s.helixAngle ?? 0), o.radii!.pitch), s.type === "herringbone" || !!s.herringbone, c > 0 ? { lo, hi } : undefined);
  return withHub(body, hubSolid(s, s.faceWidth, 1, c));
}

function ringGear(s: GearSolidSpec, c: number): Shape3D {
  const o = gearOutline(profileSpec(s, "internal"));
  const rim = s.rim ?? 3 * s.module;
  const br = [Math.min(c, rim / 4), c];
  return regionBody([{ circle: o.radii!.root + rim }, { pieces: outlinePieces(o) }], 0, s.faceWidth, twistRate(s.helixAngle ?? 0, o.radii!.pitch), !!s.herringbone, c > 0 ? { lo: br, hi: br } : undefined);
}

function rackGear(s: GearSolidSpec, c: number): Shape3D {
  const h = s.faceWidth;
  const slope = Math.tan((s.helixAngle ?? 0) * DEG); // x shift per mm along Z
  if (Math.abs(slope) < 1e-12) {
    // broken all round the end faces but at the bar's square ends (whose half root spaces can be
    // shorter than the chamfer)
    const pieces = outlinePieces(gearOutline(profileSpec(s, "rack")));
    const L = Math.round(s.teeth) * Math.PI * s.module;
    const ends = pieces.flatMap((p, i) => (p.kind === "line" && Math.abs(Math.abs(p.a.x) - L / 2) < 1e-9 && Math.abs(p.b.x - p.a.x) < 1e-9 ? [i] : []));
    return regionBody([{ pieces, unbroken: ends }], 0, h, 0, false, c > 0 ? { lo: [c], hi: [c] } : undefined);
  }
  // The profile carried along a slanted vector: a prism of the wire (a shell) capped at both ends;
  // herringbone mirrors the lower half (sewn, like the round gears). It runs a few teeth long at
  // each end (on the same pitch lattice) so the square-trimmed bar is full at both ends.
  const zEnd = s.herringbone ? h / 2 : h;
  const L = Math.round(s.teeth) * Math.PI * s.module;
  const extra = Math.ceil(Math.abs(zEnd * slope) / (Math.PI * s.module)) + 1;
  const o = gearOutline(profileSpec(s, "rack", Math.round(s.teeth) + 2 * extra));
  const pieces = outlinePieces(o);
  const w0 = piecesWire(pieces, 0);
  const shell = prism(w0, [zEnd * slope, 0, zEnd]);
  const w1 = translateShape(w0 as unknown as Shape3D, { x: zEnd * slope, y: 0, z: zEnd }) as unknown as Wire;
  const start = capFace(w0);
  const parts: Shape3D[] = [start, shell];
  if (s.herringbone) parts.push(mirrorZ(start, zEnd), mirrorZ(shell, zEnd));
  else parts.push(capFace(w1));
  let body: Shape3D;
  try { body = makeSolid(parts as never) as unknown as Shape3D; } finally { free(...parts, w0, w1); }
  // trim the slanted ends square
  const ys = o.rack!.pitchLineV;
  const box = makeBox([-L / 2, ys - 100 * s.module, -1], [L / 2, ys + 100 * s.module, h + 1]) as unknown as Shape3D;
  let bar: Shape3D;
  try { bar = intersectShapes(body, box); } finally { free(body, box); }
  return c > 0 ? slantedRackBreaks(bar, s, c) : bar;
}

function bevelGear(s: GearSolidSpec, c: number): Shape3D {
  const o = bevelOutline({ ...profileSpec(s, "external"), mateTeeth: s.mateTeeth ?? s.teeth });
  const bg = o.bevel;
  if (!(s.faceWidth < bg.coneDistance * 0.6)) throw new Error(`bevel face width must be under ${(bg.coneDistance * 0.6).toFixed(2)} (60% of the cone distance)`);
  const pieces = outlinePieces(o);
  const k = 1 - s.faceWidth / bg.coneDistance;  // the toe is the heel scaled toward the apex
  const cosA = Math.cos(bg.pitchAngle), zt = s.faceWidth * cosA;
  // sections along the cone, scaled toward the apex: heel and toe, and with an edge break, the heel's
  // and toe's outlines offset into the tooth by c (the toe's by c scaled) at the faces, the full
  // outline c (c·k) along the cone from each
  const scaled = (kk: number) => pieces.map((p) => mapPiece(p, (q) => ({ x: q.x * kk, y: q.y * kk })));
  const at = (slant: number): [Piece[], number] => [scaled(1 - slant / bg.coneDistance), slant * cosA];
  const sections: [Piece[], number][] = c > 0
    ? [[(offsetLoop({ pieces }, c, true) as { pieces: Piece[] }).pieces, 0], at(CHAMFER_DEPTH * c), at(s.faceWidth - CHAMFER_DEPTH * c * k), [(offsetLoop({ pieces: scaled(k) }, c * k, true) as { pieces: Piece[] }).pieces, zt]]
    : [[pieces, 0], [scaled(k), zt]];
  const wires = sections.map(([p, z]) => piecesWire(p, z));
  let body: Shape3D;
  try { body = loft(wires, { ruled: true }) as unknown as Shape3D; } finally { free(...wires); }
  // the bore and windows cut through the cone, then the hub behind the heel
  const holes = webHoles(s, o.radii!.root * k);
  const bore = boreLoop(s);
  for (const [i, h] of holes.entries()) {
    const cb = i === 0 && bore ? boreBreak(s, c, o.radii!.root * k - (s.bore ?? 0) / 2) : 0;
    const tool = cb > 0 ? flaredBore((s.bore ?? 0) / 2, hasHub(s) ? 0 : cb, cb * k, zt) : regionBody([h], -1, zt + 1, 0, false);
    const cut = cutShapes(body, tool); free(body, tool);
    body = cut;
  }
  return withHub(body, hubSolid(s, 0, -1, c));
}

/** A round bore's cutter from z = 0 to zt, flared by cLo at the bottom and cHi at the top (CHAMFER_DEPTH
 *  deep; on past both faces, so it never runs along one). */
function flaredBore(r: number, cLo: number, cHi: number, zt: number): Shape3D {
  const e = 1, D = CHAMFER_DEPTH;
  const pts: P3[] = [[0, 0, -e], [r + cLo + e / D, 0, -e], [r, 0, D * cLo], [r, 0, zt - D * cHi], [r + cHi + e / D, 0, zt + e], [0, 0, zt + e]];
  const face = makePolygon(pts);
  try { return revolution(face, [0, 0, 0], [0, 0, 1], 360); } finally { free(face); }
}

/** A worm's transverse section (z = 0). Its thread's axial section is the basic rack — straight
 *  flanks, ZA / Archimedean — so across the axis each flank is an Archimedean spiral: at radius r a
 *  thread of axial width w(r) spans 2π·w(r)/lead radians. Thread k is centred on angle 2πk/starts. */
function wormSection(w: ReturnType<typeof wormGeometry>, leftHand: boolean): Piece[] {
  const n = w.starts, rf = w.rootRadius, ra = w.tipRadius;
  const width = (r: number) => w.rootWidth + ((w.tipWidth - w.rootWidth) * (r - rf)) / (ra - rf);
  const half = (r: number) => (Math.PI * width(r)) / w.lead; // half the thread's angular width at r
  const pieces: Piece[] = [];
  const S = 8;
  for (let k = 0; k < n; k++) {
    const c = (2 * Math.PI * k) / n;
    const right = Array.from({ length: S + 1 }, (_, i) => { const r = rf + ((ra - rf) * i) / S; return polarPt(r, c - half(r)); });
    const left = right.map((p) => { const r = Math.hypot(p.x, p.y); return polarPt(r, c + half(r)); }).reverse();
    pieces.push({ kind: "cubic", c: fitCubic(right) });
    pieces.push({ kind: "arc", a: right[S], m: polarPt(ra, c), b: left[0] });
    pieces.push({ kind: "cubic", c: fitCubic(left) });
    const next = c + (2 * Math.PI) / n;
    pieces.push({ kind: "arc", a: left[S], m: polarPt(rf, (c + half(rf) + next - half(rf)) / 2), b: polarPt(rf, next - half(rf)) });
  }
  // close exactly: the last root arc ends where the first flank starts
  const last = pieces[pieces.length - 1] as Extract<Piece, { kind: "arc" }>;
  last.b = (pieces[0] as Extract<Piece, { kind: "cubic" }>).c[0];
  if (leftHand) return pieces.map(mirrorPieceY).reverse();
  return pieces;
}

/** A piece mirrored in the X axis, reversed (so a mirrored loop still runs end to start). */
function mirrorPieceY(p: Piece): Piece {
  const m = (q: Pt): Pt => ({ x: q.x, y: -q.y });
  if (p.kind === "line") return { kind: "line", a: m(p.b), b: m(p.a) };
  if (p.kind === "arc") return { kind: "arc", a: m(p.b), m: m(p.m), b: m(p.a) };
  return { kind: "cubic", c: [m(p.c[3]), m(p.c[2]), m(p.c[1]), m(p.c[0])] };
}

/** A worm: the transverse section swept along the axis turning once per lead (right hand unless
 *  helixAngle < 0), with its bore. */
function worm(s: GearSolidSpec, c: number): Shape3D {
  const leftHand = (s.helixAngle ?? 1) < 0;
  const w = wormGeometry(s.module, Math.max(1, Math.round(s.teeth)), s.wormDiameter ?? 10 * s.module, { pressureAngle: s.pressureAngle, addendum: s.addendum, dedendum: s.dedendum, backlash: s.backlash });
  const bore = boreLoop(s);
  if (bore && (s.bore ?? 0) / 2 > w.rootRadius - 0.8) throw new Error(`worm bore must leave a wall: at most ${(2 * (w.rootRadius - 0.8)).toFixed(2)} mm`);
  const br = [c, ...(bore ? [boreBreak(s, c, w.rootRadius - (s.bore ?? 0) / 2)] : [])];
  return regionBody([{ pieces: wormSection(w, leftHand) }, ...(bore ? [bore] : [])], 0, s.faceWidth, ((leftHand ? -1 : 1) * 2 * Math.PI) / w.lead, false, c > 0 ? { lo: br, hi: br } : undefined);
}

/** Build a gear solid in its own frame (axis +Z; see the module comment). With `chamfer`, its edges
 *  are broken (see chamferSize); if that can't be built — a tooth tip too narrow for it, or the
 *  kernel failing — it is tried at half the size, then left sharp and reported to `warn`. */
export function buildGearSolid(s: GearSolidSpec, warn?: (msg: string) => void): Shape3D {
  if (!(s.module > 0)) throw new Error("module must be positive");
  if (!(s.faceWidth > 0)) throw new Error("face width must be positive");
  const build = (c: number): Shape3D => {
    switch (s.type) {
      case "spur": case "helical": case "herringbone": return cylindricalGear(s, c);
      case "ring": return ringGear(s, c);
      case "rack": return rackGear(s, c);
      case "bevel": return bevelGear(s, c);
      case "worm": return worm(s, c);
    }
    throw new Error(`unknown gear type "${s.type}"`);
  };
  const c = s.chamfer ? chamferSize(s) : 0;
  if (!c) return build(0);
  for (const f of [1, 0.5]) {
    if (c * f < 0.02) break;
    try {
      const body = build(c * f);
      if (isValidSolid(body)) return body;
      free(body);
    } catch { /* tried smaller, or left sharp below */ }
  }
  const body = build(0); // a sharp gear that can't be built throws as it always did
  warn?.("its edges couldn't be chamfered, so it is built sharp");
  return body;
}

// ---- edge breaks ---------------------------------------------------------------------------
//
// A machined gear has its sharp edges broken, and that thin bevel is what catches
// the light round each tooth. Round gears, rings, straight racks and worms get it
// built in (regionBody, above): the whole toothed outline at each end face —
// tips, flanks and roots — the rim of a ring, a round bore and a hub's far end.
// A bevel gear is lofted through its heel and toe outlines offset the same way,
// its round bore cut with flared ends. A slanted rack (trimmed square from a
// longer slanted bar) has its tips and back broken by cutting prisms along it,
// which is cheap on its plane faces. Spoke windows and a D-flat's or keyway's
// bore stay sharp.

/** How far an edge break runs along the axis, for each mm it cuts in from the side: a little steeper
 *  than 45°, so a break on the face a gear prints on never overhangs past 45° (as tessellated). */
const CHAMFER_DEPTH = 1.25;

/** The edge break's size (its width across the end face), mm: 0.15 × module, at most a quarter of the addendum and a sixth of the
 *  face width; 0 when that's too small to cut cleanly (under 0.02 mm). */
export function chamferSize(s: GearSolidSpec): number {
  const c = Math.min(0.15 * s.module, 0.25 * (s.addendum ?? 1) * s.module, s.faceWidth / 6);
  return c >= 0.02 ? c : 0;
}

/** A slanted rack with its tips and back broken by c at both end faces (consumes `bar`): a prism of
 *  triangular section along X takes each corner off (CHAMFER_DEPTH deep), grown past the faces it meets. */
function slantedRackBreaks(bar: Shape3D, s: GearSolidSpec, c: number): Shape3D {
  const m = s.module, H = s.faceWidth;
  const tip = (s.addendum ?? 1) * m, back = -(s.dedendum ?? 1.25) * m - (s.rim ?? 2 * m);
  const e = Math.max(0.05, 0.5 * c), half = (Math.round(s.teeth) * Math.PI * m) / 2 + 2 * m;
  // corners in (y, z): K, and the directions of its two sides into the material
  const corners: [Pt, Pt, Pt][] = [
    [{ x: tip, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }], [{ x: tip, y: H }, { x: -1, y: 0 }, { x: 0, y: -1 }],
    [{ x: back, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], [{ x: back, y: H }, { x: 1, y: 0 }, { x: 0, y: -1 }],
  ];
  const cutters = corners.map(([K, d1, d2]) => {
    const P = { x: K.x + c * d1.x, y: K.y + c * d1.y }, Q = { x: K.x + CHAMFER_DEPTH * c * d2.x, y: K.y + CHAMFER_DEPTH * c * d2.y };
    const u = norm({ x: P.x - Q.x, y: P.y - Q.y });
    const tri = [{ x: P.x + e * u.x, y: P.y + e * u.y }, { x: K.x - e * (d1.x + d2.x), y: K.y - e * (d1.y + d2.y) }, { x: Q.x - e * u.x, y: Q.y - e * u.y }];
    const face = makePolygon(tri.map((p) => [-half, p.x, p.y] as P3)) as unknown as Shape3D;
    try { return prism(face, [2 * half, 0, 0]); } finally { free(face); }
  });
  const tool = makeCompound(cutters) as unknown as Shape3D;
  try { return cutShapes(bar, tool); } finally { free(bar, tool, ...cutters); }
}

/** One valid solid (BRepCheck), as a broken gear must be. */
function isValidSolid(shape: Shape3D): boolean {
  const oc = getOC() as OcAny;
  const a = new oc.BRepCheck_Analyzer(raw(shape), true, false, false);
  try {
    if (!a.IsValid()) return false;
  } finally { a.delete(); }
  const ex = new oc.TopExp_Explorer(raw(shape), oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let n = 0;
  try { for (; ex.More(); ex.Next()) n++; } finally { ex.delete(); }
  return n === 1 && volumeOfShape(shape) > 0;
}


// ---- built once, placed many times ----------------------------------------------------------
//
// A gear's solid depends only on its numbers, not on where it is: a gear on a
// revolute joint is the same solid at every angle. So the local solid is built
// once per spec (kept, least recently used dropped) and each placement is the
// same geometry under a new location — no rebuild, no copy — which is what
// keeps a clockwork of helical gears turning at slider speed.

/** A ring of material about a gear's own axis: radii rIn..rOut, local z0..z1. */
export interface Annulus { rIn: number; rOut: number; z0: number; z1: number }

/** The annuli that hold a round gear — its toothed part (out to the tips, in to the bore or a ring
 *  gear's tips) and its hub — so a collision check can rule a pair out before any boolean: side by
 *  side, past each other's ends, or a pin inside a bore. Null for a rack. */
export function gearExtent(s: GearSolidSpec): Annulus[] | null {
  const m = s.module, margin = 1e-3;
  const bore = s.bore ?? 0, flat = s.dFlat ?? 0;
  const rIn = Math.max(0, (bore > 0 ? (flat > 0 && flat < bore ? Math.min(bore / 2, flat - bore / 2) : bore / 2) : 0) - margin);
  const hubR = (s.hubDiameter ?? 0) / 2, hubL = hubR > 0 ? s.hubLength ?? 0 : 0;
  const ring = (lo: number, hi: number, z0: number, z1: number): Annulus => ({ rIn: lo, rOut: hi + margin, z0, z1 });
  switch (s.type) {
    case "spur": case "helical": case "herringbone": {
      const out = [ring(rIn, m * (s.teeth / 2 + (s.addendum ?? 1)), 0, s.faceWidth)];
      if (hubL > 0) out.push(ring(rIn, hubR, s.faceWidth, s.faceWidth + hubL));
      return out;
    }
    case "ring":
      return [ring(Math.max(0, m * (s.teeth / 2 - (s.addendum ?? 1)) - margin), m * (s.teeth / 2 + (s.dedendum ?? 1.25)) + (s.rim ?? 3 * m), 0, s.faceWidth)];
    case "bevel": {
      const o = bevelOutline({ ...profileSpec(s, "external"), mateTeeth: s.mateTeeth ?? s.teeth });
      const out = [ring(rIn, o.radii!.tip, 0, s.faceWidth * Math.cos(o.bevel.pitchAngle))];
      if (hubL > 0) out.push(ring(rIn, hubR, -hubL, 0));
      return out;
    }
    case "worm":
      return [ring(rIn, wormGeometry(m, Math.max(1, Math.round(s.teeth)), s.wormDiameter ?? 10 * m, s).tipRadius, 0, s.faceWidth)];
    default: return null;
  }
}

const LOCAL = new Map<string, Shape3D>();
const LOCAL_WARN = new Map<string, string>();
const LOCAL_MAX = 48;

/** A stable key for a gear spec (the same numbers → the same key). */
export function gearSolidKey(s: GearSolidSpec): string {
  return JSON.stringify(Object.keys(s).sort().flatMap((k) => { const v = (s as unknown as Record<string, unknown>)[k]; return v === undefined ? [] : [[k, v]]; }));
}

/** The gear in its own frame, built once per spec, and what went wrong on the way (a chamfer left
 *  off). Owned by the memo: place it, don't delete it. */
export function localGearSolid(s: GearSolidSpec): { key: string; shape: Shape3D; warning?: string } {
  const key = gearSolidKey(s);
  const hit = LOCAL.get(key);
  if (hit) { LOCAL.delete(key); LOCAL.set(key, hit); return { key, shape: hit, warning: LOCAL_WARN.get(key) }; }
  let warning: string | undefined;
  const shape = buildGearSolid(s, (w) => { warning = w; });
  LOCAL.set(key, shape);
  if (warning) LOCAL_WARN.set(key, warning);
  while (LOCAL.size > LOCAL_MAX) {
    const [k, old] = LOCAL.entries().next().value as [string, Shape3D];
    LOCAL.delete(k);
    LOCAL_WARN.delete(k);
    free(old); // placed copies hold their own handle to the geometry
  }
  return { key, shape, warning };
}

/** The memo's local solid for a key, if it still holds it (not counted as a use). */
export const peekLocalGear = (key: string): Shape3D | undefined => LOCAL.get(key);

/** `shape` moved by the rigid transform T: the same geometry under a new location (no copy). */
export function placeShape(shape: Shape3D, T: Rigid): Shape3D {
  const oc = getOC() as OcAny;
  const t = new oc.gp_Trsf();
  t.SetValues(T.x.x, T.y.x, T.z.x, T.origin.x, T.x.y, T.y.y, T.z.y, T.origin.y, T.x.z, T.y.z, T.z.z, T.origin.z);
  const b = new oc.BRepBuilderAPI_Transform(raw(shape), t, false, false);
  try { return castOwned(b.Shape()); } finally { b.delete(); t.delete(); }
}
