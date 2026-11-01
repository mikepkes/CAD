// A 3D spine for a sweep: a smooth cubic B-spline in space, either THROUGH a
// list of points (C2 global interpolation, chord-length parameters) or
// CONTROLLED by them (the points are its control polygon: a run of four
// collinear points gives an exactly straight stretch, and every bend is
// curvature-continuous — how a bent tube with smooth, G2 bends is drawn).
//
// Plain math, no kernel: the same curve is handed to OCC as NURBS data, and
// evaluated here to place sweep sections square to it, measure its length and
// lay out a scale law along it.

import type { NurbsCurveData } from "../nurbs";
import type { Vec3 } from "../../math/vec";
import type { WorkPlane } from "../../geometry/plane";

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const unit = (a: V): V => scale(a, 1 / (len(a) || 1));
const asV = (p: Vec3): V => [p.x, p.y, p.z];
const asVec = (a: V): Vec3 => ({ x: a[0], y: a[1], z: a[2] });

/** Drop consecutive points closer than `tol` (a zero-length span has no tangent). */
function dedupe(points: Vec3[], tol = 1e-6): V[] {
  const out: V[] = [];
  for (const p of points.map(asV)) if (!out.length || len(sub(p, out[out.length - 1])) > tol) out.push(p);
  return out;
}

/** Flat clamped knot vector for `n` poles of degree `p` with the given interior knots. */
const clamped = (p: number, interior: number[]): number[] => [...Array(p + 1).fill(0), ...interior, ...Array(p + 1).fill(1)];

/** The cubic B-spline whose control polygon is `points` (clamped: it starts and ends on the end points, tangent to the end legs). */
export function controlSpine(points: Vec3[]): NurbsCurveData {
  const P = dedupe(points);
  if (P.length < 2) throw new Error("a 3D path needs at least two distinct points");
  const p = Math.min(3, P.length - 1), n = P.length;
  const spans = n - p;
  const interior = Array.from({ length: spans - 1 }, (_, i) => (i + 1) / spans);
  return { degree: p, knots: clamped(p, interior), poles: P.flat() };
}

/** Solve a small dense linear system (Gaussian elimination, partial pivoting); B holds 3 right-hand sides. */
function solve(A: number[][], B: V[]): V[] {
  const n = A.length;
  const M = A.map((r) => r.slice()), R = B.map((b) => b.slice() as V);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]]; [R[c], R[piv]] = [R[piv], R[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-14) throw new Error("the 3D path's points can't be interpolated");
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / d;
      if (!f) continue;
      for (let k = c; k < n; k++) M[r][k] -= f * M[c][k];
      for (let k = 0; k < 3; k++) R[r][k] -= f * R[c][k];
    }
  }
  const X: V[] = Array.from({ length: n }, () => [0, 0, 0]);
  for (let r = n - 1; r >= 0; r--) {
    const acc = R[r].slice() as V;
    for (let k = r + 1; k < n; k++) for (let j = 0; j < 3; j++) acc[j] -= M[r][k] * X[k][j];
    X[r] = scale(acc, 1 / M[r][r]);
  }
  return X;
}

/** The C2 cubic B-spline through `points` in order (global interpolation: chord-length parameters, averaged knots). */
export function throughSpine(points: Vec3[]): NurbsCurveData {
  const Q = dedupe(points);
  if (Q.length < 2) throw new Error("a 3D path needs at least two distinct points");
  const n = Q.length, p = Math.min(3, n - 1);
  const chord = Q.slice(1).map((q, i) => len(sub(q, Q[i])));
  const total = chord.reduce((a, b) => a + b, 0);
  const u = [0];
  for (const c of chord) u.push(u[u.length - 1] + c / total);
  u[n - 1] = 1;
  const interior: number[] = [];
  for (let j = 1; j <= n - p - 1; j++) { let s = 0; for (let i = j; i < j + p; i++) s += u[i]; interior.push(s / p); }
  const knots = clamped(p, interior);
  const A = u.map((t) => basisRow(knots, p, n, t));
  return { degree: p, knots, poles: solve(A, Q).flat() };
}

/** Index of the knot span holding t. */
function span(knots: number[], p: number, n: number, t: number): number {
  if (t >= knots[n]) return n - 1;
  if (t <= knots[p]) return p;
  let lo = p, hi = n;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t < knots[mid]) hi = mid; else lo = mid; }
  return lo;
}

/** Every basis function's value at t (a full row, for the interpolation system). */
function basisRow(knots: number[], p: number, n: number, t: number): number[] {
  const row = new Array(n).fill(0);
  const i = span(knots, p, n, t);
  const N = basisDerivs(knots, p, i, t, 0)[0];
  for (let k = 0; k <= p; k++) row[i - p + k] = N[k];
  return row;
}

