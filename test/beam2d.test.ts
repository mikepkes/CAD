import { describe, it, expect } from "vitest";
import { solveBeam, cantilever, rectSection } from "../src/sim/beam2d";

// Unit beam: EI = 1, very stiff axially (inextensible, like the elastica).
const SEC = { E: 1, A: 1e6, I: 1, c: 0.5 };

/** Independent reference: the inextensible elastica of a cantilever with a tip
 *  load P perpendicular to the undeformed beam (EI θ'' = -P cos θ, θ(0) = 0,
 *  θ'(L) = 0), solved by shooting on θ'(0) with RK4 along the arc. */
function elastica(alpha: number): { x: number; y: number } {
  const integrate = (k0: number) => {
    const n = 4000, h = 1 / n;
    let th = 0, k = k0, x = 0, y = 0;
    const f = (t: number, kk: number) => [kk, -alpha * Math.cos(t), Math.cos(t), Math.sin(t)];
    for (let i = 0; i < n; i++) {
      const a = f(th, k), b = f(th + (h / 2) * a[0], k + (h / 2) * a[1]);
      const c = f(th + (h / 2) * b[0], k + (h / 2) * b[1]), d = f(th + h * c[0], k + h * c[1]);
      th += (h / 6) * (a[0] + 2 * b[0] + 2 * c[0] + d[0]);
      k += (h / 6) * (a[1] + 2 * b[1] + 2 * c[1] + d[1]);
      x += (h / 6) * (a[2] + 2 * b[2] + 2 * c[2] + d[2]);
      y += (h / 6) * (a[3] + 2 * b[3] + 2 * c[3] + d[3]);
    }
    return { k, x, y };
  };
  // the root curvature equals the root moment αL (as a fraction of EI/L); bisect on it
  let lo = 0, hi = alpha;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (integrate(mid).k > 0) hi = mid; else lo = mid; }
  return integrate((lo + hi) / 2);
}

describe("co-rotational 2D beam", () => {
  it("matches small-deflection theory: δ = PL³/3EI", () => {
    const P = 1e-4;
    const r = solveBeam(cantilever(1, 10, SEC), { forces: [{ node: 10, fy: P }] }, { steps: 1 });
    expect(r.converged).toBe(true);
    expect(r.nodes[10].y / (P / 3)).toBeCloseTo(1, 4);
  });

  it("bends a pure tip moment into an exact circular arc", () => {
    const phi = Math.PI / 2; // M = EI·φ/L curls the beam through a quarter turn
    const r = solveBeam(cantilever(1, 20, SEC), { forces: [{ node: 20, m: phi }] });
    expect(r.converged).toBe(true);
    expect(r.nodes[20].theta).toBeCloseTo(phi, 6);
    expect(r.nodes[20].x).toBeCloseTo(Math.sin(phi) / phi, 3);
    expect(r.nodes[20].y).toBeCloseTo((1 - Math.cos(phi)) / phi, 3);
  });

  for (const alpha of [1, 3, 10]) {
    it(`tracks the large-deflection elastica for a tip load, PL²/EI = ${alpha}`, () => {
      const ref = elastica(alpha);
      const r = solveBeam(cantilever(1, 40, SEC), { forces: [{ node: 40, fy: alpha }] }, { steps: 30 });
      expect(r.converged).toBe(true);
      expect(Math.abs(r.nodes[40].x - ref.x)).toBeLessThan(2e-3);
      expect(Math.abs(r.nodes[40].y - ref.y)).toBeLessThan(2e-3);
    });
  }

  it("reproduces Bisshopp & Drucker's classic tip deflection (PL²/EI = 1 → δ/L = 0.3017)", () => {
    const r = solveBeam(cantilever(1, 40, SEC), { forces: [{ node: 40, fy: 1 }] });
    expect(r.nodes[40].y).toBeCloseTo(0.3017, 3);
  });

  it("displacement control returns the force that drives the motion", () => {
    const viaForce = solveBeam(cantilever(1, 30, SEC), { forces: [{ node: 30, fy: 3 }] });
    const viaDisp = solveBeam(cantilever(1, 30, SEC), { prescribed: [{ node: 30, dof: 1, value: viaForce.nodes[30].y }] });
    expect(viaDisp.converged).toBe(true);
    // with only y prescribed, the tip still swings in x, so the reaction is the applied load
    expect(viaDisp.reactions["30:1"]).toBeCloseTo(3, 3);
  });

  // Worked example in docs/COMPLIANT.md: a star box snap tongue (6 × 2 mm, free
  // from its root at z = 13.4 to the barb band at z ≈ 18.3) pushed 0.85 mm by the
  // mating lip, bending across the print layers (TPU for AMS, E_Z = 600 MPa).
  it("worked example: the star box tongue as printed vs. lengthened", () => {
    const tongue = (L: number, t: number) =>
      solveBeam(cantilever(L, 20, rectSection(600, 6, t)), { prescribed: [{ node: 20, dof: 1, value: 0.85 }] });
    const asPrinted = tongue(4.9, 2);
    expect(asPrinted.reactions["20:1"]).toBeCloseTo(53.5, 0); // N per tongue
    expect(asPrinted.elements[0].maxStrain).toBeCloseTo(0.108, 3); // ~10.8% at the root
    const longer = tongue(9.8, 2);
    expect(longer.reactions["20:1"]).toBeCloseTo(6.6, 0);
    expect(longer.elements[0].maxStrain).toBeCloseTo(0.027, 3);
  });

  it("reports peak bending strain εmax = M·c/EI (= 3tδ/2L² for a small tip deflection)", () => {
    const sec = rectSection(600, 6, 2); // a 6×2 mm TPU strip, E = 600 MPa
    const L = 10, d = 0.05;
    const r = solveBeam(cantilever(L, 20, sec), { prescribed: [{ node: 20, dof: 1, value: d }] }, { steps: 1 });
    expect(r.elements[0].maxStrain / ((3 * 2 * d) / (2 * L * L))).toBeCloseTo(1, 2);
  });
});
