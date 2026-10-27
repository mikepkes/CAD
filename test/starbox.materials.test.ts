// The star box's print material (test/starbox.model.ts, MATERIALS): each
// material's snap sizing checked with the beam solver, and its geometry built,
// closed and twisted at the default size and the corners of the size sliders.
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { collideFeatures } from "../src/core/features";
import { materialForComponent } from "../src/core/document";
import type { CadSession } from "../src/core/command/session";
import { WIDTH, HEIGHT, WIDTH_RANGE, HEIGHT_RANGE, MATERIALS, DEFAULT_MATERIAL, wall, dis, buildStarBox, closeBox, expanded, twistOverlaps, tongueBeam, faceForce, snapScope } from "./starbox.model";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

describe("star box print materials", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  // The material table's derivation, kept as a check: at every height each
  // material's tongue stays within its strain limit, and at the default height it
  // closes and pulls open with about the force of the TPU 68D box that works.
  it("sizes the snaps per material: strain within the limit, forces like the box that works", async () => {
    const s = realSession();
    await buildStarBox(s);
    const ref = tongueBeam(snapScope(s, DEFAULT_MATERIAL, HEIGHT), MATERIALS[DEFAULT_MATERIAL].E).force;
    const tpu = MATERIALS[DEFAULT_MATERIAL];
    const refIn = faceForce(ref, tpu.mu, tpu.leadIn), refOut = faceForce(ref, tpu.mu, tpu.retain);
    const rows = MATERIALS.flatMap((m, i) => [HEIGHT_RANGE[0], HEIGHT, HEIGHT_RANGE[1]].map((height) => {
      const sc = snapScope(s, i, height), b = tongueBeam(sc, m.E);
      return { m, height, sc, b, fin: faceForce(b.force, m.mu, sc.leadIn), fout: faceForce(b.force, m.mu, sc.retention) };
    }));
    console.log(rows.map(({ m, height, sc, b, fin, fout }) =>
      `${m.name.padEnd(22)} h ${height}: δ ${sc.deflection.toFixed(2)} mm, lead ${sc.leadIn}°, strain ${(b.strain * 100).toFixed(2)}% (limit ${m.strain * 100}%), push ${b.force.toFixed(1)} N, close ${fin.toFixed(1)} N, open ${fout.toFixed(1)} N per snap`).join("\n"));
    for (const { m, height, sc, b, fin, fout } of rows) {
      expect(b.strain, `${m.name} at height ${height}`).toBeLessThanOrEqual(m.strain * 1.03);
      expect(wall - sc.deflection - 0.3, `${m.name}: wall left behind the pocket`).toBeGreaterThanOrEqual(0.8 - 1e-9);
      if (height !== HEIGHT || m.name === "TPU 95A") continue;
      expect(fin / refIn, `${m.name}: closing force vs TPU 68D`).toBeGreaterThan(0.8);
      expect(fin / refIn, `${m.name}: closing force vs TPU 68D`).toBeLessThan(1.25);
      expect(fout / refOut, `${m.name}: opening force vs TPU 68D`).toBeGreaterThan(0.8);
      expect(fout / refOut, `${m.name}: opening force vs TPU 68D`).toBeLessThan(1.25);
    }
    // soft TPU can't push hard at any printable size: it holds by its grip
    const soft = MATERIALS.findIndex((m) => m.name === "TPU 95A"), sc = snapScope(s, soft, HEIGHT);
    expect(faceForce(tongueBeam(sc, MATERIALS[soft].E).force, MATERIALS[soft].mu, sc.retention)).toBeGreaterThan(5);
  }, 120000);

  // Every material's geometry: closes cleanly and resists a twist, at the default
  // size and the extreme corners of the size sliders. One test per size, letting
  // the event loop breathe between the long kernel calls, so vitest's worker can
  // still report progress when the machine is loaded.
  const breathe = () => new Promise((r) => setTimeout(r, 0));
  for (const [i, m] of MATERIALS.entries()) {
    if (i === DEFAULT_MATERIAL) continue; // test/starbox.build.test.ts
    describe(`printed in ${m.name}`, () => {
      let s: CadSession;
      beforeAll(async () => {
        s = realSession();
        await buildStarBox(s);
        await dis(s, "parameter.set", { name: "material", expression: String(i) });
      }, 120000);

      for (const [width, height] of [[WIDTH, HEIGHT], [WIDTH_RANGE[0], HEIGHT_RANGE[0]], [WIDTH_RANGE[1], HEIGHT_RANGE[1]]]) {
        it(`closes cleanly and binds against a twist at ${width} × ${height}`, async () => {
          await dis(s, "parameter.set", { name: "width", expression: String(width) });
          await dis(s, "parameter.set", { name: "height", expression: String(height) });
          await closeBox(s);
          for (const sk of Object.values(s.doc.sketches)) expect(sk.status.conflicting, `sketch ${sk.name}`).toBe(false);
          expect(materialForComponent(s.doc, Object.values(s.doc.components).find((c) => c.name === "Star half")!.id)?.name).toBe(m.name);
          await breathe();
          const { doc, scope } = expanded(s);
          const c = collideFeatures(doc, scope);
          expect(c.buildError).toBeUndefined();
          expect(c.maxOverlap, JSON.stringify(c.overlaps)).toBeLessThan(0.05);
          await breathe();
          const [neg, pos] = await twistOverlaps(s, [-1.5, 1.5]);
          expect(neg).toBeGreaterThan(1);
          expect(pos).toBeGreaterThan(1);
        }, 300000);
      }
    });
  }
});
