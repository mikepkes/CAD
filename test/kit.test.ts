import { describe, it, expect } from "vitest";
import { quantize, decimals, scrubValue, keyStep, formatValue, parseTyped } from "../src/ui/kit/numberMath";
import { placeCard, clampInside, clusterPins, pinOffset } from "../src/ui/kit/anchor";

describe("live numbers", () => {
  it("quantize snaps to the step within the bounds and kills float noise", () => {
    expect(quantize(0.1 + 0.2, { step: 0.1 })).toBe(0.3);
    expect(quantize(7.26, { step: 0.5 })).toBe(7.5);
    expect(quantize(99, { min: 1, max: 50, step: 1 })).toBe(50);
    expect(quantize(-3, { min: 0, step: 0.25 })).toBe(0);
  });
  it("decimals follow the step", () => {
    expect(decimals(1)).toBe(0); expect(decimals(0.5)).toBe(1); expect(decimals(0.25)).toBe(2); expect(decimals(0.1)).toBe(1);
  });
  it("scrubbing moves one step per 5 px, ×10 with shift, finer with alt", () => {
    const spec = { min: 0, max: 100, step: 1 };
    expect(scrubValue(10, 50, spec)).toBe(20);
    expect(scrubValue(10, -4, spec)).toBe(9);
    expect(scrubValue(10, 2, spec)).toBe(10);
    expect(scrubValue(10, 50, spec, { coarse: true })).toBe(100);
    expect(scrubValue(10, 5, spec, { fine: true })).toBe(10.1);
  });
  it("arrow keys step, other keys don't", () => {
    const spec = { min: 0, max: 10, step: 0.5 };
    expect(keyStep(3, "ArrowRight", false, spec)).toBe(3.5);
    expect(keyStep(3, "ArrowDown", false, spec)).toBe(2.5);
    expect(keyStep(3, "ArrowUp", true, spec)).toBe(8);
    expect(keyStep(3, "Enter", false, spec)).toBeNull();
  });
  it("formats with the step's precision and the unit, and parses typed text back", () => {
    expect(formatValue(1234.5, { step: 0.5 }, "mm")).toBe("1,234.5 mm");
    expect(formatValue(4, { step: 1 })).toBe("4");
    expect(parseTyped("1,234.5 mm", { step: 0.5 })).toBe(1234.5);
    expect(parseTyped("12°", { step: 1 })).toBe(12);
    expect(parseTyped("abc", { step: 1 })).toBeNull();
  });
});

describe("anchoring", () => {
  const bounds = { w: 1000, h: 600 }, size = { w: 300, h: 200 };
  it("places a card to the right of its anchor when it fits, else to the left", () => {
    expect(placeCard({ anchor: { x: 100, y: 100 }, size, bounds })).toEqual({ x: 114, y: 92 });
    expect(placeCard({ anchor: { x: 900, y: 100 }, size, bounds })).toEqual({ x: 586, y: 92 });
  });
  it("flips below/above the same way and always stays inside the bounds", () => {
    expect(placeCard({ anchor: { x: 500, y: 550 }, size, bounds, prefer: "below" })).toEqual({ x: 492, y: 336 });
    const p = placeCard({ anchor: { x: 990, y: 590 }, size, bounds });
    expect(p.x + size.w).toBeLessThanOrEqual(bounds.w - 8);
    expect(p.y + size.h).toBeLessThanOrEqual(bounds.h - 8);
    expect(clampInside({ x: -50, y: -50 }, size, bounds)).toEqual({ x: 8, y: 8 });
  });
  it("offsets pins diagonally and clusters the ones that would overlap", () => {
    expect(pinOffset({ x: 100, y: 100 }, "ne")).toEqual({ x: 130, y: 70 });
    const pins = [{ pos: { x: 0, y: 0 }, n: 1 }, { pos: { x: 10, y: 0 }, n: 2 }, { pos: { x: 200, y: 0 }, n: 3 }];
    const c = clusterPins(pins, 30);
    expect(c.map((k) => k.members.map((m) => m.n))).toEqual([[1, 2], [3]]);
    expect(c[0].pos).toEqual({ x: 5, y: 0 });
  });
});
