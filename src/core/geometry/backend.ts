// The geometry backend seam. Everything above the kernel (the store, the UI)
// talks to this async interface instead of calling the OCC kernel directly, so
// the heavy B-rep work can live wherever we want: inline on the caller's thread
// (tests, fallback), in a Web Worker (the browser app), in a Node worker_thread,
// or — eventually — behind a native Rust/Tauri command. The contract is plain
// data in, plain data out; meshes come back as transferable typed arrays.

import { CadDocument } from "../document";
import { resolveParameters } from "../../model/parameters";
import { initKernel, isKernelReady, KernelInitOptions, Edge3D } from "../occ/kernel";
import { evaluateFeatures, featureEdges, exportFeatureBytes, SolidEval } from "../features";

export type ExportFormat = "stl" | "step";

export interface GeometryBackend {
  /** Load the kernel (wherever this backend runs it). Idempotent. */
  init(opts: KernelInitOptions): Promise<void>;
  /** True once the kernel is loaded and jobs will produce geometry. */
  ready(): boolean;
  /** Evaluate every feature into display meshes (keyed by feature/body id). */
  evaluate(doc: CadDocument): Promise<Record<string, SolidEval>>;
  /** World-space B-rep edges of one feature's solid (for projection into a sketch). */
  edges(doc: CadDocument, featureId: string): Promise<Edge3D[]>;
  /** STL/STEP bytes for one feature's solid. */
  exportBytes(doc: CadDocument, featureId: string, format: ExportFormat): Promise<Uint8Array | null>;
  /** Release workers / native resources. */
  dispose(): void;
}

const scopeOf = (doc: CadDocument) => resolveParameters(doc.parameters).scope;

// ---- shared job protocol (used by both worker adapters) --------------------

export type GeometryRequest =
  | { id: number; kind: "evaluate"; doc: CadDocument }
  | { id: number; kind: "edges"; doc: CadDocument; featureId: string }
  | { id: number; kind: "export"; doc: CadDocument; featureId: string; format: ExportFormat };

export type GeometryResponse =
  | { id: number; kind: "evaluate"; solids: Record<string, SolidEval> }
  | { id: number; kind: "edges"; edges: Edge3D[] }
  | { id: number; kind: "export"; bytes: Uint8Array | null }
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
export async function runGeometryJob(req: GeometryRequest): Promise<{ res: GeometryResponse; transfer: ArrayBuffer[] }> {
  try {
    const scope = scopeOf(req.doc);
    if (req.kind === "evaluate") {
      const solids = evaluateFeatures(req.doc, scope);
      return { res: { id: req.id, kind: "evaluate", solids }, transfer: meshTransferables(solids) };
    }
    if (req.kind === "edges") {
      const edges = featureEdges(req.doc, scope, req.featureId);
      return { res: { id: req.id, kind: "edges", edges }, transfer: [] };
    }
    const bytes = await exportFeatureBytes(req.doc, scope, req.featureId, req.format);
    return { res: { id: req.id, kind: "export", bytes }, transfer: bytes ? [bytes.buffer as ArrayBuffer] : [] };
  } catch (e) {
    return { res: { id: req.id, kind: "error", message: (e as Error).message }, transfer: [] };
  }
}

// ---- inline backend (same thread as the caller) ----------------------------

/** Runs the kernel on the caller's own thread. The default for tests and the
 *  fallback when workers aren't available. */
export class InlineGeometryBackend implements GeometryBackend {
  private isReady = false;
  async init(opts: KernelInitOptions): Promise<void> {
    await initKernel(opts);
    this.isReady = isKernelReady();
  }
  ready(): boolean { return this.isReady; }
  async evaluate(doc: CadDocument): Promise<Record<string, SolidEval>> {
    return evaluateFeatures(doc, scopeOf(doc));
  }
  async edges(doc: CadDocument, featureId: string): Promise<Edge3D[]> {
    return featureEdges(doc, scopeOf(doc), featureId);
  }
  async exportBytes(doc: CadDocument, featureId: string, format: ExportFormat): Promise<Uint8Array | null> {
    return exportFeatureBytes(doc, scopeOf(doc), featureId, format);
  }
  dispose(): void {}
}
