import { create } from "zustand";
import planegcsWasmUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import occWasmUrl from "replicad-opencascadejs/wasm?url";

import { CadSession, DispatchResult } from "../core/command/session";
import { createDefaultRegistry } from "../core/command/builtins";
import { createDocument } from "../core/document";
import { PlaneGCSSolver } from "../core/solver/planegcs";
import { Evaluations } from "../core/recompute";
import { resolveParameters } from "./parameters";
import { availableOps } from "./selectionOps";
import type AnthropicNS from "@anthropic-ai/sdk";
import { ChatEntry, describeDocument, runAgent } from "./agent";
import { enableWebMcp, disableWebMcp } from "./webmcp";

const AGENT_KEY_LS = "chisel.anthropic.key";
const AGENT_MODEL_LS = "chisel.anthropic.model";
const WEBMCP_LS = "chisel.webmcp.enabled";
const readLS = (k: string, d = "") => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
import { solveDrag } from "../core/drag";
import { Sketch } from "../sketch/types";
import { initKernel } from "../core/occ/kernel";
import { evaluateFeatures, exportFeatureBlob, featureEdges, SolidEval } from "../core/features";
import { projectEdges } from "../core/geometry/project";
import { resolveSketchPlane } from "../geometry/plane";
import { CadDocument } from "../core/document";
import { serializeDocument, deserializeDocument } from "../core/persistence";

const AUTOSAVE_KEY = "chisel.autosave.v1";
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

// Agent conversation state lives outside the store (not React-reactive): the full
// Anthropic message history (for multi-turn) and the in-flight request's aborter.
let agentHistory: AnthropicNS.MessageParam[] = [];
let agentAbort: AbortController | null = null;

export type Tool = "select" | "line" | "rectangle" | "circle" | "arc" | "point" | "dimension" | "trim" | "extend" | "polygon" | "slot" | "ellipse";

/** Default variant per shape tool, and the choices the UI offers. */
export const TOOL_VARIANTS: Partial<Record<Tool, { id: string; label: string }[]>> = {
  circle: [{ id: "center", label: "Center" }, { id: "2point", label: "2-Point" }, { id: "3point", label: "3-Point" }],
  rectangle: [{ id: "corner", label: "2-Corner" }, { id: "center", label: "Center" }, { id: "3point", label: "3-Point" }],
  arc: [{ id: "center", label: "Center" }, { id: "3point", label: "3-Point" }],
};
const DEFAULT_VARIANT: Partial<Record<Tool, string>> = { circle: "center", rectangle: "corner", arc: "center" };
export type AppMode = "model" | "sketch";
export type GeoRef = { x: number; y: number } | { ref: string };

/** A pending in-canvas numeric/expression editor (dimension placement or edit). */
export type InlineEdit =
  | { mode: "new"; params: Record<string, unknown>; value: string; screen: { x: number; y: number } }
  | { mode: "edit"; cid: string; value: string; screen: { x: number; y: number } };

export interface Toast {
  kind: "error" | "info";
  text: string;
}

const registry = createDefaultRegistry();
const solver = new PlaneGCSSolver({ wasmUrl: planegcsWasmUrl });
const session = new CadSession(createDocument(), registry, solver);

export interface AppState {
  session: CadSession;
  rev: number;
  ready: boolean;

  mode: AppMode;
  activeSketchId: string | null;
  tool: Tool;
  /** Variant of the active shape tool (e.g. circle "center"|"2point"|"3point"). */
  toolVariant: string;
  /** Active explicit constraint tool (e.g. "coincident"); clicks pick its entities. */
  constraintTool: string | null;
  /** When on, newly drawn geometry is construction (reference) — excluded from fills. */
  constructionMode: boolean;
  selection: string[];
  hover: string | null;
  showPlanes: boolean;
  showGrid: boolean;
  showConstraints: boolean;

  dragging: { pointId: string } | null;
  transient: Record<string, { x: number; y: number }> | null;
  draggingDim: { cid: string } | null;
  transientDimLabel: { cid: string; x: number; y: number } | null;
  inlineEdit: InlineEdit | null;
  contextMenu: { x: number; y: number } | null;

