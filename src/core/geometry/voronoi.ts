// A Voronoi pattern wrapped around an axis: the 2D layout that feature.voronoi cuts through the wall of a
// hollow body (a lamp shade, a vase, a basket). Pure geometry, no kernel.
//
// The pattern lives in a strip unrolled from the wall: x runs round the axis (x = angle × `radius`, so one
// full turn is `period` = 2π·radius long and the strip wraps on itself), z runs along the axis. The cells
// are the Voronoi cells of the seeds in that periodic strip, so the pattern has no seam: the cell that
// straddles x = 0 is one cell, and turning every seed by an angle turns the whole pattern by it. A `twist`
// shears the strip so the cells lean with a twisted body: the point (x, z) sits at angle x/radius + τ(z).
//
// Each cell becomes an opening inset from its edges by half the web, measured in the wall's own metric (the
// cell's angles times the smallest wall radius it spans, so the real web is never narrower), and the
// openings may have rounded corners.

export interface P2 { x: number; y: number }

/** Deterministic PRNG (mulberry32): the same seed lays out the same cells everywhere. */
export function mulberry32(seed: number): () => number {
  let a = (Math.round(seed) | 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Signed area (CCW positive). */
export function polygonArea(poly: P2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Area centroid of a simple polygon. */
export function polygonCentroid(poly: P2[]): P2 {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const c = p.x * q.y - q.x * p.y;
    a += c; cx += (p.x + q.x) * c; cy += (p.y + q.y) * c;
  }
  if (Math.abs(a) < 1e-12) {
    const n = poly.length || 1;
    return { x: poly.reduce((s, p) => s + p.x, 0) / n, y: poly.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** Keep the part of a convex polygon where n·p ≥ c (Sutherland–Hodgman, one plane). */
export function clipHalfPlane(poly: P2[], n: P2, c: number): P2[] {
  const out: P2[] = [];
  const side = (p: P2) => n.x * p.x + n.y * p.y - c;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const sp = side(p), sq = side(q);
    if (sp >= 0) out.push(p);
    if ((sp >= 0) !== (sq >= 0)) {
      const t = sp / (sp - sq);
      out.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
    }
  }
  return out;
}

/** Drop repeated and collinear vertices (a clipped polygon picks up both). */
export function cleanPolygon(poly: P2[], tol = 1e-4): P2[] {
  let pts = poly.slice();
  for (let changed = true; changed && pts.length >= 3; ) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const ab = Math.hypot(b.x - a.x, b.y - a.y), bc = Math.hypot(c.x - b.x, c.y - b.y);
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (ab < tol || Math.abs(cross) < tol * Math.max(ab + bc, 1e-9) * 1e-2) { pts.splice(i, 1); changed = true; break; }
    }
  }
  return pts.length >= 3 ? pts : [];
}

/** A convex CCW polygon moved in by `d` on every edge: the points at least `d` from its outside. */
export function insetConvex(poly: P2[], d: number): P2[] {
  let out = poly.slice();
  for (let i = 0; i < poly.length && out.length >= 3; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const L = Math.hypot(q.x - p.x, q.y - p.y);
    if (L < 1e-12) continue;
    const n = { x: -(q.y - p.y) / L, y: (q.x - p.x) / L }; // inward for CCW
    out = clipHalfPlane(out, n, n.x * p.x + n.y * p.y + d);
  }
  return cleanPolygon(out);
}

/** How deep inside a convex CCW polygon a point lies: its distance to the nearest edge line (negative outside). */
export function insetDepth(poly: P2[], p: P2): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 1e-12) continue;
    d = Math.min(d, (-(b.y - a.y) * (p.x - a.x) + (b.x - a.x) * (p.y - a.y)) / L);
  }
  return d;
}

export interface VoronoiStripOptions {
  /** Seeds (cells). */
  count: number;
  /** Seed for the random layout: the same number gives the same pattern. */
  seed: number;
  /** One full turn round the axis, along x. */
  period: number;
  /** The strip's extent along the axis. */
  z0: number;
  z1: number;
  /** Lloyd relaxation passes (each moves every seed to its cell's centroid: evener cells). */
  relax: number;
}

export interface VoronoiStrip {
  seeds: P2[];
  /** Each seed's cell: a convex CCW polygon in strip coordinates (x round the axis, y = z along it),
   *  unwrapped next to its seed (it may reach past 0 or `period`: that part wraps round). */
  cells: P2[][];
}

