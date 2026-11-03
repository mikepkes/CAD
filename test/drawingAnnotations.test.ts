// The shop drawing's placed dimensions, section views and details: the 2D
// geometry (measuring, hatching, clipping), the commands, and the sheet they make
// on a real model — a plate with a hole, dimensioned by topological name, that
// keeps its dimensions through a rebuild and shows the new values, and marks
// them broken (not crashes) when the geometry is gone.
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { resolveParameters } from "../src/core/parameters";
import { placeComponentSketches } from "../src/core/recompute";
import { bodyTopology, evaluateFeatures } from "../src/core/features";
import { drawingModel, drawingSheet } from "../src/core/drawings";
import {
  measureDimension, hatchSegments, clipToCircle, sectionFrame, ORTHO_FRAMES, dimensionText, dimensionAnchor, linearDimSvg,
  type Feature2, type Seg,
} from "../src/core/drawingAnnotations";
import type { CadSession } from "../src/core/command/session";
import type { DrawingRef } from "../src/core/document";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

const pt = (p: [number, number]): Feature2 => ({ kind: "point", p });
const seg = (a: [number, number], b: [number, number]): Feature2 => ({ kind: "segment", a, b });

describe("measuring a dimension in a view", () => {
  it("measures horizontal, vertical and aligned distances, placed by an offset from their middle", () => {
    const h = measureDimension("horizontal", [pt([0, 0]), pt([30, 40])], { u: 0, v: -50 }, 100, [0, 0]);
    expect(h.ok && h.geom.kind === "linear" && h.geom.value).toBeCloseTo(30, 9);
    // the dimension line runs 50 below the midpoint (v = 20 − 50), from above each point
    expect(h.ok && h.geom.kind === "linear" && h.geom.ends).toEqual([[0, -30], [30, -30]]);
    const v = measureDimension("vertical", [pt([0, 0]), pt([30, 40])], { u: 60, v: 0 }, 100, [0, 0]);
    expect(v.ok && v.geom.value).toBeCloseTo(40, 9);
    const a = measureDimension("aligned", [pt([0, 0]), pt([30, 40])], undefined, 100, [100, -100]);
    expect(a.ok && a.geom.value).toBeCloseTo(50, 9);
    // two parallel edges: the gap between them, from the ends nearer the dimension line
    const g = measureDimension("aligned", [seg([0, 0], [0, 10]), seg([25, 0], [25, 10])], { u: 0, v: 20 }, 100, [0, 0]);
    expect(g.ok && g.geom.kind === "linear" && g.geom.value).toBeCloseTo(25, 9);
    expect(g.ok && g.geom.kind === "linear" && g.geom.feet).toEqual([[0, 10], [25, 10]]);
    // a circle counts as its centre
    const c = measureDimension("horizontal", [{ kind: "curve", pts: [], circle: { c: [10, 0], r: 5, faceOn: true } }, pt([42, 7])], { u: 0, v: 30 }, 100, [0, 0]);
    expect(c.ok && c.geom.value).toBeCloseTo(32, 9);
  });
  it("refuses what it can't measure, saying why", () => {
    const slanted = measureDimension("horizontal", [seg([0, 0], [10, 10]), pt([30, 0])], undefined, 100, [0, 0]);
    expect(slanted.ok).toBe(false);
    expect(!slanted.ok && slanted.reason).toMatch(/not square/);
    const skew = measureDimension("aligned", [seg([0, 0], [0, 10]), seg([20, 0], [25, 10])], undefined, 100, [0, 0]);
    expect(!skew.ok && skew.reason).toMatch(/not parallel/);
    expect(measureDimension("radius", [seg([0, 0], [1, 0])], undefined, 100, [0, 0]).ok).toBe(false);
    expect(measureDimension("angle", [seg([0, 0], [1, 0]), seg([0, 1], [1, 1])], undefined, 100, [0, 0]).ok).toBe(false);
  });
  it("measures a radius and a diameter with the arrow on the curve toward the text", () => {
    const circle: Feature2 = { kind: "curve", pts: [], circle: { c: [5, 5], r: 10, faceOn: true } };
    const r = measureDimension("radius", [circle], { u: 30, v: 40 }, 100, [0, 0]);
    expect(r.ok && r.geom.value).toBe(10);
    expect(r.ok && r.geom.kind === "radius" && r.geom.tip.map((x) => Math.round(x * 1e9) / 1e9)).toEqual([11, 13]);
    const d = measureDimension("diameter", [circle], { u: 30, v: 40 }, 100, [0, 0]);
    expect(d.ok && d.geom.value).toBe(20);
    expect(d.ok && d.geom.kind === "diameter" && d.geom.tip2!.map((x) => Math.round(x * 1e9) / 1e9)).toEqual([-1, -3]);
    expect(dimensionText("radius", 10)).toBe("R10");
    expect(dimensionText("diameter", 31.75, "4× ")).toBe("4× Ø31.8");
  });
  it("measures the angle on the side the offset points to", () => {
    const e1 = seg([0, 0], [10, 0]), e2 = seg([0, 0], [10, 10]);
    const inside = measureDimension("angle", [e1, e2], { u: 10, v: 3 }, 100, [0, 0]);
    expect(inside.ok && inside.geom.value).toBeCloseTo(45, 9);
    const outside = measureDimension("angle", [e1, e2], { u: -1, v: 5 }, 100, [0, 0]);
    expect(outside.ok && outside.geom.value).toBeCloseTo(135, 9);
    expect(dimensionAnchor("angle", [seg([5, 0], [10, 0]), seg([0, 5], [0, 10])])).toEqual([0, 0]);
  });
  it("draws a linear dimension with extension lines, two arrows and its text", () => {
    const svg = linearDimSvg([[0, 100], [200, 100]], [[0, 150], [200, 150]], "200");
    expect(svg.match(/<line /g)).toHaveLength(3); // two extension lines and the dimension line
    expect(svg.match(/<path /g)).toHaveLength(2); // the arrowheads
    expect(svg).toContain(">200</text>");
    // the extension lines start a gap off the geometry and run past the dimension line
    const ext = [...svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="[\d.]+" y2="([\d.]+)"/g)][0];
    expect(Number(ext[2])).toBeGreaterThan(100);
    expect(Number(ext[3])).toBeGreaterThan(150);
  });
});

