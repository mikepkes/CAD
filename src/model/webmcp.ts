// WebMCP: expose the app's commands as Model Context Protocol tools to agents
// running in the browser (an AI browser, an extension, Claude-in-Chrome, …).
//
// There is no relay and no server — everything stays in the page. We register
// the tools with the emerging `navigator.modelContext` API when it exists, and
// always publish a stable, self-describing surface at `window.chiselWebMCP` so
// an external agent can discover and call tools even without the native API.

import { CommandRegistry } from "../core/command/registry";
import { hotkeys } from "./hotkeys";
import type { RenderViewOpts } from "../viewport/SceneManager";
import type { TurntableOpts, TurntableResult } from "../viewport/turntableRecorder";
import { sanitizeOutputName, timestampedStem } from "./saveOutput";
import type { BodyTopology } from "../core/features";

export interface WebMcpResult {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
}

/** MCP tool annotations: hints a client uses to decide what needs confirmation. */
export interface ToolAnnotations {
  title?: string;
  /** Doesn't change the document or anything else. */
  readOnlyHint?: boolean;
  /** May delete or overwrite (only meaningful when not read-only). */
  destructiveHint?: boolean;
  /** Calling it again with the same arguments has no further effect. */
  idempotentHint?: boolean;
  /** Reaches outside the app (the network, other services). */
  openWorldHint?: boolean;
}

export interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: ToolAnnotations;
  execute: (args: Record<string, unknown>) => Promise<WebMcpResult>;
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const EDIT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

