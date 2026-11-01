// The geometry backend seam. Everything above the kernel (the store, the UI)
// talks to this async interface instead of calling the OCC kernel directly, so
// the heavy B-rep work can live wherever we want: inline on the caller's thread
// (tests, fallback), in a Web Worker (the browser app), in a Node worker_thread,
// or — eventually — behind a native Rust/Tauri command. The contract is plain
// data in, plain data out; meshes come back as transferable typed arrays.

import { CadDocument } from "../document";
import { resolveParameters } from "../parameters";
import { WorkPlane } from "../../geometry/plane";
import { initKernel, isKernelReady, KernelInitOptions, Edge3D, kernelErrorMessage } from "../occ/kernel";
import { evaluateFeaturesStaged, StagedEvaluation, withBuildProgress, featureEdges, exportFeatureBytes, exportFusedBlob, printPartsByMaterial, collideFeatures, CollisionResult, GeometryCache, SolidEval, bodyTopology, BodyTopology, bodyDistance, analyzeBodies, BodyAnalysisResult } from "../features";
import { meshesTo3mf } from "../export/threemf";
import { hasFlexures } from "../../sim/flexure";
import { placeComponentSketches, placeParametricPoints } from "../recompute";
import { expandAssembly, hasAssemblyPatterns, instanceSolids } from "../assembly";
import { Scope } from "../../math/expr";
import { cutList, drawingSheetSVG, type CutPart, type SheetOptions } from "../drawings";

/** "3mf" is the whole model as one object with a part per material, for a
 *  multi-material print. */
export type ExportFormat = "stl" | "step" | "3mf";

/** Evaluated geometry plus the re-resolved planes of any face-referenced sketches
 *  (so the caller can fold them back onto a doc the worker only saw a copy of). */
export interface EvaluateResult {
  solids: Record<string, SolidEval>;
  facePlanes: Record<string, WorkPlane>;
  /** False when the measuring was given up because a newer evaluation superseded this one
   *  (the rows then carry their meshes' boxes and lack the mass properties). */
  complete?: boolean;
}

/** The current planes of sketches that re-resolve to a body face (set by evaluate). */
function collectFacePlanes(doc: CadDocument): Record<string, WorkPlane> {
  const out: Record<string, WorkPlane> = {};
  for (const sk of Object.values(doc.sketches)) {
    if (sk.faceRef && sk.plane) out[sk.id] = sk.plane;
  }
  return out;
}

export interface TopologyOpts { bodyId?: string; faces?: boolean; edges?: boolean }

export interface GeometryBackend {
  /** Load the kernel (wherever this backend runs it). Idempotent. */
  init(opts: KernelInitOptions): Promise<void>;
  /** True once the kernel is loaded and jobs will produce geometry. */
  ready(): boolean;
  /** Evaluate every feature into display meshes, plus re-resolved face-sketch planes;
   *  `onProgress` hears how far it has got (0…1) as it goes. With `onMeshes`, the rows
   *  are delivered to it as soon as their meshes exist — before the exact measuring
   *  (box, volume, area, centroid) of the bodies not measured before, which only the
   *  returned promise waits for; until then such a row carries its mesh's box and no
   *  mass properties. The promise's rows carry no meshes then (they were delivered). */
  evaluate(doc: CadDocument, onProgress?: (fraction: number) => void, onMeshes?: (r: EvaluateResult) => void): Promise<EvaluateResult>;
  /** World-space B-rep edges of one feature's solid (for projection into a sketch). */
  edges(doc: CadDocument, featureId: string): Promise<Edge3D[]>;
  /** STL/STEP bytes for one feature's solid, or (featureId null) the whole model
   *  fused into one print-ready solid. */
  exportBytes(doc: CadDocument, featureId: string | null, format: ExportFormat): Promise<Uint8Array | null>;
  /** Measure body-body interpenetration at a configuration (param `overrides`
   *  set the pose), for the motion study's pass/fail. */
  collide(doc: CadDocument, overrides?: Record<string, string>): Promise<CollisionResult>;
  /** Bodies with exact mass properties and their named faces/edges (all bodies, or one). */
  topology(doc: CadDocument, opts?: TopologyOpts): Promise<BodyTopology[]>;
  /** Minimum distance between two bodies (by creating-feature id). */
  distance(doc: CadDocument, a: string, b: string): Promise<number>;
  /** Curvature per display-mesh vertex, edge continuity and curvature combs (all bodies, or one). */
  analyze(doc: CadDocument, opts?: { bodyId?: string; combs?: boolean }): Promise<BodyAnalysisResult[]>;
  /** A shop drawing of the model: the third-angle sheet (SVG) and the builder's cut list. */
  drawing(doc: CadDocument, opts?: SheetOptions): Promise<{ svg: string; parts: CutPart[] }>;
  /** Release workers / native resources. */
  dispose(): void;
}

