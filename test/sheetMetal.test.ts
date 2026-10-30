import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import { flatPatternSvg, flatPatternDxf, bendAllowance } from "../src/core/sheet";
import type { CadSession } from "../src/core/command/session";

// Sheet metal and paper, checked against exact values: with K = 0.5 the
// neutral layer is the mid-plane, so folding keeps volume (flat area × t);
// flat lengths are Σ straights + Σ bend allowances; bounds come from radii.

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
const PI = Math.PI;
const BA = (deg: number, r: number, t: number, k = 0.5) => bendAllowance((deg * PI) / 180, r, { thickness: t, kFactor: k });

function rows(s: CadSession): Record<string, SolidEval> {
  return evaluateFeatures(s.doc, resolveParameters(s.doc.parameters).scope);
}
function body(s: CadSession, id: string): SolidEval {
  const out = rows(s);
  const errs = Object.values(out).filter((r) => r.error);
  if (errs.length) throw new Error(errs.map((r) => `${r.featureId}: ${r.error}`).join("; "));
  const b = out[id];
  if (!b?.mesh) throw new Error(`no body ${id}`);
  return b;
}
const sketch = async (s: CadSession, params: Record<string, unknown> = { plane: "XY" }) => (await s.dispatch("sketch.create", params)).createdIds[0];
/** A w × h rectangle at the origin: returns [sketch, bottom, right, top, left line ids]. */
async function rectSketch(s: CadSession, w: number, h: number, params?: Record<string, unknown>) {
  const sk = await sketch(s, params);
  const r = await s.dispatch("sketch.addRectangle", { sketch: sk, corner: { x: 0, y: 0 }, opposite: { x: w, y: h } });
  return [sk, ...r.createdIds.slice(4, 8)];
}
const constructionLine = async (s: CadSession, sk: string, a: [number, number], b: [number, number]) =>
  (await s.dispatch("sketch.addLine", { sketch: sk, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, construction: true })).createdIds[0];
const ok = async (s: CadSession, type: string, params: Record<string, unknown>) => {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds[0];
};

