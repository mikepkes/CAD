import { describe, it, expect, afterEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { realSession } from "./helpers";
import type { CadSession } from "../src/core/command/session";
import {
  AssistInbox, AssistService, AssistWatcher, ASSIST_INBOX_URI, ASSIST_MODEL, ASSIST_SYSTEM, assistContext, assistReplyMessage,
  buildNamingRequest, cleanName, heuristicName, inboxSections, isAssistRequest, isDefaultName, parseNamingResponse, renameViaEdit,
  setAssistHost, onAssistChange, getAssistHost,
} from "../src/model/assist";
import { buildTools as buildWebTools, type WebMcpHost } from "../src/model/webmcp";
import { buildTools as buildAgentTools, runAgent, setAgentClientFactory, type MessagesClient } from "../src/model/agent";
import { handleMcpRpc } from "../src/model/desktopMcp";
import { createDefaultRegistry } from "../src/core/command/builtins";
import { replayClient } from "../src/demo/agentReplay";
import { createCadMcpServer } from "../mcp/server";

// Organizational assist: the inbox, when things are queued, the context a namer gets, the naming
// request through the agent's client hook, and the tools / resources on every MCP surface.

const text = (r: { content: unknown }) => JSON.parse((r.content as { type: string; text: string }[]).find((c) => c.type === "text")!.text);

/** A sketch with a 40 × 20 rectangle and one dimension. */
async function rectSketch(s: CadSession, name?: string) {
  const r = await s.dispatch("sketch.create", { plane: "XY", ...(name ? { name } : {}) });
  const sk = r.createdIds[0];
  const rect = await s.dispatch("sketch.addRectangle", { sketch: sk, corner: { x: 0, y: 0 }, opposite: { x: 40, y: 20 } });
  const line = rect.createdIds.find((id) => s.doc.sketches[sk].entities[id]?.kind === "line")!;
  await s.dispatch("sketch.addDimension", { sketch: sk, type: "distance", a: line, expression: "40" });
  return sk;
}

function service(s: CadSession) {
  return new AssistService({
    doc: () => s.doc,
    rename: (target, name) => renameViaEdit(s.doc, target, name, (opId, params) => s.editOperation(opId, params), () => s.doc),
  });
}

afterEach(() => { setAssistHost(null); setAgentClientFactory(null); });

describe("the inbox", () => {
  it("queues once per target, resolves, dismisses and notifies", () => {
    const inbox = new AssistInbox();
    let changes = 0;
    inbox.subscribe(() => changes++);
    const a = inbox.enqueue("sketch1", "sketch", "Sketch 1")!;
    expect(inbox.enqueue("sketch1", "sketch", "Sketch 1")).toBeNull();
    const b = inbox.enqueue("ext2", "feature", "Extrude")!;
    expect(inbox.pending().map((i) => i.id)).toEqual([a.id, b.id]);
    inbox.markDone(a.id, "Base profile", "agent", 10);
    inbox.dismiss(b.id, 11);
    expect(inbox.pending()).toEqual([]);
    expect(inbox.get(a.id)).toMatchObject({ status: "done", name: "Base profile", by: "agent", resolved: 10 });
    expect(inboxSections(inbox.all())).toMatchObject({ pending: [], recent: [{ id: a.id }] });
    expect(changes).toBe(4);
  });

  it("cleans names", () => {
    expect(cleanName('  "Back plate profile."\n')).toBe("Back plate profile");
    expect(cleanName("")).toBe("");
    expect(cleanName(42)).toBe("");
    expect(cleanName("x".repeat(80)).length).toBe(48);
  });
});

describe("when things are queued", () => {
  it("knows a default name from a chosen one", async () => {
    const s = realSession();
    const a = await rectSketch(s);
    const b = await rectSketch(s, "Lid outline");
    const e = (await s.dispatch("feature.extrude", { sketch: a, distance: "5" })).createdIds[0];
    const f = (await s.dispatch("feature.extrude", { sketch: b, distance: "5", name: "Lid" })).createdIds[0];
    expect(isDefaultName(s.doc, s.doc.operations, a)).toBe(true);
    expect(isDefaultName(s.doc, s.doc.operations, b)).toBe(false);
    expect(isDefaultName(s.doc, s.doc.operations, e)).toBe(true);
    expect(isDefaultName(s.doc, s.doc.operations, f)).toBe(false);
  });

  it("queues a sketch once it is finished, a feature as it appears, and nothing already in an opened document", async () => {
    const s = realSession();
    const old = await rectSketch(s);
    const w = new AssistWatcher();
    expect(w.observe({ scope: s, doc: s.doc, openSketchId: null })).toEqual({ reset: true, targets: [] }); // the baseline
    const sk = await rectSketch(s);
    expect(w.observe({ scope: s, doc: s.doc, openSketchId: sk }).targets).toEqual([]); // still being drawn
    expect(w.observe({ scope: s, doc: s.doc, openSketchId: null }).targets).toEqual([{ target: sk, targetKind: "sketch", from: s.doc.sketches[sk].name }]);
    const ext = (await s.dispatch("feature.extrude", { sketch: sk, distance: "5" })).createdIds[0];
    expect(w.observe({ scope: s, doc: s.doc, openSketchId: null }).targets).toEqual([{ target: ext, targetKind: "feature", from: "Extrude" }]);
    // undo + redo brings back the same op: not queued again
    s.undo(); w.observe({ scope: s, doc: s.doc, openSketchId: null });
    s.redo();
    expect(w.observe({ scope: s, doc: s.doc, openSketchId: null }).targets).toEqual([]);
    expect(old).not.toBe(sk);
  });

  it("headless: the newest sketch nothing reads yet is still open", async () => {
    const s = realSession();
    const w = new AssistWatcher();
    w.observe({ scope: s, doc: s.doc });
    const sk = await rectSketch(s);
    expect(w.observe({ scope: s, doc: s.doc }).targets).toEqual([]);
    const ext = (await s.dispatch("feature.extrude", { sketch: sk, distance: "5" })).createdIds[0];
    expect(w.observe({ scope: s, doc: s.doc }).targets.map((t) => t.target)).toEqual([sk, ext]); // sketch first
  });

  it("drops items whose target is undone and marks ones renamed elsewhere as done", async () => {
    const s = realSession();
    const svc = service(s);
    svc.observe({ scope: s, doc: s.doc });
    const sk = await rectSketch(s);
    const ext = (await s.dispatch("feature.extrude", { sketch: sk, distance: "5" })).createdIds[0];
    svc.observe({ scope: s, doc: s.doc });
    expect(svc.inbox.pending().map((i) => i.target)).toEqual([sk, ext]);
    s.undo();
    svc.observe({ scope: s, doc: s.doc });
    expect(svc.inbox.pending().map((i) => i.target)).toEqual([sk]);
    const op = s.doc.operations.find((o) => o.createdIds[0] === sk)!;
    await s.editOperation(op.opId, { ...op.params, name: "Mine" });
    svc.observe({ scope: s, doc: s.doc });
    expect(svc.inbox.all().find((i) => i.target === sk)).toMatchObject({ status: "done", name: "Mine", by: "user" });
    // a different document re-baselines and clears
    const other = realSession();
    expect(svc.observe({ scope: other, doc: other.doc })).toEqual([]);
    expect(svc.inbox.all()).toEqual([]);
  });

  it("queues nothing while the assist is off", async () => {
    const s = realSession();
    const svc = new AssistService({ doc: () => s.doc, rename: async () => ({ ok: true }), status: () => ({ enabled: false, agent: false }) });
    svc.observe({ scope: s, doc: s.doc });
    await s.dispatch("feature.primitive", { shape: "box", x: 1, y: 1, z: 1 });
    expect(svc.observe({ scope: s, doc: s.doc })).toEqual([]);
    expect(svc.view()).toMatchObject({ enabled: false, pending: 0 });
  });
});

describe("context and names", () => {
  it("gives a sketch's plane, entities, size, dimensions and what uses it", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "depth", expression: "8" });
    const sk = await rectSketch(s);
    await s.dispatch("feature.extrude", { sketch: sk, distance: "depth", operation: "new" });
    const ctx = assistContext(s.doc, { target: sk, targetKind: "sketch" }) as { sketch: Record<string, unknown>; usedBy: Record<string, unknown>[] };
    expect(ctx.sketch).toMatchObject({ plane: "XY", entities: { line: 4 }, size: { width: 40, height: 20 } });
    expect(ctx.sketch.dimensions).toEqual([{ type: "distance", expr: "40", value: 40 }]);
    expect(ctx.usedBy[0]).toMatchObject({ kind: "extrude", operation: "new", distanceExpr: "depth" });
    expect(heuristicName({ targetKind: "sketch", from: "Sketch 1" }, ctx)).toBe("Base profile");
    const ext = Object.keys(s.doc.features)[0];
    const fctx = assistContext(s.doc, { target: ext, targetKind: "feature" }) as Record<string, unknown>;
    expect(fctx.feature).toMatchObject({ kind: "extrude", sketchId: { sketch: sk } });
    expect(fctx.parameters).toEqual([{ name: "depth", expr: "8", value: 8 }]);
    expect((fctx.sketches as unknown[]).length).toBe(1);
  });

  it("builds one small naming request and reads its answer", () => {
    const req = buildNamingRequest([{ id: "as1", targetKind: "sketch", from: "Sketch 1", context: { sketch: { entities: { circle: 1 } } } }]);
    expect(req).toMatchObject({ model: ASSIST_MODEL, system: ASSIST_SYSTEM, thinking: { type: "disabled" }, output_config: { effort: "low", format: { type: "json_schema" } } });
    expect(ASSIST_MODEL).toBe("claude-haiku-5-5");
    expect(isAssistRequest(req)).toBe(true);
    expect(isAssistRequest({ system: "something else" })).toBe(false);
    const msg = { stop_reason: "end_turn", content: [{ type: "text", text: '{"names":[{"id":"as1","name":" Hole circle. "},{"id":"as2","name":""}]}' }] } as unknown as Anthropic.Message;
    expect(parseNamingResponse(msg)).toEqual({ as1: "Hole circle" });
    expect(() => parseNamingResponse({ stop_reason: "refusal", content: [] } as unknown as Anthropic.Message)).toThrow(/declined/);
    expect(() => parseNamingResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "nope" }] } as unknown as Anthropic.Message)).toThrow(/unreadable/);
    expect(parseNamingResponse(assistReplyMessage(req))).toEqual({ as1: "Circle sketch" });
    expect(parseNamingResponse(assistReplyMessage(req, { "Sketch 1": "Bore" }))).toEqual({ as1: "Bore" });
  });

  it("the video's replay client answers a naming request without using up a turn", async () => {
    const client = replayClient({ prompt: "p", model: "m", source: "test", names: { "Sketch 1": "Plate" }, turns: [{ delayMs: 0, stop_reason: "end_turn", content: [{ type: "text", text: "built", citations: null }] }] });
    const req = buildNamingRequest([{ id: "as1", targetKind: "sketch", from: "Sketch 1", context: {} }]);
    expect(parseNamingResponse(await client.messages.create(req))).toEqual({ as1: "Plate" });
    const turn = await client.messages.create({ model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(turn.content[0]).toMatchObject({ type: "text", text: "built" });
  });
});