describe("hatching and clipping", () => {
  const square: Seg[] = [[[0, 0], [10, 0]], [[10, 0], [10, 10]], [[10, 10], [0, 10]], [[0, 10], [0, 0]]];
  it("hatches a region at an angle, inside it only, and leaves a hole empty", () => {
    const h = hatchSegments(square, 45, 1);
    expect(h.length).toBeGreaterThan(10);
    for (const [p, q] of h) {
      for (const x of [...p, ...q]) { expect(x).toBeGreaterThanOrEqual(-1e-9); expect(x).toBeLessThanOrEqual(10 + 1e-9); }
      expect(Math.abs((q[1] - p[1]) / (q[0] - p[0]))).toBeCloseTo(1, 9); // at 45°
    }
    const hole: Seg[] = [[[4, 4], [6, 4]], [[6, 4], [6, 6]], [[6, 6], [4, 6]], [[4, 6], [4, 4]]];
    const flat = hatchSegments([...square, ...hole], 0, 1);
    const through = flat.filter(([p]) => p[1] > 4 && p[1] < 6);
    expect(through.length).toBe(4); // two rows, each split by the hole
    for (const [p, q] of through) expect(p[0] >= 6 - 1e-9 || q[0] <= 4 + 1e-9).toBe(true);
  });
  it("clips a segment to a circle", () => {
    expect(clipToCircle([[-10, 0], [10, 0]], [0, 0], 5)).toEqual([[-5, 0], [5, 0]]);
    expect(clipToCircle([[-10, 9], [10, 9]], [0, 0], 5)).toBeUndefined();
  });
  it("looks to the left of the section line, with up the world's up where it can", () => {
    // a vertical line up the front view: looks along −X, seen like the right view
    const v = sectionFrame(ORTHO_FRAMES.front, { u: 10, v: -100 }, { u: 10, v: 100 }).frame;
    expect(v.d).toEqual({ x: -1, y: 0, z: 0 });
    expect(v.v.z).toBeCloseTo(1, 12);
    expect(v.u.y).toBeCloseTo(1, 12);
    // a level line across the front view, flipped: looks down, seen like the top view
    const h = sectionFrame(ORTHO_FRAMES.front, { u: -100, v: 5 }, { u: 100, v: 5 }, true).frame;
    expect(h.d.z).toBeCloseTo(-1, 12);
    expect(h.u.x).toBeCloseTo(1, 12);
    expect(h.v.y).toBeCloseTo(1, 12);
  });
});

