// feature.gear's edge break (`chamfer`): a new gear gets a small chamfer all round
// its teeth at each end face, a round bore, a ring's rim and a hub's end — built
// into the solid, not cut (slow) or OCC-chamfered (fragile) — on every gear type: always
// a valid solid a sliver smaller than the sharp one, the same size overall and
// the same in the middle of its face (where it meshes). A gear recorded before
// the option existed replays sharp; `chamfer: false` keeps it sharp.
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, sessionFromDoc, FULL } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, SolidEval } from "../src/core/features";
import { placeComponentSketches } from "../src/core/recompute";
import { resolveParameters } from "../src/core/parameters";
import { buildGearSolid, chamferSize, GearSolidSpec } from "../src/core/occ/gear";
import { serializeDocument, deserializeDocument } from "../src/core/persistence";
import type { CadSession } from "../src/core/command/session";
import { measureVolume, makeBox, type Shape3D } from "replicad";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

const solidsOf = (s: CadSession): Record<string, SolidEval> => {
  const scope = resolveParameters(s.doc.parameters).scope;
  placeComponentSketches(s.doc, scope);
  return evaluateFeatures(s.doc, scope);
};

type BB = { min: number[]; max: number[] };
const box = (sh: Shape3D): BB => { const b = (sh as unknown as { boundingBox: { bounds: [number[], number[]] } }).boundingBox.bounds; return { min: b[0], max: b[1] }; };
/** The volume of `sh` inside the slab z0..z1 (a box far wider than any gear). */
const slab = (sh: Shape3D, z0: number, z1: number) => {
  const b = makeBox([-500, -500, z0], [500, 500, z1]) as unknown as Shape3D;
  const c = (sh as unknown as { intersect: (o: Shape3D) => Shape3D }).intersect(b);
  try { return measureVolume(c); } finally { (c as unknown as { delete(): void }).delete(); (b as unknown as { delete(): void }).delete(); }
};

const CASES: [string, GearSolidSpec, [number, number]][] = [
  // [name, spec, a slab in the middle of the face width where nothing may change]
  ["spur, bore and hub", { type: "spur", module: 2, teeth: 20, faceWidth: 8, bore: 5, hubDiameter: 12, hubLength: 5, backlash: 0.1 }, [2, 6]],
  ["spur, small module", { type: "spur", module: 0.5, teeth: 30, faceWidth: 3, bore: 3 }, [0.5, 2.5]],
  ["spur, D-flat", { type: "spur", module: 1.5, teeth: 18, faceWidth: 6, bore: 5, dFlat: 4.5 }, [1.5, 4.5]],
  ["spur, keyway and spokes", { type: "spur", module: 2, teeth: 36, faceWidth: 8, bore: 8, keyway: 2, spokes: 5 }, [2, 6]],
  ["helical", { type: "helical", module: 2, teeth: 28, faceWidth: 7, helixAngle: 20, bore: 5, spokes: 5 }, [2, 5]],
  ["helical, few teeth", { type: "helical", module: 2, teeth: 9, faceWidth: 7, helixAngle: 25, bore: 4 }, [2, 5]],
  ["herringbone, hub", { type: "herringbone", module: 2, teeth: 14, faceWidth: 7, helixAngle: 30, bore: 5, hubDiameter: 11, hubLength: 5.5 }, [2, 5]],
  ["ring", { type: "ring", module: 1.5, teeth: 36, faceWidth: 9, rim: 3.5 }, [2, 7]],
  ["ring, herringbone", { type: "ring", module: 2, teeth: 36, faceWidth: 8, helixAngle: 20, herringbone: true, rim: 5 }, [2, 6]],
  ["rack", { type: "rack", module: 2, teeth: 17, faceWidth: 7, rim: 6 }, [2, 5]],
  ["rack, helical", { type: "rack", module: 2, teeth: 10, faceWidth: 8, helixAngle: 20 }, [2, 6]],
  ["rack, chevron", { type: "rack", module: 2, teeth: 10, faceWidth: 8, helixAngle: 20, herringbone: true }, [2, 6]],
  ["bevel", { type: "bevel", module: 2, teeth: 21, mateTeeth: 14, faceWidth: 7, bore: 5 }, [1.5, 3.5]],
  ["bevel, hub", { type: "bevel", module: 2, teeth: 16, mateTeeth: 24, faceWidth: 8, bore: 5, hubDiameter: 12, hubLength: 4 }, [1.5, 4]],
  ["worm", { type: "worm", module: 2, teeth: 1, wormDiameter: 16, faceWidth: 30, bore: 5 }, [3, 27]],
  ["worm, two starts", { type: "worm", module: 1, teeth: 2, wormDiameter: 10, faceWidth: 20 }, [2, 18]],
];