describe("sheet metal", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("folds a blank along a sketched line: volume kept, bend radius and allowance exact", async () => {
    const s = realSession();
    const [sk] = await rectSketch(s, 100, 50);
    const l = await constructionLine(s, sk, [60, 0], [60, 50]);
    const id = await ok(s, "feature.sheet", { sketch: sk, thickness: 2, radius: 3, folds: [{ line: l, angle: 90 }] });
    const b = body(s, id);
    expect(b.volume).toBeCloseTo(100 * 50 * 2, 4);
    const ba = BA(90, 3, 2);
    expect(b.bounds!.max.x).toBeCloseTo(60 - ba / 2 + 3 + 2, 5); // outside of the bend
    expect(b.bounds!.max.z).toBeCloseTo(3 + 2 + (100 - 60 - ba / 2), 5);
    expect(b.sheet!.angles[l]).toBeCloseTo(90, 9);
    expect(b.sheet!.flat.max.x - b.sheet!.flat.min.x).toBeCloseTo(100, 6);
  });

  it("an L bracket with K ≠ 0.5: flat length = Σ flanges + BA, volume from the exact bend", async () => {
    const s = realSession();
    const [sk, , right] = await rectSketch(s, 100, 50);
    const id = await ok(s, "feature.sheet", { sketch: sk, thickness: 2, radius: 3, kFactor: 0.3 });
    await ok(s, "feature.flange", { edge: right, length: 30 });
    const b = body(s, id);
    const ba = BA(90, 3, 2, 0.3);
    expect(b.sheet!.flat.max.x - b.sheet!.flat.min.x).toBeCloseTo(100 + ba + 30, 6);
    expect(b.sheet!.flat.folds[0].allowance).toBeCloseTo(ba, 9);
    const bend = (PI / 4) * ((3 + 2) ** 2 - 3 ** 2) * 50;
    expect(b.volume).toBeCloseTo((100 + 30) * 50 * 2 + bend, 3);
    expect(b.bounds!.max.x).toBeCloseTo(105, 5);
    expect(b.bounds!.max.z).toBeCloseTo(35, 5);
  });

  it("an open box: four edge flanges, flat = base + Σ (BA + flange) each way", async () => {
    const s = realSession();
    const [sk, ...edges] = await rectSketch(s, 100, 60);
    const id = await ok(s, "feature.sheet", { sketch: sk, thickness: 1, radius: 1 });
    for (const e of edges) await ok(s, "feature.flange", { edge: e, length: 20 });
    const b = body(s, id);
    const ba = BA(90, 1, 1);
    const fp = b.sheet!.flat;
    expect(fp.max.x - fp.min.x).toBeCloseTo(100 + 2 * (ba + 20), 6);
    expect(fp.max.y - fp.min.y).toBeCloseTo(60 + 2 * (ba + 20), 6);
    const flatArea = 100 * 60 + 2 * 100 * (ba + 20) + 2 * 60 * (ba + 20);
    expect(b.volume).toBeCloseTo(flatArea * 1, 3);
    expect([b.bounds!.min.x, b.bounds!.max.x, b.bounds!.max.z].map((v) => Math.round(v * 1e5) / 1e5)).toEqual([-2, 102, 22]);
  });

  it("set-back flanges meet at a corner: outsides flush with the blank, the overlap cut away", async () => {
    const s = realSession();
    const [sk, bottom, right] = await rectSketch(s, 100, 60);
    const id = await ok(s, "feature.sheet", { sketch: sk, thickness: 1, radius: 1 });
    await ok(s, "feature.flange", { edge: bottom, length: 20, position: "materialInside" });
    await ok(s, "feature.flange", { edge: right, length: 20, position: "materialInside" });
    const b = body(s, id);
    expect(b.bounds!.max.x).toBeCloseTo(100, 5);
    expect(b.bounds!.min.y).toBeCloseTo(0, 5);
    const uEnd = -2 + BA(90, 1, 1) + 20;
    // less the corner relief: the 2 × 2 overlap plus each flange's end inside the other's setback
    const flatArea = 100 * 60 + 100 * uEnd + 60 * uEnd - 2 * 2 - 2 * 2 * uEnd;
    expect(b.volume).toBeCloseTo(flatArea, 3);
  });

  it("a partial flange set back into the blank gets relief slots", async () => {
    const s = realSession();
    const [sk, bottom] = await rectSketch(s, 100, 60);
    const id = await ok(s, "feature.sheet", { sketch: sk, thickness: 1, radius: 1, reliefWidth: 1 });
    await ok(s, "feature.flange", { edge: bottom, length: 15, position: "materialInside", inset: [20, 30] });
    const b = body(s, id);
    const uEnd = -2 + BA(90, 1, 1) + 15;
    const relief = 2 * (1 * (2 + 1)); // two slots, 1 wide, (setback + width) deep
    expect(b.volume).toBeCloseTo(100 * 60 + 50 * uEnd - relief, 3);
    expect(b.bounds!.min.y).toBeCloseTo(0, 5);
  });

  it("a closed hem doubles the edge back over the sheet", async () => {
    const s = realSession();
    const [sk, bottom] = await rectSketch(s, 100, 50);
    const id = await ok(s, "feature.sheet", { sketch: sk, thickness: 1 });
    await ok(s, "feature.flange", { edge: bottom, length: 10, hem: true });
    const b = body(s, id);
    expect(b.volume).toBeCloseTo((100 * 50 + 100 * 10) * 1 + (PI / 2) * 100, 3); // + the half-round outside the crease
    expect(b.bounds!.max.z).toBeCloseTo(2, 6);
    expect(b.bounds!.min.y).toBeCloseTo(-1, 6);
  });

  it("a contour flange (U channel) unrolls to Σ straights + Σ BA", async () => {
    const s = realSession();
    const sk = await sketch(s);
    await s.dispatch("sketch.addPolyline", { sketch: sk, points: [{ x: 0, y: 30 }, { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 30 }], closed: false });
    const id = await ok(s, "feature.sheet", { sketch: sk, mode: "contour", thickness: 1, radius: 2, width: 40 });
    const b = body(s, id);
    const ba = BA(90, 2, 1);
    const straights = (30 - 2) + (50 - 4) + (30 - 2); // less the setbacks (the sketch is the inside: r)
    expect(b.sheet!.flat.max.x - b.sheet!.flat.min.x).toBeCloseTo(straights + 2 * ba, 6);
    expect(b.volume).toBeCloseTo((straights + 2 * ba) * 40 * 1, 3);
    const bb = b.bounds!;
    expect([bb.min.x, bb.max.x, bb.min.y, bb.max.y, bb.min.z, bb.max.z].map((v) => Math.round(v * 1e5) / 1e5 + 0)).toEqual([-1, 51, -1, 30, 0, 40]);
  });

  it("a jog steps the far side up and keeps it parallel", async () => {
    const s = realSession();
    const [sk] = await rectSketch(s, 100, 50);
    const id = await ok(s, "feature.sheet", { sketch: sk, thickness: 1, radius: 1, fixed: { x: 10, y: 25 } });
    const top = await sketch(s, { plane: "XY", offset: 1 });
    await s.dispatch("sketch.addLine", { sketch: top, start: { x: 50, y: 0 }, end: { x: 50, y: 50 } });
    await ok(s, "feature.fold", { sketch: top, jog: 5, flip: true });
    const b = body(s, id);
    expect(b.volume).toBeCloseTo(100 * 50, 3);
    expect(b.bounds!.min.z).toBeCloseTo(0, 5);
    expect(b.bounds!.max.z).toBeCloseTo(6, 5);
    expect(b.bounds!.min.x).toBeCloseTo(0, 5);
  });

  it("unfold, cut a hole across the bend while flat, refold: the hole wraps round the bend", async () => {
    const s = realSession();
    const [sk] = await rectSketch(s, 100, 50);
    const l = await constructionLine(s, sk, [60, 0], [60, 50]);
    const id = await ok(s, "feature.sheet", { sketch: sk, thickness: 2, radius: 3, folds: [{ line: l, angle: 90 }] });
    await ok(s, "feature.unfold", {});
    const hs = await sketch(s);
    await s.dispatch("sketch.addCircle", { sketch: hs, center: { x: 60, y: 25 }, radius: 5 });
    await ok(s, "feature.extrude", { sketch: hs, distance: "10", extent: "throughAll", symmetric: true, operation: "cut", body: id });
    expect(body(s, id).sheet!.unfolded).toBe(true);
    await ok(s, "feature.refold", {});
    const b = body(s, id);
    expect(b.sheet!.unfolded).toBe(false);
    expect(b.volume).toBeCloseTo((100 * 50 - PI * 25) * 2, 3);
    expect(b.sheet!.flat.outline.some((o) => o.kind === "circle" && Math.abs(o.r - 5) < 1e-6)).toBe(true);
  });

  it("writes the flat pattern as SVG and DXF with cut and bend layers", async () => {
    const s = realSession();
    const [sk, , right] = await rectSketch(s, 100, 50);
    await ok(s, "feature.sheet", { sketch: sk, thickness: 2, radius: 3 });
    const fl = await ok(s, "feature.flange", { edge: right, length: 30, angle: -90 });
    const b = Object.values(rows(s)).find((r) => r.sheet)!;
    const svg = flatPatternSvg(b.sheet!.flat), dxf = flatPatternDxf(b.sheet!.flat);
    expect(svg).toContain('class="mountain"');
    expect(svg).toContain(`${fl}: down 90.0°`);
    expect(dxf).toMatch(/LAYER\n2\nBEND_DOWN/);
    expect(dxf.match(/\nLINE\n8\nCUT/g)!.length).toBe(4);
    expect(dxf.match(/\nLINE\n8\nBEND_DOWN/g)!.length).toBe(1);
  });
});

