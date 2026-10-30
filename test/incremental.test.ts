import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, GeometryCache, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
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

  it("modifiers are incremental too: a no-op re-eval of a mirror runs nothing", async () => {
    const { s } = await fourBoxes();
    await s.dispatch("feature.mirror", { plane: "YZ" });
    const cache = new GeometryCache();
    const first = evaluateFeatures(s.doc, scopeOf(s), cache);
    expect(cache.misses).toBe(5); // four boxes + the mirror
    const [h0, m0] = [cache.hits, cache.misses];
    const again = evaluateFeatures(s.doc, scopeOf(s), cache);
    expect(cache.misses - m0).toBe(0);
    expect(cache.hits - h0).toBe(5);
    const vol = (r: Record<string, SolidEval>) => Object.values(r).filter((b) => b.mesh).map((b) => Math.round(b.volume!)).sort();
    expect(vol(again)).toEqual(vol(first));
  });

  it("an edit re-runs only that body's chain: the other body's fillet is reused", async () => {
    const s = realSession();
    const a = await s.dispatch("feature.primitive", { shape: "box", x: 20, y: 20, z: 20 });
    await s.dispatch("feature.fillet", { radius: "2" });
    const b = await s.dispatch("feature.primitive", { shape: "box", x: 10, y: 10, z: 10, at: { x: 50, y: 0, z: 0 } });
    await s.dispatch("feature.hole", { at: [{ x: 50, y: 0, z: 5 }], diameter: "4", throughAll: true });
    const cache = new GeometryCache();
    evaluateFeatures(s.doc, scopeOf(s), cache);
    const [h0, m0] = [cache.hits, cache.misses];
    await s.editOperation(b.opId!, { shape: "box", x: 12, y: 12, z: 10, at: { x: 50, y: 0, z: 0 } });
    const out = evaluateFeatures(s.doc, scopeOf(s), cache);
    expect(cache.misses - m0).toBe(2); // the edited box and the hole drilled into it
    expect(cache.hits - h0).toBe(2);   // the first box and its fillet
    const full = evaluateFeatures(s.doc, scopeOf(s)); // uncached reference
    for (const id of [a.createdIds[0], b.createdIds[0]]) {
      expect(out[id].volume).toBeCloseTo(full[id].volume!, 6);
      expect(out[id].area).toBeCloseTo(full[id].area!, 6);
      expect(out[id].mesh!.faceNames).toEqual(full[id].mesh!.faceNames);
    }
    expect(out[b.createdIds[0]].volume).toBeCloseTo(12 * 12 * 10 - Math.PI * 4 * 10, 6);
  });

  it("editing an early feature re-runs everything downstream of it", async () => {
    const s = realSession();
    const a = await s.dispatch("feature.primitive", { shape: "box", x: 20, y: 20, z: 20 });
    await s.dispatch("feature.hole", { at: [{ x: 0, y: 0, z: 10 }], diameter: "6", throughAll: true });
    await s.dispatch("feature.chamfer", { distance: "1", edges: { parallelTo: "Z", curveType: "line" } });
    const cache = new GeometryCache();
    evaluateFeatures(s.doc, scopeOf(s), cache);
    const m0 = cache.misses;
    await s.editOperation(a.opId!, { shape: "box", x: 30, y: 20, z: 20 });
    const out = evaluateFeatures(s.doc, scopeOf(s), cache);
    expect(cache.misses - m0).toBe(3);
    expect(out[a.createdIds[0]].volume).toBeCloseTo(30 * 20 * 20 - Math.PI * 9 * 20 - 4 * 0.5 * 20, 6);
  });
});