/** The Voronoi cells of seeds in a strip that wraps round (periodic in x, bounded in z). */
export function periodicCells(seeds: P2[], period: number, z0: number, z1: number): P2[][] {
  return seeds.map((s, i) => {
    // the periodic cell lies within half a turn either side of its seed (its bisectors with its own images)
    let cell: P2[] = [
      { x: s.x - period / 2, y: z0 }, { x: s.x + period / 2, y: z0 },
      { x: s.x + period / 2, y: z1 }, { x: s.x - period / 2, y: z1 },
    ];
    for (let j = 0; j < seeds.length && cell.length >= 3; j++) {
      if (j === i) continue;
      // the image of seed j nearest seed i, and its neighbours a turn either side
      const base = seeds[j].x - period * Math.round((seeds[j].x - s.x) / period);
      for (const k of [-1, 0, 1]) {
        const o = { x: base + k * period, y: seeds[j].y };
        const n = { x: s.x - o.x, y: s.y - o.y };
        if (Math.hypot(n.x, n.y) < 1e-12) continue;
        const m = { x: (s.x + o.x) / 2, y: (s.y + o.y) / 2 };
        cell = clipHalfPlane(cell, n, n.x * m.x + n.y * m.y);
      }
    }
    return cleanPolygon(cell, 1e-9);
  });
}

/** Random seeds in the strip, relaxed toward even cells (Lloyd), and their cells. */
export function voronoiStrip(o: VoronoiStripOptions): VoronoiStrip {
  const n = Math.max(1, Math.round(o.count));
  if (!(o.period > 0) || !(o.z1 > o.z0)) throw new Error("voronoi: the band has no size");
  const rnd = mulberry32(o.seed);
  let seeds: P2[] = Array.from({ length: n }, () => ({ x: rnd() * o.period, y: o.z0 + rnd() * (o.z1 - o.z0) }));
  let cells = periodicCells(seeds, o.period, o.z0, o.z1);
  for (let k = 0; k < o.relax; k++) {
    seeds = cells.map((c, i) => {
      if (c.length < 3) return seeds[i];
      const g = polygonCentroid(c);
      return { x: ((g.x % o.period) + o.period) % o.period, y: g.y };
    });
    cells = periodicCells(seeds, o.period, o.z0, o.z1);
  }
  return { seeds, cells };
}

/** One piece of an opening's outline: a straight run, or an arc through `via`. */
export type OutlineSeg = { kind: "line"; to: P2 } | { kind: "arc"; to: P2; via: P2 };
export interface Outline { start: P2; segments: OutlineSeg[] }

/** A convex CCW polygon's outline with its corners rounded to radius `r` — the polygon must already be
 *  inset by `r` (the rounded outline then reaches `r` further out, as far as the polygon inset by 0 would). */
export function roundedOutline(core: P2[], r: number): Outline {
  const m = core.length;
  if (!(r > 1e-9)) return { start: core[0], segments: [...core.slice(1), core[0]].map((to) => ({ kind: "line" as const, to })) };
  const outward = (p: P2, q: P2): P2 => { const L = Math.hypot(q.x - p.x, q.y - p.y); return { x: (q.y - p.y) / L, y: -(q.x - p.x) / L }; };
  const pts: { a: P2; b: P2; via?: P2 }[] = core.map((v, i) => {
    const n1 = outward(core[(i + m - 1) % m], v), n2 = outward(v, core[(i + 1) % m]);
    const a = { x: v.x + r * n1.x, y: v.y + r * n1.y }, b = { x: v.x + r * n2.x, y: v.y + r * n2.y };
    const turn = Math.acos(Math.max(-1, Math.min(1, n1.x * n2.x + n1.y * n2.y)));
    if (turn < (2 * Math.PI) / 180) return { a, b }; // all but straight: no arc to speak of
    const h = { x: n1.x + n2.x, y: n1.y + n2.y }, L = Math.hypot(h.x, h.y);
    return { a, b, via: { x: v.x + (r * h.x) / L, y: v.y + (r * h.y) / L } };
  });
  const segments: OutlineSeg[] = [];
  for (let i = 0; i < m; i++) {
    const c = pts[i];
    if (c.via) segments.push({ kind: "arc", to: c.b, via: c.via });
    else if (Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y) > 1e-6) segments.push({ kind: "line", to: c.b });
    segments.push({ kind: "line", to: pts[(i + 1) % m].a });
  }
  return { start: pts[0].a, segments };
}