const scopeOf = (doc: CadDocument) => resolveParameters(doc.parameters).scope;

/** The drawing sheet and cut list of a document (placed as the recompute places components). */
function drawingOf(doc: CadDocument, opts?: SheetOptions): { svg: string; parts: CutPart[] } {
  const scope = scopeOf(doc);
  const d = geometryDoc(structuredClone(doc), scope);
  placeComponentSketches(d, scope);
  return { svg: drawingSheetSVG(d, scope, opts), parts: cutList(d, scope) };
}

/** Expand component patterns into concrete instances and place every sketch in
 *  its (instance's) component frame, so geometry/collision see the articulated
 *  copies. A no-op passthrough when the document has no component patterns. */
function geometryDoc(doc: CadDocument, scope: Scope): CadDocument {
  if (!hasAssemblyPatterns(doc)) return doc;
  const d = expandAssembly(doc, scope);
  placeComponentSketches(d, scope);
  return d;
}

/** Build the solids to render. For a patterned doc, evaluate the SOURCE bodies
 *  once (cacheable — they don't depend on the joint-drive params) and instance
 *  them by transforming the mesh; otherwise the plain feature evaluation. */
function evaluateForRender(doc: CadDocument, scope: Scope, cache?: GeometryCache): Record<string, SolidEval> {
  const staged = evaluateForRenderStaged(doc, scope, cache);
  while (staged.measureNext()) { /* every body, exactly */ }
  return staged.render();
}

/** evaluateForRender in stages (see StagedEvaluation): `render()` gives the rows to show —
 *  with their meshes — as they stand, before or after the measuring. */
function evaluateForRenderStaged(doc: CadDocument, scope: Scope, cache?: GeometryCache): StagedEvaluation & { render(): Record<string, SolidEval> } {
  if (!hasAssemblyPatterns(doc)) {
    const staged = evaluateFeaturesStaged(doc, scope, cache);
    return { ...staged, get pending() { return staged.pending; }, render: () => staged.solids };
  }
  placeComponentSketches(doc, scope); // place the source sketches in their component frames
  const staged = evaluateFeaturesStaged(doc, scope, cache);
  return { ...staged, get pending() { return staged.pending; }, render: () => instanceSolids(doc, scope, staged.solids) };
}

/** The rows without their meshes (delivered already): what the measuring adds. */
function measuredRows(solids: Record<string, SolidEval>): Record<string, SolidEval> {
  return Object.fromEntries(Object.entries(solids).map(([id, r]) => [id, { ...r, mesh: undefined }]));
}

/** Let the event loop run (so a worker can hear a newer request between two measurements). */
const breathe = () => new Promise<void>((r) => setTimeout(r, 0));
/** How long to measure before breathing (ms). */
const MEASURE_SLICE_MS = 12;

/** A pose of `doc` for a collision check: parameter expressions overridden and
 *  sketches re-placed in their components' frames for those values, with their
 *  expression-positioned points moved too (geometry drawn to follow a drive,
 *  like a beam that bends with it). Clones the parameters and sketches so
 *  re-placing them never disturbs the caller's live document (the worker gets a
 *  copy anyway; the inline backend does not). */
