import { describe, it, expect, vi } from "vitest";
import { realSession } from "./helpers";
import { createDocument } from "../src/core/document";
import { resolveParameters } from "../src/core/parameters";
import type { GeometryBackend } from "../src/core/geometry/backend";
import type { CadDocument } from "../src/core/document";
import { parseIntent, metricsOf, densityOf, checkIntents } from "../src/model/concepts/intents";
import { materialForComponent } from "../src/core/document";
import {
  boundedParams, pickAxes, axisOf, quantizeTo, axisValue, axisIndex, axisCoord, axisFromCoord, stepValue, cellOrder, cellKey,
  judgeCell, mappableIntents, metricRange, shadeOf, lightestPassing, frontier, frontiers, layout, gridToSvg, svgToGrid, clientToSvg, pointToValues, ticks,
  addPin, removePin, metricDeltas, formatDelta, formatMetric, docSignature, gridKey, describePoint, withDensity,
  keyMove, swapAxes, cellOpacity, cellTitle, lightestMark, frontierStroke, frontierColor, mapLegend, resultsFor, okCount, readoutState, intentsText, statusText, pinMove,
  type Axis, type CellVerdict, type GridSpec,
} from "../src/ui/concepts/space/space";
import { sampleGrid, sampleCell, variantDoc, GridCache, getSamplerBackend, disposeSamplerBackend } from "../src/ui/concepts/space/sampler";
import { useSpace } from "../src/ui/concepts/space/spaceState";
import { variantDocForPin, pinApplies, ghostKey, ghostLabel, evaluateVariant, ghostStatusText, GhostCache } from "../src/ui/concepts/space/ghost";
import { useGhost, ghostSolidViews } from "../src/model/concepts/ghostVariant";
import { useStore } from "../src/model/store";
import type { SolidEval } from "../src/core/features";
import type { Pin } from "../src/ui/concepts/space/space";

const param = (name: string, expr: string, extra: Record<string, unknown> = {}) => ({ id: name, name, expr, value: Number(expr), ...extra }) as never;

/** A backend whose only body is a w × h × 10 box: volume reads the two parameters, so each cell is checkable by hand. */
function boxBackend(onEval?: (doc: CadDocument) => void): GeometryBackend {
  return {
    init: async () => {}, ready: () => true, dispose: () => {},
    evaluate: async (doc) => {
      onEval?.(doc);
      const { scope } = resolveParameters(doc.parameters);
      const w = scope.w, h = scope.h;
      if (w * h > 1000) throw new Error("too big to build");
      return { solids: { b: { featureId: "b", name: "b", sketchId: "", distance: 0, mesh: {} as never, volume: w * h * 10, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: w, y: h, z: 10 } } } }, facePlanes: {} };
    },
    edges: async () => [], exportBytes: async () => null, collide: async () => ({ overlaps: [], maxOverlap: 0 }) as never, topology: async () => [], distance: async () => 0, analyze: async () => [],
  };
}

async function twoParamSession() {
  const s = realSession();
  await s.dispatch("parameter.add", { name: "w", expression: "30", min: 10, max: 50, step: 5 });
  await s.dispatch("parameter.add", { name: "h", expression: "15", min: 5, max: 25 });
  await s.dispatch("parameter.add", { name: "free", expression: "2" });
  return s;
}

