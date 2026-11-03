// Browser geometry backend: runs the kernel in Web Workers (see geometry.worker.ts) so
// B-rep evaluation never blocks the main thread. A pool of `size` workers, each with a
// kernel and an incremental cache of its own: an evaluation is split into independent
// chains of features (core/geometry/chains.ts) that build in parallel, the heaviest spread
// over the pool first and every chain kept on its worker so its cache keeps hitting; every
// other job, and a model that can't be split, goes to worker 0 whole, as with a single
// worker. Pool size 1 is exactly the single-worker backend of before.
//
// This module references `new Worker(new URL(...))`, which only resolves in a
// bundler/browser realm — it is imported solely from the browser store, never
// from Node tests (those hand it stand-in workers through `spawn`).

import { GeometryBackend, GeometryRequest, GeometryRequestInit, GeometryResponse, ExportFormat, EvaluateResult, TopologyOpts } from "../core/geometry/backend";
import { planEvaluation, mergeParts, needsWholeRebuild, type EvaluationPart, type PartResult } from "../core/geometry/pool";
import { CadDocument } from "../core/document";
import { resolveParameters } from "../core/parameters";
import { CollisionResult, BodyTopology, BodyAnalysisResult, type BuildProgressSink, type BuildStep } from "../core/features";
import { KernelInitOptions, Edge3D } from "../core/occ/kernel";
import type { ShopDrawing, SheetOptions } from "../core/drawings";

/** What the backend needs of a worker (a Web Worker; a test's stand-in). */
export interface WorkerLike {
  postMessage(msg: unknown, transfer?: ArrayBuffer[]): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  terminate(): void;
}

export interface WorkerBackendOptions {
  /** Workers in the pool (default 1). */
  size?: number;
  /** Makes a worker (default: the geometry Web Worker). */
  spawn?: () => WorkerLike;
  /** Compiles the kernel's wasm once for every worker (default: compileKernel). */
  compile?: (wasmUrl: string) => Promise<WebAssembly.Module>;
}

