import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { analyzeBodies } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import type { CadSession } from "../src/core/command/session";

// Surface-quality analysis: curvature from the B-rep (not the mesh), edge
// continuity G0/G1/G2, and curvature combs.

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
const analyze = (s: CadSession, combs = false) => analyzeBodies(s.doc, resolveParameters(s.doc.parameters).scope, { combs });

describe("surface analysis", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("a sphere has k1 = k2 = 1/r everywhere (convex positive)", async () => {
    const s = realSession();
    await s.dispatch("feature.primitive", { shape: "sphere", radius: 10 });
    const [a] = analyze(s);
    expect(a.curvature.length).toBe(a.vertices * 2);
    expect(a.stats.kMin).toBeCloseTo(0.1, 6);
    expect(a.stats.kMax).toBeCloseTo(0.1, 6);
    expect(a.stats.gaussMax).toBeCloseTo(0.01, 6);
  });

  it("a cylinder curves 1/r around and 0 along; its rims are creases", async () => {
    const s = realSession();
    await s.dispatch("feature.primitive", { shape: "cylinder", radius: 5, height: 20 });
    const [a] = analyze(s);
    expect(a.stats.kMax).toBeCloseTo(0.2, 6);
    expect(a.stats.meanMax).toBeCloseTo(0.1, 6);
    expect(a.stats.gaussMax).toBeCloseTo(0, 9);
    const rims = a.edges.filter((e) => e.name.includes("cylinder") && !e.name.includes("cylinder|") || /\+Z|-Z/.test(e.name));
    expect(rims.length).toBeGreaterThan(0);
    expect(rims.every((e) => e.continuity === "G0" && Math.abs(e.angleDeg - 90) < 1e-6)).toBe(true);
  });

  it("a fillet meets its faces tangentially (G1) but not curvature-continuously", async () => {
    const s = realSession();
    await s.dispatch("feature.primitive", { shape: "box", x: 20, y: 20, z: 20 });
    await s.dispatch("feature.fillet", { radius: "3", edges: { parallelTo: "Z" } });
    const [a] = analyze(s);
    const blendEdges = a.edges.filter((e) => e.name.includes("blend"));
    expect(blendEdges.length).toBeGreaterThan(0);
    const sides = blendEdges.filter((e) => e.continuity !== "G0");
    expect(sides.length).toBe(8);                                       // 4 blends × their 2 side faces
    expect(sides.every((e) => e.continuity === "G1")).toBe(true);
    expect(sides.every((e) => Math.abs(e.curvatureJump - 1 / 3) < 1e-3)).toBe(true); // 0 → 1/r across the seam
    expect(a.stats.kMax).toBeCloseTo(1 / 3, 6);
  });

  it("two faces of one sphere meet curvature-continuously (G2)", async () => {
    const s = realSession();
    const sk = (await s.dispatch("sketch.create", { plane: "XZ" })).createdIds[0];
    // a semicircle (r 10) drawn as two arcs plus the axis line, revolved: two spherical faces sharing a seam
    const c = await s.dispatch("sketch.addPoint", { sketch: sk, x: 0, y: 0 });
    const a1 = await s.dispatch("sketch.addArc", { sketch: sk, center: { ref: c.createdIds[0] }, start: { x: 0, y: -10 }, end: { x: 10, y: 0 } });
    const a2 = await s.dispatch("sketch.addArc", { sketch: sk, center: { ref: c.createdIds[0] }, start: { ref: a1.createdIds[3] }, end: { x: 0, y: 10 } }); // ids: [arc, center, start, end]
    await s.dispatch("sketch.addLine", { sketch: sk, start: { ref: a2.createdIds[3] }, end: { ref: a1.createdIds[2] } });
    await s.dispatch("feature.revolve", { sketch: sk, axis: { p1: { x: 0, y: 0 }, p2: { x: 0, y: 1 } } });
    const [a] = analyze(s);
    const seam = a.edges.filter((e) => /rev:.*\|.*rev:/.test(e.name) && e.angleDeg < 0.5);
    expect(seam.length).toBeGreaterThan(0);
    expect(seam.some((e) => e.continuity === "G2")).toBe(true);
  });

  it("draws curvature combs only along curved edges", async () => {
    const box = realSession();
    await box.dispatch("feature.primitive", { shape: "box", x: 10, y: 10, z: 10 });
    expect(analyze(box, true)[0].combs.length).toBe(0);
    const cyl = realSession();
    await cyl.dispatch("feature.primitive", { shape: "cylinder", radius: 5, height: 10 });
    const combs = analyze(cyl, true)[0].combs;
    expect(combs.length).toBeGreaterThan(0);
    expect(combs.length % 6).toBe(0);
  });
});