describe("design space: axes and grid", () => {
  it("maps only parameters with numeric min < max that are not switches, enums or value lists", () => {
    const ps = [param("a", "1", { min: 0, max: 10 }), param("b", "1"), param("c", "1", { min: 5, max: 5 }), param("d", "1", { min: 0, max: 1, boolean: true }), param("e", "1", { values: [1, 2] }), param("f", "1", { min: 0, max: 2, options: ["x", "y", "z"] }), param("g", "1", { min: 2, max: 9, step: 1 })];
    expect(boundedParams(ps).map((p) => p.name)).toEqual(["a", "g"]);
    expect(pickAxes(boundedParams(ps), null, null)!.map((p) => p.name)).toEqual(["a", "g"]);
    expect(pickAxes(boundedParams(ps), "g", "a")!.map((p) => p.name)).toEqual(["g", "a"]);
    expect(pickAxes(boundedParams(ps), "g", "g")!.map((p) => p.name)).toEqual(["g", "a"]); // never the same twice
    expect(pickAxes(boundedParams(ps), "zzz", "a")!.map((p) => p.name)).toEqual(["a", "g"]);
    expect(pickAxes([ps[0]], null, null)).toBeNull();
    expect(axisOf(ps[6])).toEqual({ name: "g", min: 2, max: 9, step: 1, unit: undefined });
  });

  it("quantizes to the step anchored at min and clamps to the bounds", () => {
    const a: Axis = { name: "w", min: 10, max: 50, step: 5 };
    expect(quantizeTo(a, 23.4)).toBe(25);
    expect(quantizeTo(a, 2)).toBe(10);
    expect(quantizeTo(a, 99)).toBe(50);
    const b: Axis = { name: "t", min: 0.5, max: 3, step: 0.1 };
    expect(quantizeTo(b, 1.2500001)).toBe(1.3);
    expect(quantizeTo({ name: "x", min: 0, max: 1 }, 0.333333333)).toBe(0.3333);
  });

  it("round-trips grid indices and values", () => {
    const a: Axis = { name: "w", min: 10, max: 50 };
    expect(axisValue(a, 0, 9)).toBe(10);
    expect(axisValue(a, 8, 9)).toBe(50);
    expect(axisValue(a, 4, 9)).toBe(30);
    expect(axisIndex(a, 30, 9)).toBe(4);
    expect(axisIndex(a, 31, 9)).toBe(4);
    expect(axisIndex(a, 500, 9)).toBe(8);
    expect(axisCoord(a, 20, 9)).toBe(2);
    expect(axisFromCoord(a, 2.4, 9)).toBe(22);
    const stepped: Axis = { ...a, step: 5 };
    expect(axisValue(stepped, 1, 9)).toBe(15);
    expect(axisValue(stepped, 3, 9)).toBe(25); // 25 exactly on the step
    expect(axisFromCoord(stepped, 2.4, 9)).toBe(20);
  });

  it("arrow steps use the parameter step, else one cell; shift always one cell", () => {
    expect(stepValue({ name: "w", min: 10, max: 50, step: 5 }, 30, 1, 9)).toBe(35);
    expect(stepValue({ name: "w", min: 10, max: 50, step: 5 }, 30, -1, 9, true)).toBe(25);
    expect(stepValue({ name: "h", min: 5, max: 25 }, 15, 1, 5)).toBe(20);
    expect(stepValue({ name: "h", min: 5, max: 25 }, 25, 1, 5)).toBe(25);
  });

  it("orders cells centre, corners, coarse levels, then the rest, covering every cell once", () => {
    for (const n of [5, 9, 13]) {
      const order = cellOrder(n);
      expect(order.length).toBe(n * n);
      expect(new Set(order.map(([i, j]) => cellKey(i, j, n))).size).toBe(n * n);
      const c = (n - 1) / 2;
      expect(order[0]).toEqual([c, c]);
      const corners = order.slice(1, 5).map(([i, j]) => `${i},${j}`).sort();
      expect(corners).toEqual([`0,0`, `0,${n - 1}`, `${n - 1},0`, `${n - 1},${n - 1}`]);
      // the half-grid (edge midpoints) comes before any odd cell
      const firstOdd = order.findIndex(([i, j]) => i % 2 === 1 || j % 2 === 1);
      const lastHalf = Math.max(...order.map(([i, j], k) => (i % c === 0 && j % c === 0 ? k : -1)));
      expect(lastHalf).toBeLessThan(firstOdd);
    }
  });
});

