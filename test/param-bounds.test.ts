import { describe, it, expect } from "vitest";
import { realSession } from "./helpers";
import { resolveParameters } from "../src/model/parameters";
import type { Parameter } from "../src/core/document";

// Named parameters may carry optional extents (min/max) OR a list of acceptable
// values (enum) — never both, default unbounded.
describe("parameter extents / enum", () => {
  it("stores extents on parameter.add", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "width", expression: "60", min: 20, max: 120 });
    const p = s.doc.parameters.find((x) => x.name === "width")!;
    expect(p.min).toBe(20);
    expect(p.max).toBe(120);
    expect(p.values).toBeUndefined();
  });

  it("stores and de-duplicates a value list", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "thread", expression: "3", values: [6, 3, 4, 3, 5] });
    const p = s.doc.parameters.find((x) => x.name === "thread")!;
    expect(p.values).toEqual([3, 4, 5, 6]);
    expect(p.min).toBeUndefined();
  });

  it("rejects extents and a value list together", async () => {
    const s = realSession();
    const r = await s.dispatch("parameter.add", { name: "bad", expression: "3", min: 1, values: [1, 2] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/extents or a value list/i);
  });

  it("rejects min greater than max", async () => {
    const s = realSession();
    const r = await s.dispatch("parameter.add", { name: "bad", expression: "3", min: 10, max: 2 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/min.*max/i);
  });

  it("parameter.setBounds edits and clears extents", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "w", expression: "5" });
    await s.dispatch("parameter.setBounds", { name: "w", min: 0, max: 10 });
    expect(s.doc.parameters[0].max).toBe(10);
    await s.dispatch("parameter.setBounds", { name: "w", values: [1, 2, 3] });
    expect(s.doc.parameters[0].values).toEqual([1, 2, 3]);
    expect(s.doc.parameters[0].max).toBeUndefined(); // switching clears the old kind
    await s.dispatch("parameter.setBounds", { name: "w", clear: true });
    expect(s.doc.parameters[0].values).toBeUndefined();
    expect(s.doc.parameters[0].min).toBeUndefined();
  });

  it("stores a step increment and drops it when switched to an enum", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "stages", expression: "3", min: 1, max: 8, step: 1 });
    expect(s.doc.parameters[0].step).toBe(1);
    await s.dispatch("parameter.setBounds", { name: "stages", values: [2, 4, 6] });
    expect(s.doc.parameters[0].step).toBeUndefined(); // step is meaningless with an enum
  });

  it("warns when a value is off the step increment (anchored at min)", () => {
    const params: Parameter[] = [
      { id: "p1", name: "a", expr: "2.5", value: 0, min: 1, max: 8, step: 1 },
      { id: "p2", name: "b", expr: "4", value: 0, min: 1, max: 8, step: 1 },
      { id: "p3", name: "c", expr: "1.5", value: 0, min: 0, max: 5, step: 0.5 },
    ];
    const { resolved } = resolveParameters(params);
    const by = (n: string) => resolved.find((p) => p.name === n)!;
    expect(by("a").warning).toMatch(/not a multiple/i);
    expect(by("b").warning).toBeUndefined(); // 4 = 1 + 3×1
    expect(by("c").warning).toBeUndefined(); // 1.5 = 0 + 3×0.5
  });

  it("warns (but does not error) when a value is out of range or off the list", () => {
    const params: Parameter[] = [
      { id: "p1", name: "a", expr: "150", value: 0, min: 20, max: 120 },
      { id: "p2", name: "b", expr: "60", value: 0, min: 20, max: 120 },
      { id: "p3", name: "c", expr: "7", value: 0, values: [3, 4, 5, 6] },
      { id: "p4", name: "d", expr: "5", value: 0, values: [3, 4, 5, 6] },
    ];
    const { resolved } = resolveParameters(params);
    const by = (n: string) => resolved.find((p) => p.name === n)!;
    expect(by("a").value).toBe(150); // still resolves
    expect(by("a").warning).toMatch(/above max/i);
    expect(by("b").warning).toBeUndefined();
    expect(by("c").warning).toMatch(/not one of/i);
    expect(by("d").warning).toBeUndefined();
  });
});
