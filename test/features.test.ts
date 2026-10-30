import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import type { CadSession } from "../src/core/command/session";

// The B-rep path: region extrude, boolean new/join/cut into bodies, and
// edit-propagation all the way through to the solid. Loads the real OCC kernel.
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

function bodies(s: CadSession): SolidEval[] {
  const scope = resolveParameters(s.doc.parameters).scope;
  return Object.values(evaluateFeatures(s.doc, scope)).filter((b) => b.mesh);
}
function extent(b: SolidEval, axis: 0 | 1 | 2): number {
  const p = b.mesh!.positions;
  let lo = Infinity, hi = -Infinity;
  for (let i = axis; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
  return hi - lo;
}
const zExtent = (b: SolidEval) => extent(b, 2);

async function box(s: CadSession, size: number, dist: string, extra: Record<string, unknown> = {}) {
  const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
  await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: -size / 2, y: -size / 2 }, opposite: { x: size / 2, y: size / 2 } });
  const f = await s.dispatch("feature.extrude", { sketch: sid, distance: dist, ...extra });
  return { sid, extrudeOpId: f.opId!, featureId: f.createdIds[0] };
}

describe("features / OCC kernel", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("extrudes a region into a single body", async () => {
    const s = realSession();
    await box(s, 40, "30");
    const b = bodies(s);
    expect(b.length).toBe(1);
    expect(zExtent(b[0])).toBeCloseTo(30, 1);
  });

  it("join fuses overlapping extrudes into one body; new keeps them separate", async () => {
    const joined = realSession();
    await box(joined, 40, "20");                               // new body
    await box(joined, 20, "40", { operation: "join" });        // overlaps + fuses
    expect(bodies(joined).length).toBe(1);

    const separate = realSession();
    await box(separate, 40, "20");
    await box(separate, 20, "40");                             // default "new"
    expect(bodies(separate).length).toBe(2);
  });

  it("cut subtracts from the running body", async () => {
    const s = realSession();
    await box(s, 40, "20");                                    // 40x40x20 block
    await box(s, 10, "40", { operation: "cut" });              // punch a 10x10 hole through
    const b = bodies(s);
    expect(b.length).toBe(1);
    // a through-hole adds interior wall triangles → more than a plain block's 12
    expect(b[0].mesh!.triangleCount).toBeGreaterThan(12);
  });

  it("propagates an extrude distance edit through to the solid", async () => {
    const s = realSession();
    const { sid, extrudeOpId } = await box(s, 40, "20");
    expect(zExtent(bodies(s)[0])).toBeCloseTo(20, 1);
    await s.editOperation(extrudeOpId, { sketch: sid, distance: "55" });
    expect(zExtent(bodies(s)[0])).toBeCloseTo(55, 1);
  });

  it("propagates an upstream sketch-size edit through to the solid", async () => {
    const s = realSession();
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("parameter.add", { name: "size", expression: "40" });
    const rect = await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 0, y: 0 }, opposite: { x: 40, y: 40 } });
    // drive the far corner by the parameter so editing it resizes the profile
    const corners = rect.createdIds; // 4 corner points
    await s.dispatch("sketch.addDimension", { sketch: sid, type: "distanceX", a: corners[0], b: corners[1], expression: "size" });
    await s.dispatch("feature.extrude", { sketch: sid, distance: "10" });
    const widthBefore = extent(bodies(s)[0], 0);
    expect(widthBefore).toBeCloseTo(40, 1);
    const sizeOp = s.timeline.find((o) => o.type === "parameter.add")!;
    await s.editOperation(sizeOp.opId, { name: "size", expression: "80" });
    const after = bodies(s)[0];
    expect(after.error).toBeUndefined();
    expect(extent(after, 0)).toBeCloseTo(80, 1); // profile widened → solid widened
  });
});