/** Non-zero basis functions at t (span i) and their derivatives up to `d` (Piegl & Tiller A2.3). */
function basisDerivs(U: number[], p: number, i: number, t: number, d: number): number[][] {
  const ndu: number[][] = Array.from({ length: p + 1 }, () => new Array(p + 1).fill(0));
  const left = new Array(p + 1).fill(0), right = new Array(p + 1).fill(0);
  ndu[0][0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = t - U[i + 1 - j]; right[j] = U[i + j] - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      ndu[j][r] = right[r + 1] + left[j - r];
      const tmp = ndu[r][j - 1] / ndu[j][r];
      ndu[r][j] = saved + right[r + 1] * tmp;
      saved = left[j - r] * tmp;
    }
    ndu[j][j] = saved;
  }
  const ders: number[][] = Array.from({ length: d + 1 }, () => new Array(p + 1).fill(0));
  for (let j = 0; j <= p; j++) ders[0][j] = ndu[j][p];
  const a = [new Array(p + 1).fill(0), new Array(p + 1).fill(0)];
  for (let r = 0; r <= p; r++) {
    let s1 = 0, s2 = 1;
    a[0][0] = 1;
    for (let k = 1; k <= d; k++) {
      let dd = 0;
      const rk = r - k, pk = p - k;
      if (r >= k) { a[s2][0] = a[s1][0] / ndu[pk + 1][rk]; dd = a[s2][0] * ndu[rk][pk]; }
      const j1 = rk >= -1 ? 1 : -rk, j2 = r - 1 <= pk ? k - 1 : p - r;
      for (let j = j1; j <= j2; j++) { a[s2][j] = (a[s1][j] - a[s1][j - 1]) / ndu[pk + 1][rk + j]; dd += a[s2][j] * ndu[rk + j][pk]; }
      if (r <= pk) { a[s2][k] = -a[s1][k - 1] / ndu[pk + 1][r]; dd += a[s2][k] * ndu[r][pk]; }
      ders[k][r] = dd;
      [s1, s2] = [s2, s1];
    }
  }
  let f = p;
  for (let k = 1; k <= d; k++) { for (let j = 0; j <= p; j++) ders[k][j] *= f; f *= p - k; }
  return ders;
}

/** Point and first two derivatives of the curve at parameter t ∈ [0, 1]. */
export function curveDerivs(c: NurbsCurveData, t: number): { p: Vec3; d1: Vec3; d2: Vec3 } {
  const n = c.poles.length / 3, p = c.degree;
  const tt = Math.min(1, Math.max(0, t));
  const i = span(c.knots, p, n, tt);
  const D = basisDerivs(c.knots, p, i, tt, Math.min(2, p));
  const out: V[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let k = 0; k < D.length; k++) for (let j = 0; j <= p; j++) {
    const b = 3 * (i - p + j);
    for (let a = 0; a < 3; a++) out[k][a] += D[k][j] * c.poles[b + a];
  }
  return { p: asVec(out[0]), d1: asVec(out[1]), d2: asVec(out[2]) };
}

/** Arc length along the curve as a table (parameter ↔ length), by fine Gauss–Legendre sums. */
export interface SpineTable { t: number[]; s: number[]; length: number }

export function spineTable(c: NurbsCurveData, samples = 400): SpineTable {
  const g = [-0.7745966692414834, 0, 0.7745966692414834], w = [0.5555555555555556, 0.8888888888888888, 0.5555555555555556];
  const t = [0], s = [0];
  for (let k = 1; k <= samples; k++) {
    const a = (k - 1) / samples, b = k / samples;
    let acc = 0;
    for (let q = 0; q < 3; q++) { const d = curveDerivs(c, (a + b) / 2 + ((b - a) / 2) * g[q]).d1; acc += w[q] * Math.hypot(d.x, d.y, d.z); }
    t.push(b); s.push(s[k - 1] + (acc * (b - a)) / 2);
  }
  return { t, s, length: s[samples] };
}

/** The curve parameter at arc length `at` (clamped to the curve). */
export function paramAtLength(tab: SpineTable, at: number): number {
  if (at <= 0) return 0;
  if (at >= tab.length) return 1;
  let lo = 0, hi = tab.s.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tab.s[m] <= at) lo = m; else hi = m; }
  const f = (at - tab.s[lo]) / (tab.s[hi] - tab.s[lo] || 1);
  return tab.t[lo] + f * (tab.t[hi] - tab.t[lo]);
}

/** The plane square to the curve at t: origin on it, normal along its tangent,
 *  v toward `up` (projected square to the tangent), u = v × tangent. Where the
 *  curve runs along `up`, `prev`'s u is carried over. */
export function sectionPlane(c: NurbsCurveData, t: number, up: Vec3, prev?: WorkPlane): WorkPlane {
  const { p, d1 } = curveDerivs(c, t);
  const T = unit(asV(d1));
  let Y = sub(asV(up), scale(T, dot(asV(up), T)));
  if (len(Y) < 1e-6 * (len(asV(up)) || 1)) {
    const u0 = prev ? asV(prev.u) : Math.abs(T[2]) < 0.9 ? cross([0, 0, 1], T) : cross([1, 0, 0], T);
    Y = cross(T, sub(u0, scale(T, dot(u0, T))));
  }
  Y = unit(Y);
  const X = unit(cross(Y, T));
  return { id: "custom", name: "Section", origin: p, u: asVec(X), v: asVec(Y), normal: asVec(T), color: "#c9a227" };
}

/** C2 ease between stations: 0 → 1 with zero slope and curvature at both ends. */
const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (10 + x * (-15 + 6 * x)));

/** A value law along the spine from (arc length, value) stations: constant
 *  before the first and after the last, an eased (C2, monotone) blend between
 *  neighbours — so equal neighbours hold the value exactly and nothing overshoots. */
export function easedLaw(stations: { at: number; value: number }[]): (s: number) => number {
  const st = stations.slice().sort((a, b) => a.at - b.at);
  if (!st.length) return () => 1;
  return (s: number) => {
    let v = st[0].value;
    for (let i = 0; i + 1 < st.length; i++) {
      const a = st[i], b = st[i + 1];
      if (b.at > a.at) v += (b.value - a.value) * ease((s - a.at) / (b.at - a.at));
      else if (s >= b.at) v += b.value - a.value;
    }
    return v;
  };
}
