// Content keys for the evaluation cache: a canonical JSON encoding (object keys
// sorted, so two equal values always encode the same) and a 106-bit string hash
// of it. Pure and dependency-free.

/** Canonical JSON: sorted object keys, `undefined` fields dropped, -0 → 0. */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number") return Number.isFinite(v) ? String(v === 0 ? 0 : v) : JSON.stringify(String(v));
    return v === undefined ? "null" : JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
}

/** cyrb53 (a fast, well-mixed 53-bit string hash). */
function cyrb53(s: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** A collision-resistant-enough key for cache lookups (two independent 53-bit hashes). */
export function contentHash(s: string): string {
  return cyrb53(s, 1).toString(36) + "." + cyrb53(s, 0x9e3779b9).toString(36);
}