function poseDoc(doc: CadDocument, overrides?: Record<string, string>): CadDocument {
  const parameters = doc.parameters.map((p) => (overrides?.[p.name] != null ? { ...p, expr: overrides[p.name] } : p));
  const scope = resolveParameters(parameters).scope;
  const sketches: CadDocument["sketches"] = {};
  for (const [id, sk] of Object.entries(doc.sketches)) {
    const parametric = overrides && Object.values(sk.entities).some((e) => e.kind === "point" && (e.xExpr !== undefined || e.yExpr !== undefined));
    sketches[id] = parametric ? { ...sk, entities: Object.fromEntries(Object.entries(sk.entities).map(([k, e]) => [k, { ...e }])) } : { ...sk };
    if (parametric) placeParametricPoints(sketches[id], scope);
  }
  const posed = { ...doc, parameters, sketches };
  placeComponentSketches(posed, scope);
  return posed;
}

/** The whole model as one solid, for printing. A compliant mechanism prints in
 *  its as-modelled (unbent) pose — joints dropped, so every link sits where it
 *  was drawn — with its links fused through their flexure strips; anything else
 *  prints as it stands. */
async function exportModelBytes(doc: CadDocument, format: ExportFormat): Promise<Uint8Array | null> {
  let printed = doc;
  if (hasFlexures(doc)) {
    // at rest: every joint drive at 0, so geometry drawn to follow one (a bent
    // beam) is unbent too. A drive is a slider (a bounded parameter) a joint's
    // motion reads; a derived size it also reads (a hinge's length, setting
    // where the pivots are) keeps its value, or the hinges would print at zero.
    const drives = Object.fromEntries(Object.values(doc.joints).filter((j) => !j.solve && !j.closes && j.kind !== "beam")
      .flatMap((j) => doc.parameters.filter((p) => p.min !== undefined && p.max !== undefined && new RegExp(`\\b${p.name}\\b`).test([j.valueExpr, ...Object.values(j.planar ?? {})].join(" "))).map((p) => [p.name, "0"])));
    printed = { ...poseDoc(doc, drives), joints: {} };
    placeComponentSketches(printed, scopeOf(printed));
  }
  const scope = scopeOf(printed);
  const geo = geometryDoc(printed, scope);
  if (format === "3mf") {
    const parts = printPartsByMaterial(geo, scopeOf(geo));
    return parts.length ? meshesTo3mf(parts.map((p) => ({ name: p.name, color: p.color, positions: p.mesh.positions, indices: p.mesh.indices })), "model") : null;
  }
  const blob = exportFusedBlob(geo, scopeOf(geo), format);
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/** Named topology + mass properties of the bodies as built (component patterns expanded). */
function topologyOf(doc: CadDocument, opts?: TopologyOpts): BodyTopology[] {
  const geo = geometryDoc(doc, scopeOf(doc));
  return bodyTopology(geo, scopeOf(geo), opts);
}

/** Surface analysis of the bodies as built (component patterns expanded). */
function analyzeOf(doc: CadDocument, opts?: { bodyId?: string; combs?: boolean }): BodyAnalysisResult[] {
  const geo = geometryDoc(doc, scopeOf(doc));
  return analyzeBodies(geo, scopeOf(geo), opts);
}

// ---- shared job protocol (used by both worker adapters) --------------------

export type GeometryRequest =
  /** `staged`: answer with the meshes first (an "evaluate" response), then the measurements (a "measured" one). */
  | { id: number; kind: "evaluate"; doc: CadDocument; staged?: boolean }
  | { id: number; kind: "edges"; doc: CadDocument; featureId: string }
  | { id: number; kind: "export"; doc: CadDocument; featureId: string | null; format: ExportFormat }
  | { id: number; kind: "collide"; doc: CadDocument; overrides?: Record<string, string> }
  | { id: number; kind: "topology"; doc: CadDocument; opts?: TopologyOpts }
  | { id: number; kind: "distance"; doc: CadDocument; a: string; b: string }
  | { id: number; kind: "analyze"; doc: CadDocument; opts?: { bodyId?: string; combs?: boolean } }
  | { id: number; kind: "drawing"; doc: CadDocument; opts?: SheetOptions };

export type GeometryResponse =
  | { id: number; kind: "evaluate"; solids: Record<string, SolidEval>; facePlanes: Record<string, WorkPlane> }
  /** A staged evaluation's second answer: every row measured (without its mesh), or — `complete` false —
   *  as far as it got before a newer evaluation superseded it. */
  | { id: number; kind: "measured"; solids: Record<string, SolidEval>; complete: boolean }
  | { id: number; kind: "edges"; edges: Edge3D[] }
  | { id: number; kind: "export"; bytes: Uint8Array | null }
  | { id: number; kind: "collide"; result: CollisionResult }
  | { id: number; kind: "topology"; bodies: BodyTopology[] }
  | { id: number; kind: "distance"; distance: number }
  | { id: number; kind: "analyze"; bodies: BodyAnalysisResult[] }
  | { id: number; kind: "drawing"; svg: string; parts: CutPart[] }
  | { id: number; kind: "error"; message: string }
  /** Not an answer: how far a running job has got (0…1), sent while it works. */
  | { id: number; kind: "progress"; fraction: number };

/** GeometryRequest without the id field, distributing over the union. */
export type GeometryRequestInit = GeometryRequest extends infer T ? (T extends { id: number } ? Omit<T, "id"> : never) : never;

/** Every mesh buffer in a solids map, for a zero-copy postMessage transfer list. */
export function meshTransferables(solids: Record<string, SolidEval>): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const s of Object.values(solids)) {
    if (!s.mesh) continue;
    out.push(
      s.mesh.positions.buffer as ArrayBuffer,
      s.mesh.normals.buffer as ArrayBuffer,
      s.mesh.indices.buffer as ArrayBuffer,
      s.mesh.edges.buffer as ArrayBuffer
    );
  }
  return out;
}

