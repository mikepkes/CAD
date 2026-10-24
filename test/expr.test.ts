import { describe, it, expect } from "vitest";
import { compileExpr, evaluate } from "../src/math/expr";

describe("expression evaluator", () => {
  it("arithmetic with precedence", () => {
    expect(evaluate("2 + 3 * 4")).toBe(14);
    expect(evaluate("(2 + 3) * 4")).toBe(20);
    expect(evaluate("10 / 4")).toBeCloseTo(2.5);
    expect(evaluate("-5 + 2")).toBe(-3);
  });

  it("resolves parameters from scope", () => {
    expect(evaluate("width / 2", { width: 40 })).toBe(20);
    expect(evaluate("a + b", { a: 3, b: 4 })).toBe(7);
  });

  it("supports math functions", () => {
    expect(evaluate("sqrt(16)")).toBeCloseTo(4);
    expect(evaluate("abs(-7)")).toBe(7);
    expect(evaluate("rad(180)")).toBeCloseTo(Math.PI);
    expect(evaluate("cos(0)")).toBeCloseTo(1);
  });

  it("throws on an unknown identifier", () => {
    expect(() => evaluate("nope + 1")).toThrow();
  });

  it("compiles once and evaluates many times", () => {
    const c = compileExpr("x * 2 + 1");
    expect(c.eval({ x: 3 })).toBe(7);
    expect(c.eval({ x: 10 })).toBe(21);
  });
});
