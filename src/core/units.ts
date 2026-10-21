// Units and tolerance model.
//
// All model-space math is done in a single canonical linear unit — MILLIMETRES
// — as IEEE-754 float64 (double). This matches every production CAD kernel
// (OpenCASCADE, Parasolid, ACIS); robustness for very small and very large
// parts comes from a *relative* tolerance model plus robust predicates, not
// from wider number types. Display units are a presentation concern only.

export type LinearUnit = "mm" | "cm" | "m" | "in" | "ft" | "mil" | "um";
export type AngularUnit = "deg" | "rad";

/** Factor to convert a value in the given unit INTO canonical millimetres. */
export const MM_PER_UNIT: Record<LinearUnit, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
  mil: 0.0254, // thousandth of an inch
  um: 0.001,
};

export const toMM = (value: number, unit: LinearUnit): number => value * MM_PER_UNIT[unit];
export const fromMM = (mm: number, unit: LinearUnit): number => mm / MM_PER_UNIT[unit];

export const degToRad = (d: number): number => (d * Math.PI) / 180;
export const radToDeg = (r: number): number => (r * 180) / Math.PI;

export const TAU = Math.PI * 2;

/**
 * Tolerances, in canonical millimetres / radians. These drive solver
 * convergence and geometric equality tests. The *absolute* floors protect tiny
 * parts; the *relative* term protects large parts (a 2 m plate still resolves
 * coincidence sensibly). Compare with `lengthEqual` / `linearResolution`.
 */
export interface Tolerance {
  /** Absolute length tolerance floor (mm). ~1 nm — well inside double precision. */
  linear: number;
  /** Relative length tolerance (fraction of the compared magnitude). */
  linearRelative: number;
  /** Angular tolerance (radians). */
  angular: number;
  /** Solver residual convergence threshold (mm). */
  convergence: number;
}

export const DEFAULT_TOLERANCE: Tolerance = {
  linear: 1e-6,
  linearRelative: 1e-9,
  angular: 1e-9,
  convergence: 1e-10,
};

/** Scale-aware length tolerance for magnitudes around `scale` mm. */
export function linearResolution(scale: number, tol: Tolerance = DEFAULT_TOLERANCE): number {
  return Math.max(tol.linear, Math.abs(scale) * tol.linearRelative);
}

/** True when two lengths are equal within scale-aware tolerance. */
export function lengthEqual(a: number, b: number, tol: Tolerance = DEFAULT_TOLERANCE): boolean {
  return Math.abs(a - b) <= linearResolution(Math.max(Math.abs(a), Math.abs(b)), tol);
}

export function angleEqual(a: number, b: number, tol: Tolerance = DEFAULT_TOLERANCE): boolean {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return Math.abs(d) <= tol.angular;
}
