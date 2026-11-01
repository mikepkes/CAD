import { create } from "zustand";
import planegcsWasmUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import occWasmUrl from "replicad-opencascadejs/wasm?url";
import rhino3dmWasmUrl from "rhino3dm/rhino3dm.wasm?url";

import { CadSession, DispatchResult, SessionCheckpoint } from "../core/command/session";
import { createDefaultRegistry } from "../core/command/builtins";
import { createDocument, materialForComponent } from "../core/document";
import { PlaneGCSSolver } from "../core/solver/planegcs";
import { Evaluations } from "../core/recompute";
import { resolveParameters } from "../core/parameters";
import { availableOps } from "./selectionOps";
import { ChatEntry, describeDocument } from "./agent";
import { createAgentController, AGENT_KEY_LS, AGENT_MODEL_LS } from "./agentController";
import { DEFAULT_DESKTOP_MCP_PORT, DesktopMcpStatus } from "./desktopMcp";
import { createMcpController, WEBMCP_LS, DESKTOP_MCP_LS, DESKTOP_MCP_PORT_LS } from "./mcpController";
import { getActiveScene } from "../viewport/sceneRef";
import type { RenderViewOpts } from "../viewport/SceneManager";
import type { TurntableOpts } from "../viewport/turntableRecorder";
import { saveOutput } from "./saveOutput";
import { pickFace } from "../core/geometry/pick";
import type { Vec3 } from "../math/vec";
import type { AnalysisView } from "../viewport/SceneManager";
import { isolationList } from "../core/visibility";
import { importRequests, ImportRequest } from "../core/importers";

const readLS = (k: string, d = "") => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
import { solveDrag } from "../core/drag";
import { Sketch, isDimension, DimensionConstraint } from "../sketch/types";
import type { SolidEval } from "../core/features";
import { GeometryBackend, InlineGeometryBackend, TopologyOpts, ExportFormat, EvaluateResult } from "../core/geometry/backend";
import { hasFlexures } from "../sim/flexure";
import { WorkerGeometryBackend } from "./worker-backend";
import { runMotionStudy, driveParams, MotionStatus, MotionResult } from "./motionStudy";
import { meshesToStlBinary } from "../core/export/stl";
import { projectEdges } from "../core/geometry/project";
import { resolveSketchPlane, makePlaneFromNormal, to2d } from "../geometry/plane";
import { CadDocument } from "../core/document";
import { serializeDocument, deserializeDocument } from "../core/persistence";
import type { CutPart } from "../core/drawings";
import { pickItems, sketchPickItems, type PickItem } from "./pickMenu";
import { expressionProblem, parameterAssignment } from "../core/expressionCheck";
import { NOT_EXPRESSIONS as PROSE_KEYS } from "../core/parameterRename";
import { renameViaEdit } from "./assist";
import { sketchIsEmpty } from "../ui/sketchStatus";
import { FeatureTool, FeatureToolKind, defaultRevolveAxis, hasClosedRegion, profileChoices, toggled, toolCommand, toolExpressions } from "./featureTools";

/** The geometry backend: a Web Worker when available (keeps the OCC kernel off
 *  the main thread), else inline on this thread. */
function createGeometryBackend(): GeometryBackend {
  try {
    if (typeof Worker !== "undefined") return new WorkerGeometryBackend();
  } catch { /* fall through to inline */ }
  return new InlineGeometryBackend();
}
const geometry = createGeometryBackend();
// A second backend dedicated to the motion study, so its 360° sweep runs in
// parallel with (and never blocks) the live preview on the main backend.
const studyGeometry = createGeometryBackend();
let studyReady = false;
let motionToken = 0; // bumped to cancel/supersede an in-flight study
let rebuildInFlight: Promise<void> | null = null; // the running preview evaluate (its whole coalesced loop)
let rebuildDirty = false;    // a newer rebuild was requested while one ran
let buildToken = 0;          // the latest build started: measurements of an older one are stale
/** Resolves once no solid rebuild is running (the video director's "the model is done" signal). */
export const whenRebuilt = (): Promise<void> => rebuildInFlight ?? Promise.resolve();

const AUTOSAVE_KEY = "vibecad.autosave.v1";
/** Whether the autosaved document has changes not yet saved to a file ("1"), kept beside it. */
const AUTOSAVE_DIRTY_KEY = "vibecad.autosave.dirty";

/** The file name Save uses for a document: its name made file-safe, else "model". */
export function documentFileName(name: string | undefined): string {
  const base = (name ?? "").normalize("NFKD").replace(/[^\w\s.-]+/g, "").trim().replace(/\s+/g, "-").replace(/^[-.]+|[-.]+$/g, "").toLowerCase();
  return `${base || "model"}.vibecad.json`;
}
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;


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

export interface FaceSelection {
  /** Body (feature id) the face belongs to; "" when the mesh carried no id. */
  bodyId: string;
  /** Topological face name (e.g. "extrude3:end"), when the mesh carries names. */
  faceName?: string;
  point: Vec3;
  normal: Vec3;
  /** Client coordinates of the click, where face verbs anchor. */
  screen: { x: number; y: number };
}

export interface Toast {
  kind: "error" | "info";
  text: string;
  /** A way forward the toast offers (a button): "Make it a reference dimension". */
  action?: { label: string; run: () => void };
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
  /** The body face picked by a click in model mode (the "verbs on a face" anchor). */
  faceSelection: FaceSelection | null;
  showPlanes: boolean;
  showGrid: boolean;
  /** Draw hidden bodies as faint, unpickable ghosts. */
  showHiddenGhosts: boolean;
  /** Surface-quality display: zebra / draft / curvature map, and curvature combs. */
  analysis: AnalysisView;
  /** Another display (the lens) needs curvature data while the analysis mode itself is off. */
  curvatureRequested: boolean;
  /** Per-body curvature and comb data for the current solids (when the display needs it). */
  analysisData: Record<string, { curvature: Float32Array; combs: Float32Array; vertices: number }>;
  showConstraints: boolean;
  /** Cross-section view: clip the solids on a base plane at an offset (null = off). */
  section: { plane: "XY" | "XZ" | "YZ"; offset: number; flip: boolean } | null;
  /** Grid cell size (mm) and whether drawing snaps to grid intersections. */
  gridSize: number;
  gridSnap: boolean;

  dragging: { pointId: string } | null;
  transient: Record<string, { x: number; y: number }> | null;
  draggingDim: { cid: string } | null;
  transientDimLabel: { cid: string; x: number; y: number } | null;
  inlineEdit: InlineEdit | null;
  contextMenu: { x: number; y: number } | null;

  // 3D solids (derived from features via the OCC kernel)
  solids: Record<string, SolidEval>;
  kernelReady: boolean;
  /** The model rebuilding now: when it started (performance.now) and how far it has got (0…1); null when idle. */
  build: { started: number; fraction: number } | null;
  kernelLoading: boolean;

  // Motion study (customize mode): sweep the driven joints and pass/fail the
  // current configuration on collision.
  motionStatus: MotionStatus;
  motionProgress: number; // 0..1 while running
  motionResult: MotionResult | null;
  hasMotionStudy: boolean; // the model has driven joints to sweep
  runMotionStudy: () => Promise<void>;
  cancelMotionStudy: () => void;

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
  /** Desktop app only: serve the same tools to external MCP clients over local HTTP. */
  desktopMcpEnabled: boolean;
  desktopMcpPort: number;
  desktopMcp: DesktopMcpStatus & { error?: string };

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
  /** Select the body face under a world point (null clears); `screen` is where it was clicked. */
  selectFace: (point: Vec3 | null, normal?: Vec3, screen?: { x: number; y: number }, bodyId?: string) => void;
  setHover: (id: string | null) => void;
  toggleShowPlanes: () => void;
  toggleShowGrid: () => void;
  toggleShowHiddenGhosts: () => void;
  /** Change the surface-quality display; curvature/combs are computed in the geometry backend. */
  setAnalysis: (patch: Partial<AnalysisView>) => Promise<void>;
  /** Ask for curvature data regardless of the analysis mode (the lens's curvature view); off releases it. */
  requestCurvature: (on: boolean) => Promise<void>;
  /** Show or hide bodies (feature ids) / sketches / components / datum planes. Undoable. */
  setVisibility: (ids: string[], visible: boolean) => Promise<void>;
  /** Show only these (hide every other body and sketch); null shows everything. */
  isolate: (ids: string[] | null) => Promise<void>;
  /** Turn the section view on/off, or update its plane/offset/flip. */
  setSection: (section: { plane: "XY" | "XZ" | "YZ"; offset: number; flip: boolean } | null) => void;
  setGridSize: (n: number) => void;
  setGridSnap: (on: boolean) => void;
  toggleShowConstraints: () => void;
  dismissToast: () => void;
  /** Write the status-bar line (the intent line reports what it ran). */
  setMessage: (text: string) => void;

