// Flexure hinges as small-length flexural pivots (pseudo-rigid-body model,
// Howell 2001 §5.2): a strip much shorter than the links it joins bends about
// its middle, so it acts as a pin at its centre with a torsional spring
//   k = E·I / L,  I = w·t³/12,
// and, bending in a pure-moment arc, its outer fibre strain is
//   ε = (t/2)·κ = t·|φ| / (2L)   (exact for the arc: see test/flexure.test.ts).
// A mechanism of such hinges moves kinematically (the loop solve in
// recompute.ts places it for any drive value); this module reads each hinge's
// rotation off that pose and reports strain, stored energy and the effort the
// drive needs, dU/d(drive).

import type { CadDocument, FlexureSection, Joint, MechanicalProps } from "../core/document";
import { materialForComponent } from "../core/document";
import { resolveComponentWorld } from "../core/recompute";
import { resolveParameters } from "../model/parameters";
import { applyPoint, compose, IDENTITY, invert, type Rigid } from "../math/transform";
import { rectSection, solveBeam } from "./beam2d";

const RAD = Math.PI / 180;

/** Torsional stiffness of a flexure strip (N·mm per radian). */
export function flexureStiffness(E: number, s: FlexureSection): number {
  return (E * ((s.width * s.thickness ** 3) / 12)) / s.length;
}

/** Peak (outer-fibre) bending strain of a flexure bent through `phiDeg`. */
export function flexureStrain(s: FlexureSection, phiDeg: number): number {
  return (s.thickness * Math.abs(phiDeg * RAD)) / (2 * s.length);
}

export interface FlexureReading {
  joint: string;
  name: string;
  /** A beam element (its energy and strain from the large-deflection solve), not a hinge. */
  beam?: boolean;
  /** Hinge rotation from the as-modelled (unstressed) pose, degrees. */
  angle: number;
  strain: number;
  /** The material's allowable strain, when it has mechanical properties. */
  allowable?: number;
  /** Bending moment in the hinge (N·mm). */
  moment: number;
}

export interface FlexureState {
  flexures: FlexureReading[];
  /** Elastic energy stored in all hinges (N·mm = mJ). */
  energy: number;
  /** Largest strain / allowable over the hinges (≤ 1 passes); NaN if no allowable. */
  utilisation: number;
  /** A loop that failed to close, or a hinge with no material stiffness. */
  error?: string;
  /** Each beam element's moved end (displacement since as-modelled) and, when
   *  solved, the force it pushes back with there: what a study needs for the
   *  drive's effort without differencing a beam's energy across a snap. */
  beams: { joint: string; end: { dx: number; dy: number; dth: number }; reaction?: { fx: number; fy: number; m: number } }[];
}

const flexureJoints = (doc: CadDocument): Joint[] => Object.values(doc.joints).filter((j) => j.kind === "flexure" && j.flexure);
const beamJoints = (doc: CadDocument): Joint[] => Object.values(doc.joints).filter((j) => j.kind === "beam" && j.beam);

export const hasFlexures = (doc: CadDocument): boolean => flexureJoints(doc).length > 0 || beamJoints(doc).length > 0;

const BEAM_SEGMENTS = 16;

/** A beam's unstressed shape, from its base end to its moved end (as modelled). */
export function beamRestShape(j: Joint, n = BEAM_SEGMENTS): { x: number; y: number }[] {
  const a = j.baseOrigin, b = j.movedOrigin;
  return restShape({ x: b.x - a.x, y: b.y - a.y }, j.beam!.profile, n).map((p) => ({ x: a.x + p.x, y: a.y + p.y }));
}

/** The unstressed shape of a strip from the origin to `rel`. */
function restShape(rel: { x: number; y: number }, profile: "straight" | "cosine", n = BEAM_SEGMENTS) {
  return Array.from({ length: n + 1 }, (_, k) => {
    const s = k / n, f = profile === "cosine" ? (1 - Math.cos(Math.PI * s)) / 2 : s;
    return { x: rel.x * s, y: rel.y * f };
  });
}

/** Where the beam's moved end has gone, in the base part's frame: the end's
 *  displacement and rotation since the as-modelled pose. */
function beamEnd(j: Joint, world: Map<string, Rigid>): { dx: number; dy: number; dth: number } {
  const M = compose(invert(world.get(j.base) ?? IDENTITY), world.get(j.moved) ?? IDENTITY);
  const tip = applyPoint(M, j.movedOrigin);
  return { dx: tip.x - j.movedOrigin.x, dy: tip.y - j.movedOrigin.y, dth: Math.atan2(M.x.y, M.x.x) };
}

