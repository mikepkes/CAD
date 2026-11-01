// A build reports its progress: rising, from the features through the meshing, below 1 while it works.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { InlineGeometryBackend } from "../src/core/geometry/backend";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

describe("build progress", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("reports a rising fraction as the features build and mesh", async () => {
    const s = realSession();
    for (let i = 0; i < 4; i++) {
      const sk = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
      await s.dispatch("sketch.addRectangle", { sketch: sk, corner: { x: i * 30, y: 0 }, opposite: { x: i * 30 + 20, y: 20 } });
      await s.dispatch("feature.extrude", { sketch: sk, distance: "10" });
    }
    const g = new InlineGeometryBackend();
    await g.init({ wasmBinary: wasm });
    const seen: number[] = [];
    const r = await g.evaluate(s.doc, (f) => seen.push(f));
    expect(Object.keys(r.solids)).toHaveLength(4);
    expect(seen.length).toBeGreaterThanOrEqual(8);       // each feature, then each body
    expect(seen[0]).toBe(0);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    expect(seen.at(-1)!).toBeLessThan(1);
    expect(seen.at(-1)!).toBeGreaterThan(0.8);
  }, 60000);
});
