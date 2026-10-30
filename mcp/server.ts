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
import { resolveParameters } from "../src/core/parameters";
import { pickFace } from "../src/core/geometry/pick";
import { resolveSketchPlane } from "../src/geometry/plane";
import { describeFeature } from "../src/model/agent";
import { InlineGeometryBackend } from "../src/core/geometry/backend";
import type { Vec3 } from "../src/math/vec";

/** Topology / distance queries share the backend's assembly-aware evaluation (the kernel is loaded by ensureKernel). */
const geometry = new InlineGeometryBackend();

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
  annotations?: ToolAnnotations;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/** MCP tool annotations (hints a client uses to decide what needs confirmation). */
interface ToolAnnotations { title?: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const EDIT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
/** Meta tools by how they touch the document (registry commands carry their own flag). */
const META_ANNOTATIONS: Record<string, ToolAnnotations> = {
  get_document: READ_ONLY, describe_sketch: READ_ONLY, list_timeline: READ_ONLY, get_solids: READ_ONLY, measure: READ_ONLY, body_topology: READ_ONLY,
  export_model: READ_ONLY, export_document: READ_ONLY,
  delete_operation: DESTRUCTIVE, import_document: DESTRUCTIVE, batch: DESTRUCTIVE,
};
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const rounded = <T>(v: T): T => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "number" ? round6(x) : x)));

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
    features: Object.values(session.doc.features).map((f) => describeFeature(f)),
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
                : ent.kind === "spline"
                  ? { id: ent.id, kind: "spline", points: ent.points }
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
      annotations: { ...(mcp.destructive ? DESTRUCTIVE : EDIT), title: mcp.title },
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
      description: "Evaluate the 3D features with the OpenCASCADE kernel and return a summary per feature: bodies (triangle count, world bounds, volume) and modifier status, with any error or warning (e.g. a cut that removed nothing).",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        await ensureKernel();
        const scope = resolveParameters(session.doc.parameters).scope;
        const solids = evaluateFeatures(session.doc, scope);
        return {
          kernelReady: isKernelReady(),
          solids: Object.values(solids).map((s) => ({ featureId: s.featureId, name: s.name, sketch: s.sketchId, distance: s.distance, triangles: s.mesh?.triangleCount, bounds: s.bounds, volume: s.volume, area: s.area, centroid: s.centroid, error: s.error, warning: s.warning })),
        };
      },
    },
    {
      name: "sketch_on_face",
      description: "Start a sketch on a planar body face: by its topological `face` name from body_topology (e.g. \"extrude3:end\"; preferred — the sketch then follows that face through upstream edits), or the face nearest a world `point` {x,y,z}. Returns the sketch id, origin id, the face name and the sketch's world frame (origin, u, v, normal): extrude direction \"reverse\" goes into the body, extent \"throughAll\" cuts all the way through.",
      inputSchema: {
        type: "object",
        properties: {
          face: { type: "string", description: "Topological face name (from body_topology)." },
          point: { type: "object", required: ["x", "y", "z"], properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
          name: { type: "string" },
        },
      },
      handler: async (a) => {
        await ensureKernel();
        const point = a.point as { x: number; y: number; z: number } | undefined;
        let at: { origin: Vec3; normal: Vec3; point: Vec3; featureId: string; distance: number; name?: string };
        if (a.face) {
          const hits = (await geometry.topology(session.doc, { edges: false })).flatMap((b) => b.faces.filter((f) => f.name === a.face && f.type === "PLANE").map((f) => ({ b, f })));
          if (!hits.length) return { ok: false, error: `no planar face named "${a.face}" — list names with body_topology` };
          const d2 = (c: Vec3) => (point ? (c.x - point.x) ** 2 + (c.y - point.y) ** 2 + (c.z - point.z) ** 2 : 0);
          const { b, f } = hits.reduce((m, h) => (d2(h.f.center) < d2(m.f.center) ? h : m));
          const off = f.center.x * f.normal.x + f.center.y * f.normal.y + f.center.z * f.normal.z;
          at = { origin: { x: f.normal.x * off, y: f.normal.y * off, z: f.normal.z * off }, normal: f.normal, point: f.center, featureId: b.id, distance: 0, name: String(a.face) };
        } else {
          if (!point) return { ok: false, error: "give a face name or a world point" };
          const scope = resolveParameters(session.doc.parameters).scope;
          const solids = evaluateFeatures(session.doc, scope);
          const meshes = Object.values(solids).filter((s) => s.mesh).map((s) => ({ featureId: s.featureId, mesh: s.mesh! }));
          const hit = pickFace(meshes, point);
          if (!hit) return { ok: false, error: "no body face found — build a solid first" };
          at = { origin: hit.origin, normal: hit.normal, point: hit.point, featureId: hit.featureId, distance: hit.distance, name: hit.faceName };
        }
        const r = await session.dispatch("sketch.create", { planeDef: { origin: at.origin, normal: at.normal }, faceRef: { normal: at.normal, point: at.point, ...(at.name ? { name: at.name } : {}) }, ...(a.name ? { name: a.name } : {}) });
        if (!r.ok) return { ok: false, error: r.error };
        const wp = resolveSketchPlane(session.doc.sketches[r.createdIds[0]]);
        return { ok: true, sketchId: r.createdIds[0], originId: r.createdIds[1], featureId: at.featureId, face: at.name, distanceToFace: at.distance, frame: { origin: wp.origin, u: wp.u, v: wp.v, normal: wp.normal } };
      },
    },
    {
      name: "measure",
      description: "Exact (B-rep, not mesh) mass properties of the bodies: volume (mm³), surface area (mm²), centroid and world bounds — every body, or one (`body`: the id of the feature that created it). With `between: [bodyA, bodyB]`, also their minimum distance (0 when they touch or overlap).",
      inputSchema: { type: "object", properties: { body: { type: "string" }, between: { type: "array", items: { type: "string" } } } },
      handler: async (a) => {
        await ensureKernel();
        const bodies = await geometry.topology(session.doc, { bodyId: a.body as string | undefined, faces: false, edges: false });
        if (a.body && !bodies.length) return { ok: false, error: `no body "${a.body}"` };
        const out: Record<string, unknown> = { ok: true, bodies: bodies.map((b) => rounded({ id: b.id, name: b.name, volume: b.volume, area: b.area, centroid: b.centroid, bounds: b.bounds })) };
        const between = a.between as string[] | undefined;
        if (between) {
          if (between.length !== 2) return { ok: false, error: "`between` takes exactly two body ids" };
          out.distance = round6(await geometry.distance(session.doc, between[0], between[1]));
        }
        return out;
      },
    },
    {
      name: "body_topology",
      description: "The faces and edges of each body (or one: `body`), with stable topological names. A face is named by the feature that made it — \"extrude3:end\", \"extrude3:side:line7\" (the sketch line that swept it), \"prim2:+X\", \"hole9:bore\", \"fillet6:blend(…)\" — and keeps that name through later features. Each edge is named by the two faces it separates (\"A|B\"). Use face names with sketch_on_face and edge names in a fillet/chamfer `edges: { names: [...] }` selector.",
      inputSchema: { type: "object", properties: { body: { type: "string" }, faces: { type: "boolean" }, edges: { type: "boolean" } } },
      handler: async (a) => {
        await ensureKernel();
        const bodies = await geometry.topology(session.doc, { bodyId: a.body as string | undefined, faces: a.faces !== false, edges: a.edges !== false });
        if (a.body && !bodies.length) return { ok: false, error: `no body "${a.body}"` };
        return { ok: true, bodies: bodies.map((b) => rounded({
          id: b.id, name: b.name, volume: b.volume, area: b.area, centroid: b.centroid,
          faces: b.faces.map((f) => ({ name: f.name, type: f.type.toLowerCase(), area: f.area, center: f.center, normal: f.normal, point: f.point })),
          edges: b.edges.map((e) => ({ name: e.name, type: e.type.toLowerCase(), length: e.length, mid: e.mid })),
        })) };
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
      name: "import_step",
      description: "Import a STEP file from disk (a .step/.stp path) as a body — the same as feature.import with the file's text, which is stored in the document. Optional `at` offset, `operation` (new/join/cut/intersect), `body`, `name`.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
          at: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
          operation: { type: "string", enum: ["new", "join", "cut", "intersect"] },
          body: { type: "string" },
          name: { type: "string" },
        },
      },
      handler: async (a) => {
        const path = String(a.path ?? "");
        if (!/\.(step|stp)$/i.test(path)) return { ok: false, error: "path must be a .step or .stp file" };
        const { path: _p, ...rest } = a;
        const name = (a.name as string | undefined) ?? path.split(/[\\/]/).pop()!.replace(/\.(step|stp)$/i, "");
        return shapeDispatch(await session.dispatch("feature.import", { ...rest, name, data: readFileSync(path, "utf8") }));
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
  tools.push({
    name: "batch",
    description: "Run several tool calls in order as one transaction: `steps` is a list of {tool, arguments}. By default (`atomic: true`) the first failing step rolls the document (and its undo history) back to before the batch; `atomic: false` keeps the steps that succeeded. Returns each step's result and time in ms, which step failed, and whether it rolled back.",
    inputSchema: {
      type: "object",
      required: ["steps"],
      properties: {
        steps: { type: "array", items: { type: "object", required: ["tool"], properties: { tool: { type: "string" }, arguments: { type: "object" } } } },
        atomic: { type: "boolean", description: "Roll everything back if a step fails (default true)." },
      },
    },
    handler: async (a) => {
      const steps = (Array.isArray(a.steps) ? a.steps : []) as { tool?: string; arguments?: Record<string, unknown> }[];
      const atomic = a.atomic !== false;
      const start = { session, state: session.checkpoint() };
      const results: { step: number; tool: string; ok: boolean; ms: number; result?: unknown }[] = [];
      const failAt = (i: number) => {
        if (atomic) { session = start.session; session.rollback(start.state); }
        return { ok: false, failedStep: i, rolledBack: atomic, results };
      };
      for (let i = 0; i < steps.length; i++) {
        const name = String(steps[i]?.tool ?? "");
        const tool = name === "batch" ? undefined : byName.get(name);
        if (!tool) { results.push({ step: i, tool: name, ok: false, ms: 0, result: { error: `Unknown tool "${name}"` } }); return failAt(i); }
        const t0 = performance.now();
        let result: unknown;
        try { result = await tool.handler(steps[i].arguments ?? {}); }
        catch (e) { result = { ok: false, error: (e as Error).message }; }
        const ok = !(typeof result === "object" && result !== null && (result as { ok?: boolean }).ok === false);
        results.push({ step: i, tool: name, ok, ms: Math.round(performance.now() - t0), result });
        if (!ok) return failAt(i);
      }
      return { ok: true, results };
    },
  });
  for (const t of tools) t.annotations ??= META_ANNOTATIONS[t.name] ?? EDIT;

  const byName = new Map(tools.map((t) => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
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