describe("paper and origami", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  /** A 100 × 100 square centred on the origin, creases from the centre at these angles (degrees). */
  async function vertex(s: CadSession, dirs: number[]) {
    const sk = await sketch(s);
    await s.dispatch("sketch.addRectangle", { sketch: sk, corner: { x: -50, y: -50 }, opposite: { x: 50, y: 50 } });
    const ids: string[] = [];
    for (const d of dirs) {
      // to the square's edge along direction d
      const c = Math.cos((d * PI) / 180), sn = Math.sin((d * PI) / 180), k = 50 / Math.max(Math.abs(c), Math.abs(sn));
      ids.push(await constructionLine(s, sk, [0, 0], [c * k, sn * k]));
    }
    return { sk, ids };
  }

  it("zero-thickness paper is a surface: area kept, sharp crease", async () => {
    const s = realSession();
    const [sk] = await rectSketch(s, 100, 50);
    const l = await constructionLine(s, sk, [60, 0], [60, 50]);
    const id = await ok(s, "feature.sheet", { sketch: sk, thickness: 0, folds: [{ line: l, angle: 90 }] });
    const b = body(s, id);
    expect(b.surface).toBe(true);
    expect(b.area).toBeCloseTo(5000, 6);
    expect(b.bounds!.max.x).toBeCloseTo(60, 6);
    expect(b.bounds!.max.z).toBeCloseTo(40, 6);
  });

  it("solves a degree-4 vertex from one driven crease (rigid origami)", async () => {
    const s = realSession();
    // sector angles 60/80/120/100: flat-foldable (Kawasaki: 60 + 120 = 180); the
    // odd crease out (Maekawa: 3 valleys, 1 mountain) bounds the smallest sector
    const { sk, ids } = await vertex(s, [0, 60, 140, 260]);
    const id = await ok(s, "feature.sheet", {
      sketch: sk, thickness: 0, radius: 0, fixed: { x: 20, y: -20 },
      folds: [{ line: ids[0], angle: 40 }, { line: ids[1], direction: "mountain" }, { line: ids[2], direction: "valley" }, { line: ids[3], direction: "valley" }],
    });
    const out = rows(s);
    expect(out[id].warning).toBeUndefined();
    const b = body(s, id);
    expect(b.area).toBeCloseTo(10000, 5);
    const a = b.sheet!.angles;
    expect(a[ids[0]]).toBeCloseTo(40, 9);
    // a flat-foldable degree-4 vertex: one opposite pair folds alike, the other
    // equal and opposite, and tan(ρ₂/2) = cos((α+β)/2) / cos((α−β)/2) · tan(ρ₁/2)
    expect(a[ids[2]]).toBeCloseTo(a[ids[0]], 5);
    expect(a[ids[1]]).toBeCloseTo(-a[ids[3]], 5);
    const tanHalf = (deg: number) => Math.tan((deg * PI) / 360);
    const [al, be] = [60, 80].map((d) => (d * PI) / 180);
    expect(tanHalf(-a[ids[1]])).toBeCloseTo((Math.cos((al + be) / 2) / Math.cos((al - be) / 2)) * tanHalf(40), 6);
  });

  it("names the vertex when the angles given can't all fold at once", async () => {
    const s = realSession();
    const { sk, ids } = await vertex(s, [0, 80, 180, 280]);
    await ok(s, "feature.sheet", { sketch: sk, thickness: 0, radius: 0, folds: ids.map((line) => ({ line, angle: 60 })) });
    const out = rows(s);
    expect(Object.values(out).find((r) => r.error)?.error).toMatch(/around \(0\.0, 0\.0\) don't close up/);
  });

  it("thick paper: creases hinge on the inside with the outside corner filled", async () => {
    const s = realSession();
    const [sk] = await rectSketch(s, 100, 50);
    const l = await constructionLine(s, sk, [60, 0], [60, 50]);
    const id = await ok(s, "feature.sheet", { sketch: sk, thickness: 0.5, radius: 0, folds: [{ line: l, angle: 90 }] });
    const b = body(s, id);
    expect(b.volume).toBeCloseTo(5000 * 0.5 + (PI / 4) * 0.25 * 50, 4);
    expect(b.bounds!.max.x).toBeCloseTo(60.5, 6);
  });
});
