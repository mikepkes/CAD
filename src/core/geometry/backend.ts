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
import { evaluateFeatures, featureEdges, exportFeatureBytes, exportFusedBlob, printPartsByMaterial, collideFeatures, CollisionResult, GeometryCache, SolidEval, bodyTopology, BodyTopology, bodyDistance } from "../features";
import { meshesTo3mf } from "../export/threemf";
import { hasFlexures } from "../../sim/flexure";
import { placeComponentSketches, placeParametricPoints } from "../recompute";
import { expandAssembly, hasAssemblyPatterns, instanceSolids } from "../assembly";
import { Scope } from "../../math/expr";

/** "3mf" is the whole model as one object with a part per material, for a
 *  multi-material print. */
export type ExportFormat = "stl" | "step" | "3mf";

/** Evaluated geometry plus the re-resolved planes of any face-referenced sketches
 *  (so the caller can fold them back onto a doc the worker only saw a copy of). */
export interface EvaluateResult {
  solids: Record<string, SolidEval>;
  facePlanes: Record<string, WorkPlane>;
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
  /** Evaluate every feature into display meshes, plus re-resolved face-sketch planes. */
  evaluate(doc: CadDocument): Promise<EvaluateResult>;
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
  /** Release workers / native resources. */
  dispose(): void;
}

const scopeOf = (doc: CadDocument) => resolveParameters(doc.parameters).scope;

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
  if (!hasAssemblyPatterns(doc)) return evaluateFeatures(doc, scope, cache);
  placeComponentSketches(doc, scope); // place the source sketches in their component frames
  const source = evaluateFeatures(doc, scope, cache);
  return instanceSolids(doc, scope, source);
}

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

// ---- shared job protocol (used by both worker adapters) --------------------

export type GeometryRequest =
  | { id: number; kind: "evaluate"; doc: CadDocument }
  | { id: number; kind: "edges"; doc: CadDocument; featureId: string }
  | { id: number; kind: "export"; doc: CadDocument; featureId: string | null; format: ExportFormat }
  | { id: number; kind: "collide"; doc: CadDocument; overrides?: Record<string, string> }
  | { id: number; kind: "topology"; doc: CadDocument; opts?: TopologyOpts }
  | { id: number; kind: "distance"; doc: CadDocument; a: string; b: string };

export type GeometryResponse =
  | { id: number; kind: "evaluate"; solids: Record<string, SolidEval>; facePlanes: Record<string, WorkPlane> }
  | { id: number; kind: "edges"; edges: Edge3D[] }
  | { id: number; kind: "export"; bytes: Uint8Array | null }
  | { id: number; kind: "collide"; result: CollisionResult }
  | { id: number; kind: "topology"; bodies: BodyTopology[] }
  | { id: number; kind: "distance"; distance: number }
  | { id: number; kind: "error"; message: string };

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

/**
 * The pure, environment-agnostic job handler both workers run. No `self`, no
 * `parentPort` — just a request in, a response plus its transfer list out. The
 * kernel must already be initialized in whatever realm this runs in.
 */
export async function runGeometryJob(req: GeometryRequest, cache?: GeometryCache): Promise<{ res: GeometryResponse; transfer: ArrayBuffer[] }> {
  try {
    const scope = scopeOf(req.doc);
    if (req.kind === "evaluate") {
      const solids = evaluateForRender(req.doc, scope, cache);
      return { res: { id: req.id, kind: "evaluate", solids, facePlanes: collectFacePlanes(req.doc) }, transfer: meshTransferables(solids) };
    }
    if (req.kind === "edges") {
      const edges = featureEdges(geometryDoc(req.doc, scope), scope, req.featureId);
      return { res: { id: req.id, kind: "edges", edges }, transfer: [] };
    }
    if (req.kind === "topology") {
      return { res: { id: req.id, kind: "topology", bodies: topologyOf(req.doc, req.opts) }, transfer: [] };
    }
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
  async evaluate(doc: CadDocument): Promise<EvaluateResult> {
    const solids = evaluateForRender(doc, scopeOf(doc), this.cache);
    return { solids, facePlanes: collectFacePlanes(doc) };
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
  async distance(doc: CadDocument, a: string, b: string): Promise<number> {
    const d = geometryDoc(doc, scopeOf(doc));
    return bodyDistance(d, scopeOf(d), a, b);
  }
  dispose(): void {}
}
