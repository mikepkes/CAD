// The OCC side of 3D gears (see core/geometry/gear.ts for the tooth maths):
// one involute outline turned into the solid a 3D-printing user expects —
// straight, helical (a true helical sweep), herringbone (two mirrored helical
// halves), internal ring gears (the toothed bore cut from a rim), racks
// (straight / slanted / chevron), straight bevel gears (the outline tapered to
// the pitch-cone apex: every flank is a cone through the apex) and worms (a
// rack-section thread). Printable extras — a bore with a D-flat or keyway, a
// hub and spoked windows — are cut and joined last, away from the teeth.
//
// Built in the gear's own frame: axis +Z, the gear from z = 0 to its face
// width (a bevel gear's heel at z = 0, its apex up the axis; a rack along X
// with teeth toward +Y; a worm along +Z). The feature places it.

import { getOC, cast, makeLine, makeCircle, makeThreePointArc, makeBezierCurve, assembleWire, makeFace, makeSolid, twistExtrude, complexExtrude, loft, makeBox, type Shape3D, type Wire, type Edge } from "replicad";
import { gearOutline, bevelOutline, GearOutline, GearType, OutlineEdge, wormGeometry } from "../geometry/gear";
import type { Pt } from "../geometry/spline";
import type { Rigid } from "../../math/transform";
import { fuseShapes, cutShapes, intersectShapes, translateShape, volumeOfShape } from "./kernel";

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
  try { b.Build(); return cast(b.Shape()) as unknown as Shape3D; } finally { b.delete(); vec.delete(); }
}

