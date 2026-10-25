// Browser geometry backend: runs the kernel in a Web Worker (see
// geometry.worker.ts) so B-rep evaluation never blocks the main thread. One
// worker for now; because the job handler is pure and stateless, growing this
// into a round-robin pool for parallel independent jobs is a localized change.
//
// This module references `new Worker(new URL(...))`, which only resolves in a
// bundler/browser realm — it is imported solely from the browser store, never
// from Node tests (those use InlineGeometryBackend).

import { GeometryBackend, GeometryRequest, GeometryRequestInit, GeometryResponse, ExportFormat, EvaluateResult } from "./backend";
import { CadDocument } from "../document";
import { CollisionResult } from "../features";
import { KernelInitOptions, Edge3D } from "../occ/kernel";

export class WorkerGeometryBackend implements GeometryBackend {
  private worker: Worker;
  private isReady = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private seq = 1;
  private pending = new Map<number, (r: GeometryResponse) => void>();

  constructor() {
    this.worker = new Worker(new URL("./geometry.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as { kind: "ready" } | GeometryResponse;
      if (msg.kind === "ready") { this.isReady = true; this.readyResolve?.(); return; }
      const resolve = this.pending.get(msg.id);
      if (resolve) { this.pending.delete(msg.id); resolve(msg); }
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

  private send(req: GeometryRequestInit): Promise<GeometryResponse> {
    const id = this.seq++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage({ ...req, id } as GeometryRequest);
    });
  }

  async evaluate(doc: CadDocument): Promise<EvaluateResult> {
    const r = await this.send({ kind: "evaluate", doc });
    if (r.kind === "evaluate") return { solids: r.solids, facePlanes: r.facePlanes };
    throw new Error(r.kind === "error" ? r.message : "evaluate failed");
  }
  async edges(doc: CadDocument, featureId: string): Promise<Edge3D[]> {
    const r = await this.send({ kind: "edges", doc, featureId });
    if (r.kind === "edges") return r.edges;
    throw new Error(r.kind === "error" ? r.message : "edges failed");
  }
  async exportBytes(doc: CadDocument, featureId: string, format: ExportFormat): Promise<Uint8Array | null> {
    const r = await this.send({ kind: "export", doc, featureId, format });
    if (r.kind === "export") return r.bytes;
    throw new Error(r.kind === "error" ? r.message : "export failed");
  }
  async collide(doc: CadDocument, overrides?: Record<string, string>): Promise<CollisionResult> {
    const r = await this.send({ kind: "collide", doc, overrides });
    if (r.kind === "collide") return r.result;
    throw new Error(r.kind === "error" ? r.message : "collide failed");
  }
  dispose(): void { this.worker.terminate(); this.pending.clear(); }
}
