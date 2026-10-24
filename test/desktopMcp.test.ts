import { describe, expect, it } from "vitest";
import { handleMcpRpc } from "../src/model/desktopMcp";
import type { WebMcpTool } from "../src/model/webmcp";

// The JSON-RPC layer the desktop (Tauri) MCP server answers with. Pure — no
// Tauri, no DOM — so it runs here against a fake toolset.
const tools: WebMcpTool[] = [
  {
    name: "echo",
    description: "echoes",
    inputSchema: { type: "object", properties: { v: { type: "string" } } },
    execute: async (args) => ({ content: [{ type: "text", text: String(args.v) }] }),
  },
  {
    name: "boom",
    description: "throws",
    inputSchema: { type: "object", properties: {} },
    execute: async () => { throw new Error("kaboom"); },
  },
];

describe("desktop MCP JSON-RPC handler", () => {
  it("initialize echoes a supported protocol version and advertises tools", async () => {
    const r = (await handleMcpRpc({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, tools)) as any;
    expect(r.id).toBe(1);
    expect(r.result.protocolVersion).toBe("2025-03-26");
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.serverInfo.name).toBe("chisel-cad");
  });

  it("falls back to the newest protocol version for unknown ones", async () => {
    const r = (await handleMcpRpc({ id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, tools)) as any;
    expect(r.result.protocolVersion).toBe("2025-06-18");
  });

  it("lists and calls tools", async () => {
    const list = (await handleMcpRpc({ id: 3, method: "tools/list" }, tools)) as any;
    expect(list.result.tools.map((t: any) => t.name)).toEqual(["echo", "boom"]);
    const call = (await handleMcpRpc({ id: 4, method: "tools/call", params: { name: "echo", arguments: { v: "hi" } } }, tools)) as any;
    expect(call.result.content[0].text).toBe("hi");
  });

  it("reports tool exceptions as isError results, not protocol errors", async () => {
    const r = (await handleMcpRpc({ id: 5, method: "tools/call", params: { name: "boom" } }, tools)) as any;
    expect(r.error).toBeUndefined();
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("kaboom");
  });

  it("unknown tool / method are JSON-RPC errors", async () => {
    const t = (await handleMcpRpc({ id: 6, method: "tools/call", params: { name: "nope" } }, tools)) as any;
    expect(t.error.code).toBe(-32602);
    const m = (await handleMcpRpc({ id: 7, method: "resources/list" }, tools)) as any;
    expect(m.error.code).toBe(-32601);
    const p = (await handleMcpRpc({ id: 8, method: "ping" }, tools)) as any;
    expect(p.result).toEqual({});
  });
});