/** An outline stretched across by `k` (x only): a wall opening's outline on the cutter plane at distance k. */
export function scaleOutline(o: Outline, k: number): Outline {
  const at = (p: P2): P2 => ({ x: k * p.x, y: p.y });
  return { start: at(o.start), segments: o.segments.map((s) => (s.kind === "line" ? { kind: "line", to: at(s.to) } : { kind: "arc", to: at(s.to), via: at(s.via) })) };
}

/** Points along an outline (arcs sampled; lines cut into pieces no longer than `lineStep`), for measuring it. */
export function outlinePoints(o: Outline, perArc = 8, lineStep = Infinity): P2[] {
  const out: P2[] = [o.start];
  let at = o.start;
  for (const s of o.segments) {
    if (s.kind === "line") {
      const k = Math.max(1, Math.ceil(Math.hypot(s.to.x - at.x, s.to.y - at.y) / lineStep));
      for (let i = 1; i <= k; i++) out.push({ x: at.x + ((s.to.x - at.x) * i) / k, y: at.y + ((s.to.y - at.y) * i) / k });
      at = s.to;
      continue;
    }
    // circle through at, via, to
    const [a, b, c] = [at, s.via, s.to];
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    const ux = ((a.x ** 2 + a.y ** 2) * (b.y - c.y) + (b.x ** 2 + b.y ** 2) * (c.y - a.y) + (c.x ** 2 + c.y ** 2) * (a.y - b.y)) / d;
    const uy = ((a.x ** 2 + a.y ** 2) * (c.x - b.x) + (b.x ** 2 + b.y ** 2) * (a.x - c.x) + (c.x ** 2 + c.y ** 2) * (b.x - a.x)) / d;
    const R = Math.hypot(a.x - ux, a.y - uy);
    const ang = (p: P2) => Math.atan2(p.y - uy, p.x - ux);
    const a0 = ang(a), am = ang(b), a1 = ang(c);
    // sweep the way that passes through `via`
    const ccw = ((am - a0 + 4 * Math.PI) % (2 * Math.PI)) < ((a1 - a0 + 4 * Math.PI) % (2 * Math.PI));
    let sweep = ((a1 - a0 + 4 * Math.PI) % (2 * Math.PI));
    if (!ccw) sweep -= 2 * Math.PI;
    for (let k = 1; k <= perArc; k++) { const t = a0 + (sweep * k) / perArc; out.push({ x: ux + R * Math.cos(t), y: uy + R * Math.sin(t) }); }
    at = s.to;
  }
  return out;
}

// ---- reading the wall: where a ray from the axis crosses a triangulated body ----

