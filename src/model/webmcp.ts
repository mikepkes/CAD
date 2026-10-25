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
  runCommand: (type: string, params: Record<string, unknown>) => Promise<{ ok: boolean; createdIds?: string[]; message?: string; error?: string; frame?: unknown; warning?: string }>;
  /** Start a sketch on the body face nearest a world point (face picking without the mouse). */
  sketchOnFace?: (point: { x: number; y: number; z: number }, name?: string) => Promise<unknown>;
  describe: () => unknown;
  render: (opts: { view?: string; width?: number; height?: number; hideSketches?: boolean }) => Promise<{ base64: string; width: number; height: number; view: string }>;
  /** Document-level actions (optional; the desktop/in-page hosts provide them). */
  newDocument?: () => Promise<void>;
  undo?: () => void;
  redo?: () => void;
  deleteOperation?: (opId: string) => Promise<void>;
}

export const WEBMCP_INFO = {
  name: "ChiselCAD",
  version: 1,
  description:
    "A parametric CAD app (sketch → solid, OpenCASCADE kernel). Tools are its commands: create a sketch (sketch.create with a plane XY/XZ/YZ/offset/datum/planeDef, or sketch_on_face at a world point → returns ids + the sketch frame), add geometry (sketch.addLine/addPolyline/addCircle/addRing/addArc/addRectangle{cornerRadius}/addBar/addPolygon/addEllipse/addSlot), constrain/dimension (sketch.addConstraint/addDimension, expressions allowed), edit (sketch.trim/extend/offset/offsetLoop/fillet/filletCorners/chamfer/mirror/*Pattern), then build solids: feature.extrude (new/join/cut, symmetric, direction reverse, extent throughAll), feature.revolve, feature.fillet/chamfer (EdgeSelector), feature.shell, feature.pattern (linear/circular bodies), feature.mirror. Modifiers act on the most recent body. Points are {x,y} or {ref:<pointId>}; reuse a point id to make endpoints coincident. Call get_state first and after creating geometry to read live ids and body bounds — never guess them. Feature results include kernel errors/warnings (e.g. a cut that removed nothing).",
};

let registered = false;
const unregister: (() => void)[] = [];

/** The tool surface shared by WebMCP and the desktop MCP server: every registry command + get_state / render_view / hotkeys. */
export function buildTools(host: WebMcpHost): WebMcpTool[] {
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
    description: "Render the current model and return a PNG image. `view` is one of iso (default), front, back, top, bottom, left, right. Optional `width`/`height` in pixels (max 1920). `hideSketches` hides sketch curves/points/constraint glyphs for a clean solids-only capture. Use it to see what you've built.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["iso", "front", "back", "top", "bottom", "left", "right"] },
        width: { type: "number" },
        height: { type: "number" },
        hideSketches: { type: "boolean" },
      },
    },
    execute: async (args) => {
      try {
        const a = args as { view?: string; width?: number; height?: number; hideSketches?: boolean };
        const r = await host.render({ view: a.view, width: a.width, height: a.height, hideSketches: a.hideSketches });
        return { content: [{ type: "image", data: r.base64, mimeType: "image/png" }] };
      } catch (e) {
        return { ...ok({ ok: false, error: (e as Error).message }), isError: true };
      }
    },
  });
  if (host.sketchOnFace) {
    tools.push({
      name: "sketch_on_face",
      description: "Start a sketch on the body face nearest to a world point {x,y,z} (pick a face without the mouse). The sketch tracks that face parametrically. Returns the sketch id, origin point id and the sketch's world frame (origin, u, v, normal) so you know which way sketch coordinates and extrudes go — extrude `direction: \"reverse\"` goes into the body, `extent: \"throughAll\"` cuts all the way through.",
      inputSchema: {
        type: "object",
        required: ["point"],
        properties: {
          point: { type: "object", required: ["x", "y", "z"], properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, description: "A world point on (or near) the face." },
          name: { type: "string" },
        },
      },
      execute: async (args) => {
        const a = args as { point: { x: number; y: number; z: number }; name?: string };
        try { return ok({ ok: true, ...(await host.sketchOnFace!(a.point, a.name) as object) }); }
        catch (e) { return { ...ok({ ok: false, error: (e as Error).message }), isError: true }; }
      },
    });
  }
  if (host.newDocument) {
    tools.push({
      name: "new_document",
      description: "Start a fresh, empty document (discards the current one; the browser autosave is cleared). Use before building something unrelated.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => { await host.newDocument!(); return ok({ ok: true }); },
    });
  }
  if (host.undo && host.redo) {
    tools.push({
      name: "undo",
      description: "Undo the last edit transaction.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => { host.undo!(); return ok({ ok: true, state: host.describe() }); },
    });
    tools.push({
      name: "redo",
      description: "Redo the last undone edit transaction.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => { host.redo!(); return ok({ ok: true, state: host.describe() }); },
    });
  }
  if (host.deleteOperation) {
    tools.push({
      name: "delete_operation",
      description: "Delete a timeline operation by its opId (e.g. an extrude feature id). Downstream operations that referenced it will error. Undoable.",
      inputSchema: { type: "object", required: ["opId"], properties: { opId: { type: "string" } } },
      execute: async (args) => {
        try { await host.deleteOperation!(String((args as { opId?: string }).opId)); return ok({ ok: true, state: host.describe() }); }
        catch (e) { return { ...ok({ ok: false, error: (e as Error).message }), isError: true }; }
      },
    });
  }
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
    info: WEBMCP_INFO,
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
