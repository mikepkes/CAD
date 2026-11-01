// The SKÅDIS holder's motion (test/skadis.ts): the rack drives the arms through
// the gear ratio, the pads stay upright and shut on the item, and nothing hits.
import { describe, it, beforeAll, expect } from "vitest";
import type { CadSession } from "../src/core/command/session";
import { collideFeatures } from "../src/core/features";
import { resolveComponentWorld } from "../src/core/recompute";
import { applyPoint, applyVec } from "../src/math/transform";
import { built, posed, clear, DROP, RP, LA, A0, A1, D_ITEM, ZP, S, Co } from "./skadis";

describe("SKÅDIS gravity holder: motion", () => {
  let s: CadSession;
  beforeAll(async () => { s = await built(); }, 300000);

  it("closes as the rack drops: the arms turn drop/r, the pads stay upright and shut on the item", async () => {
    const rows: string[] = [];
    for (const item of [20, 30, 40]) {
      let last = Infinity;
      for (const drop of [0, 1.3, 2.6, 4, DROP]) {
        const { doc, scope } = posed(s, { item, drop });
        const world = resolveComponentWorld(doc, scope);
        const comp = (name: string) => Object.values(doc.components).find((c) => c.name === name)!.id;
        const jv = (name: string) => Object.values(doc.joints).find((j) => j.name === name)!.valueValue;
        const turn = (drop / RP) * (180 / Math.PI);
        expect(jv("Lower arm, right")).toBeCloseTo(turn, 6);           // the rack ratio: drop / pitch radius
        expect(jv("Lower arm, left")).toBeCloseTo(-turn, 6);
        expect(jv("Upper arm, right")).toBeCloseTo(turn, 6);
        const down = applyPoint(world.get(comp("Rack"))!, { x: 1, y: 0, z: 0 }).z - applyPoint(world.get(comp("Linkage"))!, { x: 1, y: 0, z: 0 }).z;
        expect(down).toBeCloseTo(-drop, 9);                              // the rack slides `drop` down
        // each pad: upright (its frame turns with the linkage only), and its grip face at `held`/2
        for (const side of ["left", "right"]) {
          const W = world.get(comp(`Pad, ${side}`))!, L = world.get(comp("Linkage"))!;
          const a = applyVec(W, { x: 0, y: 0, z: 1 }), b = applyVec(L, { x: 0, y: 0, z: 1 });
          expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(1e-9);
        }
        const face = (side: string, sg: number) => applyPoint(world.get(comp(`Pad, ${side}`))!, { x: -(LA * S(A0) + 10), y: -(D_ITEM + 20), z: sg * scope.xin }).x;
        const gap = face("right", 1) - face("left", -1);
        expect(gap).toBeCloseTo(scope.held, 6);
        expect(gap).toBeLessThan(last);
        last = gap;
        if (drop === DROP) { expect(gap).toBeCloseTo(item, 6); rows.push(`item ${item}: pads ${(item + 2 * (LA * (Co(A0) - Co(A1)))).toFixed(1)} → ${gap.toFixed(1)} mm apart over ${DROP} mm of rack, rising ${(LA * (S(A1) - S(A0))).toFixed(1)} mm`); }
      }
    }
    console.log(rows.join("\n"));
  }, 120000);

  // The motion study sweeps `drop` and `lift` at the saved sizes (test/examples.test.ts); here, the corners.
  const POSES: Record<string, number>[] = [
    { drop: 2.6 }, { item: 20, drop: DROP }, { item: 40, drop: DROP }, { arm: 8, drop: DROP }, { arm: 5, hooks: 80, lift: 25, drop: 2 },
  ];
  for (const over of POSES) {
    const label = Object.entries(over).map(([k, v]) => `${k} ${v}`).join(", ");
    it(`is clear at ${label}`, async () => { const { doc, scope } = posed(s, over); clear(doc, scope, label); }, 600000);
  }
  it("the check can fail: a pinion half a tooth out of phase hits the rack", async () => {
    const { doc, scope } = posed(s, { drop: 2 }, (d) => Object.fromEntries(Object.entries(d.joints).map(([k, j]) => [k, j.name === "Lower arm, right" ? { ...j, valueExpr: `${j.valueExpr} + ${180 / ZP}` } : j])));
    const hit = collideFeatures(doc, scope).overlaps.find((o) => /Pinion|Lower arm, right/.test(o.a + o.b) && /Rack/.test(o.a + o.b));
    expect(hit?.volume ?? 0).toBeGreaterThan(0.5);
  }, 600000);

});
