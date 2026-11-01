// Typed values: what doesn't read, or names no parameter, is refused with a sentence; "name = expr" makes the parameter.
import { describe, it, expect } from "vitest";
import { expressionProblem, parameterAssignment } from "../src/core/expressionCheck";
import { realSession } from "./helpers";

describe("expressionProblem", () => {
  it("accepts numbers and known names; refuses the rest, saying why", () => {
    expect(expressionProblem("80", [])).toBeNull();
    expect(expressionProblem("width*2 + rad(30)", ["width"])).toBeNull();
    expect(expressionProblem("base_len", [])).toMatch(/No parameter called base_len/);
    expect(expressionProblem("80+", [])).toMatch(/Couldn't read "80\+"/);
    expect(expressionProblem("a + b", [])).toMatch(/No parameters called a, b/);
    expect(expressionProblem("  ", [])).toMatch(/Type a number/);
  });
  it("reads name = expr", () => {
    expect(parameterAssignment("len = 80")).toEqual({ name: "len", expression: "80" });
    expect(parameterAssignment("len=width*2")).toEqual({ name: "len", expression: "width*2" });
    expect(parameterAssignment("80")).toBeNull();
    expect(parameterAssignment("a <= 3")).toBeNull();
  });
});

describe("sketch.addDimension", () => {
  it("refuses an expression naming no parameter (instead of driving the dimension to 0)", async () => {
    const s = realSession();
    const sk = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    const ids = (await s.dispatch("sketch.addRectangle", { sketch: sk, corner: { x: 0, y: 0 }, opposite: { x: 40, y: 20 } })).createdIds;
    const r = await s.dispatch("sketch.addDimension", { sketch: sk, type: "distanceX", a: ids[0], b: ids[1], expression: "base_len" });
    expect(`${r.error ?? ""} ${r.message ?? ""}`).toMatch(/No parameter called base_len/);
    expect(Object.values(s.doc.sketches[sk].constraints).some((c) => (c as { expr?: string }).expr === "base_len")).toBe(false);
  });
});