describe("resolving", () => {
  it("renames through the creating op (undoable), dismisses, and rejects bad input", async () => {
    const s = realSession();
    const svc = service(s);
    svc.observe({ scope: s, doc: s.doc });
    const sk = await rectSketch(s);
    const ext = (await s.dispatch("feature.extrude", { sketch: sk, distance: "5" })).createdIds[0];
    svc.observe({ scope: s, doc: s.doc, openSketchId: null });
    const [a, b] = svc.inbox.pending();
    expect(await svc.resolve({ id: a.id, name: "Back plate profile" })).toEqual({ ok: true, id: a.id, target: sk, name: "Back plate profile" });
    expect(s.doc.sketches[sk].name).toBe("Back plate profile");
    expect(s.doc.operations.find((o) => o.createdIds[0] === sk)!.params.name).toBe("Back plate profile");
    expect(svc.inbox.get(a.id)).toMatchObject({ status: "done", by: "external" });
    expect(await svc.resolve({ id: b.id, name: "  " })).toMatchObject({ ok: false });
    expect(await svc.resolve({ id: "nope", name: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/get_assist_inbox/) });
    expect(await svc.resolve({ id: b.id, dismiss: true })).toMatchObject({ ok: true, dismissed: true });
    expect(s.doc.features[ext].name).toBe("Extrude");
    s.undo();
    expect(s.doc.sketches[sk].name).toMatch(/^Sketch \d+$/);
  });
});

