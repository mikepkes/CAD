// The geometry worker pool when a worker dies or goes quiet (src/model/worker-backend.ts): its requests fail
// with a reason instead of hanging, and a fresh worker takes its place.
import { describe, it, expect } from "vitest";
import { WorkerGeometryBackend, geometryWorkerStatus, type WorkerLike } from "../src/model/worker-backend";
import { createDocument } from "../src/core/document";
import { echoSession } from "./helpers";

/** A worker that answers `ready`, then never answers a job (or crashes on it). */
function stuckWorker(mode: "silent" | "crash"): WorkerLike & { killed: boolean } {
  const w: WorkerLike & { killed: boolean } = {
    killed: false, onmessage: null, onerror: null,
    postMessage(msg: unknown) {
      const m = msg as { kind: string };
      if (m.kind === "init") setTimeout(() => w.onmessage?.({ data: { kind: "ready" } }), 0);
      else if (mode === "crash") setTimeout(() => w.onerror?.({ message: "RuntimeError: Aborted(OOM)" }), 0);
    },
    terminate() { w.killed = true; },
  };
  return w;
}

describe("worker pool resilience", () => {
  it("a crashed worker fails its requests with the reason and is replaced", async () => {
    const spawned: ReturnType<typeof stuckWorker>[] = [];
    const b = new WorkerGeometryBackend({ size: 1, spawn: () => { const w = stuckWorker("crash"); spawned.push(w); return w; }, compile: () => Promise.reject(new Error("none")), silenceMs: 0 });
    await b.init({ wasmUrl: "x.wasm" });
    await expect(b.topology(createDocument())).rejects.toThrow(/crashed.*OOM/);
    expect(spawned.length).toBe(2);
    expect(spawned[0].killed).toBe(true);
    expect(geometryWorkerStatus()?.pools.some((p) => p.restarts === 1)).toBe(true);
    b.dispose();
  });

  it("a worker quiet for too long with a request outstanding is restarted and the request fails", async () => {
    const spawned: ReturnType<typeof stuckWorker>[] = [];
    const b = new WorkerGeometryBackend({ size: 1, spawn: () => { const w = stuckWorker("silent"); spawned.push(w); return w; }, compile: () => Promise.reject(new Error("none")), silenceMs: 300 });
    await b.init({ wasmUrl: "x.wasm" });
    const t0 = Date.now();
    const pendingBefore = b.distance(createDocument(), "a", "b").catch((e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 120));
    expect(geometryWorkerStatus()?.pools.flatMap((p) => p.pending.map((q) => q.kind))).toEqual(["distance"]);
    const msg = await pendingBefore;
    expect(msg).toMatch(/did not answer/);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(spawned.length).toBe(2);
    expect(geometryWorkerStatus()?.pools.flatMap((p) => p.pending)).toEqual([]);
    b.dispose();
  });
});

describe("worker pool routing", () => {
  /** A worker that answers every job at once, noting which worker got it. */
  function countingWorker(log: number[], index: number, jobs?: { kind: string; only?: string[] }[]): WorkerLike {
    const w: WorkerLike = {
      onmessage: null, onerror: null,
      postMessage(msg: unknown) {
        const m = msg as { kind: string; id: number; only?: string[] };
        if (m.kind === "init") { setTimeout(() => w.onmessage?.({ data: { kind: "ready" } }), 0); return; }
        log.push(index);
        jobs?.push({ kind: m.kind, only: m.only });
        const res = m.kind === "evaluate" ? { id: m.id, kind: "evaluate", solids: {}, facePlanes: {}, applied: m.only ?? [] } : { id: m.id, kind: "distance", distance: 1 };
        setTimeout(() => w.onmessage?.({ data: res }), 0);
      },
      terminate() {},
    };
    return w;
  }
  it("a job that builds the whole model goes to the worker holding the most of it", async () => {
    const log: number[] = [];
    let n = 0;
    const b = new WorkerGeometryBackend({ size: 2, spawn: () => countingWorker(log, n++), compile: () => Promise.reject(new Error("none")), silenceMs: 0 });
    await b.init({ wasmUrl: "x.wasm" });
    // no chains placed yet: worker 0
    await b.distance(createDocument(), "a", "b");
    expect(log).toEqual([0]);
    // pretend the planner put three chains on worker 1 and one on worker 0
    (b as unknown as { placed: Map<string, number> }).placed = new Map([["c1", 1], ["c2", 1], ["c3", 1], ["c4", 0]]);
    await b.distance(createDocument(), "a", "b");
    expect(log).toEqual([0, 1]);
    b.dispose();
  });

  it("a job about one body goes to the worker whose cache holds that body's chain", async () => {
    const s = echoSession();
    const box = async (x: number) => {
      const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
      await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: x - 5, y: -5 }, opposite: { x: x + 5, y: 5 } });
      return (await s.dispatch("feature.extrude", { sketch: sid, distance: "10" })).createdIds[0];
    };
    const a = await box(0), c = await box(30);
    const log: number[] = [];
    const jobs: { kind: string; only?: string[] }[] = [];
    let n = 0;
    const b = new WorkerGeometryBackend({ size: 2, spawn: () => countingWorker(log, n++, jobs), compile: () => Promise.reject(new Error("none")), silenceMs: 0 });
    await b.init({ wasmUrl: "x.wasm" });
    await b.evaluate(s.doc); // two chains, one per worker
    const placed = (b as unknown as { placed: Map<string, number> }).placed;
    expect(new Set(placed.values())).toEqual(new Set([0, 1]));
    log.length = 0;
    const quiet = (p: Promise<unknown>) => p.catch(() => undefined); // the counting worker answers with the wrong kind
    await quiet(b.exportBytes(s.doc, a, "stl"));
    await quiet(b.exportBytes(s.doc, c, "stl"));
    await quiet(b.topology(s.doc, { bodyId: c }));
    await quiet(b.edges(s.doc, a));
    expect(log).toEqual([placed.get(a), placed.get(c), placed.get(c), placed.get(a)]);
    // and each job is told its body's chain, all the worker needs to build
    expect(jobs.slice(2).map((j) => [j.kind, j.only])).toEqual([["export", [a]], ["export", [c]], ["topology", [c]], ["edges", undefined]]);
    // the whole model: the home worker, whichever that is
    await quiet(b.exportBytes(s.doc, null, "stl"));
    expect(log.length).toBe(5);
    b.dispose();
  });
});
