// A reference part (component.setReference): context the design is made around
// but that isn't made itself — the item a holder grips, the board it hangs on.
// It is marked on the component (and inherited down the tree), saved with the
// document, kept out of the print files and Save's format choice, and still
// collides with the parts it touches.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, sessionFromDoc } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { referenceOf, isReferenceBody } from "../src/core/document";
import { collideFeatures, evaluateFeatures, exportFusedBlob, printPartsByMaterial } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import { serializeDocument, deserializeDocument } from "../src/core/persistence";
import { printFormat } from "../src/model/store";
import type { CadSession } from "../src/core/command/session";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

/** A 20 mm printed block, and a stand-in (in a component of its own, under a holder component) sunk 2 mm into it. */
async function model() {
  const s = realSession();
  const d = async (type: string, params: Record<string, unknown>) => (await s.dispatch(type, params)).createdIds?.[0] as string;
  const pla = await d("material.create", { name: "PLA", kind: "printed", color: "#d8b98a" });
  const toy = await d("material.create", { name: "Stand-in", kind: "plastic", color: "#c9e33a" });
  const part = await d("component.create", { name: "Block" });
  const holder = await d("component.create", { name: "Holder" });
  const item = await d("component.create", { name: "Item", parent: holder });
  await s.dispatch("material.assign", { component: part, material: pla });
  await s.dispatch("material.assign", { component: item, material: toy });
  const box = async (component: string, z0: number, name: string) => {
    const sk = await d("sketch.create", { plane: "XY", offset: z0, component, name });
    await s.dispatch("sketch.addRectangle", { sketch: sk, corner: { x: 0, y: 0 }, opposite: { x: 20, y: 20 } });
    return d("feature.extrude", { sketch: sk, distance: "20", name });
  };
  const block = await box(part, 0, "Block");
  const stand = await box(item, 18, "Item");
  await s.recompute();
  return { s, part, holder, item, block, stand };
}

/** The z span of a binary STL. */
function stlZ(buf: ArrayBuffer): [number, number] {
  const dv = new DataView(buf);
  let lo = Infinity, hi = -Infinity;
  for (let t = 0; t < dv.getUint32(80, true); t++) for (let v = 0; v < 3; v++) { const z = dv.getFloat32(84 + t * 50 + 12 + v * 12 + 8, true); lo = Math.min(lo, z); hi = Math.max(hi, z); }
  return [lo, hi];
}

describe("reference parts", () => {
  let m: Awaited<ReturnType<typeof model>>;
  let s: CadSession;
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); m = await model(); s = m.s; }, 120000);

  it("marks a component, its children inherit it, and it can be a part again", async () => {
    expect(referenceOf(s.doc, m.item)).toBeUndefined();
    expect((await s.dispatch("component.setReference", { component: m.holder, show: "solid" })).ok).toBe(true);
    expect(referenceOf(s.doc, m.item)).toBe("solid");                 // from its parent
    await s.dispatch("component.setReference", { component: m.item });
    expect(s.doc.components[m.item].reference).toBe("ghost");         // its own wins (the default show)
    await s.dispatch("component.setReference", { component: m.holder, reference: false });
    expect(s.doc.components[m.holder].reference).toBeUndefined();
    expect(referenceOf(s.doc, m.item)).toBe("ghost");
    expect(referenceOf(s.doc, m.part)).toBeUndefined();
    expect((await s.dispatch("component.setReference", { component: s.doc.rootComponentId })).ok).toBe(false);
    // saved with the document: it replays
    const back = sessionFromDoc(deserializeDocument(serializeDocument(s.doc)));
    await back.recompute();
    expect(back.doc.components[m.item].reference).toBe("ghost");
  });

  it("is left out of the print files and Save's choice of format, but still collides", async () => {
    await s.recompute();
    const scope = resolveParameters(s.doc.parameters).scope;
    const solids = evaluateFeatures(s.doc, scope);
    expect(isReferenceBody(s.doc, solids[m.stand])).toBe(true);
    expect(isReferenceBody(s.doc, solids[m.block])).toBe(false);
    // one print material left: an STL, not a two-part 3MF
    expect(printFormat(s.doc, solids)).toBe("stl");
    expect(printPartsByMaterial(s.doc, scope).map((p) => p.name)).toEqual(["PLA"]);
    const stl = exportFusedBlob(s.doc, scope, "stl")!;
    const [lo, hi] = stlZ(await stl.arrayBuffer());
    expect(lo).toBeCloseTo(0, 3);
    expect(hi).toBeCloseTo(20, 3);                                    // the stand-in (up to 38) isn't in it
    // the overlap with the stand-in is still found: it rests on, presses on, what it touches
    const c = collideFeatures(s.doc, scope);
    expect(c.overlaps.map((o) => o.volume)).toEqual([expect.closeTo(800, 1)]);
    // a part again: back in the file
    await s.dispatch("component.setReference", { component: m.item, reference: false });
    expect(printPartsByMaterial(s.doc, scope).length).toBe(2);
  }, 120000);
});
