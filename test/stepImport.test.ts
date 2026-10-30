import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, exportFeatureBlob, bodyTopology, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import { serializeDocument, deserializeDocument } from "../src/core/persistence";
import type { CadSession } from "../src/core/command/session";

// STEP import: a part exported to STEP and read back is the same solid (exact
// volume, area, centroid); an import can start a body or cut one; and the file
// travels inside the saved document.

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
const scopeOf = (s: CadSession) => resolveParameters(s.doc.parameters).scope;
const bodies = (s: CadSession): SolidEval[] => {
  const out = evaluateFeatures(s.doc, scopeOf(s));
  const errs = Object.values(out).filter((r) => r.error);
  if (errs.length) throw new Error(errs.map((r) => r.error).join("; "));
  return Object.values(out).filter((r) => r.mesh);
};

/** A filleted, drilled block exported to STEP text. */
async function partStep(): Promise<{ step: string; ref: SolidEval }> {
  const s = realSession();
  const box = (await s.dispatch("feature.primitive", { shape: "box", x: 30, y: 20, z: 10 })).createdIds[0];
  await s.dispatch("feature.fillet", { radius: "2", edges: { parallelTo: "Z" } });
  await s.dispatch("feature.hole", { at: [{ x: 5, y: 0, z: 5 }], diameter: "4", throughAll: true });
  const blob = exportFeatureBlob(s.doc, scopeOf(s), box, "step")!;
  return { step: await blob.text(), ref: bodies(s)[0] };
}

describe("STEP import", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("round-trips a part: export → import gives the same exact solid", async () => {
    const { step, ref } = await partStep();
    expect(step.startsWith("ISO-10303-21")).toBe(true);
    const s = realSession();
    const r = await s.dispatch("feature.import", { data: step, name: "Block" });
    expect(r.ok).toBe(true);
    const [b] = bodies(s);
    expect(b.volume).toBeCloseTo(ref.volume!, 6);
    expect(b.area).toBeCloseTo(ref.area!, 6);
    expect(b.centroid!.x).toBeCloseTo(ref.centroid!.x, 6);
    const names = bodyTopology(s.doc, scopeOf(s))[0].faces.map((f) => f.name);
    expect(names[0]).toBe(`${r.createdIds[0]}:f0`);
  });

  it("offsets the import and can cut it from another body", async () => {
    const { step, ref } = await partStep();
    const s = realSession();
    await s.dispatch("feature.primitive", { shape: "box", x: 100, y: 100, z: 20, at: { x: 0, y: 0, z: 30 } });
    const moved = await s.dispatch("feature.import", { data: step, at: { x: 0, y: 0, z: 30 }, operation: "cut" });
    expect(moved.ok).toBe(true);
    const [b] = bodies(s);
    expect(b.volume).toBeCloseTo(100 * 100 * 20 - ref.volume!, 4);
  });

  it("rejects text that isn't STEP", async () => {
    const s = realSession();
    const r = await s.dispatch("feature.import", { data: "solid cube\nendsolid" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not a STEP file/);
  });

  it("keeps the file in the saved document", async () => {
    const { step, ref } = await partStep();
    const s = realSession();
    await s.dispatch("feature.import", { data: step });
    const again = realSession();
    const loaded = deserializeDocument(serializeDocument(s.doc));
    again.doc = loaded;
    await again.recompute();
    expect(bodies(again)[0].volume).toBeCloseTo(ref.volume!, 6);
  });
});
