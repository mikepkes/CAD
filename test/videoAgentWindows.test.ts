// The demo's "Ask Claude" beat (video/mock/agent-vase.json): the lamp shade's third prompt asks for windows that
// don't overlap, and the cached fix has to deliver that, not just build. Each window is a tunnel through the
// wall, so on the body's (closed, triangulated) surface it adds one handle: an open-top hollow vase is a
// sphere topologically (genus 0), and N separate windows make genus N. Two windows that cross merge into one
// opening and lose a handle, so genus = the number of windows exactly when no two of them touch.
import { expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, itFull } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import type { SolidMesh } from "../src/core/occ/kernel";
import { evaluateFeatures, GeometryCache } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

/** Genus of a closed triangulated surface, from its Euler characteristic (vertices welded at 1 µm). */
function genus(mesh: SolidMesh): number {
  const ids = new Map<string, number>();
  const vid = (i: number) => {
    const k = [0, 1, 2].map((a) => Math.round(mesh.positions[3 * i + a] * 1000)).join(",");
    let v = ids.get(k);
    if (v == null) ids.set(k, (v = ids.size));
    return v;
  };
  const edges = new Set<string>();
  let faces = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => vid(mesh.indices[t + k]));
    if (a === b || b === c || a === c) continue;
    faces++;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) edges.add(p < q ? `${p}-${q}` : `${q}-${p}`);
  }
  return (2 - (ids.size - edges.size + faces)) / 2;
}

/** Windows the cuts make: every circle in the window sketches goes through both walls. */
function windowCount(doc: { sketches: Record<string, { name: string; entities: Record<string, { kind: string }> }> }): number {
  return Object.values(doc.sketches).filter((s) => s.name.startsWith("Windows"))
    .reduce((n, s) => n + 2 * Object.values(s.entities).filter((e) => e.kind === "circle").length, 0);
}

// Builds the loft and shell twice (a few minutes): the extended run, like videoMocks' body check.
itFull("agent-vase.json: the third prompt's windows don't overlap", async () => {
  const cache = JSON.parse(readFileSync(fileURLToPath(new URL("../video/mock/agent-vase.json", import.meta.url)), "utf8"));
  expect(cache.followUps).toHaveLength(2);
  const s = realSession();
  const geo = new GeometryCache();
  const body = () => {
    const rows = Object.values(evaluateFeatures(s.doc, resolveParameters(s.doc.parameters).scope, geo)).filter((r) => r.mesh);
    expect(rows).toHaveLength(1);
    return rows[0].mesh!;
  };
  // Replay prompt by prompt: each user prompt's turns run to its end_turn.
  let ends = 0;
  for (const turn of cache.turns) {
    for (const b of turn.content) {
      if (b.type !== "tool_use") continue;
      const r = await s.dispatch(b.name.replace(/__/g, "."), b.input);
      expect(r.ok, `${b.id}: ${r.error}`).toBe(true);
    }
    if (turn.stop_reason !== "end_turn") continue;
    ends++;
    if (ends === 2) {
      // The lamp shade as the second prompt leaves it: 126 windows, some crossing (the problem the user points out).
      expect(windowCount(s.doc)).toBe(126);
      expect(genus(body())).toBeLessThan(126);
    }
  }
  expect(ends).toBe(3);
  // After the fix: 42 windows, 42 separate openings.
  expect(windowCount(s.doc)).toBe(42);
  expect(genus(body())).toBe(42);
}, 600000);
