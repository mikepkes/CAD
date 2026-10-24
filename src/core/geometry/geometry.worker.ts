/// <reference lib="webworker" />
// Web Worker that owns an OCC kernel and runs geometry jobs off the main thread.
// It is a thin adapter: all the real work is the shared, env-agnostic
// runGeometryJob. Meshes are posted back with their buffers in the transfer
// list, so they move to the main thread zero-copy.

import { runGeometryJob, GeometryRequest } from "./backend";
import { GeometryCache } from "../features";
import { initKernel } from "../occ/kernel";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let initPromise: Promise<void> | null = null;
// Persists across messages so evaluations are incremental (see GeometryCache).
const cache = new GeometryCache();

ctx.onmessage = async (e: MessageEvent) => {
  const msg = e.data as { kind: "init"; wasmUrl?: string } | GeometryRequest;
  if (msg.kind === "init") {
    initPromise ??= initKernel({ wasmUrl: msg.wasmUrl });
    await initPromise;
    ctx.postMessage({ kind: "ready" });
    return;
  }
  if (initPromise) await initPromise;
  const { res, transfer } = await runGeometryJob(msg, cache);
  ctx.postMessage(res, transfer);
};
