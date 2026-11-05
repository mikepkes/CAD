// The agent's side of notes: draw a diagram with note.add (path data), list and
// read notes back (strokes as path data, the background as an image block), look
// at a drawing with notes_render — on the in-app surface and the headless server.
import { describe, it, expect, afterEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { buildTools as buildAgentTools, runAgent, setAgentClientFactory, type MessagesClient } from "../src/model/agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { realSession } from "./helpers";
import { createDefaultRegistry } from "../src/core/command/builtins";
import { buildTools, type WebMcpHost, type WebMcpResult } from "../src/model/webmcp";
import { withAgentAuthor } from "../src/core/notes";
import { createCadMcpServer } from "../mcp/server";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG = `data:image/png;base64,${PNG_B64}`;
const json = (r: WebMcpResult | { content: unknown }) => JSON.parse((r.content as { type: string; text: string }[]).find((c) => c.type === "text")!.text);

/** The store's host, minus the viewport: commands signed by the agent, notes read from the session. */
function appHost() {
  const session = realSession();
  const rendered: { id: string; size: number }[] = [];
  const host: WebMcpHost = {
    registry: createDefaultRegistry(),
    runCommand: async (type, params) => { const r = await session.dispatch(type, withAgentAuthor(type, params)); return { ok: r.ok, createdIds: r.createdIds, error: r.error, message: r.message }; },
    describe: () => ({}),
    render: async () => { throw new Error("no viewport"); },
    notes: () => session.doc.notes ?? [],
    renderNote: async (id, size) => { rendered.push({ id, size }); return PNG_B64; },
  };
  const tools = buildTools(host);
  const call = (name: string, args: Record<string, unknown> = {}) => tools.find((t) => t.name === name)!.execute(args);
  return { session, tools, call, rendered };
}

describe("notes over WebMCP", () => {
  it("an agent draws a diagram, and reads it back as path data in the 1000×1000 space", async () => {
    const { call, session } = appHost();
    const r = json(await call("note.add", { title: "Rib idea", body: "Add a **rib** here", strokes: [{ path: "M100 500 L900 500 M500 100 L500 900", color: "#d33", width: 6 }], anchor: { point: { x: 0, y: 0, z: 10 } } }));
    expect(r.ok).toBe(true);
    const id = r.createdIds[0];
    expect(session.doc.notes![0].author).toBe("agent");

    const list = json(await call("notes_list"));
    expect(list.notes).toMatchObject([{ id, title: "Rib idea", author: "agent", strokes: 2, hasBackground: false, excerpt: "Add a rib here", anchor: { point: { x: 0, y: 0, z: 10 } } }]);

    const got = await call("notes_get", { id });
    const d = json(got);
    expect(d.body).toBe("Add a **rib** here");
    expect(d.drawing.strokes).toEqual([
      { color: "#d33", width: 6, path: "M100 500L900 500" },
      { color: "#d33", width: 6, path: "M500 100L500 900" },
    ]);
    expect(got.content.some((c) => c.type === "image")).toBe(false); // no background, no image
  });

  it("returns a person's captured view as an image beside the strokes", async () => {
    const { call, session } = appHost();
    await session.dispatch("note.add", { title: "Look here", author: "human", drawing: { background: PNG, strokes: [{ points: [[0.2, 0.2], [0.4, 0.4]] }] } });
    const id = session.doc.notes![0].id;
    const got = await call("notes_get", { id });
    expect(got.content.find((c) => c.type === "image")).toEqual({ type: "image", data: PNG_B64, mimeType: "image/png" });
    expect(json(got).drawing.background).toMatch(/attached/);
    expect((await call("notes_get", { id, background: false })).content).toHaveLength(1);
  });

  it("notes_render returns the composited drawing as a PNG", async () => {
    const { call, session, rendered } = appHost();
    await session.dispatch("note.add", { title: "x", strokes: [{ path: "M0 0 L10 10" }] });
    const id = session.doc.notes![0].id;
    const r = await call("notes_render", { id, size: 5000 });
    expect(r.content[0]).toEqual({ type: "image", data: PNG_B64, mimeType: "image/png" });
    expect(rendered).toEqual([{ id, size: 1600 }]);
    expect((await call("notes_render", { id: "nope" })).isError).toBe(true);
  });

  it("an agent adds to a person's drawing and answers in the body; the person stays the author", async () => {
    const { call, session } = appHost();
    await session.dispatch("note.add", { title: "Q", body: "Is this too thin?", author: "human" });
    const id = session.doc.notes![0].id;
    expect(json(await call("note.stroke.add", { id, strokes: [{ path: "M300 300 A 100 100 0 1 1 299 300", color: "#2563eb" }] })).ok).toBe(true);
    await call("note.update", { id, body: "Is this too thin?\n\n**Agent:** yes — 1.2 mm; I'd go to 2 mm." });
    expect(session.doc.notes![0]).toMatchObject({ author: "human", updatedBy: "agent" });
    expect(session.doc.notes![0].drawing!.strokes[0].points.length).toBeGreaterThan(10);
  });

  it("explains a stroke in the wrong space", async () => {
    const { call } = appHost();
    const r = await call("note.add", { title: "x", strokes: [{ points: [{ x: 500, y: 500 }] }] });
    expect(r.isError).toBe(true);
    expect(json(r).error).toMatch(/give `path`/);
  });

  it("annotates the readers read-only", () => {
    const { tools } = appHost();
    for (const n of ["notes_list", "notes_get", "notes_render"]) expect(tools.find((t) => t.name === n)!.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((t) => t.name === "note.delete")!.annotations).toMatchObject({ destructiveHint: true });
  });
});

describe("notes for the in-app agent", () => {
  afterEach(() => setAgentClientFactory(null));

  it("lists notes, and sees a drawing and its captured view as images", async () => {
    const session = realSession();
    await session.dispatch("note.add", { title: "Look", author: "human", drawing: { background: PNG, strokes: [{ path: "M0 0 L10 10" }] } });
    const id = session.doc.notes![0].id;
    let n = 0;
    const sent: Anthropic.MessageParam[][] = [];
    const turns = [
      { content: [{ type: "tool_use", id: "t1", name: "notes_list", input: {} }, { type: "tool_use", id: "t2", name: "notes_get", input: { id } }, { type: "tool_use", id: "t3", name: "notes_render", input: { id } }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "seen" }], stop_reason: "end_turn" },
    ] as unknown as Anthropic.Message[];
    const fake: MessagesClient = { messages: { create: async (body) => { sent.push(structuredClone(body.messages)); return turns[n++]; } } };
    setAgentClientFactory(() => fake);
    const tools: { name: string; ok: boolean }[] = [];
    await runAgent({
      apiKey: "k", model: "m", history: [{ role: "user", content: "what did I draw?" }], registry: createDefaultRegistry(),
      ctx: { describe: () => ({}), runCommand: async () => ({ ok: true }), render: async () => { throw new Error("no"); }, notes: () => session.doc.notes ?? [], renderNote: async () => PNG_B64 },
      onText: () => {}, onTool: (name, ok) => tools.push({ name, ok }),
    });
    expect(tools).toEqual([{ name: "notes_list", ok: true }, { name: "notes_get", ok: true }, { name: "notes_render", ok: true }]);
    const results = (sent[1].at(-1)!.content as Anthropic.ToolResultBlockParam[]);
    expect(JSON.parse(results[0].content as string).notes[0]).toMatchObject({ id, hasBackground: true });
    expect((results[1].content as { type: string }[]).map((c) => c.type)).toEqual(["text", "image"]);
    expect((results[2].content as { type: string; source: { data: string } }[])[0].source.data).toBe(PNG_B64);
    expect(buildAgentTools(createDefaultRegistry()).some((t) => t.name === "note__add")).toBe(true);
  });
});

describe("notes on the headless server", () => {
  it("writes and reads notes, signed by the agent", async () => {
    const { server, getSession } = createCadMcpServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const add = json(await client.callTool({ name: "note__add", arguments: { title: "Hi", strokes: [{ path: "M0 0 L1000 1000" }] } }));
    expect(add.ok).toBe(true);
    expect(getSession().doc.notes![0].author).toBe("agent");
    const list = json(await client.callTool({ name: "notes_list", arguments: {} }));
    expect(list.notes[0]).toMatchObject({ title: "Hi", strokes: 1 });
    const got = json(await client.callTool({ name: "notes_get", arguments: { id: add.createdIds[0] } }));
    expect(got.drawing.strokes[0].path).toBe("M0 0L1000 1000");
    const doc = json(await client.callTool({ name: "get_document", arguments: {} }));
    expect(doc.notes).toHaveLength(1);
  });
});
