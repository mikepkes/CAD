// A gravity holder for an IKEA SKÅDIS pegboard (the model and how it works:
// test/skadis.ts). Here: it builds, how far it stands off the board, and the
// STLs. Its mount, motion, and physics and printing are checked in
// skadis.mount.test.ts, skadis.motion.test.ts and skadis.physics.test.ts (each
// in a kernel of its own).
//   BUILD_SKADIS=/abs/out npx vitest run test/skadis.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { expectCommittedExample } from "./helpers";
import type { CadSession } from "../src/core/command/session";
import { writeFileSync } from "node:fs";
import { serializeDocument } from "../src/core/persistence";
import { exportFeatureBytes, GeometryCache } from "../src/core/features";
import { built, parts, posed, componentOf, PRINTED, RHO, DROP, D_C1, D_ITEM, ITEM_D } from "./skadis";

const OUT = process.env.BUILD_SKADIS || "";

describe("SKÅDIS gravity holder: build", () => {
  let s: CadSession;
  beforeAll(async () => { s = await built(); }, 300000);

  it("builds: 23 printed parts, the board and a stand-in, one clean body each", async () => {
    if (OUT) writeFileSync(`${OUT}/skadis.json`, serializeDocument(s.doc));
    expectCommittedExample(s, "skadis"); // so the example suite's checks of public/examples/skadis.json are this model's
    for (const sk of Object.values(s.doc.sketches)) expect(sk.status.conflicting, `sketch ${sk.name}`).toBe(false);
    const cache = new GeometryCache(); // built cold here; the poses below replay its bodies, moved
    const { by, out } = parts(s, {}, cache);
    for (const b of Object.values(out)) expect(b.error, b.name).toBeUndefined();
    expect(Object.keys(by).sort()).toEqual([...PRINTED, "SKÅDIS board (not printed)", "Stand-in item (not printed)"].sort());
    for (const [name, p] of Object.entries(by)) expect(p.meshes.length, name).toBe(1);
    // mirror pairs and repeated parts are alike
    for (const [a, b] of [["Lower arm, left", "Lower arm, right"], ["Upper arm, left", "Upper arm, right"], ["Pad, left", "Pad, right"], ["Pivot pin 1", "Pivot pin 4"], ["Guide pin 1", "Guide pin 2"], ["Foot pin 1", "Pad pin, right upper"]])
      expect(by[a].volume, `${a} ~ ${b}`).toBeCloseTo(by[b].volume, 1);
    // how far it stands off the board: every printed part, at rest and at full travel
    let depth = 0;
    for (const drop of [0, DROP]) { const q = parts(s, { drop }, cache); for (const k of PRINTED) for (const m of q.by[k].meshes) for (let i = 1; i < m.positions.length; i += 3) depth = Math.max(depth, -m.positions[i]); }
    console.log(`parts (solid PLA): ${PRINTED.map((k) => `${k} ${(by[k].volume * RHO).toFixed(1)} g`).join(", ")}\ndepth off the board: ${depth.toFixed(1)} mm (the plates ${D_C1} mm; the item's front ${D_ITEM + ITEM_D} mm)`);
    expect(depth).toBeLessThan(D_ITEM + ITEM_D);                     // the holder stays inside the item's own depth
    expect(s.doc.drawing?.title).toBe("SKÅDIS gravity holder");
    if (OUT) {
      // one STL per printed part, as modelled (turn each to its print axis in the slicer)
      const { doc, scope } = posed(s);
      for (const b of Object.values(out)) {
        const name = componentOf(s.doc, b.sketchId);
        if (!b.mesh || !PRINTED.includes(name)) continue;
        const bytes = await exportFeatureBytes(doc, scope, b.featureId, "stl");
        if (bytes) writeFileSync(`${OUT}/skadis-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.stl`, bytes);
      }
    }
  }, 300000);

});
