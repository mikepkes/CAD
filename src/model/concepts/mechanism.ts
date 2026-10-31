// The Mechanism panel's logic: which parameters drive a compliant mechanism,
// the force–travel curve along one of them (with its rest positions, the
// unstable tipping point between them and the snap force), the chart's
// geometry, the per-flexure strain bars and the values a Sweep steps through.
// Pure functions over the solver's output (src/sim/flexure.ts); no React, no
// store. mechanismStore.ts runs the solver and keeps the results.

import type { CadDocument, Parameter } from "../../core/document";
import { compileExpr } from "../../math/expr";
import type { EquilibriumStudy, FlexureState } from "../../sim/flexure";

/** The parameters that drive a compliant mechanism: bounded parameters that a
 *  placing joint's motion follows (a planar joint can have one per axis). */
export function drivesOf(doc: Pick<CadDocument, "joints" | "parameters">): Parameter[] {
  const out: Parameter[] = [];
  for (const j of Object.values(doc.joints)) {
    if (j.solve || j.closes || j.kind === "beam" || j.kind === "rigid") continue;
    for (const e of j.kind === "planar" ? Object.values(j.planar ?? {}) : [j.valueExpr]) {
      let deps: string[] = [];
      try { deps = compileExpr(String(e)).deps; } catch { continue; }
      for (const p of doc.parameters) if (deps.includes(p.name) && p.min != null && p.max != null && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

export interface CurvePoint { x: number; y: number }

/** A force–travel (or torque–angle) curve along one drive. */
export interface MechanismCurve {
  param: string;
  /** The drive is a joint angle (degrees): the effort is a torque in N·mm. */
  angular: boolean;
  /** The drive's own unit ("mm" or "°"). */
  unit: string;
  /** The effort's unit ("N" or "N·mm"). */
  effortUnit: string;
  min: number;
  max: number;
  /** Drive value → effort (dU/d(drive)), in drive order; poses that failed are left out. */
  points: CurvePoint[];
  /** Rest positions: effort zero and rising through it (an energy minimum). */
  stable: CurvePoint[];
  /** Tipping points: effort zero and falling through it (an energy maximum). */
  unstable: CurvePoint[];
  /** Two stable rests or more. */
  multistable: boolean;
  /** The largest effort between the first two rests: what it takes to snap it over. */
  snap?: CurvePoint;
}

/** The curve a study of `param` over [min, max] draws (efforts in N, or N·mm for an angle). */
export function buildCurve(study: EquilibriumStudy, param: string, angular: boolean, min: number, max: number): MechanismCurve {
  const points = study.poses.filter((p) => !p.error && Number.isFinite(p.effort) && Number.isFinite(p.value)).map((p) => ({ x: p.value, y: p.effort }));
  const stable = study.states.filter((s) => s.stable).map((s) => ({ x: s.value, y: 0 }));
  const unstable = study.states.filter((s) => !s.stable).map((s) => ({ x: s.value, y: 0 }));
  return {
    param, angular, unit: angular ? "°" : "mm", effortUnit: angular ? "N·mm" : "N", min, max,
    points, stable, unstable, multistable: study.multistable,
    ...(study.snap ? { snap: { x: study.snap.value, y: study.snap.effort } } : {}),
  };
}

/** The effort at a drive value, read off the curve (linear between samples, held at the ends). */
export function effortAt(curve: Pick<MechanismCurve, "points">, x: number): number {
  const p = curve.points;
  if (!p.length) return NaN;
  if (x <= p[0].x) return p[0].y;
  for (let i = 1; i < p.length; i++) {
    if (x <= p[i].x) {
      const a = p[i - 1], b = p[i], t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return p[p.length - 1].y;
}

/** Round, readable axis ticks covering [lo, hi] (about `count` of them). */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  // the round step that gives the count nearest the one asked for
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).reduce((b, s) => (Math.abs((hi - lo) / s - count) < Math.abs((hi - lo) / b - count) ? s : b));
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9 * step; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : +v.toPrecision(12));
  return out;
}

export interface ChartBox { w: number; h: number; left: number; right: number; top: number; bottom: number }

export interface ChartGeometry {
  sx: (x: number) => number;
  sy: (y: number) => number;
  /** The curve as an SVG path. */
  path: string;
  /** The y of the zero-effort line. */
  zeroY: number;
  xTicks: number[];
  yTicks: number[];
  /** The plotted y range (zero always inside it). */
  yLo: number;
  yHi: number;
}

/** Scales, ticks and the path for a curve in a box (padding in the box). */
export function chartGeometry(curve: Pick<MechanismCurve, "points" | "min" | "max"> & Partial<Pick<MechanismCurve, "stable" | "multistable">>, box: ChartBox): ChartGeometry {
  // A multistable curve is scaled to the stretch between its rests (and a little
  // either side): past the last rest the effort climbs steeply and would flatten
  // the snap. The curve runs off the plot there (the chart clips it).
  const st = curve.multistable && curve.stable && curve.stable.length >= 2 ? curve.stable : null;
  const margin = 0.15 * (curve.max - curve.min);
  const focus = st ? curve.points.filter((p) => p.x >= st[0].x - margin && p.x <= st[st.length - 1].x + margin) : curve.points;
  const ys = (focus.length ? focus : curve.points).map((p) => p.y);
  let lo = Math.min(0, ...ys), hi = Math.max(0, ...ys);
  if (!(hi > lo)) { lo = -1; hi = 1; }
  const pad = (hi - lo) * 0.1;
  lo -= pad; hi += pad;
  const yTicks = niceTicks(lo, hi, 4);
  const xTicks = niceTicks(curve.min, curve.max, 5);
  const x0 = box.left, x1 = box.w - box.right, y0 = box.top, y1 = box.h - box.bottom;
  const span = curve.max - curve.min || 1;
  const sx = (x: number) => x0 + ((x - curve.min) / span) * (x1 - x0);
  const sy = (y: number) => y1 - ((y - lo) / (hi - lo)) * (y1 - y0);
  const r = (v: number) => Math.round(v * 10) / 10;
  const path = curve.points.map((p, i) => `${i ? "L" : "M"}${r(sx(p.x))},${r(sy(p.y))}`).join("");
  return { sx, sy, path, zeroY: sy(0), xTicks, yTicks, yLo: lo, yHi: hi };
}

/** A number for a label: up to `digits` decimals, no trailing zeros. */
export function fmt(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return "–";
  let s = v.toFixed(digits);
  if (s.includes(".")) s = s.replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

/** An effort with its unit: force to 0.1 N (two decimals under 1 N), torque to 1 N·mm. */
export function fmtEffort(v: number, angular: boolean): string {
  if (!Number.isFinite(v)) return "–";
  return angular ? `${fmt(v, Math.abs(v) < 10 ? 1 : 0)} N·mm` : `${fmt(v, Math.abs(v) < 1 ? 2 : 1)} N`;
}

/** A drive value with its unit. */
export function fmtDrive(v: number, angular: boolean): string {
  return angular ? `${fmt(v, 1)}°` : `${fmt(v, 2)} mm`;
}

/** The curve in a sentence: where it rests, where it tips over, what it takes to snap. */
export function restSentence(curve: MechanismCurve): string {
  const at = (pts: CurvePoint[]) => pts.map((q) => fmtDrive(q.x, curve.angular)).join(" and ");
  if (!curve.stable.length) return `No rest position between ${fmtDrive(curve.min, curve.angular)} and ${fmtDrive(curve.max, curve.angular)}: it springs back out of this range.`;
  const parts = [curve.multistable ? `Bistable: rests at ${at(curve.stable)}` : `Rests at ${at(curve.stable)}`];
  if (curve.unstable.length) parts.push(`tips over at ${at(curve.unstable)}`);
  if (curve.snap) parts.push(`snaps over at ${fmtEffort(curve.snap.y, curve.angular)}`);
  return parts.join("; ") + ".";
}

/** Which side of a point a label goes, so it stays inside the plot. */
export const labelSide = (x: number, x0: number, x1: number): "start" | "end" => (x > (x0 + x1) / 2 ? "end" : "start");

/** A strain bar's fill: the ramp's share up to its value (CSS), or the over-limit stripes. */
export function barFill(pct: number): { width: string; background: string; backgroundSize?: string } {
  if (!Number.isFinite(pct)) return { width: "0%", background: "var(--k-an-strain-rigid)" };
  if (pct > 100) return { width: "100%", background: "var(--k-an-strain-over)" };
  const w = Math.max(1, pct);
  return { width: `${w}%`, background: "var(--k-an-strain)", backgroundSize: `${(100 / w) * 100}% 100%` };
}

export interface StrainBar {
  joint: string;
  name: string;
  beam: boolean;
  /** Peak strain (fraction). */
  strain: number;
  /** Strain as a percentage of the material's limit (NaN with no limit). */
  pct: number;
  over: boolean;
}

/** One bar per flexure / beam: its peak strain against its material's limit. */
export function strainBars(state: Pick<FlexureState, "flexures">): StrainBar[] {
  return state.flexures.map((f) => {
    const pct = f.allowable && Number.isFinite(f.strain) ? (100 * f.strain) / f.allowable : NaN;
    return { joint: f.joint, name: f.name, beam: !!f.beam, strain: f.strain, pct, over: pct > 100 };
  });
}

/** The flexure working hardest (by share of its limit; by raw strain when none has a limit). */
export function worstFlexure(state: Pick<FlexureState, "flexures">): StrainBar | undefined {
  const bars = strainBars(state).filter((b) => Number.isFinite(b.strain));
  if (!bars.length) return undefined;
  const key = (b: StrainBar) => (Number.isFinite(b.pct) ? b.pct : -Infinity);
  return bars.reduce((m, b) => (key(b) > key(m) || (key(b) === key(m) && b.strain > m.strain) ? b : m));
}

/** The values a Sweep steps through: from where it stands up to the top of the
 *  range, down to the bottom, and back to where it started, about `perLeg`
 *  steps across the full range, snapped to the parameter's step. */
export function sweepPlan(current: number, min: number, max: number, perLeg = 20, step?: number): number[] {
  if (!(max > min)) return [];
  const start = Math.min(max, Math.max(min, current));
  const d = (max - min) / Math.max(1, perLeg);
  const snap = (v: number) => {
    const s = step && step > 0 ? Math.round(v / step) * step : v;
    return +Math.min(max, Math.max(min, s)).toPrecision(10);
  };
  const out: number[] = [];
  const push = (v: number) => { const s = snap(v); if (out.length === 0 ? s !== snap(start) : s !== out[out.length - 1]) out.push(s); };
  const leg = (from: number, to: number) => {
    const n = Math.max(1, Math.round(Math.abs(to - from) / d));
    for (let k = 1; k <= n; k++) push(from + ((to - from) * k) / n);
  };
  leg(start, max);
  leg(max, min);
  leg(min, start);
  return out;
}