/** A triangulated body in the axis frame (z along the axis), bucketed by height for ray casts. */
export class RadialProbe {
  private bins: number[][];
  readonly zMin: number;
  readonly zMax: number;
  private readonly step: number;
  constructor(private readonly p: ArrayLike<number>, private readonly tri: ArrayLike<number>, nBins = 128) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 2; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
    this.zMin = lo; this.zMax = hi;
    this.step = Math.max((hi - lo) / nBins, 1e-9);
    this.bins = Array.from({ length: nBins + 1 }, () => []);
    for (let t = 0; t < tri.length; t += 3) {
      const zs = [0, 1, 2].map((k) => p[3 * tri[t + k] + 2]);
      const b0 = this.bin(Math.min(...zs)), b1 = this.bin(Math.max(...zs));
      for (let b = b0; b <= b1; b++) this.bins[b].push(t);
    }
  }
  private bin(z: number): number { return Math.max(0, Math.min(this.bins.length - 1, Math.floor((z - this.zMin) / this.step))); }
  /** Distances from the axis at which the ray at angle θ, height z, crosses the surface (sorted, deduplicated). */
  hits(theta: number, z: number): number[] {
    const dx = Math.cos(theta), dy = Math.sin(theta);
    const p = this.p, tri = this.tri;
    const out: number[] = [];
    for (const t of this.bins[this.bin(z)]) {
      const i0 = 3 * tri[t], i1 = 3 * tri[t + 1], i2 = 3 * tri[t + 2];
      // quick reject: the triangle lies wholly behind the ray or wholly above / below it
      if (p[i0] * dx + p[i0 + 1] * dy < 0 && p[i1] * dx + p[i1 + 1] * dy < 0 && p[i2] * dx + p[i2 + 1] * dy < 0) continue;
      const z0 = p[i0 + 2], z1 = p[i1 + 2], z2 = p[i2 + 2];
      if ((z0 > z && z1 > z && z2 > z) || (z0 < z && z1 < z && z2 < z)) continue;
      // Möller–Trumbore, ray origin (0, 0, z), direction (dx, dy, 0)
      const e1x = p[i1] - p[i0], e1y = p[i1 + 1] - p[i0 + 1], e1z = z1 - z0;
      const e2x = p[i2] - p[i0], e2y = p[i2 + 1] - p[i0 + 1], e2z = z2 - z0;
      const hx = dy * e2z, hy = -dx * e2z, hz = dx * e2y - dy * e2x;
      const det = e1x * hx + e1y * hy + e1z * hz;
      if (Math.abs(det) < 1e-12) continue;
      const sx = -p[i0], sy = -p[i0 + 1], sz = z - z0;
      const u = (sx * hx + sy * hy + sz * hz) / det;
      if (u < -1e-9 || u > 1 + 1e-9) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy) / det;
      if (v < -1e-9 || u + v > 1 + 1e-9) continue;
      const r = (e2x * qx + e2y * qy + e2z * qz) / det;
      if (r > 1e-9) out.push(r);
    }
    out.sort((a, b) => a - b);
    return out.filter((r, i) => i === 0 || r - out[i - 1] > 1e-6);
  }
}

// ---- the openings ----

export interface VoronoiWallOptions {
  /** The body, triangulated, in the axis frame. */
  probe: RadialProbe;
  count: number;
  seed: number;
  relax: number;
  /** Least width of wall left between two openings, and between an opening and the band's ends. */
  web: number;
  /** Corner radius of the openings (0: sharp). */
  round: number;
  /** The band the openings fill, along the axis. */
  from: number;
  to: number;
  /** How far the pattern turns (radians) over the body's whole extent along the axis. */
  twist: number;
}

export interface WallOpening {
  /** Angle of the opening's middle: the cutter runs along this direction. */
  theta: number;
  /** The cutter runs between the planes square to `theta` at these distances from the axis (inside the
   *  wall's inner face and outside its outer face, everywhere across the opening). */
  rIn: number;
  rOut: number;
  /** The opening on those planes, scaled to distance 1: x = tan(angle − theta), y = height. A point on it
   *  lies on the plane at distance ρ at (ρ·x, y), so every edge of the cutter runs straight out from the axis. */
  outline: Outline;
  /** The opening as (angle, height) samples: its outline wrapped onto the wall. */
  polygon: P2[];
  /** The smallest wall (inner face) radius across the cell: the web was measured at it. */
  rWall: number;
}

export interface VoronoiWall {
  strip: VoronoiStrip;
  /** The radius the strip was unrolled at (mean inner radius over the band). */
  radius: number;
  openings: WallOpening[];
  /** Index (into strip.cells) of each opening's cell. */
  cellOf: number[];
  /** Cells too small to leave an opening once the web is taken off. */
  skipped: number;
}

