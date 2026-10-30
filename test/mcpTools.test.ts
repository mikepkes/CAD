import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { createDefaultRegistry } from "../src/core/command/builtins";
import { InlineGeometryBackend } from "../src/core/geometry/backend";
import { buildTools, type WebMcpHost } from "../src/model/webmcp";
import { createCadMcpServer } from "../mcp/server";

// The agent-facing additions on both MCP surfaces: batch with rollback,
// measure, body_topology, sketch_on_face by face name, and tool annotations.

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
const text = (r: { content: unknown }) => JSON.parse((r.content as { type: string; text: string }[]).find((c) => c.type === "text")!.text);

/** The in-app tool surface over a real session + kernel (the store's host, minus the viewport). */
function appHost() {
  const registry = createDefaultRegistry();
  const session = realSession();
  const geometry = new InlineGeometryBackend();
  const host: WebMcpHost = {
    registry,
    runCommand: async (type, params) => { const r = await session.dispatch(type, params); return { ok: r.ok, createdIds: r.createdIds, error: r.error }; },
    describe: () => ({ operations: session.doc.operations.length }),
    render: async () => { throw new Error("no viewport"); },
    topology: (opts) => geometry.topology(session.doc, opts),
    distance: (a, b) => geometry.distance(session.doc, a, b),
    checkpoint: () => session.checkpoint(),
    rollback: async (cp) => session.rollback(cp as ReturnType<typeof session.checkpoint>),
  };
  const tools = buildTools(host);
  const call = async (name: string, args: Record<string, unknown> = {}) => tools.find((t) => t.name === name)!.execute(args);
  return { session, tools, call };
}

describe("in-app MCP tools", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("batch rolls the whole transaction back when a step fails", async () => {
    const { session, call } = appHost();
    await call("feature.primitive", { shape: "box", x: 10, y: 10, z: 10 });
    const ops = session.doc.operations.length;
    const r = await call("batch", { steps: [
      { tool: "feature.primitive", arguments: { shape: "box", x: 5, y: 5, z: 5, at: { x: 20, y: 0, z: 0 } } },
      { tool: "feature.primitive", arguments: { shape: "sphere", radius: 3, at: { x: 40, y: 0, z: 0 } } },
      { tool: "feature.fillet", arguments: {} }, // missing its required radius → fails
    ] });
    expect(r.isError).toBe(true);
    const out = text(r);
    expect(out).toMatchObject({ ok: false, failedStep: 2, rolledBack: true });
    expect(out.results.map((x: { ok: boolean }) => x.ok)).toEqual([true, true, false]);
    expect(out.results[0].ms).toBeGreaterThanOrEqual(0);
    expect(session.doc.operations.length).toBe(ops); // both boxes' sibling steps undone
    expect(session.canUndo()).toBe(true);           // and the pre-batch history is intact
    session.undo();
    expect(session.doc.operations.length).toBe(ops - 1);
  });

  it("batch with atomic:false keeps the steps that succeeded", async () => {
    const { session, call } = appHost();
    const r = await call("batch", { atomic: false, steps: [
      { tool: "feature.primitive", arguments: { shape: "box", x: 5, y: 5, z: 5 } },
      { tool: "no_such_tool" },
    ] });
    expect(text(r)).toMatchObject({ ok: false, failedStep: 1, rolledBack: false });
    expect(session.doc.operations.length).toBe(1);
  });

  it("measure reports exact mass properties and the gap between bodies", async () => {
    const { call, session } = appHost();
    await call("feature.primitive", { shape: "box", x: 10, y: 20, z: 30 });
    await call("feature.primitive", { shape: "sphere", radius: 5, at: { x: 25, y: 0, z: 0 } });
    const [a, b] = Object.keys(session.doc.features);
    const m = text(await call("measure", { between: [a, b] }));
    expect(m.bodies[0]).toMatchObject({ id: a, volume: 6000, area: 2200, centroid: { x: 0, y: 0, z: 0 } });
    expect(m.distance).toBeCloseTo(25 - 5 - 5, 6);
  });

  it("body_topology lists named faces and edges", async () => {
    const { call, session } = appHost();
    await call("feature.primitive", { shape: "box", x: 10, y: 10, z: 10 });
    const id = Object.keys(session.doc.features)[0];
    const t = text(await call("body_topology", { body: id }));
    expect(t.bodies[0].faces.map((f: { name: string }) => f.name)).toContain(`${id}:+Z`);
    expect(t.bodies[0].faces.find((f: { name: string }) => f.name === `${id}:+Z`)).toMatchObject({ type: "plane", area: 100, normal: { x: 0, y: 0, z: 1 } });
    expect(t.bodies[0].edges.length).toBe(12);
    expect(t.bodies[0].edges.map((e: { name: string }) => e.name)).toContain(`${id}:+X|${id}:+Z`);
  });

  it("annotates every tool: queries read-only, deletes destructive", async () => {
    const { tools } = appHost();
    expect(tools.every((t) => t.annotations)).toBe(true);
    const ann = (n: string) => tools.find((t) => t.name === n)!.annotations!;
    expect(ann("get_state")).toMatchObject({ readOnlyHint: true });
    expect(ann("measure")).toMatchObject({ readOnlyHint: true });
    expect(ann("body_topology")).toMatchObject({ readOnlyHint: true });
    expect(ann("sketch.deleteEntities")).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(ann("feature.extrude")).toMatchObject({ readOnlyHint: false, destructiveHint: false, title: "Extrude" });
    expect(ann("batch")).toMatchObject({ destructiveHint: true });
  });
});

describe("headless MCP server", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  async function connect() {
    const { server, getSession } = createCadMcpServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return { client, getSession };
  }

  it("lists annotated tools and runs an atomic batch", async () => {
    const { client, getSession } = await connect();
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "get_document")?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((t) => t.name === "delete_operation")?.annotations).toMatchObject({ destructiveHint: true });
    const r = await client.callTool({ name: "batch", arguments: { steps: [
      { tool: "feature__primitive", arguments: { shape: "box", x: 10, y: 10, z: 10 } },
      { tool: "feature__shell", arguments: { thickness: "1" } }, // missing openFaces → fails
    ] } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatchObject({ ok: false, failedStep: 1, rolledBack: true });
    expect(getSession().doc.operations.length).toBe(0);
  });

  it("sketches on a face by name and measures through the server", async () => {
    const { client, getSession } = await connect();
    await client.callTool({ name: "feature__primitive", arguments: { shape: "box", x: 20, y: 20, z: 20 } });
    const box = Object.keys(getSession().doc.features)[0];
    const topo = text(await client.callTool({ name: "body_topology", arguments: { edges: false } }));
    expect(topo.bodies[0].faces.length).toBe(6);
    const sk = text(await client.callTool({ name: "sketch_on_face", arguments: { face: `${box}:+Z` } }));
    expect(sk).toMatchObject({ ok: true, face: `${box}:+Z`, frame: { normal: { x: 0, y: 0, z: 1 } } });
    expect(sk.frame.origin.z).toBeCloseTo(10, 9);
    expect(getSession().doc.sketches[sk.sketchId].faceRef?.name).toBe(`${box}:+Z`);
    const m = text(await client.callTool({ name: "measure", arguments: {} }));
    expect(m.bodies[0].volume).toBe(8000);
  });
});
