import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import type { CadSession } from "../src/core/command/session";

// feature.mirror: the first solid transform. Reflect the running bodies across
// a plane and fuse each reflection into its source, giving a symmetric result.
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

/** An axis-aligned box offset entirely into +X (so a YZ mirror is non-trivial). */
async function offsetBox(s: CadSession, x0: number, x1: number, dist: string) {
  const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
  await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: x0, y: -15 }, opposite: { x: x1, y: 15 } });
  const f = await s.dispatch("feature.extrude", { sketch: sid, distance: dist });
  return { sid, extrudeOpId: f.opId! };
}

describe("feature.mirror", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("reflects an offset body across YZ into a symmetric pair", async () => {
    const s = realSession();
    await offsetBox(s, 10, 30, "20");
    expect(axisRange(bodies(s)[0], 0)).toMatchObject({ lo: expect.closeTo(10, 1), hi: expect.closeTo(30, 1) });

    await s.dispatch("feature.mirror", { plane: "YZ" });
    const b = bodies(s);
    expect(b.length).toBe(1); // original + reflection fused into one body
    const x = axisRange(b[0], 0);
    expect(x.lo).toBeCloseTo(-30, 1);
    expect(x.hi).toBeCloseTo(30, 1); // symmetric about x = 0
  });

  it("keeps the mirror parametric: editing the source re-mirrors", async () => {
    const s = realSession();
    const { extrudeOpId, sid } = await offsetBox(s, 10, 30, "20");
    await s.dispatch("feature.mirror", { plane: "YZ" });
    expect(axisRange(bodies(s)[0], 2).hi).toBeCloseTo(20, 1);

    // Taller extrude → the reflection must follow (z grows on both halves).
    await s.editOperation(extrudeOpId, { sketch: sid, distance: "45" });
    const b = bodies(s);
    expect(b.length).toBe(1);
    expect(axisRange(b[0], 2).hi).toBeCloseTo(45, 1);
    expect(axisRange(b[0], 0)).toMatchObject({ lo: expect.closeTo(-30, 1), hi: expect.closeTo(30, 1) });
  });

  it("mirrors across a datum plane", async () => {
    const s = realSession();
    // A box in +X, mirrored across a YZ-parallel datum offset to x = 40.
    await offsetBox(s, 10, 30, "20");
    const pl = (await s.dispatch("plane.create", { base: "YZ", offset: "40" })).createdIds[0];
    await s.dispatch("feature.mirror", { plane: pl });
    const x = axisRange(bodies(s)[0], 0);
    // reflection of [10,30] across x=40 is [50,70]; fused span [10,70].
    expect(x.lo).toBeCloseTo(10, 1);
    expect(x.hi).toBeCloseTo(70, 1);
  });

  it("errors cleanly on an unknown mirror plane without blocking the build", async () => {
    const s = realSession();
    await offsetBox(s, 10, 30, "20");
    // apply validates the plane exists → the op fails and is not committed.
    const r = await s.dispatch("feature.mirror", { plane: "nope" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/mirror plane/i);
    expect(bodies(s).length).toBe(1); // original body still there
  });
});
