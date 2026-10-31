import { describe, it, expect, vi } from "vitest";
import { quantize, decimals, scrubValue, keyStep, formatValue, parseTyped, arrowDir, formatMagnitude, magnitudeDigits } from "../src/ui/kit/numberMath";
import { placeCard, clampInside, clusterPins, pinOffset, CARD_W, CARD_W_WIDE, CARD_W_NARROW } from "../src/ui/kit/anchor";
import { createEditQueue } from "../src/ui/kit/editQueue";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

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
  it("names the direction of an arrow key once for every control", () => {
    expect(arrowDir("ArrowRight")).toEqual({ dx: 1, dy: 0 });
    expect(arrowDir("ArrowLeft")).toEqual({ dx: -1, dy: 0 });
    expect(arrowDir("ArrowUp")).toEqual({ dx: 0, dy: 1 });
    expect(arrowDir("ArrowDown")).toEqual({ dx: 0, dy: -1 });
    expect(arrowDir("Enter")).toBeNull();
  });
  it("formats a measured value by its magnitude: hundreds whole, tens to a tenth, else two places", () => {
    expect(magnitudeDigits(108.4)).toBe(0); expect(magnitudeDigits(12.3)).toBe(1); expect(magnitudeDigits(0.5)).toBe(2);
    expect(formatMagnitude(1234.5, "g")).toBe("1,235 g");
    expect(formatMagnitude(51.84, "g")).toBe("51.8 g");
    expect(formatMagnitude(0.1234)).toBe("0.12");
    expect(formatMagnitude(3)).toBe("3.00");
    expect(formatMagnitude(3, "", { trim: true })).toBe("3");
    expect(formatMagnitude(12000, "mm³", { digits: 0 })).toBe("12,000 mm³");
    expect(formatMagnitude(NaN, "g")).toBe("—");
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
  it("has one set of card widths", () => {
    expect(CARD_W).toBeLessThan(CARD_W_WIDE);
    expect(CARD_W_NARROW).toBeLessThan(CARD_W);
  });
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

describe("edit queue: one edit in flight", () => {
  it("sends the first value at once, keeps only the latest while in flight, and sends it after", async () => {
    const sent: number[] = [];
    let release!: () => void;
    const q = createEditQueue<number>((v) => { sent.push(v); return new Promise<void>((r) => { release = r; }); });
    q.live(1);
    expect(sent).toEqual([1]);
    expect(q.inFlight).toBe(true);
    q.live(2); q.live(3); q.live(4);
    expect(sent).toEqual([1]);
    expect(q.pending).toBe(4);
    release();
    await tick();
    expect(sent).toEqual([1, 4]);
    expect(q.inFlight).toBe(true);
    release();
    await tick();
    expect(q.inFlight).toBe(false);
    expect(q.pending).toBeNull();
    q.live(5);
    expect(sent).toEqual([1, 4, 5]);
  });

  it("commit sends the final value unless it is the last one already sent", async () => {
    const sent: number[] = [];
    const q = createEditQueue<number>(async (v) => { sent.push(v); });
    q.live(5);
    await tick();
    q.commit(5);
    expect(sent).toEqual([5]);
    q.commit(6);
    expect(sent).toEqual([5, 6]);
  });

  it("commit while in flight replaces the pending value", async () => {
    const sent: number[] = [];
    let release!: () => void;
    const q = createEditQueue<number>((v) => { sent.push(v); return new Promise<void>((r) => { release = r; }); });
    q.live(1); q.live(2); q.commit(2);
    release();
    await tick();
    expect(sent).toEqual([1, 2]);
  });

  it("tells values apart by the key it is given", async () => {
    const send = vi.fn(() => Promise.resolve());
    const q = createEditQueue<{ v: number }>(send, (e) => String(e.v));
    q.live({ v: 1 }); q.commit({ v: 1 });
    await tick();
    q.live({ v: 2 }); q.commit({ v: 2 });
    await tick();
    expect(send.mock.calls.map((c) => (c[0] as { v: number }).v)).toEqual([1, 2]);
  });

  it("survives a rejected or throwing send", async () => {
    let n = 0;
    const send = vi.fn((v: number) => { n++; if (v === 1) throw new Error("sync"); return v === 2 ? Promise.reject(new Error("async")) : Promise.resolve(); });
    const q = createEditQueue<number>(send);
    q.live(1);
    await tick();
    q.live(2); q.live(3);
    await tick();
    expect(n).toBe(3);
    expect(q.inFlight).toBe(false);
  });

  it("flush resolves once nothing is running or waiting", async () => {
    const ran: number[] = [];
    let release: () => void = () => {};
    const q = createEditQueue<number>(async (v) => { ran.push(v); await new Promise<void>((r) => { release = r; }); });
    q.live(1); q.live(2); q.live(3);
    expect(ran).toEqual([1]);
    expect(q.inFlight).toBe(true);
    release();
    await tick();
    expect(ran).toEqual([1, 3]);
    release();
    await q.flush();
    expect(q.inFlight).toBe(false);
    expect(ran).toEqual([1, 3]);
  });
});