  // 3D solids (derived from features via the OCC kernel)
  solids: Record<string, SolidEval>;
  kernelReady: boolean;
  kernelLoading: boolean;

  toast: Toast | null;
  lastMessage: string;

  // embedded agent (BYO Claude API key, stored in the browser only)
  settingsOpen: boolean;
  hotkeysOpen: boolean;
  agentOpen: boolean;
  apiKey: string;
  agentModel: string;
  agentChat: ChatEntry[];
  agentRunning: boolean;
  /** Expose the app's commands to in-browser external agents via WebMCP. */
  webMcpEnabled: boolean;

  // generic command dispatch (used by the constraint/dimension bar)
  dispatch: (type: string, params: Record<string, unknown>, opts?: { rejectOnConflict?: boolean }) => Promise<DispatchResult>;

  // ui
  setTool: (t: Tool) => void;
  setToolVariant: (v: string) => void;
  setConstraintTool: (type: string | null) => void;
  setConstructionMode: (on: boolean) => void;
  toggleConstruction: () => void;
  pickForConstraint: (id: string) => Promise<void>;
  select: (ids: string[], additive?: boolean) => void;
  toggleSelect: (id: string) => void;
  clearSelection: () => void;
  setHover: (id: string | null) => void;
  toggleShowPlanes: () => void;
  toggleShowGrid: () => void;
  toggleShowConstraints: () => void;
  dismissToast: () => void;

  // sketch lifecycle
  startSketch: (plane: string, offset?: number) => Promise<void>;
  startSketchOnFace: (hit: { x: number; y: number; z: number }, normal: { x: number; y: number; z: number }) => Promise<void>;
  finishSketch: () => void;
  editSketch: (id: string) => void;

  // drawing tools (return created ids for chaining)
  placePoint: (x: number, y: number) => Promise<DispatchResult>;
  placeLine: (start: GeoRef, end: GeoRef) => Promise<DispatchResult>;
  placeRectangle: (corner: { x: number; y: number }, opposite: { x: number; y: number }) => Promise<DispatchResult>;
  placeCircle: (center: GeoRef, radius: number) => Promise<DispatchResult>;
  placeArc: (center: GeoRef, start: GeoRef, end: GeoRef, ccw: boolean) => Promise<DispatchResult>;
  placePolygon: (center: { x: number; y: number }, vertex: { x: number; y: number }, sides?: number) => Promise<DispatchResult>;
  placeRectangle3: (p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }) => Promise<DispatchResult>;
  placeSlot: (p1: { x: number; y: number }, p2: { x: number; y: number }, width: number) => Promise<DispatchResult>;
  placeEllipse: (center: { x: number; y: number }, rx: number, ry: number, rotation: number) => Promise<DispatchResult>;
  projectBodies: (construction?: boolean) => Promise<void>;
  deleteSelected: () => Promise<void>;

  // drag
  beginDrag: (pointId: string) => void;
  dragTo: (x: number, y: number) => Promise<void>;
  endDrag: () => Promise<void>;
  // dimension annotation drag (repositioning)
  beginDimDrag: (cid: string) => void;
  dimDragTo: (x: number, y: number) => void;
  endDimDrag: () => Promise<void>;
  renderSketch: () => Sketch | null;

  // parameters
  addParameter: (name?: string, expr?: string) => Promise<void>;
  setParameterExpr: (name: string, expr: string) => Promise<void>;
  renameParameter: (name: string, newName: string) => Promise<void>;
  deleteParameter: (name: string) => Promise<void>;

  // constraints/dimensions by id (mapped to their creating operation)
  editDimension: (constraintId: string, expr: string) => Promise<void>;
  toggleDrivenDimension: (constraintId: string) => Promise<void>;
  deleteConstraintById: (constraintId: string) => Promise<void>;

  // in-canvas dimension editor
  beginInlineEdit: (edit: InlineEdit) => void;
  commitInlineEdit: (expr: string) => Promise<void>;
  cancelInlineEdit: () => void;

  // right-click context menu
  openContextMenu: (x: number, y: number) => void;
  closeContextMenu: () => void;

  // timeline groups (organization)
  createTimelineGroup: (opIds: string[], name?: string) => void;
  renameTimelineGroup: (id: string, name: string) => void;
  toggleTimelineGroup: (id: string) => void;
  ungroupTimeline: (id: string) => void;

  // timeline / history
  undo: () => void;
  redo: () => void;
  editOperation: (opId: string, params: Record<string, unknown>) => Promise<void>;
  suppressOperation: (opId: string, suppressed: boolean) => Promise<void>;
  deleteOperation: (opId: string) => Promise<void>;
  moveRollback: (index: number) => Promise<void>;

  // features (3D)
  ensureKernel: () => Promise<void>;
  rebuildSolids: () => Promise<void>;
  extrudeSketch: (sketchId: string, distanceExpr?: string, opts?: { operation?: "new" | "join" | "cut"; symmetric?: boolean; region?: { x: number; y: number } }) => Promise<void>;
  /** The sketch currently targeted by the Extrude panel (model mode), or null. */
  extrudeTarget: string | null;
  openExtrude: (sketchId?: string) => void;
  closeExtrude: () => void;
  editFeatureDistance: (featureId: string, expr: string) => Promise<void>;
  deleteFeature: (featureId: string) => Promise<void>;
  exportSolid: (format: "stl" | "step") => Promise<void>;

  // agent
  setSettingsOpen: (open: boolean) => void;
  setHotkeysOpen: (open: boolean) => void;
  toggleAgent: () => void;
  setApiKey: (key: string) => void;
  setAgentModel: (model: string) => void;
  sendAgentMessage: (text: string) => Promise<void>;
  stopAgent: () => void;
  clearAgentChat: () => void;
  setWebMcpEnabled: (on: boolean) => void;

  // persistence
  initApp: () => Promise<void>;
  newDocument: () => Promise<void>;
  loadDocument: (doc: CadDocument) => Promise<void>;
  saveToFile: () => void;
  openFile: (file: File) => Promise<void>;
}

