import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, GeometryCache, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import { serializeDocument, deserializeDocument } from "../src/core/persistence";
import { parseConfigTable } from "../src/ui/ParametersPanel";
import { createCadMcpServer } from "../mcp/server";
import { buildTools, type WebMcpHost } from "../src/model/webmcp";
import type { CadSession } from "../src/core/command/session";

// Configuration tables: named rows of parameter overrides (and suppressed
// features) that switch the whole model between variants without touching the
// timeline.

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
const scopeOf = (s: CadSession) => resolveParameters(s.doc.parameters).scope;
const volumes = (s: CadSession, cache?: GeometryCache) =>
  Object.values(evaluateFeatures(s.doc, scopeOf(s), cache)).filter((b: SolidEval) => b.mesh).map((b) => Math.round(b.volume!)).sort((a, b) => a - b);

/** A width × 10 × 10 block with a lid (a second box) on top, plus Small/Large rows. */
async function variants() {
  const s = realSession();
  await s.dispatch("parameter.add", { name: "width", expression: "20" });
  await s.dispatch("feature.primitive", { shape: "box", x: "width", y: 10, z: 10 });
  const lid = (await s.dispatch("feature.primitive", { shape: "box", x: "width", y: 10, z: 2, at: { x: 0, y: 0, z: 20 } })).createdIds[0];
  const small = await s.dispatch("configuration.create", { name: "Small", values: { width: 10 } });
  const large = await s.dispatch("configuration.create", { name: "Large", values: { width: "width_big" }, suppress: [lid] });
  return { s, lid, small: small.createdIds[0], large: large.createdIds[0] };
}

