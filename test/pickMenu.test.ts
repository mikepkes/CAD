import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import { pickItems, faceTriangles } from "../src/model/pickMenu";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

describe("selection picker entries", () => {
  it("lists the near and far faces a ray crosses, named by their feature, nearest first, then planes", async () => {
    const s = realSession();
    const id = (await s.dispatch("feature.primitive", { shape: "box", x: "40", y: "40", z: "20", at: { x: 0, y: 0, z: 10 }, name: "Base" })).createdIds[0];
    const solids = evaluateFeatures(s.doc, resolveParameters(s.doc.parameters).scope);
    // a ray along -X through the box at y = 5, z = 12: in at +X, out at -X, then the YZ plane at x = 0 sits between
    const hits = {
      faces: [
        { bodyId: id, world: { x: 20, y: 5, z: 12 }, normal: { x: 1, y: 0, z: 0 } },
        { bodyId: id, world: { x: 20, y: 5.2, z: 12 }, normal: { x: 1, y: 0, z: 0 } }, // the same face again: one entry
        { bodyId: id, world: { x: -20, y: 5, z: 12 }, normal: { x: -1, y: 0, z: 0 } },
      ],
      planes: [{ planeId: "YZ", world: { x: 0, y: 5, z: 12 } }],
    };
    const items = pickItems(hits, solids, s.doc);
    expect(items.map((i) => i.label)).toEqual(["Base · +X", "Base · -X", "Right (YZ) plane"]);
    expect(items.map((i) => i.detail)).toEqual(["nearest", "behind, 1", "plane"]);
    const far = items[1];
    expect(far.kind === "face" && far.faceName).toBe(`${id}:-X`);
    const tris = faceTriangles(solids[id].mesh, far.kind === "face" ? far.faceName : undefined)!;
    expect(tris.length % 9).toBe(0);
    expect(tris.length).toBeGreaterThan(0);
    for (let i = 0; i < tris.length; i += 3) expect(tris[i]).toBeCloseTo(-20, 6); // every vertex on the -X face
    expect(faceTriangles(solids[id].mesh, "nope")).toBeNull();
  });
});