describe("design space: cells, frontiers and the lightest", () => {
  const spec: GridSpec = { x: { name: "w", min: 10, max: 50 }, y: { name: "h", min: 5, max: 25 }, n: 5 };
  const doc = createDocument();
  doc.parameters.push(param("w", "30", { min: 10, max: 50 }), param("h", "15", { min: 5, max: 25 }));
  const cap = parseIntent("volume <= 4000", "i1", "Volume cap")!;
  const wide = parseIntent("w >= 20", "i2", "Wide enough")!;

  const grid = (intents = [cap, wide]) => {
    const cells: (CellVerdict | undefined)[] = new Array(25);
    for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) {
      const x = axisValue(spec.x, i, 5), y = axisValue(spec.y, j, 5);
      cells[cellKey(i, j, 5)] = judgeCell({ i, j, x, y, metrics: metricsOf({ b: { featureId: "b", name: "b", mesh: {} as never, volume: x * y * 10, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x, y, z: 10 } } } as never }, 1) }, doc, spec, intents, 2.7);
    }
    return cells;
  };

  it("judges a cell against the intents with the cell's own parameter values in scope", () => {
    const cells = grid();
    const c = cells[cellKey(0, 0, 5)]!; // w 10, h 5 → volume 500: cap ok, wide fails
    expect(c.results.map((r) => r.ok)).toEqual([true, false]);
    expect(c.pass).toBe(false);
    const d = cells[cellKey(2, 1, 5)]!; // w 30, h 10 → 3000
    expect(d.pass).toBe(true);
    expect(d.metrics!.mass).toBeCloseTo(3 * 2.7, 6); // re-expressed at the document density
    const unbuilt = judgeCell({ i: 0, j: 0, x: 1, y: 1, metrics: null, error: "boom" }, doc, spec, [cap], 1);
    expect(unbuilt.pass).toBe(false);
    expect(unbuilt.results).toEqual([]);
  });

  it("keeps only intents the map can evaluate", () => {
    const scope = { w: 30, h: 15, volume: 100, mass: 1, density: 1, width: 1, depth: 1, height: 1, bodies: 1 };
    const odd = parseIntent("deflection <= 0.5", "i9")!;
    expect(mappableIntents([cap, odd, wide], scope).map((i) => i.id)).toEqual(["i1", "i2"]);
  });

  it("shades by metric, brighter for lower, and finds the lightest passing cell", () => {
    const cells = grid();
    const r = metricRange(cells, "volume")!;
    expect(r).toEqual({ min: 500, max: 12500 });
    expect(shadeOf(500, r)).toBe(1);
    expect(shadeOf(12500, r)).toBe(0);
    expect(shadeOf(5, null)).toBe(1);
    const best = lightestPassing(cells, "volume", 5)!;
    expect([best.x, best.y]).toEqual([20, 5]); // the smallest box that is still wide enough
    expect(lightestPassing(grid([parseIntent("volume <= 1", "z")!]), "volume", 5)).toBeNull();
  });

  it("draws a frontier between passing and failing neighbours (marching squares over cell centres)", () => {
    const cells = grid([wide]); // passes for w >= 20: columns 1..4, fails column 0 → a vertical line at x = 0.5
    const segs = frontier(cells, 5, (c) => c.pass);
    expect(segs.length).toBe(4);
    for (const s of segs) { expect(s.x1).toBe(0.5); expect(s.x2).toBe(0.5); }
    expect(frontier(grid([cap]).map((c, k) => (k === 7 ? undefined : c)), 5, (c) => c.pass).length).toBeGreaterThan(0); // an unsampled hole only skips its squares
    expect(frontier(new Array(25), 5, (c) => c.pass)).toEqual([]);
    const all = frontiers(grid(), 5, [cap, wide]);
    expect(all.map((f) => f.label)).toEqual(["Volume cap", "Wide enough", "All intents"]);
    expect(all[1].segments.length).toBe(4);
    expect(all[2].segments.length).toBeGreaterThan(4);
  });

  it("handles saddles with two segments", () => {
    const cells: (CellVerdict | undefined)[] = new Array(4);
    const mk = (i: number, j: number, pass: boolean) => ({ i, j, x: 0, y: 0, metrics: null, results: [], pass }) as CellVerdict;
    cells[cellKey(0, 0, 2)] = mk(0, 0, true); cells[cellKey(1, 1, 2)] = mk(1, 1, true);
    cells[cellKey(1, 0, 2)] = mk(1, 0, false); cells[cellKey(0, 1, 2)] = mk(0, 1, false);
    expect(frontier(cells, 2, (c) => c.pass).length).toBe(2);
  });

  it("describes the current point for the accessible label", () => {
    expect(describePoint(spec, 30, 15, "pass", "Mass (est.) 12 g")).toBe("Design space map. w 30, h 15, Mass (est.) 12 g; passes every intent. Drag to move the design; arrow keys step.");
    expect(describePoint(spec, 30, 15, "unknown")).toContain("not yet checked");
  });
});

