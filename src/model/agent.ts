// Embedded CAD agent. Runs Claude (via the user's own API key, straight from the
// browser) in a tool-use loop where the tools ARE our command registry — the same
// commands the UI dispatches — so the agent builds sketches live in the app.
//
// The API key lives only in the user's browser (localStorage) and is sent only to
// api.anthropic.com. Nothing goes to any server of ours.

import Anthropic from "@anthropic-ai/sdk";
import { CommandRegistry } from "../core/command/registry";
import { CadDocument, FeatureDef } from "../core/document";
import { resolveSketchPlane } from "../geometry/plane";
import type { SolidEval } from "../core/features";
import { hotkeys } from "./hotkeys";

export type ChatEntry =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "tool"; name: string; ok: boolean; detail: string }
  | { role: "error"; text: string };

export interface AgentContext {
  describe: () => unknown;
  runCommand: (type: string, params: Record<string, unknown>) => Promise<{ ok: boolean; createdIds?: string[]; message?: string; error?: string }>;
  render: (opts: { view?: string; width?: number; height?: number }) => Promise<{ base64: string; width: number; height: number; view: string }>;
}

const SYSTEM = `You are the embedded assistant inside ChiselCAD, a browser-based parametric 2D sketch CAD app (an OpenCASCADE/PlaneGCS modeler). You build and edit sketches for the user by calling tools, which are the app's own commands — the user watches the geometry appear as you work.

Core rules:
- Tool names mirror the commands but with "." replaced by "__" (e.g. sketch__create, sketch__addLine, sketch__addDimension, sketch__addConstraint, feature__extrude). Read each tool's description for its parameters.
- NEVER guess entity ids. Call get_state first to learn the active sketch id, point/line ids, and existing constraints; call it again after creating geometry to get the new ids (commands also return their createdIds).
- To begin, call sketch__create with a plane ("XY", "XZ", or "YZ"); its createdIds[0] is the new sketch id, createdIds[1] is the fixed origin point. Pass that sketch id to subsequent commands.
- Points are {x, y} to create a new point, or {ref: "<pointId>"} to reuse one (reusing a point id makes endpoints coincident). Chain lines by passing the previous end point's ref as the next start.
- Prefer making shapes fully constrained when asked: add horizontal/vertical/parallel/perpendicular/coincident constraints and parametric dimensions (expressions may reference named parameters).
- Work in millimetres. Keep going until the request is complete, then give a brief one- or two-sentence summary of what you built. Do not ask for confirmation on routine steps.`;

const sanitize = (name: string) => name.replace(/\./g, "__");
const desanitize = (name: string) => name.replace(/__/g, ".");

export function buildTools(registry: CommandRegistry): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = registry.toMcpTools().map((t) => ({
    name: sanitize(t.name),
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
  tools.push({
    name: "get_state",
    description:
      "Inspect the current document: editing mode, the active sketch id, every sketch (id, plane, solve status, entities with ids/kinds/coordinates, constraints), features, and parameters. Call this before referencing any id.",
    input_schema: { type: "object", properties: {} },
  });
  tools.push({
    name: "render_view",
    description:
      "Render the current model and return a PNG image to look at. `view` is one of iso (default), front, back, top, bottom, left, right; optional `width`/`height` (px, max 1920). Call it to check what you've built.",
    input_schema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["iso", "front", "back", "top", "bottom", "left", "right"] },
        width: { type: "number" },
        height: { type: "number" },
      },
    },
  });
  tools.push({
    name: "get_hotkeys",
    description:
      "List keyboard shortcuts: contexts (stack order, active flagged), each action's id/label/primary/secondary binding, and any within-context conflicts.",
    input_schema: { type: "object", properties: {} },
  });
  tools.push({
    name: "set_hotkey",
    description:
      "Bind or clear a keyboard shortcut. `action` is an action id from get_hotkeys. `key` is a canonical binding like \"f\", \"mod+z\", \"shift+d\" (mod = Ctrl/Cmd), or null to clear. `slot` is \"primary\" (default) or \"secondary\".",
    input_schema: {
      type: "object",
      required: ["action", "key"],
      properties: {
        action: { type: "string" },
        key: { type: ["string", "null"] },
        slot: { type: "string", enum: ["primary", "secondary"] },
      },
    },
  });
  return tools;
}

