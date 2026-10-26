import { describe, it, expect } from "vitest";
import { axisAngle, rotation } from "../src/math/transform";

describe("axisAngle", () => {
  const cases: [string, { x: number; y: number; z: number }, number][] = [
    ["identity", { x: 0, y: 0, z: 1 }, 0],
    ["quarter turn about Z", { x: 0, y: 0, z: 1 }, Math.PI / 2],
    ["oblique axis", { x: 1, y: -2, z: 0.5 }, 1.1],
    // half turns: the antisymmetric part vanishes, so the axis comes off the diagonal
    ["half turn about Y (a flip)", { x: 0, y: 1, z: 0 }, Math.PI],
    ["half turn about an oblique axis", { x: 1, y: -2, z: 0.5 }, Math.PI],
    ["half turn about a negative-component axis", { x: -0.3, y: 0.2, z: 1 }, Math.PI],
    ["just short of a half turn", { x: 0.6, y: -0.8, z: 0.3 }, Math.PI - 1e-7],
    ["a tiny turn", { x: 0.6, y: -0.8, z: 0.3 }, 1e-7],
  ];
  for (const [name, axis, angle] of cases) {
    it(`recovers ${name}`, () => {
      const R = rotation(axis, angle);
      const r = axisAngle(R);
      expect(r.angle).toBeCloseTo(angle, 6); // acos is ill-conditioned at 0 and π
      // the recovered axis/angle must rebuild the same rotation (n and -n are equal at π)
      const back = rotation(r.axis, r.angle);
      for (const k of ["x", "y", "z"] as const) for (const c of ["x", "y", "z"] as const) expect(back[k][c]).toBeCloseTo(R[k][c], 9);
    });
  }
});
