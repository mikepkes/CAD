import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/model/parameters";
import type { CadSession } from "../src/core/command/session";

// Sub-components: assembly-tree nodes with their own placement frame. A sketch
// scoped to a component builds its body in the component's world frame, and the
// frame composes down the parent chain — the groundwork for instances + joints.
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

function bodies(s: CadSession): SolidEval[] {
  const scope = resolveParameters(s.doc.parameters).scope;
  return Object.values(evaluateFeatures(s.doc, scope)).filter((b) => b.mesh);
}
function axisRange(b: SolidEval, axis: 0 | 1 | 2): { lo: number; hi: number } {
  const p = b.mesh!.positions;
  let lo = Infinity, hi = -Infinity;
  for (let i = axis; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
  return { lo, hi };
}
/** A 20x20 box centered on its sketch origin, extruded 10, in component `comp`. */
async function boxIn(s: CadSession, comp: string | undefined) {
  const sid = (await s.dispatch("sketch.create", comp ? { plane: "XY", component: comp } : { plane: "XY" })).createdIds[0];
  await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: -10, y: -10 }, opposite: { x: 10, y: 10 } });
  await s.dispatch("feature.extrude", { sketch: sid, distance: "10" });
  return sid;
}

describe("sub-components", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("builds a body in its component's world frame", async () => {
    const s = realSession();
    const c = (await s.dispatch("component.create", { position: { x: 50, y: 0, z: 0 } })).createdIds[0];
    await boxIn(s, c);
    const x = axisRange(bodies(s)[0], 0);
    expect(x.lo).toBeCloseTo(40, 1); // -10 + 50
    expect(x.hi).toBeCloseTo(60, 1); //  10 + 50
  });

  it("composes placement down the parent chain", async () => {
    const s = realSession();
    const a = (await s.dispatch("component.create", { position: { x: 50, y: 0, z: 0 } })).createdIds[0];
    const b = (await s.dispatch("component.create", { parent: a, position: { x: 0, y: 30, z: 0 } })).createdIds[0];
    await boxIn(s, b);
    const body = bodies(s)[0];
    expect(axisRange(body, 0)).toMatchObject({ lo: expect.closeTo(40, 1), hi: expect.closeTo(60, 1) });
    expect(axisRange(body, 1)).toMatchObject({ lo: expect.closeTo(20, 1), hi: expect.closeTo(40, 1) }); // -10+30 .. 10+30
  });

  it("scopes the sketch to its component, leaving root untouched", async () => {
    const s = realSession();
    const c = (await s.dispatch("component.create", {})).createdIds[0];
    const sid = await boxIn(s, c);
    expect(s.doc.components[c].sketches).toContain(sid);
    expect(s.doc.components[s.doc.rootComponentId].sketches).not.toContain(sid);
    expect(s.doc.sketches[sid].componentId).toBe(c);
  });

  it("propagates a component placement edit through to the body", async () => {
    const s = realSession();
    const op = await s.dispatch("component.create", { position: { x: 50, y: 0, z: 0 } });
    const c = op.createdIds[0];
    await boxIn(s, c);
    expect(axisRange(bodies(s)[0], 0).lo).toBeCloseTo(40, 1);

    await s.editOperation(op.opId!, { position: { x: 100, y: 0, z: 0 } });
    const x = axisRange(bodies(s)[0], 0);
    expect(x.lo).toBeCloseTo(90, 1);  // -10 + 100
    expect(x.hi).toBeCloseTo(110, 1);
  });

  it("keeps a root-scoped body at the origin frame", async () => {
    const s = realSession();
    await boxIn(s, undefined);
    expect(axisRange(bodies(s)[0], 0)).toMatchObject({ lo: expect.closeTo(-10, 1), hi: expect.closeTo(10, 1) });
  });
});