/** One feature row: its kind plus the parameters an agent would edit. */
export function describeFeature(f: FeatureDef): Record<string, unknown> {
  switch (f.kind) {
    case "extrude": return { id: f.id, kind: f.kind, name: f.name, sketchId: f.sketchId, distance: f.distanceExpr, operation: f.operation ?? "new", ...(f.symmetric ? { symmetric: true } : {}), ...(f.direction ? { direction: f.direction } : {}), ...(f.extent ? { extent: f.extent } : {}) };
    case "revolve": return { id: f.id, kind: f.kind, name: f.name, sketchId: f.sketchId, angle: f.angleExpr, axis: f.axis, operation: f.operation ?? "new" };
    case "primitive": return { id: f.id, kind: f.kind, name: f.name, shape: f.shape, dims: f.dims, at: f.at, operation: f.operation ?? "new" };
    case "surface": return { id: f.id, kind: f.kind, name: f.name, mode: f.mode, sketchId: f.sketchId, sketches: f.sketchIds, path: f.pathSketch, distance: f.distanceExpr, axis: f.axis, angle: f.angleExpr };
    case "stitch": return { id: f.id, kind: f.kind, name: f.name, bodies: f.bodies, solid: !!f.solid };
    case "thicken": return { id: f.id, kind: f.kind, name: f.name, body: f.body, thickness: f.thicknessExpr, side: f.side ?? "out" };
    case "trim": return { id: f.id, kind: f.kind, name: f.name, body: f.body, sketchId: f.sketchId, toolBody: f.toolBody, keep: f.keep };
    case "untrim": return { id: f.id, kind: f.kind, name: f.name, body: f.body };
    case "member": return { id: f.id, kind: f.kind, name: f.name, sketchId: f.sketchId, lines: f.lines, profile: f.profile, rotate: f.rotateExpr, corner: f.corner ?? "miter", endCaps: !!f.endCaps, gusset: f.gussetExpr };
    case "import": return { id: f.id, kind: f.kind, name: f.name, format: f.format, bytes: f.data.length, at: f.at, operation: f.operation ?? "new" };
    case "hole": return { id: f.id, kind: f.kind, name: f.name, at: f.at, diameter: f.diameterExpr, ...(f.throughAll ? { throughAll: true } : { depth: f.depthExpr }), ...(f.counterbore ? { counterbore: f.counterbore } : {}), ...(f.countersink ? { countersink: f.countersink } : {}), ...(f.thread ? { thread: f.thread } : {}) };
    case "thread": return { id: f.id, kind: f.kind, name: f.name, at: f.at, axis: f.axis, spec: f.spec, operation: f.operation ?? (f.spec.internal ? "cut" : "new") };
    case "fillet":
    case "chamfer": return { id: f.id, kind: f.kind, name: f.name, size: f.sizeExpr, edges: f.edges };
    case "shell": return { id: f.id, kind: f.kind, name: f.name, thickness: f.thicknessExpr, openFaces: f.openFaces };
    case "pattern": return { id: f.id, kind: f.kind, name: f.name, mode: f.mode, count: f.count, step: f.step, axis: f.axis, angle: f.angle };
    case "mirror": return { id: f.id, kind: f.kind, name: f.name, plane: f.plane, bodies: f.bodies ?? "all" };
    case "loft": return { id: f.id, kind: f.kind, name: f.name, sketches: f.sketchIds, ruled: !!f.ruled, operation: f.operation ?? "new" };
    case "sweep": return { id: f.id, kind: f.kind, name: f.name, profile: f.profileSketch, path: f.pathSketch, operation: f.operation ?? "new" };
  }
}

