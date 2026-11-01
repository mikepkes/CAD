// End-to-end: the androgynous snap-together star box (built in
// test/starbox.model.ts). Proves the two copies close without interpenetrating,
// that the snaps are real (without the pockets, the barbs dig into the mating
// wall), that a twist binds, that every corner of the size sliders stays sound,
// and that the committed example matches the builder. Writes the example:
//   BUILD_STARBOX=/abs/out npx vitest run test/starbox.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, forkSession, itFull, expectCommittedExample } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { serializeDocument } from "../src/core/persistence";
import { collideFeatures, evaluateFeatures, type SolidEval } from "../src/core/features";
import type { CadSession } from "../src/core/command/session";
import { instanceSolids } from "../src/core/assembly";
import { placeComponentSketches } from "../src/core/recompute";
import { HEIGHT, WIDTH_RANGE, HEIGHT_RANGE, L, dis, buildStarBox, closeBox, expanded, twistOverlaps, meshVolume } from "./starbox.model";

const OUT = process.env.BUILD_STARBOX || "";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

describe("androgynous snap-together star box", () => {
  // built once: the tests below change forks of it
  let built: CadSession;
  beforeAll(async () => {
    await initKernel({ wasmBinary: wasm });
    built = realSession();
    await buildStarBox(built);
    await built.recompute();
  }, 60000);

  // One test for what were four, each of which built and evaluated the box
  // again: the generator makes the committed example; it opens on one half, as
  // printed; ticking fullBox closes the two copies into a 64×61×28 star without
  // interpenetrating; and the rebuild path (collision, motion study) builds the
  // same two halves as the mesh-instancing path the viewport draws.
  // (Regression: the rebuild path used to drop cloned offset/face sketch planes
  // onto XY and skip sketch-less modifiers, the base round, so its instances
  // differed from what the render path showed.)
  it("builds the committed example, one half as printed; closed, two copies make a 64×61×28 star without interpenetrating, the same on both paths", async () => {
    if (OUT) writeFileSync(`${OUT}/starbox.vibecad.json`, serializeDocument(built.doc));
    expectCommittedExample(built, "starbox");
    const s = await forkSession(built);
    const zRange = (bodies: SolidEval[]) => {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const b of bodies) for (let i = 0; i < b.mesh!.positions.length; i++) { lo[i % 3] = Math.min(lo[i % 3], b.mesh!.positions[i]); hi[i % 3] = Math.max(hi[i % 3], b.mesh!.positions[i]); }
      return { lo, hi };
    };

    // the fullBox checkbox: one half, open side up, with its tongues standing above the rim
    expect(s.doc.parameters.find((p) => p.name === "fullBox")).toMatchObject({ boolean: true, values: [0, 1], value: 0 });
    {
      const { doc, scope } = expanded(s);
      const open = Object.values(evaluateFeatures(doc, scope)).filter((b) => b.mesh);
      expect(open.length).toBe(1);
      expect(zRange(open).hi[2]).toBeCloseTo(HEIGHT / 2 + L, 1);
    }

    await closeBox(s);
    const { doc, scope } = expanded(s);
    const rebuilt = evaluateFeatures(doc, scope);
    const bodies = Object.values(rebuilt).filter((b) => b.mesh);
    expect(bodies.length).toBe(2);
    for (const body of bodies) {
      // shell + 5 tongues − cavity − 5 pockets − base round
      expect(meshVolume(body.mesh!.positions, body.mesh!.indices)).toBeGreaterThan(12000);
      expect(meshVolume(body.mesh!.positions, body.mesh!.indices)).toBeLessThan(12600);
    }
    const { lo, hi } = zRange(bodies);
    expect(hi[0] - lo[0]).toBeCloseTo(64, 0);
    expect(hi[1] - lo[1]).toBeCloseTo(61.2, 0);
    expect(hi[2] - lo[2]).toBeCloseTo(HEIGHT, 1); // the halves meet rim to rim
    expect(hi[2]).toBeCloseTo(HEIGHT, 1);

    // the mesh-instancing path: the same two halves
    placeComponentSketches(s.doc, scope);
    const fast = Object.values(instanceSolids(s.doc, scope, evaluateFeatures(s.doc, scope))).filter((b) => b.mesh);
    expect(fast.length).toBe(2);
    for (const f of fast) {
      const r = rebuilt[f.featureId];
      expect(r?.error).toBeUndefined();
      expect(r.volume!).toBeCloseTo(f.volume!, 0);
      for (const k of ["min", "max"] as const) for (const ax of ["x", "y", "z"] as const) expect(r.bounds![k][ax]).toBeCloseTo(f.bounds![k][ax], 1); // tessellation differs with orientation
    }

    const c = collideFeatures(doc, scope);
    expect(c.buildError).toBeUndefined();
    expect(c.maxOverlap).toBeLessThan(0.05);
  }, 120000);

  it("twisting the closed box either way binds: each edge has a clip and an opposing key", async () => {
    const [neg, zero, pos] = await twistOverlaps(built, [-1.5, 0, 1.5]);
    console.log(`twist with keys: -1.5° ${neg.toFixed(2)} mm³, 0° ${zero.toFixed(2)}, +1.5° ${pos.toFixed(2)}`);
    expect(zero).toBeLessThan(0.05);
    expect(neg).toBeGreaterThan(1);
    expect(pos).toBeGreaterThan(1);
  }, 120000);

  // The v2 failure, kept as a check that the keys are what fixes it. (Extended run.)
  itFull("without the keys, a twist one way slides every barb free", async () => {
    const s = realSession();
    await buildStarBox(s, { keys: false });
    await s.recompute();
    const [neg, pos] = await twistOverlaps(s, [-1.5, 3]);
    console.log(`twist without keys: -1.5° ${neg.toFixed(2)} mm³, +3° ${pos.toFixed(2)}`);
    expect(neg).toBeGreaterThan(1);
    expect(pos).toBeLessThan(0.05);
  }, 120000);

  // Size and height are customize sliders: every corner of their range must
  // still close cleanly, measure what was asked for, and resist a twist.
  // (Extended run: by default the example suite builds the committed example
  // at each slider's ends, and the box closes cleanly and binds at its own size.)
  for (const width of WIDTH_RANGE) for (const height of HEIGHT_RANGE) {
    itFull(`stays sound at width ${width} × height ${height}`, async () => {
      const s = await forkSession(built);
      await dis(s, "parameter.set", { name: "width", expression: String(width) });
      await dis(s, "parameter.set", { name: "height", expression: String(height) });
      await closeBox(s);
      const { doc, scope } = expanded(s);
      const bodies = Object.values(evaluateFeatures(doc, scope)).filter((b) => b.mesh);
      expect(bodies.length).toBe(2);
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const b of bodies) for (let i = 0; i < b.mesh!.positions.length; i++) { lo[i % 3] = Math.min(lo[i % 3], b.mesh!.positions[i]); hi[i % 3] = Math.max(hi[i % 3], b.mesh!.positions[i]); }
      expect(hi[0] - lo[0]).toBeCloseTo(width, 1);
      expect(hi[2] - lo[2]).toBeCloseTo(height, 1);
      const c = collideFeatures(doc, scope);
      expect(c.buildError).toBeUndefined();
      expect(c.maxOverlap, JSON.stringify(c.overlaps)).toBeLessThan(0.05);
      const [neg, pos] = await twistOverlaps(s, [-1.5, 1.5]);
      expect(neg).toBeGreaterThan(1);
      expect(pos).toBeGreaterThan(1);
    }, 120000);
  }

  // (Extended run.)
  itFull("the snaps engage: without the pockets every barb digs into the mating wall", async () => {
    const s = realSession();
    await buildStarBox(s, { pockets: false });
    await closeBox(s);
    const { doc, scope } = expanded(s);
    const c = collideFeatures(doc, scope);
    // ~9mm³ of barb sits behind the 2.15mm lip at each of the 10 snaps
    expect(c.maxOverlap).toBeGreaterThan(60);
  }, 120000);
});
