import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { collideFeatures } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import { runMotionStudy, driveParams } from "../src/model/motionStudy";
import type { GeometryBackend } from "../src/core/geometry/backend";
import type { CadSession } from "../src/core/command/session";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

async function box(s: CadSession, x0: number, y0: number, x1: number, y1: number) {
  const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
  await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: x0, y: y0 }, opposite: { x: x1, y: y1 } });
  await s.dispatch("feature.extrude", { sketch: sid, distance: "10" }); // operation defaults to "new" → own body
}

describe("collideFeatures", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("reports the overlap volume of two interpenetrating bodies", async () => {
    const s = realSession();
    await box(s, -10, -10, 10, 10);
    await box(s, 0, 0, 20, 20); // overlaps the first in [0,10]×[0,10]×[0,10] = 1000 mm³
    const r = collideFeatures(s.doc, resolveParameters(s.doc.parameters).scope);
    expect(r.maxOverlap).toBeGreaterThan(900);
    expect(r.overlaps.length).toBe(1);
  });

  it("reports no overlap for disjoint bodies", async () => {
    const s = realSession();
    await box(s, -10, -10, 10, 10);
    await box(s, 20, 20, 40, 40); // clear of the first
    const r = collideFeatures(s.doc, resolveParameters(s.doc.parameters).scope);
    expect(r.maxOverlap).toBeLessThan(1);
    expect(r.overlaps.length).toBe(0);
  });
});

// Fake backend to test the sweep/pass-fail logic without the kernel.
function fakeBackend(collide: (overrides?: Record<string, string>) => { maxOverlap: number; overlaps: { a: string; b: string; volume: number }[]; buildError?: string }): GeometryBackend {
  return {
    init: async () => {}, ready: () => true, evaluate: async () => ({ solids: {}, facePlanes: {} }),
    edges: async () => [], exportBytes: async () => null, dispose: () => {},
    collide: async (_doc, overrides) => collide(overrides),
  };
}
const docWith = (joints: Record<string, { kind: string; valueExpr: string }>, paramNames: string[]) => ({
  joints, parameters: paramNames.map((name) => ({ id: name, name, expr: "0", value: 0 })),
} as any);

describe("runMotionStudy", () => {
  it("derives the driven joint parameters from revolute joints", () => {
    const doc = docWith({ j1: { kind: "revolute", valueExpr: "spin2" }, j2: { kind: "revolute", valueExpr: "spin3" }, j3: { kind: "rigid", valueExpr: "0" } }, ["spin2", "spin3"]);
    expect(driveParams(doc)).toEqual(["spin2", "spin3"]);
  });

  it("passes when nothing ever overlaps", async () => {
    const doc = docWith({ j: { kind: "revolute", valueExpr: "spin" } }, ["spin"]);
    const r = await runMotionStudy(fakeBackend(() => ({ maxOverlap: 0, overlaps: [] })), doc, { steps: 6 });
    expect(r?.status).toBe("pass");
  });

  it("fails at the colliding angle and names the parts", async () => {
    const doc = docWith({ j: { kind: "revolute", valueExpr: "spin" } }, ["spin"]);
    const r = await runMotionStudy(fakeBackend((o) => Number(o!.spin) === 180 ? { maxOverlap: 50, overlaps: [{ a: "Ring 2", b: "Ring 1", volume: 50 }] } : { maxOverlap: 0, overlaps: [] }), doc, { steps: 12 });
    expect(r?.status).toBe("fail");
    expect(r?.reason).toMatch(/Ring 2 hits Ring 1 at spin = 180/);
  });

  it("fails on a build error (crash)", async () => {
    const doc = docWith({ j: { kind: "revolute", valueExpr: "spin" } }, ["spin"]);
    const r = await runMotionStudy(fakeBackend(() => ({ maxOverlap: 0, overlaps: [], buildError: "non-finite result" })), doc, { steps: 4 });
    expect(r?.status).toBe("fail");
    expect(r?.reason).toMatch(/build error/);
  });

  it("stops when cancelled", async () => {
    const doc = docWith({ j: { kind: "revolute", valueExpr: "spin" } }, ["spin"]);
    const r = await runMotionStudy(fakeBackend(() => ({ maxOverlap: 0, overlaps: [] })), doc, { steps: 12, cancelled: () => true });
    expect(r).toBeNull();
  });
});