describe("drawing commands", () => {
  it("adds, edits and removes dimensions, sections and details, undoably and with the views checked", async () => {
    const s = realSession();
    const edge = { body: "ext5", edge: "a|b" };
    const [dim] = await dis(s, "drawing.addDimension", { view: "front", kind: "horizontal", refs: [edge, { body: "ext5", vertex: "a|b|c" }], offset: { u: 0, v: 20 } });
    expect(s.doc.drafting?.dimensions[0]).toMatchObject({ id: dim, view: "front", kind: "horizontal", offset: { u: 0, v: 20 } });
    expect((await s.dispatch("drawing.addDimension", { view: "nowhere", kind: "radius", refs: [edge] })).ok).toBe(false);
    expect((await s.dispatch("drawing.addDimension", { view: "top", kind: "radius", refs: [edge, edge] })).error).toMatch(/one circle/);
    expect((await s.dispatch("drawing.addDimension", { view: "top", kind: "angle", refs: [edge, { body: "x", vertex: "v" }] })).error).toMatch(/edges/);
    const [sec] = await dis(s, "drawing.addSection", { base: "front", from: { u: 0, v: -10 }, to: { u: 0, v: 10 } });
    const [det] = await dis(s, "drawing.addDetail", { base: sec, center: { u: 0, v: 0 }, radius: 5 });
    expect(s.doc.drafting?.sections[0].label).toBe("A");
    expect(s.doc.drafting?.details[0]).toMatchObject({ label: "B", scale: 2 });
    const [onSec] = await dis(s, "drawing.addDimension", { view: sec, kind: "diameter", refs: [edge] });
    await dis(s, "drawing.edit", { id: dim, offset: { u: 5, v: 30 } });
    expect(s.doc.drafting?.dimensions[0].offset).toEqual({ u: 5, v: 30 });
    expect((await s.dispatch("drawing.edit", { id: dim, radius: 3 })).error).toMatch(/has no radius/);
    // removing the section takes the detail of it and the dimension on it along
    const r = await s.dispatch("drawing.remove", { id: sec });
    expect(r.message).toContain(det);
    expect(s.doc.drafting?.sections).toEqual([]);
    expect(s.doc.drafting?.details).toEqual([]);
    expect(s.doc.drafting?.dimensions.map((d) => d.id)).toEqual([dim]);
    s.undo();
    expect(s.doc.drafting?.dimensions.map((d) => d.id)).toEqual([dim, onSec]);
  });
});

