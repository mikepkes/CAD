// Samples the design space: for each grid cell, a variant of the document with
// the two axis parameters set to the cell's values is evaluated on a geometry
// backend of its own (so the live viewport's backend stays free), and the
// variant's metrics are kept. Progressive (coarse-to-fine, one cell at a time),
// cancellable, and cached per (axes, N, recipe). Pure apart from the backend:
// tested with a fake backend in test/space.test.ts.

import type { CadDocument } from "../../../core/document";
import type { GeometryBackend } from "../../../core/geometry/backend";
import { metricsOf } from "../../../model/concepts/intents";
import { cellOrder, axisValue, type CellSample, type GridSpec } from "./space";

export interface SampleOpts {
  /** Called after each cell, with that cell. */
  onCell?: (cell: CellSample, done: number, total: number) => void;
  cancelled?: () => boolean;
  /** Cells already known (from the cache): skipped, but still counted in the total. */
  skip?: (i: number, j: number) => boolean;
}

/** The variant document for one cell (or a pin): a structured clone with the two axis parameters' expressions replaced. */
export function variantDoc(doc: CadDocument, spec: { x: { name: string }; y: { name: string } }, x: number, y: number): CadDocument {
  const d = structuredClone(doc);
  for (const p of d.parameters) {
    if (p.name === spec.x.name) { p.expr = String(x); p.value = x; delete p.baseExpr; delete p.configuredBy; }
    else if (p.name === spec.y.name) { p.expr = String(y); p.value = y; delete p.baseExpr; delete p.configuredBy; }
  }
  return d;
}

/** Evaluate one variant into its metrics (density 1: the caller re-expresses mass at the document's density). */
export async function sampleCell(backend: GeometryBackend, doc: CadDocument, spec: GridSpec, i: number, j: number): Promise<CellSample> {
  const x = axisValue(spec.x, i, spec.n), y = axisValue(spec.y, j, spec.n);
  try {
    const { solids } = await backend.evaluate(variantDoc(doc, spec, x, y));
    const failed = Object.values(solids).find((s) => s.error && !s.mesh);
    const metrics = metricsOf(solids, 1);
    if (metrics.bodies === 0) return { i, j, x, y, metrics: null, error: failed?.error ?? "no bodies" };
    return { i, j, x, y, metrics, error: failed?.error };
  } catch (e) {
    return { i, j, x, y, metrics: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Sample the whole grid in coarse-to-fine order. Returns null when cancelled; otherwise every cell. */
export async function sampleGrid(backend: GeometryBackend, doc: CadDocument, spec: GridSpec, opts: SampleOpts = {}): Promise<CellSample[] | null> {
  const order = cellOrder(spec.n);
  const out: CellSample[] = [];
  let done = 0;
  for (const [i, j] of order) {
    if (opts.cancelled?.()) return null;
    if (opts.skip?.(i, j)) { done++; continue; }
    const cell = await sampleCell(backend, doc, spec, i, j);
    if (opts.cancelled?.()) return null;
    out.push(cell);
    done++;
    opts.onCell?.(cell, done, order.length);
  }
  return out;
}

/** A cache of sampled grids by key (see space.ts gridKey), bounded so old recipes fall out. */
export class GridCache {
  private map = new Map<string, Map<number, CellSample>>();
  constructor(private limit = 12) {}
  get(key: string): Map<number, CellSample> | undefined {
    const v = this.map.get(key);
    if (v) { this.map.delete(key); this.map.set(key, v); } // refresh LRU order
    return v;
  }
  open(key: string): Map<number, CellSample> {
    let v = this.get(key);
    if (!v) {
      v = new Map();
      this.map.set(key, v);
      while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as string);
    }
    return v;
  }
  clear(): void { this.map.clear(); }
}

/**
 * The sampler's own geometry backend, created the way the store creates its
 * live one (a Worker when the browser has them, inline otherwise) and
 * initialised with the same kernel wasm. Loaded lazily so tests and the empty
 * state never touch the worker module or the wasm URL.
 */
export async function createSamplerBackend(): Promise<GeometryBackend> {
  const [{ default: occWasmUrl }, backendMod] = await Promise.all([
    import("replicad-opencascadejs/wasm?url"),
    import("../../../core/geometry/backend"),
  ]);
  let backend: GeometryBackend | null = null;
  if (typeof Worker !== "undefined") {
    try {
      const { WorkerGeometryBackend } = await import("../../../model/worker-backend");
      backend = new WorkerGeometryBackend();
    } catch { backend = null; }
  }
  if (!backend) backend = new backendMod.InlineGeometryBackend();
  await backend.init({ wasmUrl: occWasmUrl });
  return backend;
}

// ---- the one sampler backend ----
// A Worker plus a full kernel boot is too dear to pay on every tab switch, so
// the backend outlives the panel: created on first use, dropped on a failed
// start (so the next run retries) and disposed only by `disposeSamplerBackend`
// (the panel is toggled off, or tests reset).

let samplerBackend: Promise<GeometryBackend> | null = null;

/** The shared backend, creating it with `create` when there is none yet. A rejected start is forgotten. */
export function getSamplerBackend(create: () => Promise<GeometryBackend> = createSamplerBackend): Promise<GeometryBackend> {
  if (!samplerBackend) {
    const p = create();
    samplerBackend = p;
    p.catch(() => { if (samplerBackend === p) samplerBackend = null; });
  }
  return samplerBackend;
}

export function disposeSamplerBackend(): void {
  const p = samplerBackend;
  samplerBackend = null;
  void p?.then((b) => b.dispose()).catch(() => {});
}