type BeamSolution = { energy: number; strain: number; reaction: { fx: number; fy: number; m: number } };
// The same pose is solved many times over (a study's probes, the equilibrium
// refinement, a mechanism's identical or mirror-image beams), so solutions are
// remembered by the beam's shape relative to its base end, mirrored to point +X.
const beamCache = new Map<string, BeamSolution>();

/** Solve a beam for its moved end's displacement: clamped at the base, the end
 *  driven to (dx, dy, dθ). Energy (mJ), peak strain, and the force it pushes
 *  back with there (N, N, N·mm/rad). Ramped in steps of about a quarter
 *  thickness, so a snap-through follows the beam's own path. */
export function solveBeamElement(j: Joint, E: number, end: { dx: number; dy: number; dth: number }): BeamSolution {
  const b = j.beam!;
  const flip = j.movedOrigin.x < j.baseOrigin.x ? -1 : 1; // x → −x is the same problem
  const rel = { x: flip * (j.movedOrigin.x - j.baseOrigin.x), y: j.movedOrigin.y - j.baseOrigin.y };
  const e = { dx: flip * end.dx, dy: end.dy, dth: flip * end.dth };
  const key = [rel.x, rel.y, b.width, b.thickness, b.profile, E, e.dx, e.dy, e.dth].map((v) => (typeof v === "number" ? v.toPrecision(10) : v)).join("|");
  let sol = beamCache.get(key);
  if (!sol) {
    const nodes = restShape(rel, b.profile);
    const n = nodes.length - 1, sec = rectSection(E, b.width, b.thickness);
    const travel = Math.max(Math.abs(e.dx), Math.abs(e.dy), Math.abs(e.dth) * Math.hypot(rel.x, rel.y));
    const model = { nodes, elements: Array.from({ length: n }, (_, k) => ({ a: k, b: k + 1, ...sec })), fixed: [{ node: 0 as const, dof: 0 as const }, { node: 0, dof: 1 as const }, { node: 0, dof: 2 as const }] };
    const load = { prescribed: [{ node: n, dof: 0 as const, value: e.dx }, { node: n, dof: 1 as const, value: e.dy }, { node: n, dof: 2 as const, value: e.dth }] };
    // Newton can leap onto a far, non-physical branch as a beam snaps through:
    // a result that didn't converge or that bends the strip beyond any plastic
    // (30% strain) is re-solved in finer steps.
    let steps = Math.min(48, Math.max(6, Math.ceil(travel / (0.25 * b.thickness))));
    let r = solveBeam(model, load, { steps, maxIter: 80 });
    const plausible = (q: typeof r) => q.converged && q.elements.every((el) => el.maxStrain < 0.3);
    for (let k = 0; k < 3 && !plausible(r); k++) { steps *= 2; r = solveBeam(model, load, { steps, maxIter: 80 }); }
    // the beam's push on its moved end: the energy's gradient there
    sol = {
      energy: r.converged ? r.energy : NaN,
      strain: Math.max(...r.elements.map((el) => el.maxStrain)),
      reaction: { fx: r.reactions[`${n}:0`] ?? 0, fy: r.reactions[`${n}:1`] ?? 0, m: r.reactions[`${n}:2`] ?? 0 },
    };
    if (beamCache.size > 4000) beamCache.clear();
    beamCache.set(key, sol);
  }
  return flip > 0 ? sol : { ...sol, reaction: { fx: -sol.reaction.fx, fy: sol.reaction.fy, m: -sol.reaction.m } };
}

function propsOf(doc: CadDocument, j: Joint, scope: Record<string, number>): MechanicalProps | undefined {
  if (j.beam) return (j.beam.material ? doc.materials[j.beam.material] : materialForComponent(doc, j.base, scope))?.mechanical;
  const m = j.flexure!.material ? doc.materials[j.flexure!.material] : materialForComponent(doc, j.moved, scope);
  return m?.mechanical;
}

/** Pose the mechanism with these parameter overrides and read every hinge and
 *  beam. `solveBeams: false` poses the beams' ends without solving them (their
 *  energy and strain are left out). */
