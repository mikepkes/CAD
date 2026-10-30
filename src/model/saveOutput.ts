// Where render outputs (PNG stills, MP4 turntables) end up. In the desktop app the
// Rust side writes them into ~/Downloads/Chisel CAD/ — a caller (e.g. an MCP
// client) picks the filename, never the path. In a plain browser the file is
// offered as a download instead.

/** Reduce a caller-supplied name to a plain filename with extension `ext`: drop
 *  any directories, keep a safe character set, fall back to `fallbackStem`. */
export function sanitizeOutputName(name: string | undefined, ext: string, fallbackStem: string): string {
  const leaf = (name ?? "").split(/[\\/]/).pop() ?? "";
  const stem = leaf
    .replace(new RegExp(`\\.${ext}$`, "i"), "")
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 100);
  return `${stem || fallbackStem}.${ext}`;
}

/** A timestamped default stem, e.g. "chisel-turntable-20261029-1452". */
export function timestampedStem(prefix: string, d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Save `bytes` as `filename`; resolves to an absolute path on desktop, or the download name in a browser. */
export async function saveOutput(filename: string, bytes: Uint8Array, mime: string): Promise<string> {
  // Loaded lazily: desktopMcp imports webmcp, which imports this module.
  const { isTauri } = await import("./desktopMcp");
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("save_render", bytes, { headers: { "x-filename": filename } });
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return filename;
}
