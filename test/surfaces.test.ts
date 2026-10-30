import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, bodyTopology, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import type { CadSession } from "../src/core/command/session";

// Surface modelling: surface bodies from open (or closed) curves, patches,
// stitching into a solid, thickening, trimming and untrimming — checked
// against exact areas and volumes.

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
const PI = Math.PI;
const scopeOf = (s: CadSession) => resolveParameters(s.doc.parameters).scope;
const bodies = (s: CadSession): SolidEval[] => {
  const out = evaluateFeatures(s.doc, scopeOf(s));
  const errs = Object.values(out).filter((r) => r.error);
  if (errs.length) throw new Error(errs.map((r) => r.error).join("; "));
  return Object.values(out).filter((r) => r.mesh);
};
const sketch = async (s: CadSession, params: Record<string, unknown> = { plane: "XY" }) => (await s.dispatch("sketch.create", params)).createdIds[0];
const line = (s: CadSession, sk: string, a: [number, number], b: [number, number]) => s.dispatch("sketch.addLine", { sketch: sk, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] } });

/** A 100 × 40 strip: an open line on XY extruded 40 up — a wall at y = 0. */
async function strip(s: CadSession) {
  const sk = await sketch(s);
  const l = await line(s, sk, [0, 0], [100, 0]);
  const f = await s.dispatch("feature.surface", { mode: "extrude", sketch: sk, distance: 40 });
  expect(f.ok).toBe(true);
  return { sk, line: l.createdIds[0], id: f.createdIds[0] };
}

describe("surface modelling", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("extrudes an open curve into a surface (area, no volume), faces named by their curve", async () => {
    const s = realSession();
    const { id, line: ln } = await strip(s);
    const [b] = bodies(s);
    expect(b.surface).toBe(true);
    expect(b.area).toBeCloseTo(4000, 6);
    expect(Math.abs(b.volume ?? 0)).toBeLessThan(1e-9);
    expect(bodyTopology(s.doc, scopeOf(s))[0].faces.map((f) => f.name)).toEqual([`${id}:side:${ln}`]);
  });

  it("revolves an open line into a cylinder skin and patches a circle into a disc", async () => {
    const s = realSession();
    const sk = await sketch(s, { plane: "XZ" });
    await line(s, sk, [10, 0], [10, 30]);
    await s.dispatch("feature.surface", { mode: "revolve", sketch: sk, axis: { p1: { x: 0, y: 0 }, p2: { x: 0, y: 1 } } });
    const disc = await sketch(s);
    await s.dispatch("sketch.addCircle", { sketch: disc, center: { x: 0, y: 0 }, radius: 10 });
    await s.dispatch("feature.surface", { mode: "patch", sketch: disc });
    const [skin, cap] = bodies(s);
    expect(skin.area).toBeCloseTo(2 * PI * 10 * 30, 6);
    expect(cap.area).toBeCloseTo(PI * 100, 6);
    expect(skin.surface && cap.surface).toBe(true);
  });

  it("stitches a skin and two caps into a closed solid", async () => {
    const s = realSession();
    const sk = await sketch(s, { plane: "XZ" });
    await line(s, sk, [10, 0], [10, 30]);
    const skin = (await s.dispatch("feature.surface", { mode: "revolve", sketch: sk, axis: { p1: { x: 0, y: 0 }, p2: { x: 0, y: 1 } } })).createdIds[0];
    const caps: string[] = [];
    for (const z of [0, 30]) {
      const c = await sketch(s, { plane: "XY", offset: z });
      await s.dispatch("sketch.addCircle", { sketch: c, center: { x: 0, y: 0 }, radius: 10 });
      caps.push((await s.dispatch("feature.surface", { mode: "patch", sketch: c })).createdIds[0]);
    }
    await s.dispatch("feature.stitch", { bodies: [skin, ...caps], solid: true });
    const bs = bodies(s);
    expect(bs.length).toBe(1);
    expect(bs[0].surface).toBeUndefined();
    expect(bs[0].volume).toBeCloseTo(PI * 100 * 30, 4);
  });

  it("reports a gap instead of a bogus solid", async () => {
    const s = realSession();
    const sk = await sketch(s, { plane: "XZ" });
    await line(s, sk, [10, 0], [10, 30]);
    const skin = (await s.dispatch("feature.surface", { mode: "revolve", sketch: sk, axis: { p1: { x: 0, y: 0 }, p2: { x: 0, y: 1 } } })).createdIds[0];
    const c = await sketch(s);
    await s.dispatch("sketch.addCircle", { sketch: c, center: { x: 0, y: 0 }, radius: 10 });
    const cap = (await s.dispatch("feature.surface", { mode: "patch", sketch: c })).createdIds[0];
    await s.dispatch("feature.stitch", { bodies: [skin, cap], solid: true }); // the top is open
    expect(() => bodies(s)).toThrow(/enclose a volume|gap|shell/);
  });

  it("thickens a surface into a solid, on one side or straddling it", async () => {
    for (const side of ["out", "both"] as const) {
      const s = realSession();
      await strip(s);
      await s.dispatch("feature.thicken", { thickness: 2, side });
      const [b] = bodies(s);
      expect(b.surface).toBeUndefined();
      expect(b.volume).toBeCloseTo(100 * 40 * 2, 4);
      const y = [b.bounds!.min.y, b.bounds!.max.y];
      if (side === "both") expect(y.map((v) => Math.round(v * 1000) / 1000)).toEqual([-1, 1]);
      else expect(Math.abs(y[1] - y[0])).toBeCloseTo(2, 6);
    }
  });

  it("trims a window out of a surface, and untrim fills it again", async () => {
    const s = realSession();
    await strip(s);
    const w = await sketch(s, { plane: "XZ" });
    await s.dispatch("sketch.addCircle", { sketch: w, center: { x: 50, y: 20 }, radius: 10 });
    await s.dispatch("feature.trim", { sketch: w, keep: "outside" });
    expect(bodies(s)[0].area).toBeCloseTo(4000 - PI * 100, 4);
    await s.dispatch("feature.untrim", {});
    expect(bodies(s)[0].area).toBeCloseTo(4000, 4);
  });

  it("lofts between two open sections", async () => {
    const s = realSession();
    const a = await sketch(s);
    await line(s, a, [0, 0], [60, 0]);
    const b = await sketch(s, { plane: "XY", offset: 30 });
    await line(s, b, [0, 0], [60, 0]);
    await s.dispatch("feature.surface", { mode: "loft", sketches: [a, b], ruled: true });
    expect(bodies(s)[0].area).toBeCloseTo(60 * 30, 6);
  });
});
