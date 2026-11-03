// Where a rebuild's time goes, for one bundled example (headless, in Node, the same code
// the app's main thread and geometry worker run):
//
//   npx vite-node scripts/bench/profile.ts public/examples/walker.json [edits]
//
// A slider change in the app is: clone the document, replay its operation log (rebuild),
// solve every sketch (recompute) — all on the main thread — then evaluate the features
// through the kernel on the worker: the cached steps replay, the rest run OCC, every
// changed body is meshed, and the exact measuring (box, mass properties) follows. This
// prints each of those for the cold open, a geometry slider and a pose (joint drive)
// slider, with the kernel time split by feature kind. One JSON line to stdout.
//
// VIBECAD_THREADS=1 runs the pthreads build of the kernel (replicad_multi.wasm) with OCC's
// parallel booleans and meshing switched on, to see what a threaded kernel would give.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { CadSession } from "../../src/core/command/session";
import { createDefaultRegistry } from "../../src/core/command/builtins";
import { PlaneGCSSolver } from "../../src/core/solver/planegcs";
import { deserializeDocument } from "../../src/core/persistence";
import { rebuild } from "../../src/core/build";
import { recompute } from "../../src/core/recompute";
import { InlineGeometryBackend } from "../../src/core/geometry/backend";
import { GeometryCache, type BuildStep } from "../../src/core/features";
import type { CadDocument } from "../../src/core/document";

const file = process.argv[2];
const edits = Number(process.argv[3] ?? 3);
if (!file) { console.error("usage: vite-node scripts/bench/profile.ts <example.json> [edits]"); process.exit(2); }
const threads = !!process.env.VIBECAD_THREADS;
const wasm = readFileSync(fileURLToPath(new URL(`../../node_modules/replicad-opencascadejs/dist/replicad_${threads ? "multi" : "single"}.wasm`, import.meta.url)));
const ms = (t: number) => Math.round(t * 10) / 10;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const clone = <T>(x: T): T => structuredClone(x);

type Slider = { name: string; values: string[] };
function sweep(p: CadDocument["parameters"][number], n: number): Slider {
  const v = Number(p.value);
  const values: string[] = [];
  for (let i = 0; i < n; i++) {
    const f = 0.15 + (0.7 * i) / Math.max(1, n - 1);
    const next = p.min != null && p.max != null ? p.min + (p.max - p.min) * f : v * (1.1 + 0.1 * i) + 0.5 * (i + 1);
    values.push(String(Math.round(next * 1000) / 1000));
  }
  return { name: p.name, values: values.filter((x) => Number(x) !== v) };
}
function slidersOf(doc: CadDocument, n: number): { geom: Slider | null; pose: Slider | null } {
  const geomText = JSON.stringify([doc.features, doc.sketches, doc.planes]);
  const jointText = JSON.stringify([doc.joints, doc.jointTemplates ?? {}]);
  const reads = (text: string, p: { name: string }) => new RegExp(`\\b${p.name}\\b`).test(text);
  const bounded = (p: { min?: number; max?: number }) => p.min != null && p.max != null;
  const pick = (ps: CadDocument["parameters"]) => ps.find(bounded) ?? ps[0];
  const g = pick(doc.parameters.filter((p) => reads(geomText, p) && !reads(jointText, p))) ?? pick(doc.parameters.filter((p) => reads(geomText, p)));
  const j = pick(doc.parameters.filter((p) => reads(jointText, p) && !reads(geomText, p))) ?? pick(doc.parameters.filter((p) => reads(jointText, p)));
  return { geom: g ? sweep(g, n) : null, pose: j ? sweep(j, n) : null };
}

/** An evaluation's phases, timed through the build-progress sink: the kernel time of each
 *  feature (by kind), the meshing, then the measuring. */
async function timedEvaluate(backend: InlineGeometryBackend, doc: CadDocument) {
  const kinds: Record<string, number> = {};
  const each: Record<string, number> = {};
  const meshed: number[] = []; // per body, in the order they are meshed (their rows' order)
  const features = Object.values(doc.features);
  let last = performance.now(), lastStep: BuildStep | undefined;
  let featuresMs = 0, meshingMs = 0;
  const t0 = performance.now();
  let meshesAt = 0;
  const sink = (_f: number, step?: BuildStep) => {
    const now = performance.now();
    if (lastStep?.phase === "features") {
      const f = features.filter((x) => !x.configSuppressed)[lastStep.done];
      const k = f?.kind ?? "?";
      kinds[k] = (kinds[k] ?? 0) + (now - last);
      if (f) each[`${f.kind} ${f.name}`] = (each[`${f.kind} ${f.name}`] ?? 0) + (now - last);
      featuresMs += now - last;
    } else if (lastStep?.phase === "meshing") { meshingMs += now - last; meshed[lastStep.done] = (meshed[lastStep.done] ?? 0) + now - last; }
    last = now; lastStep = step;
  };
  const cache = (backend as unknown as { cache: GeometryCache }).cache;
  const h0 = cache.hits, m0 = cache.misses;
  const r = await backend.evaluate(doc, sink, (shown) => {
    const now = performance.now();
    if (lastStep?.phase === "meshing") { meshingMs += now - last; meshed[lastStep.done] = (meshed[lastStep.done] ?? 0) + now - last; }
    meshesAt = now - t0; lastStep = undefined;
    Object.values(shown.solids).filter((x) => x.mesh).forEach((x, i) => { if (meshed[i]) each[`mesh ${x.name}`] = meshed[i]; });
  });
  const total = performance.now() - t0;
  const errors = Object.values(r.solids).filter((x) => x.error).map((x) => `${x.name}: ${x.error}`);
  return { meshesMs: ms(meshesAt), measureMs: ms(total - meshesAt), featuresMs: ms(featuresMs), meshingMs: ms(meshingMs), hits: cache.hits - h0, misses: cache.misses - m0, kinds: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, ms(v)])), slowest: slowest(each), errors };
}

