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

  // A joint drive moves a component; the bodies drawn in it are the same bodies
  // somewhere else, so nothing is rebuilt: the recorded shapes are moved.
  describe("a moved component replays its bodies in the new pose", () => {
    /** A link on a revolute joint driven by `theta`: a plate (new), a boss joined
     *  to it from a second sketch, a bore cut through-all, and a hole at a world
     *  point (which must NOT follow the link). */
    async function link() {
      const s = realSession();
      await s.dispatch("parameter.add", { name: "theta", expression: "0" });
      const c = (await s.dispatch("component.create", { name: "Link" })).createdIds[0];
      await s.dispatch("joint.create", { kind: "revolute", moved: c, baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 }, value: "theta" });
      const plate = (await s.dispatch("sketch.create", { plane: "XY", component: c })).createdIds[0];
      await s.dispatch("sketch.addRectangle", { sketch: plate, corner: { x: 0, y: -8 }, opposite: { x: 60, y: 8 } });
      const body = (await s.dispatch("feature.extrude", { sketch: plate, distance: "6" })).createdIds[0];
      const boss = (await s.dispatch("sketch.create", { plane: "XY", component: c })).createdIds[0];
      await s.dispatch("sketch.addCircle", { sketch: boss, center: { x: 50, y: 0 }, radius: 7 });
      await s.dispatch("feature.extrude", { sketch: boss, distance: "12", operation: "join" });
      const bore = (await s.dispatch("sketch.create", { plane: "XY", component: c })).createdIds[0];
      await s.dispatch("sketch.addCircle", { sketch: bore, center: { x: 50, y: 0 }, radius: 3 });
      await s.dispatch("feature.extrude", { sketch: bore, distance: "1", operation: "cut", extent: "throughAll", symmetric: true });
      await s.dispatch("feature.hole", { at: [{ x: 10, y: 0, z: 6 }], diameter: "4", throughAll: true });
      return { s, body };
    }
    const turn = async (s: CadSession, deg: number) => { await s.dispatch("parameter.set", { name: "theta", expression: String(deg) }); };
    const near = (a: ArrayLike<number>, b: ArrayLike<number>, tol: number) => { expect(a.length).toBe(b.length); for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > tol) throw new Error(`[${i}] ${a[i]} vs ${b[i]}`); };

    it("rebuilds nothing but the world-anchored hole, and matches a cold build", async () => {
      const { s, body } = await link();
      const cache = new GeometryCache();
      evaluateFeatures(s.doc, scopeOf(s), cache);
      for (const deg of [35, -120, 35]) {
        await turn(s, deg);
        const [h0, m0] = [cache.hits, cache.misses];
        const out = evaluateFeatures(s.doc, scopeOf(s), cache);
        expect(cache.misses - m0, `theta ${deg}: only the hole re-runs`).toBe(1);
        expect(cache.hits - h0).toBe(3);
        const cold = evaluateFeatures(s.doc, scopeOf(s));
        const a = out[body], b = cold[body];
        expect(a.error).toBeUndefined();
        expect(a.volume).toBeCloseTo(b.volume!, 6);
        expect(a.area).toBeCloseTo(b.area!, 6);
        near([a.centroid!.x, a.centroid!.y, a.centroid!.z], [b.centroid!.x, b.centroid!.y, b.centroid!.z], 1e-6);
        near([a.bounds!.min.x, a.bounds!.min.y, a.bounds!.min.z, a.bounds!.max.x, a.bounds!.max.y, a.bounds!.max.z], [b.bounds!.min.x, b.bounds!.min.y, b.bounds!.min.z, b.bounds!.max.x, b.bounds!.max.y, b.bounds!.max.z], 1e-6);
        expect(a.mesh!.faceNames).toEqual(b.mesh!.faceNames);
        near(a.mesh!.positions, b.mesh!.positions, 1e-4);
      }
    });

    it("a mesh measured in one pose is moved to the next, not re-meshed", async () => {
      const { s } = await link();
      const cache = new GeometryCache();
      evaluateFeatures(s.doc, scopeOf(s), cache);
      await turn(s, 90);
      const size0 = cache.size;
      const out = evaluateFeatures(s.doc, scopeOf(s), cache);
      expect(cache.size).toBe(size0); // the hole step re-ran, so its body was re-measured; nothing else was
      const b = Object.values(out).find((r) => r.mesh)!;
      expect(b.bounds!.min.x).toBeCloseTo(-8, 3); // the link now lies along +Y
      expect(b.bounds!.max.y).toBeCloseTo(60, 3);
    });
  });
});
