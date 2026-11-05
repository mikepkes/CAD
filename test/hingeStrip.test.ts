// A living hinge drawn bent (src/sim/hingeStrip.ts): straight at rest, a
// half-round when folded flat, and always running from one attachment point to
// the other, however the parts are posed.
import { describe, it, expect } from "vitest";
import { bentStripPath, bentStripMesh, flexureStripEnds, type StripEnds } from "../src/sim/hingeStrip";
import { IDENTITY, rotationAbout, type Rigid } from "../src/math/transform";
import type { Joint } from "../src/core/document";

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

describe("bentStripPath", () => {
  it("is a straight line between its ends at rest", () => {
    const e: StripEnds = { from: { x: 0, y: 0, z: 0 }, to: { x: 6, y: 0, z: 0 }, d0: { x: 1, y: 0, z: 0 }, d1: { x: 1, y: 0, z: 0 }, length: 6 };
    const { points, bendAngle } = bentStripPath(e, 8);
    expect(bendAngle).toBe(0);
    for (const p of points) { expect(near(p.y, 0)).toBe(true); expect(near(p.z, 0)).toBe(true); }
    expect(points[0]).toEqual(e.from);
    expect(points[8]).toEqual(e.to);
  });

  it("folded 180° with its ends a diameter apart, it is a half-round of that radius", () => {
    // a strip of length π·r leaving along -X and arriving back along +X, ends 2r apart in Z
    const r = 2, L = Math.PI * r;
    const e: StripEnds = { from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 2 * r }, d0: { x: -1, y: 0, z: 0 }, d1: { x: 1, y: 0, z: 0 }, length: L };
    const { points, bendAngle } = bentStripPath(e, 32);
    expect(near(bendAngle, Math.PI)).toBe(true);
    const bulge = Math.min(...points.map((p) => p.x));
    expect(Math.abs(-bulge - r) / r).toBeLessThan(0.03); // a cubic's arc is within 3% of the circle
    // every point within a few percent of the circle about (−0, 0, r)... centred on the chord's middle
    for (const p of points) {
      const d = Math.hypot(p.x, p.z - r);
      expect(Math.abs(d - r) / r).toBeLessThan(0.03);
    }
  });
});

describe("bentStripMesh", () => {
  it("is a closed strip of the given section with outward normals", () => {
    const e: StripEnds = { from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 }, d0: { x: 1, y: 0, z: 0 }, d1: { x: 1, y: 0, z: 0 }, length: 10 };
    const m = bentStripMesh(e, { x: 0, y: 1, z: 0 }, 12, 0.5, 4);
    expect(m.triangleCount).toBe(4 * 4 * 2 + 4);
    expect(m.indices.length).toBe(m.triangleCount * 3);
    // bounds: 10 long, 12 wide (Y), 0.5 thick (Z)
    const xs: number[] = [], ys: number[] = [], zs: number[] = [];
    for (let i = 0; i < m.positions.length; i += 3) { xs.push(m.positions[i]); ys.push(m.positions[i + 1]); zs.push(m.positions[i + 2]); }
    expect(near(Math.max(...xs) - Math.min(...xs), 10)).toBe(true);
    expect(near(Math.max(...ys) - Math.min(...ys), 12)).toBe(true);
    expect(near(Math.max(...zs) - Math.min(...zs), 0.5)).toBe(true);
    // every triangle's winding agrees with its stored normal, and that normal points away from the axis
    for (let t = 0; t < m.indices.length; t += 3) {
      const v = (k: number) => ({ x: m.positions[3 * m.indices[t + k]], y: m.positions[3 * m.indices[t + k] + 1], z: m.positions[3 * m.indices[t + k] + 2] });
      const a = v(0), b = v(1), c = v(2);
      const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
      const n = { x: ab.y * ac.z - ab.z * ac.y, y: ab.z * ac.x - ab.x * ac.z, z: ab.x * ac.y - ab.y * ac.x };
      const sn = { x: m.normals[3 * m.indices[t]], y: m.normals[3 * m.indices[t] + 1], z: m.normals[3 * m.indices[t] + 2] };
      expect(n.x * sn.x + n.y * sn.y + n.z * sn.z).toBeGreaterThan(0);
      const mid = { x: (a.x + b.x + c.x) / 3 - 5, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3 };
      // a long face's normal points away from the centreline; an end cap's along it
      const away = mid.y * sn.y + mid.z * sn.z, along = mid.x * sn.x;
      expect(away > 1e-9 || Math.abs(along) > 4.9).toBe(true);
    }
  });
});

describe("flexureStripEnds", () => {
  const joint = (strip: NonNullable<Joint["flexure"]>["strip"]): Joint => ({
    id: "j", name: "hinge", kind: "flexure", base: "A", moved: "B", baseOrigin: { x: 0, y: 0, z: 4 }, movedOrigin: { x: 0, y: 0, z: 4 },
    axis: { x: 0, y: 1, z: 0 }, valueExpr: "0", valueValue: 0, flexure: { length: 6, width: 12, thickness: 0.25, strip },
  });
  it("runs along the as-modelled chord at rest", () => {
    const j = joint({ from: { x: -3, y: 0, z: 0 }, to: { x: 3, y: 0, z: 4 } });
    const world = new Map<string, Rigid>([["A", IDENTITY], ["B", IDENTITY]]);
    const e = flexureStripEnds(j, world, IDENTITY)!;
    expect(e.from).toEqual({ x: -3, y: 0, z: 0 });
    expect(e.to).toEqual({ x: 3, y: 0, z: 4 });
    expect(near(e.length, Math.hypot(6, 4))).toBe(true);
    expect(near(e.d0.x, e.d1.x) && near(e.d0.z, e.d1.z)).toBe(true);
  });
  it("turns the arriving direction with the moved part", () => {
    const j = joint({ from: { x: -3, y: 0, z: 0 }, to: { x: 3, y: 0, z: 4 } });
    // the lid flipped 180° about the hinge line at the mating face
    const flip = rotationAbout({ x: 0, y: 1, z: 0 }, Math.PI, { x: 0, y: 0, z: 4 });
    const world = new Map<string, Rigid>([["A", IDENTITY], ["B", flip]]);
    const e = flexureStripEnds(j, world, IDENTITY)!;
    expect(near(e.to.x, -3) && near(e.to.z, 4)).toBe(true); // lands on the base's hinge face, a half-thickness above `from`
    expect(near(e.d1.x, -e.d0.x) && near(e.d1.z, -e.d0.z)).toBe(true);
    const { bendAngle } = bentStripPath(e);
    expect(near(bendAngle, Math.PI)).toBe(true);
  });
  it("is nothing without attachment points", () => {
    expect(flexureStripEnds(joint(undefined), new Map(), IDENTITY)).toBeUndefined();
  });
});
