import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/model/parameters";
import type { CadSession } from "../src/core/command/session";

// Datum/reference planes: a parametric coordinate frame offset from a base
// plane. Proves the frame primitive end-to-end — resolved frame, a sketch that
// solves on it, a solid that lands at the offset, and offset-edit propagation.
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

function bodies(s: CadSession): SolidEval[] {
  const scope = resolveParameters(s.doc.parameters).scope;
  return Object.values(evaluateFeatures(s.doc, scope)).filter((b) => b.mesh);
}
function zRange(b: SolidEval): { lo: number; hi: number } {
  const p = b.mesh!.positions;
  let lo = Infinity, hi = -Infinity;
  for (let i = 2; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
  return { lo, hi };
}

describe("datum planes", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("resolves an offset plane to a frame offset along the base normal", async () => {
    const s = realSession();
    const pl = (await s.dispatch("plane.create", { base: "XY", offset: "20" })).createdIds[0];
    const dp = s.doc.planes[pl];
    expect(dp.error).toBeUndefined();
    expect(dp.plane).toBeTruthy();
    expect(dp.plane!.origin.z).toBeCloseTo(20, 6);
    expect(dp.plane!.normal.z).toBeCloseTo(1, 6);
    expect(dp.offsetValue).toBeCloseTo(20, 6);
  });

  it("solves a sketch that lives on a datum plane and copies the frame onto it", async () => {
    const s = realSession();
    const pl = (await s.dispatch("plane.create", { base: "XY", offset: "15" })).createdIds[0];
    const sid = (await s.dispatch("sketch.create", { datum: pl })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: -10, y: -10 }, opposite: { x: 10, y: 10 } });
    const sk = s.doc.sketches[sid];
    expect(sk.planeId).toBe("datum");
    expect(sk.datumId).toBe(pl);
    expect(sk.plane?.origin.z).toBeCloseTo(15, 6);
    expect(sk.status.converged).toBe(true);
  });

  it("lands an extruded solid at the datum's offset", async () => {
    const s = realSession();
    const pl = (await s.dispatch("plane.create", { base: "XY", offset: "20" })).createdIds[0];
    const sid = (await s.dispatch("sketch.create", { datum: pl })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: -20, y: -20 }, opposite: { x: 20, y: 20 } });
    await s.dispatch("feature.extrude", { sketch: sid, distance: "10" });
    const { lo, hi } = zRange(bodies(s)[0]);
    expect(lo).toBeCloseTo(20, 1);
    expect(hi).toBeCloseTo(30, 1);
  });

  it("propagates an offset edit through the datum to move the solid", async () => {
    const s = realSession();
    const planeOp = await s.dispatch("plane.create", { base: "XY", offset: "20" });
    const pl = planeOp.createdIds[0];
    const sid = (await s.dispatch("sketch.create", { datum: pl })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: -20, y: -20 }, opposite: { x: 20, y: 20 } });
    await s.dispatch("feature.extrude", { sketch: sid, distance: "10" });
    expect(zRange(bodies(s)[0]).lo).toBeCloseTo(20, 1);

    await s.editOperation(planeOp.opId!, { base: "XY", offset: "50" });
    const moved = zRange(bodies(s)[0]);
    expect(moved.lo).toBeCloseTo(50, 1);
    expect(moved.hi).toBeCloseTo(60, 1);
  });

  it("drives a datum offset by a parameter expression", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "gap", expression: "12" });
    const pl = (await s.dispatch("plane.create", { base: "XY", offset: "gap*2" })).createdIds[0];
    expect(s.doc.planes[pl].plane!.origin.z).toBeCloseTo(24, 6);
    const gapOp = s.timeline.find((o) => o.type === "parameter.add")!;
    await s.editOperation(gapOp.opId, { name: "gap", expression: "30" });
    expect(s.doc.planes[pl].plane!.origin.z).toBeCloseTo(60, 6);
  });

  it("chains a datum on a datum", async () => {
    const s = realSession();
    const a = (await s.dispatch("plane.create", { base: "XY", offset: "10" })).createdIds[0];
    const b = (await s.dispatch("plane.create", { base: a, offset: "5" })).createdIds[0];
    expect(s.doc.planes[b].error).toBeUndefined();
    expect(s.doc.planes[b].plane!.origin.z).toBeCloseTo(15, 6);
  });
});
