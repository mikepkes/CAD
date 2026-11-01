/// <reference lib="webworker" />
// Web Worker that owns an OCC kernel and runs geometry jobs off the main thread.
// It is a thin adapter: all the real work is the shared, env-agnostic
// runGeometryJob. Meshes are posted back with their buffers in the transfer
// list, so they move to the main thread zero-copy.

import { runGeometryJob, GeometryRequest } from "../core/geometry/backend";
import { GeometryCache } from "../core/features";
import { initKernel } from "../core/occ/kernel";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let initPromise: Promise<void> | null = null;
// Persists across messages so evaluations are incremental (see GeometryCache).
// Keeps a few recent evaluations, so flipping between configurations (or undoing) replays from cache.
const cache = new GeometryCache({ generations: 6 });
// The newest evaluation asked for: an older one still measuring its bodies stops when it hears of it
// (its meshes went out already; the measurements would be of a superseded model).
let latestEvaluate = 0;

ctx.onmessage = async (e: MessageEvent) => {
  const msg = e.data as { kind: "init"; wasmUrl?: string } | GeometryRequest;
  if (msg.kind === "init") {
    initPromise ??= initKernel({ wasmUrl: msg.wasmUrl });
    await initPromise;
    ctx.postMessage({ kind: "ready" });
    return;
  }
  if (msg.kind === "evaluate") latestEvaluate = msg.id;
  if (initPromise) await initPromise;
  // progress, at most every 50 ms, so a long build can show how far it has got
  let last = 0;
  const progress = (fraction: number) => { const t = performance.now(); if (t - last > 50) { last = t; ctx.postMessage({ id: msg.id, kind: "progress", fraction }); } };
  const { res, transfer } = await runGeometryJob(msg, cache, progress, {
    emit: (r, buffers) => ctx.postMessage(r, buffers),
    stale: () => msg.kind === "evaluate" && latestEvaluate !== msg.id,
  });
  ctx.postMessage(res, transfer);
};