describe("configuration tables", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("switches parameters and suppression per configuration; default is the timeline's values", async () => {
    const { s } = await variants();
    await s.dispatch("parameter.add", { name: "width_big", expression: "40" });
    expect(volumes(s)).toEqual([400, 2000]);                 // default: width 20, lid on
    expect((await s.setActiveConfiguration("Small")).ok).toBe(true);
    expect(volumes(s)).toEqual([200, 1000]);                 // width 10
    const w = s.doc.parameters.find((p) => p.name === "width")!;
    expect(w).toMatchObject({ expr: "10", baseExpr: "20", configuredBy: "Small", value: 10 });
    await s.setActiveConfiguration("Large");
    expect(volumes(s)).toEqual([4000]);                      // width 40, lid suppressed
    await s.setActiveConfiguration(null);
    expect(volumes(s)).toEqual([400, 2000]);
    expect(s.doc.parameters.find((p) => p.name === "width")!.configuredBy).toBeUndefined();
  });

  it("switching is undoable and stays off the timeline", async () => {
    const { s, small } = await variants();
    const ops = s.doc.operations.length;
    await s.setActiveConfiguration(small);
    expect(s.doc.operations.length).toBe(ops);
    expect(s.doc.activeConfiguration).toBe(small);
    s.undo();
    expect(s.doc.activeConfiguration).toBeUndefined();
    s.redo();
    expect(s.doc.activeConfiguration).toBe(small);
  });

  it("edits merge cells, null removes one, and deleting the active row falls back to default", async () => {
    const { s, small } = await variants();
    await s.setActiveConfiguration(small);
    await s.dispatch("configuration.update", { configuration: "Small", values: { width: null }, name: "Tiny" });
    expect(s.doc.configurations.find((c) => c.id === small)).toMatchObject({ name: "Tiny", values: {} });
    expect(s.doc.parameters.find((p) => p.name === "width")!.value).toBe(20);
    await s.dispatch("configuration.delete", { configuration: "Tiny" });
    expect(s.doc.activeConfiguration).toBeUndefined();
  });

  it("flags a cell for a parameter or feature that no longer exists, without failing", async () => {
    const { s } = await variants();
    // Large's cell is for "width", which exists (its expression's own errors surface on the parameter)
    expect(s.doc.configurations.find((c) => c.name === "Large")!.warnings).toBeUndefined();
    await s.dispatch("configuration.create", { name: "Ghost", values: { depth: 5 }, suppress: ["prim99"] });
    expect(s.doc.configurations.find((c) => c.name === "Ghost")!.warnings).toEqual(['no parameter "depth"', 'no feature "prim99"']);
    expect((await s.setActiveConfiguration("Ghost")).ok).toBe(true);
    expect(volumes(s)).toEqual([400, 2000]);
  });

  it("rejects duplicate names and bad expressions", async () => {
    const { s } = await variants();
    expect((await s.dispatch("configuration.create", { name: "Small" })).error).toMatch(/exists/);
    expect((await s.dispatch("configuration.create", { name: "Bad", values: { width: "3 +" } })).ok).toBe(false);
    expect((await s.setActiveConfiguration("Nope")).error).toMatch(/No configuration/);
  });

  it("saves the active configuration with the document", async () => {
    const { s, small } = await variants();
    await s.setActiveConfiguration(small);
    const again = realSession();
    again.doc = deserializeDocument(serializeDocument(s.doc));
    await again.recompute();
    expect(again.doc.activeConfiguration).toBe(small);
    expect(volumes(again)).toEqual([200, 1000]);
  });

  it("previews a configuration without switching to it", async () => {
    const { s } = await variants();
    const doc = await s.previewConfiguration("Small");
    expect(doc.parameters.find((p) => p.name === "width")!.value).toBe(10);
    expect(s.doc.activeConfiguration).toBeUndefined();
  });

  it("flipping back to a recent configuration replays from cache", async () => {
    const { s } = await variants();
    const cache = new GeometryCache({ generations: 3 });
    volumes(s, cache);                                   // default
    await s.setActiveConfiguration("Small");
    volumes(s, cache);                                   // Small: both boxes rebuilt
    const m0 = cache.misses;
    await s.setActiveConfiguration(null);
    expect(volumes(s, cache)).toEqual([400, 2000]);
    expect(cache.misses - m0).toBe(0);                   // default again: nothing rebuilt
    const single = new GeometryCache();                  // keeping one generation can't do that
    volumes(s, single); await s.setActiveConfiguration("Small"); volumes(s, single);
    const m1 = single.misses; await s.setActiveConfiguration(null); volumes(s, single);
    expect(single.misses - m1).toBe(2);
  });

  it("the app's export_model writes one file per configuration", async () => {
    const saved: string[] = [];
    const asked: (string | null | undefined)[] = [];
    const tools = buildTools({
      registry: { toMcpTools: () => [] } as unknown as WebMcpHost["registry"],
      runCommand: async () => ({ ok: true }), describe: () => ({}), render: async () => { throw new Error("no viewport"); },
      configurations: () => [{ id: "cfg1", name: "Small" }, { id: "cfg2", name: "Large" }],
      exportModel: async (_f, _b, cfg) => { asked.push(cfg); return new Uint8Array([1, 2, 3]); },
      saveOutput: async (name) => { saved.push(name); return `/out/${name}`; },
    });
    const r = await tools.find((t) => t.name === "export_model")!.execute({ format: "step", all: true, filename: "bracket" });
    expect(JSON.parse((r.content[0] as { text: string }).text)).toMatchObject({ ok: true, files: [{ configuration: "Small" }, { configuration: "Large" }] });
    expect(asked).toEqual(["Small", "Large"]);
    expect(saved).toEqual(["bracket Small.step", "bracket Large.step"]);
  });

  it("parses a pasted table", () => {
    expect(parseConfigTable("name,width,height\nSmall,40,20\nLarge\t80\t\n")).toEqual([
      { name: "Small", values: { width: "40", height: "20" } },
      { name: "Large", values: { width: "80" } },
    ]);
  });

  it("works over MCP: set_configuration, get_document, export by configuration", async () => {
    const { server, getSession } = createCadMcpServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
    await call("parameter__add", { name: "w", expression: "20" });
    await call("feature__primitive", { shape: "box", x: "w", y: 10, z: 10 });
    await call("configuration__create", { name: "Wide", values: { w: 50 } });
    const set = await call("set_configuration", { configuration: "Wide" });
    expect(set.ok).toBe(true);
    const doc = await call("get_document", {});
    expect(doc.activeConfiguration).toBe("Wide");
    expect(doc.parameters[0]).toMatchObject({ name: "w", expr: "50", baseExpr: "20", configuredBy: "Wide" });
    await call("set_configuration", { configuration: null });
    expect(getSession().doc.activeConfiguration).toBeUndefined();
    const step = await call("export_model", { format: "step", configuration: "Wide" });
    expect(step.ok).toBe(true);
    expect(Buffer.from(step.base64, "base64").toString().startsWith("ISO-10303-21")).toBe(true);
    expect(getSession().doc.activeConfiguration).toBeUndefined(); // exporting a variant doesn't switch to it
  });
});
