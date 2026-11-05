// The draft feature (src/core/features.ts applyDraft, kernel draftFaces): walls tilted about a parting
// plane so the part draws from a two-plate mould — outer walls narrowing away from the plane with a
// positive angle, a hole's walls narrowing the other way with a negative one.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

/** Half-extent in X of the body's vertices at a height, outside (|x| > 4) or inside (|x| < 4) the hole. */
function extents(positions: Float32Array, z: number) {
  let outer = 0, hole = 0;
  for (let i = 0; i < positions.length; i += 3) {
    if (Math.abs(positions[i + 2] - z) > 1e-3) continue;
    const x = Math.abs(positions[i]);
    if (x > 4) outer = Math.max(outer, x); else hole = Math.max(hole, x);
  }
  return { outer: +outer.toFixed(3), hole: +hole.toFixed(3) };
}

describe("feature.draft", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("tilts outer walls inward and a slot's walls outward, each by its own sign", async () => {
    const s = realSession();
    const sk = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sk, corner: { x: -10, y: -10 }, opposite: { x: 10, y: 10 } });
    const ext = (await s.dispatch("feature.extrude", { sketch: sk, distance: "10" })).createdIds[0];
    const hole = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: hole, corner: { x: -3, y: -3 }, opposite: { x: 3, y: 3 } });
    await s.dispatch("feature.extrude", { sketch: hole, distance: "10", operation: "cut" });
    const outer = await s.dispatch("feature.draft", { angle: "3", faces: { inBox: { min: { x: -11, y: -11, z: -1 }, max: { x: 11, y: 11, z: 11 } } }, requireEffect: true });
    expect(outer.ok).toBe(true);
    // the first draft took every wall, the slot's included; the angle is the wall's final tilt, so the slot's are now set to −3°
    const inner = await s.dispatch("feature.draft", { angle: "-3", faces: { inBox: { min: { x: -4, y: -4, z: -1 }, max: { x: 4, y: 4, z: 11 } } }, requireEffect: true });
    expect(inner.ok).toBe(true);
    const scope = resolveParameters(s.doc.parameters).scope;
    const solids = evaluateFeatures(s.doc, scope);
    const body = solids[ext];
    expect(body.mesh).toBeTruthy();
    for (const id of [outer.createdIds[0], inner.createdIds[0]]) expect(solids[id].error).toBeUndefined();
    const bottom = extents(body.mesh!.positions, 0), top = extents(body.mesh!.positions, 10);
    const tilt = 10 * Math.tan((3 * Math.PI) / 180);
    expect(bottom.outer).toBe(10);
    expect(Math.abs(top.outer - (10 - tilt))).toBeLessThan(0.01);   // outer wall leans in: narrower at the top
    expect(bottom.hole).toBe(3);
    expect(Math.abs(top.hole - (3 - tilt))).toBeLessThan(0.01);     // the slot narrows at the top: the core pin's taper
  });

  it("refuses a zero or steep angle, and reports when no wall matched", async () => {
    const s = realSession();
    const sk = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sk, corner: { x: 0, y: 0 }, opposite: { x: 10, y: 10 } });
    await s.dispatch("feature.extrude", { sketch: sk, distance: "5" });
    expect((await s.dispatch("feature.draft", { angle: "0" })).ok).toBe(false);
    expect((await s.dispatch("feature.draft", { angle: "60" })).ok).toBe(false);
    const none = await s.dispatch("feature.draft", { angle: "2", faces: { inBox: { min: { x: 50, y: 50, z: 50 }, max: { x: 60, y: 60, z: 60 } } }, requireEffect: true });
    expect(none.ok).toBe(true);
    const solids = evaluateFeatures(s.doc, resolveParameters(s.doc.parameters).scope);
    expect(solids[none.createdIds[0]].error).toMatch(/changed nothing/);
  });
});

describe("feature.draft near curved faces", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("leaves a wall that meets a round rim alone (the kernel would never return), and says so", async () => {
    const s = realSession();
    const sk = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addCircle", { sketch: sk, center: { x: 0, y: 0 }, radius: 14 });
    await s.dispatch("feature.extrude", { sketch: sk, distance: "4" });
    const g = (await s.dispatch("sketch.create", { plane: "XY", offset: 4 })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: g, corner: { x: -2.25, y: -16 }, opposite: { x: 2.25, y: 16 } });
    await s.dispatch("feature.extrude", { sketch: g, distance: "2.25", operation: "cut", direction: "reverse" });
    const t0 = Date.now();
    const d = await s.dispatch("feature.draft", { angle: "1", offset: 4, faces: { inBox: { min: { x: -2.5, y: -16, z: 1.5 }, max: { x: 2.5, y: 16, z: 4.2 } } }, requireEffect: true });
    const solids = evaluateFeatures(s.doc, resolveParameters(s.doc.parameters).scope);
    expect(Date.now() - t0).toBeLessThan(20000);
    expect(solids[d.createdIds[0]].error).toMatch(/changed nothing/);
  });
});