/** A planar face bounded by `outer` with `holes`, its loops oriented properly whatever their winding. */
function capFace(outer: Wire, holes: Wire[] = []): Shape3D {
  const oc = getOC() as OcAny;
  const f = makeFace(outer, holes);
  const fix = new oc.ShapeFix_Face(raw(f));
  try {
    fix.FixOrientation();
    return cast(fix.Face()) as unknown as Shape3D;
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

/** A loop of the region: gear pieces (which twist, unless `fixed`: a bore or a window) or a plain circle about the axis. */
type RegionLoop = { pieces: Piece[]; fixed?: boolean } | { circle: number };

function loopWire(l: RegionLoop, z: number): Wire {
  if ("circle" in l) {
    const e = makeCircle(l.circle, [0, 0, z], [0, 0, 1]);
    try { return assembleWire([e]); } finally { free(e); }
  }
  return piecesWire(l.pieces, z);
}

/** One loop swept from z0 to z1 as an open shell, with its start and end wires. */
function sweptLoop(l: RegionLoop, z0: number, z1: number, twistPerMm: number): [Shape3D, Wire, Wire] {
  const w = loopWire(l, z0);
  try {
    const turn = "circle" in l || l.fixed ? 0 : (twistPerMm * (z1 - z0)) / DEG;
    return (Math.abs(turn) < 1e-9
      ? complexExtrude(w, [0, 0, z0], [0, 0, z1 - z0], undefined, true)
      : twistExtrude(w, turn, [0, 0, z0], [0, 0, z1 - z0], undefined, true)) as unknown as [Shape3D, Wire, Wire];
  } finally { free(w); }
}

/** The region from z0 to z1, straight (twist 0), helical, or herringbone (see above). */
function regionBody(loops: RegionLoop[], z0: number, z1: number, twistPerMm: number, herringbone: boolean): Shape3D {
  const twists = Math.abs(twistPerMm) > 1e-12 && loops.some((l) => "pieces" in l && !l.fixed);
  if (!twists) {
    const wires = loops.map((l) => loopWire(l, z0));
    const face = capFace(wires[0], wires.slice(1));
    try { return prism(face, [0, 0, z1 - z0]); } finally { free(face, ...wires); }
  }
  const zEnd = herringbone ? (z0 + z1) / 2 : z1;
  const swept = loops.map((l) => sweptLoop(l, z0, zEnd, twistPerMm));
  const shells = swept.map((x) => x[0]);
  const startFace = capFace(swept[0][1], swept.slice(1).map((x) => x[1]));
  const pieces: Shape3D[] = [startFace, ...shells];
  if (herringbone) pieces.push(...[startFace, ...shells].map((x) => mirrorZ(x, zEnd)));
  else pieces.push(capFace(swept[0][2], swept.slice(1).map((x) => x[2])));
  try {
    const solid = makeSolid(pieces as never) as unknown as Shape3D;
    if (!(volumeOfShape(solid) > 0)) { free(solid); throw new Error("the helical sweep did not close into a solid"); }
    return solid;
  } finally { free(...pieces, ...swept.flatMap((x) => [x[1], x[2]])); }
}

/** Mirror a shape in the plane z = c (a copy). */
function mirrorZ(shape: Shape3D, c: number): Shape3D {
  const copy = (shape as unknown as { clone: () => Shape3D }).clone();
  return (copy as unknown as { mirror: (n: P3, o: P3) => Shape3D }).mirror([0, 0, 1], [0, 0, c]);
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

/** The holes a round gear's web carries: the bore and, with spokes, the windows between the hub and
 *  a rim `rim` inside `rInner` (the root circle). */
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

/** A hub of diameter `hubDiameter`, `hubLength` beyond the face at z (upward when dir = 1), bored like the gear. */
function hubSolid(s: GearSolidSpec, z: number, dir: 1 | -1): Shape3D | null {
  const d = s.hubDiameter ?? 0, L = s.hubLength ?? 0;
  if (!(d > 0 && L > 0)) return null;
  const bore = boreLoop(s);
  // overlap the gear by a hair so the fuse has volume to merge
  const z0 = dir > 0 ? z - 1e-3 : z - L, z1 = dir > 0 ? z + L : z + 1e-3;
  return regionBody([{ circle: d / 2 }, ...(bore ? [bore] : [])], z0, z1, 0, false);
}

/** Join a hub onto a gear body (consumes the body). */
function withHub(body: Shape3D, hub: Shape3D | null): Shape3D {
  if (!hub) return body;
  try { return fuseShapes(body, hub); } finally { free(body, hub); }
}

// ---- the gear types ---------------------------------------------------------------------

const profileSpec = (s: GearSolidSpec, type: GearType, teeth = s.teeth) => ({
  type, module: s.module, teeth, pressureAngle: s.pressureAngle, addendum: s.addendum, dedendum: s.dedendum,
  backlash: s.backlash, rootFillet: s.rootFillet, samples: 10,
  ...(type === "rack" ? { rackHeight: s.rim } : {}),
});

/** Twist rate (rad/mm) of a helical gear of pitch radius rp: a tooth advances tan β per mm along the axis. */
const twistRate = (helixDeg: number, rp: number) => Math.tan(helixDeg * DEG) / rp;

function cylindricalGear(s: GearSolidSpec): Shape3D {
  const o = gearOutline(profileSpec(s, "external"));
  const helix = s.type === "spur" ? 0 : (s.helixAngle ?? 0);
  const body = regionBody([{ pieces: outlinePieces(o) }, ...webHoles(s, o.radii!.root)], 0, s.faceWidth, twistRate(helix, o.radii!.pitch), s.type === "herringbone" || !!s.herringbone);
  return withHub(body, hubSolid(s, s.faceWidth, 1));
}

function ringGear(s: GearSolidSpec): Shape3D {
  const o = gearOutline(profileSpec(s, "internal"));
  const rOut = o.radii!.root + (s.rim ?? 3 * s.module);
  return regionBody([{ circle: rOut }, { pieces: outlinePieces(o) }], 0, s.faceWidth, twistRate(s.helixAngle ?? 0, o.radii!.pitch), !!s.herringbone);
}

function rackGear(s: GearSolidSpec): Shape3D {
  const h = s.faceWidth;
  const slope = Math.tan((s.helixAngle ?? 0) * DEG); // x shift per mm along Z
  if (Math.abs(slope) < 1e-12) return regionBody([{ pieces: outlinePieces(gearOutline(profileSpec(s, "rack"))) }], 0, h, 0, false);
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
  try { return intersectShapes(body, box); } finally { free(body, box); }
}

function bevelGear(s: GearSolidSpec): Shape3D {
  const o = bevelOutline({ ...profileSpec(s, "external"), mateTeeth: s.mateTeeth ?? s.teeth });
  const bg = o.bevel;
  if (!(s.faceWidth < bg.coneDistance * 0.6)) throw new Error(`bevel face width must be under ${(bg.coneDistance * 0.6).toFixed(2)} (60% of the cone distance)`);
  const pieces = outlinePieces(o);
  const k = 1 - s.faceWidth / bg.coneDistance;  // the toe is the heel scaled toward the apex
  const zt = s.faceWidth * Math.cos(bg.pitchAngle);
  const heel = piecesWire(pieces, 0, 1), toe = piecesWire(pieces, zt, k);
  let body: Shape3D;
  try { body = loft([heel, toe], { ruled: true }) as unknown as Shape3D; } finally { free(heel, toe); }
  // the bore and windows cut through the cone, then the hub behind the heel
  const holes = webHoles(s, o.radii!.root * k);
  if (holes.length) {
    for (const h of holes) {
      const tool = regionBody([h], -1, zt + 1, 0, false);
      const cut = cutShapes(body, tool); free(body, tool);
      body = cut;
    }
  }
  return withHub(body, hubSolid(s, 0, -1));
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
function worm(s: GearSolidSpec): Shape3D {
  const leftHand = (s.helixAngle ?? 1) < 0;
  const w = wormGeometry(s.module, Math.max(1, Math.round(s.teeth)), s.wormDiameter ?? 10 * s.module, { pressureAngle: s.pressureAngle, addendum: s.addendum, dedendum: s.dedendum, backlash: s.backlash });
  const bore = boreLoop(s);
  if (bore && (s.bore ?? 0) / 2 > w.rootRadius - 0.8) throw new Error(`worm bore must leave a wall: at most ${(2 * (w.rootRadius - 0.8)).toFixed(2)} mm`);
  return regionBody([{ pieces: wormSection(w, leftHand) }, ...(bore ? [bore] : [])], 0, s.faceWidth, ((leftHand ? -1 : 1) * 2 * Math.PI) / w.lead, false);
}

/** Build a gear solid in its own frame (axis +Z; see the module comment). */
export function buildGearSolid(s: GearSolidSpec): Shape3D {
  if (!(s.module > 0)) throw new Error("module must be positive");
  if (!(s.faceWidth > 0)) throw new Error("face width must be positive");
  switch (s.type) {
    case "spur": case "helical": case "herringbone": return cylindricalGear(s);
    case "ring": return ringGear(s);
    case "rack": return rackGear(s);
    case "bevel": return bevelGear(s);
    case "worm": return worm(s);
  }
  throw new Error(`unknown gear type "${s.type}"`);
}


// ---- built once, placed many times ----------------------------------------------------------
//
// A gear's solid depends only on its numbers, not on where it is: a gear on a
// revolute joint is the same solid at every angle. So the local solid is built
// once per spec (kept, least recently used dropped) and each placement is the
// same geometry under a new location — no rebuild, no copy — which is what
// keeps a clockwork of helical gears turning at slider speed.

const LOCAL = new Map<string, Shape3D>();
const LOCAL_MAX = 48;

/** A stable key for a gear spec (the same numbers → the same key). */
export function gearSolidKey(s: GearSolidSpec): string {
  return JSON.stringify(Object.keys(s).sort().flatMap((k) => { const v = (s as unknown as Record<string, unknown>)[k]; return v === undefined ? [] : [[k, v]]; }));
}

/** The gear in its own frame, built once per spec. Owned by the memo: place it, don't delete it. */
export function localGearSolid(s: GearSolidSpec): { key: string; shape: Shape3D } {
  const key = gearSolidKey(s);
  const hit = LOCAL.get(key);
  if (hit) { LOCAL.delete(key); LOCAL.set(key, hit); return { key, shape: hit }; }
  const shape = buildGearSolid(s);
  LOCAL.set(key, shape);
  while (LOCAL.size > LOCAL_MAX) {
    const [k, old] = LOCAL.entries().next().value as [string, Shape3D];
    LOCAL.delete(k);
    free(old); // placed copies hold their own handle to the geometry
  }
  return { key, shape };
}

/** The memo's local solid for a key, if it still holds it (not counted as a use). */
export const peekLocalGear = (key: string): Shape3D | undefined => LOCAL.get(key);

/** `shape` moved by the rigid transform T: the same geometry under a new location (no copy). */
export function placeShape(shape: Shape3D, T: Rigid): Shape3D {
  const oc = getOC() as OcAny;
  const t = new oc.gp_Trsf();
  t.SetValues(T.x.x, T.y.x, T.z.x, T.origin.x, T.x.y, T.y.y, T.z.y, T.origin.y, T.x.z, T.y.z, T.z.z, T.origin.z);
  const b = new oc.BRepBuilderAPI_Transform(raw(shape), t, false, false);
  try { return cast(b.Shape()) as unknown as Shape3D; } finally { b.delete(); t.delete(); }
}
