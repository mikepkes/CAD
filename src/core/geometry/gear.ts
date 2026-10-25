// Involute gearing: external spur gears, internal (ring) gears and racks from
// one specification, generated the way the real cutting process defines them.
//
// - Flanks are true involutes of the base circle (external/internal) or the
//   straight basic-rack flank (rack) — the exact conjugate of the involute.
// - External root fillets are the trochoid swept by the rounded tip of the
//   generating rack as it rolls on the pitch circle, offset by the tip radius;
//   on small tooth counts that curve crosses the involute, which is undercut,
//   and the outline follows it (the flank starts where the cutter left it).
// - Racks get exact tangent root fillets; internal gears a plain root arc.
//
// Output is a closed outline (lines / arcs / spline through-points) in gear
// coordinates plus reference circles; the sketch command turns it into entities.

import { Pt } from "./spline";

export type GearType = "external" | "internal" | "rack";

export interface GearSpec {
  type?: GearType;
  /** Module (mm per tooth): pitch diameter = module × teeth; rack pitch = π × module. */
  module: number;
  teeth: number;
  /** Pressure angle in degrees (20 standard; 14.5 legacy). */
  pressureAngle?: number;
  /** Addendum / dedendum as multiples of the module (1 and 1.25 standard). */
  addendum?: number;
  dedendum?: number;
  /** Backlash: tooth thinning at the pitch circle/line, mm. */
  backlash?: number;
  /** Through-points per flank (and per fillet) spline. */
  samples?: number;
  /** Root fillet as the generating cutter's tip radius, × module (0.38 standard; 0 = sharp). */
  rootFillet?: number;
  /** Internal gears: rim material outside the root circle, × module. */
  rimThickness?: number;
  /** Racks: body depth below the root line, mm. */
  rackHeight?: number;
}

export type OutlineEdge =
  | { kind: "line"; to: Pt; filletAtEnd?: number }
  | { kind: "arc"; to: Pt; r: number; ccw: boolean }
  | { kind: "spline"; through: Pt[] }; // after the current point, ending at the edge's end

export interface GearOutline {
  type: GearType;
  start: Pt;
  edges: OutlineEdge[];
  /** Real (non-construction) circles that are part of the profile (an internal gear's rim). */
  circles: { r: number }[];
  /** Reference circles (construction): pitch, base, tip, root. */
  reference: { name: string; r: number }[];
  /** Rack only: the pitch line (v = 0) and the overall length. */
  rack?: { length: number; pitch: number; pitchLineV: number };
  radii?: { pitch: number; base: number; tip: number; root: number };
  summary: string;
}

const TAU = Math.PI * 2;
const rot = (p: Pt, a: number): Pt => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) });
const polar = (r: number, a: number): Pt => ({ x: r * Math.cos(a), y: r * Math.sin(a) });
const inv = (t: number) => t - Math.atan(t); // involute function of the roll parameter t = tan(pressure angle at r)
const f3 = (n: number) => Math.round(n * 1000) / 1000;

function resolved(spec: GearSpec) {
  const m = spec.module, N = Math.round(spec.teeth);
  if (!(m > 0)) throw new Error("module must be positive");
  if (N < 3) throw new Error("a gear needs at least 3 teeth");
  const alpha = ((spec.pressureAngle ?? 20) * Math.PI) / 180;
  if (!(alpha > 0 && alpha < Math.PI / 2)) throw new Error("pressure angle must be between 0 and 90 degrees");
  return {
    m, N, alpha,
    ha: spec.addendum ?? 1,
    hf: spec.dedendum ?? 1.25,
    backlash: spec.backlash ?? 0,
    samples: Math.max(3, Math.round(spec.samples ?? 8)),
    rho: (spec.rootFillet ?? 0.38) * m,
  };
}

/** Intersection of segments ab and cd (strictly interior), or null. */
function segmentHit(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const r = { x: b.x - a.x, y: b.y - a.y }, q = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * q.y - r.y * q.x;
  if (Math.abs(den) < 1e-14) return null;
  const ac = { x: c.x - a.x, y: c.y - a.y };
  const t = (ac.x * q.y - ac.y * q.x) / den;
  const u = (ac.x * r.y - ac.y * r.x) / den;
  if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) return null;
  return { x: a.x + r.x * t, y: a.y + r.y * t };
}

