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
}

const flexureJoints = (doc: CadDocument): Joint[] => Object.values(doc.joints).filter((j) => j.kind === "flexure" && j.flexure);

export const hasFlexures = (doc: CadDocument): boolean => flexureJoints(doc).length > 0;

function propsOf(doc: CadDocument, j: Joint): MechanicalProps | undefined {
  const m = j.flexure!.material ? doc.materials[j.flexure!.material] : materialForComponent(doc, j.moved);
  return m?.mechanical;
}

/** Pose the mechanism with these parameter overrides and read every hinge. */
export function flexureState(doc: CadDocument, overrides: Record<string, string> = {}): FlexureState {
  const parameters = doc.parameters.map((p) => (overrides[p.name] != null ? { ...p, expr: overrides[p.name] } : p));
  resolveComponentWorld(doc, resolveParameters(parameters).scope); // poses and closes the loops (joint values)
  const flexures: FlexureReading[] = [];
  let energy = 0, utilisation = 0;
  let error = Object.values(doc.joints).find((j) => j.error)?.error;
  for (const j of flexureJoints(doc)) {
    const props = propsOf(doc, j);
    const angle = j.valueValue;
    const strain = flexureStrain(j.flexure!, angle);
    if (!props) { error ??= `flexure "${j.name}" has no material stiffness`; flexures.push({ joint: j.id, name: j.name, angle, strain, moment: NaN }); continue; }
    const k = flexureStiffness(props.E, j.flexure!);
    energy += 0.5 * k * (angle * RAD) ** 2;
    utilisation = Math.max(utilisation, strain / props.allowableStrain);
    flexures.push({ joint: j.id, name: j.name, angle, strain, allowable: props.allowableStrain, moment: k * angle * RAD });
  }
  return { flexures, energy, utilisation: flexures.every((f) => f.allowable) ? utilisation : NaN, ...(error ? { error } : {}) };
}

export interface FlexurePose extends FlexureState {
  value: number;
  /** dU/d(drive) by central difference: N·mm per radian when the drive is an
   *  angle in degrees of a revolute/flexure joint (i.e. the input torque), else
   *  per unit of the drive parameter. */
  effort: number;
}

/** Sweep a drive parameter through `values` (in order, so each loop solve is
 *  seeded from its neighbour's pose) and read the hinges at each. */
export function flexureSweep(doc: CadDocument, param: string, values: number[]): FlexurePose[] {
  const angular = Object.values(doc.joints).some((j) => (j.kind === "revolute" || j.kind === "flexure") && j.valueExpr.trim() === param);
  const per = angular ? 180 / Math.PI : 1; // dU/dθ[deg] → per radian
  const d = 1e-3;
  return values.map((v) => {
    const lo = flexureState(doc, { [param]: String(v - d) }).energy;
    const hi = flexureState(doc, { [param]: String(v + d) }).energy;
    const state = flexureState(doc, { [param]: String(v) });
    return { ...state, value: v, effort: ((hi - lo) / (2 * d)) * per };
  });
}