export function flexureState(doc: CadDocument, overrides: Record<string, string> = {}, opts: { solveBeams?: boolean } = {}): FlexureState {
  const parameters = doc.parameters.map((p) => (overrides[p.name] != null ? { ...p, expr: overrides[p.name] } : p));
  const scope = resolveParameters(parameters).scope;
  const world = resolveComponentWorld(doc, scope); // poses and closes the loops (joint values) and sizes the strips
  const flexures: FlexureReading[] = [];
  const beams: FlexureState["beams"] = [];
  let energy = 0, utilisation = 0;
  let error = Object.values(doc.joints).find((j) => j.error)?.error;
  for (const j of flexureJoints(doc)) {
    const props = propsOf(doc, j, scope);
    const angle = j.valueValue;
    const strain = flexureStrain(j.flexure!, angle);
    if (!props) { error ??= `flexure "${j.name}" has no material stiffness`; flexures.push({ joint: j.id, name: j.name, angle, strain, moment: NaN }); continue; }
    const k = flexureStiffness(props.E, j.flexure!);
    energy += 0.5 * k * (angle * RAD) ** 2;
    utilisation = Math.max(utilisation, strain / props.allowableStrain);
    flexures.push({ joint: j.id, name: j.name, angle, strain, allowable: props.allowableStrain, moment: k * angle * RAD });
  }
  for (const j of beamJoints(doc)) {
    const props = propsOf(doc, j, scope);
    const end = beamEnd(j, world);
    if (opts.solveBeams === false) { beams.push({ joint: j.id, end }); continue; }
    if (!props) { error ??= `beam "${j.name}" has no material stiffness`; flexures.push({ joint: j.id, name: j.name, beam: true, angle: end.dth / RAD, strain: NaN, moment: NaN }); continue; }
    const b = solveBeamElement(j, props.E, end);
    beams.push({ joint: j.id, end, reaction: b.reaction });
    if (!Number.isFinite(b.energy)) error ??= `beam "${j.name}" did not converge`;
    energy += Number.isFinite(b.energy) ? b.energy : 0;
    utilisation = Math.max(utilisation, b.strain / props.allowableStrain);
    flexures.push({ joint: j.id, name: j.name, beam: true, angle: end.dth / RAD, strain: b.strain, allowable: props.allowableStrain, moment: NaN });
  }
  return { flexures, energy, utilisation: flexures.every((f) => f.allowable) ? utilisation : NaN, beams, ...(error ? { error } : {}) };
}

/** True when `param` is a revolute/flexure joint's bare angle (degrees), so its
 *  effort is a torque; otherwise it's per unit of the parameter (a force, for a
 *  length). */
export const isAngularDrive = (doc: CadDocument, param: string): boolean =>
  Object.values(doc.joints).some((j) => (j.kind === "revolute" || j.kind === "flexure") && j.valueExpr.trim() === param);

export interface FlexurePose extends FlexureState {
  value: number;
  /** dU/d(drive): N·mm per radian when the drive is an angle in degrees of a
   *  revolute/flexure joint (i.e. the input torque), else per unit of the drive
   *  parameter. The hinges' part by central difference of their energy; each
   *  beam's as its end force times how far that end moves per unit of drive. */
  effort: number;
}

/** Sweep a drive parameter through `values` (in order, so each loop solve is
 *  seeded from its neighbour's pose) and read the hinges at each. */
export function flexureSweep(doc: CadDocument, param: string, values: number[]): FlexurePose[] {
  const angular = isAngularDrive(doc, param);
  const per = angular ? 180 / Math.PI : 1; // dU/dθ[deg] → per radian
  const d = 1e-3;
  return values.map((v) => {
    const lo = flexureState(doc, { [param]: String(v - d) }, { solveBeams: false });
    const hi = flexureState(doc, { [param]: String(v + d) }, { solveBeams: false });
    const state = flexureState(doc, { [param]: String(v) });
    let effort = (hi.energy - lo.energy) / (2 * d);
    for (const b of state.beams) {
      const a = lo.beams.find((q) => q.joint === b.joint)!.end, c = hi.beams.find((q) => q.joint === b.joint)!.end, R = b.reaction;
      if (R) effort += (R.fx * (c.dx - a.dx) + R.fy * (c.dy - a.dy) + R.m * (c.dth - a.dth)) / (2 * d);
    }
    return { ...state, value: v, effort: effort * per };
  });
}

/** A rest position along a drive: where the effort is zero. Stable when the
 *  effort rises through zero (an energy minimum: pushed either way, it springs
 *  back), unstable when it falls (an energy maximum: the tipping point). */
export interface Equilibrium {
  value: number;
  stable: boolean;
  /** Stored energy there (N·mm = mJ). */
  energy: number;
}