  // sketch lifecycle
  /** "Create Sketch" tool armed: a viewport click on a plane/face starts a sketch. */
  sketchPlacing: boolean;
  setSketchPlacing: (on: boolean) => void;
  startSketch: (plane: string, offset?: number) => Promise<void>;
  createDatumPlane: (base: string, offset: string) => Promise<string | null>;
  activeComponentId: string;
  activateComponent: (id: string) => void;
  createComponent: (position?: { x: number; y: number; z: number }, name?: string) => Promise<string | null>;
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
  /** Add a parameter (a unique name from `name`); resolves to the name it got, null when it couldn't. */
  addParameter: (name?: string, expr?: string) => Promise<string | null>;
  /** A typed value checked against the parameters: the expression to store, or null (with a toast saying why).
   *  "name = expr" makes the parameter and gives its name. */
  resolveTyped: (expr: string) => Promise<string | null>;
  /** Create a parameter from a dimension's current value and point the dimension at it. */
  promoteDimension: (cid: string) => Promise<void>;
  setParameterExpr: (name: string, expr: string) => Promise<void>;
  /** Make a configuration active (id or name), or none. */
  setActiveConfiguration: (ref: string | null) => Promise<void>;
  /** Add a configuration row; with no `values`, it captures the current values of every parameter. */
  createConfiguration: (name: string, values?: Record<string, string>) => Promise<string | null>;
  updateConfiguration: (ref: string, change: { name?: string; values?: Record<string, string | null>; suppress?: string[]; hide?: string[] }) => Promise<void>;
  deleteConfiguration: (ref: string) => Promise<void>;
  renameParameter: (name: string, newName: string) => Promise<void>;
  /** Delete a parameter; with `inline`, everything that used it keeps its current value (one undo step). */
  deleteParameter: (name: string, opts?: { inline?: boolean }) => Promise<void>;
  /** Set or clear a parameter's extents (min/max) or acceptable values (enum). */
  setParameterBounds: (name: string, bounds: { min?: number; max?: number; values?: number[]; boolean?: boolean; options?: string[]; clear?: boolean }) => Promise<void>;

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
  extrudeSketch: (sketchId: string, distanceExpr?: string, opts?: { operation?: "new" | "join" | "cut" | "intersect"; symmetric?: boolean; region?: { x: number; y: number }; toFace?: { normal: Vec3; point: Vec3; name?: string }; reverse?: boolean; throughAll?: boolean }) => Promise<void>;
  /** Extrude session (model mode): active flag, target profile sketch, chosen region, live params. */
  extrudeActive: boolean;
  extrudeTarget: string | null;
  extrudeRegion: { x: number; y: number } | null;
  extrudeDistanceExpr: string;
  extrudeOperation: "new" | "join" | "cut" | "intersect";
  extrudeSymmetric: boolean;
  /** How far the extrude goes: a distance, through everything, or up to a face picked in the viewport. */
  extrudeExtent: "distance" | "toFace" | "throughAll";
  /** Extrude to the other side of the sketch. */
  extrudeReverse: boolean;
  /** The face a "to face" extrude stops at (picked while the session is open). */
  extrudeToFace: { normal: Vec3; point: Vec3; name?: string } | null;
  setExtrudeExtent: (e: "distance" | "toFace" | "throughAll") => void;
  /** Pick the face a "to face" extrude stops at; the distance field shows how far that is. */
  pickExtrudeToFace: (point: Vec3, normal: Vec3) => void;
  openExtrude: (sketchId?: string) => void;
  /** A modelling panel's session (Revolve, Shell, Pattern, edge-pick Fillet/Chamfer): its choices so far; null when none is open. */
  featureTool: FeatureTool | null;
  openFeatureTool: (kind: FeatureToolKind, blend?: "fillet" | "chamfer") => void;
  patchFeatureTool: (patch: Record<string, unknown>) => void;
  closeFeatureTool: () => void;
  /** Run the open session's command; resolves to the new feature's id (null when it couldn't run). */
  commitFeatureTool: () => Promise<string | null>;
  /** A face clicked during a session: Shell opens or closes it; any session takes its body when it has none yet. */
  toolPickFace: (point: Vec3, normal: Vec3, bodyId: string, faceName?: string) => void;
  /** An edge clicked during an edge-pick Fillet/Chamfer session: picked, or dropped when it was. */
  toolPickEdge: (bodyId: string, name: string) => void;
  mirrorModel: (plane: string) => Promise<void>;
  closeExtrude: () => void;
  setExtrudeRegion: (p: { x: number; y: number } | null) => void;
  setExtrudeDistanceExpr: (expr: string) => void;
  setExtrudeOperation: (op: "new" | "join" | "cut" | "intersect") => void;
  setExtrudeSymmetric: (on: boolean) => void;
  commitExtrude: () => Promise<void>;
  /** Extrude a planar face directly: project its boundary into a new sketch and target it. */
  startFaceExtrude: (hit: { x: number; y: number; z: number }, normal: { x: number; y: number; z: number }) => Promise<void>;
  editFeatureDistance: (featureId: string, expr: string) => Promise<void>;
  editJointValue: (jointId: string, expr: string) => Promise<void>;
  deleteJoint: (jointId: string) => Promise<void>;
  // ---- parametric jointed assemblies ----
  addConnector: (componentId: string, name: string, origin: { x: number; y: number; z: number }) => Promise<void>;
  deleteConnector: (componentId: string, name: string) => Promise<void>;
  createComponentPattern: (source: string, count: string, name?: string) => Promise<string | null>;
  editPatternCount: (patternId: string, count: string) => Promise<void>;
  deletePattern: (patternId: string) => Promise<void>;
  createJointTemplate: (patternId: string, params: Record<string, unknown>) => Promise<void>;
  editJointTemplateValue: (templateId: string, expr: string) => Promise<void>;
  setJointTemplateAppliesTo: (templateId: string, appliesTo: "first" | "rest" | "all") => Promise<void>;
  deleteJointTemplate: (templateId: string) => Promise<void>;
  deleteFeature: (featureId: string) => Promise<void>;
  exportSolid: (format: "stl" | "step" | "3mf") => Promise<void>;
  /** The open shop drawing (third-angle sheet + cut list), null when closed; `loading` while it is made. */
  drawing: { svg: string; parts: CutPart[]; title: string } | { loading: true } | null;
  /** The long-press selection picker: everything under the cursor, nearest first; null when closed. */
  pickMenu: { screen: { x: number; y: number }; items: PickItem[] } | null;
  openPickMenu: (screen: { x: number; y: number }, hits: Parameters<typeof pickItems>[0]) => void;
  /** The picker for a long press in a sketch: the entities under the cursor (ids, points first). */
  openSketchPickMenu: (screen: { x: number; y: number }, hits: { id: string }[]) => void;
  closePickMenu: () => void;
  /** Act on a picker entry exactly as clicking that face (or plane) would, in whatever session is open. */
  choosePick: (item: PickItem) => void;
  openDrawing: () => Promise<void>;
  closeDrawing: () => void;
  /** The whole model as one print file, offered through the native share sheet
   *  on phones (Save to Files / AirDrop / another app) and downloaded elsewhere:
   *  an STL, or a 3MF with a part per material when it has more than one. */
  shareModel: (name?: string) => Promise<void>;

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
  setDesktopMcpEnabled: (on: boolean) => Promise<void>;
  setDesktopMcpPort: (port: number) => void;

  // persistence
  /** Changes since the document was last saved to (or opened from) a file. */
  dirty: boolean;
  /** Name the document (Save names its file after it). Undoable. */
  renameDocument: (name: string) => Promise<void>;
  /** Rename a sketch or feature (by id) where it shows: the browser, the strip, the card. Undoable. */
  renameEntity: (id: string, name: string) => Promise<void>;
  initApp: () => Promise<void>;
  newDocument: () => Promise<void>;
  loadDocument: (doc: CadDocument) => Promise<void>;
  saveToFile: () => void;
  openFile: (file: File) => Promise<void>;
  /** Import a STEP / BREP / STL / FreeCAD file as bodies (feature.import on the timeline). */
  importFile: (file: File) => Promise<void>;
}

// The error names the conflicting constraints in words (session.ts); their ids stay in r.conflicting for agents.
function toastFor(r: DispatchResult): Toast | null {
  if (r.ok) return null;
  return { kind: "error", text: r.error ?? "Rejected" };
}

