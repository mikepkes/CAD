import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDocument, type Parameter } from "../src/core/document";
import { realSession } from "./helpers";
import { useStore } from "../src/model/store";
import { checkIntents, intentScope, metricsOf, parseIntent, type Metrics } from "../src/model/concepts/intents";
import {
  densityOf, formatDelta, formatMass, formatNow, intentDeps, intentGlyph, massGrams, mergeSegments, paramToken, plainNumber,
  rhsStep, rowClasses, suggestFixes, suggestionText, tidy, uncheckedResult, unitLabel, useIntents, useSuggestions, visibleSuggestions,
  candidateValues, findMetricFixes, metricDeps, metricFailures, needsMetricSearch, metricNote, allPass, variantScope, VariantCache, fixSearchText, mergeSuggestions,
  type Suggestion,
} from "../src/ui/concepts/ledger/ledger";
import { evaluateVariant, overrideDoc } from "../src/ui/concepts/space/sampler";
import type { GeometryBackend } from "../src/core/geometry/backend";

const T = (text: string) => ({ text });

describe("ledger: sentence helpers", () => {
  it("merges adjacent text segments, drops empty ones and keeps refs and params apart", () => {
    const segs = mergeSegments([T("Extrude "), { ref: "s1", text: "Sketch 1" }, T(" by "), T(""), { param: "distance" }, T(" each way"), T(" cut"), T(".")]);
    expect(segs).toEqual([T("Extrude "), { ref: "s1", text: "Sketch 1" }, T(" by "), { param: "distance" }, T(" each way cut.")]);
    expect(mergeSegments([T(""), T("")])).toEqual([]);
  });

  it("labels units for prose", () => {
    expect(unitLabel("mm")).toBe("mm");
    expect(unitLabel("deg")).toBe("°");
    expect(unitLabel("")).toBe("");
  });

  it("renders a param as a live number only when the spec knows it and it evaluates", () => {
    const row = { spec: { params: [{ key: "d", label: "D", unit: "mm", step: 0.5 }] }, values: { d: 24, bad: NaN }, exprs: { d: "h*2", bad: "nope" } } as never;
    expect(paramToken(row, "d")).toMatchObject({ kind: "live", value: 24 });
    expect(paramToken(row, "bad")).toEqual({ kind: "text", text: "nope" });
    expect(paramToken(row, "missing")).toEqual({ kind: "text", text: "?" });
  });

  it("gives a paragraph its state classes", () => {
    expect(rowClasses({ rolledBack: false, suppressed: false }, false)).toBe("ledger-row");
    expect(rowClasses({ rolledBack: true, suppressed: true, error: "boom" }, true).split(" ")).toEqual(["ledger-row", "ghost", "off", "err", "k-hot"]);
  });
});

describe("ledger: mass estimate", () => {
  it("uses a density-like field when the material has one, else a guess from its kind, else aluminium (and says which)", () => {
    expect(densityOf(undefined)).toEqual({ density: 2.7, source: "no material: aluminium 2.7 g/cm³ assumed" });
    expect(densityOf({ id: "m", name: "Oak", kind: "wood" })).toEqual({ density: 0.7, source: "Oak (wood, 0.7 g/cm³ assumed)" });
    expect(densityOf({ id: "m", name: "x", kind: "metal", density: 7.85 } as never).density).toBe(7.85);
    expect(densityOf({ id: "m", name: "x", kind: "metal", density: 7.85 } as never).source).not.toMatch(/assumed/);
    expect(densityOf({ id: "m", name: "x", kind: "plastic", mechanical: { E: 1, allowableStrain: 0.1, density: 1.2 } } as never).density).toBe(1.2);
  });
  it("turns mm³ into grams and formats a signed delta", () => {
    expect(massGrams(19200, 2.7)).toBeCloseTo(51.84, 6);
    expect(massGrams(undefined, 2.7)).toBeNull();
    expect(massGrams(NaN, 2.7)).toBeNull();
    expect(formatMass(51.84)).toBe("+51.8 g");
    expect(formatMass(0.1234)).toBe("+0.12 g");
    expect(formatMass(1234.5)).toBe("+1,235 g");
    expect(formatMass(-3)).toBe("−3.00 g");
  });
});

