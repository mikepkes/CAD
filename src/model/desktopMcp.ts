// Desktop MCP server (Tauri shell only).
//
// When the app runs inside the optional Tauri desktop shell, the Rust side can
// open a local HTTP endpoint speaking MCP's Streamable HTTP transport and
// forward every JSON-RPC request to this page as an `mcp-request` event. We
// answer it here with the same tool surface WebMCP exposes, so an external MCP
// client (Claude Code, Claude Desktop, …) drives the *live* document.
//
// Everything Tauri-specific is reached through dynamic imports behind
// `isTauri()`, so the static web build (GitHub Pages) never loads it.

import { buildTools, WEBMCP_INFO, WebMcpHost, WebMcpTool } from "./webmcp";

export const DEFAULT_DESKTOP_MCP_PORT = 4673;

export interface DesktopMcpStatus {
  running: boolean;
  port?: number | null;
  url?: string | null;
}

/** True when the page is hosted by the Tauri desktop shell. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Newest first; we echo the client's version when we support it.
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface RpcRequest { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }

let tools: WebMcpTool[] = [];
let unlisten: (() => void) | null = null;

const result = (id: unknown, value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const failure = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

/** Answer one JSON-RPC request. Exported for tests; has no Tauri dependency. */
export async function handleMcpRpc(req: RpcRequest, toolset: WebMcpTool[] = tools): Promise<unknown> {
  const id = req.id ?? null;
  const params = req.params ?? {};
  switch (req.method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      return result(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "chisel-cad", title: WEBMCP_INFO.name, version: "0.1.0" },
        instructions: WEBMCP_INFO.description,
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: toolset.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    case "tools/call": {
      const name = String(params.name ?? "");
      const tool = toolset.find((t) => t.name === name);
      if (!tool) return failure(id, -32602, `Unknown tool "${name}"`);
      try {
        const r = await tool.execute((params.arguments as Record<string, unknown>) ?? {});
        return result(id, r);
      } catch (e) {
        return result(id, { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      return failure(id, -32601, `Method not found: ${req.method}`);
  }
}

/** Start the endpoint (or move it to `port`). Resolves with the URL to connect to. */
export async function startDesktopMcp(host: WebMcpHost, port: number): Promise<DesktopMcpStatus> {
  if (!isTauri()) throw new Error("The MCP server is only available in the desktop app.");
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  tools = buildTools(host);
  if (!unlisten) {
    // Register the listener *before* the server exists so no request can race it.
    unlisten = await listen<{ id: number; request: RpcRequest }>("mcp-request", async (e) => {
      let response: unknown;
      try {
        response = await handleMcpRpc(e.payload.request);
      } catch (err) {
        response = failure(e.payload.request?.id ?? null, -32603, (err as Error).message);
      }
      try {
        await invoke("mcp_respond", { id: e.payload.id, response });
      } catch {
        /* request already timed out on the Rust side */
      }
    });
  }
  return invoke<DesktopMcpStatus>("mcp_start", { port });
}

export async function stopDesktopMcp(): Promise<DesktopMcpStatus> {
  if (!isTauri()) return { running: false };
  const { invoke } = await import("@tauri-apps/api/core");
  const status = await invoke<DesktopMcpStatus>("mcp_stop");
  unlisten?.();
  unlisten = null;
  tools = [];
  return status;
}

export async function desktopMcpStatus(): Promise<DesktopMcpStatus> {
  if (!isTauri()) return { running: false };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DesktopMcpStatus>("mcp_status");
}