export const useStore = create<AppState>((set, get) => {
  const bump = (extra: Partial<AppState> = {}) => set((s) => ({ rev: s.rev + 1, ...extra }));

  const scheduleAutosave = () => {
    if (!get().dirty) set({ dirty: true });
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, serializeDocument(get().session.doc));
        localStorage.setItem(AUTOSAVE_DIRTY_KEY, get().dirty ? "1" : "0");
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

  // ---- typed values: refuse what doesn't read or names no parameter; "name = expr" makes the parameter ----
  const paramNames = () => get().session.doc.parameters.map((p) => p.name);
  const typedProblem = (expr: string): string | null => {
    const a = parameterAssignment(expr);
    if (!a) return expressionProblem(expr, paramNames());
    if (paramNames().includes(a.name)) return `There's already a parameter called ${a.name}: type ${a.name} on its own, or change it in Parameters`;
    return expressionProblem(a.expression, paramNames());
  };
  /** The expression to store for a typed value (null, with a toast, when it can't be used). */
  const typedExpression = async (expr: string): Promise<string | null> => {
    const problem = typedProblem(expr);
    if (problem) { set({ toast: { kind: "error", text: problem } }); return null; }
    const a = parameterAssignment(expr);
    if (!a) return expr.trim();
    const r = await runDispatch("parameter.add", { name: a.name, expression: a.expression });
    return r.ok ? a.name : null;
  };

  // Curvature and combs come from the B-rep, so they're computed in the
  // geometry backend — only while a display that shows them is on.
  const refreshAnalysis = async () => {
    const a = get().analysis;
    if (a.mode !== "curvature" && !a.combs && !get().curvatureRequested) { if (Object.keys(get().analysisData).length) bump({ analysisData: {} }); return; }
    if (!get().kernelReady || !Object.keys(get().session.doc.features).length) return;
    try {
      const res = await geometry.analyze(get().session.doc, { combs: a.combs });
      bump({ analysisData: Object.fromEntries(res.map((r) => [r.featureId, { curvature: r.curvature, combs: r.combs, vertices: r.vertices }])) });
    } catch (e) {
      bump({ toast: { kind: "error", text: `Analysis failed: ${(e as Error).message}` } });
    }
  };

  // Import several bodies as one undoable unit: all of them, or (on a failure) none.
  const importAll = async (reqs: ImportRequest[]): Promise<string[]> => {
    const session = get().session;
    const start = session.checkpoint();
    const ids: string[] = [];
    for (const r of reqs) {
      const res = await session.dispatch("feature.import", { data: r.data, format: r.format, name: r.name });
      if (!res.ok) { session.rollback(start); bump(); throw new Error(`${r.name}: ${res.error}`); }
      ids.push(res.createdIds[0]);
    }
    bump(); afterMutate();
    return ids;
  };

  const activeId = () => get().activeSketchId;
  const scope = () => resolveParameters(get().session.doc.parameters).scope;
  // Scope a new sketch to the active component (omit when it's root — root is the default).
  const scopeComponent = (): { component?: string } => {
    const c = get().activeComponentId;
    return c && c !== get().session.doc.rootComponentId ? { component: c } : {};
  };
  // A face reference for a sketch on the body face at `point`, with the face's
  // topological name pinned (read off the display meshes) so the sketch follows
  // that face through upstream edits rather than the nearest look-alike.
  const faceRefOf = (normal: Vec3, point: Vec3): { normal: Vec3; point: Vec3; name?: string } => {
    const meshes = Object.values(get().solids).filter((s) => s.mesh).map((s) => ({ featureId: s.featureId, mesh: s.mesh! }));
    const name = pickFace(meshes, point)?.faceName;
    return { normal, point, ...(name ? { name } : {}) };
  };

  // Shared command host for both the in-app agent and WebMCP: dispatch a command
  // and keep the viewport in sync (activate a new sketch, switch to model on extrude).
  const commandHost = () => ({
    describe: () => describeDocument(get().session.doc, get().mode, get().activeSketchId, get().solids),
    runCommand: async (type: string, params: Record<string, unknown>) => {
      const r = await runDispatch(type, params);
      if (r.ok && type === "sketch.create") set({ mode: "sketch", activeSketchId: r.createdIds[0], tool: "select" });
      // a new solid (members, primitives, imports…) is seen in model mode, with no sketch left open (as finishing one does)
      if (r.ok && type.startsWith("feature.")) set({ mode: "model", activeSketchId: null, tool: "select", selection: [] });
      const out: { ok: boolean; createdIds?: string[]; message?: string; error?: string; frame?: unknown; warning?: string } =
        { ok: r.ok, createdIds: r.createdIds, message: r.message, error: r.error };
      // A new sketch reports its world frame so callers know which way u/v/normal point.
      if (r.ok && type === "sketch.create") {
        const wp = resolveSketchPlane(get().session.doc.sketches[r.createdIds[0]]);
        out.frame = { origin: wp.origin, u: wp.u, v: wp.v, normal: wp.normal };
      }
      // Feature commands: wait for the kernel so the caller sees failures/warnings in the same call.
      if (r.ok && type.startsWith("feature.")) {
        await get().rebuildSolids();
        const sol = get().solids[r.createdIds[0]];
        if (sol?.error) out.error = sol.error;
        if (sol?.warning) out.warning = sol.warning;
      }
      return out;
    },
    sketchOnFace: async (point: { x: number; y: number; z: number } | undefined, name?: string, face?: string) => {
      if (Object.keys(get().session.doc.features).length) await get().rebuildSolids();
      let at: { origin: Vec3; normal: Vec3; point: Vec3; featureId: string; distance: number; faceRef: { normal: Vec3; point: Vec3; name?: string } };
      if (face) {
        // By topological name: the planar face carrying it (the piece nearest `point` if it was split).
        const bodies = await geometry.topology(get().session.doc, { edges: false });
        const hits = bodies.flatMap((b) => b.faces.filter((f) => f.name === face).map((f) => ({ b, f })));
        if (!hits.length) throw new Error(`no face named "${face}" — list names with body_topology`);
        const planar = hits.filter((h) => h.f.type === "PLANE");
        if (!planar.length) throw new Error(`face "${face}" is ${hits[0].f.type.toLowerCase()}, not planar — sketches need a planar face`);
        const d2 = (c: Vec3) => (point ? (c.x - point.x) ** 2 + (c.y - point.y) ** 2 + (c.z - point.z) ** 2 : 0);
        const { b, f } = planar.reduce((m, h) => (d2(h.f.center) < d2(m.f.center) ? h : m));
        const off = f.center.x * f.normal.x + f.center.y * f.normal.y + f.center.z * f.normal.z;
        at = { origin: { x: f.normal.x * off, y: f.normal.y * off, z: f.normal.z * off }, normal: f.normal, point: f.center, featureId: b.id, distance: 0, faceRef: { normal: f.normal, point: f.center, name: face } };
      } else {
        if (!point) throw new Error("give a world point on the face, or a face name");
        const meshes = Object.values(get().solids).filter((s) => s.mesh).map((s) => ({ featureId: s.featureId, mesh: s.mesh! }));
        const hit = pickFace(meshes, point);
        if (!hit) throw new Error("no body face found — build a solid first");
        at = { origin: hit.origin, normal: hit.normal, point: hit.point, featureId: hit.featureId, distance: hit.distance, faceRef: faceRefOf(hit.normal, hit.point) };
      }
      const r = await runDispatch("sketch.create", { planeDef: { origin: at.origin, normal: at.normal }, faceRef: at.faceRef, ...(name ? { name } : {}), ...scopeComponent() });
      if (!r.ok) throw new Error(r.error ?? "sketch.create failed");
      set({ mode: "sketch", activeSketchId: r.createdIds[0], tool: "select" });
      const wp = resolveSketchPlane(get().session.doc.sketches[r.createdIds[0]]);
      return { sketchId: r.createdIds[0], originId: r.createdIds[1], featureId: at.featureId, face: at.faceRef.name, distanceToFace: at.distance, frame: { origin: wp.origin, u: wp.u, v: wp.v, normal: wp.normal } };
    },
    topology: (opts: TopologyOpts) => geometry.topology(get().session.doc, opts),
    setConfiguration: async (ref: string | null) => {
      const r = await get().session.setActiveConfiguration(ref);
      if (!r.ok) throw new Error(r.error ?? "could not switch configuration");
      bump(); afterMutate();
      if (Object.keys(get().session.doc.features).length) await get().rebuildSolids();
      return { active: ref, parameters: get().session.doc.parameters.filter((p) => p.configuredBy).map((p) => ({ name: p.name, expr: p.expr, value: p.value })) };
    },
    configurations: () => get().session.doc.configurations.map((c) => ({ id: c.id, name: c.name })),
    members: async () => {
      if (Object.keys(get().session.doc.features).length) await get().rebuildSolids();
      return Object.values(get().solids).filter((b) => b.member).map((b) => ({ body: b.featureId, ...b.member! }));
    },
    sheets: async () => {
      if (Object.keys(get().session.doc.features).length) await get().rebuildSolids();
      return Object.values(get().solids).filter((b) => b.sheet).map((b) => ({ body: b.featureId, name: b.name, sheet: b.sheet! }));
    },
    analyze: async (opts: { bodyId?: string; combs?: boolean }) => {
      await get().ensureKernel();
      return geometry.analyze(get().session.doc, opts);
    },
    setAnalysis: async (patch: Record<string, unknown>) => {
      await get().setAnalysis(patch as Partial<AnalysisView>);
      return get().analysis;
    },
    importFile: async (fileName: string, bytes: Uint8Array) => {
      const reqs = await importRequests(fileName, bytes, { rhino3dmWasmUrl });
      const ids = await importAll(reqs);
      set({ mode: "model" });
      await get().rebuildSolids();
      return ids.map((id) => ({ id, name: get().session.doc.features[id]?.name, error: get().solids[id]?.error }));
    },
    setVisibility: async (ids: string[], visible: boolean) => {
      const r = await get().session.setVisibility(ids, visible);
      if (!r.ok) throw new Error(r.error ?? "could not change visibility");
      bump(); scheduleAutosave();
      return { hidden: get().session.doc.hidden ?? [] };
    },
    isolate: async (ids: string[] | null) => {
      if (ids && Object.keys(get().session.doc.features).length) await get().rebuildSolids();
      await get().isolate(ids);
      return { hidden: get().session.doc.hidden ?? [] };
    },
    // A variant is exported from a rebuilt copy, so the live model never switches.
    exportModel: async (format: ExportFormat, body: string | null, configuration?: string | null) => {
      await get().ensureKernel();
      const doc = configuration === undefined ? get().session.doc : await get().session.previewConfiguration(configuration);
      return geometry.exportBytes(doc, body, format);
    },
    distance: (a: string, b: string) => geometry.distance(get().session.doc, a, b),
    // An all-or-nothing batch: remember the session (new_document swaps it) and
    // its state, and put both back if a step fails.
    checkpoint: () => ({ session: get().session, state: get().session.checkpoint() }),
    rollback: async (token: unknown) => {
      const t = token as { session: CadSession; state: SessionCheckpoint };
      t.session.rollback(t.state);
      if (get().session !== t.session) set({ session: t.session, solids: {} });
      bump();
      afterMutate();
      if (Object.keys(t.session.doc.features).length) await get().rebuildSolids();
    },
    newDocument: () => get().newDocument(),
    undo: () => get().undo(),
    redo: () => get().redo(),
    deleteOperation: (opId: string) => get().deleteOperation(opId),
    render: async (opts: RenderViewOpts) => {
      // Make sure solids are current before capturing (agents call this right
      // after editing, and the worker-backed rebuild is asynchronous): always
      // evaluate the live doc, so the capture never shows a stale body.
      if (Object.keys(get().session.doc.features).length) await get().rebuildSolids();
      else if (Object.keys(get().solids).length) bump({ solids: {} });
      const scene = getActiveScene();
      if (!scene) throw new Error("viewport not ready");
      return scene.renderView(opts);
    },
    recordTurntable: async (opts: TurntableOpts) => {
      if (Object.keys(get().session.doc.features).length) await get().rebuildSolids();
      const scene = getActiveScene();
      if (!scene) throw new Error("viewport not ready");
      const { recordTurntable } = await import("../viewport/turntableRecorder");
      return recordTurntable(scene, get().session.doc, get().solids as never, opts);
    },
    saveOutput,
  });

  // The embedded agent's actions (history + aborter live inside the controller).
  const agentActions = createAgentController({
    getState: get,
    patch: set,
    appendChat: (e) => set((st) => ({ agentChat: [...st.agentChat, e] })),
    registry,
    commandHost,
  });

  // The MCP surface actions (WebMCP + desktop server).
  const mcpActions = createMcpController({
    getState: get,
    patch: set,
    makeHost: () => ({ registry, ...commandHost() }),
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
    sketchPlacing: false,
    selection: [],
    hover: null,
    showPlanes: true,
    showGrid: true,
    showHiddenGhosts: false,
    analysis: { mode: "none", stripes: 12, draftDeg: 1, pull: { x: 0, y: 0, z: 1 }, quantity: "mean", combs: false },
    curvatureRequested: false,
    analysisData: {},
    section: null,
    gridSize: 10,
    gridSnap: false,
    showConstraints: true,
    dragging: null,
    transient: null,
    draggingDim: null,
    transientDimLabel: null,
    inlineEdit: null,
    contextMenu: null,
    faceSelection: null,
    solids: {},
    kernelReady: false,
    build: null,
    motionStatus: "idle",
    motionProgress: 0,
    motionResult: null,
    hasMotionStudy: false,
    kernelLoading: false,
    toast: null,
    lastMessage: "Pick an origin plane to start a sketch.",
    activeComponentId: session.doc.rootComponentId,
    settingsOpen: false,
    hotkeysOpen: false,
    extrudeActive: false,
    extrudeTarget: null,
    extrudeRegion: null,
    extrudeDistanceExpr: "10",
    extrudeOperation: "new",
    extrudeSymmetric: false,
    extrudeExtent: "distance",
    extrudeReverse: false,
    extrudeToFace: null,
    agentOpen: false,
    apiKey: readLS(AGENT_KEY_LS),
    agentModel: readLS(AGENT_MODEL_LS, "claude-opus-5-5"),
    agentChat: [],
    agentRunning: false,
    webMcpEnabled: readLS(WEBMCP_LS) === "1",
    desktopMcpEnabled: readLS(DESKTOP_MCP_LS) === "1",
    desktopMcpPort: Number(readLS(DESKTOP_MCP_PORT_LS, String(DEFAULT_DESKTOP_MCP_PORT))) || DEFAULT_DESKTOP_MCP_PORT,
    desktopMcp: { running: false },

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
    selectFace: (point, normal, screen, bodyId) => {
      if (!point || !normal) { if (get().faceSelection) set({ faceSelection: null }); return; }
      const meshes = Object.values(get().solids).filter((s) => s.mesh).map((s) => ({ featureId: s.featureId, mesh: s.mesh! }));
      const hit = pickFace(meshes, point);
      set({ faceSelection: { bodyId: bodyId ?? hit?.featureId ?? "", faceName: hit?.faceName, point, normal, screen: screen ?? { x: 0, y: 0 } } });
    },
    setHover: (id) => set({ hover: id }),
    toggleShowPlanes: () => set((s) => ({ showPlanes: !s.showPlanes })),
    toggleShowGrid: () => set((s) => ({ showGrid: !s.showGrid })),
    toggleShowHiddenGhosts: () => set((s) => ({ showHiddenGhosts: !s.showHiddenGhosts })),
    setAnalysis: async (patch) => {
      set((s) => ({ analysis: { ...s.analysis, ...patch } }));
      await refreshAnalysis();
    },
    requestCurvature: async (on) => {
      if (get().curvatureRequested === on) return;
      set({ curvatureRequested: on });
      await refreshAnalysis();
    },
    setVisibility: async (ids, visible) => {
      const r = await get().session.setVisibility(ids, visible);
      bump(r.ok ? {} : { toast: toastFor(r) });
      scheduleAutosave();
    },
    isolate: async (ids) => {
      const bodies = Object.values(get().solids).filter((b) => b.mesh);
      const others = ids === null ? [] : isolationList(get().session.doc, bodies, ids);
      const r = await get().session.setHidden(others);
      bump(r.ok ? {} : { toast: toastFor(r) });
      scheduleAutosave();
    },
    setSection: (section) => set({ section }),
    setGridSize: (n) => set({ gridSize: Math.max(0.1, n) }),
    setGridSnap: (on) => set({ gridSnap: on }),
    toggleShowConstraints: () => set((s) => ({ showConstraints: !s.showConstraints })),
    dismissToast: () => set({ toast: null }),
    setMessage: (text) => set({ lastMessage: text }),

    setSketchPlacing: (on) => set({ sketchPlacing: on }),
    startSketch: async (plane, offset) => {
      // A datum plane id (from plane.create) routes to the {datum} param; an
      // origin plane id (XY/XZ/YZ) keeps the {plane[, offset]} form. New sketches
      // land in the active component.
      const isDatum = !!get().session.doc.planes[plane];
      const params = isDatum ? { datum: plane } : offset ? { plane, offset } : { plane };
      const r = await runDispatch("sketch.create", { ...params, ...scopeComponent() });
      if (r.ok) {
        const label = isDatum ? get().session.doc.planes[plane].name : `${plane}${offset ? ` +${offset}` : ""}`;
        set({ mode: "sketch", activeSketchId: r.createdIds[0], tool: "line", selection: [], sketchPlacing: false, lastMessage: `Sketching on ${label}.` });
      }
    },
    createDatumPlane: async (base, offset) => {
      const r = await runDispatch("plane.create", { base, offset });
      if (r.ok) { set({ lastMessage: `Created offset plane from ${base} by ${offset}.` }); return r.createdIds[0]; }
      return null;
    },
    activateComponent: (id) => {
      if (get().session.doc.components[id]) set({ activeComponentId: id, lastMessage: `Active: ${get().session.doc.components[id].name}` });
    },
    createComponent: async (position, name) => {
      const parent = get().activeComponentId;
      const r = await runDispatch("component.create", { parent, ...(position ? { position } : {}), ...(name ? { name } : {}) });
      if (r.ok) { set({ activeComponentId: r.createdIds[0], lastMessage: `Created ${get().session.doc.components[r.createdIds[0]].name}` }); return r.createdIds[0]; }
      return null;
    },
    startSketchOnFace: async (hit, normal) => {
      // Stable sketch origin: foot of the perpendicular from world (0,0,0) to the face plane.
      const d = hit.x * normal.x + hit.y * normal.y + hit.z * normal.z;
      const origin = { x: normal.x * d, y: normal.y * d, z: normal.z * d };
      const r = await runDispatch("sketch.create", { planeDef: { origin, normal }, faceRef: faceRefOf(normal, hit), ...scopeComponent() });
      if (r.ok) set({ mode: "sketch", activeSketchId: r.createdIds[0], tool: "line", selection: [], sketchPlacing: false, lastMessage: "Sketching on face." });
    },
    finishSketch: () => {
      const sk = activeSketch(get());
      set({ mode: "model", activeSketchId: null, tool: "select", selection: [], hover: null, transient: null, dragging: null, inlineEdit: null, contextMenu: null, constraintTool: null, lastMessage: sk ? `Finished ${sk.name}.` : "" });
      // a sketch finished with nothing in it isn't left behind (M18): its ops go, in one undo step
      if (sk && sketchIsEmpty(sk)) {
        const tl = get().session.timeline;
        const used = tl.some((o) => o.params.sketch === sk.id && o.type !== "sketch.create" && !o.type.startsWith("sketch."))
          || tl.some((o) => Array.isArray(o.params.sketches) && (o.params.sketches as unknown[]).includes(sk.id));
        const own = tl.filter((o) => (o.type === "sketch.create" && o.createdIds[0] === sk.id) || o.params.sketch === sk.id);
        if (!used && own.length) void (async () => {
          const s = get().session;
          const cp = s.checkpoint();
          for (const o of [...own].reverse()) await s.deleteOperation(o.opId);
          s.squash(cp, `Remove the empty ${sk.name}`);
          bump({ lastMessage: `Removed the empty ${sk.name}.` });
          scheduleAutosave();
        })();
      }
    },
    editSketch: (id) => set({ mode: "sketch", activeSketchId: id, tool: "select", selection: [], lastMessage: `Editing ${get().session.doc.sketches[id]?.name ?? "the sketch"}.` }),

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
      const edges = (await Promise.all(Object.keys(doc.features).map((fid) => geometry.edges(doc, fid)))).flat();
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
      const r = await runDispatch("parameter.add", { name: n, expression: expr ?? "10" });
      return r.ok ? n : null;
    },
    resolveTyped: (expr) => typedExpression(expr),
    promoteDimension: async (cid) => {
      const sk = activeSketch(get());
      if (!sk) return;
      const c = sk.constraints[cid];
      if (!c || !isDimension(c)) return;
      const dim = c as DimensionConstraint;
      // Parameter base name by dimension type; value = the dimension's current value.
      const base = dim.type === "radius" ? "r" : dim.type === "diameter" ? "dia" : dim.type === "angle" ? "ang" : "d";
      const names = new Set(get().session.doc.parameters.map((p) => p.name));
      let name = base, i = 1;
      while (names.has(name)) name = `${base}${i++}`;
      const v = dim.value;
      const valueStr = Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
      // the parameter and the dimension pointing at it are one undo step (M17)
      const cp = get().session.checkpoint();
      const r = await runDispatch("parameter.add", { name, expression: valueStr });
      if (!r.ok) return;
      // Point the dimension's expression at the new parameter.
      const op = get().session.timeline.find((o) => o.type === "sketch.addDimension" && o.createdIds.includes(cid));
      if (op) await get().editOperation(op.opId, { ...op.params, expression: name });
      get().session.squash(cp, `Name ${name}`);
      bump({ lastMessage: `Named the dimension ${name}.` });
    },
    setParameterExpr: async (name, expr) => {
      // While a configuration supplies this parameter, an edit changes its cell.
      const p = get().session.doc.parameters.find((x) => x.name === name);
      if (p?.configuredBy && get().session.doc.activeConfiguration) {
        await runDispatch("configuration.update", { configuration: get().session.doc.activeConfiguration, values: { [name]: expr } });
        return;
      }
      const op = get().session.timeline.find((o) => o.type === "parameter.add" && o.params.name === name);
      if (op) await get().editOperation(op.opId, { ...op.params, name, expression: expr });
      else await runDispatch("parameter.set", { name, expression: expr });
    },
    setActiveConfiguration: async (ref) => {
      const r = await get().session.setActiveConfiguration(ref);
      bump({ toast: r.ok ? undefined : toastFor(r), lastMessage: r.ok ? (ref ? `Configuration: ${ref}` : "Configuration: default") : r.error ?? "" });
      afterMutate();
    },
    createConfiguration: async (name, values) => {
      // Capture concrete values, so the row stays what it was when saved.
      const cells = values ?? Object.fromEntries(get().session.doc.parameters.map((p) => [p.name, Number.isInteger(p.value) ? String(p.value) : String(Math.round(p.value * 1e6) / 1e6)]));
      const r = await runDispatch("configuration.create", { name, values: cells });
      return r.ok ? r.createdIds[0] : null;
    },
    updateConfiguration: async (ref, change) => { await runDispatch("configuration.update", { configuration: ref, ...change }); },
    deleteConfiguration: async (ref) => { await runDispatch("configuration.delete", { configuration: ref }); },
    renameParameter: async (name, newName) => {
      // every expression that used it follows the new name (one undoable step)
      const r = await get().session.renameParameter(name, newName);
      if (!r.ok) { set({ toast: { kind: "error", text: r.error ?? "Rename failed" } }); return; }
      bump();
      set({ lastMessage: `Renamed ${name} to ${newName}, and everything that used it` });
      if (Object.keys(get().session.doc.features).length) await get().rebuildSolids();
    },
    setParameterBounds: async (name, bounds) => {
      const op = get().session.timeline.find((o) => o.type === "parameter.add" && o.params.name === name);
      // Rebuild the parameter.add params so the new extents replace the old ones.
      const extra = bounds.clear
        ? {}
        : bounds.boolean
          ? { boolean: true }
          : bounds.options
            ? { options: bounds.options }
          : bounds.values != null
            ? { values: bounds.values }
            : { ...(bounds.min != null ? { min: bounds.min } : {}), ...(bounds.max != null ? { max: bounds.max } : {}) };
      // a switch is 0 or 1: a value other than that snaps to 1 if non-zero, else 0
      // and a named choice is one of 0 … n−1: snap to the nearest
      const current = get().session.doc.parameters.find((p) => p.name === name)?.value ?? 0;
      const choice = bounds.options && Math.min(bounds.options.length - 1, Math.max(0, Math.round(Number.isFinite(current) ? current : 0)));
      const expression = bounds.boolean && current !== 0 && current !== 1 ? (current !== 0 ? "1" : "0")
        : choice != null && choice !== current ? String(choice) : op?.params.expression;
      if (op) await get().editOperation(op.opId, { name: op.params.name, expression, ...extra });
      else await runDispatch("parameter.setBounds", { name, ...(bounds.clear ? { clear: true } : extra) });
    },
    deleteParameter: async (name, opts) => {
      const r = await get().session.deleteParameter(name, opts ?? {});
      bump({ toast: toastFor(r), lastMessage: r.ok ? (opts?.inline ? `Deleted ${name}; what used it keeps its value` : `Deleted ${name}`) : r.error ?? "" });
      afterMutate();
    },

    editDimension: async (cid, expr) => {
      const op = get().session.timeline.find((o) => o.type === "sketch.addDimension" && o.createdIds.includes(cid));
      const value = op && (await typedExpression(expr));
      if (op && value) await get().editOperation(op.opId, { ...op.params, expression: value });
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
      if (!edit || !expr.trim()) { set({ inlineEdit: null }); return; }
      // a value that doesn't read, or names no parameter, keeps the editor open and says why
      const problem = typedProblem(expr);
      if (problem) { set({ toast: { kind: "error", text: problem } }); return; }
      set({ inlineEdit: null });
      const value = await typedExpression(expr);
      if (!value) return;
      if (edit.mode === "new") {
        const params = { ...edit.params, expression: value };
        const r = await runDispatch("sketch.addDimension", params);
        // Over-constrained: the way forward is a reference (driven) dimension that measures without constraining.
        if (!r.ok && r.conflicting?.length) {
          set({ toast: { kind: "error", text: r.error ?? "That would over-constrain the sketch", action: { label: "Make it a reference dimension", run: () => { set({ toast: null }); void runDispatch("sketch.addDimension", { ...params, driven: true }); } } } });
        }
      }
      else await get().editDimension(edit.cid, value);
    },
    cancelInlineEdit: () => set({ inlineEdit: null }),

    openContextMenu: (x, y) => set({ contextMenu: { x, y } }),
    closeContextMenu: () => set({ contextMenu: null }),

    setSettingsOpen: (open) => set({ settingsOpen: open }),
    setHotkeysOpen: (open) => set({ hotkeysOpen: open }),
    ...agentActions,
    ...mcpActions,
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

    undo: () => {
      const label = get().session.undoLabel();
      if (!get().session.undo()) { set({ lastMessage: "Nothing to undo" }); return; }
      bump({ lastMessage: `Undid ${label ?? "the last change"}`, toast: null, faceSelection: null }); afterMutate();
    },
    redo: () => {
      const label = get().session.redoLabel();
      if (!get().session.redo()) { set({ lastMessage: "Nothing to redo" }); return; }
      bump({ lastMessage: `Redid ${label ?? "the last change"}`, toast: null, faceSelection: null }); afterMutate();
    },
    editOperation: async (opId, params) => {
      // a changed value that should be an expression must read and name only real parameters
      const was = get().session.timeline.find((o) => o.opId === opId)?.params as Record<string, unknown> | undefined;
      if (was && !String(get().session.timeline.find((o) => o.opId === opId)?.type).startsWith("intent.")) {
        for (const [k, v] of Object.entries(params)) {
          if (typeof v !== "string" || v === was[k] || PROSE_KEYS.has(k)) continue;
          const problem = expressionProblem(v, get().session.doc.parameters.map((p) => p.name));
          if (problem && expressionProblem(String(was[k] ?? "0"), get().session.doc.parameters.map((p) => p.name)) === null) {
            set({ toast: { kind: "error", text: problem } });
            return;
          }
        }
      }
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
        await geometry.init({ wasmUrl: occWasmUrl }); // idempotent
        set({ kernelReady: geometry.ready(), kernelLoading: false });
      } catch (e) {
        set({ kernelLoading: false, toast: { kind: "error", text: `3D kernel failed to load: ${(e as Error).message}` } });
      }
    },
    rebuildSolids: async () => {
      await get().ensureKernel();
      if (!get().kernelReady) return;
      // Coalesce, latest-wins: while one evaluate is in flight, a new request
      // only flags that another is needed. When the build finishes it re-runs
      // for the CURRENT doc, so rapid edits (dragging a slider) never queue a
      // backlog of stale rebuilds — the preview always chases the latest value.
      // A caller that awaits gets the running loop's promise, which settles only
      // after that re-run, so it always sees solids for the doc as it is now.
      if (rebuildInFlight) { rebuildDirty = true; return rebuildInFlight; }
      rebuildInFlight = (async () => {
        try {
          const started = performance.now(); // kept across the re-runs a drag queues: it's one wait to the person watching
          do {
            rebuildDirty = false;
            const doc = get().session.doc;
            set({ build: { started, fraction: 0 } });
            // The meshes land first and the loop goes on (to the next value of a drag, say); the
            // exact measurements (volume, area, centroid, box) follow and are folded in when they
            // arrive — unless a newer build has landed by then, in which case they are of a
            // superseded model and the backend gave them up anyway.
            const token = ++buildToken;
            const shown = (r: EvaluateResult) => {
              // The backend may run on a worker (a doc copy), so fold the derived state
              // back onto the live doc: feature distances (inspector) and re-resolved
              // face-sketch planes (so the ghost sketch tracks its face).
              for (const [fid, s] of Object.entries(r.solids)) {
                const f = doc.features[fid];
                if (f && f.kind === "extrude" && Number.isFinite(s.distance)) f.distanceValue = s.distance;
              }
              for (const [sid, plane] of Object.entries(r.facePlanes)) {
                const sk = doc.sketches[sid];
                if (sk) sk.plane = plane;
              }
              bump({ solids: r.solids });
            };
            let landed!: () => void;
            const meshes = new Promise<void>((res) => { landed = res; });
            const measured = geometry.evaluate(doc, (fraction) => set({ build: { started, fraction } }), (r) => { shown(r); landed(); });
            void measured.then((r) => {
              if (token !== buildToken || r.complete === false) return;
              set((s) => ({ rev: s.rev + 1, solids: Object.fromEntries(Object.entries(s.solids).map(([id, row]) => [id, r.solids[id] ? { ...row, ...r.solids[id], mesh: row.mesh } : row])) }));
            }, () => { /* reported through the race below when it is this build's failure */ });
            await Promise.race([meshes, measured]);
          } while (rebuildDirty);
          await refreshAnalysis();
        } finally {
          rebuildInFlight = null;
          set({ build: null });
        }
      })();
      return rebuildInFlight;
    },
    runMotionStudy: async () => {
      const doc = get().session.doc;
      if (!driveParams(doc).length) { set({ hasMotionStudy: false, motionStatus: "idle", motionResult: null }); return; }
      const token = ++motionToken; // supersede any in-flight study
      set({ hasMotionStudy: true, motionStatus: "running", motionProgress: 0, motionResult: null });
      try {
        if (!studyReady) { await studyGeometry.init({ wasmUrl: occWasmUrl }); studyReady = studyGeometry.ready(); }
        const res = await runMotionStudy(studyGeometry, doc, {
          steps: 8,
          onProgress: (f) => { if (token === motionToken) set({ motionProgress: f }); },
          cancelled: () => token !== motionToken,
        });
        if (token !== motionToken) return;            // superseded by a newer run
        if (!res) { set({ motionStatus: "idle" }); return; } // cancelled
        set({ motionStatus: res.status, motionResult: res, motionProgress: 1 });
      } catch (e) {
        if (token === motionToken) set({ motionStatus: "fail", motionResult: { status: "fail", reason: (e as Error).message, worstOverlap: 0 }, motionProgress: 1 });
      }
    },
    cancelMotionStudy: () => { motionToken++; set({ motionStatus: "idle", motionProgress: 0 }); },
    extrudeSketch: async (sketchId, distanceExpr, opts) => {
      if (distanceExpr != null && !opts?.toFace && !opts?.throughAll) {
        const problem = expressionProblem(distanceExpr, get().session.doc.parameters.map((p) => p.name));
        if (problem) { set({ toast: { kind: "error", text: `Distance: ${problem}` } }); return; }
      }
      // a sketch with no closed region has nothing to extrude: say so rather than add a feature that fails (M11)
      const sk = get().session.doc.sketches[sketchId];
      if (sk && !opts?.region && !hasClosedRegion(sk)) {
        set({ toast: { kind: "error", text: `${sk.name} has no closed region to extrude: close its outline first` } });
        return;
      }
      await get().ensureKernel();
      await runDispatch("feature.extrude", {
        sketch: sketchId,
        distance: distanceExpr ?? "10",
        ...(opts?.operation ? { operation: opts.operation } : {}),
        ...(opts?.symmetric ? { symmetric: true } : {}),
        ...(opts?.region ? { region: opts.region } : {}),
        ...(opts?.toFace ? { extent: "toFace", toFace: opts.toFace, distance: "0" } : {}),
        ...(opts?.throughAll ? { extent: "throughAll" } : {}),
        ...(opts?.reverse && !opts?.symmetric && !opts?.toFace ? { direction: "reverse" } : {}),
      });
    },
    mirrorModel: async (plane) => {
      await get().ensureKernel();
      if (!Object.keys(get().session.doc.features).length) { set({ toast: { kind: "info", text: "Make a body first, then mirror it." } }); return; }
      const r = await runDispatch("feature.mirror", { plane });
      if (r.ok) { await get().rebuildSolids(); set({ lastMessage: `Mirrored across ${plane}.` }); }
      else set({ toast: { kind: "error", text: r.error ?? "Mirror failed." } });
    },
    openExtrude: (sketchId) => {
      const s = get();
      const sketches = profileChoices(s.session.doc);
      const hasBody = Object.keys(s.session.doc.features).length > 0;
      // the sketch asked for, else the open one, else the latest that has a closed region
      const target = sketchId ?? s.activeSketchId ?? (sketches.length ? sketches[sketches.length - 1].id : null);
      if (!target && !hasBody) { set({ toast: { kind: "info", text: "Draw a sketch first, then extrude." } }); return; }
      const onFace = !!target && s.session.doc.sketches[target]?.planeId === "custom";
      // Enter an extrude session: click a profile region or a face to pick what to extrude.
      set({
        extrudeActive: true, extrudeTarget: target, extrudeRegion: null,
        extrudeDistanceExpr: "10", extrudeOperation: hasBody && onFace ? "join" : "new", extrudeSymmetric: false, extrudeExtent: "distance", extrudeReverse: false, extrudeToFace: null,
        mode: "model", activeSketchId: null, selection: [], featureTool: null,
      });
    },
    closeExtrude: () => set({ extrudeActive: false, extrudeTarget: null, extrudeRegion: null }),

    featureTool: null,
    openFeatureTool: (kind, blend) => {
      const s = get();
      const doc = s.session.doc;
      const bodies = Object.values(s.solids).filter((b) => b.mesh && !b.error);
      const lastBody = bodies.length ? bodies[bodies.length - 1].featureId : null;
      const face = s.faceSelection;
      let tool: FeatureTool;
      if (kind === "revolve") {
        const choices = profileChoices(doc);
        if (!choices.length) { set({ toast: { kind: "info", text: "Draw a closed profile in a sketch first (and a line to turn it about), then revolve it." } }); return; }
        const sid = s.activeSketchId && choices.some((c) => c.id === s.activeSketchId) ? s.activeSketchId : choices[choices.length - 1].id;
        tool = { kind, sketch: sid, axis: defaultRevolveAxis(doc.sketches[sid]), angle: "360", operation: bodies.length && doc.sketches[sid]?.planeId === "custom" ? "join" : "new" };
      } else {
        if (!bodies.length) { set({ toast: { kind: "info", text: "Make a body first." } }); return; }
        const body = face?.bodyId || lastBody;
        if (kind === "shell") tool = { kind, body, faces: face?.faceName ? [{ name: face.faceName, point: face.point, normal: face.normal }] : [], thickness: "2" };
        else if (kind === "pattern") {
          const b = (body && s.solids[body]?.bounds) || null;
          const spacing = b ? String(Math.ceil(b.max.x - b.min.x + 5)) : "20";
          tool = { kind, body, mode: "linear", count: "3", direction: "X", spacing, axis: "Z", angle: "" };
        } else tool = { kind: "edges", blend: blend ?? "fillet", body, edges: [], size: blend === "chamfer" ? "1" : "2" };
      }
      set({
        featureTool: tool, extrudeActive: false, extrudeTarget: null, sketchPlacing: false, faceSelection: null,
        mode: "model", activeSketchId: null, selection: [],
        lastMessage: kind === "shell" ? "Shell: click the faces to open, set the wall, then Shell."
          : kind === "edges" ? `${tool.kind === "edges" && tool.blend === "chamfer" ? "Chamfer" : "Fillet"}: click the edges on the model, then ${tool.kind === "edges" && tool.blend === "chamfer" ? "Chamfer" : "Fillet"}.`
          : kind === "pattern" ? "Pattern: choose how many and how far apart, then Pattern."
          : "Revolve: choose the profile and the axis, then Revolve.",
      });
    },
    patchFeatureTool: (patch) => { const t = get().featureTool; if (t) set({ featureTool: { ...t, ...patch } as FeatureTool }); },
    closeFeatureTool: () => { if (get().featureTool) set({ featureTool: null, lastMessage: "" }); },
    commitFeatureTool: async () => {
      const tool = get().featureTool;
      if (!tool) return null;
      const cmd = toolCommand(tool, get().session.doc);
      if ("problem" in cmd) { set({ toast: { kind: "info", text: cmd.problem } }); return null; }
      for (const [label, expr] of Object.entries(toolExpressions(tool))) {
        const problem = typedProblem(expr);
        if (problem) { set({ toast: { kind: "error", text: `${label}: ${problem}` } }); return null; }
      }
      await get().ensureKernel();
      const r = await runDispatch(cmd.type, cmd.params);
      if (!r.ok) return null;
      set({ featureTool: null });
      await get().rebuildSolids();
      const sol = get().solids[r.createdIds[0]];
      if (sol?.error) set({ toast: { kind: "error", text: sol.error } });
      return r.createdIds[0] ?? null;
    },
    toolPickFace: (point, normal, bodyId, faceName) => {
      const t = get().featureTool;
      if (!t) return;
      if (t.kind === "shell") {
        if (!faceName) { set({ lastMessage: "That face has no name to remember it by; try another" }); return; }
        if (t.body && bodyId && bodyId !== t.body && t.faces.length) { set({ lastMessage: "Pick faces of one body" }); return; }
        set({ featureTool: { ...t, body: t.body ?? bodyId, faces: toggled(t.faces, { name: faceName, point, normal }, (a, b) => a.name === b.name) } });
      } else if ((t.kind === "pattern" || t.kind === "edges") && bodyId && t.body !== bodyId && !(t.kind === "edges" && t.edges.length)) {
        set({ featureTool: { ...t, body: bodyId } as FeatureTool });
      }
    },
    toolPickEdge: (bodyId, name) => {
      const t = get().featureTool;
      if (!t || t.kind !== "edges") return;
      if (t.body && t.body !== bodyId && t.edges.length) { set({ lastMessage: "Pick edges of one body" }); return; }
      const edges = toggled(t.edges, name);
      set({ featureTool: { ...t, body: bodyId, edges }, lastMessage: `${edges.length} edge${edges.length === 1 ? "" : "s"} picked` });
    },
    setExtrudeRegion: (p) => set({ extrudeRegion: p }),
    setExtrudeDistanceExpr: (expr) => set({ extrudeDistanceExpr: expr }),
    setExtrudeOperation: (op) => set({ extrudeOperation: op }),
    setExtrudeSymmetric: (on) => set({ extrudeSymmetric: on }),
    setExtrudeExtent: (e) => set({ extrudeExtent: e, ...(e === "toFace" ? { extrudeSymmetric: false } : { extrudeToFace: null }) }),
    pickExtrudeToFace: (point, normal) => {
      const s = get();
      const sk = s.extrudeTarget ? s.session.doc.sketches[s.extrudeTarget] : null;
      if (!sk) return;
      const pl = resolveSketchPlane(sk);
      const d = (point.x - pl.origin.x) * pl.normal.x + (point.y - pl.origin.y) * pl.normal.y + (point.z - pl.origin.z) * pl.normal.z;
      set({ extrudeToFace: faceRefOf(normal, point), extrudeDistanceExpr: String(Math.round(d * 100) / 100), lastMessage: "Extrude up to this face." });
    },
    commitExtrude: async () => {
      const s = get();
      if (!s.extrudeTarget) return;
      if (s.extrudeExtent === "toFace" && !s.extrudeToFace) { set({ lastMessage: "Click the face to extrude up to." }); return; }
      await s.extrudeSketch(s.extrudeTarget, s.extrudeExtent === "throughAll" ? "0" : s.extrudeDistanceExpr.trim() || "10", {
        operation: s.extrudeOperation,
        symmetric: s.extrudeSymmetric,
        region: s.extrudeRegion ?? undefined,
        reverse: s.extrudeReverse,
        throughAll: s.extrudeExtent === "throughAll",
        ...(s.extrudeExtent === "toFace" && s.extrudeToFace ? { toFace: s.extrudeToFace } : {}),
      });
      get().closeExtrude();
    },
    startFaceExtrude: async (hit, normal) => {
      await get().ensureKernel();
      if (!get().kernelReady) return;
      const doc = get().session.doc;
      // Stable origin: foot of the perpendicular from world (0,0,0) to the face plane.
      const d = hit.x * normal.x + hit.y * normal.y + hit.z * normal.z;
      const origin = { x: normal.x * d, y: normal.y * d, z: normal.z * d };
      const plane = makePlaneFromNormal(origin, normal);
      // Edges of every body, kept only where they lie in the picked face's plane.
      const all = (await Promise.all(Object.keys(doc.features).map((fid) => geometry.edges(doc, fid)))).flat();
      const tol = 0.02;
      const onPlane = all.filter((e) => e.pts.every((p) => Math.abs((p.x - origin.x) * normal.x + (p.y - origin.y) * normal.y + (p.z - origin.z) * normal.z) < tol));
      const curves = projectEdges(onPlane, plane);
      if (!curves.length) { bump({ toast: { kind: "info", text: "Couldn't read that face's boundary." } }); return; }
      const r = await runDispatch("sketch.create", { planeDef: { origin, normal }, faceRef: faceRefOf(normal, hit), name: "Face" });
      if (!r.ok) return;
      const sid = r.createdIds[0];
      await runDispatch("sketch.projectCurves", { sketch: sid, curves });
      // Pre-select the region under the click; a face boss defaults to Join.
      const uv = to2d(plane, hit);
      const hasBody = Object.keys(doc.features).length > 0;
      set({
        extrudeActive: true, extrudeTarget: sid, extrudeRegion: { x: uv.u, y: uv.v },
        extrudeDistanceExpr: "10", extrudeOperation: hasBody ? "join" : "new", extrudeSymmetric: false,
        mode: "model", activeSketchId: null,
      });
    },
    editFeatureDistance: async (featureId, expr) => {
      const op = get().session.timeline.find((o) => o.type === "feature.extrude" && o.createdIds.includes(featureId));
      if (op) await get().editOperation(op.opId, { ...op.params, distance: expr });
    },
    deleteFeature: async (featureId) => {
      const op = get().session.timeline.find((o) => o.type.startsWith("feature.") && o.createdIds.includes(featureId));
      if (op) await get().deleteOperation(op.opId);
    },
    editJointValue: async (jointId, expr) => {
      const op = get().session.timeline.find((o) => o.type === "joint.create" && o.createdIds.includes(jointId));
      if (op) await get().editOperation(op.opId, { ...op.params, value: expr });
    },
    deleteJoint: async (jointId) => {
      const op = get().session.timeline.find((o) => o.type === "joint.create" && o.createdIds.includes(jointId));
      if (op) await get().deleteOperation(op.opId);
    },

    // ---- parametric jointed assemblies ----
    addConnector: async (componentId, name, origin) => {
      await runDispatch("component.connector", { component: componentId, name, origin });
    },
    deleteConnector: async (componentId, name) => {
      const op = get().session.timeline.find((o) => o.type === "component.connector" && o.params.component === componentId && o.params.name === name);
      if (op) await get().deleteOperation(op.opId);
    },
    createComponentPattern: async (source, count, name) => {
      const r = await runDispatch("assembly.pattern", { source, count, ...(name ? { name } : {}) });
      return r.ok ? r.createdIds[0] : null;
    },
    editPatternCount: async (patternId, count) => {
      const op = get().session.timeline.find((o) => o.type === "assembly.pattern" && o.createdIds.includes(patternId));
      if (op) await get().editOperation(op.opId, { ...op.params, count });
    },
    deletePattern: async (patternId) => {
      // Remove the pattern's joint templates first (they reference it), then the pattern.
      const tmpls = get().session.timeline.filter((o) => o.type === "joint.template" && o.params.pattern === patternId);
      for (const t of tmpls) await get().deleteOperation(t.opId);
      const op = get().session.timeline.find((o) => o.type === "assembly.pattern" && o.createdIds.includes(patternId));
      if (op) await get().deleteOperation(op.opId);
    },
    createJointTemplate: async (patternId, params) => {
      await runDispatch("joint.template", { pattern: patternId, ...params });
    },
    editJointTemplateValue: async (templateId, expr) => {
      const op = get().session.timeline.find((o) => o.type === "joint.template" && o.createdIds.includes(templateId));
      if (op) await get().editOperation(op.opId, { ...op.params, value: expr });
    },
    setJointTemplateAppliesTo: async (templateId, appliesTo) => {
      const op = get().session.timeline.find((o) => o.type === "joint.template" && o.createdIds.includes(templateId));
      if (op) await get().editOperation(op.opId, { ...op.params, appliesTo });
    },
    deleteJointTemplate: async (templateId) => {
      const op = get().session.timeline.find((o) => o.type === "joint.template" && o.createdIds.includes(templateId));
      if (op) await get().deleteOperation(op.opId);
    },
    pickMenu: null,
    openPickMenu: (screen, hits) => {
      const items = pickItems(hits, get().solids, get().session.doc);
      if (items.length) set({ pickMenu: { screen, items } });
    },
    openSketchPickMenu: (screen, hits) => {
      const sk = activeSketch(get());
      if (!sk || !hits.length) return;
      set({ pickMenu: { screen, items: sketchPickItems(sk, hits) } });
    },
    closePickMenu: () => set({ pickMenu: null, hover: null }),
    choosePick: (item) => {
      const s = get();
      set({ pickMenu: null });
      if (item.kind === "entity") { s.select([item.id]); set({ hover: null }); return; }
      if (item.kind === "plane") { if (s.sketchPlacing) void s.startSketch(item.planeId); return; }
      if (s.extrudeActive && s.extrudeExtent === "toFace" && s.extrudeTarget) s.pickExtrudeToFace(item.point, item.normal);
      else if (s.extrudeActive) void s.startFaceExtrude(item.point, item.normal);
      else if (s.sketchPlacing) void s.startSketchOnFace(item.point, item.normal);
      else s.selectFace(item.point, item.normal, s.pickMenu?.screen ?? { x: 0, y: 0 }, item.bodyId);
    },
    drawing: null,
    openDrawing: async () => {
      await get().ensureKernel();
      const doc = get().session.doc;
      if (!Object.keys(doc.features).length) { set({ toast: { kind: "info", text: "Nothing to draw yet: make a body first." } }); return; }
      const title = doc.drawing?.title ?? (doc.components[doc.rootComponentId]?.name && doc.components[doc.rootComponentId].name !== "Root Component" ? doc.components[doc.rootComponentId].name : "Shop drawing");
      set({ drawing: { loading: true } });
      try {
        const r = await geometry.drawing(doc, { title, units: "mm" });
        if (get().drawing) set({ drawing: { ...r, title } }); // still open
      } catch (e) {
        set({ drawing: null, toast: { kind: "error", text: `Drawing failed: ${(e as Error).message}` } });
      }
    },
    closeDrawing: () => set({ drawing: null }),
    exportSolid: async (format) => {
      await get().ensureKernel();
      const doc = get().session.doc;
      const fid = Object.keys(doc.features)[0];
      if (!fid) { set({ toast: { kind: "error", text: "Nothing to export — extrude a sketch first." } }); return; }
      const bytes = await geometry.exportBytes(doc, fid, format);
      if (!bytes) { set({ toast: { kind: "error", text: "Export failed (no closed profile?)." } }); return; }
      const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `model.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },
    shareModel: async (name) => {
      const meshes = Object.values(get().solids)
        .filter((s) => s.mesh)
        .map((s) => ({ positions: s.mesh!.positions, indices: s.mesh!.indices }));
      if (!meshes.length) { set({ toast: { kind: "info", text: "Nothing to export yet." } }); return; }
      // A compliant mechanism prints unbent and in one piece, whatever pose the
      // sliders show; anything else exports as it stands.
      const doc = get().session.doc;
      // two print materials (an embedded skeleton): a 3MF, one part each
      const scope = resolveParameters(doc.parameters).scope;
      const materials = new Set(Object.values(get().solids).filter((sol) => sol.mesh)
        .map((sol) => materialForComponent(doc, sol.sketchId ? doc.sketches[sol.sketchId]?.componentId : undefined, scope)?.id ?? ""));
      const multi = materials.size > 1;
      const bytes = multi ? await geometry.exportBytes(doc, null, "3mf")
        : hasFlexures(doc) ? await geometry.exportBytes(doc, null, "stl") : meshesToStlBinary(meshes);
      if (!bytes) { set({ toast: { kind: "error", text: "Export failed." } }); return; }
      const file = multi
        ? new File([bytes as BlobPart], `${name || "model"}.3mf`, { type: "model/3mf" })
        : new File([bytes as BlobPart], `${name || "model"}.stl`, { type: "model/stl" });
      const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean; share?: (d: unknown) => Promise<void> };
      // Native share sheet (phones) → Save to Files / AirDrop / another app.
      if (nav.canShare && nav.share && nav.canShare({ files: [file] })) {
        try { await nav.share({ files: [file], title: file.name, text: `3D model (${multi ? "3MF" : "STL"}) from VibeCAD` }); return; }
        catch (e) { if ((e as Error).name === "AbortError") return; /* else fall through to download */ }
      }
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url; a.download = file.name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },

    initApp: async () => {
      mcpActions.initMcp();
      // the kernel (23 MB of wasm to fetch and compile) starts loading now, alongside the
      // saved document's recompute, not after it — the first rebuild finds it ready sooner
      void get().ensureKernel();
      // a 3D mouse: the desktop's native reader, or a browser device paired before
      void import("./spaceMouseInput").then((m) => m.autoConnectSpaceMouse()).catch(() => { /* no device support here */ });
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(AUTOSAVE_KEY);
      } catch {
        /* ignore */
      }
      if (saved) {
        try {
          await get().loadDocument(deserializeDocument(saved));
          let dirty = false;
          try { dirty = localStorage.getItem(AUTOSAVE_DIRTY_KEY) === "1"; } catch { /* ignore */ }
          set({ dirty });
        } catch {
          /* corrupt autosave — start fresh */
        }
      }
    },
    loadDocument: async (doc) => {
      const s = new CadSession(doc, registry, solver);
      set({
        dirty: false,
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
        faceSelection: null,
        extrudeActive: false, extrudeTarget: null, extrudeRegion: null,
        sketchPlacing: false, featureTool: null,
        // a stale hint from the last document ("Pick an origin plane…") must not outlive it
        lastMessage: doc.operations.length ? "" : "Pick an origin plane to start a sketch.",
      });
      await s.recompute();
      bump();
      if (Object.keys(s.doc.features).length) await get().rebuildSolids();
    },
    dirty: false,
    renameDocument: async (name) => {
      const r = await get().session.renameDocument(name);
      if (!r.ok) return;
      bump({ lastMessage: get().session.doc.name ? `Named the document ${get().session.doc.name}` : "The document is untitled" });
      scheduleAutosave();
    },
    renameEntity: async (id, name) => {
      const clean = name.replace(/\s+/g, " ").trim();
      if (!clean) return;
      const r = await renameViaEdit(get().session.doc, id, clean, (opId, params) => get().editOperation(opId, params), () => get().session.doc);
      if (r.ok) set({ lastMessage: `Renamed to ${clean}` });
      else set({ toast: { kind: "error", text: r.error ?? "Couldn't rename that" } });
    },
    newDocument: async () => {
      await get().loadDocument(createDocument());
      set({ lastMessage: "New document. Pick an origin plane to start a sketch." });
      try {
        localStorage.removeItem(AUTOSAVE_KEY);
      } catch {
        /* ignore */
      }
    },
    saveToFile: () => {
      const doc = get().session.doc;
      const blob = new Blob([serializeDocument(doc)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = documentFileName(doc.name);
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      set({ dirty: false, lastMessage: `Saved ${a.download}` });
      try { localStorage.setItem(AUTOSAVE_DIRTY_KEY, "0"); } catch { /* ignore */ }
    },
    openFile: async (file) => {
      try {
        const text = await file.text();
        const doc = deserializeDocument(text);
        // a file saved before documents had names is named after the file
        if (!doc.name) { const base = file.name.replace(/(\.vibecad)?\.json$/i, "").trim(); if (base && base !== "model") doc.name = base; }
        await get().loadDocument(doc);
        // the opened file is now the autosave too (not the document it replaced), and it starts clean
        try { localStorage.setItem(AUTOSAVE_KEY, serializeDocument(get().session.doc)); localStorage.setItem(AUTOSAVE_DIRTY_KEY, "0"); } catch { /* ignore */ }
        bump({ dirty: false, toast: { kind: "info", text: `Opened ${file.name}` }, lastMessage: `Opened ${doc.name ?? file.name}` });
      } catch (e) {
        bump({ toast: { kind: "error", text: `Open failed: ${(e as Error).message}` } });
      }
    },
    importFile: async (file) => {
      try {
        const reqs = await importRequests(file.name, new Uint8Array(await file.arrayBuffer()), { rhino3dmWasmUrl });
        const ids = await importAll(reqs);
        set({ mode: "model" });
        await get().rebuildSolids();
        const failed = ids.map((id) => get().solids[id]).find((sol) => sol?.error);
        bump({ toast: failed ? { kind: "error", text: failed.error! } : { kind: "info", text: `Imported ${reqs.length > 1 ? `${reqs.length} bodies from ` : ""}${file.name}` } });
      } catch (e) {
        bump({ toast: { kind: "error", text: `Import failed: ${(e as Error).message}` } });
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
  (window as any).__vibecad = useStore;
}
