// Prototype: geometrically nonlinear 2D beam statics (co-rotational Euler-
// Bernoulli elements, Crisfield 1991 §7). The core a compliant-mechanism motion
// solver needs: flexures bend through LARGE rotations, so the equilibrium shape
// is solved, not assumed. Each element carries a rigid rotation plus small local
// deformation (axial stretch, two end rotations); Newton iterations with load
// stepping track the large motion.
//
// Inputs are nodal forces/moments and/or prescribed displacements (displacement
// control: "push this point 0.85 mm"); outputs are the deformed nodes, the
// reactions (the force it takes to drive that motion) and each element's peak
// strain, for pass/fail against the material's allowable strain.
//
// Wired into assemblies as `beam` elements (src/sim/flexure.ts): a strip clamped
// between two parts whose energy and strain come from this solve.

export type Dof = 0 | 1 | 2; // x, y, θ

export interface BeamModel {
  nodes: { x: number; y: number }[];
  /** E (MPa), A (mm²), I (mm⁴); c = distance from the neutral axis to the extreme fibre (mm). */
  elements: { a: number; b: number; E: number; A: number; I: number; c: number }[];
  /** Supports: these DOFs are held at zero. */
  fixed: { node: number; dof: Dof }[];
}

export interface BeamLoad {
  /** Nodal forces (N) and moments (N·mm), ramped from zero over the load steps. */
  forces?: { node: number; fx?: number; fy?: number; m?: number }[];
  /** Displacement control: drive these DOFs to `value` (mm / rad), ramped. */
  prescribed?: { node: number; dof: Dof; value: number }[];
}

export interface BeamResult {
  converged: boolean;
  /** Deformed nodes: position and rotation (rad, from the initial orientation). */
  nodes: { x: number; y: number; theta: number }[];
  /** Reaction at each fixed or prescribed DOF (N or N·mm), keyed `${node}:${dof}`. */
  reactions: Record<string, number>;
  /** Per element: axial force N, end moments, and the peak fibre strain |N/EA| + |M|·c/EI. */
  elements: { N: number; M1: number; M2: number; maxStrain: number }[];
  /** Elastic strain energy stored in the beam (N·mm = mJ). */
  energy: number;
  /** The nodal displacements (x, y, θ per node), to continue from (`start`). */
  u: Float64Array;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Element internal force (6) and tangent stiffness (6×6) at the current displacement u. */
function element(m: BeamModel, e: BeamModel["elements"][number], u: Float64Array) {
  const p = m.nodes[e.a], q = m.nodes[e.b];
  const i = 3 * e.a, j = 3 * e.b;
  const dx0 = q.x - p.x, dy0 = q.y - p.y;
  const L0 = Math.hypot(dx0, dy0), b0 = Math.atan2(dy0, dx0);
  const dx = dx0 + u[j] - u[i], dy = dy0 + u[j + 1] - u[i + 1];
  const L = Math.hypot(dx, dy), beta = Math.atan2(dy, dx);
  const rigid = wrap(beta - b0); // the element chord's rigid rotation
  const t1 = wrap(u[i + 2] - rigid), t2 = wrap(u[j + 2] - rigid);

  const EA = e.E * e.A, EI = e.E * e.I;
  const N = (EA * (L - L0)) / L0;
  const M1 = ((2 * EI) / L0) * (2 * t1 + t2);
  const M2 = ((2 * EI) / L0) * (t1 + 2 * t2);

  const c = Math.cos(beta), s = Math.sin(beta);
  const r = [-c, -s, 0, c, s, 0];
  const z = [s, -c, 0, -s, c, 0];
  const B = [r, [-s / L, c / L, 1, s / L, -c / L, 0], [-s / L, c / L, 0, s / L, -c / L, 1]];
  const D = [[EA / L0, 0, 0], [0, (4 * EI) / L0, (2 * EI) / L0], [0, (2 * EI) / L0, (4 * EI) / L0]];
  const loc = [N, M1, M2];

  const f = new Array(6).fill(0);
  for (let k = 0; k < 6; k++) for (let a = 0; a < 3; a++) f[k] += B[a][k] * loc[a];
  const K = Array.from({ length: 6 }, () => new Array(6).fill(0));
  for (let k = 0; k < 6; k++) {
    for (let l = 0; l < 6; l++) {
      let v = 0;
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) v += B[a][k] * D[a][b] * B[b][l];
      // geometric stiffness: the axial force and the end moments rotate with the chord
      v += (z[k] * z[l] * N) / L + ((r[k] * z[l] + z[k] * r[l]) * (M1 + M2)) / (L * L);
      K[k][l] = v;
    }
  }
  const maxStrain = Math.abs(N / EA) + (Math.max(Math.abs(M1), Math.abs(M2)) * e.c) / EI;
  // the internal forces are this energy's gradient: dU/dL = N, dU/dθ1 = M1, dU/dθ2 = M2
  const energy = (EA * (L - L0) ** 2) / (2 * L0) + ((2 * EI) / L0) * (t1 * t1 + t1 * t2 + t2 * t2);
  return { f, K, dofs: [i, i + 1, i + 2, j, j + 1, j + 2], N, M1, M2, maxStrain, energy };
}

