import { describe, it, expect } from "vitest";
import { meshesToStlBinary } from "../src/core/export/stl";

describe("binary STL export", () => {
  it("writes the header, triangle count and facet data", () => {
    // one triangle in the z=0 plane, CCW → normal +Z
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint32Array([0, 1, 2]);
    const buf = meshesToStlBinary([{ positions, indices }]);
    expect(buf.byteLength).toBe(84 + 1 * 50);
    const dv = new DataView(buf);
    expect(dv.getUint32(80, true)).toBe(1); // triangle count
    // facet normal = +Z
    expect(dv.getFloat32(84, true)).toBeCloseTo(0);
    expect(dv.getFloat32(88, true)).toBeCloseTo(0);
    expect(dv.getFloat32(92, true)).toBeCloseTo(1);
    // first vertex = (0,0,0)
    expect(dv.getFloat32(96, true)).toBeCloseTo(0);
  });

  it("concatenates triangles from every mesh (all bodies in one file)", () => {
    const tri = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
    const buf = meshesToStlBinary([tri, tri, tri]);
    expect(new DataView(buf).getUint32(80, true)).toBe(3);
    expect(buf.byteLength).toBe(84 + 3 * 50);
  });
});
