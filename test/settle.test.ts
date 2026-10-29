// Force-driven equilibrium: a planar joint's free axes settle where the stored
// elastic energy is least. Checked on the blade parallelogram, whose answers
// are exact in linear theory: stiffness 2·12EI/L³, and the platform drifts
// toward the base by 0.6·δ²/L as it moves sideways δ (each blade's ends draw
// together by ∫½w'² for the fixed-guided shape). It turns, slightly: both
// blades bend the same way, so their end moments add (2·6EIδ/L²), and the
// platform balances that couple with opposite axial forces in the blades, whose
// stretch tilts it by θ = 2T²δ/(L·b²) (b the blades' spacing).
import { describe, it, expect } from "vitest";
import { realSession } from "./helpers";
import { flexureSweep, flexureState } from "../src/sim/flexure";
import type { CadSession } from "../src/core/command/session";

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

const E = 1000, W = 6, T = 0.8, L = 30, EI = (E * W * T ** 3) / 12;

async function parallelogram(free: { y?: boolean; angle?: boolean } = { y: true, angle: true }) {
  const s = realSession();
  await dis(s, "parameter.add", { name: "dx", expression: "0" });
  const mat = (await dis(s, "material.create", { name: "Test", kind: "plastic", youngsModulus: E, allowableStrain: 0.1 }))[0];
  const base = (await dis(s, "component.create", { name: "Base" }))[0];
  const platform = (await dis(s, "component.create", { name: "Platform" }))[0];
  await dis(s, "material.assign", { component: base, material: mat });
  const o = { x: 0, y: L, z: 0 };
  const planar: Record<string, string> = { x: "dx" };
  if (!free.y) planar.y = "0";
  if (!free.angle) planar.angle = "0";
  const j = (await dis(s, "joint.create", { kind: "planar", base, moved: platform, baseOrigin: o, movedOrigin: o, planar, name: "Stage" }))[0];
  for (const x of [-10, 10]) await dis(s, "joint.create", { kind: "beam", base, moved: platform, baseOrigin: { x, y: 0, z: 0 }, movedOrigin: { x, y: L, z: 0 }, beam: { width: W, thickness: T }, name: `Blade ${x}` });
  await s.recompute();
  return { s, joint: () => s.doc.joints[j] };
}

describe("free planar axes settle at minimum energy", () => {
  it("a blade parallelogram: stiffness 24EI/L³, drift 0.6·δ²/L toward the base, tilt 2T²δ/(L·b²)", async () => {
    const { s, joint } = await parallelogram();
    for (const d of [0.5, 1, 2]) {
      const [p] = flexureSweep(s.doc, "dx", [d]);
      expect(p.error).toBeUndefined();
      const pv = joint().planarValue!;
      expect(pv.x).toBe(d);
      expect(pv.y / (-0.6 * d * d / L), `drift at δ = ${d}`).toBeCloseTo(1, 1);
      const b = 20, tilt = (2 * T * T * d) / (L * b * b) * (180 / Math.PI);
      if (d <= 1) expect(Math.abs(pv.angle) / tilt, `tilt at δ = ${d}`).toBeCloseTo(1, 1); // linear theory: small δ only
      expect(p.effort / ((24 * EI * d) / L ** 3), `stiffness at δ = ${d}`).toBeCloseTo(1, 1);
    }
  });

  it("the drift is what keeps the blades from stretching: held level, the same push is stiffer", async () => {
    const free = await parallelogram();
    const held = await parallelogram({ y: false, angle: true });
    const d = 2;
    const f = flexureSweep(free.s.doc, "dx", [d])[0].effort, g = flexureSweep(held.s.doc, "dx", [d])[0].effort;
    expect(g).toBeGreaterThan(1.05 * f); // the blades must stretch instead of drawing in
    expect(flexureState(held.s.doc).energy).toBeGreaterThan(flexureState(free.s.doc).energy);
  });

  it("a free axis with nothing elastic on it stays put", async () => {
    const s = realSession();
    const a = (await dis(s, "component.create", { name: "A" }))[0], b = (await dis(s, "component.create", { name: "B" }))[0];
    const o = { x: 0, y: 0, z: 0 };
    const j = (await dis(s, "joint.create", { kind: "planar", base: a, moved: b, baseOrigin: o, movedOrigin: o, planar: { x: "3" } }))[0];
    await s.recompute();
    expect(s.doc.joints[j].planarValue).toEqual({ x: 3, y: 0, angle: 0 });
    expect((await s.dispatch("joint.create", { kind: "planar", base: a, moved: b, baseOrigin: o, movedOrigin: o, planar: { x: "nope" } })).ok).toBe(false);
  });
});