/** Solve A·x = b in place (Gaussian elimination with partial pivoting). A chain
 *  of elements gives a banded matrix, so the work stays inside the band: the
 *  pivot is sought within it, and a swapped-in row reaches at most twice as far. */
function solveDense(A: number[][], b: number[]): number[] {
  const n = b.length;
  let bw = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (A[r][c] !== 0) bw = Math.max(bw, Math.abs(r - c));
  for (let k = 0; k < n; k++) {
    const last = Math.min(n - 1, k + bw), right = Math.min(n - 1, k + 2 * bw);
    let piv = k;
    for (let r = k + 1; r <= last; r++) if (Math.abs(A[r][k]) > Math.abs(A[piv][k])) piv = r;
    [A[k], A[piv]] = [A[piv], A[k]]; [b[k], b[piv]] = [b[piv], b[k]];
    for (let r = k + 1; r <= last; r++) {
      const f = A[r][k] / A[k][k];
      if (!f) continue;
      for (let c = k; c <= right; c++) A[r][c] -= f * A[k][c];
      b[r] -= f * b[k];
    }
  }
  const x = new Array(n).fill(0);
  for (let k = n - 1; k >= 0; k--) {
    let v = b[k];
    for (let c = k + 1, right = Math.min(n - 1, k + 2 * bw); c <= right; c++) v -= A[k][c] * x[c];
    x[k] = v / A[k][k];
  }
  return x;
}

/** LDLᵀ of a symmetric banded matrix (no pivoting). Stops at the first pivot
 *  that isn't positive and returns its index: the matrix isn't positive
 *  definite, and `L⁻ᵀ·e_k` is a direction of negative curvature along it. */
function ldlt(A: number[][], bw: number): { L: number[][]; d: number[]; bad: number } {
  const n = A.length, L = Array.from({ length: n }, () => new Array(n).fill(0)), d = new Array(n).fill(0);
  const scale = Math.max(1e-300, ...A.map((r, i) => Math.abs(r[i])));
  for (let k = 0; k < n; k++) {
    let v = A[k][k];
    for (let j = Math.max(0, k - bw); j < k; j++) v -= L[k][j] * L[k][j] * d[j];
    d[k] = v;
    if (!(v > 1e-12 * scale)) return { L, d, bad: k };
    L[k][k] = 1;
    for (let i = k + 1; i <= Math.min(n - 1, k + bw); i++) {
      let w = A[i][k];
      for (let j = Math.max(0, i - bw, k - bw); j < k; j++) w -= L[i][j] * L[k][j] * d[j];
      L[i][k] = w / v;
    }
  }
  return { L, d, bad: -1 };
}

function bandwidth(A: number[][]): number {
  let bw = 0;
  for (let r = 0; r < A.length; r++) for (let c = 0; c < A.length; c++) if (A[r][c] !== 0) bw = Math.max(bw, Math.abs(r - c));
  return bw;
}

/** `start`: begin from an earlier solution of the same model (its `u`) instead
 *  of from rest, stepping the prescribed displacements on from where they were
 *  there (displacement loads only: forces are ramped from zero regardless).
 *  The result is a stable equilibrium unless `stable: false`. */