describe("ledger: intents display", () => {
  it("recognises a plain-number rhs and picks its step", () => {
    expect(plainNumber("120")).toBe(120);
    expect(plainNumber(" 0.5 ")).toBe(0.5);
    expect(plainNumber("-2e3")).toBe(-2000);
    expect(plainNumber("t_min*2")).toBeNull();
    expect(plainNumber("")).toBeNull();
    expect(rhsStep(4.2)).toBe(0.1);
    expect(rhsStep(10)).toBe(1);
    expect(rhsStep(-120)).toBe(1);
  });
  it("formats the readout and the glyph", () => {
    expect(formatNow(108.4)).toBe("108");
    expect(formatNow(12.34)).toBe("12.3");
    expect(formatNow(3.14159)).toBe("3.14");
    expect(formatNow(3)).toBe("3");
    expect(formatNow(NaN)).toBe("—");
    const i = parseIntent("mass <= 120", "a")!;
    expect(intentGlyph({ intent: i, ok: true, lhs: 1, rhs: 2 })).toEqual({ glyph: "✓", label: "passes", state: "ok" });
    expect(intentGlyph({ intent: i, ok: false, lhs: 3, rhs: 2 })).toEqual({ glyph: "✗", label: "fails", state: "bad" });
    expect(intentGlyph({ intent: i, ok: false, lhs: NaN, rhs: NaN, error: "unknown name" }).label).toMatch(/cannot evaluate/);
    expect(uncheckedResult(i)).toMatchObject({ intent: i, ok: false, error: "not checked" });
  });
});

describe("ledger: intents store", () => {
  beforeEach(() => {
    useIntents.setState({ docId: null, intents: [], results: [], scope: {} });
  });

  it("reads the open document's intents, adds parsed ones through intent.add, evaluates, updates and removes", async () => {
    const session = realSession();
    await session.dispatch("parameter.add", { name: "wall", expression: "3" });
    useStore.setState({ session, rev: useStore.getState().rev + 1, solids: {} });
    const s = useIntents.getState();
    expect(useIntents.getState().docId).toBe(session.doc.id);
    expect(useIntents.getState().intents).toEqual([]);
    expect(s.add("just words")).toBeNull(); // not a comparison: nothing dispatched
    expect(session.doc.operations.length).toBe(1);
    const i = (await s.add("wall >= 4", "Wall"))!;
    expect(i).toMatchObject({ label: "Wall", lhs: "wall", op: ">=", rhs: "4" });
    expect(session.doc.intents).toEqual([i]); // the document holds it, via the intent.add operation
    expect(session.doc.operations.at(-1)).toMatchObject({ type: "intent.add", params: { label: "Wall", lhs: "wall", op: ">=", rhs: "4" }, createdIds: [i.id] });
    expect((await s.add("mass <= 120", "  "))!.label).toBe("mass");
    expect(useIntents.getState().intents.map((x) => x.lhs)).toEqual(["wall", "mass"]);
    expect(useIntents.getState().results.map((r) => r.ok)).toEqual([false, true]); // wall 3 < 4; mass 0 with nothing built
    const results = s.evaluate({ wall: 3, mass: 100 });
    expect(results.map((r) => r.ok)).toEqual([false, true]);
    expect(useIntents.getState().results).toBe(results);
    const upd = s.update(i.id, { rhs: "3" });
    expect(useIntents.getState().results[0].ok).toBe(true); // shown at once, re-checked in the last scope
    await upd;
    expect(session.doc.intents[0].rhs).toBe("3");
    expect(session.doc.operations.at(-1)).toMatchObject({ type: "intent.update", params: { id: i.id, rhs: "3" } });
    await s.remove(i.id);
    expect(session.doc.intents.map((x) => x.lhs)).toEqual(["mass"]);
    expect(useIntents.getState().intents.map((x) => x.lhs)).toEqual(["mass"]);
    s.load(session.doc.id); // the open doc: re-read, nothing changes
    expect(useIntents.getState().intents.length).toBe(1);
    s.load("docB"); // another document: its intents are unknown until it opens
    expect(useIntents.getState().intents).toEqual([]);
  });

  it("gives each intent a distinct id and runs queued writes in order", async () => {
    const session = realSession();
    useStore.setState({ session, rev: useStore.getState().rev + 1, solids: {} });
    const s = useIntents.getState();
    const [a, b] = await Promise.all([s.add("a < 1"), s.add("b < 1")]); // concurrent: neither drops the other
    expect(a!.id).not.toBe(b!.id);
    expect(session.doc.intents.map((x) => x.lhs)).toEqual(["a", "b"]);
    expect(useIntents.getState().intents.length).toBe(2);
  });
});

