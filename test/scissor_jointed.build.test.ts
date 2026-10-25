// End-to-end: the parametric JOINTED scissor as geometry. One source stage
// (two bars with connectors) + a component pattern of `stages` + relational
// joint templates. The expander materializes the instances; the normal geometry
// pipeline builds and places each bar. Proves the copies are real solids, that
// the count is parametric, and serializes the compact rule as an example.
//   BUILD_SCISSOR=/abs/out npx vitest run test/scissor_jointed.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { serializeDocument } from "../src/core/persistence";
import { evaluateFeatures } from "../src/core/features";
import { expandAssembly, instanceSolids } from "../src/core/assembly";
import { placeComponentSketches } from "../src/core/recompute";
import { resolveParameters } from "../src/model/parameters";
import type { CadSession } from "../src/core/command/session";

const OUT = process.env.BUILD_SCISSOR || "";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

const L = 60, W = 6, T = 4;
const AXIS = { x: 0, y: -1, z: 0 };

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

/** A flat bar in the XZ plane from local (0,0) to (L,0), thickness T along Y.
 *  `side` layers the two bars of the X onto opposite Y so they never collide. */
async function bar(s: CadSession, stage: string, name: string, side: "A" | "B"): Promise<string> {
  const cmp = (await dis(s, "component.create", { name, parent: stage }))[0];
  const sid = (await dis(s, "sketch.create", { plane: "XZ", component: cmp }))[0];
  await dis(s, "sketch.addRectangle", { sketch: sid, corner: { x: -W / 2, y: -W / 2 }, opposite: { x: L + W / 2, y: W / 2 } });
  await dis(s, "feature.extrude", { sketch: sid, distance: String(T), ...(side === "B" ? { direction: "reverse" } : {}) });
  await dis(s, "component.connector", { component: cmp, name: "bottom", origin: { x: 0, y: 0, z: 0 } });
  await dis(s, "component.connector", { component: cmp, name: "top", origin: { x: L, y: 0, z: 0 } });
  await dis(s, "component.connector", { component: cmp, name: "center", origin: { x: L / 2, y: 0, z: 0 } });
  return cmp;
}

async function buildScissor(s: CadSession): Promise<void> {
  await dis(s, "parameter.add", { name: "theta", expression: "40", min: 18, max: 68 });
  await dis(s, "parameter.add", { name: "stages", expression: "3", min: 1, max: 8, step: 1 });
  const stage = (await dis(s, "component.create", { name: "Stage" }))[0];
  const A = await bar(s, stage, "BarA", "A");
  const B = await bar(s, stage, "BarB", "B");
  const pat = (await dis(s, "assembly.pattern", { source: stage, count: "stages", name: "Linkages" }))[0];
  await dis(s, "joint.template", { pattern: pat, kind: "revolute", base: { role: "root", origin: { x: 0, y: 0, z: 0 } }, moved: { role: "self", component: A, port: "bottom" }, axis: AXIS, value: "theta", appliesTo: "first" });
  await dis(s, "joint.template", { pattern: pat, kind: "revolute", base: { role: "self", component: A, port: "center" }, moved: { role: "self", component: B, port: "center" }, axis: AXIS, value: "180 - 2*theta", appliesTo: "first" });
  await dis(s, "joint.template", { pattern: pat, kind: "revolute", base: { role: "prev", component: B, port: "top" }, moved: { role: "self", component: A, port: "bottom" }, axis: AXIS, value: "2*theta - 180", appliesTo: "rest" });
  await dis(s, "joint.template", { pattern: pat, kind: "revolute", base: { role: "prev", component: A, port: "top" }, moved: { role: "self", component: B, port: "bottom" }, axis: AXIS, value: "180 - 2*theta", appliesTo: "rest" });
}

function build(s: CadSession): { bodies: number; topZ: number } {
  const scope = resolveParameters(s.doc.parameters).scope;
  const expanded = expandAssembly(s.doc, scope);
  placeComponentSketches(expanded, scope);
  const solids = Object.values(evaluateFeatures(expanded, scope)).filter((b) => b.mesh);
  let hi = -Infinity;
  for (const b of solids) for (let i = 2; i < b.mesh!.positions.length; i += 3) hi = Math.max(hi, b.mesh!.positions[i]);
  return { bodies: solids.length, topZ: hi };
}

describe("jointed parametric scissor (geometry)", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("builds 2 bars per stage and gets taller with the stages parameter", async () => {
    const s = realSession();
    await buildScissor(s);
    await s.recompute();

    // Serialize the CLEAN construction (no trailing parameter.set ops, which would
    // otherwise override the Customize sliders on load).
    if (OUT) writeFileSync(`${OUT}/scissor-jointed.chisel.json`, serializeDocument(s.doc));

    const r3 = build(s);
    expect(r3.bodies).toBe(6); // 3 stages × 2 bars, each a real solid
    expect(r3.topZ).toBeGreaterThan(110); // ~3 × L·sin(40°) + overhang

    await dis(s, "parameter.set", { name: "stages", expression: "6" });
    await s.recompute();
    const r6 = build(s);
    expect(r6.bodies).toBe(12);
    expect(r6.topZ).toBeGreaterThan(r3.topZ * 1.8);

    // And it still articulates: lower the drive angle, the apex drops.
    await dis(s, "parameter.set", { name: "stages", expression: "3" });
    await dis(s, "parameter.set", { name: "theta", expression: "22" });
    await s.recompute();
    expect(build(s).topZ).toBeLessThan(r3.topZ * 0.75);

    await dis(s, "parameter.set", { name: "theta", expression: "40" });
    console.log(`jointed scissor: 3 stages → ${r3.bodies} bodies, topZ ${r3.topZ.toFixed(0)}mm; 6 stages → ${r6.bodies} bodies, topZ ${r6.topZ.toFixed(0)}mm`);
  }, 120000);

  it("the fast mesh-instancing path matches the rebuild path", async () => {
    const s = realSession();
    await buildScissor(s);
    await s.recompute();
    const scope = resolveParameters(s.doc.parameters).scope;

    // Rebuild path: clone the subtree per instance and build each with OCC.
    const expanded = expandAssembly(s.doc, scope);
    placeComponentSketches(expanded, scope);
    const rebuilt = Object.values(evaluateFeatures(expanded, scope)).filter((b) => b.mesh);

    // Fast path: build the source once, transform its mesh per instance.
    placeComponentSketches(s.doc, scope);
    const source = evaluateFeatures(s.doc, scope);
    const fast = Object.values(instanceSolids(s.doc, scope, source)).filter((b) => b.mesh);

    expect(fast.length).toBe(rebuilt.length);
    const span = (bs: typeof fast) => {
      let lo = Infinity, hi = -Infinity;
      for (const b of bs) for (let i = 2; i < b.mesh!.positions.length; i += 3) { lo = Math.min(lo, b.mesh!.positions[i]); hi = Math.max(hi, b.mesh!.positions[i]); }
      return { lo, hi };
    };
    const a = span(rebuilt), c = span(fast);
    expect(Math.abs(a.hi - c.hi)).toBeLessThan(0.05); // same apex
    expect(Math.abs(a.lo - c.lo)).toBeLessThan(0.05); // same base
    // vertex totals match (same topology, transformed)
    const verts = (bs: typeof fast) => bs.reduce((n, b) => n + b.mesh!.positions.length, 0);
    expect(verts(fast)).toBe(verts(rebuilt));
  }, 120000);
});