/** How a job handler talks back beyond its one answer: `emit` posts an earlier answer (a staged
 *  evaluation's meshes), `stale` says a newer evaluation has arrived (so stop measuring for this one). */
export interface JobChannel {
  emit?: (res: GeometryResponse, transfer: ArrayBuffer[]) => void;
  stale?: () => boolean;
}

/**
 * The pure, environment-agnostic job handler both workers run. No `self`, no
 * `parentPort` — just a request in, a response plus its transfer list out. The
 * kernel must already be initialized in whatever realm this runs in.
 */
export async function runGeometryJob(req: GeometryRequest, cache?: GeometryCache, onProgress?: (fraction: number) => void, channel: JobChannel = {}): Promise<{ res: GeometryResponse; transfer: ArrayBuffer[] }> {
  try {
    const scope = scopeOf(req.doc);
    if (req.kind === "evaluate") {
      if (!req.staged || !channel.emit) {
        const solids = withBuildProgress(onProgress, () => evaluateForRender(req.doc, scope, cache));
        return { res: { id: req.id, kind: "evaluate", solids, facePlanes: collectFacePlanes(req.doc) }, transfer: meshTransferables(solids) };
      }
      // staged: the meshes go out as soon as they exist; the measuring follows, breathing between
      // slices so a newer evaluation can be heard — and supersede it
      const staged = withBuildProgress(onProgress, () => evaluateForRenderStaged(req.doc, scope, cache));
      const shown = staged.render();
      channel.emit({ id: req.id, kind: "evaluate", solids: shown, facePlanes: collectFacePlanes(req.doc) }, meshTransferables(shown));
      let complete = true;
      while (staged.pending) {
        if (channel.stale?.()) { staged.dispose(); complete = false; break; }
        const t = performance.now();
        while (staged.pending && performance.now() - t < MEASURE_SLICE_MS) staged.measureNext();
        if (staged.pending) await breathe();
      }
      return { res: { id: req.id, kind: "measured", solids: measuredRows(complete ? staged.render() : shown), complete }, transfer: [] };
    }
    if (req.kind === "edges") {
      const edges = featureEdges(geometryDoc(req.doc, scope), scope, req.featureId);
      return { res: { id: req.id, kind: "edges", edges }, transfer: [] };
    }
    if (req.kind === "topology") {
      return { res: { id: req.id, kind: "topology", bodies: topologyOf(req.doc, req.opts) }, transfer: [] };
    }
    if (req.kind === "analyze") {
      const bodies = analyzeOf(req.doc, req.opts);
      return { res: { id: req.id, kind: "analyze", bodies }, transfer: bodies.flatMap((b) => [b.curvature.buffer as ArrayBuffer, b.combs.buffer as ArrayBuffer]) };
    }
    if (req.kind === "drawing") return { res: { id: req.id, kind: "drawing", ...drawingOf(req.doc, req.opts) }, transfer: [] };
    if (req.kind === "distance") {
      const doc = geometryDoc(req.doc, scope);
      return { res: { id: req.id, kind: "distance", distance: bodyDistance(doc, scopeOf(doc), req.a, req.b) }, transfer: [] };
    }
    if (req.kind === "collide") {
      const posed = poseDoc(req.doc, req.overrides);
      const doc = geometryDoc(posed, scopeOf(posed));
      const result = collideFeatures(doc, scopeOf(doc));
      return { res: { id: req.id, kind: "collide", result }, transfer: [] };
    }
    const bytes = req.featureId === null || req.format === "3mf" // a 3MF is always the whole model
      ? await exportModelBytes(req.doc, req.format)
      : await exportFeatureBytes(geometryDoc(req.doc, scope), scope, req.featureId, req.format);
    return { res: { id: req.id, kind: "export", bytes }, transfer: bytes ? [bytes.buffer as ArrayBuffer] : [] };
  } catch (e) {
    return { res: { id: req.id, kind: "error", message: kernelErrorMessage(e) }, transfer: [] };
  }
}

