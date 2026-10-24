// WebMCP: expose the app's commands as Model Context Protocol tools to agents
// running in the browser (an AI browser, an extension, Claude-in-Chrome, …).
//
// There is no relay and no server — everything stays in the page. We register
// the tools with the emerging `navigator.modelContext` API when it exists, and
// always publish a stable, self-describing surface at `window.chiselWebMCP` so
// an external agent can discover and call tools even without the native API.

import { CommandRegistry } from "../core/command/registry";
import { hotkeys } from "../core/hotkeys";

export interface WebMcpResult {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
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
  render: (opts: { view?: string; width?: number; height?: number }) => Promise<{ base64: string; width: number; height: number; view: string }>;
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
        return { ...ok({ ok: false, error: (e as Error).message }), isError: true };
      }
    },
  }));
  tools.push({
    name: "get_state",
    description: "Inspect the current document: mode, active sketch id, every sketch (entities with ids/kinds/coordinates, constraints), features and parameters. Call before referencing any id.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ok(host.describe()),
  });
  tools.push({
    name: "render_view",
    description: "Render the current model and return a PNG image. `view` is one of iso (default), front, back, top, bottom, left, right. Optional `width`/`height` in pixels (max 1920). Use it to see what you've built.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["iso", "front", "back", "top", "bottom", "left", "right"] },
        width: { type: "number" },
        height: { type: "number" },
      },
    },
    execute: async (args) => {
      try {
        const a = args as { view?: string; width?: number; height?: number };
        const r = await host.render({ view: a.view, width: a.width, height: a.height });
        return { content: [{ type: "image", data: r.base64, mimeType: "image/png" }] };
      } catch (e) {
        return { ...ok({ ok: false, error: (e as Error).message }), isError: true };
      }
    },
  });
  tools.push({
    name: "get_hotkeys",
    description: "List keyboard shortcuts: contexts (in stack order, active flagged), each action's id/label/primary/secondary binding, and any within-context conflicts.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ok(hotkeys.describe()),
  });
  tools.push({
    name: "set_hotkey",
    description: "Bind or clear a keyboard shortcut. `action` is an action id from get_hotkeys. `key` is a canonical binding like \"f\", \"mod+z\", \"shift+d\" (mod = Ctrl/Cmd), or null to clear. `slot` is \"primary\" (default) or \"secondary\".",
    inputSchema: {
      type: "object",
      required: ["action", "key"],
      properties: {
        action: { type: "string" },
        key: { type: ["string", "null"] },
        slot: { type: "string", enum: ["primary", "secondary"] },
      },
    },
    execute: async (args) => {
      const a = args as { action?: string; key?: string | null; slot?: "primary" | "secondary" };
      try {
        hotkeys.setBinding(String(a.action), a.slot === "secondary" ? "secondary" : "primary", a.key == null ? null : String(a.key));
        return { ...ok({ ok: true, hotkeys: hotkeys.describe() }) };
      } catch (e) {
        return { ...ok({ ok: false, error: (e as Error).message }), isError: true };
      }
    },
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
      if (!t) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Unknown tool "${name}"` }) }], isError: true };
      return t.execute(args ?? {});
    },
  };

  // Register with the native WebMCP API wherever the browser exposes it. The
  // surface is still in flux: most builds put it on navigator.modelContext, some
  // on document.modelContext; registerTool() is the consistent method (returns a
  // registration with .unregister() or a bare unregister fn), with provideContext
  // as an older fallback. We try both objects so discovery works either way.
  type Ctx = {
    registerTool?: (t: unknown) => (() => void) | { unregister?: () => void } | void;
    provideContext?: (c: { tools: unknown[] }) => void;
  };
  const surfaces: Ctx[] = [];
  const navCtx = (navigator as unknown as { modelContext?: Ctx }).modelContext;
  const docCtx = (document as unknown as { modelContext?: Ctx }).modelContext;
  if (navCtx) surfaces.push(navCtx);
  if (docCtx && docCtx !== navCtx) surfaces.push(docCtx);

  let registeredNatively = false;
  for (const ctx of surfaces) {
    try {
      if (ctx.registerTool) {
        for (const t of tools) {
          const reg = ctx.registerTool(t);
          if (typeof reg === "function") unregister.push(reg);
          else if (reg && typeof reg.unregister === "function") unregister.push(reg.unregister.bind(reg));
        }
        registeredNatively = true;
      } else if (ctx.provideContext) {
        ctx.provideContext({ tools });
        registeredNatively = true;
      }
    } catch {
      /* this surface rejected our tools — others / the window surface still work */
    }
  }

  // No native API at all → publish a minimal polyfill so an injected agent still
  // finds the standard shape (the window surface already works regardless).
  if (!registeredNatively) {
    (navigator as unknown as { modelContext?: unknown }).modelContext = {
      registerTool: (t: WebMcpTool) => { tools.push(t); return () => {}; },
      provideContext: () => {},
      listTools: () => tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      callTool: (name: string, args: Record<string, unknown>) =>
        (window as unknown as { chiselWebMCP: { callTool: (n: string, a: unknown) => unknown } }).chiselWebMCP.callTool(name, args),
    };
  }
  registered = true;
}

export function disableWebMcp(): void {
  for (const un of unregister) { try { un(); } catch { /* ignore */ } }
  unregister.length = 0;
  delete (window as unknown as Record<string, unknown>).chiselWebMCP;
  registered = false;
}