export interface EquilibriumStudy {
  /** Every rest position in the range, in drive order. */
  states: Equilibrium[];
  /** The sampled poses, in drive order. */
  poses: FlexurePose[];
  /** Two stable states or more: it stays put where you leave it in each. */
  multistable: boolean;
  /** Bistable: the largest effort between the first two stable states (the
   *  push needed to snap it over), and the energy barrier between them. */
  snap?: { value: number; effort: number; barrier: number };
}

/** Find where a mechanism rests along a drive: the zeros of the effort
 *  dU/d(drive) over [min, max]. Sampled with `n` steps outward from the current
 *  value (so each loop solve is seeded by its neighbour and stays on its
 *  assembly branch), each crossing then refined by bisection. Leaves the
 *  document posed at the current value. */
export function flexureEquilibria(doc: CadDocument, param: string, min: number, max: number, n = 48): EquilibriumStudy {
  const p = doc.parameters.find((q) => q.name === param);
  const current = Math.min(max, Math.max(min, p?.value ?? min));
  const step = (max - min) / n;
  const up: number[] = [], down: number[] = [];
  for (let v = current; v <= max + 1e-9; v += step) up.push(v);
  if (up[up.length - 1] < max - 1e-9) up.push(max);
  for (let v = current - step; v >= min - 1e-9; v -= step) down.push(v);
  if (down.length && down[down.length - 1] > min + 1e-9) down.push(min);
  const ascending = flexureSweep(doc, param, up);
  flexureState(doc, { [param]: String(current) }); // re-seed at the start before going the other way
  const descending = flexureSweep(doc, param, down);
  const poses = [...descending.reverse(), ...ascending];
  const effortAt = (v: number) => flexureSweep(doc, param, [v])[0];
  const states: Equilibrium[] = [];
  // a sample can sit exactly on a rest position (the as-made pose has no effort)
  const tiny = 1e-9 * Math.max(1e-12, ...poses.map((q) => Math.abs(q.effort)).filter(Number.isFinite));
  const zero = poses.map((q) => !q.error && Math.abs(q.effort) <= tiny);
  for (let i = 0; i < poses.length; i++) {
    if (!zero[i]) continue;
    const before = poses[i - 1]?.effort ?? -poses[i + 1]?.effort, after = poses[i + 1]?.effort ?? -poses[i - 1]?.effort;
    states.push({ value: poses[i].value, stable: after > before, energy: poses[i].energy });
  }
  for (let i = 1; i < poses.length; i++) {
    const a = poses[i - 1], b = poses[i];
    if (a.error || b.error || zero[i - 1] || zero[i] || Math.sign(a.effort) === Math.sign(b.effort)) continue;
    // refine the crossing by regula falsi (Illinois): a few solves, not dozens
    let lo = a.value, hi = b.value, flo = a.effort, fhi = b.effort, mid = (lo + hi) / 2, pose = b, side = 0;
    for (let k = 0; k < 24 && hi - lo > 1e-6 * (max - min); k++) {
      mid = (lo * fhi - hi * flo) / (fhi - flo);
      if (!(mid > lo && mid < hi)) mid = (lo + hi) / 2;
      pose = effortAt(mid);
      if (Math.abs(pose.effort) <= tiny) break;
      if (Math.sign(pose.effort) === Math.sign(flo)) { lo = mid; flo = pose.effort; if (side === -1) fhi /= 2; side = -1; }
      else { hi = mid; fhi = pose.effort; if (side === 1) flo /= 2; side = 1; }
    }
    states.push({ value: mid, stable: b.effort > a.effort, energy: pose.energy });
  }
  flexureState(doc, { [param]: String(current) }); // leave it where it was
  states.sort((x, y) => x.value - y.value);
  const stable = states.filter((s) => s.stable);
  let snap: EquilibriumStudy["snap"];
  if (stable.length >= 2) {
    const [s0, s1] = stable;
    const between = poses.filter((q) => q.value > s0.value && q.value < s1.value && !q.error);
    const peak = between.reduce((m, q) => (Math.abs(q.effort) > Math.abs(m.effort) ? q : m), between[0]);
    const top = states.find((s) => !s.stable && s.value > s0.value && s.value < s1.value);
    if (peak) snap = { value: peak.value, effort: peak.effort, barrier: (top?.energy ?? Math.max(...between.map((q) => q.energy))) - s0.energy };
  }
  return { states, poses, multistable: stable.length >= 2, ...(snap ? { snap } : {}) };
}
