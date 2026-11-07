// A job about one body built from its chain alone (readBodies' `only`, the pool's per-body routing in
// model/worker-backend.ts) gives the same answer as the whole model built: the chains are independent.
import { it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { exportFeatureBytes, bodyTopology } from "../src/core/features";
import { featureChains } from "../src/core/geometry/chains";
import { resolveParameters } from "../src/core/parameters";
const wasm = readFileSync("node_modules/replicad-opencascadejs/dist/replicad_single.wasm");
beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

it("a body exported from its chain alone matches the body exported from the whole model", async () => {
  const s = realSession();
  const box = async (x: number) => {
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: x - 5, y: -5 }, opposite: { x: x + 5, y: 5 } });
    return (await s.dispatch("feature.extrude", { sketch: sid, distance: "10" })).createdIds[0];
  };
  const a = await box(0), c = await box(30);
  const hole = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
  await s.dispatch("sketch.addCircle", { sketch: hole, center: { x: 30, y: 0 }, radius: 2 });
  await s.dispatch("feature.extrude", { sketch: hole, distance: "10", operation: "cut", body: c });
  const scope = resolveParameters(s.doc.parameters).scope;
  const chains = featureChains(s.doc, scope)!;
  expect(chains.length).toBe(2);
  const chainC = chains.find((ch) => ch.features.includes(c))!;
  expect(chainC.features.length).toBe(2);
  const whole = await exportFeatureBytes(s.doc, scope, c, "stl");
  const alone = await exportFeatureBytes(s.doc, scope, c, "stl", undefined, new Set(chainC.features));
  expect(alone).toEqual(whole);
  expect(whole!.length).toBeGreaterThan(84);
  // the topology of one body from its chain alone: the same faces
  const topoWhole = bodyTopology(s.doc, scope, { bodyId: c }, undefined);
  const topoAlone = bodyTopology(s.doc, scope, { bodyId: c }, undefined, new Set(chainC.features));
  expect(topoAlone.map((b) => b.faces.length)).toEqual(topoWhole.map((b) => b.faces.length));
  expect(topoAlone.length).toBe(1);
});