/** Lay out a wrapped Voronoi pattern on the wall of a hollow body and size each cell's opening. */
export function voronoiWall(o: VoronoiWallOptions): VoronoiWall {
  const { probe } = o;
  if (!(o.web > 0)) throw new Error("voronoi: web must be positive");
  if (!(o.round >= 0)) throw new Error("voronoi: round must not be negative");
  if (!(o.to - o.from > 2 * o.web)) throw new Error("voronoi: the band (from → to) must be taller than two webs");
  const span = probe.zMax - probe.zMin;
  const tau = (z: number) => (span > 0 ? (o.twist * (z - probe.zMin)) / span : 0);
  const wall = (theta: number, z: number) => {
    const h = probe.hits(theta, z);
    if (h.length < 2) throw new Error("voronoi: the axis must run through the hollow inside of the body (a ray out from it should cross the wall's inner and outer faces)");
    return { rIn: h[0], rOut: h[h.length - 1] };
  };
  // unroll at the band's mean inner radius, so a cell is about as wide on the wall as it is tall
  let sum = 0, n = 0;
  for (let i = 0; i < 24; i++) for (let k = 0; k <= 6; k++) {
    const z = o.from + ((o.to - o.from) * (k + 0.5)) / 7.5;
    sum += wall((2 * Math.PI * i) / 24, z).rIn; n++;
  }
  const radius = sum / n;
  const period = 2 * Math.PI * radius;
  // the cells stop half a web inside the band, and each opening half a web inside its cell
  const strip = voronoiStrip({ count: o.count, seed: o.seed, period, z0: o.from + o.web / 2, z1: o.to - o.web / 2, relax: o.relax });
  const angleOf = (p: P2) => p.x / radius + tau(p.y);
  const openings: WallOpening[] = [], cellOf: number[] = [];
  let skipped = 0;
  strip.cells.forEach((cell, ci) => {
    if (cell.length < 3) { skipped++; return; }
    // the wall across the cell: its nearest inner face sets the scale the web is measured at
    const g = polygonCentroid(cell);
    const samples: P2[] = [g];
    cell.forEach((v, i) => {
      const w = cell[(i + 1) % cell.length];
      const m = { x: (v.x + w.x) / 2, y: (v.y + w.y) / 2 };
      samples.push(v, m, { x: (v.x + g.x) / 2, y: (v.y + g.y) / 2 }, { x: (m.x + g.x) / 2, y: (m.y + g.y) / 2 });
    });
    let rWall = Infinity, rFar = 0;
    for (const s of samples) { const r = wall(angleOf(s), s.y); rWall = Math.min(rWall, r.rIn); rFar = Math.max(rFar, r.rOut); }
    rWall *= 0.99; // between samples a flat face can come a little nearer
    // the cell on the wall, in its own metric: (angle × rWall, height) — a shear of the strip, still convex
    const local = cell.map((p) => ({ x: angleOf(p) * rWall, y: p.y }));
    if (insetConvex(local, o.web / 2 + Math.max(o.round, o.web / 4)).length < 3) { skipped++; return; }
    // The cutter's edges run straight on its planes, i.e. straight in tan(angle − theta), not in angle: a
    // hair off the inset outline. Measure how far they stray toward the cell's edge, and inset that much more.
    const build = (extra: number) => {
      const core = insetConvex(local, o.web / 2 + o.round + extra);
      if (core.length < 3) return undefined;
      const outlineLocal = roundedOutline(core, o.round);
      const theta = polygonCentroid(core).x / rWall;
      const toPlane = (p: P2): P2 => ({ x: Math.tan(p.x / rWall - theta), y: p.y });
      const outline: Outline = {
        start: toPlane(outlineLocal.start),
        segments: outlineLocal.segments.map((s) => (s.kind === "line" ? { kind: "line", to: toPlane(s.to) } : { kind: "arc", to: toPlane(s.to), via: toPlane(s.via) })),
      };
      // the cutter's real outline, wrapped back onto the wall, in the cell's metric
      const real = outlinePoints(scaleOutline(outline, rWall), 8, 0.25).map((p) => ({ x: (theta + Math.atan(p.x / rWall)) * rWall, y: p.y }));
      const stray = Math.max(0, ...real.map((p) => o.web / 2 - insetDepth(local, p)));
      return { theta, outline, real, stray };
    };
    let cut = build(0);
    for (let extra = 0, k = 0; cut && cut.stray > 0 && k < 4; k++) { extra += cut.stray * 1.25 + 1e-6; cut = build(extra); }
    if (!cut) { skipped++; return; }
    const { theta, outline, real } = cut;
    const half = Math.max(...real.map((p) => Math.abs(p.x / rWall - theta)));
    if (half > Math.PI / 3) throw new Error(`voronoi: a cell spans ${Math.round((2 * half * 180) / Math.PI)}° round the axis; use more cells`);
    openings.push({
      theta, outline, rWall,
      rIn: (rWall - 1) * Math.cos(half),
      rOut: 1.02 * rFar + 1,
      polygon: real.map((p) => ({ x: p.x / rWall, y: p.y })),
    });
    cellOf.push(ci);
  });
  return { strip, radius, openings, cellOf, skipped };
}