/** Compact, id-rich summary of the document for the agent. */
export function describeDocument(doc: CadDocument, mode: string, activeSketchId: string | null, solids?: Record<string, SolidEval>): unknown {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  const rv = (v: { x: number; y: number; z: number }) => ({ x: r(v.x), y: r(v.y), z: r(v.z) });
  const sketches = Object.values(doc.sketches).map((sk) => ({
    id: sk.id,
    name: sk.name,
    plane: sk.planeId,
    // The sketch's world frame: world = origin + u*U + v*V; extrudes go along `normal`.
    frame: (() => { const wp = resolveSketchPlane(sk); return { origin: rv(wp.origin), u: rv(wp.u), v: rv(wp.v), normal: rv(wp.normal) }; })(),
    ...(sk.faceRef ? { onFace: true } : {}),
    status: sk.status,
    entities: Object.values(sk.entities).map((e) =>
      e.kind === "point" ? { id: e.id, kind: "point", x: r(e.x), y: r(e.y), fixed: !!e.fixed }
        : e.kind === "line" ? { id: e.id, kind: "line", p1: e.p1, p2: e.p2 }
          : e.kind === "circle" ? { id: e.id, kind: "circle", center: e.center, r: r(e.r) }
            : e.kind === "arc" ? { id: e.id, kind: "arc", center: e.center, p1: e.p1, p2: e.p2, r: r(e.r) }
              : e.kind === "spline" ? { id: e.id, kind: "spline", points: e.points }
                : { id: e.id, kind: "ellipse", center: (e as { center: string }).center }
    ),
    constraints: Object.values(sk.constraints).map((c) => ({ ...c })),
  }));
  return {
    mode,
    activeSketchId,
    sketches,
    features: Object.values(doc.features).map((f) => describeFeature(f)),
    parameters: doc.parameters.map((p) => ({ name: p.name, expr: p.expr, value: p.value, ...(p.configuredBy ? { configuredBy: p.configuredBy, baseExpr: p.baseExpr } : {}) })),
    ...(doc.hidden?.length ? { hidden: doc.hidden } : {}),
    // The configuration table: rows override parameters / suppress features while active.
    ...(doc.configurations?.length ? {
      configurations: doc.configurations.map((c) => ({ id: c.id, name: c.name, values: c.values, ...(c.suppress ? { suppress: c.suppress } : {}), ...(c.warnings ? { warnings: c.warnings } : {}) })),
      activeConfiguration: doc.activeConfiguration ? doc.configurations.find((c) => c.id === doc.activeConfiguration)?.name : null,
    } : {}),
    // Evaluation results per feature (when the host has them): bodies with bounds/volume, modifier status, warnings.
    ...(solids ? {
      bodies: Object.values(solids).filter((s) => s.mesh).map((s) => ({
        featureId: s.featureId, name: s.name, triangles: s.mesh!.triangleCount,
        ...(s.bounds ? { bounds: { min: rv(s.bounds.min), max: rv(s.bounds.max) } } : {}),
        ...(s.volume !== undefined ? { volume: r(s.volume) } : {}),
        ...(s.error ? { error: s.error } : {}),
      })),
      featureStatus: Object.values(solids).filter((s) => s.error || s.warning).map((s) => ({ featureId: s.featureId, ...(s.error ? { error: s.error } : {}), ...(s.warning ? { warning: s.warning } : {}) })),
    } : {}),
  };
}

export async function runAgent(opts: {
  apiKey: string;
  model: string;
  history: Anthropic.MessageParam[];
  registry: CommandRegistry;
  ctx: AgentContext;
  onText: (t: string) => void;
  onTool: (name: string, ok: boolean, detail: string) => void;
  signal?: AbortSignal;
}): Promise<Anthropic.MessageParam[]> {
  const client = new Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true });
  const tools = buildTools(opts.registry);
  const messages: Anthropic.MessageParam[] = [...opts.history];

  for (let step = 0; step < 50; step++) {
    if (opts.signal?.aborted) break;
    const resp = await client.messages.create(
      { model: opts.model, max_tokens: 8000, system: SYSTEM, tools, messages },
      { signal: opts.signal }
    );
    messages.push({ role: "assistant", content: resp.content });
    for (const b of resp.content) if (b.type === "text" && b.text.trim()) opts.onText(b.text);
    if (resp.stop_reason !== "tool_use") break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of resp.content) {
      if (b.type !== "tool_use") continue;
      // render_view returns an image block, not JSON.
      if (b.name === "render_view") {
        try {
          const a = b.input as { view?: string; width?: number; height?: number };
          const img = await opts.ctx.render({ view: a.view, width: a.width, height: a.height });
          opts.onTool("render_view", true, `rendered ${img.view}`);
          results.push({ type: "tool_result", tool_use_id: b.id, content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: img.base64 } }] });
        } catch (e) {
          opts.onTool("render_view", false, (e as Error).message);
          results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify({ ok: false, error: (e as Error).message }), is_error: true });
        }
        continue;
      }
      let result: { ok: boolean; createdIds?: string[]; message?: string; error?: string } | unknown;
      const readOnly = b.name === "get_state" || b.name === "get_hotkeys";
      try {
        if (b.name === "get_state") result = opts.ctx.describe();
        else if (b.name === "get_hotkeys") result = hotkeys.describe();
        else if (b.name === "set_hotkey") {
          const a = b.input as { action?: string; key?: string | null; slot?: "primary" | "secondary" };
          hotkeys.setBinding(String(a.action), a.slot === "secondary" ? "secondary" : "primary", a.key == null ? null : String(a.key));
          result = { ok: true, hotkeys: hotkeys.describe() };
        } else {
          result = await opts.ctx.runCommand(desanitize(b.name), b.input as Record<string, unknown>);
        }
      } catch (e) {
        result = { ok: false, error: (e as Error).message };
      }
      const ok = readOnly ? true : !!(result as { ok?: boolean }).ok;
      const detail = readOnly
        ? (b.name === "get_hotkeys" ? "read hotkeys" : "read state")
        : (result as { message?: string; error?: string }).error ?? (result as { message?: string }).message ?? "ok";
      opts.onTool(b.name, ok, detail);
      results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(result) });
    }
    messages.push({ role: "user", content: results });
  }
  return messages;
}