describe("ledger: suggestions", () => {
  const doc = createDocument();
  doc.parameters.push({ id: "p1", name: "wall", expr: "3", value: 3 } as never, { id: "p2", name: "t_min", expr: "2", value: 2 } as never);
  const scope = intentScope(doc, metricsOf({ a: { featureId: "a", name: "a", mesh: {} as never, volume: 40000 } as never }));
  const names = doc.parameters.map((p) => p.name);

  it("finds the smallest parameter move that makes a failing intent pass", () => {
    const results = checkIntents([parseIntent("wall >= 4", "i1", "Wall")!, parseIntent("wall*2 == 6", "i2")!], scope);
    const s = suggestFixes(results, scope, names);
    expect(s.length).toBe(1);
    expect(s[0]).toMatchObject({ intentId: "i1", label: "Wall", param: "wall", from: 3, to: 4.05, confirm: false });
    expect(s[0].delta).toBeCloseTo(1.05, 6);
    expect(suggestionText(s[0])).toBe("Set wall to 4.05 (+1.05)");
  });

  it("tries both sides and proposes the smaller change", () => {
    const results = checkIntents([parseIntent("wall <= 2.9", "i1")!], scope);
    const s = suggestFixes(results, scope, names);
    expect(s[0]).toMatchObject({ param: "wall", to: 2.85 });
    expect(formatDelta(s[0].delta)).toBe("−0.15");
  });

  it("considers every parameter either side depends on, and skips ones out of reach", () => {
    const results = checkIntents([parseIntent("wall >= t_min*2", "i1")!], scope);
    const s = suggestFixes(results, scope, names);
    expect(s.map((x) => x.param).sort()).toEqual(["t_min", "wall"]);
    expect(s.find((x) => x.param === "wall")!.to).toBeCloseTo(4.05, 6);
    expect(s.find((x) => x.param === "t_min")!.to).toBeCloseTo(1.5, 6);
    const far = suggestFixes(checkIntents([parseIntent("wall >= 100", "i2")!], scope), scope, names);
    expect(far).toEqual([]);
  });

  it("flags metric-based intents as needing a rebuild and gives metric-only ones nothing", () => {
    const results = checkIntents([parseIntent("mass / wall <= 30", "i1", "Mass per wall")!, parseIntent("mass <= 50", "i2", "Mass")!], scope);
    expect(results.map((r) => r.ok)).toEqual([false, false]); // mass is 108 g
    const s = suggestFixes(results, scope, names);
    expect(s.length).toBe(1);
    expect(s[0]).toMatchObject({ intentId: "i1", param: "wall", confirm: true });
    expect(s[0].to).toBeGreaterThanOrEqual(3.6);
  });

  it("skips intents that pass or cannot be evaluated, and parameters at zero still move", () => {
    const d2 = createDocument();
    d2.parameters.push({ id: "p", name: "off", expr: "0", value: 0 } as never);
    const sc = intentScope(d2, metricsOf({}));
    const results = checkIntents([parseIntent("off > 0.2", "i1")!, parseIntent("nope > 1", "i2")!, parseIntent("off >= 0", "i3")!], sc);
    const s = suggestFixes(results, sc, ["off"]);
    expect(s.length).toBe(1);
    expect(s[0].to).toBeCloseTo(0.25, 6);
    expect(intentDeps(parseIntent("a + c*2 < 1", "x")!)).toEqual(["a", "c"]);
    expect(intentDeps({ id: "x", label: "x", lhs: "(", op: "<", rhs: "1" })).toEqual([]);
    expect(tidy(0.1 + 0.2)).toBe(0.3);
  });

  it("hides dismissed and accepted suggestions and keeps accepted ones for undo", () => {
    useSuggestions.setState({ dismissed: {}, accepted: {} });
    const a = { id: "a", intentId: "i", label: "L", param: "wall", from: 3, to: 4, delta: 1, confirm: false };
    const b = { ...a, id: "b" }, c = { ...a, id: "c" };
    const st = useSuggestions.getState();
    st.dismiss("a");
    st.accept(b, "3");
    expect(visibleSuggestions([a, b, c], useSuggestions.getState()).map((s) => s.id)).toEqual(["c"]);
    expect(useSuggestions.getState().accepted.b).toEqual({ suggestion: b, prevExpr: "3" });
    st.forget("b");
    expect(useSuggestions.getState().accepted.b).toBeUndefined();
    expect(visibleSuggestions([a, b, c], useSuggestions.getState()).map((s) => s.id)).toEqual(["b", "c"]);
  });
});

