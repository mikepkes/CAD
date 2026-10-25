import { describe, it, expect } from "vitest";
import { compose, invert, applyPoint, rotationAbout, translation, IDENTITY, Rigid } from "../src/math/transform";

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);
const nearPt = (p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number }) => { near(p.x, q.x); near(p.y, q.y); near(p.z, q.z); };

describe("rigid transform invert", () => {
  const cases: Rigid[] = [
    IDENTITY,
    translation({ x: 3, y: -4, z: 5 }),
    rotationAbout({ x: 0, y: 0, z: 1 }, 0.7, { x: 2, y: 0, z: 0 }),
    compose(translation({ x: 1, y: 2, z: 3 }), rotationAbout({ x: 1, y: 1, z: 0 }, 1.2, { x: 0, y: 0, z: 0 })),
  ];

  it("T ∘ T⁻¹ and T⁻¹ ∘ T are both identity", () => {
    for (const T of cases) {
      for (const I of [compose(T, invert(T)), compose(invert(T), T)]) {
        nearPt(applyPoint(I, { x: 0, y: 0, z: 0 }), { x: 0, y: 0, z: 0 });
        nearPt(I.x, { x: 1, y: 0, z: 0 });
        nearPt(I.y, { x: 0, y: 1, z: 0 });
        nearPt(I.z, { x: 0, y: 0, z: 1 });
      }
    }
  });

  it("invert actually undoes the mapping of a point", () => {
    const T = cases[3];
    const p = { x: 7, y: -2, z: 11 };
    nearPt(applyPoint(invert(T), applyPoint(T, p)), p);
  });
});
