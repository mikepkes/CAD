import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures } from "../src/core/features";
import { resolveParameters } from "../src/model/parameters";
import {
  InlineGeometryBackend, runGeometryJob, meshTransferables, GeometryRequest,
} from "../src/core/geometry/backend";
import type { CadSession } from "../src/core/command/session";

// The geometry-backend seam: proves the inline backend matches direct kernel
// use, and that the shared job handler returns results whose mesh buffers are
// transferable — the exact contract the Web/Node worker relies on.
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

async function boxSession(): Promise<CadSession> {
  const s = realSession();
  const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
  await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: -15, y: -15 }, opposite: { x: 15, y: 15 } });
  await s.dispatch("feature.extrude", { sketch: sid, distance: "25" });
  return s;
}
const zExtent = (p: Float32Array) => { let lo = Infinity, hi = -Infinity; for (let i = 2; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); } return hi - lo; };

describe("geometry backend", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("InlineGeometryBackend matches direct evaluateFeatures", async () => {
    const s = await boxSession();
    const backend = new InlineGeometryBackend();
    await backend.init({ wasmBinary: wasm });
    expect(backend.ready()).toBe(true);

    const { solids: viaBackend } = await backend.evaluate(s.doc);
    const direct = evaluateFeatures(s.doc, resolveParameters(s.doc.parameters).scope);
    expect(Object.keys(viaBackend).sort()).toEqual(Object.keys(direct).sort());
    const fid = Object.keys(viaBackend)[0];
    expect(viaBackend[fid].mesh!.triangleCount).toBe(direct[fid].mesh!.triangleCount);
    expect(zExtent(viaBackend[fid].mesh!.positions)).toBeCloseTo(25, 1);
  });

  it("the evaluate job returns meshes whose buffers are in the transfer list", async () => {
    const s = await boxSession();
    const req: GeometryRequest = { id: 1, kind: "evaluate", doc: s.doc };
    const { res, transfer } = await runGeometryJob(req);
    expect(res.kind).toBe("evaluate");
    if (res.kind !== "evaluate") throw new Error("unexpected");
    const mesh = Object.values(res.solids)[0].mesh!;
    // Every mesh buffer must be present in the transfer list (zero-copy handoff).
    expect(transfer).toContain(mesh.positions.buffer);
    expect(transfer).toContain(mesh.indices.buffer);
    expect(meshTransferables(res.solids).length).toBe(4); // one body × 4 arrays
  });

  it("the export job returns transferable bytes", async () => {
    const s = await boxSession();
    const fid = Object.keys(s.doc.features)[0];
    const { res, transfer } = await runGeometryJob({ id: 2, kind: "export", doc: s.doc, featureId: fid, format: "step" });
    expect(res.kind).toBe("export");
    if (res.kind !== "export") throw new Error("unexpected");
    expect(res.bytes!.byteLength).toBeGreaterThan(0);
    expect(transfer[0]).toBe(res.bytes!.buffer);
    // STEP is ASCII starting with "ISO-10303".
    expect(new TextDecoder().decode(res.bytes!.slice(0, 9))).toBe("ISO-10303");
  });

  it("the edges job returns a feature's world-space edges", async () => {
    const s = await boxSession();
    const fid = Object.keys(s.doc.features)[0];
    const { res } = await runGeometryJob({ id: 3, kind: "edges", doc: s.doc, featureId: fid });
    expect(res.kind).toBe("edges");
    if (res.kind !== "edges") throw new Error("unexpected");
    expect(res.edges.length).toBeGreaterThan(0); // a box has 12 edges
  });
});
