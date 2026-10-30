import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import type { CadSession } from "../src/core/command/session";

// Assembly joints: a joint resolves the `moved` component's world frame (rigid /
// revolute / slider), which flows through its sketches' planes to its bodies —
// so jointing and editing the motion value moves the component's geometry.
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

function body(s: CadSession): SolidEval {
  const scope = resolveParameters(s.doc.parameters).scope;
  return Object.values(evaluateFeatures(s.doc, scope)).find((b) => b.mesh)!;
}
function range(b: SolidEval, axis: 0 | 1 | 2): { lo: number; hi: number } {
  const p = b.mesh!.positions;
  let lo = Infinity, hi = -Infinity;
  for (let i = axis; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
  return { lo, hi };
}

/** A component with a box drawn around a given local-x center, extruded on XY. */
async function componentWithBox(s: CadSession, cx: number) {
  const c = (await s.dispatch("component.create", {})).createdIds[0];
  const sid = (await s.dispatch("sketch.create", { plane: "XY", component: c })).createdIds[0];
  await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: cx - 10, y: -10 }, opposite: { x: cx + 10, y: 10 } });
  await s.dispatch("feature.extrude", { sketch: sid, distance: "10" });
  return c;
}

describe("assembly joints", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("a rigid joint seats the component's connector on the base connector", async () => {
    const s = realSession();
    const c = await componentWithBox(s, 0); // box around local origin
    await s.dispatch("joint.create", { moved: c, baseOrigin: { x: 50, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 } });
    const x = range(body(s), 0);
    expect(x.lo).toBeCloseTo(40, 1); // -10 + 50
    expect(x.hi).toBeCloseTo(60, 1);
  });

  it("a slider joint translates along its axis, and the value drives it", async () => {
    const s = realSession();
    const c = await componentWithBox(s, 0);
    const j = await s.dispatch("joint.create", { kind: "slider", moved: c, baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 }, value: "25" });
    expect(range(body(s), 2)).toMatchObject({ lo: expect.closeTo(25, 1), hi: expect.closeTo(35, 1) });
    await s.editOperation(j.opId!, { kind: "slider", moved: c, baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 }, value: "50" });
    expect(range(body(s), 2)).toMatchObject({ lo: expect.closeTo(50, 1), hi: expect.closeTo(60, 1) });
  });

  it("a revolute joint rotates the component about its axis", async () => {
    const s = realSession();
    const c = await componentWithBox(s, 30); // box centered at local x=30
    // 90° about +Z through the origin: (30,0) → (0,30), so x→[-10,10], y→[20,40].
    await s.dispatch("joint.create", { kind: "revolute", moved: c, baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 }, value: "90" });
    const b = body(s);
    expect(range(b, 0)).toMatchObject({ lo: expect.closeTo(-10, 1), hi: expect.closeTo(10, 1) });
    expect(range(b, 1)).toMatchObject({ lo: expect.closeTo(20, 1), hi: expect.closeTo(40, 1) });
  });

  it("drives a joint value by a parameter", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "lift", expression: "15" });
    const c = await componentWithBox(s, 0);
    await s.dispatch("joint.create", { kind: "slider", moved: c, baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 }, value: "lift" });
    expect(range(body(s), 2).lo).toBeCloseTo(15, 1);
    const op = s.timeline.find((o) => o.type === "parameter.add")!;
    await s.editOperation(op.opId, { name: "lift", expression: "40" });
    expect(range(body(s), 2).lo).toBeCloseTo(40, 1);
  });

  it("a chained joint inherits the base component's orientation", async () => {
    const s = realSession();
    // A: an empty frame rotated 90° about +Z.
    const a = (await s.dispatch("component.create", {})).createdIds[0];
    await s.dispatch("joint.create", { kind: "revolute", moved: a, baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 }, value: "90" });
    // B: a box (local x∈[20,40]) jointed onto A at a shared origin — it must pick
    // up A's rotation, so (30,0)→(0,30): x→[-10,10], y→[20,40].
    const b = await componentWithBox(s, 30);
    await s.dispatch("joint.create", { kind: "rigid", base: a, moved: b, baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 } });
    const bd = body(s);
    expect(range(bd, 0)).toMatchObject({ lo: expect.closeTo(-10, 1), hi: expect.closeTo(10, 1) });
    expect(range(bd, 1)).toMatchObject({ lo: expect.closeTo(20, 1), hi: expect.closeTo(40, 1) });
  });

  it("flags a joint to a missing component without breaking the build", async () => {
    const s = realSession();
    const c = await componentWithBox(s, 0);
    // dispatch validates at apply time, so a bad component is rejected.
    const r = await s.dispatch("joint.create", { moved: c, base: "nope", baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/base component/i);
    expect(body(s)).toBeTruthy(); // original body intact
  });
});