describe("feature.draft on a moved component", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("selects its faces as modelled, so a posed lid drafts the same walls", async () => {
    const { InlineGeometryBackend } = await import("../src/core/geometry/backend");
    const s = realSession();
    await s.dispatch("parameter.add", { name: "turn", expression: "0", min: 0, max: 180 });
    const cmp = (await s.dispatch("component.create", { name: "lid" })).createdIds[0];
    const sk = (await s.dispatch("sketch.create", { plane: "XY", component: cmp })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sk, corner: { x: 10, y: -10 }, opposite: { x: 30, y: 10 } });
    const ext = (await s.dispatch("feature.extrude", { sketch: sk, distance: "4" })).createdIds[0];
    const hole = (await s.dispatch("sketch.create", { plane: "XY", component: cmp })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: hole, corner: { x: 17, y: -3 }, opposite: { x: 23, y: 3 } });
    await s.dispatch("feature.extrude", { sketch: hole, distance: "4", operation: "cut" });
    const d = (await s.dispatch("feature.draft", { angle: "-2", faces: { inBox: { min: { x: 16, y: -4, z: -1 }, max: { x: 24, y: 4, z: 5 } } }, requireEffect: true })).createdIds[0];
    const fil = (await s.dispatch("feature.fillet", { radius: "0.5", edges: { inPlane: { plane: "XY", offset: 4 }, parallelTo: "X" }, requireEffect: true })).createdIds[0];
    await s.dispatch("joint.create", { kind: "revolute", moved: cmp, baseOrigin: { x: 0, y: 0, z: 4 }, movedOrigin: { x: 0, y: 0, z: 4 }, axis: { x: 0, y: 1, z: 0 }, value: "-turn" });
    const backend = new InlineGeometryBackend();
    const rest = await backend.evaluate(s.doc);
    expect(rest.solids[d].error).toBeUndefined();
    const restVolume = rest.solids[ext].volume!;
    await s.dispatch("parameter.set", { name: "turn", expression: "135" });
    const posed = await backend.evaluate(s.doc);
    expect(posed.solids[d].error).toBeUndefined();         // the box is read as modelled, not in the world
    expect(posed.solids[fil].error).toBeUndefined();       // and so is a fillet's plane
    expect(Math.abs(posed.solids[ext].volume! - restVolume)).toBeLessThan(1e-3); // the same body, turned
    expect(posed.solids[ext].bounds!.max.z).toBeGreaterThan(10); // and it really is posed
  });

  it("replays from cache as the lid turns: a pose runs no kernel step again", async () => {
    const { InlineGeometryBackend } = await import("../src/core/geometry/backend");
    const s = realSession();
    await s.dispatch("parameter.add", { name: "turn", expression: "0", min: 0, max: 180 });
    const cmp = (await s.dispatch("component.create", { name: "lid" })).createdIds[0];
    const sk = (await s.dispatch("sketch.create", { plane: "XY", component: cmp })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sk, corner: { x: 10, y: -10 }, opposite: { x: 30, y: 10 } });
    await s.dispatch("feature.extrude", { sketch: sk, distance: "4" });
    const hole = (await s.dispatch("sketch.create", { plane: "XY", component: cmp })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: hole, corner: { x: 17, y: -3 }, opposite: { x: 23, y: 3 } });
    await s.dispatch("feature.extrude", { sketch: hole, distance: "4", operation: "cut" });
    await s.dispatch("feature.draft", { angle: "-2", faces: { inBox: { min: { x: 16, y: -4, z: -1 }, max: { x: 24, y: 4, z: 5 } } }, requireEffect: true });
    await s.dispatch("feature.fillet", { radius: "0.5", edges: { inPlane: { plane: "XY", offset: 4 }, parallelTo: "X" }, requireEffect: true });
    const boss = (await s.dispatch("sketch.create", { plane: "XY", offset: 4, component: cmp })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: boss, corner: { x: 12, y: -2 }, opposite: { x: 15, y: 2 } });
    await s.dispatch("feature.extrude", { sketch: boss, distance: "2", operation: "join" }); // a step after the blends: it must replay too
    await s.dispatch("joint.create", { kind: "revolute", moved: cmp, baseOrigin: { x: 0, y: 0, z: 4 }, movedOrigin: { x: 0, y: 0, z: 4 }, axis: { x: 0, y: 1, z: 0 }, value: "-turn" });
    const backend = new InlineGeometryBackend();
    const cache = (backend as unknown as { cache: { hits: number; misses: number } }).cache;
    await backend.evaluate(s.doc);
    await s.dispatch("parameter.set", { name: "turn", expression: "60" });
    await backend.evaluate(s.doc); // the first pose away from rest is keyed in the lid's own frame: built once
    const misses = cache.misses;
    for (const turn of [90, 135, 180, 45]) {
      await s.dispatch("parameter.set", { name: "turn", expression: String(turn) });
      const r = await backend.evaluate(s.doc);
      expect(Object.values(r.solids).find((x) => x.error)).toBeUndefined();
    }
    expect(cache.misses).toBe(misses); // every later pose replayed every step
  });
});