describe("the tools", () => {
  async function liveService() {
    const s = realSession();
    const svc = service(s);
    svc.observe({ scope: s, doc: s.doc });
    const sk = await rectSketch(s);
    svc.observe({ scope: s, doc: s.doc, openSketchId: null });
    setAssistHost(svc);
    return { s, svc, sk };
  }

  it("get_assist_inbox / resolve_assist on the in-app MCP surface", async () => {
    const { s, sk } = await liveService();
    const tools = buildWebTools({ registry: createDefaultRegistry(), runCommand: async () => ({ ok: true }), describe: () => ({}), render: async () => { throw new Error("no"); } } as WebMcpHost);
    const call = (name: string, args: Record<string, unknown> = {}) => tools.find((t) => t.name === name)!.execute(args);
    expect(tools.find((t) => t.name === "get_assist_inbox")!.annotations).toMatchObject({ readOnlyHint: true });
    const inbox = text(await call("get_assist_inbox"));
    expect(inbox).toMatchObject({ enabled: true, pending: 1, items: [{ target: sk, targetKind: "sketch", status: "pending", context: { sketch: { plane: "XY" } } }] });
    const r = await call("resolve_assist", { id: inbox.items[0].id, name: "Base plate" });
    expect(r.isError).toBeFalsy();
    expect(s.doc.sketches[sk].name).toBe("Base plate");
    expect((await call("resolve_assist", { id: "x", name: "y" })).isError).toBe(true);
    setAssistHost(null);
    expect(text(await call("get_assist_inbox"))).toMatchObject({ pending: 0, note: expect.any(String) });
  });

  it("the embedded agent's tools include them, and its loop runs them", async () => {
    const { s, sk } = await liveService();
    const names = buildAgentTools(createDefaultRegistry()).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_assist_inbox", "resolve_assist", "set_panel", "run_action"]));
    const id = (getHostItems())[0];
    let n = 0;
    const turns: Anthropic.Message[] = [
      { content: [{ type: "tool_use", id: "t1", name: "resolve_assist", input: { id, name: "Plate profile" } }], stop_reason: "tool_use" } as unknown as Anthropic.Message,
      { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } as unknown as Anthropic.Message,
    ];
    const fake: MessagesClient = { messages: { create: async () => turns[n++] } };
    setAgentClientFactory(() => fake);
    const tools: { name: string; ok: boolean }[] = [];
    await runAgent({ apiKey: "k", model: "m", history: [{ role: "user", content: "name it" }], registry: createDefaultRegistry(), ctx: { describe: () => ({}), runCommand: async () => ({ ok: true }), render: async () => { throw new Error("no"); } }, onText: () => {}, onTool: (name, ok) => tools.push({ name, ok }) });
    expect(tools).toEqual([{ name: "resolve_assist", ok: true }]);
    expect(s.doc.sketches[sk].name).toBe("Plate profile");
  });

  it("the desktop server lists and reads the inbox resource", async () => {
    const { sk } = await liveService();
    const init = await handleMcpRpc({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, []) as { result: { capabilities: Record<string, unknown> } };
    expect(init.result.capabilities.resources).toEqual({ subscribe: true, listChanged: false });
    const list = await handleMcpRpc({ id: 2, method: "resources/list" }, []) as { result: { resources: { uri: string }[] } };
    expect(list.result.resources.map((r) => r.uri)).toEqual([ASSIST_INBOX_URI]);
    const read = await handleMcpRpc({ id: 3, method: "resources/read", params: { uri: ASSIST_INBOX_URI } }, []) as { result: { contents: { text: string }[] } };
    expect(JSON.parse(read.result.contents[0].text).items[0].target).toBe(sk);
    expect(await handleMcpRpc({ id: 4, method: "resources/subscribe", params: { uri: ASSIST_INBOX_URI } }, [])).toMatchObject({ result: {} });
    expect(await handleMcpRpc({ id: 5, method: "resources/read", params: { uri: "vibecad://nope" } }, [])).toMatchObject({ error: { code: -32002 } });
  });

  it("every inbox change reaches the hub's listeners once per tick", async () => {
    const { s, svc } = await liveService();
    let heard = 0;
    const off = onAssistChange(() => heard++);
    await Promise.resolve();
    heard = 0;
    await s.dispatch("feature.primitive", { shape: "box", x: 1, y: 1, z: 1 });
    svc.observe({ scope: s, doc: s.doc, openSketchId: null });
    svc.inbox.patch(svc.inbox.pending()[0].id, { attempted: true });
    await Promise.resolve();
    expect(heard).toBe(1);
    off();
  });
});

describe("headless MCP server", () => {
  it("serves the inbox as tools and a subscribable resource, and notifies on change", async () => {
    const { server, getSession } = createCadMcpServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => { updates.push(n.params.uri); });
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual([ASSIST_INBOX_URI]);
    await client.subscribeResource({ uri: ASSIST_INBOX_URI });
    const sk = text(await client.callTool({ name: "sketch__create", arguments: { plane: "XY" } })).createdIds[0];
    await client.callTool({ name: "sketch__addCircle", arguments: { sketch: sk, center: { x: 0, y: 0 }, radius: 5 } });
    await client.callTool({ name: "feature__extrude", arguments: { sketch: sk, distance: "3" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(updates).toContain(ASSIST_INBOX_URI);
    const inbox = text(await client.callTool({ name: "get_assist_inbox", arguments: {} }));
    expect(inbox.items.map((i: { targetKind: string }) => i.targetKind)).toEqual(["sketch", "feature"]);
    const read = await client.readResource({ uri: ASSIST_INBOX_URI });
    expect(JSON.parse((read.contents[0] as { text: string }).text).pending).toBe(2);
    const r = text(await client.callTool({ name: "resolve_assist", arguments: { id: inbox.items[0].id, name: "Peg profile" } }));
    expect(r).toMatchObject({ ok: true, name: "Peg profile" });
    expect(getSession().doc.sketches[sk].name).toBe("Peg profile");
  });
});

/** The pending ids on the installed host. */
function getHostItems(): string[] { return getAssistHost()!.view().items.map((i) => i.id); }
