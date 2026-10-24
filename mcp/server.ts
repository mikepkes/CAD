// MCP server exposing the Chisel CAD core to an LLM/agent.
//
// Every registry command becomes a tool; plus timeline/undo/query tools. After
// any mutation the response carries the solver diagnosis (DoF, fully
// constrained, conflicts) so the agent gets immediate, structured feedback and
// can self-correct — the same incremental over-constraint signal the UI uses.
//
// The core is renderer-agnostic and runs headless here (PlaneGCS via WASM), so
// an agent can build and edit CNC/3D-print-ready models with no browser.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CadSession, DispatchResult } from "../src/core/command/session";
import { createDefaultRegistry } from "../src/core/command/builtins";
import { CadDocument, createDocument } from "../src/core/document";
import { PlaneGCSSolver, PlaneGCSOptions } from "../src/core/solver/planegcs";
import { Evaluations } from "../src/core/recompute";
import { JSONSchema } from "../src/core/command/types";
import { initKernel, isKernelReady } from "../src/core/occ/kernel";
import { evaluateFeatures, exportFeatureBlob } from "../src/core/features";
import { resolveParameters } from "../src/model/parameters";

let kernelInit: Promise<void> | null = null;
async function ensureKernel(): Promise<void> {
  if (!kernelInit) {
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve("replicad-opencascadejs/wasm");
    kernelInit = initKernel({ wasmBinary: readFileSync(wasmPath) });
  }
  await kernelInit;
}

const COMMAND_PREFIX_SEP = "__"; // "sketch.addLine" <-> "sketch__addLine"
const toToolName = (cmd: string) => cmd.replace(/\./g, COMMAND_PREFIX_SEP);
const fromToolName = (name: string) => name.replace(new RegExp(COMMAND_PREFIX_SEP, "g"), ".");

interface ToolDef {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export function createCadMcpServer(opts: PlaneGCSOptions = {}) {
  const registry = createDefaultRegistry();
  const solver = new PlaneGCSSolver(opts);
  let session = new CadSession(createDocument(), registry, solver);