/** Cut every self-intersecting loop out of a polyline, keeping the path from start to end. */
function removeLoops(pts: Pt[]): Pt[] {
  const out = pts.slice();
  for (let i = 0; i < out.length - 3; i++) {
    for (let j = out.length - 2; j > i + 1; j--) {
      const x = segmentHit(out[i], out[i + 1], out[j], out[j + 1]);
      if (x) { out.splice(i + 1, j - i, x); break; }
    }
  }
  return out;
}

/** Resample a polyline to `n` points spaced evenly by arc length (ends kept). */
function resample(pts: Pt[], n: number): Pt[] {
  if (pts.length <= 2 || n <= 2) return [pts[0], pts[pts.length - 1]];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = cum[cum.length - 1];
  const out: Pt[] = [pts[0]];
  let j = 1;
  for (let k = 1; k < n - 1; k++) {
    const s = (total * k) / (n - 1);
    while (j < pts.length - 1 && cum[j] < s) j++;
    const t = (s - cum[j - 1]) / ((cum[j] - cum[j - 1]) || 1);
    out.push({ x: pts[j - 1].x + (pts[j].x - pts[j - 1].x) * t, y: pts[j - 1].y + (pts[j].y - pts[j - 1].y) * t });
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// ---- external spur gear ------------------------------------------------------

interface ToothCurves {
  /** Left-flank root fillet, root circle → contact with the involute (tooth centred at angle 0). */
  fillet: Pt[] | null;
  /** Left flank involute, contact (or base/root) → tip. */
  flank: Pt[];
  /** Radial stem from the root circle to the flank start (sharp-root gears whose root lies inside the base circle). */
  stem: Pt | null;
  rootHalfAngle: number;
}

/**
 * The left half of one external tooth (centred at angle 0), including the root
 * fillet generated by a rack cutter of tip radius `rho` rolling on the pitch
 * circle. Mirror for the right half.
 */
function externalTooth(g: ReturnType<typeof resolved>) {
  const { m, N, alpha, ha, hf, backlash, samples, rho } = g;
  const rp = (m * N) / 2;
  const rb = rp * Math.cos(alpha);
  const ra = rp + ha * m;
  const rf = rp - hf * m;
  if (rf <= 0) throw new Error("dedendum too large for this gear");
  if (ra <= rb) throw new Error("tip circle inside the base circle — increase the addendum");
  if (rho < 0 || rho > hf * m) throw new Error("rootFillet must be between 0 and the dedendum");
  const tAt = (r: number) => Math.sqrt(Math.max(0, (r / rb) ** 2 - 1));
  // Half tooth angle at the pitch circle (circular thickness πm/2 − backlash), carried to the base circle.
  const thetaP = ((Math.PI * m) / 2 - backlash) / (2 * rp);
  const thetaB = thetaP + inv(Math.tan(alpha));
  const flankAngle = (r: number) => thetaB - inv(tAt(r)); // half tooth angle at radius r ≥ rb
  const tA = tAt(ra);
  if (flankAngle(ra) <= 1e-4) throw new Error("tooth tip comes to a point — reduce the addendum or use more teeth");

  const involute = (rFrom: number, rTo: number): Pt[] => {
    const t0 = tAt(rFrom), t1 = tAt(rTo);
    const out: Pt[] = [];
    for (let i = 0; i <= samples; i++) {
      const t = t0 + ((t1 - t0) * i) / samples;
      const r = rb * Math.sqrt(1 + t * t);
      out.push(polar(r, thetaB - inv(t))); // left flank: positive angles
    }
    return out;
  };

  let tooth: ToothCurves;
  if (rho <= 1e-9) {
    // Sharp root: involute from the base circle (or the root circle when that is outside it) plus a radial stem.
    const hasStem = rf < rb;
    const rStart = hasStem ? rb : rf;
    const flank = involute(rStart, ra);
    tooth = { fillet: null, flank, stem: hasStem ? polar(rf, thetaB) : null, rootHalfAngle: hasStem ? thetaB : flankAngle(rf) };
  } else {
    // Generating rack: pitch line tangent to the pitch circle at (0, rp), teeth pointing down.
    // Its tooth centred on x=0 cuts the space centred at 90°; the tooth to the right of that
    // space sits at angle aT, and its LEFT flank fillet is traced by the rack tooth's right corner.
    const aT = Math.PI / 2 - Math.PI / N;
    const halfThickPitchRack = (Math.PI * m) / 4 + backlash / 2; // rack tooth = gear space (+ backlash)
    const dC = hf * m - rho; // corner-circle centre depth below the pitch line
    const xC = halfThickPitchRack - dC * Math.tan(alpha) - rho / Math.cos(alpha);
    const yC = rp - dC;
    // Trochoid of the corner-circle centre in the gear frame: gear turns CCW by φ, rack slides −rp·φ.
    const centre = (phi: number): Pt => rot({ x: xC - rp * phi, y: yC }, -phi);
    const span = Math.min(1.2, (4 * Math.PI) / N);
    const STEPS = 1600;
    const centres: { c: Pt; n: Pt }[] = [];
    for (let i = 0; i <= STEPS; i++) {
      const phi = -span + (2 * span * i) / STEPS;
      const c = centre(phi);
      const h = 1e-5;
      const c1 = centre(phi + h), c0 = centre(phi - h);
      const d = { x: (c1.x - c0.x) / (2 * h), y: (c1.y - c0.y) / (2 * h) };
      const L = Math.hypot(d.x, d.y) || 1;
      centres.push({ c, n: { x: -d.y / L, y: d.x / L } }); // left-hand normal, continuous along the path
    }
    // The envelope of the tip circle is the centre path offset by ρ along a
    // CONTINUOUS normal (fixed sign, chosen at the root to point toward the gear
    // centre). Where the path's curvature exceeds 1/ρ the offset folds into a
    // swallowtail — that is the undercut, handled by removeLoops below.
    let iRoot = 0;
    for (let i = 1; i < centres.length; i++) if (Math.hypot(centres[i].c.x, centres[i].c.y) < Math.hypot(centres[iRoot].c.x, centres[iRoot].c.y)) iRoot = i;
    const n0 = centres[iRoot].n, c0 = centres[iRoot].c;
    const sign = n0.x * c0.x + n0.y * c0.y > 0 ? -1 : 1;
    const fillet = centres.map(({ c, n }) => {
      const p = { x: c.x + sign * rho * n.x, y: c.y + sign * rho * n.y };
      return { p, r: Math.hypot(p.x, p.y), a: Math.atan2(p.y, p.x) };
    });
    // Walk from the root toward the tooth (decreasing angle) until the envelope meets the involute:
    // g ≤ 0 means the cutter has reached (or crossed = undercut) the involute flank.
    const dir = fillet[Math.min(iRoot + 1, fillet.length - 1)].a < fillet[iRoot].a ? 1 : -1;
    let iContact = -1, iBest = -1, best = Infinity;
    for (let i = iRoot; i >= 0 && i < fillet.length; i += dir) {
      const f = fillet[i];
      if (f.r < rb) continue;
      if (f.r > ra) break;
      const gval = f.a - (aT + flankAngle(f.r));
      if (gval <= 0) { iContact = i; break; }
      if (gval < best) { best = gval; iBest = i; }
    }
    if (iContact < 0) iContact = iBest;
    if (iContact < 0) throw new Error("root fillet never reaches the involute — reduce rootFillet or the dedendum");
    const lo = Math.min(iRoot, iContact), hi = Math.max(iRoot, iContact);
    let curve = fillet.slice(lo, hi + 1).map((f) => f.p);
    if (iContact < iRoot) curve = curve.reverse(); // root → contact
    // Undercut: where the trochoid bends tighter than ρ its offset folds into a
    // swallowtail. The cutter has swept the loop's interior, so the real
    // boundary jumps across at the self-intersection.
    curve = removeLoops(curve);
    curve = curve.map((p) => rot(p, -aT)); // into the tooth-at-0 frame
    const rContact = fillet[iContact].r;
    const filletPts = resample(curve, samples + 1);
    const flank = involute(rContact, ra);
    filletPts[filletPts.length - 1] = flank[0]; // share the exact joint
    // Snap the root end onto the root circle at its true angle.
    const root = filletPts[0];
    const rootAngle = Math.atan2(root.y, root.x);
    filletPts[0] = polar(rf, rootAngle);
    tooth = { fillet: filletPts, flank, stem: null, rootHalfAngle: rootAngle };
  }
  if (tooth.rootHalfAngle * 2 >= TAU / N - 1e-6) throw new Error("teeth overlap at the root — fewer dedendum/fillet, a larger pressure angle or more teeth");
  return { tooth, radii: { pitch: rp, base: rb, tip: ra, root: rf }, tA };
}

function externalOutline(spec: GearSpec): GearOutline {
  const g = resolved(spec);
  const { tooth, radii } = externalTooth(g);
  const N = g.N, step = TAU / N;
  const mirror = (p: Pt): Pt => ({ x: p.x, y: -p.y });
  const edges: OutlineEdge[] = [];
  // Per tooth (centred at k·step), walked CCW: right half (mirrored, root → tip), tip arc, left half (tip → root), root arc.
  const rootPt = (k: number, side: 1 | -1) => rot(polar(radii.root, side * tooth.rootHalfAngle), k * step);
  const start = rootPt(0, -1);
  for (let k = 0; k < N; k++) {
    const R = (p: Pt) => rot(p, k * step);
    const rightFillet = tooth.fillet ? tooth.fillet.map(mirror).map(R) : null;
    const rightFlank = tooth.flank.map(mirror).map(R);
    const leftFlank = tooth.flank.map(R);
    const leftFillet = tooth.fillet ? tooth.fillet.map(R) : null;
    if (rightFillet) edges.push({ kind: "spline", through: rightFillet.slice(1) });
    else if (tooth.stem) edges.push({ kind: "line", to: rightFlank[0] });
    edges.push({ kind: "spline", through: rightFlank.slice(1) });
    edges.push({ kind: "arc", to: leftFlank[leftFlank.length - 1], r: radii.tip, ccw: true });
    edges.push({ kind: "spline", through: [...leftFlank].reverse().slice(1) });
    if (leftFillet) edges.push({ kind: "spline", through: [...leftFillet].reverse().slice(1) });
    else if (tooth.stem) edges.push({ kind: "line", to: R(mirror(tooth.stem)) });
    // Root arc to the next tooth (back to the start on the last one).
    edges.push({ kind: "arc", to: rootPt((k + 1) % N, -1), r: radii.root, ccw: true });
  }
  return {
    type: "external", start, edges, circles: [], radii,
    reference: [{ name: "pitch", r: radii.pitch }, { name: "base", r: radii.base }, { name: "tip", r: radii.tip }, { name: "root", r: radii.root }],
    summary: `External involute gear: ${N} teeth, module ${g.m}, ${f3((g.alpha * 180) / Math.PI)}° PA; pitch r=${f3(radii.pitch)}, base r=${f3(radii.base)}, tip r=${f3(radii.tip)}, root r=${f3(radii.root)}${tooth.fillet ? `, root fillet ρ=${f3(g.rho)}` : ", sharp root"}`,
  };
}

// ---- internal (ring) gear -----------------------------------------------------

function internalOutline(spec: GearSpec): GearOutline {
  const g = resolved(spec);
  const { m, N, alpha, ha, hf, backlash, samples } = g;
  const rp = (m * N) / 2, rb = rp * Math.cos(alpha);
  const rt = rp - ha * m; // tips point inward
  const rr = rp + hf * m; // roots are outside
  const rim = rr + (spec.rimThickness ?? 3) * m;
  if (rt <= 0) throw new Error("addendum too large for this internal gear");
  const tAt = (r: number) => Math.sqrt(Math.max(0, (r / rb) ** 2 - 1));
  // The internal tooth is the material between two external-type spaces: its half angle is π/N − (external half angle).
  const thetaP = ((Math.PI * m) / 2 - backlash) / (2 * rp);
  const thetaB = thetaP + inv(Math.tan(alpha));
  const halfAngle = (r: number) => Math.PI / N - (thetaB - inv(tAt(r)));
  const hasStem = rt < rb;
  const rStart = hasStem ? rb : rt;
  if (halfAngle(rStart) <= 1e-4) throw new Error("internal tooth tip comes to a point — reduce the addendum or use more teeth");
  const flank = (): Pt[] => { // tip → root, positive angles (left flank)
    const t0 = tAt(rStart), t1 = tAt(rr);
    const out: Pt[] = [];
    for (let i = 0; i <= samples; i++) {
      const t = t0 + ((t1 - t0) * i) / samples;
      const r = rb * Math.sqrt(1 + t * t);
      out.push(polar(r, halfAngle(r)));
    }
    return out;
  };
  const left = flank();
  const mirror = (p: Pt): Pt => ({ x: p.x, y: -p.y });
  const step = TAU / N;
  const edges: OutlineEdge[] = [];
  const rootPt = (k: number, side: 1 | -1) => rot(polar(rr, side * halfAngle(rr)), k * step);
  const start = rootPt(0, -1);
  for (let k = 0; k < N; k++) {
    const R = (p: Pt) => rot(p, k * step);
    const rightIn = [...left].reverse().map(mirror).map(R); // root → tip, negative angles
    const leftOut = left.map(R);                             // tip → root
    edges.push({ kind: "spline", through: rightIn.slice(1) });
    if (hasStem) edges.push({ kind: "line", to: R(polar(rt, -halfAngle(rStart))) });
    edges.push({ kind: "arc", to: R(polar(rt, halfAngle(rStart))), r: rt, ccw: true });
    if (hasStem) edges.push({ kind: "line", to: leftOut[0] });
    edges.push({ kind: "spline", through: leftOut.slice(1) });
    edges.push({ kind: "arc", to: rootPt((k + 1) % N, -1), r: rr, ccw: true });
  }
  return {
    type: "internal", start, edges, circles: [{ r: rim }], radii: { pitch: rp, base: rb, tip: rt, root: rr },
    reference: [{ name: "pitch", r: rp }, { name: "base", r: rb }, { name: "tip", r: rt }, { name: "root", r: rr }],
    summary: `Internal involute gear: ${N} teeth, module ${m}; pitch r=${f3(rp)}, tip r=${f3(rt)}, root r=${f3(rr)}, rim r=${f3(rim)}`,
  };
}

// ---- rack -----------------------------------------------------------------------

function rackOutline(spec: GearSpec): GearOutline {
  const g = resolved(spec);
  const { m, N, alpha, ha, hf, backlash, rho } = g;
  const pitch = Math.PI * m;
  const length = N * pitch;
  const tipV = ha * m, rootV = -hf * m;
  const bottomV = rootV - (spec.rackHeight ?? 2 * m);
  // Basic rack: straight flanks at the pressure angle; half thickness at the pitch line πm/4 (− backlash/2).
  const wP = pitch / 4 - backlash / 2;
  const wTip = wP - tipV * Math.tan(alpha);
  const wRoot = wP - rootV * Math.tan(alpha);
  if (wTip <= 1e-6) throw new Error("rack tooth tip comes to a point — reduce the addendum");
  if (2 * wRoot >= pitch - 1e-6) throw new Error("rack teeth overlap at the root — reduce the dedendum");
  // A tangent root fillet of radius ρ between the root line and the flank must fit the root flat and the flank.
  const rootFlat = pitch - 2 * wRoot;
  const cornerAngle = Math.PI / 2 + alpha; // interior angle between root line and flank
  const setback = rho / Math.tan(cornerAngle / 2);
  const fillet = rho > 1e-9 && 2 * setback < rootFlat - 1e-6 ? rho : 0;
  // Tooth centres: a tooth on u=0 for odd counts, a space for even counts (meshes with a gear tooth pointing at it).
  const centre = (i: number) => (i - (N - 1) / 2) * pitch;
  const start = { x: -length / 2, y: bottomV };
  const edges: OutlineEdge[] = [];
  edges.push({ kind: "line", to: { x: length / 2, y: bottomV } });
  edges.push({ kind: "line", to: { x: length / 2, y: rootV } });
  for (let i = N - 1; i >= 0; i--) {
    const c = centre(i);
    edges.push({ kind: "line", to: { x: c + wRoot, y: rootV }, filletAtEnd: fillet || undefined });
    edges.push({ kind: "line", to: { x: c + wTip, y: tipV } });
    edges.push({ kind: "line", to: { x: c - wTip, y: tipV } });
    edges.push({ kind: "line", to: { x: c - wRoot, y: rootV }, filletAtEnd: fillet || undefined });
  }
  edges.push({ kind: "line", to: { x: -length / 2, y: rootV } });
  edges.push({ kind: "line", to: start });
  return {
    type: "rack", start, edges, circles: [], reference: [],
    rack: { length, pitch, pitchLineV: 0 },
    summary: `Rack: ${N} teeth, module ${m}, pitch ${f3(pitch)}; length ${f3(length)}, pitch line at v=0, tips at v=${f3(tipV)}, roots at v=${f3(rootV)}${fillet ? `, root fillet r=${f3(fillet)}` : ""}`,
  };
}

/** Generate the outline for an external gear, internal gear or rack. */
export function gearOutline(spec: GearSpec): GearOutline {
  switch (spec.type ?? "external") {
    case "internal": return internalOutline(spec);
    case "rack": return rackOutline(spec);
    default: return externalOutline(spec);
  }
}

/** Centre distance for two external gears of the same module (standard, no profile shift). */
export const centreDistance = (module: number, teeth1: number, teeth2: number) => (module * (teeth1 + teeth2)) / 2;