/** The features that took longest (over 50 ms), slowest first. */
const slowest = (each: Record<string, number>) => Object.fromEntries(Object.entries(each).filter(([, v]) => v > 50).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => [k, ms(v)]));

async function main() {
  const text = readFileSync(file, "utf8");
  const backend = new InlineGeometryBackend();
  let t = performance.now();
  let module: unknown;
  if (threads) {
    const factory = (await import("replicad-opencascadejs/multi")).default as unknown as (o: unknown) => Promise<unknown>;
    module = await factory({ print: () => {}, printErr: () => {}, wasmBinary: wasm });
    const m = module as { BOPAlgo_Options: { SetParallelMode: (b: boolean) => void }; BRepMesh_IncrementalMesh: { SetParallelDefault: (b: boolean) => void } };
    m.BOPAlgo_Options.SetParallelMode(true);
    m.BRepMesh_IncrementalMesh.SetParallelDefault(true);
  }
  await backend.init(module ? { module } : { wasmBinary: wasm });
  const kernelMs = ms(performance.now() - t);
  const solver = new PlaneGCSSolver();
  const registry = createDefaultRegistry();
  const s = new CadSession(deserializeDocument(text), registry, solver);
  await solver.ready();

  // the cold open: replay the log, solve, build
  t = performance.now();
  rebuild(s.doc, registry);
  const rebuildMs = ms(performance.now() - t);
  t = performance.now();
  await recompute(s.doc, solver);
  const recomputeMs = ms(performance.now() - t);
  const sketches = Object.keys(s.doc.sketches).length;
  const cold = await timedEvaluate(backend, s.doc);

  // a slider change, as the app does it (store.setParameterExpr → session.editOperation):
  // clone, replay, solve on the main thread; then evaluate on the worker
  const edit = async (slider: Slider | null) => {
    if (!slider) return null;
    const op = s.doc.operations.find((o) => o.type === "parameter.add" && o.params.name === slider.name);
    const original = op ? (op.params.expression as string) : s.doc.parameters.find((p) => p.name === slider.name)!.expr;
    const rows: { cloneMs: number; rebuildMs: number; recomputeMs: number; ev: Awaited<ReturnType<typeof timedEvaluate>> }[] = [];
    for (const expr of [...slider.values, original]) {
      t = performance.now();
      const draft = clone(s.doc);
      const cloneMs = performance.now() - t;
      const o = draft.operations.find((x) => x.opId === op?.opId);
      if (o) o.params = { ...o.params, expression: expr };
      else { const p = draft.parameters.find((x) => x.name === slider.name)!; p.expr = expr; }
      t = performance.now();
      rebuild(draft, registry);
      const rebuildMs = performance.now() - t;
      t = performance.now();
      await recompute(draft, solver);
      const recomputeMs = performance.now() - t;
      (s as unknown as { doc: CadDocument }).doc = draft;
      const ev = await timedEvaluate(backend, draft);
      if (expr !== original) rows.push({ cloneMs, rebuildMs, recomputeMs, ev });
    }
    const med = (f: (r: typeof rows[number]) => number) => ms(median(rows.map(f))!);
    const kinds: Record<string, number> = {};
    for (const r of rows) for (const [k, v] of Object.entries(r.ev.kinds)) kinds[k] = (kinds[k] ?? 0) + v / rows.length;
    return {
      slider: slider.name, cloneMs: med((r) => r.cloneMs), rebuildMs: med((r) => r.rebuildMs), recomputeMs: med((r) => r.recomputeMs),
      meshesMs: med((r) => r.ev.meshesMs), measureMs: med((r) => r.ev.measureMs), featuresMs: med((r) => r.ev.featuresMs), meshingMs: med((r) => r.ev.meshingMs),
      hits: med((r) => r.ev.hits), misses: med((r) => r.ev.misses), kinds: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, ms(v)])),
      totalMs: med((r) => r.cloneMs + r.rebuildMs + r.recomputeMs + r.ev.meshesMs),
    };
  };
  const sliders = slidersOf(s.doc, edits);
  const geom = await edit(sliders.geom);
  const pose = await edit(sliders.pose);
  console.log(JSON.stringify({
    example: file.replace(/^.*\//, "").replace(/\.json$/, ""), kernelMs, operations: s.doc.operations.length, sketches, features: Object.keys(s.doc.features).length,
    cold: { rebuildMs, recomputeMs, ...cold }, geom, pose,
  }));
}
main().catch((e) => { console.error(e); process.exit(1); });