export function solveBeam(m: BeamModel, load: BeamLoad, opts: { steps?: number; tol?: number; maxIter?: number; start?: Float64Array; stable?: boolean } = {}): BeamResult {
  const steps = opts.steps ?? 20, tol = opts.tol ?? 1e-10, maxIter = opts.maxIter ?? 50;
  const n = 3 * m.nodes.length;
  const constrained = new Map<number, number>(); // dof index → target value at full load
  for (const f of m.fixed) constrained.set(3 * f.node + f.dof, 0);
  for (const p of load.prescribed ?? []) constrained.set(3 * p.node + p.dof, p.value);
  const from = new Map([...constrained.keys()].map((d) => [d, opts.start?.[d] ?? 0])); // each one's value at load factor 0
  const free = [...Array(n).keys()].filter((d) => !constrained.has(d));
  const fext = new Float64Array(n);
  for (const f of load.forces ?? []) { fext[3 * f.node] += f.fx ?? 0; fext[3 * f.node + 1] += f.fy ?? 0; fext[3 * f.node + 2] += f.m ?? 0; }

  // Converge on the residual OR on a negligible Newton step: with stiff axial
  // terms (EA/L0 ≫ EI/L0³) round-off alone can keep the force residual above any
  // fixed tolerance even though the displacements have stopped changing.
  const span = Math.max(1, ...m.nodes.map((p) => Math.hypot(p.x, p.y)));
  const u = opts.start ? Float64Array.from(opts.start) : new Float64Array(n);
  const assemble = () => {
    const fint = new Float64Array(n);
    const K = Array.from({ length: n }, () => new Array(n).fill(0));
    const els = m.elements.map((e) => element(m, e, u));
    for (const el of els) {
      el.dofs.forEach((di, a) => { fint[di] += el.f[a]; el.dofs.forEach((dj, b) => { K[di][dj] += el.K[a][b]; }); });
    }
    return { fint, K, els };
  };

  /** Newton corrections at load factor `lam`; true once converged. */
  const correct = (lam: number): boolean => {
    for (let it = 0; it < maxIter; it++) {
      const { fint, K } = assemble();
      const R = free.map((d) => lam * fext[d] - fint[d]);
      const scale = Math.max(1, ...free.map((d) => Math.abs(lam * fext[d])), ...free.map((d) => Math.abs(fint[d])));
      if (Math.max(0, ...R.map(Math.abs)) <= tol * scale) return true;
      const du = solveDense(free.map((d) => free.map((e) => K[d][e])), R);
      if (!du.every(Number.isFinite)) return false;
      free.forEach((d, k) => { u[d] += du[k]; });
      if (Math.max(0, ...du.map(Math.abs)) <= 1e-12 * span) return true;
    }
    return false;
  };

  // Load stepping with a consistent predictor: a prescribed increment is carried
  // into the free DOFs through the tangent (K_ff·Δu_f = Δλ·f_ext − K_fp·Δu_p)
  // instead of jumping the driven node alone, which kinks its element and throws
  // Newton off. A step that still fails is undone and halved.
  let converged = true;
  let lam = 0, dlam = 1 / steps, cuts = 0;
  while (lam < 1 - 1e-12) {
    const next = Math.min(1, lam + dlam);
    const saved = u.slice();
    const { K } = assemble();
    const dp = new Map([...constrained].map(([d, v]) => [d, (next - lam) * (v - from.get(d)!)]));
    const rhs = free.map((d) => (next - lam) * fext[d] - [...dp].reduce((acc, [p, v]) => acc + K[d][p] * v, 0));
    const du = solveDense(free.map((d) => free.map((e) => K[d][e])), rhs);
    free.forEach((d, k) => { u[d] += du[k]; });
    for (const [d, v] of constrained) u[d] = from.get(d)! + next * (v - from.get(d)!);
    if (du.every(Number.isFinite) && correct(next)) { lam = next; continue; }
    u.set(saved);
    dlam /= 2;
    if (++cuts > 16) { converged = false; break; }
  }

  // Newton finds equilibria, stable or not: a beam pushed along a symmetric
  // path keeps to its symmetric shape past where a nudge would tip it into a
  // lower one (an arch's second mode). Where it stops is checked: if the
  // stiffness isn't positive definite there, it's moved off along the way
  // down and let settle to the stable shape, as the real strip would.
  if (converged && opts.stable !== false) converged = stabilise();

  function potential(): number {
    let E = 0;
    for (const e of m.elements) E += element(m, e, u).energy;
    for (let d = 0; d < n; d++) E -= fext[d] * u[d];
    return E;
  }
  function stabilise(): boolean {
    for (let round = 0; round < 6; round++) {
      const { K } = assemble();
      const Kff = free.map((d) => free.map((e) => K[d][e]));
      const bw = bandwidth(Kff), f = ldlt(Kff, bw);
      if (f.bad < 0) return true;
      // the direction of negative curvature: Lᵀ·φ = e_k
      const phi = new Array(free.length).fill(0);
      phi[f.bad] = 1;
      for (let i = f.bad - 1; i >= 0; i--) {
        let v = 0;
        for (let j = i + 1; j <= Math.min(f.bad, i + bw); j++) v -= f.L[j][i] * phi[j];
        phi[i] = v;
      }
      const big = Math.max(...phi.map(Math.abs)) || 1;
      // step down it, whichever way goes further down, then minimise
      const u0 = u.slice(), E0 = potential();
      let best = { E: E0, u: u0 };
      for (const sgn of [1, -1]) {
        for (let a = 1e-4 * span; a <= 0.1 * span; a *= 2) {
          u.set(u0);
          free.forEach((d, k) => { u[d] += (sgn * a * phi[k]) / big; });
          const E = potential();
          if (E < best.E) best = { E, u: u.slice() };
        }
      }
      if (best.E >= E0 - 1e-12 * Math.max(1, Math.abs(E0))) { u.set(u0); return true; } // flat: as good as stable
      u.set(best.u);
      if (!minimise()) return false;
    }
    return true;
  }
  /** Damped Newton on the potential: the stiffness shifted until positive
   *  definite, and every step lowering the energy. */
  function minimise(): boolean {
    let mu = 0;
    for (let it = 0; it < 200; it++) {
      const { fint, K } = assemble();
      const g = free.map((d) => fint[d] - fext[d]);
      const scale = Math.max(1, ...free.map((d) => Math.abs(fext[d])), ...free.map((d) => Math.abs(fint[d])));
      if (Math.max(0, ...g.map(Math.abs)) <= 1e-9 * scale) return true;
      const Kff = free.map((d) => free.map((e) => K[d][e])), diag = Math.max(...Kff.map((r, i) => Math.abs(r[i])));
      let A = Kff;
      for (let tries = 0; tries < 40; tries++) {
        A = Kff.map((r, i) => r.map((v, j) => (i === j ? v + mu * diag : v)));
        if (ldlt(A, bandwidth(A)).bad < 0) break;
        mu = Math.max(mu * 4, 1e-8);
      }
      const step = solveDense(A.map((r) => r.slice()), g.map((v) => -v));
      const u0 = u.slice(), E0 = potential(), slope = step.reduce((acc, v, k) => acc + v * g[k], 0);
      let ok = false;
      for (let a = 1; a > 1e-8; a /= 2) {
        u.set(u0);
        free.forEach((d, k) => { u[d] += a * step[k]; });
        if (potential() <= E0 + 1e-4 * a * slope) { ok = true; break; }
      }
      if (!ok) { u.set(u0); if (mu > 1e6) return false; mu = Math.max(mu * 10, 1e-6); continue; }
      mu /= 4;
      if (Math.max(...step.map(Math.abs)) <= 1e-12 * span) return true;
    }
    return false;
  }

  const { fint, els } = assemble();
  const reactions: Record<string, number> = {};
  for (const d of constrained.keys()) reactions[`${Math.floor(d / 3)}:${d % 3}`] = fint[d] - fext[d];
  return {
    converged,
    nodes: m.nodes.map((p, k) => ({ x: p.x + u[3 * k], y: p.y + u[3 * k + 1], theta: u[3 * k + 2] })),
    reactions,
    elements: els.map((e) => ({ N: e.N, M1: e.M1, M2: e.M2, maxStrain: e.maxStrain })),
    energy: els.reduce((sum, e) => sum + e.energy, 0),
    u,
  };
}

/** A straight cantilever along +x, clamped at node 0, in `n` elements. */
export function cantilever(L: number, n: number, sec: { E: number; A: number; I: number; c: number }): BeamModel {
  return {
    nodes: Array.from({ length: n + 1 }, (_, k) => ({ x: (L * k) / n, y: 0 })),
    elements: Array.from({ length: n }, (_, k) => ({ a: k, b: k + 1, ...sec })),
    fixed: [{ node: 0, dof: 0 }, { node: 0, dof: 1 }, { node: 0, dof: 2 }],
  };
}

/** Rectangular section, bending about the axis parallel to `width`. */
export const rectSection = (E: number, width: number, thickness: number) =>
  ({ E, A: width * thickness, I: (width * thickness ** 3) / 12, c: thickness / 2 });
