// The SKÅDIS holder's physics and printing (test/skadis.ts): empty it falls open,
// only the item's weight shuts it, and every part prints without supports.
import { describe, it, beforeAll, expect } from "vitest";
import type { CadSession } from "../src/core/command/session";
import { GeometryCache } from "../src/core/features";
import { built, parts, PRINTED, MOVING, RHO, G, DROP, RP, LA, A0, S } from "./skadis";

describe("SKÅDIS gravity holder: physics and printing", () => {
  let s: CadSession;
  beforeAll(async () => { s = await built(); }, 300000);

  // Virtual work: the moving parts' weight against the rack's drop. Empty, it must
  // rise as the rack drops (the pads go up as they close), so it falls open; an
  // item of mass M adds −M·drop, and shuts it once it outweighs that.
  it("falls open when empty, and only the item's weight shuts it: the least weight, and the grip", async () => {
    const drops = Array.from({ length: 7 }, (_, k) => (DROP * k) / 6);
    const cache = new GeometryCache(); // across the sweep: the parts only move, so each pose replays them, moved
    const U = drops.map((drop) => { const { by } = parts(s, { drop }, cache); return MOVING.reduce((u, k) => u + by[k].volume * RHO * by[k].centroid.z, 0); }); // g·mm
    const slopes: number[] = [];
    for (let k = 1; k < drops.length; k++) slopes.push((U[k] - U[k - 1]) / (drops[k] - drops[k - 1])); // g per mm of drop: the weight it takes to hold it there
    const least = Math.max(...slopes);
    // the squeeze on a 100 g item, each pad, half shut: what's left of its weight's work over the pads' travel in
    const k = 3, mid = A0 + ((drops[k] / RP) * 180) / Math.PI, inward = (LA * S(mid)) / RP; // mm of pad travel in per mm of drop
    const dU = (U[k + 1] - U[k - 1]) / (drops[k + 1] - drops[k - 1]);
    const grip = (M: number) => (G * (M - dU)) / (2 * inward);
    console.log(`empty, the parts' weight holds the rack up with ${slopes.map((v) => v.toFixed(1)).join(" ")} g across the travel; ` +
      `it shuts on anything over ${least.toFixed(0)} g (solid PLA parts); a 100 g item is squeezed with ${grip(100).toFixed(2)} N a pad, a 150 g one ${grip(150).toFixed(2)} N`);
    for (const v of slopes) expect(v).toBeGreaterThan(5);          // empty, it opens everywhere, with a margin
    expect(least).toBeLessThan(70);                                  // a shaver or a toothbrush handle shuts it
    expect(grip(120)).toBeGreaterThan(0.1);
    expect(grip(150) - grip(100)).toBeCloseTo(grip(200) - grip(150), 9); // in proportion to the weight
  }, 300000);

  // Each part on its print bed: the face it lies on, and no face (other than
  // the bed) facing down more than 45° from the vertical.
  it("prints without supports: every part has a flat face on the bed and no overhang past 45°", async () => {
    const BED: Record<string, { x: number; y: number; z: number }> = {
      "Strip": { x: -1, y: 0, z: 0 },                                                  // on its side: the hook in the layers
      "Back plate": { x: 0, y: -1, z: 0 },                                             // on its front face: the channel opens up
      "Cover": { x: 0, y: 1, z: 0 },                                                   // on its back face: the counterbores open up
      "Rack": { x: 0, y: 1, z: 0 },
      "Lower arm, left": { x: 0, y: 1, z: 0 }, "Lower arm, right": { x: 0, y: 1, z: 0 },
      "Upper arm, left": { x: 0, y: 1, z: 0 }, "Upper arm, right": { x: 0, y: 1, z: 0 },
      "Foot": { x: 0, y: 0, z: -1 },                                                   // standing on its ring, the tab up
      "Pad, left": { x: 0, y: 0, z: -1 }, "Pad, right": { x: 0, y: 0, z: -1 },          // standing: ribs and grip face up the layers
    };
    for (const k of PRINTED) if (/pin/i.test(k)) BED[k] = { x: 0, y: 0, z: -1 };       // the pins on their flats
    const axisOf: Record<string, string> = {};
    for (const c of Object.values(s.doc.components)) { const m = c.materialId ? s.doc.materials[c.materialId] : undefined; if (m) axisOf[c.name] = m.printAxis ?? "z"; }
    const rows: string[] = [];
    for (const over of [{}, { item: 20, arm: 5, hooks: 80 }, { item: 40, arm: 8 }]) {
      const { by } = parts(s, over);
      for (const name of PRINTED) {
        const bed = BED[name];
        expect(axisOf[name], name).toBe(bed.x ? "x" : bed.y ? "y" : "z");             // its material prints along that axis
        const m = by[name].meshes[0], Pp = m.positions, I = m.indices;
        const along = (i: number) => Pp[3 * i] * bed.x + Pp[3 * i + 1] * bed.y + Pp[3 * i + 2] * bed.z;
        let bedLevel = -Infinity;
        for (let i = 0; i < Pp.length / 3; i++) bedLevel = Math.max(bedLevel, along(i));
        let onBed = 0, overhang = 0, worst = 0;
        for (let t = 0; t < I.length; t += 3) {
          const [a, b, c] = [I[t], I[t + 1], I[t + 2]];
          const u = [Pp[3 * b] - Pp[3 * a], Pp[3 * b + 1] - Pp[3 * a + 1], Pp[3 * b + 2] - Pp[3 * a + 2]], w = [Pp[3 * c] - Pp[3 * a], Pp[3 * c + 1] - Pp[3 * a + 1], Pp[3 * c + 2] - Pp[3 * a + 2]];
          const nx = u[1] * w[2] - u[2] * w[1], ny = u[2] * w[0] - u[0] * w[2], nz = u[0] * w[1] - u[1] * w[0], len = Math.hypot(nx, ny, nz);
          if (len < 1e-12) continue;
          const down = (nx * bed.x + ny * bed.y + nz * bed.z) / len, area = len / 2;
          const flat = Math.abs(along(a) - bedLevel) < 1e-3 && Math.abs(along(b) - bedLevel) < 1e-3 && Math.abs(along(c) - bedLevel) < 1e-3;
          if (flat && down > 0.999) onBed += area;
          else if (down > Math.SQRT1_2 + 2e-3) { overhang += area; worst = Math.max(worst, down); }
        }
        expect(onBed, `${name}: on the bed`).toBeGreaterThan(/pin/i.test(name) ? 15 : 100);
        expect(overhang, `${name}: overhanging ${overhang.toFixed(2)} mm² (steepest ${(Math.acos(Math.min(1, worst)) * 180 / Math.PI).toFixed(1)}° off the bed) at ${JSON.stringify(over)}`).toBeLessThan(0.01);
        if (!Object.keys(over).length) rows.push(`${name} ${onBed.toFixed(0)} mm²`);
      }
    }
    console.log(`on the bed: ${rows.join(", ")}`);
  }, 300000);
});