describe("design space: layout", () => {
  it("maps grid coordinates to the viewBox and back, y up", () => {
    const L = layout(5);
    const p = gridToSvg(L, 0, 0);
    expect(p.x).toBeCloseTo(L.left + L.w / 10);
    expect(p.y).toBeCloseTo(L.top + L.h - L.h / 10); // bottom-left cell
    const g = svgToGrid(L, p.x, p.y);
    expect(g.gx).toBeCloseTo(0); expect(g.gy).toBeCloseTo(0);
    const top = gridToSvg(L, 4, 4);
    expect(top.y).toBeLessThan(p.y);
  });
  it("converts client pixels using the rendered size, and a pointer into quantized values", () => {
    const s = clientToSvg({ left: 100, top: 50, width: 280, height: 210 }, 100 + 140, 50 + 105);
    expect(s).toEqual({ x: 280, y: 210 });
    expect(clientToSvg({ left: 0, top: 0, width: 0, height: 0 }, 30, 40)).toEqual({ x: 30, y: 40 }); // jsdom: no layout → 1:1
    const spec: GridSpec = { x: { name: "w", min: 10, max: 50, step: 5 }, y: { name: "h", min: 5, max: 25 }, n: 5 };
    const L = layout(5);
    const c = gridToSvg(L, 2, 2);
    expect(pointToValues(spec, L, c.x, c.y)).toEqual({ x: 30, y: 15 });
    expect(pointToValues(spec, L, -1000, 1000)).toEqual({ x: 10, y: 5 }); // clamped
  });
  it("ticks land on grid indices, ending at max", () => {
    const t = ticks({ name: "w", min: 10, max: 50, step: 5 }, 9);
    expect(t.map((x) => x.value)).toEqual([10, 20, 30, 40, 50]);
    expect(t.map((x) => x.label)).toEqual(["10", "20", "30", "40", "50"]);
    expect(ticks({ name: "w", min: 0, max: 1 }, 13).at(-1)!.coord).toBe(12);
  });
});

