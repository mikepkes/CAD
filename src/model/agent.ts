// Embedded CAD agent. Runs Claude (via the user's own API key, straight from the
// browser) in a tool-use loop where the tools ARE our command registry — the same
// commands the UI dispatches — so the agent builds sketches live in the app.
//
// The API key lives only in the user's browser (localStorage) and is sent only to
// api.anthropic.com. Nothing goes to any server of ours.

import Anthropic from "@anthropic-ai/sdk";
import { CommandRegistry } from "../core/command/registry";
import { CadDocument } from "../core/document";

export type ChatEntry =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "tool"; name: string; ok: boolean; detail: string }
  | { role: "error"; text: string };

export interface AgentContext {
  describe: () => unknown;
  runCommand: (type: string, params: Record<string, unknown>) => Promise<{ ok: boolean; createdIds?: string[]; message?: string; error?: string }>;
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
  return tools;
}

/** Compact, id-rich summary of the document for the agent. */
export function describeDocument(doc: CadDocument, mode: string, activeSketchId: string | null): unknown {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  const sketches = Object.values(doc.sketches).map((sk) => ({
    id: sk.id,
    plane: sk.planeId,
    status: sk.status,
    entities: Object.values(sk.entities).map((e) =>
      e.kind === "point" ? { id: e.id, kind: "point", x: r(e.x), y: r(e.y), fixed: !!e.fixed }
        : e.kind === "line" ? { id: e.id, kind: "line", p1: e.p1, p2: e.p2 }
          : e.kind === "circle" ? { id: e.id, kind: "circle", center: e.center, r: r(e.r) }
            : e.kind === "arc" ? { id: e.id, kind: "arc", center: e.center, p1: e.p1, p2: e.p2, r: r(e.r) }
              : { id: e.id, kind: "ellipse", center: (e as { center: string }).center }
    ),
    constraints: Object.values(sk.constraints).map((c) => ({ ...c })),
  }));
  return {
    mode,
    activeSketchId,
    sketches,
    features: Object.values(doc.features).map((f) => ({ id: f.id, kind: f.kind, sketchId: f.sketchId, distance: f.distanceExpr })),
    parameters: doc.parameters.map((p) => ({ name: p.name, expr: p.expr, value: p.value })),
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
      let result: { ok: boolean; createdIds?: string[]; message?: string; error?: string } | unknown;
      try {
        result = b.name === "get_state"
          ? opts.ctx.describe()
          : await opts.ctx.runCommand(desanitize(b.name), b.input as Record<string, unknown>);
      } catch (e) {
        result = { ok: false, error: (e as Error).message };
      }
      const ok = b.name === "get_state" ? true : !!(result as { ok?: boolean }).ok;
      const detail = b.name === "get_state"
        ? "read state"
        : (result as { message?: string; error?: string }).error ?? (result as { message?: string }).message ?? "ok";
      opts.onTool(b.name, ok, detail);
      results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(result) });
    }
    messages.push({ role: "user", content: results });
  }
  return messages;
}
