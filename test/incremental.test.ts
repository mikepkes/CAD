import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, GeometryCache, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/model/parameters";
import type { CadSession } from "../src/core/command/session";

// Incremental evaluation: a content-keyed body cache so an edit only re-meshes
// the bodies whose inputs changed (the stacked-disc / many-independent-body
// case, e.g. the teapot), while the rest are served from cache.
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

const zExtent = (b: SolidEval) => { const p = b.mesh!.positions; let lo = Infinity, hi = -Infinity; for (let i = 2; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); } return hi - lo; };

describe("incremental evaluation", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  /** Four independent boxes at different x, each extruded 20. */
  async function fourBoxes(): Promise<{ s: CadSession; boxes: { opId: string; sid: string }[] }> {
    const s = realSession();
    const boxes: { opId: string; sid: string }[] = [];
    for (const x of [0, 50, 100, 150]) {
      const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
      await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: x - 10, y: -10 }, opposite: { x: x + 10, y: 10 } });
      const f = await s.dispatch("feature.extrude", { sketch: sid, distance: "20" });
      boxes.push({ opId: f.opId!, sid });
    }
    return { s, boxes };
  }
  const scopeOf = (s: CadSession) => resolveParameters(s.doc.parameters).scope;

  it("caches all bodies; a no-op re-eval is all hits", async () => {
    const { s } = await fourBoxes();
    const cache = new GeometryCache();
    evaluateFeatures(s.doc, scopeOf(s), cache);
    expect(cache.misses).toBe(4);
    expect(cache.hits).toBe(0);
    expect(cache.size).toBe(4);

    const [h0, m0] = [cache.hits, cache.misses];
    const again = evaluateFeatures(s.doc, scopeOf(s), cache);
    expect(cache.misses - m0).toBe(0); // nothing rebuilt
    expect(cache.hits - h0).toBe(4);   // all served from cache
    expect(Object.values(again).filter((b) => b.mesh).length).toBe(4);
  });

  it("an edit rebuilds only the changed body", async () => {
    const { s, boxes } = await fourBoxes();
    const cache = new GeometryCache();
    evaluateFeatures(s.doc, scopeOf(s), cache);

    const [h0, m0] = [cache.hits, cache.misses];
    await s.editOperation(boxes[1].opId, { sketch: boxes[1].sid, distance: "40" });
    const out = evaluateFeatures(s.doc, scopeOf(s), cache);
    expect(cache.misses - m0).toBe(1); // only box #1 rebuilt
    expect(cache.hits - h0).toBe(3);   // the other three reused
    expect(cache.size).toBe(4);        // stale signature pruned

    // The rebuilt body reflects the new height; the others are unchanged.
    const bodies = Object.values(out).filter((b) => b.mesh);
    expect(bodies.map((b) => Math.round(zExtent(b))).sort((a, b) => a - b)).toEqual([20, 20, 20, 40]);
  });

  it("the cached result matches a full (uncached) evaluation", async () => {
    const { s } = await fourBoxes();
    const cached = evaluateFeatures(s.doc, scopeOf(s), new GeometryCache());
    const full = evaluateFeatures(s.doc, scopeOf(s)); // no cache → evaluateFull
    expect(Object.keys(cached).sort()).toEqual(Object.keys(full).sort());
    for (const id of Object.keys(full)) {
      expect(cached[id].mesh?.triangleCount).toBe(full[id].mesh?.triangleCount);
    }
  });

  it("falls back to full eval (no cache path) when a mirror is present", async () => {
    const { s } = await fourBoxes();
    await s.dispatch("feature.mirror", { plane: "YZ" });
    const cache = new GeometryCache();
    evaluateFeatures(s.doc, scopeOf(s), cache);
    expect(cache.size).toBe(0);   // cache untouched — mirror forces the full path
    expect(cache.misses).toBe(0);
  });
});
