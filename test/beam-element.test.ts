// Beam elements: long compliant strips clamped between two parts, solved as
// large-deflection beams (src/sim/beam2d.ts) as the parts move. Checked against
// exact linear theory, and against the published curved-beam bistable result.
import { describe, it, expect } from "vitest";
import { realSession } from "./helpers";
import { flexureEquilibria, flexureState, flexureSweep } from "../src/sim/flexure";
import type { CadSession } from "../src/core/command/session";

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

const E = 1000, W = 6, T = 0.8, EI = (E * W * T ** 3) / 12;

/** A ground part and a shuttle that slides along −Y by `travel`, with the given
 *  beams from the ground to the shuttle. */
async function rig(beams: { from: [number, number]; to: [number, number]; profile: "straight" | "cosine" }[], travel = 0) {
  const s = realSession();
  await dis(s, "parameter.add", { name: "travel", expression: String(travel) });
  const mat = (await dis(s, "material.create", { name: "Test", kind: "plastic", youngsModulus: E, allowableStrain: 0.1 }))[0];
  const ground = (await dis(s, "component.create", { name: "Frame" }))[0];
  const shuttle = (await dis(s, "component.create", { name: "Shuttle" }))[0];
  await dis(s, "material.assign", { component: ground, material: mat });
  const o = { x: 0, y: 0, z: 0 };
  await dis(s, "joint.create", { kind: "slider", base: ground, moved: shuttle, baseOrigin: o, movedOrigin: o, axis: { x: 0, y: -1, z: 0 }, value: "travel", name: "Guide" });
  for (const [i, b] of beams.entries()) {
    await dis(s, "joint.create", { kind: "beam", base: ground, moved: shuttle, baseOrigin: { x: b.from[0], y: b.from[1], z: 0 }, movedOrigin: { x: b.to[0], y: b.to[1], z: 0 }, beam: { width: W, thickness: T, profile: b.profile }, name: `Beam ${i}` });
  }
  await s.recompute();
  return s;
}

describe("beam elements", () => {
  it("a straight strip pushed sideways at its guided end is the fixed-guided beam: F = 12EI·δ/L³", async () => {
    const L = 30, d = 0.02;
    const s = await rig([{ from: [-L, 0], to: [0, 0], profile: "straight" }]);
    const [p] = flexureSweep(s.doc, "travel", [d]);
    expect(p.error).toBeUndefined();
    expect(p.effort / ((12 * EI * d) / L ** 3)).toBeCloseTo(1, 2);
    // and its energy is ½kδ²
    expect(p.energy / (0.5 * ((12 * EI) / L ** 3) * d * d)).toBeCloseTo(1, 2);
  });

  it("places nothing, needs a section, and won't take a cosine strip with its ends level in X", async () => {
    const s = await rig([]);
    const [g, sh] = Object.keys(s.doc.components).filter((k) => k !== s.doc.rootComponentId);
    const o = { x: 0, y: 0, z: 0 };
    expect((await s.dispatch("joint.create", { kind: "beam", base: g, moved: sh, baseOrigin: o, movedOrigin: { x: 5, y: 0, z: 0 } })).ok).toBe(false);
    expect((await s.dispatch("joint.create", { kind: "beam", base: g, moved: sh, baseOrigin: o, movedOrigin: { x: 0, y: 5, z: 0 }, beam: { width: 6, thickness: 1, profile: "cosine" } })).ok).toBe(false);
  });

  // Qiu, Lang & Slocum, "A curved-beam bistable mechanism" (JMEMS 2004): a
  // clamped-clamped cosine beam whose centre can't rotate (a double beam) snaps
  // at F_top ≈ 740·EI·h/L³, pulls back at most ≈ 370·EI·h/L³ past the middle,
  // and rests again just short of 2h.
  it("a double curved beam is bistable, as the curved-beam bistable mechanism predicts", async () => {
    const L = 40, h = 3; // span and rise of each beam; two beams, so twice the force
    const halves: { from: [number, number]; to: [number, number]; profile: "cosine" }[] = [];
    for (const y0 of [0, 8]) for (const side of [-1, 1]) halves.push({ from: [side * (L / 2), y0], to: [0, y0 + h], profile: "cosine" });
    const s = await rig(halves);
    const st = flexureEquilibria(s.doc, "travel", 0, 2.2 * h, 66);
    const scale = (2 * EI * h) / L ** 3; // two beams
    const stable = st.states.filter((q) => q.stable).map((q) => q.value / h);
    const between = st.poses.filter((p) => p.value > 0 && p.value < stable[1] * h);
    const peak = st.snap!.effort / scale, pull = Math.min(...between.map((p) => p.effort)) / scale;
    console.log(`F_top ${peak.toFixed(0)}·EIh/L³ (paper ≈ 740), F_bottom ${pull.toFixed(0)} (≈ −370); rests at ${stable.map((v) => v.toFixed(2)).join(", ")}·h`);
    expect(st.multistable).toBe(true);
    expect(stable[0]).toBeCloseTo(0, 6);
    expect(stable[1]).toBeGreaterThan(1.75);
    expect(stable[1]).toBeLessThan(2);
    expect(peak / 740).toBeGreaterThan(0.9);
    expect(peak / 740).toBeLessThan(1.1);
    expect(-pull / 370).toBeGreaterThan(0.85);
    expect(-pull / 370).toBeLessThan(1.15);
    // the document is left posed where it was
    expect(flexureState(s.doc).energy).toBeCloseTo(0, 9);
  }, 120000);
});
