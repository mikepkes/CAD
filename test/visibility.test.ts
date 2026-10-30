import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, exportFusedBlob, bodyTopology } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import { serializeDocument, deserializeDocument } from "../src/core/persistence";
import { hiddenIds, bodyVisible, sketchVisible, isolationList } from "../src/core/visibility";
import { createCadMcpServer } from "../mcp/server";
import type { CadSession } from "../src/core/command/session";

// Visibility: display-only document state. Hidden things aren't drawn, but a
// hidden body still exists for booleans, measurement and export.

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
const scopeOf = (s: CadSession) => resolveParameters(s.doc.parameters).scope;
const bodies = (s: CadSession) => Object.values(evaluateFeatures(s.doc, scopeOf(s))).filter((b) => b.mesh);

/** A box in the root and a cylinder sketched in a child component. */
async function scene() {
  const s = realSession();
  const box = (await s.dispatch("feature.primitive", { shape: "box", x: 10, y: 10, z: 10 })).createdIds[0];
  const comp = (await s.dispatch("component.create", { name: "Pin" })).createdIds[0];
  const sk = (await s.dispatch("sketch.create", { plane: "XY", component: comp })).createdIds[0];
  await s.dispatch("sketch.addCircle", { sketch: sk, center: { x: 30, y: 0 }, radius: 2 });
  const pin = (await s.dispatch("feature.extrude", { sketch: sk, distance: "8" })).createdIds[0];
  return { s, box, comp, sk, pin };
}

describe("visibility", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("hides a body by id and everything in a hidden component", async () => {
    const { s, box, comp, sk, pin } = await scene();
    const [b, p] = [bodies(s).find((x) => x.featureId === box)!, bodies(s).find((x) => x.featureId === pin)!];
    expect(bodyVisible(s.doc, b) && bodyVisible(s.doc, p)).toBe(true);
    await s.setVisibility([box], false);
    expect(bodyVisible(s.doc, b)).toBe(false);
    expect(bodyVisible(s.doc, p)).toBe(true);
    await s.setVisibility([comp], false);
    expect(bodyVisible(s.doc, p)).toBe(false);      // inside the hidden component
    expect(sketchVisible(s.doc, sk)).toBe(false);
    await s.setVisibility([box, comp], true);
    expect(hiddenIds(s.doc).size).toBe(0);
  });

  it("is display only: hidden bodies still build, measure and export", async () => {
    const { s, box, pin } = await scene();
    await s.setVisibility([box, pin], false);
    expect(bodies(s).length).toBe(2);
    expect(bodyTopology(s.doc, scopeOf(s), { bodyId: box, faces: false, edges: false })[0].volume).toBeCloseTo(1000, 6);
    const step = await exportFusedBlob(s.doc, scopeOf(s), "step")!.text();
    expect(step.startsWith("ISO-10303-21")).toBe(true);
  });

  it("is undoable, stays off the timeline, and is saved", async () => {
    const { s, box } = await scene();
    const ops = s.doc.operations.length;
    await s.setVisibility([box], false);
    expect(s.doc.operations.length).toBe(ops);
    s.undo();
    expect(s.doc.hidden).toBeUndefined();
    s.redo();
    const again = realSession();
    again.doc = deserializeDocument(serializeDocument(s.doc));
    await again.recompute();
    expect(again.doc.hidden).toEqual([box]);
  });

  it("rejects unknown ids but drops stale ones quietly", async () => {
    const { s, box, pin } = await scene();
    expect((await s.setVisibility(["nope"], false)).error).toMatch(/Nothing to hide/);
    await s.setVisibility([pin], false);
    const op = s.doc.operations.find((o) => o.createdIds.includes(pin))!;
    await s.deleteOperation(op.opId);                           // pin's feature is gone
    expect((await s.setVisibility([box], false)).ok).toBe(true); // the stale "pin" entry doesn't block it
    expect(s.doc.hidden).toEqual([box]);
  });

  it("isolate keeps the given ids and whatever lives in a kept component", async () => {
    const { s, box, comp, sk, pin } = await scene();
    const rows = bodies(s);
    expect(isolationList(s.doc, rows, [box]).sort()).toEqual([pin, sk].sort());
    expect(isolationList(s.doc, rows, [comp])).toEqual([box]);
    expect(() => isolationList(s.doc, rows, ["ghost"])).toThrow(/Nothing called/);
  });

  it("a configuration can hide things while it is active", async () => {
    const { s, box, pin } = await scene();
    await s.dispatch("configuration.create", { name: "Pin only", hide: [box] });
    await s.setActiveConfiguration("Pin only");
    const rows = bodies(s);
    expect(bodyVisible(s.doc, rows.find((b) => b.featureId === box)!)).toBe(false);
    expect(bodyVisible(s.doc, rows.find((b) => b.featureId === pin)!)).toBe(true);
    await s.setActiveConfiguration(null);
    expect(hiddenIds(s.doc).size).toBe(0);
    await s.dispatch("configuration.create", { name: "Bad", hide: ["zz"] });
    expect(s.doc.configurations.find((c) => c.name === "Bad")!.warnings).toEqual(['nothing to hide called "zz"']);
  });

  it("works over the headless MCP server", async () => {
    const { server, getSession } = createCadMcpServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
    await call("feature__primitive", { shape: "box", x: 10, y: 10, z: 10 });
    await call("feature__primitive", { shape: "sphere", radius: 3, at: { x: 20, y: 0, z: 0 } });
    const [box, ball] = Object.keys(getSession().doc.features);
    expect((await call("set_visibility", { ids: [box], visible: false })).hidden).toEqual([box]);
    expect((await call("isolate", { ids: [box] })).hidden).toEqual([ball]);
    expect((await call("isolate", { ids: null })).hidden).toEqual([]);
    expect((await call("get_document", {})).hidden).toEqual([]);
  });
});
