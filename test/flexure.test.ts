import { describe, it, expect } from "vitest";
import { realSession } from "./helpers";
import { flexureStiffness, flexureStrain, flexureState, flexureSweep } from "../src/sim/flexure";
import { solveBeam, cantilever, rectSection } from "../src/sim/beam2d";
import type { CadSession } from "../src/core/command/session";

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

const SEC = { length: 4, width: 6, thickness: 1 }; // a TPU hinge strip (mm)
const Z = { x: 0, y: 0, z: 1 };

/** A four-bar of flexures, components modelled in world coordinates (so every
 *  connector is the pivot itself): ground pivots O2, O4; crank tip A; rocker tip B. */
async function fourBar(s: CadSession, O2: { x: number; y: number }, A: { x: number; y: number }, B: { x: number; y: number }, O4: { x: number; y: number }) {
  await dis(s, "parameter.add", { name: "theta", expression: "0", min: -30, max: 30 });
  const tpu = (await dis(s, "material.create", { name: "TPU", kind: "plastic", youngsModulus: 1190, allowableStrain: 0.08 }))[0];
  const comp = async (name: string) => { const c = (await dis(s, "component.create", { name }))[0]; await dis(s, "material.assign", { material: tpu, component: c }); return c; };
  const crank = await comp("Crank"), coupler = await comp("Coupler"), rocker = await comp("Rocker");
  const P = (p: { x: number; y: number }) => ({ x: p.x, y: p.y, z: 0 });
  const flex = { flexure: SEC, kind: "flexure", axis: Z };
  await dis(s, "joint.create", { ...flex, moved: crank, baseOrigin: P(O2), movedOrigin: P(O2), value: "theta", name: "O2" });
  await dis(s, "joint.create", { ...flex, base: crank, moved: coupler, baseOrigin: P(A), movedOrigin: P(A), solve: true, name: "A" });
  await dis(s, "joint.create", { ...flex, moved: rocker, baseOrigin: P(O4), movedOrigin: P(O4), solve: true, name: "O4" });
  await dis(s, "joint.create", { ...flex, base: coupler, moved: rocker, baseOrigin: P(B), movedOrigin: P(B), closes: true, name: "B" });
  return { crank, coupler, rocker };
}

/** Rocker angle (deg, from rest) by circle intersection: B lies on the circle of
 *  radius |O4B| about O4 and of radius |AB| about A(θ); take the root nearest rest. */
function rockerAngle(O2: { x: number; y: number }, A0: { x: number; y: number }, B0: { x: number; y: number }, O4: { x: number; y: number }, thetaDeg: number) {
  const t = (thetaDeg * Math.PI) / 180;
  const A = { x: O2.x + (A0.x - O2.x) * Math.cos(t) - (A0.y - O2.y) * Math.sin(t), y: O2.y + (A0.x - O2.x) * Math.sin(t) + (A0.y - O2.y) * Math.cos(t) };
  const r3 = Math.hypot(B0.x - A0.x, B0.y - A0.y), r4 = Math.hypot(B0.x - O4.x, B0.y - O4.y);
  const d = Math.hypot(A.x - O4.x, A.y - O4.y), a = (r4 * r4 - r3 * r3 + d * d) / (2 * d), h = Math.sqrt(r4 * r4 - a * a);
  const m = { x: O4.x + (a * (A.x - O4.x)) / d, y: O4.y + (a * (A.y - O4.y)) / d };
  const cands = [{ x: m.x + (h * (A.y - O4.y)) / d, y: m.y - (h * (A.x - O4.x)) / d }, { x: m.x - (h * (A.y - O4.y)) / d, y: m.y + (h * (A.x - O4.x)) / d }];
  const B = cands.sort((p, q) => Math.hypot(p.x - B0.x, p.y - B0.y) - Math.hypot(q.x - B0.x, q.y - B0.y))[0];
  return ((Math.atan2(B.y - O4.y, B.x - O4.x) - Math.atan2(B0.y - O4.y, B0.x - O4.x)) * 180) / Math.PI;
}

describe("flexure hinge model", () => {
  it("matches the beam solver: a strip under an end moment bends with k = EI/L and ε = tφ/2L", () => {
    const E = 1190, M = 150; // N·mm
    const r = solveBeam(cantilever(SEC.length, 20, rectSection(E, SEC.width, SEC.thickness)), { forces: [{ node: 20, m: M }] });
    const phi = r.nodes[20].theta; // radians
    expect(M / phi).toBeCloseTo(flexureStiffness(E, SEC), 6);
    expect(r.elements[0].maxStrain).toBeCloseTo(flexureStrain(SEC, (phi * 180) / Math.PI), 6);
  });
});

describe("closed-loop four-bar", () => {
  const O2 = { x: 0, y: 0 }, A0 = { x: 0, y: 40 }, B0 = { x: 60, y: 50 }, O4 = { x: 60, y: 0 };

  it("solves the rocker to match the analytic position, and the loop closes", async () => {
    const s = realSession();
    await fourBar(s, O2, A0, B0, O4);
    for (const th of [0, 5, 12, 20, 25, -10, -20, -30]) {
      const st = flexureState(s.doc, { theta: String(th) });
      expect(st.error, `theta ${th}`).toBeUndefined();
      const o4 = st.flexures.find((f) => f.name === "O4")!;
      expect(o4.angle).toBeCloseTo(rockerAngle(O2, A0, B0, O4, th), 6);
      // every hinge's rotations are consistent around the loop: Σ = 0 for a closed planar loop
      const [o2, a, , b] = ["O2", "A", "O4", "B"].map((n) => st.flexures.find((f) => f.name === n)!.angle);
      expect(o2 + a + b - o4.angle).toBeCloseTo(0, 6);
    }
  });

  it("a parallelogram's input torque is exactly 4kθ (all four hinges turn by ±θ)", async () => {
    const s = realSession();
    await fourBar(s, { x: 0, y: 0 }, { x: 0, y: 40 }, { x: 60, y: 40 }, { x: 60, y: 0 });
    const k = flexureStiffness(1190, SEC);
    for (const p of flexureSweep(s.doc, "theta", [-20, -5, 10, 25])) {
      for (const f of p.flexures) expect(Math.abs(f.angle)).toBeCloseTo(Math.abs(p.value), 6);
      expect(p.effort).toBeCloseTo(4 * k * (p.value * Math.PI) / 180, 3);
      expect(p.energy).toBeCloseTo(2 * k * ((p.value * Math.PI) / 180) ** 2, 6);
    }
  });

  it("reports strain against the material's allowable, and flags a loop that cannot close", async () => {
    const s = realSession();
    await fourBar(s, O2, A0, B0, O4);
    const st = flexureState(s.doc, { theta: "20" });
    expect(st.utilisation).toBeGreaterThan(0);
    expect(st.utilisation).toBeCloseTo(Math.max(...st.flexures.map((f) => f.strain)) / 0.08, 9);
  });

  it("flags a pose where the loop cannot close", async () => {
    // non-Grashof: coupler 36.1, rocker 67.1, so with the crank tip at (40, 0) the
    // tip is 20 mm from O4, nearer than |rocker − coupler| = 31 mm can reach
    const s = realSession();
    await fourBar(s, { x: 0, y: 0 }, { x: 0, y: 40 }, { x: 30, y: 60 }, { x: 60, y: 0 });
    expect(flexureState(s.doc, { theta: "10" }).error).toBeUndefined();
    expect(flexureState(s.doc, { theta: "-90" }).error).toMatch(/loop does not close/);
  });
});