const SLAB = new Set(["spur, bore and hub", "helical", "ring", "rack", "bevel", "worm"]);

describe("gear chamfer", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  for (const [name, spec, [z0, z1]] of CASES) {
    it(`${name}: a valid solid a sliver smaller, the same size, unchanged mid-face`, () => {
      const warnings: string[] = [];
      const sharp = buildGearSolid(spec);
      const t = Date.now();
      const broken = buildGearSolid({ ...spec, chamfer: true }, (w) => warnings.push(w));
      const ms = Date.now() - t;
      expect(warnings, name).toEqual([]);
      const v0 = measureVolume(sharp), v1 = measureVolume(broken);
      expect(v1, name).toBeLessThan(v0 - 1e-3);
      expect(v1, name).toBeGreaterThan(0.97 * v0);
      // the same size, within the chamfer: it takes corners, not extent (the tips still reach full radius
      // mid-face — though a helical gear of few teeth may reach its widest at an end, and a bevel's
      // widest section, the heel, moves up the cone)
      const a = box(sharp), b = box(broken), tol = 1.25 * chamferSize(spec); // (its depth along the axis)
      for (let i = 0; i < 3; i++) for (const k of ["min", "max"] as const) expect(Math.abs(b[k][i] - a[k][i]), `${name} ${k} ${i}`).toBeLessThan(tol);
      // where the teeth mesh, mid-face, nothing changed (a boolean each side: one of each kind by
      // default, every case in the extended run)
      if (FULL || SLAB.has(name)) {
        const s0 = slab(sharp, z0, z1);
        expect(Math.abs(slab(broken, z0, z1) - s0), name).toBeLessThan(1e-5 * s0);
      }
      console.log(`${name}: chamfer ${chamferSize(spec).toFixed(3)} mm, ${(v0 - v1).toFixed(2)} mm³ off, ${ms} ms`);
      (sharp as unknown as { delete(): void }).delete(); (broken as unknown as { delete(): void }).delete();
    }, 120000);
  }

  it("is on for a new gear, off when asked, and off for a gear recorded before it existed", async () => {
    const s = realSession();
    const on = (await s.dispatch("feature.gear", { type: "spur", module: 2, teeth: 20, faceWidth: 8 })).createdIds![0];
    const off = (await s.dispatch("feature.gear", { type: "spur", module: 2, teeth: 20, faceWidth: 8, chamfer: false, x: 60 })).createdIds![0];
    expect(s.doc.operations.map((o) => o.params.chamfer)).toEqual([true, false]);
    const out = solidsOf(s);
    expect(out[on].warning).toBeUndefined();
    expect(out[on].volume!).toBeLessThan(out[off].volume! - 1);
    // an old file: the same op without the flag replays sharp
    const old = JSON.parse(serializeDocument(s.doc));
    delete old.operations[0].params.chamfer;
    const s2 = sessionFromDoc(deserializeDocument(JSON.stringify(old)));
    await s2.recompute();
    const out2 = solidsOf(s2);
    expect(out2[on].volume!).toBeCloseTo(out[off].volume!, 3);
  }, 120000);
});
