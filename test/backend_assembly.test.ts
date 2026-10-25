import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { InlineGeometryBackend } from "../src/core/geometry/backend";
import type { CadSession } from "../src/core/command/session";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
const L = 60, W = 6, T = 4, AXIS = { x: 0, y: -1, z: 0 };

async function dis(s: CadSession, type: string, params: Record<string, unknown>) {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}
async function bar(s: CadSession, stage: string, name: string, side: "A" | "B") {
  const cmp = (await dis(s, "component.create", { name, parent: stage }))[0];
  const sid = (await dis(s, "sketch.create", { plane: "XZ", component: cmp }))[0];
  await dis(s, "sketch.addRectangle", { sketch: sid, corner: { x: -W / 2, y: -W / 2 }, opposite: { x: L + W / 2, y: W / 2 } });
  await dis(s, "feature.extrude", { sketch: sid, distance: String(T), ...(side === "B" ? { direction: "reverse" } : {}) });
  for (const [n, x] of [["bottom", 0], ["top", L], ["center", L / 2]] as [string, number][]) await dis(s, "component.connector", { component: cmp, name: n, origin: { x, y: 0, z: 0 } });
  return cmp;
}

describe("InlineGeometryBackend expands component patterns", () => {
  const backend = new InlineGeometryBackend();
  beforeAll(async () => { await backend.init({ wasmBinary: wasm }); }, 60000);

  it("evaluate() reflects stage count and drive angle through the backend wrapper", async () => {
    const s = realSession();
    await dis(s, "parameter.add", { name: "theta", expression: "40", min: 18, max: 68 });
    await dis(s, "parameter.add", { name: "stages", expression: "3", min: 1, max: 8, step: 1 });
    const stage = (await dis(s, "component.create", { name: "Stage" }))[0];
    const A = await bar(s, stage, "BarA", "A"), B = await bar(s, stage, "BarB", "B");
    const pat = (await dis(s, "assembly.pattern", { source: stage, count: "stages" }))[0];
    await dis(s, "joint.template", { pattern: pat, kind: "revolute", base: { role: "root", origin: { x: 0, y: 0, z: 0 } }, moved: { role: "self", component: A, port: "bottom" }, axis: AXIS, value: "theta", appliesTo: "first" });
    await dis(s, "joint.template", { pattern: pat, kind: "revolute", base: { role: "self", component: A, port: "center" }, moved: { role: "self", component: B, port: "center" }, axis: AXIS, value: "180 - 2*theta", appliesTo: "first" });
    await dis(s, "joint.template", { pattern: pat, kind: "revolute", base: { role: "prev", component: B, port: "top" }, moved: { role: "self", component: A, port: "bottom" }, axis: AXIS, value: "2*theta - 180", appliesTo: "rest" });
    await dis(s, "joint.template", { pattern: pat, kind: "revolute", base: { role: "prev", component: A, port: "top" }, moved: { role: "self", component: B, port: "bottom" }, axis: AXIS, value: "180 - 2*theta", appliesTo: "rest" });
    await s.recompute();

    const count = async () => Object.values((await backend.evaluate(s.doc)).solids).filter((x) => x.mesh).length;
    const topZ = async () => { let hi = -Infinity; for (const x of Object.values((await backend.evaluate(s.doc)).solids)) if (x.mesh) for (let i = 2; i < x.mesh.positions.length; i += 3) hi = Math.max(hi, x.mesh.positions[i]); return hi; };

    expect(await count()).toBe(6);
    const z40 = await topZ();

    await dis(s, "parameter.set", { name: "stages", expression: "5" });
    await s.recompute();
    expect(await count()).toBe(10);

    await dis(s, "parameter.set", { name: "stages", expression: "3" });
    await dis(s, "parameter.set", { name: "theta", expression: "22" });
    await s.recompute();
    expect(await count()).toBe(6);
    expect(await topZ()).toBeLessThan(z40 * 0.8); // the SAME backend sees the new angle
  }, 120000);
});
