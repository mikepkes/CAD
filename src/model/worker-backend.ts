// Browser geometry backend: runs the kernel in a Web Worker (see
// geometry.worker.ts) so B-rep evaluation never blocks the main thread. One
// worker for now; because the job handler is pure and stateless, growing this
// into a round-robin pool for parallel independent jobs is a localized change.
//
// This module references `new Worker(new URL(...))`, which only resolves in a
// bundler/browser realm — it is imported solely from the browser store, never
// from Node tests (those use InlineGeometryBackend).

import { GeometryBackend, GeometryRequest, GeometryRequestInit, GeometryResponse, ExportFormat, EvaluateResult, TopologyOpts } from "../core/geometry/backend";
import { CadDocument } from "../core/document";
import { CollisionResult, BodyTopology, BodyAnalysisResult, type BuildProgressSink } from "../core/features";
import { KernelInitOptions, Edge3D } from "../core/occ/kernel";
import type { CutPart, SheetOptions } from "../core/drawings";

export class WorkerGeometryBackend implements GeometryBackend {
  private worker: Worker;
  private isReady = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private seq = 1;
  /** Per request: handles an answer, returning true once the request is done. */
  private pending = new Map<number, (r: GeometryResponse) => boolean>();
  private progress = new Map<number, BuildProgressSink>();

  constructor() {
    this.worker = new Worker(new URL("./geometry.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as { kind: "ready" } | GeometryResponse;
      if (msg.kind === "ready") { this.isReady = true; this.readyResolve?.(); return; }
      if (msg.kind === "progress") { this.progress.get(msg.id)?.(msg.fraction, msg.step); return; }
      // a request's handler hears every answer to it and says when it is done (a staged evaluate has two)
      const handle = this.pending.get(msg.id);
      if (handle && handle(msg)) { this.pending.delete(msg.id); this.progress.delete(msg.id); }
    };
  }

  init(opts: KernelInitOptions): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = new Promise((res) => { this.readyResolve = res; });
      this.worker.postMessage({ kind: "init", wasmUrl: opts.wasmUrl });
    }
    return this.readyPromise;
  }
  ready(): boolean { return this.isReady; }

  private send(req: GeometryRequestInit, onProgress?: BuildProgressSink, onEarly?: (r: GeometryResponse) => void): Promise<GeometryResponse> {
    const id = this.seq++;
    if (onProgress) this.progress.set(id, onProgress);
    return new Promise((resolve) => {
      this.pending.set(id, (r) => {
        // a staged evaluate's first answer (its meshes) comes early; its last one settles the request
        if (onEarly && r.kind === "evaluate") { onEarly(r); return false; }
        resolve(r);
        return true;
      });
      this.worker.postMessage({ ...req, id } as GeometryRequest);
    });
  }

  async evaluate(doc: CadDocument, onProgress?: BuildProgressSink, onMeshes?: (r: EvaluateResult) => void): Promise<EvaluateResult> {
    if (!onMeshes) {
      const r = await this.send({ kind: "evaluate", doc }, onProgress);
      if (r.kind === "evaluate") return { solids: r.solids, facePlanes: r.facePlanes, complete: true };
      throw new Error(r.kind === "error" ? r.message : "evaluate failed");
    }
    const r = await this.send({ kind: "evaluate", doc, staged: true }, onProgress, (early) => {
      if (early.kind === "evaluate") onMeshes({ solids: early.solids, facePlanes: early.facePlanes });
    });
    if (r.kind === "measured") return { solids: r.solids, facePlanes: {}, complete: r.complete };
    throw new Error(r.kind === "error" ? r.message : "evaluate failed");
  }
  async edges(doc: CadDocument, featureId: string): Promise<Edge3D[]> {
    const r = await this.send({ kind: "edges", doc, featureId });
    if (r.kind === "edges") return r.edges;
    throw new Error(r.kind === "error" ? r.message : "edges failed");
  }
  async exportBytes(doc: CadDocument, featureId: string | null, format: ExportFormat): Promise<Uint8Array | null> {
    const r = await this.send({ kind: "export", doc, featureId, format });
    if (r.kind === "export") return r.bytes;
    throw new Error(r.kind === "error" ? r.message : "export failed");
  }
  async collide(doc: CadDocument, overrides?: Record<string, string>): Promise<CollisionResult> {
    const r = await this.send({ kind: "collide", doc, overrides });
    if (r.kind === "collide") return r.result;
    throw new Error(r.kind === "error" ? r.message : "collide failed");
  }
  async topology(doc: CadDocument, opts?: TopologyOpts): Promise<BodyTopology[]> {
    const r = await this.send({ kind: "topology", doc, opts });
    if (r.kind === "topology") return r.bodies;
    throw new Error(r.kind === "error" ? r.message : "topology failed");
  }
  async analyze(doc: CadDocument, opts?: { bodyId?: string; combs?: boolean }): Promise<BodyAnalysisResult[]> {
    const r = await this.send({ kind: "analyze", doc, opts });
    if (r.kind === "analyze") return r.bodies;
    throw new Error(r.kind === "error" ? r.message : "analyze failed");
  }
  async drawing(doc: CadDocument, opts?: SheetOptions): Promise<{ svg: string; parts: CutPart[] }> {
    const r = await this.send({ kind: "drawing", doc, opts });
    if (r.kind === "drawing") return { svg: r.svg, parts: r.parts };
    throw new Error(r.kind === "error" ? r.message : "drawing failed");
  }
  async distance(doc: CadDocument, a: string, b: string): Promise<number> {
    const r = await this.send({ kind: "distance", doc, a, b });
    if (r.kind === "distance") return r.distance;
    throw new Error(r.kind === "error" ? r.message : "distance failed");
  }
  dispose(): void { this.worker.terminate(); this.pending.clear(); }
}