describe("design space: pins, metrics and the cache key", () => {
  it("adds pins A, B, C at most, never twice the same point, and removes by letter", () => {
    const base = { xName: "w", yName: "h", metrics: null, verdict: "unknown" as const };
    let pins = addPin([], { ...base, x: 1, y: 1 });
    pins = addPin(pins, { ...base, x: 1, y: 1 });
    expect(pins.map((p) => p.letter)).toEqual(["A"]);
    pins = addPin(pins, { ...base, x: 2, y: 1 });
    pins = addPin(pins, { ...base, x: 3, y: 1 });
    pins = addPin(pins, { ...base, x: 4, y: 1 });
    expect(pins.map((p) => p.letter)).toEqual(["A", "B", "C"]);
    pins = removePin(pins, "B");
    pins = addPin(pins, { ...base, x: 5, y: 1 });
    expect(pins.map((p) => [p.letter, p.x])).toEqual([["A", 1], ["B", 5], ["C", 3]]);
  });

  it("formats metrics and deltas honestly", () => {
    const m = metricsOf({ b: { featureId: "b", name: "b", mesh: {} as never, volume: 12000, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 20, z: 15 } } } as never }, 2.7);
    expect(formatMetric(m.mass, "mass")).toBe("32.4 g");
    expect(formatMetric(m.volume, "volume")).toBe("12,000 mm³");
    expect(formatMetric(undefined, "mass")).toBe("—");
    const d = metricDeltas(m, withDensity({ ...m, volume: 10000 }, 2.7));
    expect(d.volume).toBe(-2000);
    expect(formatDelta(d.volume, "volume")).toBe("−2,000 mm³");
    expect(formatDelta(d.mass, "mass")).toBe("−5.40 g");
    expect(formatDelta(0, "width")).toBe("±0 mm");
    expect(formatDelta(2.5, "height")).toBe("+2.50 mm");
    expect(metricDeltas(null, m)).toEqual({});
  });

  it("reads the density (one for every concept) from the root component's material", () => {
    const doc = createDocument();
    const rootMaterial = () => materialForComponent(doc, doc.rootComponentId);
    expect(densityOf(rootMaterial())).toEqual({ density: 2.7, source: "no material: aluminium 2.7 g/cm³ assumed" });
    doc.materials["m1"] = { id: "m1", name: "Oak", kind: "wood" } as never;
    doc.components[doc.rootComponentId].materialId = "m1";
    expect(densityOf(rootMaterial()).density).toBe(0.7);
    expect(densityOf(rootMaterial()).source).toContain("Oak");
  });

  it("steps the design point with the arrow keys and swaps axes so both are never the same parameter", () => {
    const spec: GridSpec = { x: { name: "w", min: 10, max: 50, step: 5 }, y: { name: "h", min: 5, max: 25 }, n: 5 };
    expect(keyMove(spec, { x: 30, y: 15 }, "ArrowRight")).toEqual({ x: 35, y: 15 });
    expect(keyMove(spec, { x: 30, y: 15 }, "ArrowUp", true)).toEqual({ x: 30, y: 20 });
    expect(keyMove(spec, { x: 30, y: 15 }, "ArrowDown")).toEqual({ x: 30, y: 10 });
    expect(keyMove(spec, { x: 30, y: 15 }, "Enter")).toBeNull();
    expect(swapAxes(spec, "x", "h")).toEqual({ x: "h", y: "w" });
    expect(swapAxes(spec, "x", "d")).toEqual({ x: "d", y: "h" });
    expect(swapAxes(spec, "y", "w")).toEqual({ x: "h", y: "w" });
    expect(swapAxes(spec, "y", "d")).toEqual({ x: "w", y: "d" });
  });

  it("describes cells, shades and marks them, and colours frontiers", () => {
    const spec: GridSpec = { x: { name: "w", min: 10, max: 50, step: 5 }, y: { name: "h", min: 5, max: 25 }, n: 5 };
    const doc = createDocument();
    doc.parameters.push(param("w", "30"), param("h", "15"));
    const intents = [parseIntent("volume <= 6000", "i1", "Volume cap")!];
    const pass = judgeCell({ i: 1, j: 0, x: 20, y: 5, metrics: metricsOf({ b: { featureId: "b", name: "b", mesh: {} as never, volume: 1000, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 5, z: 10 } } } as never }, 1) }, doc, spec, intents, 2.7);
    const fail = judgeCell({ i: 4, j: 4, x: 50, y: 25, metrics: metricsOf({ b: { featureId: "b", name: "b", mesh: {} as never, volume: 12500 } as never }, 1) }, doc, spec, intents, 2.7);
    const broken = judgeCell({ i: 0, j: 0, x: 10, y: 5, metrics: null, error: "no bodies" }, doc, spec, intents, 2.7);
    expect(cellTitle(spec, pass, "mass")).toBe("w 20, h 5: Mass (est.) 2.70 g; passes");
    expect(cellTitle(spec, fail, "volume")).toBe("w 50, h 25: Volume 12,500 mm³; fails Volume cap");
    expect(cellTitle(spec, broken, "mass")).toBe("w 10, h 5: Mass (est.) —; did not build (no bodies)");
    expect(cellOpacity(0, { min: 0, max: 10 })).toBeCloseTo(0.9);
    expect(cellOpacity(10, { min: 0, max: 10 })).toBeCloseTo(0.15);
    expect(cellOpacity(5, null)).toBeCloseTo(0.9);
    expect(lightestMark({ x: 100, y: 50 }, { w: 50, h: 100 })).toBe("M100 34 L116 50 L100 66 L84 50 Z");
    expect(frontierStroke(0, 2)).toBe(frontierColor(0));
    expect(frontierStroke(2, 2)).toBe("var(--k-bad)");
    const legend = mapLegend("volume", [{ label: "Volume cap" }, { label: "All intents" }], 1);
    expect(legend.map((r) => r.label)).toEqual(["passes (brighter = lower volume)", "fails / did not build", "Volume cap", "All intents"]);
    expect(legend.map((r) => r.color)).toEqual(["var(--k-ok)", "var(--k-bad)", frontierColor(0), "var(--k-bad)"]);
  });

  it("maps verdicts to readouts and the status line", () => {
    const i1 = parseIntent("w >= 20", "i1", "Wide")!, i2 = parseIntent("h <= 20", "i2", "Low")!, i3 = parseIntent("zz > 1", "i3", "Unknown")!;
    const results = checkIntents([i1, i2, i3], { w: 30, h: 25 });
    const mine = resultsFor(results, [i2, i1]);
    expect(mine.map((r) => r.intent.id)).toEqual(["i2", "i1"]);
    expect(resultsFor(results, [parseIntent("a < 1", "i9")!])[0]).toMatchObject({ ok: false, error: "not checked" });
    expect(okCount(mine)).toBe(1);
    expect(intentsText(mine)).toBe("1 / 2 ok");
    expect(intentsText([])).toBe("none");
    expect(readoutState("pass")).toBe("ok");
    expect(readoutState("fail")).toBe("bad");
    expect(readoutState("unknown")).toBeUndefined();
    expect(statusText("starting", { done: 0, total: 25 }, null)).toBe("starting kernel…");
    expect(statusText("sampling", { done: 3, total: 25 }, null)).toBe("sampling 3 / 25");
    expect(statusText("done", { done: 25, total: 25 }, null)).toBe("25 cells");
    expect(statusText("error", { done: 0, total: 25 }, "boom")).toBe("sampling failed: boom");
    expect(statusText("idle", { done: 4, total: 25 }, null)).toBe("4 / 25 cells");
    expect(statusText("idle", { done: 0, total: 0 }, null)).toBe("");
    expect(pinMove({ letter: "A", x: 1, y: 2, xName: "w", yName: "h", metrics: null, verdict: "unknown" })).toEqual({ xName: "w", yName: "h", x: 1, y: 2 });
  });

  it("keeps the panel's private state, and unpinning the compared pin clears the compare", () => {
    useSpace.setState({ pins: [], compare: null });
    useSpace.getState().pin({ x: 1, y: 2, xName: "w", yName: "h", metrics: null, verdict: "unknown" });
    useSpace.getState().pin({ x: 3, y: 4, xName: "w", yName: "h", metrics: null, verdict: "unknown" });
    useSpace.getState().setCompare("A");
    useSpace.getState().unpin("B");
    expect(useSpace.getState().compare).toBe("A");
    useSpace.getState().unpin("A");
    expect(useSpace.getState().compare).toBeNull();
    expect(useSpace.getState().pins).toEqual([]);
  });

  it("shares one sampler backend, forgets a failed start so the next run retries, and disposes on request", async () => {
    disposeSamplerBackend();
    let calls = 0;
    const failing = () => { calls++; return Promise.reject(new Error("no wasm")); };
    await expect(getSamplerBackend(failing)).rejects.toThrow("no wasm");
    await expect(getSamplerBackend(failing)).rejects.toThrow("no wasm");
    expect(calls).toBe(2);
    const dispose = vi.fn();
    const backend = { ...boxBackend(), dispose };
    const create = vi.fn(async () => backend);
    expect(await getSamplerBackend(create)).toBe(backend);
    expect(await getSamplerBackend(create)).toBe(backend);
    expect(create).toHaveBeenCalledTimes(1);
    disposeSamplerBackend();
    await new Promise((r) => setTimeout(r, 0));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(await getSamplerBackend(create)).toBe(backend);
    expect(create).toHaveBeenCalledTimes(2);
    disposeSamplerBackend();
  });

  it("keys the grid by the recipe with the axis expressions blanked, so a drag does not invalidate it", async () => {
    const s = await twoParamSession();
    const spec: GridSpec = { x: axisOf(s.doc.parameters[0]), y: axisOf(s.doc.parameters[1]), n: 5 };
    const k1 = gridKey(spec, docSignature(s.timeline, s.rollbackIndex, s.doc.activeConfiguration, ["w", "h"]));
    const op = s.timeline.find((o) => o.params.name === "w")!;
    await s.editOperation(op.opId, { ...op.params, expression: "45" });
    const k2 = gridKey(spec, docSignature(s.timeline, s.rollbackIndex, s.doc.activeConfiguration, ["w", "h"]));
    expect(k2).toBe(k1);
    const free = s.timeline.find((o) => o.params.name === "free")!;
    await s.editOperation(free.opId, { ...free.params, expression: "3" });
    const k3 = gridKey(spec, docSignature(s.timeline, s.rollbackIndex, s.doc.activeConfiguration, ["w", "h"]));
    expect(k3).not.toBe(k1);
    expect(gridKey({ ...spec, n: 9 }, "sig")).not.toBe(gridKey(spec, "sig"));
  });
});

