import { describe, it, expect } from "vitest";
import { realSession } from "./helpers";
import { extractRegions } from "../src/core/geometry/profile";

// Region decomposition drives extrude. Disjoint boundaries must be separate
// regions; a loop nested inside another must become a hole, not its own region.
describe("region extraction", () => {
  it("a single rectangle is one region with no holes", async () => {
    const s = realSession();
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 0, y: 0 }, opposite: { x: 40, y: 20 } });
    const regions = extractRegions(s.doc.sketches[sid]);
    expect(regions.length).toBe(1);
    expect(regions[0].holes.length).toBe(0);
  });

  it("a circle inside a rectangle is one region with one hole", async () => {
    const s = realSession();
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: -30, y: -30 }, opposite: { x: 30, y: 30 } });
    await s.dispatch("sketch.addCircle", { sketch: sid, center: { x: 0, y: 0 }, radius: 8 });
    const regions = extractRegions(s.doc.sketches[sid]);
    expect(regions.length).toBe(1);
    expect(regions[0].holes.length).toBe(1);
  });

  it("two disjoint rectangles are two independent regions", async () => {
    const s = realSession();
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: -40, y: -10 }, opposite: { x: -10, y: 10 } });
    await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 10, y: -10 }, opposite: { x: 40, y: 10 } });
    const regions = extractRegions(s.doc.sketches[sid]);
    expect(regions.length).toBe(2);
    expect(regions.every((r) => r.holes.length === 0)).toBe(true);
  });

  it("construction geometry is excluded from regions", async () => {
    const s = realSession();
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 0, y: 0 }, opposite: { x: 20, y: 20 }, construction: true });
    expect(extractRegions(s.doc.sketches[sid]).length).toBe(0);
  });
});