describe("dimensions and sections on a real model", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  /** A W × 60 × 20 plate with a Ø20 hole, on XY. */
  async function plate() {
    const s = realSession();
    await dis(s, "parameter.add", { name: "W", expression: "100" });
    const sk = (await dis(s, "sketch.create", { plane: "XY" }))[0];
    const ids: string[] = [];
    for (const [x, y] of [[0, 0], ["W", 0], ["W", 60], [0, 60]]) ids.push((await dis(s, "sketch.addPoint", { sketch: sk, x, y }))[0]);
    for (let i = 0; i < 4; i++) await dis(s, "sketch.addLine", { sketch: sk, start: { ref: ids[i] }, end: { ref: ids[(i + 1) % 4] } });
    const body = (await dis(s, "feature.extrude", { sketch: sk, distance: "20" }))[0];
    const hs = (await dis(s, "sketch.create", { plane: "XY" }))[0];
    await dis(s, "sketch.addCircle", { sketch: hs, center: { x: 30, y: 30 }, radius: 10 });
    await dis(s, "feature.extrude", { sketch: hs, distance: "1", operation: "cut", extent: "throughAll", symmetric: true, body });
    await s.recompute();
    return { s, body };
  }
  const scopeOf = (s: CadSession) => { const sc = resolveParameters(s.doc.parameters).scope; placeComponentSketches(s.doc, sc); return sc; };
  /** The name of the plate's edge or vertex nearest a point, as body_topology and the drawing name it. */
  function names(s: CadSession, body: string) {
    const topo = bodyTopology(s.doc, scopeOf(s), { bodyId: body })[0];
    const edgeAt = (x: number, y: number, z: number) => topo.edges.reduce((a, e) => (Math.hypot(e.mid.x - x, e.mid.y - y, e.mid.z - z) < Math.hypot(a.mid.x - x, a.mid.y - y, a.mid.z - z) ? e : a)).name;
    return { edgeAt, circles: topo.edges.filter((e) => e.type === "CIRCLE").map((e) => e.name) };
  }
  const sheetOf = (s: CadSession) => { const sc = scopeOf(s); const built = evaluateFeatures(s.doc, sc); return drawingSheet(s.doc, sc, { title: "Plate" }, built, drawingModel(s.doc, sc)); };

  it("dimension named geometry, keep it through a rebuild with the new values, and break cleanly", async () => {
    const { s, body } = await plate();
    const n = names(s, body);
    // the plate's left and right ends seen edge-on in the front view, and its top hole edge
    const left: DrawingRef = { body, edge: n.edgeAt(0, 30, 20) }, right: DrawingRef = { body, edge: n.edgeAt(100, 30, 20) };
    const topHole = n.circles.map((c) => ({ body, edge: c })).find((r) => r.edge.includes("end"))!;
    expect(topHole).toBeTruthy();
    const width = (await dis(s, "drawing.addDimension", { view: "top", kind: "horizontal", refs: [left, right], offset: { u: 0, v: 50 } }))[0];
    const dia = (await dis(s, "drawing.addDimension", { view: "top", kind: "diameter", refs: [topHole], offset: { u: 25, v: 25 } }))[0];
    const rad = (await dis(s, "drawing.addDimension", { view: "top", kind: "radius", refs: [topHole] }))[0];
    // the hole's centre to the plate's right end, centre to edge
    const toEnd = (await dis(s, "drawing.addDimension", { view: "top", kind: "horizontal", refs: [topHole, right], offset: { u: 0, v: -45 } }))[0];
    // a corner vertex to the hole's centre, aligned
    const model0 = drawingModel(s.doc, scopeOf(s));
    const corner = model0.bodies.find((b) => b.id === body)!.vertices.find((v) => Math.hypot(v.at.x, v.at.y, v.at.z - 20) < 1e-6)!;
    expect(corner.name.split("|")).toHaveLength(3);
    const diag = (await dis(s, "drawing.addDimension", { view: "top", kind: "aligned", refs: [{ body, vertex: corner.name }, topHole], offset: { u: -10, v: 10 } }))[0];
    // an angle between the plate's front and right edges in the top view
    const front = { body, edge: n.edgeAt(50, 0, 20) };
    const angle = (await dis(s, "drawing.addDimension", { view: "top", kind: "angle", refs: [front, right], offset: { u: -15, v: 15 } }))[0];

    let { svg, sheet } = sheetOf(s);
    const value = (id: string) => sheet.dimensions.find((d) => d.id === id);
    expect(value(width)).toMatchObject({ value: 100, text: "100" });
    expect(value(dia)).toMatchObject({ text: "Ø20" });
    expect(value(rad)).toMatchObject({ text: "R10" });
    expect(value(toEnd)?.value).toBeCloseTo(70, 6);
    expect(value(diag)?.value).toBeCloseTo(Math.hypot(30, 30), 6);
    expect(value(angle)?.value).toBeCloseTo(90, 6);
    for (const id of [width, dia, rad, toEnd, diag, angle]) expect(svg).toContain(`data-dim="${id}"`);
    expect(svg).toContain(">Ø20</text>");
    // the views and what can be picked in them
    expect(sheet.views.map((v) => v.id)).toEqual(["front", "top", "right"]);
    expect(sheet.picks.top.some((p) => "edge" in p.ref && p.ref.edge === topHole.edge)).toBe(true);

    // a parameter change: the same names, the new values
    await dis(s, "parameter.set", { name: "W", expression: "140" });
    await s.recompute();
    ({ svg, sheet } = sheetOf(s));
    expect(value(width)?.value).toBeCloseTo(140, 6);
    expect(value(toEnd)?.value).toBeCloseTo(110, 6);
    expect(value(dia)?.text).toBe("Ø20");
    expect(svg).toContain(">140</text>");

    // the hole goes (its cut suppressed): the dimensions on it show as broken, the rest still measure
    const cutOp = s.doc.operations.find((o) => o.type === "feature.extrude" && o.params.operation === "cut")!;
    expect((await s.setSuppressed(cutOp.opId, true)).ok).toBe(true);
    await s.recompute();
    ({ svg, sheet } = sheetOf(s));
    expect(value(dia)?.broken).toMatch(/has no edge/);
    expect(value(diag)?.broken).toBeTruthy();
    expect(value(width)?.value).toBeCloseTo(140, 6);
    expect(svg).toContain(`class="dim dim-broken" data-dim="${dia}"`);
    // a body that doesn't exist at all
    await dis(s, "drawing.addDimension", { view: "front", kind: "vertical", refs: [{ body: "nope", edge: "x|y" }, left] });
    ({ sheet } = sheetOf(s));
    expect(sheet.dimensions.at(-1)?.broken).toMatch(/no body nope/);
  });

  it("cuts a section through the hole, hatches the cut faces, and draws the section line on its base view", async () => {
    const { s } = await plate();
    // across the front view at x = 30 (through the hole's middle), looking along −X
    const [sec] = await dis(s, "drawing.addSection", { base: "front", from: { u: 30, v: -10 }, to: { u: 30, v: 30 } });
    const { svg, sheet } = sheetOf(s);
    const view = sheet.views.find((v) => v.id === sec)!;
    expect(view.label).toBe("SECTION A–A");
    // the cut: two slabs either side of the hole, 20 deep, hatched; seen like the right view (y across, z up)
    expect(view.w / view.scale).toBeCloseTo(60, 3);
    const hatch = svg.match(/<g class="hatch"[^>]*>([\s\S]*?)<\/g>/g) ?? [];
    expect(hatch.length).toBe(1); // one part
    const lines = [...hatch[0].matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)].map((m) => m.slice(1).map(Number));
    expect(lines.length).toBeGreaterThan(5);
    // every hatch line inside the section's frame, and none crossing the hole (u 20..40 in the cut's y)
    const holeX = [view.x + (20 - view.minU) * view.scale, view.x + (40 - view.minU) * view.scale];
    for (const [x1, y1, x2, y2] of lines) {
      for (const [x, y] of [[x1, y1], [x2, y2]]) { expect(x).toBeGreaterThanOrEqual(view.x - 0.2); expect(x).toBeLessThanOrEqual(view.x + view.w + 0.2); expect(y).toBeGreaterThanOrEqual(view.y - 0.2); expect(y).toBeLessThanOrEqual(view.y + view.h + 0.2); }
      const mid = (x1 + x2) / 2;
      expect(mid < holeX[0] + 0.2 || mid > holeX[1] - 0.2).toBe(true);
    }
    expect(svg).toContain(`class="section-line" data-section="${sec}" data-label="A"`);
    // a detail of the section, twice as large
    const [det] = await dis(s, "drawing.addDetail", { base: sec, center: { u: 20, v: 10 }, radius: 8 });
    const again = sheetOf(s);
    const dv = again.sheet.views.find((v) => v.id === det)!;
    expect(dv.label).toBe("DETAIL B (2×)");
    expect(dv.scale).toBeCloseTo(2 * view.scale, 9);
    expect(again.svg).toContain(`data-detail="${det}"`);
    // what can be picked in the section is only what it shows (the hole's edges, x 20..40, straddle the cut)
    expect(again.sheet.picks[sec].length).toBeGreaterThan(0);
    expect(again.sheet.picks[det].length).toBeLessThan(again.sheet.picks[sec].length);
  });
});
