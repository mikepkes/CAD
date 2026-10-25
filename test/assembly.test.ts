// Parametric jointed duplication: a component pattern + relational joint
// templates expand into a scissor whose stage count is a parameter and which
// still articulates. This test exercises the kinematics only (no geometry): it
// builds the rule, expands it, runs the assembly FK, and checks that the apex
// rises with the drive angle and with the stage count.
import { describe, it, expect } from "vitest";
import { realSession } from "./helpers";
import { expandAssembly } from "../src/core/assembly";
import { resolveComponentWorld } from "../src/core/recompute";
import { resolveParameters } from "../src/model/parameters";
import { applyPoint } from "../src/math/transform";
import type { CadSession } from "../src/core/command/session";

const L = 60;
const AXIS = { x: 0, y: -1, z: 0 }; // rotate in XZ so +theta lifts toward +Z

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

/** Build the scissor as one source stage + a jointed pattern of `stages`. */
async function buildScissor(theta: number, stages: number): Promise<CadSession> {
  const s = realSession();
  await dis(s, "parameter.add", { name: "theta", expression: String(theta), min: 18, max: 68 });
  await dis(s, "parameter.add", { name: "stages", expression: String(stages), min: 1, max: 8, step: 1 });

  const stage = (await dis(s, "component.create", { name: "Stage" }))[0];
  const A = (await dis(s, "component.create", { name: "BarA", parent: stage }))[0];
  const B = (await dis(s, "component.create", { name: "BarB", parent: stage }))[0];
  for (const bar of [A, B]) {
    await dis(s, "component.connector", { component: bar, name: "bottom", origin: { x: 0, y: 0, z: 0 } });
    await dis(s, "component.connector", { component: bar, name: "top", origin: { x: L, y: 0, z: 0 } });
    await dis(s, "component.connector", { component: bar, name: "center", origin: { x: L / 2, y: 0, z: 0 } });
  }

  const pat = (await dis(s, "assembly.pattern", { source: stage, count: "stages", name: "Linkages" }))[0];
  // Seed (i=0): ground + drive bar A; cross bar B over A at their centres.
  await dis(s, "joint.template", { pattern: pat, kind: "revolute", base: { role: "root", origin: { x: 0, y: 0, z: 0 } }, moved: { role: "self", component: A, port: "bottom" }, axis: AXIS, value: "theta", appliesTo: "first" });
  await dis(s, "joint.template", { pattern: pat, kind: "revolute", base: { role: "self", component: A, port: "center" }, moved: { role: "self", component: B, port: "center" }, axis: AXIS, value: "180 - 2*theta", appliesTo: "first" });
  // Repeat (i>=1): each bar pins to the previous stage's opposite top end.
  await dis(s, "joint.template", { pattern: pat, kind: "revolute", base: { role: "prev", component: B, port: "top" }, moved: { role: "self", component: A, port: "bottom" }, axis: AXIS, value: "2*theta - 180", appliesTo: "rest" });
  await dis(s, "joint.template", { pattern: pat, kind: "revolute", base: { role: "prev", component: A, port: "top" }, moved: { role: "self", component: B, port: "bottom" }, axis: AXIS, value: "180 - 2*theta", appliesTo: "rest" });
  return s;
}

/** Highest world-Z of any bar's top connector — the structure's apex. */
function apex(s: CadSession): { hi: number; instances: number } {
  const scope = resolveParameters(s.doc.parameters).scope;
  const expanded = expandAssembly(s.doc, scope);
  const worlds = resolveComponentWorld(expanded, scope);
  let hi = -Infinity, instances = 0;
  for (const [id, c] of Object.entries(expanded.components)) {
    if (!id.includes("#")) continue; // instance components only
    instances++;
    const top = c.connectors?.top;
    if (!top) continue;
    const W = worlds.get(id);
    if (W) hi = Math.max(hi, applyPoint(W, top.origin).z);
  }
  return { hi, instances };
}

describe("parametric jointed assembly (scissor)", () => {
  it("expands a source stage into 2 components per instance", async () => {
    const s = await buildScissor(40, 3);
    expect(apex(s).instances).toBe(3 * 3); // Stage + BarA + BarB, ×3
  });

  it("the apex rises with the drive angle", async () => {
    const low = apex(await buildScissor(20, 3)).hi;
    const high = apex(await buildScissor(65, 3)).hi;
    expect(high).toBeGreaterThan(low + 100); // opens from flat to tall
  });

  it("the apex rises with the (parametric) stage count", async () => {
    const h3 = apex(await buildScissor(45, 3)).hi;
    const h6 = apex(await buildScissor(45, 6)).hi;
    // 6 stages is about twice as tall as 3 at the same angle.
    expect(h6).toBeGreaterThan(h3 * 1.8);
    expect(h6).toBeLessThan(h3 * 2.2);
  });

  it("changing only the stages parameter re-expands (no rebuild of the rule)", async () => {
    const s = await buildScissor(45, 3);
    const before = apex(s);
    await dis(s, "parameter.set", { name: "stages", expression: "5" });
    const after = apex(s);
    expect(before.instances).toBe(9);
    expect(after.instances).toBe(15); // 5 × (Stage+A+B)
    expect(after.hi).toBeGreaterThan(before.hi);
  });
});
