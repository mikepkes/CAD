// The MCP surface controllers (in-browser WebMCP + the desktop HTTP server),
// extracted from the store so store.ts stays smaller. Both expose the same
// command host; this module owns their enable/port actions and the init sync.

import { enableWebMcp, disableWebMcp, WebMcpHost } from "./webmcp";
import { DEFAULT_DESKTOP_MCP_PORT, DesktopMcpStatus, isTauri, startDesktopMcp, stopDesktopMcp } from "./desktopMcp";

export const WEBMCP_LS = "chisel.webmcp.enabled";
export const DESKTOP_MCP_LS = "chisel.desktopmcp.enabled";
export const DESKTOP_MCP_PORT_LS = "chisel.desktopmcp.port";

export interface McpStateSlice {
  webMcpEnabled: boolean;
  desktopMcpEnabled: boolean;
  desktopMcpPort: number;
}

export interface McpActions {
  setWebMcpEnabled: (on: boolean) => void;
  setDesktopMcpEnabled: (on: boolean) => Promise<void>;
  setDesktopMcpPort: (port: number) => void;
  /** Re-apply the persisted MCP preferences on app start. */
  initMcp: () => void;
}

export interface McpControllerDeps {
  getState: () => McpStateSlice;
  patch: (p: Partial<McpStateSlice & { desktopMcp: DesktopMcpStatus & { error?: string } }>) => void;
  makeHost: () => WebMcpHost;
}

export function createMcpController(deps: McpControllerDeps): McpActions {
  const actions: McpActions = {
    setWebMcpEnabled: (on) => {
      try { localStorage.setItem(WEBMCP_LS, on ? "1" : "0"); } catch { /* ignore */ }
      if (on) enableWebMcp(deps.makeHost());
      else disableWebMcp();
      deps.patch({ webMcpEnabled: on });
    },
    setDesktopMcpEnabled: async (on) => {
      try { localStorage.setItem(DESKTOP_MCP_LS, on ? "1" : "0"); } catch { /* ignore */ }
      deps.patch({ desktopMcpEnabled: on });
      if (!isTauri()) return;
      try {
        const status = on
          ? await startDesktopMcp(deps.makeHost(), deps.getState().desktopMcpPort)
          : await stopDesktopMcp();
        deps.patch({ desktopMcp: status });
      } catch (e) {
        // e.g. port in use — leave the preference as set but report why it isn't live.
        deps.patch({ desktopMcp: { running: false, error: (e as Error).message || String(e) } });
      }
    },
    setDesktopMcpPort: (port) => {
      const p = Math.min(65535, Math.max(1024, Math.round(port))) || DEFAULT_DESKTOP_MCP_PORT;
      try { localStorage.setItem(DESKTOP_MCP_PORT_LS, String(p)); } catch { /* ignore */ }
      deps.patch({ desktopMcpPort: p });
      // Live server follows the port (mcp_start on a new port restarts it).
      if (deps.getState().desktopMcpEnabled && isTauri()) void actions.setDesktopMcpEnabled(true);
    },
    initMcp: () => {
      if (deps.getState().webMcpEnabled) enableWebMcp(deps.makeHost());
      if (isTauri() && deps.getState().desktopMcpEnabled) void actions.setDesktopMcpEnabled(true);
    },
  };
  return actions;
}
