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
/** What the desktop app runs unasked. Measured (scripts/bench/app.mjs): on WebKitGTK two workers
 *  take all the gain, four cost more at the cold open than they give; four is there to ask for (?pool=4). */
export const DESKTOP_POOL = 2;
/** What the web app runs unasked, on a machine with the cores and memory for it. Measured in
 *  Chromium (scripts/bench/app.mjs, 12 cores): four workers go on helping — the clockwork opens in
 *  5.5 s with four, 7.0 s with two, 10.8 s with one — for ~400 MB more at the peak. */
export const WEB_POOL = 4;

interface Host {
  Worker?: unknown;
  /** deviceMemory: GB, rounded down to a power of two (Chromium only); userAgentData.mobile likewise. */
  navigator?: { hardwareConcurrency?: number; deviceMemory?: number; userAgent?: string; userAgentData?: { mobile?: boolean } };
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
  const memoryGB = host.navigator?.deviceMemory;
  const mobile = host.navigator?.userAgentData?.mobile ?? /Mobi|Android|iPhone|iPad/.test(host.navigator?.userAgent ?? "");
  return { workers, cores, threads, desktop, poolSize: workers ? poolSizeFor({ cores, desktop, memoryGB, mobile }, host) : 1 };
}

/**
 * How many geometry workers to run. An explicit choice wins (`?pool=N` in the URL, or
 * localStorage `vibecad.geometryPool`); else no more than half the cores: the desktop app
 * DESKTOP_POOL, the web app WEB_POOL — a pool needs nothing of the page but plain module
 * workers, it is memory that is the unknown on a visitor's machine, so a browser that says
 * it has little (deviceMemory under 8 GB: two; under 4 GB: one) or a phone or tablet (two)
 * gets fewer. Each worker is a 23 MB kernel with a heap of its own (a gear train's grows to
 * a few hundred MB).
 */
export function poolSizeFor(c: { cores: number; desktop: boolean; memoryGB?: number; mobile?: boolean }, host: Host = globalThis as unknown as Host): number {
  const clamp = (n: number) => Math.max(1, Math.min(MAX_POOL, Math.floor(n)));
  const asked = pickOverride(host);
  if (asked != null) return clamp(asked);
  if (c.desktop) return clamp(Math.min(DESKTOP_POOL, c.cores / 2));
  const memory = c.memoryGB == null ? WEB_POOL : c.memoryGB < 4 ? 1 : c.memoryGB < 8 ? 2 : WEB_POOL;
  return clamp(Math.min(memory, c.mobile ? 2 : WEB_POOL, c.cores / 2));
}

function pickOverride(host: Host): number | null {
  try {
    const q = host.location?.search ? new URLSearchParams(host.location.search).get("pool") : null;
    const v = q ?? host.localStorage?.getItem("vibecad.geometryPool");
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) && n >= 1 ? n : null;
  } catch { return null; }
}
