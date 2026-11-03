import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, sessionFromDoc } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { GeometryCache, type SolidEval } from "../src/core/features";
import { InlineGeometryBackend, runGeometryJob, type GeometryRequest, type EvaluateResult } from "../src/core/geometry/backend";
import { WorkerGeometryBackend, type WorkerLike } from "../src/model/worker-backend";
import { planEvaluation, mergeParts, hasImplicitTargets } from "../src/core/geometry/pool";
import { resolveParameters } from "../src/core/parameters";
import { deserializeDocument } from "../src/core/persistence";
import type { CadDocument } from "../src/core/document";
import { createDefaultRegistry } from "../src/core/command/builtins";
import { rebuild } from "../src/core/build";

// The worker pool: an evaluation split into independent chains of features, built by
// several workers at once, must give exactly what one worker building the model whole
// gives — the same rows in the same order, the same meshes, the same measurements —
// on a cold build, after a slider change (where the per-worker caches do the work),
// and when a feature fails (where the split falls back to a whole build).
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
const example = (name: string) => { const doc = deserializeDocument(readFileSync(fileURLToPath(new URL(`../public/examples/${name}.json`, import.meta.url)), "utf8")); rebuild(doc, createDefaultRegistry()); return doc; };

/** A stand-in for the geometry Web Worker: the same job handler, a cache of its own, answers
 *  asynchronously; the request is cloned as postMessage would clone it. */
function fakeWorker(): WorkerLike {
  const cache = new GeometryCache({ generations: 6 });
  let latest = 0;
  const w: WorkerLike = {
    onmessage: null,
    terminate() {},
    postMessage(msg) {
      const reply = (data: unknown) => setTimeout(() => w.onmessage?.({ data }), 0);
      const m = msg as { kind: "init" } | GeometryRequest;
      if (m.kind === "init") { void initKernel({ wasmBinary: wasm }).then(() => reply({ kind: "ready" })); return; }
      const req = structuredClone(m);
      if (req.kind === "evaluate") latest = req.id;
      void runGeometryJob(req, cache, (fraction, step) => reply({ id: req.id, kind: "progress", fraction, step }), {
        emit: (r) => reply(r),
        stale: () => req.kind === "evaluate" && latest !== req.id,
      }).then(({ res }) => reply(res));
    },
  };
  return w;
}

const sameRows = (a: Record<string, SolidEval>, b: Record<string, SolidEval>) => {
  expect(Object.keys(a)).toEqual(Object.keys(b)); // the same rows, in the same order
  for (const id of Object.keys(a)) {
    const x = a[id], y = b[id];
    expect(!!x.mesh).toBe(!!y.mesh);
    if (x.mesh && y.mesh) {
      expect(x.mesh.triangleCount).toBe(y.mesh.triangleCount);
      expect(x.mesh.positions).toEqual(y.mesh.positions);
      expect(x.mesh.faceNames).toEqual(y.mesh.faceNames);
    }
    expect(x.error).toBe(y.error);
    expect(x.bounds).toEqual(y.bounds);
    expect(x.volume).toBe(y.volume);
    expect(x.centroid).toEqual(y.centroid);
    expect(x.distance).toBe(y.distance);
  }
};

/** Evaluate the app's way: meshes first, measurements folded in. */
async function evaluateStaged(backend: InlineGeometryBackend | WorkerGeometryBackend, doc: CadDocument): Promise<{ shown: Record<string, SolidEval>; final: Record<string, SolidEval>; progress: number[] }> {
  let shown: EvaluateResult | undefined;
  const progress: number[] = [];
  const measured = await backend.evaluate(doc, (f) => progress.push(f), (r) => { shown = r; });
  expect(shown).toBeDefined();
  expect(measured.complete).toBe(true);
  const final: Record<string, SolidEval> = {};
  for (const [id, row] of Object.entries(shown!.solids)) final[id] = { ...row, ...(measured.solids[id] ?? {}), mesh: row.mesh };
  return { shown: shown!.solids, final, progress };
}