describe("ledger: sampled fixes for metric intents", () => {
  // A box model: one w × h × 10 body, so mass = w·h·10 / 1000 · 2.7 g (w = 30, h = 15 → 12.15 g).
  const box = (w: number, h: number): Metrics =>
    metricsOf({ b: { featureId: "b", name: "b", sketchId: "", distance: 0, mesh: {}, volume: w * h * 10, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: w, y: h, z: 10 } } } as never }, 2.7);
  const P = (name: string, expr: string, extra: Record<string, unknown> = {}): Parameter => ({ id: name, name, expr, value: Number(expr), ...extra }) as Parameter;
  const params = [P("w", "30", { min: 10, max: 50, step: 5 }), P("h", "15", { min: 5, max: 25 }), P("free", "2"), P("d", "w*2", { value: 60 })];
  const doc = createDocument();
  doc.parameters.push(...params);
  const scope = intentScope(doc, box(30, 15));
  const intentsOf = (...texts: string[]) => texts.map((t, i) => parseIntent(t, `i${i}`, t.split(" ")[0])!);
  /** The stub evaluate: the box with the overrides applied, recording every call. */
  const stub = (calls: Record<string, number>[] = [], opts: { fail?: (o: Record<string, number>) => boolean } = {}) =>
    vi.fn(async (o: Record<string, number>) => { calls.push(o); return opts.fail?.(o) ? null : box(o.w ?? 30, o.h ?? 15); });

  it("tells metric intents from parameter ones and decides when a search is worth running", () => {
    expect(metricDeps(parseIntent("mass <= 10", "a")!)).toEqual(["mass"]);
    expect(metricDeps(parseIntent("mass / h <= 2", "a")!)).toEqual(["mass"]);
    expect(metricDeps(parseIntent("height + width <= 2*depth", "a")!).sort()).toEqual(["depth", "height", "width"]);
    expect(metricDeps(parseIntent("w >= 10", "a")!)).toEqual([]);
    const results = checkIntents(intentsOf("mass <= 10", "w >= 40", "mass <= 100", "nope < 1"), scope);
    expect(metricFailures(results).map((r) => r.intent.id)).toEqual(["i0"]); // not the parameter one, the passing one or the unevaluable one
    expect(needsMetricSearch(results, 1, params)).toBe(true);
    expect(needsMetricSearch(results, 0, params)).toBe(false); // nothing built: every metric is 0
    expect(needsMetricSearch(results, 1, [P("free", "2")])).toBe(false); // nothing bounded to move
    expect(needsMetricSearch(checkIntents(intentsOf("mass <= 100"), scope), 1, params)).toBe(false); // nothing fails
  });

  it("spaces candidate values evenly to each bound, on the step, nearest first, never the current value", () => {
    expect(candidateValues(params[0])).toEqual({ up: [35, 40, 45, 50], down: [25, 20, 15, 10] });
    const h = candidateValues(params[1]);
    expect(h.up).toEqual([16.6667, 18.3333, 20, 21.6667, 23.3333, 25]);
    expect(h.down).toEqual([13.3333, 11.6667, 10, 8.3333, 6.6667, 5]);
    expect(candidateValues(params[1], 2)).toEqual({ up: [20, 25], down: [10, 5] });
    expect(candidateValues({ value: 25, min: 5, max: 25 })).toEqual({ up: [], down: [21.6667, 18.3333, 15, 11.6667, 8.3333, 5] });
    expect(candidateValues({ value: 5, min: 5, max: 25 }).down).toEqual([]);
  });

  it("re-resolves derived parameters in a variant's scope and reads the variant's metrics", () => {
    const sc = variantScope(params, scope, { w: 20 }, box(20, 15));
    expect(sc).toMatchObject({ w: 20, d: 40, h: 15, free: 2, width: 20 });
    expect(sc.mass).toBeCloseTo(8.1, 6);
    expect(allPass(intentsOf("mass <= 10", "d >= 30", "nope < 1"), sc)).toBe(true); // an unevaluable intent is not held against it
    expect(allPass(intentsOf("mass <= 10", "d >= 50"), sc)).toBe(false);
  });

  it("finds the smallest built change for each bounded parameter, smallest first, labelled with the sampled metric", async () => {
    const intents = intentsOf("mass <= 10");
    const results = checkIntents(intents, scope);
    const calls: Record<string, number>[] = [];
    const fixes = (await findMetricFixes(intents, results, scope, params, stub(calls)))!;
    expect(fixes.map((f) => [f.param, f.to])).toEqual([["h", 11.6667], ["w", 20]]); // h moves 1/6 of its range, w 1/4
    expect(fixes[0]).toMatchObject({ intentId: "i0", label: "mass", from: 15, confirm: false, note: "mass 9.45 g" });
    expect(fixes[0].delta).toBeCloseTo(-3.3333, 4);
    expect(suggestionText(fixes[0])).toBe("Set h to 11.7 (mass 9.45 g)");
    expect(suggestionText(fixes[1])).toBe("Set w to 20 (mass 8.10 g)");
    expect(fixes[0].id).not.toBe(fixes[1].id);
    // each side's bound is probed first; a side whose bound does not help is skipped, then nearest first until one passes
    expect(calls).toEqual([{ w: 50 }, { w: 10 }, { w: 25 }, { w: 20 }, { h: 25 }, { h: 5 }, { h: 13.3333 }, { h: 11.6667 }]);
    expect(calls.some((c) => "free" in c || "d" in c)).toBe(false); // only bounded parameters move
  });

  it("requires every intent to pass, derived parameters included, and labels every metric the failing intents read", async () => {
    // w >= 25 rules out w = 20 (the only w candidate under the mass limit), so only h can move
    let intents = intentsOf("mass <= 10", "w >= 25");
    let fixes = (await findMetricFixes(intents, checkIntents(intents, scope), scope, params, stub()))!;
    expect(fixes.map((f) => f.param)).toEqual(["h"]);
    // d = w*2 must stay ≥ 50: w = 20 gives d = 40, so again only h
    intents = intentsOf("mass <= 10", "d >= 50");
    fixes = (await findMetricFixes(intents, checkIntents(intents, scope), scope, params, stub()))!;
    expect(fixes.map((f) => f.param)).toEqual(["h"]);
    // two failing metric intents: one card, both labels, both metrics in the note
    intents = intentsOf("mass <= 10", "width <= 25");
    fixes = (await findMetricFixes(intents, checkIntents(intents, scope), scope, params, stub()))!;
    expect(fixes.map((f) => f.param)).toEqual(["w"]); // h alone cannot narrow the width
    expect(fixes[0]).toMatchObject({ to: 20, label: "mass, width", note: "mass 8.10 g · width 20.0 mm" });
  });

  it("skips variants that cannot be built, stops when cancelled, and has nothing to do without failures or bounds", async () => {
    const intents = intentsOf("mass <= 10");
    const results = checkIntents(intents, scope);
    // h cannot be built below 10: the bound probe (5) fails to build, so the h side is skipped
    const fixes = (await findMetricFixes(intents, results, scope, params, stub([], { fail: (o) => o.h != null && o.h < 10 })))!;
    expect(fixes.map((f) => f.param)).toEqual(["w"]);
    let n = 0;
    expect(await findMetricFixes(intents, results, scope, params, stub(), { cancelled: () => ++n > 2 })).toBeNull();
    expect(n).toBe(3);
    const idle = stub();
    expect(await findMetricFixes(intents, checkIntents(intents, { ...scope, mass: 1 }), scope, params, idle)).toEqual([]);
    expect(await findMetricFixes(intents, results, scope, [P("free", "2")], idle)).toEqual([]);
    expect(idle).not.toHaveBeenCalled();
    expect(metricNote(box(30, 15), ["mass", "volume", "height", "bodies", "nope"])).toBe("mass 12.2 g · volume 4,500 mm³ · height 10.0 mm · bodies 1");
  });

  it("remembers built variants per document revision", async () => {
    const cache = new VariantCache();
    const ev = stub();
    const a = cache.get("doc:1", { w: 20 }, ev);
    expect(cache.get("doc:1", { w: 20 }, ev)).toBe(a);
    await cache.get("doc:1", { h: 10 }, ev);
    expect(ev).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(2);
    expect((await a)!.mass).toBeCloseTo(8.1, 6);
    await cache.get("doc:2", { w: 20 }, ev); // a new revision: the geometry changed, so rebuild
    expect(ev).toHaveBeenCalledTimes(3);
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("words the search state and lets built fixes replace the unconfirmed guesses", () => {
    expect(fixSearchText("idle", 0, null)).toBe("");
    expect(fixSearchText("searching", 0, null)).toBe("Looking for a fix…");
    expect(fixSearchText("done", 0, null)).toMatch(/No change to a bounded parameter/);
    expect(fixSearchText("done", 2, null)).toBe("");
    expect(fixSearchText("error", 0, "no wasm")).toBe("Could not look for a fix: no wasm");
    const guess: Suggestion = { id: "g", intentId: "i", label: "L", param: "h", from: 15, to: 12, delta: -3, confirm: true };
    const sure: Suggestion = { ...guess, id: "s", confirm: false };
    const built: Suggestion = { ...guess, id: "b", confirm: false, note: "mass 9.45 g" };
    expect(mergeSuggestions([guess, sure], [], "idle").map((s) => s.id)).toEqual(["g", "s"]);
    expect(mergeSuggestions([guess, sure], [], "searching").map((s) => s.id)).toEqual(["s"]);
    expect(mergeSuggestions([guess, sure], [built], "done").map((s) => s.id)).toEqual(["s", "b"]);
    expect(mergeSuggestions([guess, sure], [], "done").map((s) => s.id)).toEqual(["g", "s"]); // nothing built: the guess is all there is
    expect(mergeSuggestions([guess], [], "error").map((s) => s.id)).toEqual(["g"]);
  });

  it("builds a rebuilt clone with the overrides as plain values and measures it, leaving the live document alone", async () => {
    // a real recipe: the override must edit the parameter.add op and rebuild, not just the derived parameter row
    const sess = realSession();
    await sess.dispatch("parameter.add", { name: "w", expression: "15*2", min: 10, max: 50 });
    await sess.dispatch("parameter.add", { name: "h", expression: "15", min: 5, max: 25 });
    const live = sess.doc;
    const v = await overrideDoc(live, { w: 20 });
    expect(v).not.toBe(live);
    expect(v.parameters[0]).toMatchObject({ name: "w", expr: "20", value: 20 });
    expect(v.operations.find((o) => o.type === "parameter.add" && o.params.name === "w")?.params.expression).toBe("20");
    expect(v.parameters[1]).toMatchObject({ name: "h", expr: "15", value: 15 });
    expect(live.parameters[0]).toMatchObject({ expr: "15*2", value: 30 });
    expect(live.operations.find((o) => o.type === "parameter.add" && o.params.name === "w")?.params.expression).toBe("15*2");
    const seen: string[] = [];
    const backend = {
      evaluate: async (d: typeof live) => {
        seen.push(d.parameters.map((p) => p.expr).join("/"));
        const w = Number(d.parameters[0].expr), h = Number(d.parameters[1].expr);
        if (w * h > 1000) throw new Error("too big");
        if (w * h === 0) return { solids: {}, facePlanes: {} };
        return { solids: { b: { featureId: "b", name: "b", sketchId: "", distance: 0, mesh: {}, volume: w * h * 10 } }, facePlanes: {} };
      },
    } as unknown as GeometryBackend;
    const m = await evaluateVariant(backend, live, { w: 20, h: 10 }, 1.2);
    expect(m).toMatchObject({ bodies: 1, volume: 2000, density: 1.2 });
    expect(m!.mass).toBeCloseTo(2.4, 6);
    expect(seen).toEqual(["20/10"]);
    expect((await evaluateVariant(backend, live, { w: 20 }))!.density).toBe(2.7); // the default density
    expect(await evaluateVariant(backend, live, { w: 50, h: 25 })).toBeNull(); // the kernel threw
    expect(await evaluateVariant(backend, live, { w: 0 })).toBeNull(); // nothing built
    expect(live.parameters[0].expr).toBe("15*2");
  });
});