function toastFor(r: DispatchResult): Toast | null {
  if (r.ok) return null;
  const extra = r.conflicting && r.conflicting.length ? ` — conflicts: ${r.conflicting.join(", ")}` : "";
  return { kind: "error", text: (r.error ?? "Rejected") + extra };
}

export const useStore = create<AppState>((set, get) => {
  const bump = (extra: Partial<AppState> = {}) => set((s) => ({ rev: s.rev + 1, ...extra }));

  const scheduleAutosave = () => {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, serializeDocument(get().session.doc));
      } catch {
        /* storage unavailable (private mode, quota) — non-fatal */
      }
    }, 500);
  };

  const afterMutate = () => {
    if (Object.keys(get().session.doc.features).length) void get().rebuildSolids();
    scheduleAutosave();
  };

  const runDispatch = async (type: string, params: Record<string, unknown>, opts?: { rejectOnConflict?: boolean }) => {
    const r = await get().session.dispatch(type, params, opts);
    bump({ ready: true, toast: toastFor(r), lastMessage: r.ok ? r.message ?? "" : r.error ?? "" });
    afterMutate();
    return r;
  };

  const activeId = () => get().activeSketchId;
  const scope = () => resolveParameters(get().session.doc.parameters).scope;

  // Shared command host for both the in-app agent and WebMCP: dispatch a command
  // and keep the viewport in sync (activate a new sketch, switch to model on extrude).
  const commandHost = () => ({
    describe: () => describeDocument(get().session.doc, get().mode, get().activeSketchId),
    runCommand: async (type: string, params: Record<string, unknown>) => {
      const r = await runDispatch(type, params);
      if (r.ok && type === "sketch.create") set({ mode: "sketch", activeSketchId: r.createdIds[0], tool: "select" });
      if (r.ok && type === "feature.extrude") set({ mode: "model" });
      return { ok: r.ok, createdIds: r.createdIds, message: r.message, error: r.error };
    },
  });

  return {
    session,
    rev: 0,
    ready: false,
    mode: "model",
    activeSketchId: null,
    tool: "select",
    toolVariant: "",
    constraintTool: null,
    constructionMode: false,
    selection: [],
    hover: null,
    showPlanes: true,
    showGrid: true,
    showConstraints: true,
    dragging: null,
    transient: null,
    draggingDim: null,
    transientDimLabel: null,
    inlineEdit: null,
    contextMenu: null,
    solids: {},
    kernelReady: false,
    kernelLoading: false,
    toast: null,
    lastMessage: "Pick an origin plane to start a sketch.",
    settingsOpen: false,
    hotkeysOpen: false,
    extrudeTarget: null,
    agentOpen: false,
    apiKey: readLS(AGENT_KEY_LS),
    agentModel: readLS(AGENT_MODEL_LS, "claude-opus-5-5"),
    agentChat: [],
    agentRunning: false,
    webMcpEnabled: readLS(WEBMCP_LS) === "1",

    dispatch: (type, params, opts) => runDispatch(type, params, opts),

    setTool: (t) => set({ tool: t, toolVariant: DEFAULT_VARIANT[t] ?? "", constraintTool: null }),
    setToolVariant: (v) => set({ toolVariant: v }),
    setConstraintTool: (type) => set({ constraintTool: type, tool: "select", selection: [] }),
    setConstructionMode: (on) => set({ constructionMode: on }),
    toggleConstruction: () => {
      // With geometry selected, convert it (toggle construction) like the X key
      // or the context menu. With nothing selected, arm/disarm construction
      // draw mode so subsequent geometry comes in as reference, Fusion-style.
      const s = get();
      const sk = activeSketch(s);
      if (sk && s.selection.length) {
        const op = availableOps(sk, s.selection).modify.find((o) => o.id === "construction");
        if (op) { void runDispatch(op.command.type, op.command.params); return; }
      }
      set({ constructionMode: !s.constructionMode });
    },
    pickForConstraint: async (id) => {
      const type = get().constraintTool;
      const sk = activeSketch(get());
      if (!type || !sk) return;
      let picks = get().selection.includes(id) ? get().selection : [...get().selection, id];
      const op = availableOps(sk, picks).geometric.find((o) => (o.command.params as { type?: string }).type === type);
      if (op) {
        await runDispatch(op.command.type, op.command.params, { rejectOnConflict: true });
        set({ selection: [] });
      } else {
        // No match yet — keep accumulating; restart if we've overshot the max arity.
        if (picks.length >= 3) picks = [id];
        set({ selection: picks });
      }
    },
    select: (ids, additive) => set((s) => ({ selection: additive ? [...new Set([...s.selection, ...ids])] : ids })),
    toggleSelect: (id) =>
      set((s) => ({ selection: s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id] })),
    clearSelection: () => set({ selection: [] }),
    setHover: (id) => set({ hover: id }),
    toggleShowPlanes: () => set((s) => ({ showPlanes: !s.showPlanes })),
    toggleShowGrid: () => set((s) => ({ showGrid: !s.showGrid })),
    toggleShowConstraints: () => set((s) => ({ showConstraints: !s.showConstraints })),
    dismissToast: () => set({ toast: null }),

    startSketch: async (plane, offset) => {
      const r = await runDispatch("sketch.create", offset ? { plane, offset } : { plane });
      if (r.ok) set({ mode: "sketch", activeSketchId: r.createdIds[0], tool: "line", selection: [], lastMessage: `Sketching on ${plane}${offset ? ` +${offset}` : ""}.` });
    },
    startSketchOnFace: async (hit, normal) => {
      // Stable sketch origin: foot of the perpendicular from world (0,0,0) to the face plane.
      const d = hit.x * normal.x + hit.y * normal.y + hit.z * normal.z;
      const origin = { x: normal.x * d, y: normal.y * d, z: normal.z * d };
      const r = await runDispatch("sketch.create", { planeDef: { origin, normal } });
      if (r.ok) set({ mode: "sketch", activeSketchId: r.createdIds[0], tool: "line", selection: [], lastMessage: "Sketching on face." });
    },
    finishSketch: () => set({ mode: "model", activeSketchId: null, tool: "select", selection: [], hover: null, transient: null, dragging: null, inlineEdit: null, contextMenu: null }),
    editSketch: (id) => set({ mode: "sketch", activeSketchId: id, tool: "select", selection: [] }),

    placePoint: (x, y) => runDispatch("sketch.addPoint", { sketch: activeId(), x, y }),
    placeLine: (start, end) => runDispatch("sketch.addLine", { sketch: activeId(), start, end, construction: get().constructionMode }),
    placeRectangle: (corner, opposite) => runDispatch("sketch.addRectangle", { sketch: activeId(), corner, opposite, construction: get().constructionMode }),
    placeCircle: (center, radius) => runDispatch("sketch.addCircle", { sketch: activeId(), center, radius, construction: get().constructionMode }),
    placeArc: (center, start, end, ccw) => runDispatch("sketch.addArc", { sketch: activeId(), center, start, end, ccw, construction: get().constructionMode }),
    placePolygon: (center, vertex, sides = 6) => runDispatch("sketch.addPolygon", { sketch: activeId(), center, vertex, sides, construction: get().constructionMode }),
    placeRectangle3: (p1, p2, p3) => runDispatch("sketch.addRectangle3", { sketch: activeId(), p1, p2, p3, construction: get().constructionMode }),
    placeSlot: (p1, p2, width) => runDispatch("sketch.addSlot", { sketch: activeId(), p1, p2, width, construction: get().constructionMode }),
    placeEllipse: (center, rx, ry, rotation) => runDispatch("sketch.addEllipse", { sketch: activeId(), center, rx, ry, rotation, construction: get().constructionMode }),
    projectBodies: async (construction = false) => {
      const sid = activeId();
      if (!sid) return;
      await get().ensureKernel();
      if (!get().kernelReady) return;
      const doc = get().session.doc;
      const sk = doc.sketches[sid];
      if (!sk) return;
      const sc = scope();
      const edges = Object.keys(doc.features).flatMap((fid) => featureEdges(doc, sc, fid));
      if (!edges.length) { bump({ toast: { kind: "info", text: "No body to project — extrude a sketch first." } }); return; }
      const curves = projectEdges(edges, resolveSketchPlane(sk));
      if (!curves.length) { bump({ toast: { kind: "info", text: "Nothing projects onto this plane." } }); return; }
      await runDispatch("sketch.projectCurves", { sketch: sid, curves, construction });
    },
    deleteSelected: async () => {
      const s = get();
      if (!s.activeSketchId || s.selection.length === 0) return;
      await runDispatch("sketch.deleteEntities", { sketch: s.activeSketchId, ids: s.selection });
      set({ selection: [] });
    },

    beginDrag: (pointId) => set({ dragging: { pointId } }),
    dragTo: async (x, y) => {
      const s = get();
      if (!s.dragging || !s.activeSketchId) return;
      const sk = s.session.doc.sketches[s.activeSketchId];
      if (!sk) return;
      // Seed from the previous frame's solve so under-constrained geometry
      // slides smoothly instead of popping between solution branches.
      const res = await solveDrag(sk, scope(), solver, s.dragging.pointId, x, y, s.transient ?? undefined);
      bump({ transient: res.points });
    },
    endDrag: async () => {
      const s = get();
      const trans = s.transient;
      const sid = s.activeSketchId;
      set({ dragging: null, transient: null });
      if (!trans || !sid) return;
      const sk = s.session.doc.sketches[sid];
      const seeds: Record<string, { x: number; y: number }> = {};
      for (const [id, pos] of Object.entries(trans)) {
        const e = sk.entities[id];
        if (e && e.kind === "point" && !e.fixed && Math.hypot(pos.x - e.x, pos.y - e.y) > 1e-6) {
          seeds[id] = { x: pos.x, y: pos.y };
        }
      }
      if (Object.keys(seeds).length > 0) await runDispatch("sketch.moveGeometry", { sketch: sid, seeds });
    },

    beginDimDrag: (cid) => set({ draggingDim: { cid } }),
    dimDragTo: (x, y) => { const d = get().draggingDim; if (d) bump({ transientDimLabel: { cid: d.cid, x, y } }); },
    endDimDrag: async () => {
      const t = get().transientDimLabel;
      set({ draggingDim: null, transientDimLabel: null });
      if (!t) return;
      const op = get().session.timeline.find((o) => o.type === "sketch.addDimension" && o.createdIds.includes(t.cid));
      if (op) await get().editOperation(op.opId, { ...op.params, label: { x: t.x, y: t.y } });
    },

    renderSketch: () => {
      const s = get();
      if (!s.activeSketchId) return null;
      const sk = s.session.doc.sketches[s.activeSketchId];
      if (!sk) return null;
      if (!s.transient && !s.transientDimLabel) return sk;
      const entities = { ...sk.entities };
      for (const [id, pos] of Object.entries(s.transient ?? {})) {
        const e = entities[id];
        if (e && e.kind === "point") entities[id] = { ...e, x: pos.x, y: pos.y };
      }
      let constraints = sk.constraints;
      if (s.transientDimLabel) {
        const t = s.transientDimLabel;
        const c = constraints[t.cid];
        if (c && "expr" in c) constraints = { ...constraints, [t.cid]: { ...(c as import("../sketch/types").DimensionConstraint), label: { x: t.x, y: t.y } } };
      }
      return { ...sk, entities, constraints };
    },

    addParameter: async (name, expr) => {
      // choose a unique default name
      let base = name || "d";
      const names = new Set(get().session.doc.parameters.map((p) => p.name));
      let n = base, i = 1;
      while (names.has(n)) n = `${base}${i++}`;
      await runDispatch("parameter.add", { name: n, expression: expr ?? "10" });
    },
    setParameterExpr: async (name, expr) => {
      const op = get().session.timeline.find((o) => o.type === "parameter.add" && o.params.name === name);
      if (op) await get().editOperation(op.opId, { name, expression: expr });
      else await runDispatch("parameter.set", { name, expression: expr });
    },
    renameParameter: async (name, newName) => {
      const op = get().session.timeline.find((o) => o.type === "parameter.add" && o.params.name === name);
      if (op) await get().editOperation(op.opId, { name: newName, expression: String(op.params.expression) });
    },
    deleteParameter: async (name) => {
      const op = get().session.timeline.find((o) => o.type === "parameter.add" && o.params.name === name);
      if (op) await get().deleteOperation(op.opId);
      else await runDispatch("parameter.delete", { name });
    },

    editDimension: async (cid, expr) => {
      const op = get().session.timeline.find((o) => o.type === "sketch.addDimension" && o.createdIds.includes(cid));
      if (op) await get().editOperation(op.opId, { ...op.params, expression: expr });
    },
    toggleDrivenDimension: async (cid) => {
      const op = get().session.timeline.find((o) => o.type === "sketch.addDimension" && o.createdIds.includes(cid));
      if (op) await get().editOperation(op.opId, { ...op.params, driven: !op.params.driven });
    },
    deleteConstraintById: async (cid) => {
      // If the constraint has its own dedicated operation, remove that op (clean).
      const dedicated = get().session.timeline.find(
        (o) =>
          (o.type === "sketch.addDimension" || o.type === "sketch.addConstraint") &&
          o.createdIds.length === 1 &&
          o.createdIds[0] === cid
      );
      if (dedicated) {
        await get().deleteOperation(dedicated.opId);
        return;
      }
      // Otherwise it was created inside a composite op (rectangle, mirror, …);
      // tombstone it with a deleteConstraints op so it's still removable.
      const sid = get().activeSketchId;
      if (sid) await runDispatch("sketch.deleteConstraints", { sketch: sid, ids: [cid] });
    },

    beginInlineEdit: (edit) => set({ inlineEdit: edit }),
    commitInlineEdit: async (expr) => {
      const edit = get().inlineEdit;
      set({ inlineEdit: null });
      if (!edit || !expr.trim()) return;
      if (edit.mode === "new") await runDispatch("sketch.addDimension", { ...edit.params, expression: expr });
      else await get().editDimension(edit.cid, expr);
    },
    cancelInlineEdit: () => set({ inlineEdit: null }),

    openContextMenu: (x, y) => set({ contextMenu: { x, y } }),
    closeContextMenu: () => set({ contextMenu: null }),

    setSettingsOpen: (open) => set({ settingsOpen: open }),
    setHotkeysOpen: (open) => set({ hotkeysOpen: open }),
    toggleAgent: () => set((s) => ({ agentOpen: !s.agentOpen })),
    setApiKey: (key) => { try { localStorage.setItem(AGENT_KEY_LS, key); } catch { /* ignore */ } set({ apiKey: key }); },
    setAgentModel: (model) => { try { localStorage.setItem(AGENT_MODEL_LS, model); } catch { /* ignore */ } set({ agentModel: model }); },
    stopAgent: () => { agentAbort?.abort(); },
    clearAgentChat: () => { agentHistory = []; set({ agentChat: [] }); },
    setWebMcpEnabled: (on) => {
      try { localStorage.setItem(WEBMCP_LS, on ? "1" : "0"); } catch { /* ignore */ }
      if (on) enableWebMcp({ registry, ...commandHost() });
      else disableWebMcp();
      set({ webMcpEnabled: on });
    },
    sendAgentMessage: async (text) => {
      const s = get();
      if (!s.apiKey) { set({ settingsOpen: true }); return; }
      if (s.agentRunning || !text.trim()) return;
      const push = (e: ChatEntry) => set((st) => ({ agentChat: [...st.agentChat, e] }));
      push({ role: "user", text });
      agentHistory.push({ role: "user", content: text });
      agentAbort = new AbortController();
      set({ agentRunning: true, agentOpen: true });
      try {
        agentHistory = await runAgent({
          apiKey: s.apiKey,
          model: s.agentModel,
          history: agentHistory,
          registry,
          signal: agentAbort.signal,
          ctx: commandHost(),
          onText: (t) => push({ role: "assistant", text: t }),
          onTool: (name, ok, detail) => push({ role: "tool", name: name.replace(/__/g, "."), ok, detail }),
        });
      } catch (e) {
        if (!agentAbort.signal.aborted) push({ role: "error", text: (e as Error).message || String(e) });
      } finally {
        set({ agentRunning: false });
        agentAbort = null;
      }
    },

    createTimelineGroup: (opIds, name) => {
      const doc = get().session.doc;
      const ids = opIds.filter((id) => doc.operations.some((o) => o.opId === id));
      if (!ids.length) return;
      // an op belongs to at most one group
      for (const g of doc.timelineGroups) g.opIds = g.opIds.filter((id) => !ids.includes(id));
      doc.timelineGroups = doc.timelineGroups.filter((g) => g.opIds.length > 0);
      const gid = `grp${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
      doc.timelineGroups.push({ id: gid, name: name || `Group ${doc.timelineGroups.length + 1}`, opIds: ids, collapsed: false });
      bump(); scheduleAutosave();
    },
    renameTimelineGroup: (id, name) => {
      const g = get().session.doc.timelineGroups.find((x) => x.id === id);
      if (g) { g.name = name; bump(); scheduleAutosave(); }
    },
    toggleTimelineGroup: (id) => {
      const g = get().session.doc.timelineGroups.find((x) => x.id === id);
      if (g) { g.collapsed = !g.collapsed; bump(); scheduleAutosave(); }
    },
    ungroupTimeline: (id) => {
      const doc = get().session.doc;
      doc.timelineGroups = doc.timelineGroups.filter((g) => g.id !== id);
      bump(); scheduleAutosave();
    },

    undo: () => { get().session.undo(); bump(); afterMutate(); },
    redo: () => { get().session.redo(); bump(); afterMutate(); },
    editOperation: async (opId, params) => {
      const r = await get().session.editOperation(opId, params);
      bump({ toast: toastFor(r), lastMessage: r.ok ? r.message ?? "" : r.error ?? "" });
      afterMutate();
    },
    suppressOperation: async (opId, suppressed) => { await get().session.setSuppressed(opId, suppressed); bump(); afterMutate(); },
    deleteOperation: async (opId) => { await get().session.deleteOperation(opId); bump(); afterMutate(); },
    moveRollback: async (index) => { await get().session.moveRollback(index); bump(); afterMutate(); },

    ensureKernel: async () => {
      if (get().kernelReady) return;
      set({ kernelLoading: true });
      try {
        await initKernel({ wasmUrl: occWasmUrl }); // idempotent
        set({ kernelReady: true, kernelLoading: false });
      } catch (e) {
        set({ kernelLoading: false, toast: { kind: "error", text: `3D kernel failed to load: ${(e as Error).message}` } });
      }
    },
    rebuildSolids: async () => {
      await get().ensureKernel();
      if (!get().kernelReady) return;
      const solids = evaluateFeatures(get().session.doc, scope());
      bump({ solids });
    },
    extrudeSketch: async (sketchId, distanceExpr, opts) => {
      await get().ensureKernel();
      await runDispatch("feature.extrude", {
        sketch: sketchId,
        distance: distanceExpr ?? "10",
        ...(opts?.operation ? { operation: opts.operation } : {}),
        ...(opts?.symmetric ? { symmetric: true } : {}),
        ...(opts?.region ? { region: opts.region } : {}),
      });
    },
    openExtrude: (sketchId) => {
      const s = get();
      // target: explicit, else the active/last sketch in the document
      const sketches = Object.values(s.session.doc.sketches);
      const target = sketchId ?? s.activeSketchId ?? (sketches.length ? sketches[sketches.length - 1].id : null);
      if (!target) { set({ toast: { kind: "info", text: "Draw a sketch first, then extrude." } }); return; }
      set({ extrudeTarget: target, mode: "model", activeSketchId: null });
    },
    closeExtrude: () => set({ extrudeTarget: null }),
    editFeatureDistance: async (featureId, expr) => {
      const op = get().session.timeline.find((o) => o.type === "feature.extrude" && o.createdIds.includes(featureId));
      if (op) await get().editOperation(op.opId, { ...op.params, distance: expr });
    },
    deleteFeature: async (featureId) => {
      const op = get().session.timeline.find((o) => o.type === "feature.extrude" && o.createdIds.includes(featureId));
      if (op) await get().deleteOperation(op.opId);
    },
    exportSolid: async (format) => {
      await get().ensureKernel();
      const doc = get().session.doc;
      const sc = scope();
      const fid = Object.keys(doc.features)[0];
      if (!fid) { set({ toast: { kind: "error", text: "Nothing to export — extrude a sketch first." } }); return; }
      const blob = exportFeatureBlob(doc, sc, fid, format);
      if (!blob) { set({ toast: { kind: "error", text: "Export failed (no closed profile?)." } }); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `model.${format === "step" ? "step" : "stl"}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },

    initApp: async () => {
      if (get().webMcpEnabled) enableWebMcp({ registry, ...commandHost() });
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(AUTOSAVE_KEY);
      } catch {
        /* ignore */
      }
      if (saved) {
        try {
          await get().loadDocument(deserializeDocument(saved));
        } catch {
          /* corrupt autosave — start fresh */
        }
      }
    },
    loadDocument: async (doc) => {
      const s = new CadSession(doc, registry, solver);
      set({
        session: s,
        mode: "model",
        activeSketchId: null,
        tool: "select",
        selection: [],
        hover: null,
        transient: null,
        dragging: null,
        inlineEdit: null,
        solids: {},
        toast: null,
      });
      await s.recompute();
      bump();
      if (Object.keys(s.doc.features).length) await get().rebuildSolids();
    },
    newDocument: async () => {
      await get().loadDocument(createDocument());
      try {
        localStorage.removeItem(AUTOSAVE_KEY);
      } catch {
        /* ignore */
      }
    },
    saveToFile: () => {
      const blob = new Blob([serializeDocument(get().session.doc)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "model.chisel.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },
    openFile: async (file) => {
      try {
        const text = await file.text();
        await get().loadDocument(deserializeDocument(text));
        bump({ toast: { kind: "info", text: `Opened ${file.name}` } });
      } catch (e) {
        bump({ toast: { kind: "error", text: `Open failed: ${(e as Error).message}` } });
      }
    },
  };
});

// Selectors
export const activeSketch = (s: AppState): Sketch | null =>
  s.activeSketchId ? s.session.doc.sketches[s.activeSketchId] ?? null : null;
export const activeEvaluations = (s: AppState): Evaluations => s.session.evaluations;

// dev handle
if (typeof window !== "undefined" && import.meta.env?.DEV) {
  (window as any).__chisel = useStore;
}