  const server = new Server(
    { name: "chisel-cad", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  // ---- response shaping ----
  const diagnoseAll = (evals: Evaluations) =>
    Object.values(evals).map((e) => ({
      sketch: e.sketchId,
      dof: e.diagnosis.dof,
      fullyConstrained: e.diagnosis.fullyConstrained,
      conflicting: e.diagnosis.conflicting,
      redundant: e.diagnosis.redundant,
      status: e.message,
    }));

  const shapeDispatch = (r: DispatchResult) => ({
    ok: r.ok,
    opId: r.opId,
    createdIds: r.createdIds,
    error: r.error,
    conflicting: r.conflicting,
    message: r.message,
    sketches: diagnoseAll(r.evaluations),
  });

  const documentSummary = () => ({
    units: session.doc.units,
    parameters: session.doc.parameters.map((p) => ({ name: p.name, expr: p.expr, value: p.value, error: p.error })),
    sketches: Object.values(session.doc.sketches).map((s) => ({
      id: s.id,
      name: s.name,
      plane: s.planeId,
      entities: Object.keys(s.entities).length,
      constraints: Object.keys(s.constraints).length,
      dof: s.status.dof,
      fullyConstrained: s.status.fullyConstrained,
      status: s.status.message,
    })),
    timeline: session.timeline.map((o, i) => ({
      index: i,
      opId: o.opId,
      type: o.type,
      active: i < session.rollbackIndex && !o.suppressed,
      suppressed: !!o.suppressed,
      error: o.error,
    })),
    rollbackIndex: session.rollbackIndex,
  });

  const describeSketch = (sketchId: string) => {
    const s = session.doc.sketches[sketchId];
    if (!s) return { error: `No sketch "${sketchId}"` };
    const e = session.evaluations[sketchId];
    return {
      id: s.id,
      name: s.name,
      plane: s.planeId,
      diagnosis: e
        ? { dof: e.diagnosis.dof, fullyConstrained: e.diagnosis.fullyConstrained, conflicting: e.diagnosis.conflicting, redundant: e.diagnosis.redundant }
        : undefined,
      entities: Object.values(s.entities).map((ent) =>
        ent.kind === "point"
          ? { id: ent.id, kind: "point", x: round(ent.x), y: round(ent.y), fixed: !!ent.fixed }
          : ent.kind === "line"
            ? { id: ent.id, kind: "line", p1: ent.p1, p2: ent.p2 }
            : ent.kind === "circle"
              ? { id: ent.id, kind: "circle", center: ent.center, r: round(ent.r) }
              : ent.kind === "arc"
                ? { id: ent.id, kind: "arc", center: ent.center, start: ent.p1, end: ent.p2, r: round(ent.r) }
                : { id: ent.id, kind: "ellipse", center: ent.center, rx: round(ent.rx), ry: round(ent.ry), rotation: round(ent.rotation) }
      ),
      constraints: Object.values(s.constraints).map((c) => ({ ...c })),
    };
  };

  // ---- tool set: registry commands + meta tools ----
  const tools: ToolDef[] = [];

  for (const def of registry.list()) {
    const mcp = registry.toMcpTools().find((t) => t.name === def.type)!;
    tools.push({
      name: toToolName(def.type),
      description: mcp.description,
      inputSchema: mcp.inputSchema,
      handler: async (args) => shapeDispatch(await session.dispatch(def.type, args)),
    });
  }

  const metaTools: ToolDef[] = [
    {
      name: "get_document",
      description: "Return a summary of the whole document: parameters, sketches (with DoF/constraint status), and the operation timeline.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => documentSummary(),
    },
    {
      name: "describe_sketch",
      description: "Return a sketch in full: every entity with solved coordinates, every constraint, and the DoF/conflict diagnosis. Use this to reason about what to constrain next.",
      inputSchema: { type: "object", required: ["sketch"], properties: { sketch: { type: "string" } } },
      handler: async (a) => describeSketch(String(a.sketch)),
    },
    {
      name: "list_timeline",
      description: "List the parametric timeline (the ordered operation recipe) with each operation's status and whether it is active/suppressed/errored.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => documentSummary().timeline,
    },
    {
      name: "edit_operation",
      description: "Edit an earlier operation's params by opId; the model replays and downstream operations update. Undoable.",
      inputSchema: {
        type: "object",
        required: ["opId", "params"],
        properties: { opId: { type: "string" }, params: { type: "object" } },
      },
      handler: async (a) => shapeDispatch(await session.editOperation(String(a.opId), a.params as Record<string, unknown>)),
    },
    {
      name: "suppress_operation",
      description: "Suppress or unsuppress an operation (skipped during replay). Undoable.",
      inputSchema: {
        type: "object",
        required: ["opId", "suppressed"],
        properties: { opId: { type: "string" }, suppressed: { type: "boolean" } },
      },
      handler: async (a) => shapeDispatch(await session.setSuppressed(String(a.opId), Boolean(a.suppressed))),
    },
    {
      name: "delete_operation",
      description: "Delete an operation from the timeline. Downstream operations that referenced it will report an error.",
      inputSchema: { type: "object", required: ["opId"], properties: { opId: { type: "string" } } },
      handler: async (a) => shapeDispatch(await session.deleteOperation(String(a.opId))),
    },
    {
      name: "move_rollback",
      description: "Move the rollback bar: operations at index >= `index` become inactive (rolled back). Undoable.",
      inputSchema: { type: "object", required: ["index"], properties: { index: { type: "integer", minimum: 0 } } },
      handler: async (a) => shapeDispatch(await session.moveRollback(Number(a.index))),
    },
    {
      name: "undo",
      description: "Undo the last edit transaction.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ ok: session.undo(), sketches: diagnoseAll(session.evaluations) }),
    },
    {
      name: "redo",
      description: "Redo the last undone edit transaction.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ ok: session.redo(), sketches: diagnoseAll(session.evaluations) }),
    },
    {
      name: "get_solids",
      description: "Evaluate the 3D solid features (extrudes) with the OpenCASCADE kernel and return a summary per feature (triangle count, distance, or error).",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        await ensureKernel();
        const scope = resolveParameters(session.doc.parameters).scope;
        const solids = evaluateFeatures(session.doc, scope);
        return {
          kernelReady: isKernelReady(),
          solids: Object.values(solids).map((s) => ({ featureId: s.featureId, name: s.name, sketch: s.sketchId, distance: s.distance, triangles: s.mesh?.triangleCount, error: s.error })),
        };
      },
    },
    {
      name: "export_model",
      description: "Export a solid feature to STL (3D print) or STEP (CAD/CNC). Returns base64-encoded file bytes. If featureId is omitted, the first feature is used.",
      inputSchema: {
        type: "object",
        required: ["format"],
        properties: { format: { type: "string", enum: ["stl", "step"] }, featureId: { type: "string" } },
      },
      handler: async (a) => {
        await ensureKernel();
        const scope = resolveParameters(session.doc.parameters).scope;
        const fid = (a.featureId as string) || Object.keys(session.doc.features)[0];
        if (!fid) return { ok: false, error: "No feature to export — run feature.extrude first." };
        const blob = exportFeatureBlob(session.doc, scope, fid, a.format as "stl" | "step");
        if (!blob) return { ok: false, error: "Export failed (no closed profile?)." };
        const buf = Buffer.from(await blob.arrayBuffer());
        return { ok: true, featureId: fid, format: a.format, bytes: buf.length, base64: buf.toString("base64") };
      },
    },
    {
      name: "export_document",
      description: "Return the full document as JSON (the canonical recipe). Save this to persist or hand to the browser app.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ document: session.doc }),
    },
    {
      name: "import_document",
      description: "Load a document from JSON (replaces the current one) and recompute it.",
      inputSchema: { type: "object", required: ["document"], properties: { document: { type: "object" } } },
      handler: async (a) => {
        session = new CadSession(a.document as unknown as CadDocument, registry, solver);
        const evals = await session.recompute();
        return { ok: true, sketches: diagnoseAll(evals) };
      },
    },
  ];
  tools.push(...metaTools);

  const byName = new Map(tools.map((t) => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool "${req.params.name}"` }], isError: true };
    }
    try {
      const result = await tool.handler(req.params.arguments ?? {});
      const isError = typeof result === "object" && result !== null && (result as { ok?: boolean }).ok === false;
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  });

  return { server, getSession: () => session, registry, commandToolNames: registry.list().map((d) => toToolName(d.type)), fromToolName };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
