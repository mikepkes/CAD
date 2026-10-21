// A general-purpose geometric constraint solver.
//
// The sketch is reduced to a flat array of scalar variables (point coords,
// radii, …). Each constraint contributes a "residual block": a small vector
// function that should equal zero when the constraint is satisfied, together
// with the list of variable indices it depends on. We minimise the sum of
// squared residuals with Levenberg–Marquardt, using a numeric (central-
// difference) Jacobian restricted to each block's own variables.
//
// This is independent of three.js / React and of the sketch data model, so it
// can be unit-tested and reused (e.g. for 3D assembly mates later).

export interface ResidualBlock {
  /** Variable indices this block reads. */
  vars: number[];
  /** Number of scalar residual components produced by `eval`. */
  dim: number;
  /** Compute the residual vector (length === dim) at the given state. */
  eval: (x: Float64Array) => number[];
  /** Relative weight (default 1). Soft/drag constraints use < 1. */
  weight?: number;
}

export interface SolveOptions {
  maxIter?: number;
  tol?: number; // convergence tolerance on max |residual|
  lockedVars?: boolean[]; // vars that must not move
}

export interface SolveResult {
  converged: boolean;
  iterations: number;
  residualNorm: number; // L2 norm of residual vector
  maxResidual: number;
  dof: number; // degrees of freedom = freeVars - rank(J)
  rank: number;
  redundant: boolean; // rank < number of independent residual rows requested
}

const EPS = 1e-7;

/** Solve in place: `x` is mutated toward a constraint-satisfying state. */
export function solve(
  x: Float64Array,
  blocks: ResidualBlock[],
  opts: SolveOptions = {}
): SolveResult {
  const n = x.length;
  const maxIter = opts.maxIter ?? 120;
  const tol = opts.tol ?? 1e-10;
  const locked = opts.lockedVars ?? new Array(n).fill(false);

  // Row layout: each block occupies `dim` consecutive residual rows.
  let m = 0;
  for (const b of blocks) m += b.dim;

  if (m === 0) {
    return {
      converged: true,
      iterations: 0,
      residualNorm: 0,
      maxResidual: 0,
      dof: countFree(locked),
      rank: 0,
      redundant: false,
    };
  }

  const r = new Float64Array(m);
  const J = new Float64Array(m * n); // dense; sketches are small

  const evalResiduals = (state: Float64Array, out: Float64Array) => {
    let row = 0;
    for (const b of blocks) {
      const w = b.weight ?? 1;
      const vals = b.eval(state);
      for (let k = 0; k < b.dim; k++) out[row + k] = vals[k] * w;
      row += b.dim;
    }
  };

  const buildJacobian = (state: Float64Array) => {
    J.fill(0);
    let row = 0;
    const tmp = state.slice();
    for (const b of blocks) {
      const w = b.weight ?? 1;
      for (const j of b.vars) {
        if (locked[j]) continue;
        const h = EPS * Math.max(1, Math.abs(state[j]));
        tmp[j] = state[j] + h;
        const fp = b.eval(tmp);
        tmp[j] = state[j] - h;
        const fm = b.eval(tmp);
        tmp[j] = state[j];
        const inv = w / (2 * h);
        for (let k = 0; k < b.dim; k++) {
          J[(row + k) * n + j] = (fp[k] - fm[k]) * inv;
        }
      }
      row += b.dim;
    }
  };

  let lambda = 1e-3;
  let iterations = 0;
  let converged = false;

  evalResiduals(x, r);
  let cost = l2sq(r);

  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;
    const maxRes = maxAbs(r);
    if (maxRes < tol) {
      converged = true;
      break;
    }

    buildJacobian(x);

    // Normal equations over the FREE variables only.
    const free: number[] = [];
    for (let j = 0; j < n; j++) if (!locked[j]) free.push(j);
    const nf = free.length;
    if (nf === 0) {
      converged = maxRes < 1e-6;
      break;
    }

    // H = JᵀJ (nf x nf), g = Jᵀr (nf)
    const H = new Float64Array(nf * nf);
    const g = new Float64Array(nf);
    for (let a = 0; a < nf; a++) {
      const ja = free[a];
      let gi = 0;
      for (let row = 0; row < m; row++) gi += J[row * n + ja] * r[row];
      g[a] = gi;
      for (let b = a; b < nf; b++) {
        const jb = free[b];
        let h = 0;
        for (let row = 0; row < m; row++) h += J[row * n + ja] * J[row * n + jb];
        H[a * nf + b] = h;
        H[b * nf + a] = h;
      }
    }

    // LM trust loop: grow lambda until the step reduces cost.
    let accepted = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const A = H.slice();
      for (let a = 0; a < nf; a++) A[a * nf + a] += lambda * (H[a * nf + a] + 1e-9);
      const rhs = new Float64Array(nf);
      for (let a = 0; a < nf; a++) rhs[a] = -g[a];
      const step = solveLinear(A, rhs, nf);
      if (!step) {
        lambda *= 10;
        continue;
      }
      const trial = x.slice();
      for (let a = 0; a < nf; a++) trial[free[a]] += step[a];
      evalResiduals(trial, r);
      const trialCost = l2sq(r);
      if (trialCost < cost) {
        x.set(trial);
        cost = trialCost;
        lambda = Math.max(lambda * 0.5, 1e-12);
        accepted = true;
        break;
      } else {
        lambda *= 4;
      }
    }

    if (!accepted) {
      // Can't improve — restore residuals for the current x and stop.
      evalResiduals(x, r);
      break;
    }
  }

  evalResiduals(x, r);
  const maxResidual = maxAbs(r);
  converged = converged || maxResidual < 1e-7;

  // Rank / DOF analysis on the final Jacobian.
  buildJacobian(x);
  const free: number[] = [];
  for (let j = 0; j < n; j++) if (!locked[j]) free.push(j);
  const rank = jacobianRank(J, m, n, free);
  const dof = free.length - rank;
  const redundant = rank < m && m <= free.length ? false : rank < Math.min(m, free.length);

  return {
    converged,
    iterations,
    residualNorm: Math.sqrt(cost),
    maxResidual,
    dof: Math.max(0, dof),
    rank,
    redundant,
  };
}

