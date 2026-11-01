// The SKÅDIS holder's mount (test/skadis.ts): the strip hooks into the board's
// slots, and the holder slides onto the strip, captured and stopped.
import { describe, it, beforeAll, expect } from "vitest";
import type { CadSession } from "../src/core/command/session";
import { collideFeatures } from "../src/core/features";
import { built, parts, posed, clear, nudge, only, BOARD, HOOK, C, COL, ZS } from "./skadis";

describe("SKÅDIS gravity holder: mount", () => {
  let s: CadSession;
  beforeAll(async () => { s = await built(); }, 300000);

  it("fits the SKÅDIS board: the strip's fin in a slot, a lip behind the board, its peg in the slot `hooks` below", async () => {
    for (const hooks of [40, 80]) {
      const { doc, scope, by } = parts(s, { hooks });
      const m = by["Strip"].meshes[0], v: { x: number; y: number; z: number }[] = [];
      for (let i = 0; i < m.positions.length; i += 3) if (m.positions[i + 1] > 0.01) v.push({ x: m.positions[i], y: m.positions[i + 1], z: m.positions[i + 2] });
      const span = (f: (p: { x: number; y: number; z: number }) => number, q = v) => [Math.min(...q.map(f)), Math.max(...q.map(f))];
      const [x0, x1] = span((p) => p.x);
      expect((x0 + x1) / 2).toBeCloseTo(COL, 4);                                                    // on the slot column
      expect(BOARD.slotW - (x1 - x0)).toBeCloseTo(2 * C, 4);                                       // 0.3 a side in the 5 mm slot
      const top = v.filter((p) => p.z > ZS - 20), peg = v.filter((p) => p.z < ZS - 20);
      const slotBottom = ZS - HOOK.seat, arcRise = BOARD.slotW / 2 - Math.sqrt((BOARD.slotW / 2) ** 2 - (HOOK.t / 2) ** 2);
      expect(span((p) => p.y, top)[1]).toBeCloseTo(BOARD.t + 0.4 + HOOK.lip, 4);                  // through the board, a lip behind it
      expect(Math.min(...top.filter((p) => p.y > BOARD.t).map((p) => p.z))).toBeLessThan(slotBottom - 3);
      expect(span((p) => p.z, top.filter((p) => p.y < BOARD.t))[0] - slotBottom).toBeGreaterThan(arcRise);
      const [t0, t1] = span((p) => p.z, top);
      expect(t1 - t0).toBeLessThan(BOARD.slotH - 4);                                               // fin + lip pass the slot, lifted
      const [p0, p1] = span((p) => p.z, peg);
      expect((p0 + p1) / 2 - (ZS + HOOK.neckH / 2)).toBeCloseTo(-hooks + 0.4 + HOOK.pegH / 2 - HOOK.neckH / 2, 4); // the peg is `hooks` down the column
      expect(p0 - (slotBottom - hooks)).toBeGreaterThan(arcRise);                                    // in the slot below…
      expect(slotBottom - hooks + BOARD.slotH - arcRise - p1).toBeGreaterThan(HOOK.drop - HOOK.seat + 0.5); // …with room to lift the lip in
      clear(only(doc, ["Strip", "SKÅDIS board (not printed)", "Back plate"]), scope, `hooks ${hooks}`);
      // the check can fail: drop the strip 1.5 mm and its fin hits the slot's end
      const sunk = posed(s, { hooks }, nudge("Strip on the board", { z: -1.5 }));
      expect(collideFeatures(only(sunk.doc, ["Strip", "SKÅDIS board (not printed)"]), sunk.scope).overlaps.filter((o) => /board/.test(o.a + o.b)).length).toBeGreaterThanOrEqual(1);
    }
  }, 600000);

  it("slides onto the strip: clear all the way down, captured by the dovetail, and stopped by the channel's end", async () => {
    for (const lift of [60, 30, 0]) { const { doc, scope } = posed(s, { lift }); clear(only(doc, ["Strip", "SKÅDIS board (not printed)", "Back plate", "Cover", "Rack", "Foot", "Foot pin 1", "Foot pin 2", "Pivot pin 1", "Pivot pin 2"]), scope, `lift ${lift}`); }
    const strip = (by: { x?: number; y?: number; z?: number }) => {
      const { doc, scope } = posed(s, {}, nudge("Strip on the board", by));
      return collideFeatures(only(doc, ["Strip", "Back plate"]), scope).overlaps.filter((o) => /Strip/.test(o.a + o.b) && /Back plate/.test(o.a + o.b)).reduce((v, o) => v + o.volume, 0);
    };
    expect(strip({ z: 0.5 })).toBeGreaterThan(0.1);   // seated on its end: it can't slide further down the strip
    expect(strip({ y: 0.4 })).toBeGreaterThan(0.1);   // pulled off the board, the dovetail's undercut holds it
    expect(strip({ x: 0.15 })).toBe(0);               // 0.2 clear each side…
    expect(strip({ x: -0.15 })).toBe(0);
    expect(strip({ x: 1 })).toBeGreaterThan(0.1);     // …and no more
    expect(strip({ x: -1 })).toBeGreaterThan(0.1);
  }, 600000);

});