describe("geometry worker pool", () => {
  let inline: InlineGeometryBackend;
  let pool: WorkerGeometryBackend;
  beforeAll(async () => {
    inline = new InlineGeometryBackend();
    await inline.init({ wasmBinary: wasm });
    pool = new WorkerGeometryBackend({ size: 3, spawn: fakeWorker });
    await pool.init({ wasmBinary: wasm });
    expect(pool.ready()).toBe(true);
    expect(pool.size).toBe(3);
  }, 120000);

  it("splits the walker over the pool", () => {
    const doc = example("walker");
    const plan = planEvaluation(doc, resolveParameters(doc.parameters).scope, 3)!;
    expect(plan).not.toBeNull();
    expect(plan.length).toBe(3);
    expect(plan.flatMap((p) => p.only).sort()).toEqual(Object.keys(doc.features).sort());
    for (const p of plan) expect(p.only.length).toBeGreaterThan(20); // 74 chains, spread
    // the same chain always goes to the same worker
    const again = planEvaluation(doc, resolveParameters(doc.parameters).scope, 3)!;
    expect(again).toEqual(plan);
  });

  it("builds the walker as one worker would, cold and after a slider change", async () => {
    const s = sessionFromDoc(example("walker"));
    await s.recompute();
    const a = await evaluateStaged(inline, s.doc);
    const b = await evaluateStaged(pool, s.doc);
    sameRows(a.final, b.final);
    sameRows(a.shown, b.shown);
    expect(Object.keys(b.shown).length).toBe(74); // 74 bodies (the 44 joins write no row of their own)
    expect(b.progress[b.progress.length - 1]).toBeGreaterThan(0.9);
    // a geometry slider: the chains that read it rebuild, the rest replay from each worker's cache
    const r = await s.dispatch("parameter.set", { name: "s", expression: "2.4" });
    expect(r.ok).toBe(true);
    const a2 = await evaluateStaged(inline, s.doc);
    const b2 = await evaluateStaged(pool, s.doc);
    sameRows(a2.final, b2.final);
    // a pose slider: every chain replays
    const r2 = await s.dispatch("parameter.set", { name: "t", expression: "90" });
    expect(r2.ok).toBe(true);
    const a3 = await evaluateStaged(inline, s.doc);
    const b3 = await evaluateStaged(pool, s.doc);
    sameRows(a3.final, b3.final);
  }, 300000);

  it.each(["gyroscope", "roubo", "motor", "clockwork", "starbox"])("builds %s as one worker would", async (name) => {
    const s = sessionFromDoc(example(name));
    await s.recompute();
    const a = await evaluateStaged(inline, s.doc);
    const b = await evaluateStaged(pool, s.doc);
    sameRows(a.final, b.final);
    // and the plain (unstaged) evaluate
    const c = await pool.evaluate(s.doc);
    sameRows(a.final, c.solids);
  }, 300000);

  it("falls back to a whole build when a body fails and a later cut names no body", async () => {
    // body A, body B; a cut with no `body` (so: into the most recent body); then B's sketch is
    // broken so B is never made — whole, the cut goes into A; split naively, it would stand alone
    const s = realSession();
    const mk = async (x: number) => {
      const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
      await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: x - 10, y: -10 }, opposite: { x: x + 10, y: 10 } });
      return (await s.dispatch("feature.extrude", { sketch: sid, distance: "10" })).createdIds[0];
    };
    await mk(0);
    const b = await mk(50);
    const cutSk = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addCircle", { sketch: cutSk, center: { x: 0, y: 0 }, radius: 3 });
    const cut = await s.dispatch("feature.extrude", { sketch: cutSk, distance: "10", operation: "cut" });
    expect(cut.ok).toBe(true);
    const scope = resolveParameters(s.doc.parameters).scope;
    expect(hasImplicitTargets(s.doc, scope)).toBe(true);
    expect(planEvaluation(s.doc, scope, 3)).not.toBeNull();
    // break B: an extrude of nothing (its sketch emptied)
    const fb = s.doc.features[b] as { sketchId: string };
    for (const id of Object.keys(s.doc.sketches[fb.sketchId].entities)) delete s.doc.sketches[fb.sketchId].entities[id];
    const a = await inline.evaluate(s.doc);
    const p = await pool.evaluate(s.doc);
    expect(a.solids[b].error).toBeTruthy();
    sameRows(a.solids, p.solids);
  }, 120000);

  it("merges parts' rows in a whole evaluation's order", () => {
    const doc = { features: { f1: {}, f2: {}, f3: {}, f4: {} } } as unknown as CadDocument;
    const row = (id: string) => ({ featureId: id } as SolidEval);
    const merged = mergeParts(doc, [
      { solids: { f3: row("f3"), f1: row("f1") }, applied: ["f3"] },   // f3 a modifier's row (written early), f1 a body
      { solids: { f4: row("f4"), f2: row("f2") }, applied: ["f4"] },
    ]);
    expect(Object.keys(merged.solids)).toEqual(["f3", "f4", "f1", "f2"]);
  });
});

describe("the pool's kernel", () => {
  /** Workers that only note what they're sent, and answer an init at once. */
  const recording = () => {
    const sent: unknown[] = [];
    const spawn = (): WorkerLike => {
      const w: WorkerLike = { onmessage: null, terminate() {}, postMessage(m) { sent.push(m); setTimeout(() => w.onmessage?.({ data: { kind: "ready" } }), 0); } };
      return w;
    };
    return { sent, spawn };
  };

  it("is compiled once and handed to every worker", async () => {
    const { sent, spawn } = recording();
    const module = { compiled: true } as unknown as WebAssembly.Module;
    const urls: string[] = [];
    const b = new WorkerGeometryBackend({ size: 3, spawn, compile: async (url) => { urls.push(url); return module; } });
    await b.init({ wasmUrl: "/kernel.wasm" });
    expect(b.ready()).toBe(true);
    expect(urls).toEqual(["/kernel.wasm"]);
    expect(sent).toEqual([0, 1, 2].map(() => ({ kind: "init", wasmUrl: "/kernel.wasm", wasmModule: module })));
  });

  it("is loaded by each worker itself when it can't be compiled for them", async () => {
    const { sent, spawn } = recording();
    const b = new WorkerGeometryBackend({ size: 2, spawn, compile: () => Promise.reject(new Error("no streaming compile here")) });
    await b.init({ wasmUrl: "/kernel.wasm" });
    expect(b.ready()).toBe(true);
    expect(sent).toEqual([{ kind: "init", wasmUrl: "/kernel.wasm" }, { kind: "init", wasmUrl: "/kernel.wasm" }]);
  });
});