export interface WebMcpHost {
  registry: CommandRegistry;
  runCommand: (type: string, params: Record<string, unknown>) => Promise<{ ok: boolean; createdIds?: string[]; message?: string; error?: string; frame?: unknown; warning?: string }>;
  /** Start a sketch on a body face: the face nearest a world point, or the face with a topological name. */
  sketchOnFace?: (point: { x: number; y: number; z: number } | undefined, name?: string, face?: string) => Promise<unknown>;
  /** Bodies with exact mass properties and their named faces/edges. */
  topology?: (opts: { bodyId?: string; faces?: boolean; edges?: boolean }) => Promise<BodyTopology[]>;
  /** Minimum distance between two bodies. */
  distance?: (a: string, b: string) => Promise<number>;
  /** Switch the active configuration (name/id, or null for none). */
  setConfiguration?: (ref: string | null) => Promise<unknown>;
  /** Show or hide ids (bodies by feature id, sketches, components, datum planes). */
  setVisibility?: (ids: string[], visible: boolean) => Promise<unknown>;
  /** Show only these ids (null: show everything). */
  isolate?: (ids: string[] | null) => Promise<unknown>;
  /** The configuration table's rows. */
  configurations?: () => { id: string; name: string }[];
  /** Model bytes: one body (null = the whole model fused, or every part for 3MF), optionally of a configuration. */
  exportModel?: (format: "stl" | "step" | "3mf", body: string | null, configuration?: string | null) => Promise<Uint8Array | null>;
  /** Capture / restore the document state, for an all-or-nothing batch. */
  checkpoint?: () => unknown;
  rollback?: (token: unknown) => Promise<void>;
  describe: () => unknown;
  render: (opts: RenderViewOpts) => Promise<{ base64: string; width: number; height: number; view: string }>;
  /** Record a WebCodecs turntable of the current bodies (optional; needs the live viewport). */
  recordTurntable?: (opts: TurntableOpts) => Promise<TurntableResult>;
  /** Persist an output file; resolves to where it went (a path on desktop, a download name in a browser). */
  saveOutput?: (filename: string, bytes: Uint8Array, mime: string) => Promise<string>;
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
    annotations: { ...(t.destructive ? DESTRUCTIVE : EDIT), title: t.title },
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
    annotations: READ_ONLY,
    execute: async () => ok(host.describe()),
  });
  tools.push({
    name: "render_view",
    description: "Render the current model and return a PNG image. `view` is one of iso (default), front, back, top, bottom, left, right. Or aim a free camera with `azimuthDeg` (around Z from +X toward +Y; -90 = looking at the front from -Y) and `elevationDeg` (up from the XY plane), which override `view`; `fovDeg` sets the vertical field of view (default 45 — narrow it, e.g. 10, to match a zoomed photo) and `rollDeg` rotates about the view axis. The model is framed automatically. Optional `width`/`height` in pixels (max 1920). `hideSketches` hides sketch curves/points/constraint glyphs; `clean` also hides the grid and axes for a product shot. `saveAs` (a filename) also writes the PNG to disk — in the desktop app into ~/Downloads/Chisel CAD/ — and reports the path. Use it to see what you've built.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["iso", "front", "back", "top", "bottom", "left", "right"] },
        azimuthDeg: { type: "number" },
        elevationDeg: { type: "number" },
        fovDeg: { type: "number" },
        rollDeg: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        hideSketches: { type: "boolean" },
        clean: { type: "boolean" },
        saveAs: { type: "string", description: "Filename (no directories) to also save the PNG as." },
      },
    },
    // read-only for the document, but `saveAs` writes a file
    annotations: { ...EDIT, idempotentHint: true },
    execute: async (args) => {
      try {
        const a = args as RenderViewOpts & { saveAs?: string };
        const r = await host.render({
          view: a.view, width: a.width, height: a.height, hideSketches: a.hideSketches, clean: a.clean,
          azimuthDeg: a.azimuthDeg, elevationDeg: a.elevationDeg, fovDeg: a.fovDeg, rollDeg: a.rollDeg,
        });
        const content: WebMcpResult["content"] = [{ type: "image", data: r.base64, mimeType: "image/png" }];
        if (a.saveAs && host.saveOutput) {
          const name = sanitizeOutputName(a.saveAs, "png", `chisel-${r.view}`);
          const saved = await host.saveOutput(name, base64Bytes(r.base64), "image/png");
          content.push({ type: "text", text: JSON.stringify({ ok: true, saved, width: r.width, height: r.height, view: r.view }) });
        }
        return { content };
      } catch (e) {
        return { ...ok({ ok: false, error: (e as Error).message }), isError: true };
      }
    },
  });
  if (host.recordTurntable && host.saveOutput) {
    tools.push({
      name: "record_turntable",
      description: "Record a 360° turntable video of the current bodies with WebCodecs and save it as an MP4 (H.264 when the platform can encode it, else VP9) — in the desktop app into ~/Downloads/Chisel CAD/. The camera orbits Z around the bodies, framed automatically. Defaults: 1280×720, 60 fps, 4 s, one revolution, elevationDeg 25, startAzDeg -60 (front-right), fovDeg 30. Width/height ≤ 1920, fps ≤ 60, seconds ≤ 30. Returns the saved path, codec and frame count. Takes a few seconds; it briefly borrows the viewport and restores it.",
      inputSchema: {
        type: "object",
        properties: {
          seconds: { type: "number" },
          fps: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          revolutions: { type: "number" },
          elevationDeg: { type: "number" },
          startAzDeg: { type: "number" },
          fovDeg: { type: "number" },
          filename: { type: "string", description: "Filename (no directories); default chisel-turntable-<timestamp>.mp4." },
        },
      },
      annotations: EDIT,
    execute: async (args) => {
        try {
          const a = args as { seconds?: number; fps?: number; width?: number; height?: number; revolutions?: number; elevationDeg?: number; startAzDeg?: number; fovDeg?: number; filename?: string };
          const clamp = (v: number | undefined, d: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? Number(v) : d));
          const opts: TurntableOpts = {
            seconds: clamp(a.seconds, 4, 0.5, 30),
            fps: clamp(a.fps, 60, 1, 60),
            width: clamp(a.width, 1280, 64, 1920),
            height: clamp(a.height, 720, 64, 1920),
            revolutions: clamp(a.revolutions, 1, -10, 10),
            elevationDeg: clamp(a.elevationDeg, 25, -89, 89),
            startAzDeg: Number.isFinite(a.startAzDeg) ? Number(a.startAzDeg) : -60,
            fovDeg: clamp(a.fovDeg, 30, 1, 120),
          };
          const r = await host.recordTurntable!(opts);
          const name = sanitizeOutputName(a.filename, "mp4", timestampedStem("chisel-turntable"));
          const saved = await host.saveOutput!(name, r.bytes, "video/mp4");
          return ok({ ok: true, saved, codec: r.codec, width: r.width, height: r.height, fps: r.fps, frames: r.frames, seconds: opts.seconds, bytes: r.bytes.length });
        } catch (e) {
          return { ...ok({ ok: false, error: (e as Error).message }), isError: true };
        }
      },
    });
  }
  if (host.sketchOnFace) {
    tools.push({
      name: "sketch_on_face",
      description: "Start a sketch on a planar body face: by its topological `face` name from body_topology (e.g. \"extrude3:end\"; preferred — the sketch then follows that face through upstream edits), or the face nearest a world `point` {x,y,z}. Returns the sketch id, origin point id, the face's name and the sketch's world frame (origin, u, v, normal) so you know which way sketch coordinates and extrudes go — extrude `direction: \"reverse\"` goes into the body, `extent: \"throughAll\"` cuts all the way through.",
      inputSchema: {
        type: "object",
        properties: {
          face: { type: "string", description: "Topological face name (from body_topology)." },
          point: { type: "object", required: ["x", "y", "z"], properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, description: "A world point on (or near) the face; with `face`, picks the nearest piece of a split face." },
          name: { type: "string" },
        },
      },
      annotations: EDIT,
    execute: async (args) => {
        const a = args as { point?: { x: number; y: number; z: number }; name?: string; face?: string };
        try { return ok({ ok: true, ...(await host.sketchOnFace!(a.point, a.name, a.face) as object) }); }
        catch (e) { return { ...ok({ ok: false, error: (e as Error).message }), isError: true }; }
      },
    });
  }
  if (host.newDocument) {
    tools.push({
      name: "new_document",
      description: "Start a fresh, empty document (discards the current one; the browser autosave is cleared). Use before building something unrelated.",
      inputSchema: { type: "object", properties: {} },
      annotations: DESTRUCTIVE,
    execute: async () => { await host.newDocument!(); return ok({ ok: true }); },
    });
  }
  if (host.undo && host.redo) {
    tools.push({
      name: "undo",
      description: "Undo the last edit transaction.",
      inputSchema: { type: "object", properties: {} },
      annotations: EDIT,
    execute: async () => { host.undo!(); return ok({ ok: true, state: host.describe() }); },
    });
    tools.push({
      name: "redo",
      description: "Redo the last undone edit transaction.",
      inputSchema: { type: "object", properties: {} },
      annotations: EDIT,
    execute: async () => { host.redo!(); return ok({ ok: true, state: host.describe() }); },
    });
  }
  if (host.deleteOperation) {
    tools.push({
      name: "delete_operation",
      description: "Delete a timeline operation by its opId (e.g. an extrude feature id). Downstream operations that referenced it will error. Undoable.",
      inputSchema: { type: "object", required: ["opId"], properties: { opId: { type: "string" } } },
      annotations: DESTRUCTIVE,
    execute: async (args) => {
        try { await host.deleteOperation!(String((args as { opId?: string }).opId)); return ok({ ok: true, state: host.describe() }); }
        catch (e) { return { ...ok({ ok: false, error: (e as Error).message }), isError: true }; }
      },
    });
  }
  if (host.topology) {
    tools.push({
      name: "measure",
      description: "Exact (B-rep, not mesh) mass properties of the bodies: volume (mm³), surface area (mm²), centroid and world bounds — every body, or one (`body`: the id of the feature that created it). With `between: [bodyA, bodyB]`, also their minimum distance (0 when they touch or overlap).",
      inputSchema: {
        type: "object",
        properties: {
          body: { type: "string" },
          between: { type: "array", items: { type: "string" }, description: "Two body ids to measure the gap between." },
        },
      },
      annotations: READ_ONLY,
      execute: async (args) => {
        const a = args as { body?: string; between?: string[] };
        try {
          const bodies = await host.topology!({ bodyId: a.body, faces: false, edges: false });
          if (a.body && !bodies.length) throw new Error(`no body "${a.body}"`);
          const out: Record<string, unknown> = { ok: true, bodies: bodies.map((b) => rounded({ id: b.id, name: b.name, volume: b.volume, area: b.area, centroid: b.centroid, bounds: b.bounds })) };
          if (a.between) {
            if (a.between.length !== 2 || !host.distance) throw new Error("`between` takes exactly two body ids");
            out.distance = round6(await host.distance(a.between[0], a.between[1]));
          }
          return ok(out);
        } catch (e) {
          return { ...ok({ ok: false, error: (e as Error).message }), isError: true };
        }
      },
    });
    tools.push({
      name: "body_topology",
      description: "The faces and edges of each body (or one: `body`), with stable topological names. A face is named by the feature that made it — \"extrude3:end\", \"extrude3:side:line7\" (the sketch line that swept it), \"prim2:+X\", \"hole9:bore\", \"fillet6:blend(…)\" — and keeps that name through later features. Each face has its surface type, area, centroid, normal and a point on it; each edge is named by the two faces it separates (\"A|B\") with its type, length and midpoint. Use face names with sketch_on_face and edge names in a fillet/chamfer `edges: { names: [...] }` selector instead of guessing coordinates.",
      inputSchema: {
        type: "object",
        properties: {
          body: { type: "string", description: "Body id (its creating feature); default every body." },
          faces: { type: "boolean", description: "Include faces (default true)." },
          edges: { type: "boolean", description: "Include edges (default true)." },
        },
      },
      annotations: READ_ONLY,
      execute: async (args) => {
        const a = args as { body?: string; faces?: boolean; edges?: boolean };
        try {
          const bodies = await host.topology!({ bodyId: a.body, faces: a.faces !== false, edges: a.edges !== false });
          if (a.body && !bodies.length) throw new Error(`no body "${a.body}"`);
          return ok({ ok: true, bodies: bodies.map((b) => rounded({
            id: b.id, name: b.name, volume: b.volume, area: b.area, centroid: b.centroid,
            faces: b.faces.map((f) => ({ name: f.name, type: f.type.toLowerCase(), area: f.area, center: f.center, normal: f.normal, point: f.point })),
            edges: b.edges.map((e) => ({ name: e.name, type: e.type.toLowerCase(), length: e.length, mid: e.mid })),
          })) });
        } catch (e) {
          return { ...ok({ ok: false, error: (e as Error).message }), isError: true };
        }
      },
    });
  }
  if (host.setConfiguration) {
    tools.push({
      name: "set_configuration",
      description: "Make a configuration (a row of the configuration table, by name or id) active, or pass null for the timeline's own values. Its cells override those parameters and its suppressed features are skipped everywhere — solids, collisions, motion studies, exports. Undoable; not a timeline step. Rows are made with configuration.create / configuration.update; get_state lists them.",
      inputSchema: { type: "object", required: ["configuration"], properties: { configuration: { type: ["string", "null"] } } },
      annotations: { ...EDIT, idempotentHint: true },
      execute: async (args) => {
        try { return ok({ ok: true, ...(await host.setConfiguration!((args as { configuration?: string | null }).configuration ?? null) as object) }); }
        catch (e) { return { ...ok({ ok: false, error: (e as Error).message }), isError: true }; }
      },
    });
  }
  if (host.setVisibility && host.isolate) {
    tools.push({
      name: "set_visibility",
      description: "Show or hide bodies (by the id of the feature that created them), sketches, components (hides everything inside) or datum planes. Display only: hidden bodies still take part in booleans, measure, collisions and export. Undoable; affects render_view and record_turntable, so use it to frame one part.",
      inputSchema: { type: "object", required: ["ids", "visible"], properties: { ids: { type: "array", items: { type: "string" } }, visible: { type: "boolean" } } },
      annotations: { ...EDIT, idempotentHint: true },
      execute: async (args) => {
        const a = args as { ids?: string[]; visible?: boolean };
        try { return ok({ ok: true, ...(await host.setVisibility!(a.ids ?? [], a.visible !== false) as object) }); }
        catch (e) { return { ...ok({ ok: false, error: (e as Error).message }), isError: true }; }
      },
    });
    tools.push({
      name: "isolate",
      description: "Show only the given bodies / sketches / components (everything inside a kept component stays visible), hiding the rest; `ids: null` shows everything again. Undoable.",
      inputSchema: { type: "object", required: ["ids"], properties: { ids: { type: ["array", "null"], items: { type: "string" } } } },
      annotations: { ...EDIT, idempotentHint: true },
      execute: async (args) => {
        try { return ok({ ok: true, ...(await host.isolate!((args as { ids?: string[] | null }).ids ?? null) as object) }); }
        catch (e) { return { ...ok({ ok: false, error: (e as Error).message }), isError: true }; }
      },
    });
  }
  if (host.exportModel && host.saveOutput) {
    const MIME = { step: "model/step", stl: "model/stl", "3mf": "model/3mf" } as const;
    tools.push({
      name: "export_model",
      description: "Export the model and save it — in the desktop app into ~/Downloads/Chisel CAD/. `format` step (CAD/CNC), stl (3D print) or 3mf (one part per material). `body` exports one body (its creating feature id); default the whole model (fused, or every part for 3MF). `configuration` exports that variant without switching to it; `all: true` writes one file per configuration. Returns the saved path(s).",
      inputSchema: {
        type: "object",
        required: ["format"],
        properties: {
          format: { type: "string", enum: ["step", "stl", "3mf"] },
          body: { type: "string" },
          configuration: { type: "string" },
          all: { type: "boolean", description: "One file per configuration." },
          filename: { type: "string", description: "Filename stem (no directories); a configuration's name is appended." },
        },
      },
      annotations: { ...EDIT, idempotentHint: true },
      execute: async (args) => {
        const a = args as { format: "step" | "stl" | "3mf"; body?: string; configuration?: string; all?: boolean; filename?: string };
        try {
          if (!MIME[a.format]) throw new Error("format must be step, stl or 3mf");
          const rows: (string | undefined)[] = a.all ? (host.configurations?.() ?? []).map((c) => c.name) : [a.configuration];
          if (a.all && !rows.length) throw new Error("there are no configurations — add one with configuration.create");
          const saved: { configuration?: string; saved: string; bytes: number }[] = [];
          for (const cfg of rows) {
            const bytes = await host.exportModel!(a.format, a.format === "3mf" ? null : a.body ?? null, cfg);
            if (!bytes) throw new Error(`export produced nothing${cfg ? ` for ${cfg}` : ""}`);
            const stem = [a.filename?.replace(/\.(step|stp|stl|3mf)$/i, "") || timestampedStem("chisel-model"), cfg].filter(Boolean).join(" ");
            saved.push({ ...(cfg ? { configuration: cfg } : {}), saved: await host.saveOutput!(sanitizeOutputName(stem, a.format, "chisel-model"), bytes, MIME[a.format]), bytes: bytes.length });
          }
          return ok({ ok: true, files: saved });
        } catch (e) {
          return { ...ok({ ok: false, error: (e as Error).message }), isError: true };
        }
      },
    });
  }
  tools.push({
    name: "get_hotkeys",
    description: "List keyboard shortcuts: contexts (in stack order, active flagged), each action's id/label/primary/secondary binding, and any within-context conflicts.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ_ONLY,
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
    annotations: { ...EDIT, idempotentHint: true },
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
  tools.push({
    name: "batch",
    description: "Run several tool calls in order as one transaction: `steps` is a list of {tool, arguments}. By default (`atomic: true`) the first failing step rolls the document back to before the batch, so a half-built feature never lingers; `atomic: false` keeps the steps that succeeded. Returns each step's result and time in ms, which step failed, and whether it rolled back. Images from render_view steps are returned after the summary.",
    inputSchema: {
      type: "object",
      required: ["steps"],
      properties: {
        steps: { type: "array", items: { type: "object", required: ["tool"], properties: { tool: { type: "string" }, arguments: { type: "object" } } } },
        atomic: { type: "boolean", description: "Roll everything back if a step fails (default true)." },
      },
    },
    annotations: DESTRUCTIVE, // its steps may include deletes
    execute: async (args) => {
      const a = args as { steps?: { tool?: string; arguments?: Record<string, unknown> }[]; atomic?: boolean };
      const steps = Array.isArray(a.steps) ? a.steps : [];
      const atomic = a.atomic !== false;
      const token = atomic && host.checkpoint && host.rollback ? host.checkpoint() : undefined;
      const results: { step: number; tool: string; ok: boolean; ms: number; result?: unknown }[] = [];
      const images: WebMcpResult["content"] = [];
      const finish = async (failed?: number) => {
        let rolledBack = false;
        if (failed !== undefined && token !== undefined) { await host.rollback!(token); rolledBack = true; }
        const summary = { ok: failed === undefined, ...(failed !== undefined ? { failedStep: failed, rolledBack } : {}), results };
        return { content: [{ type: "text" as const, text: JSON.stringify(summary) }, ...images], ...(failed !== undefined ? { isError: true } : {}) };
      };
      for (let i = 0; i < steps.length; i++) {
        const name = String(steps[i]?.tool ?? "");
        const tool = tools.find((t) => t.name === name && t.name !== "batch");
        const t0 = performance.now();
        if (!tool) { results.push({ step: i, tool: name, ok: false, ms: 0, result: { error: `Unknown tool "${name}"` } }); return finish(i); }
        let r: WebMcpResult;
        try { r = await tool.execute(steps[i].arguments ?? {}); }
        catch (e) { r = { content: [{ type: "text", text: JSON.stringify({ ok: false, error: (e as Error).message }) }], isError: true }; }
        const texts = r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => { try { return JSON.parse(c.text); } catch { return c.text; } });
        images.push(...r.content.filter((c) => c.type === "image"));
        results.push({ step: i, tool: name, ok: !r.isError, ms: Math.round(performance.now() - t0), result: texts.length === 1 ? texts[0] : texts });
        if (r.isError) return finish(i);
      }
      return finish();
    },
  });
  return tools;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
/** Numbers rounded to 1e-6 throughout (keeps tool output compact and readable). */
function rounded<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "number" ? round6(x) : x)));
}

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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
    listTools: () => tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) })),
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
      listTools: () => tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) })),
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
