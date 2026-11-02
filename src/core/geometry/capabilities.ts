// What the host can give the geometry kernel: the facts a backend reads to decide how to
// run — a pool of workers (each with a kernel of its own, building independent chains of
// features at once), or one day a threaded kernel. Pure: reads the environment, decides
// nothing by itself beyond the default pool size, so a test can hand it any host.

export interface GeometryCapabilities {
  /** Web Workers exist (the kernel can run off the main thread). */
  workers: boolean;
  /** Logical cores the host reports. */
  cores: number;
  /** A threaded (pthreads) wasm build could run: SharedArrayBuffer and cross-origin isolation.
   *  Not used yet — measured (scripts/bench/profile.ts with VIBECAD_THREADS=1): OCC's parallel
   *  booleans gain nothing on our models, its parallel meshing ~1.6× on gears. */
  threads: boolean;
  /** The desktop app (Tauri), where memory for several kernels is a safe bet. */
  desktop: boolean;
  /** Geometry workers to run: the chosen pool size (1 = one worker, as before). */
  poolSize: number;
}

/** The most kernels a pool runs: each is a 23 MB wasm instance with a heap of its own. */
export const MAX_POOL = 4;

interface Host {
  Worker?: unknown;
  navigator?: { hardwareConcurrency?: number };
  crossOriginIsolated?: boolean;
  SharedArrayBuffer?: unknown;
  window?: object;
  location?: { search?: string };
  localStorage?: { getItem(k: string): string | null };
}

/** Read the host (the browser, the desktop webview, a test's stand-in). */
export function geometryCapabilities(host: Host = globalThis as unknown as Host): GeometryCapabilities {
  const workers = typeof host.Worker !== "undefined";
  const cores = Math.max(1, host.navigator?.hardwareConcurrency ?? 1);
  const threads = !!host.crossOriginIsolated && typeof host.SharedArrayBuffer !== "undefined";
  const desktop = !!host.window && "__TAURI_INTERNALS__" in host.window;
  return { workers, cores, threads, desktop, poolSize: workers ? poolSizeFor({ cores, desktop }, host) : 1 };
}

/**
 * How many geometry workers to run. An explicit choice wins (`?pool=N` in the URL, or
 * localStorage `vibecad.geometryPool`); the desktop app runs up to MAX_POOL, half its
 * cores; the web app one, as before — a pool works there too (plain workers, no special
 * headers), it is memory that is the unknown on a visitor's machine.
 */
export function poolSizeFor(c: { cores: number; desktop: boolean }, host: Host = globalThis as unknown as Host): number {
  const clamp = (n: number) => Math.max(1, Math.min(MAX_POOL, Math.floor(n)));
  const asked = pickOverride(host);
  if (asked != null) return clamp(asked);
  return c.desktop ? clamp(c.cores / 2) : 1;
}

function pickOverride(host: Host): number | null {
  try {
    const q = host.location?.search ? new URLSearchParams(host.location.search).get("pool") : null;
    const v = q ?? host.localStorage?.getItem("vibecad.geometryPool");
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) && n >= 1 ? n : null;
  } catch { return null; }
}