const spawnWebWorker = (): WorkerLike => new Worker(new URL("./geometry.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;

const compiled = new Map<string, Promise<WebAssembly.Module>>();
/**
 * The kernel's wasm, compiled once per page (off the main thread, as it streams in) and
 * shared: every worker of a pool — and the motion study's — instantiates the same module
 * instead of fetching and compiling 23 MB of it again, and the engine's optimised code for
 * it is shared too, so a worker that starts a chain late doesn't run it unoptimised.
 */
export function compileKernel(wasmUrl: string): Promise<WebAssembly.Module> {
  let p = compiled.get(wasmUrl);
  if (!p) {
    p = WebAssembly.compileStreaming(fetch(wasmUrl))
      .catch(() => fetch(wasmUrl).then((r) => r.arrayBuffer()).then((b) => WebAssembly.compile(b))); // served without the wasm MIME type
    compiled.set(wasmUrl, p);
    p.catch(() => compiled.delete(wasmUrl));
  }
  return p;
}

export class WorkerGeometryBackend implements GeometryBackend {
  private workers: WorkerLike[];
  private isReady = false;
  private readyPromise: Promise<void> | null = null;
  private seq = 1;
  /** Per request: handles an answer, returning true once the request is done. */
  private pending = new Map<number, (r: GeometryResponse) => boolean>();
  private progress = new Map<number, BuildProgressSink>();
  private readyResolvers: (() => void)[] = [];
  /** Which worker each chain of features was given (see planEvaluation): it stays there, where its cache is. */
  private placed = new Map<string, number>();

  private compile: (wasmUrl: string) => Promise<WebAssembly.Module>;

  constructor(opts: WorkerBackendOptions = {}) {
    const spawn = opts.spawn ?? spawnWebWorker;
    this.compile = opts.compile ?? compileKernel;
    this.workers = Array.from({ length: Math.max(1, opts.size ?? 1) }, () => spawn());
    for (const w of this.workers) {
      w.onmessage = (e) => {
        const msg = e.data as { kind: "ready" } | GeometryResponse;
        if (msg.kind === "ready") { this.readyResolvers.shift()?.(); return; }
        if (msg.kind === "progress") { this.progress.get(msg.id)?.(msg.fraction, msg.step); return; }
        // a request's handler hears every answer to it and says when it is done (a staged evaluate has two)
        const handle = this.pending.get(msg.id);
        if (handle && handle(msg)) { this.pending.delete(msg.id); this.progress.delete(msg.id); }
      };
    }
  }

  /** Workers in the pool. */
  get size(): number { return this.workers.length; }

  init(opts: KernelInitOptions): Promise<void> {
    if (!this.readyPromise) {
      // the wasm compiled once and handed to every worker (each loads it itself if that fails);
      // ready when the last worker's kernel is
      const shared = opts.wasmUrl ? this.compile(opts.wasmUrl).catch(() => undefined) : Promise.resolve(undefined);
      this.readyPromise = shared.then((wasmModule) => Promise.all(this.workers.map((w) => new Promise<void>((res) => {
        this.readyResolvers.push(res);
        w.postMessage({ kind: "init", wasmUrl: opts.wasmUrl, ...(wasmModule ? { wasmModule } : {}) });
      })))).then(() => { this.isReady = true; });
    }
    return this.readyPromise;
  }
  ready(): boolean { return this.isReady; }

  private send(req: GeometryRequestInit, onProgress?: BuildProgressSink, onEarly?: (r: GeometryResponse) => void, worker = 0): Promise<GeometryResponse> {
    const id = this.seq++;
    if (onProgress) this.progress.set(id, onProgress);
    return new Promise((resolve) => {
      this.pending.set(id, (r) => {
        // a staged evaluate's first answer (its meshes) comes early; its last one settles the request
        if (onEarly && r.kind === "evaluate") { onEarly(r); return false; }
        resolve(r);
        return true;
      });
      this.workers[worker].postMessage({ ...req, id } as GeometryRequest);
    });
  }

  async evaluate(doc: CadDocument, onProgress?: BuildProgressSink, onMeshes?: (r: EvaluateResult) => void): Promise<EvaluateResult> {
    const scope = resolveParameters(doc.parameters).scope;
    const plan = planEvaluation(doc, scope, this.workers.length, this.placed);
    if (plan) {
      const r = await this.evaluateParts(doc, plan, onProgress, onMeshes);
      // a split that can't be trusted (a body failed to be made; see needsWholeRebuild) is built whole
      if (!needsWholeRebuild(doc, scope, r.solids)) return r;
    }
    return this.evaluateWhole(doc, onProgress, onMeshes);
  }

  private async evaluateWhole(doc: CadDocument, onProgress?: BuildProgressSink, onMeshes?: (r: EvaluateResult) => void): Promise<EvaluateResult> {
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

  /** The split evaluation: every part on its worker, the answers merged (the meshes once every part
   *  has its meshes, the measurements once every part has measured). */
  private async evaluateParts(doc: CadDocument, parts: EvaluationPart[], onProgress?: BuildProgressSink, onMeshes?: (r: EvaluateResult) => void): Promise<EvaluateResult> {
    const progress = onProgress ? poolProgress(parts, onProgress) : undefined;
    const staged = !!onMeshes;
    let shown = 0;
    const early: PartResult[] = new Array(parts.length);
    const answers = parts.map((p, i) => this.send({ kind: "evaluate", doc, staged, only: p.only }, progress?.(i), staged ? (r) => {
      if (r.kind !== "evaluate") return;
      early[i] = { solids: r.solids, facePlanes: r.facePlanes, applied: r.applied };
      if (++shown === parts.length) onMeshes!(mergeParts(doc, early));
    } : undefined, p.worker));
    const results = await Promise.all(answers);
    const failed = results.find((r) => r.kind === "error");
    if (failed) throw new Error(failed.kind === "error" ? failed.message : "evaluate failed");
    if (!staged) {
      const merged = mergeParts(doc, results.map((r) => (r.kind === "evaluate" ? { solids: r.solids, facePlanes: r.facePlanes, applied: r.applied } : { solids: {} })));
      return { ...merged, complete: true };
    }
    const measured = results.map((r) => (r.kind === "measured" ? r : null));
    if (measured.some((r) => !r)) throw new Error("evaluate failed");
    // the measured rows: in the same order as the shown ones (the parts' rows, written early or not)
    const merged = mergeParts(doc, measured.map((r, i) => ({ solids: r!.solids, applied: early[i]?.applied })));
    return { solids: merged.solids, facePlanes: {}, complete: measured.every((r) => r!.complete) };
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
  async drawing(doc: CadDocument, opts?: SheetOptions): Promise<ShopDrawing> {
    const r = await this.send({ kind: "drawing", doc, opts });
    if (r.kind === "drawing") return { svg: r.svg, parts: r.parts, sheet: r.sheet };
    throw new Error(r.kind === "error" ? r.message : "drawing failed");
  }
  async distance(doc: CadDocument, a: string, b: string): Promise<number> {
    const r = await this.send({ kind: "distance", doc, a, b });
    if (r.kind === "distance") return r.distance;
    throw new Error(r.kind === "error" ? r.message : "distance failed");
  }
  dispose(): void { for (const w of this.workers) w.terminate(); this.pending.clear(); }
}

/** One progress sink per part, reporting the pool's progress as a whole: the parts' fractions
 *  weighted by their feature counts, and their steps' counts added up. */
function poolProgress(parts: EvaluationPart[], sink: BuildProgressSink): (i: number) => BuildProgressSink {
  const weights = parts.map((p) => p.only.length);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const fractions = parts.map(() => 0);
  const steps: (BuildStep | undefined)[] = parts.map(() => undefined);
  return (i) => (fraction, step) => {
    fractions[i] = fraction;
    steps[i] = step;
    const f = fractions.reduce((a, x, k) => a + x * weights[k], 0) / total;
    const known = steps.filter((s): s is BuildStep => !!s);
    // the phase the pool is in: the one some part is still in first (features before meshing)
    const phase = known.some((s) => s.phase === "features") ? "features" : "meshing";
    const inPhase = known.filter((s) => s.phase === phase);
    sink(f, inPhase.length ? { phase, done: inPhase.reduce((a, s) => a + s.done, 0), total: inPhase.reduce((a, s) => a + s.total, 0) } : undefined);
  };
}
