import { describe, it, expect, beforeEach } from "vitest";
import { createDocument } from "../src/core/document";
import { realSession } from "./helpers";
import { useStore } from "../src/model/store";
import { checkIntents, intentScope, metricsOf, parseIntent } from "../src/model/concepts/intents";
import {
  densityOf, formatDelta, formatMass, formatNow, intentDeps, intentGlyph, massGrams, mergeSegments, paramToken, plainNumber,
  rhsStep, rowClasses, suggestFixes, suggestionText, tidy, uncheckedResult, unitLabel, useIntents, useSuggestions, visibleSuggestions,
} from "../src/ui/concepts/ledger/ledger";

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