describe("design space: sampler", () => {
  it("builds a variant with the two expressions replaced and nothing else shared", async () => {
    const s = await twoParamSession();
    const spec: GridSpec = { x: axisOf(s.doc.parameters[0]), y: axisOf(s.doc.parameters[1]), n: 5 };
    const v = variantDoc(s.doc, spec, 40, 20);
    expect(v).not.toBe(s.doc);
    expect(v.parameters.map((p) => p.expr)).toEqual(["40", "20", "2"]);
    expect(s.doc.parameters.map((p) => p.expr)).toEqual(["30", "15", "2"]);
    expect(resolveParameters(v.parameters).scope).toMatchObject({ w: 40, h: 20 });
  });

  it("samples a cell into metrics, or records why it did not build", async () => {
    const s = await twoParamSession();
    const spec: GridSpec = { x: axisOf(s.doc.parameters[0]), y: axisOf(s.doc.parameters[1]), n: 5 };
    const c = await sampleCell(boxBackend(), s.doc, spec, 2, 2);
    expect([c.x, c.y]).toEqual([30, 15]);
    expect(c.metrics!.volume).toBe(4500);
    expect([c.metrics!.width, c.metrics!.depth, c.metrics!.height]).toEqual([30, 15, 10]);
    const bad = await sampleCell(boxBackend(), s.doc, spec, 4, 4); // 50 × 25 > 1000 → throws
    expect(bad.metrics).toBeNull();
    expect(bad.error).toBe("too big to build");
  });

  it("samples the grid coarse-to-fine, reports progress, skips cached cells and can be cancelled", async () => {
    const s = await twoParamSession();
    const spec: GridSpec = { x: axisOf(s.doc.parameters[0]), y: axisOf(s.doc.parameters[1]), n: 5 };
    const seen: string[] = [];
    const onCell = vi.fn();
    const all = await sampleGrid(boxBackend((d) => seen.push(d.parameters.map((p) => p.expr).join("/"))), s.doc, spec, { onCell });
    expect(all!.length).toBe(25);
    expect(seen[0]).toBe("30/15/2"); // the centre first
    expect(onCell).toHaveBeenCalledTimes(25);
    expect(onCell.mock.calls[24][1]).toBe(25);
    expect(onCell.mock.calls[24][2]).toBe(25);

    const skipped = await sampleGrid(boxBackend(), s.doc, spec, { skip: (i, j) => i === 2 && j === 2, onCell });
    expect(skipped!.length).toBe(24);

    let count = 0;
    const partial = await sampleGrid(boxBackend(), s.doc, spec, { cancelled: () => count > 2, onCell: () => count++ });
    expect(partial).toBeNull();
    expect(count).toBe(3);
  });

  it("GridCache keeps the most recent grids and refreshes on read", () => {
    const c = new GridCache(2);
    c.open("a").set(0, { i: 0, j: 0, x: 0, y: 0, metrics: null });
    c.open("b");
    c.get("a");
    c.open("c"); // evicts b, the least recently used
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")!.size).toBe(1);
    c.clear();
    expect(c.get("a")).toBeUndefined();
  });
});

