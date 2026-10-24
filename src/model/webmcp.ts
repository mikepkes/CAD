// WebMCP: expose the app's commands as Model Context Protocol tools to agents
// running in the browser (an AI browser, an extension, Claude-in-Chrome, …).
//
// There is no relay and no server — everything stays in the page. We register
// the tools with the emerging `navigator.modelContext` API when it exists, and
// always publish a stable, self-describing surface at `window.chiselWebMCP` so
// an external agent can discover and call tools even without the native API.

import { CommandRegistry } from "../core/command/registry";

export interface WebMcpResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  execute: (args: Record<string, unknown>) => Promise<WebMcpResult>;
}

export interface WebMcpHost {
  registry: CommandRegistry;
  runCommand: (type: string, params: Record<string, unknown>) => Promise<{ ok: boolean; createdIds?: string[]; message?: string; error?: string }>;
  describe: () => unknown;
}

const INFO = {
  name: "ChiselCAD",
  version: 1,
  description:
    "A browser-based parametric 2D sketch CAD app. Tools are its commands: create a sketch (sketch.create with a plane XY/XZ/YZ → returns [sketchId, originId]), add geometry (sketch.addLine/addCircle/addArc/addRectangle/addPolygon/addEllipse/addSlot), constrain (sketch.addConstraint), dimension (sketch.addDimension, expressions allowed), edit (sketch.trim/extend/offset/fillet/chamfer/mirror/*Pattern), and extrude (feature.extrude). Points are {x,y} or {ref:<pointId>}; reuse a point id to make endpoints coincident. Call get_state first and after creating geometry to read live ids — never guess them.",
};

let registered = false;
const unregister: (() => void)[] = [];

function buildTools(host: WebMcpHost): WebMcpTool[] {
  const ok = (v: unknown): WebMcpResult => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
  const tools: WebMcpTool[] = host.registry.toMcpTools().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    execute: async (args) => {
      try {
        const r = await host.runCommand(t.name, args ?? {});
        return { ...ok(r), isError: !r.ok };
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    },
  }));
  tools.push({
    name: "get_state",
    description: "Inspect the current document: mode, active sketch id, every sketch (entities with ids/kinds/coordinates, constraints), features and parameters. Call before referencing any id.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ok(host.describe()),
  });
  return tools;
}

export function isWebMcpActive(): boolean {
  return registered;
}

export function enableWebMcp(host: WebMcpHost): void {
  if (registered) return;
  const tools = buildTools(host);

  // Stable, framework-agnostic surface for any external agent/extension.
  (window as unknown as Record<string, unknown>).chiselWebMCP = {
    info: INFO,
    listTools: () => tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    callTool: async (name: string, args: Record<string, unknown>): Promise<WebMcpResult> => {
      const t = tools.find((x) => x.name === name);
      if (!t) return { content: [{ type: "text", text: `Unknown tool "${name}"` }], isError: true };
      return t.execute(args ?? {});
    },
  };

  // Native WebMCP API, when the browser/agent provides it.
  const nav = navigator as unknown as {
    modelContext?: {
      registerTool?: (t: unknown) => (() => void) | void;
      provideContext?: (c: { tools: unknown[] }) => void;
    };
  };
  try {
    if (nav.modelContext?.registerTool) {
      for (const t of tools) {
        const un = nav.modelContext.registerTool(t);
        if (typeof un === "function") unregister.push(un);
      }
    } else if (nav.modelContext?.provideContext) {
      nav.modelContext.provideContext({ tools });
    } else {
      // Minimal polyfill so an injected agent still finds the standard surface.
      (nav as { modelContext?: unknown }).modelContext = {
        registerTool: (t: WebMcpTool) => { tools.push(t); return () => {}; },
        provideContext: () => {},
        listTools: () => tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        callTool: (name: string, args: Record<string, unknown>) =>
          (window as unknown as { chiselWebMCP: { callTool: (n: string, a: unknown) => unknown } }).chiselWebMCP.callTool(name, args),
      };
    }
  } catch {
    /* native API rejected our tools — the window surface still works */
  }
  registered = true;
}

export function disableWebMcp(): void {
  for (const un of unregister) { try { un(); } catch { /* ignore */ } }
  unregister.length = 0;
  delete (window as unknown as Record<string, unknown>).chiselWebMCP;
  registered = false;
}