// ---- inline backend (same thread as the caller) ----------------------------

/** Runs the kernel on the caller's own thread. The default for tests and the
 *  fallback when workers aren't available. */
export class InlineGeometryBackend implements GeometryBackend {
  private isReady = false;
  private cache = new GeometryCache({ generations: 6 });
  async init(opts: KernelInitOptions): Promise<void> {
    await initKernel(opts);
    this.isReady = isKernelReady();
  }
  ready(): boolean { return this.isReady; }
  async evaluate(doc: CadDocument, onProgress?: (fraction: number) => void, onMeshes?: (r: EvaluateResult) => void): Promise<EvaluateResult> {
    if (!onMeshes) {
      const solids = withBuildProgress(onProgress, () => evaluateForRender(doc, scopeOf(doc), this.cache));
      return { solids, facePlanes: collectFacePlanes(doc), complete: true };
    }
    const staged = withBuildProgress(onProgress, () => evaluateForRenderStaged(doc, scopeOf(doc), this.cache));
    onMeshes({ solids: staged.render(), facePlanes: collectFacePlanes(doc) });
    while (staged.measureNext()) { /* every body, exactly */ }
    return { solids: measuredRows(staged.render()), facePlanes: collectFacePlanes(doc), complete: true };
  }
  async edges(doc: CadDocument, featureId: string): Promise<Edge3D[]> {
    const scope = scopeOf(doc);
    return featureEdges(geometryDoc(doc, scope), scope, featureId);
  }
  async exportBytes(doc: CadDocument, featureId: string | null, format: ExportFormat): Promise<Uint8Array | null> {
    if (featureId === null || format === "3mf") return exportModelBytes(doc, format); // a 3MF is always the whole model
    const scope = scopeOf(doc);
    return exportFeatureBytes(geometryDoc(doc, scope), scope, featureId, format);
  }
  async collide(doc: CadDocument, overrides?: Record<string, string>): Promise<CollisionResult> {
    const posed = poseDoc(doc, overrides);
    const d = geometryDoc(posed, scopeOf(posed));
    return collideFeatures(d, scopeOf(d));
  }
  async topology(doc: CadDocument, opts?: TopologyOpts): Promise<BodyTopology[]> {
    return topologyOf(doc, opts);
  }
  async analyze(doc: CadDocument, opts?: { bodyId?: string; combs?: boolean }): Promise<BodyAnalysisResult[]> {
    return analyzeOf(doc, opts);
  }
  async drawing(doc: CadDocument, opts?: SheetOptions): Promise<{ svg: string; parts: CutPart[] }> {
    return drawingOf(doc, opts);
  }
  async distance(doc: CadDocument, a: string, b: string): Promise<number> {
    const d = geometryDoc(doc, scopeOf(doc));
    return bodyDistance(d, scopeOf(d), a, b);
  }
  dispose(): void {}
}