function countFree(locked: boolean[]): number {
  let c = 0;
  for (const l of locked) if (!l) c++;
  return c;
}

function l2sq(r: Float64Array): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) s += r[i] * r[i];
  return s;
}

function maxAbs(r: Float64Array): number {
  let mx = 0;
  for (let i = 0; i < r.length; i++) mx = Math.max(mx, Math.abs(r[i]));
  return mx;
}

/** Solve A x = b for a dense n×n system (Gaussian elimination, partial pivot). */
function solveLinear(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const M = A.slice();
  const x = b.slice();
  for (let col = 0; col < n; col++) {
    // pivot
    let piv = col;
    let pivVal = Math.abs(M[col * n + col]);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(M[row * n + col]);
      if (v > pivVal) {
        pivVal = v;
        piv = row;
      }
    }
    if (pivVal < 1e-14) return null; // singular
    if (piv !== col) {
      for (let k = 0; k < n; k++) {
        const t = M[col * n + k];
        M[col * n + k] = M[piv * n + k];
        M[piv * n + k] = t;
      }
      const t = x[col];
      x[col] = x[piv];
      x[piv] = t;
    }
    const diag = M[col * n + col];
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = M[row * n + col] / diag;
      if (factor === 0) continue;
      for (let k = col; k < n; k++) M[row * n + k] -= factor * M[col * n + k];
      x[row] -= factor * x[col];
    }
  }
  for (let i = 0; i < n; i++) x[i] /= M[i * n + i];
  return x;
}

/** Numerical rank of the Jacobian restricted to the free columns. */
function jacobianRank(J: Float64Array, m: number, n: number, free: number[]): number {
  const nf = free.length;
  if (nf === 0 || m === 0) return 0;
  // Copy rows into a compact m×nf matrix.
  const Mrows: Float64Array[] = [];
  for (let row = 0; row < m; row++) {
    const r = new Float64Array(nf);
    for (let a = 0; a < nf; a++) r[a] = J[row * n + free[a]];
    Mrows.push(r);
  }
  let rank = 0;
  const tol = 1e-9;
  for (let col = 0; col < nf && rank < m; col++) {
    // find pivot row at/after `rank`
    let piv = -1;
    let pivVal = tol;
    for (let row = rank; row < m; row++) {
      const v = Math.abs(Mrows[row][col]);
      if (v > pivVal) {
        pivVal = v;
        piv = row;
      }
    }
    if (piv === -1) continue;
    const t = Mrows[rank];
    Mrows[rank] = Mrows[piv];
    Mrows[piv] = t;
    const pr = Mrows[rank];
    const inv = 1 / pr[col];
    for (let row = 0; row < m; row++) {
      if (row === rank) continue;
      const f = Mrows[row][col] * inv;
      if (f === 0) continue;
      for (let k = col; k < nf; k++) Mrows[row][k] -= f * pr[k];
    }
    rank++;
  }
  return rank;
}