describe("design space: the compared pin as a ghost", () => {
  const pinAt = (x: number, y: number, xName = "w", yName = "h", letter: Pin["letter"] = "A"): Pin => ({ letter, x, y, xName, yName, metrics: null, verdict: "unknown" });

  it("builds the pin's variant from the pin's own parameters, whatever the map shows, and knows when they are gone", async () => {
    const s = await twoParamSession();
    const v = variantDocForPin(s.doc, pinAt(20, 40, "h", "w"));
    expect(v).not.toBe(s.doc);
    expect(resolveParameters(v.parameters).scope).toMatchObject({ w: 40, h: 20, free: 2 });
    expect(s.doc.parameters.map((p) => p.expr)).toEqual(["30", "15", "2"]); // the document itself is untouched
    expect(pinApplies(s.doc, pinAt(1, 2))).toBe(true);
    expect(pinApplies(s.doc, pinAt(1, 2, "w", "gone"))).toBe(false);
    expect(pinApplies(createDocument(), pinAt(1, 2))).toBe(false);
  });

  it("keys a ghost by the pin and the recipe with the pin's parameters blanked: a drag keeps it, another edit or another pin does not", async () => {
    const s = await twoParamSession();
    const key = () => ghostKey(pinAt(20, 5), s.timeline, s.rollbackIndex, s.doc.activeConfiguration);
    const k1 = key();
    const w = s.timeline.find((o) => o.params.name === "w")!;
    await s.editOperation(w.opId, { ...w.params, expression: "45" }); // the design moves along an axis
    expect(key()).toBe(k1);
    const free = s.timeline.find((o) => o.params.name === "free")!;
    await s.editOperation(free.opId, { ...free.params, expression: "3" }); // the recipe changes
    const k2 = key();
    expect(k2).not.toBe(k1);
    expect(ghostKey(pinAt(25, 5), s.timeline, s.rollbackIndex, undefined)).not.toBe(k2);
    expect(ghostKey(pinAt(5, 20, "h", "w"), s.timeline, s.rollbackIndex, undefined)).not.toBe(k2);
    expect(ghostKey(pinAt(20, 5), s.timeline, s.rollbackIndex, "cfg")).not.toBe(k2);
  });

  it("evaluates the variant into its built bodies, or says why there are none", async () => {
    const s = await twoParamSession();
    const seen: string[] = [];
    const ok = await evaluateVariant(boxBackend((d) => seen.push(d.parameters.map((p) => p.expr).join("/"))), s.doc, pinAt(20, 5));
    expect(seen).toEqual(["20/5/2"]);
    expect(ok.status).toBe("shown");
    expect(ok.solids.map((b) => b.volume)).toEqual([1000]);
    const bad = await evaluateVariant(boxBackend(), s.doc, pinAt(50, 25));
    expect(bad).toEqual({ solids: [], status: "error", error: "too big to build" });
    const none = await evaluateVariant({ ...boxBackend(), evaluate: async () => ({ solids: {}, facePlanes: {} }) }, s.doc, pinAt(20, 5));
    expect(none).toEqual({ solids: [], status: "empty" });
    const unbuilt = await evaluateVariant({ ...boxBackend(), evaluate: async () => ({ solids: { b: { featureId: "b", name: "b", sketchId: "", distance: 0, error: "open profile" } }, facePlanes: {} }) }, s.doc, pinAt(20, 5));
    expect(unbuilt).toEqual({ solids: [], status: "error", error: "open profile" });
  });

  it("labels the ghost at the axes' precision and words its status honestly", () => {
    expect(ghostLabel(pinAt(20, 5))).toBe("Pin A: w 20 · h 5");
    expect(ghostLabel(pinAt(20, 5.25, "w", "h", "B"), { x: { name: "w", min: 10, max: 50, step: 5 }, y: { name: "h", min: 5, max: 25 } })).toBe("Pin B: w 20 · h 5.3");
    expect(ghostLabel(pinAt(20, 5.25, "h", "w"), { x: { name: "w", min: 10, max: 50, step: 5 } })).toBe("Pin A: h 20 · w 5.25"); // axes that are not the pin's are ignored
    expect(ghostStatusText("evaluating")).toBe("ghost: building…");
    expect(ghostStatusText("shown")).toBe("shown as a ghost on the part");
    expect(ghostStatusText("empty")).toBe("ghost: no bodies");
    expect(ghostStatusText("error", "too big")).toBe("ghost: did not build (too big)");
    expect(ghostStatusText("error")).toBe("ghost: did not build");
    expect(ghostStatusText(null)).toBe("");
  });

  it("GhostCache keeps the most recent variants and refreshes on read", () => {
    const c = new GhostCache(2);
    c.set("a", { solids: [], status: "empty" });
    c.set("b", { solids: [], status: "empty" });
    c.get("a");
    c.set("c", { solids: [], status: "empty" }); // evicts b
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBeTruthy();
    c.set("a", { solids: [], status: "error", error: "x" }); // overwrite keeps one entry
    expect(c.get("a")!.status).toBe("error");
    c.clear();
    expect(c.get("a")).toBeUndefined();
  });

  it("useGhost holds the variant, maps it to ghost + variant solid views for its own document only, and forgets it when the document changes", () => {
    const mesh = { positions: new Float32Array([0, 0, 0]), normals: new Float32Array([0, 0, 1]), indices: new Uint32Array([0]), edges: new Float32Array([0, 0, 0, 1, 1, 1]), triangleCount: 0 };
    const body: SolidEval = { featureId: "b", name: "b", sketchId: "", distance: 0, mesh: mesh as never, volume: 1 };
    const unbuilt: SolidEval = { featureId: "c", name: "c", sketchId: "", distance: 0, error: "nope" };
    useGhost.getState().clear();
    expect(ghostSolidViews(useGhost.getState(), "d1")).toEqual([]);
    useGhost.getState().set([body, unbuilt], "Pin A: w 20 · h 5", "d1");
    expect(useGhost.getState()).toMatchObject({ label: "Pin A: w 20 · h 5", docId: "d1" });
    const views = ghostSolidViews(useGhost.getState(), "d1");
    expect(views.length).toBe(1); // only bodies with a mesh
    expect(views[0]).toEqual({ positions: mesh.positions, normals: mesh.normals, indices: mesh.indices, edges: mesh.edges, ghost: true, variant: true });
    expect(views[0].id).toBeUndefined(); // never picked, never confused with the real body
    expect(ghostSolidViews(useGhost.getState(), "other")).toEqual([]); // another document's view never draws it
    expect(ghostSolidViews(useGhost.getState(), "d1", () => false)).toEqual([]); // hidden bodies stay hidden
    // clear() only notifies when there was something to clear
    let notified = 0;
    const unsub = useGhost.subscribe(() => notified++);
    useGhost.getState().clear();
    useGhost.getState().clear();
    expect(notified).toBe(1);
    expect(useGhost.getState()).toMatchObject({ solids: null, label: null, docId: null });
    unsub();
    // a new document (a new session) in the store clears the ghost; a revision of the same one does not.
    // Every fresh document is "doc1" (createDocument's default), so the id alone could not tell them apart.
    const s1 = realSession();
    useStore.setState({ session: s1 });
    useGhost.getState().set([body], "Pin A", s1.doc.id);
    useStore.setState({ rev: useStore.getState().rev + 1 });
    useStore.setState({ session: s1 }); // the same session set again is not a switch
    expect(useGhost.getState().solids).not.toBeNull();
    const s2 = realSession();
    expect(s2.doc.id).toBe(s1.doc.id);
    useStore.setState({ session: s2 });
    expect(useGhost.getState().solids).toBeNull();
  });
});
