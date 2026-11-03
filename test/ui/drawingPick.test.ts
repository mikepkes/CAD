// Picking on the shop drawing (src/ui/drawingPick.ts): paper ↔ view coordinates,
// the nearest corner or edge a tool takes, and the commands a finished pick makes.
import { describe, it, expect } from "vitest";
import { toView, toPaper, viewAt, nearestTarget, dimensionCommand, linearKind, sectionLine } from "../../src/ui/drawingPick";
import type { PickTarget, SheetViewInfo } from "../../src/core/drawings";

const front: SheetViewInfo = { id: "front", label: "Front", kind: "ortho", x: 100, y: 200, w: 200, h: 100, scale: 0.5, minU: -200, maxV: 100 };
const corner: PickTarget = { ref: { body: "b", vertex: "a|b|c" }, f: { kind: "point", p: [0, 0] } };
const edge: PickTarget = { ref: { body: "b", edge: "a|b" }, f: { kind: "segment", a: [0, 0], b: [0, 50] } };
const right: PickTarget = { ref: { body: "b", edge: "c|d" }, f: { kind: "segment", a: [40, 0], b: [40, 50] } };
const hole: PickTarget = { ref: { body: "b", edge: "e|f" }, f: { kind: "curve", pts: [[30, 20], [20, 30], [10, 20], [20, 10], [30, 20]], circle: { c: [20, 20], r: 10, faceOn: true } } };

describe("picking on the sheet", () => {
  it("maps paper to a view's coordinates and back, and finds the view under a point", () => {
    expect(toView(front, [100, 200])).toEqual([-200, 100]);
    expect(toView(front, [300, 300])).toEqual([200, -100]);
    expect(toPaper(front, toView(front, [123, 245]))).toEqual([123, 245]);
    expect(viewAt([front], [150, 250])?.id).toBe("front");
    expect(viewAt([front], [90, 250])).toBeUndefined();
    expect(viewAt([front], [90, 250], 20)?.id).toBe("front");
  });
  it("takes the nearest thing the tool can use, a corner before the edge it ends", () => {
    const picks = [corner, edge, right, hole];
    expect(nearestTarget(picks, [0.5, 0.5], 3, "linear")).toBe(corner);
    expect(nearestTarget(picks, [0.5, 25], 3, "linear")).toBe(edge);
    expect(nearestTarget(picks, [29, 21], 3, "radius")).toBe(hole);
    expect(nearestTarget(picks, [0.5, 25], 3, "radius")).toBeUndefined(); // a radius takes circles only
    expect(nearestTarget(picks, [39, 25], 3, "angle")).toBe(right);
    expect(nearestTarget(picks, [100, 100], 3, "linear")).toBeUndefined();
  });
  it("makes the dimension command, its kind from where it is pulled, its offset from what it measures", () => {
    expect(linearKind([edge.f, right.f], [20, -30])).toBe("horizontal");
    expect(linearKind([edge.f, right.f], [70, 25])).toBe("vertical");
    expect(dimensionCommand("linear", "front", [edge, right], [20, -30])).toEqual({ view: "front", kind: "horizontal", refs: [edge.ref, right.ref], offset: { u: 0, v: -55 } });
    expect(dimensionCommand("diameter", "top", [hole], [40, 45])).toEqual({ view: "top", kind: "diameter", refs: [hole.ref], offset: { u: 20, v: 25 } });
    expect(dimensionCommand("angle", "front", [edge, right], [0, 0])).toBeUndefined(); // parallel: no vertex
  });
  it("draws a section line across the whole view, square to it when nearly so", () => {
    const l = sectionLine(front, [10, -50], [12, 50])!;
    expect(l.from.u).toBe(10);
    expect(l.to.u).toBe(10);
    expect(l.from.v).toBeLessThan(-100); // past the view's bottom (v −100) …
    expect(l.to.v).toBeGreaterThan(100); // … and top (v 100), going the way it was drawn
    const slant = sectionLine(front, [0, 0], [50, 50])!;
    expect(slant.to.v - slant.from.v).toBeCloseTo(slant.to.u - slant.from.u, 6);
    expect(sectionLine(front, [5, 5], [5, 5])).toBeUndefined();
  });
});
