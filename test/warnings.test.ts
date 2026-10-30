import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import type { CadSession } from "../src/core/command/session";

// A fillet/chamfer/shell that changes nothing must NOT silently report success:
// it either errors (OCC rejected it) or warns (it ran but moved no material),
// the same courtesy booleans already extend.
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

function evalById(s: CadSession, prefix: string) {
  const scope = resolveParameters(s.doc.parameters).scope;
  return Object.values(evaluateFeatures(s.doc, scope)).find((e) => e.featureId.startsWith(prefix));
}
async function box(s: CadSession) {
  const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
  await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: -10, y: -10 }, opposite: { x: 10, y: 10 } });
  await s.dispatch("feature.extrude", { sketch: sid, distance: "20" });
}

describe("no-op warnings", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("a fillet that matches no edges is not silent", async () => {
    const s = realSession();
    await box(s);
    // no edges live in the plane z=999 → OCC rejects it outright
    await s.dispatch("feature.fillet", { radius: "2", edges: { inPlane: { plane: "XY", offset: 999 } } });
    const e = evalById(s, "fil");
    expect(e?.error ?? e?.warning).toBeTruthy();
    expect(e?.error ?? e?.warning).toMatch(/no edge|changed nothing/i);
  });

  it("a real fillet neither errors nor warns", async () => {
    const s = realSession();
    await box(s);
    await s.dispatch("feature.fillet", { radius: "2", edges: { parallelTo: "Z" } });
    const e = evalById(s, "fil");
    expect(e?.error).toBeUndefined();
    expect(e?.warning).toBeUndefined();
  });

  it("a shell whose wall is too thick to remove material warns", async () => {
    const s = realSession();
    await box(s);
    // a 50mm wall cannot hollow a 20mm-tall box → it moves no material
    await s.dispatch("feature.shell", { thickness: "50", openFaces: { inPlane: { plane: "XY", offset: 20 } } });
    const e = evalById(s, "shl");
    expect(e?.warning).toMatch(/changed nothing/i);
  });

  it("a real shell neither errors nor warns", async () => {
    const s = realSession();
    await box(s);
    await s.dispatch("feature.shell", { thickness: "2", openFaces: { inPlane: { plane: "XY", offset: 20 } } });
    const e = evalById(s, "shl");
    expect(e?.error).toBeUndefined();
    expect(e?.warning).toBeUndefined();
  });
});
