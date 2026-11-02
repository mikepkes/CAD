// Headless rebuild benchmark for one bundled example (run by scripts/bench/run.mjs,
// one process per example so every example gets a fresh kernel and its numbers
// don't depend on what ran before it). Same path as the app's worker: the
// InlineGeometryBackend with its persistent GeometryCache.
//
//   npx vite-node scripts/bench/rebuild.ts public/examples/gimbal.json [repeats]
//
// Prints one JSON line: { example, kernelMs, recomputeMs, coldMs, warmMs, editMs,
// editRecomputeMs, bodies, triangles, meshBytes, docBytes, hits, misses }.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { CadSession } from "../../src/core/command/session";
import { createDefaultRegistry } from "../../src/core/command/builtins";
import { PlaneGCSSolver } from "../../src/core/solver/planegcs";
import { deserializeDocument } from "../../src/core/persistence";
import { InlineGeometryBackend } from "../../src/core/geometry/backend";
import type { SolidEval } from "../../src/core/features";
import type { CadDocument } from "../../src/core/document";

const file = process.argv[2];
const repeats = Number(process.argv[3] ?? 3);
if (!file) { console.error("usage: vite-node scripts/bench/rebuild.ts <example.json> [repeats]"); process.exit(2); }

const wasm = readFileSync(fileURLToPath(new URL("../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const ms = (t: number) => Math.round(t * 10) / 10;

function meshStats(solids: Record<string, SolidEval>) {
  let bodies = 0, triangles = 0, bytes = 0;
  for (const s of Object.values(solids)) {
    if (!s.mesh) continue;
    bodies++; triangles += s.mesh.triangleCount;
    bytes += s.mesh.positions.byteLength + s.mesh.normals.byteLength + s.mesh.indices.byteLength + s.mesh.edges.byteLength;
  }
  return { bodies, triangles, meshBytes: bytes };
}

type Slider = { name: string; values: string[] };

/** `n` distinct values for a parameter, none its current one: spread over its range
 *  when bounded, else steps of +10% (a slider drag produces a fresh value every tick,
 *  so no two edits may hit the cache the way toggling between two values would). */
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

/** The sliders to sweep: one that changes geometry (read by a sketch or a feature; one no
 *  joint reads, when there is one) and one that only poses it (a joint drive). Bounded ones first. */
function slidersOf(doc: CadDocument, n: number): { geom: Slider | null; pose: Slider | null } {
  const geomText = JSON.stringify([doc.features, doc.sketches, doc.planes]);
  const jointText = JSON.stringify([doc.joints, doc.jointTemplates ?? {}]);
  const reads = (text: string, p: { name: string }) => new RegExp(`\\b${p.name}\\b`).test(text);
  const bounded = (p: { min?: number; max?: number }) => p.min != null && p.max != null;
  const geomOnly = doc.parameters.filter((p) => reads(geomText, p) && !reads(jointText, p));
  const geomAny = doc.parameters.filter((p) => reads(geomText, p));
  const poseOnly = doc.parameters.filter((p) => reads(jointText, p) && !reads(geomText, p));
  const poseAny = doc.parameters.filter((p) => reads(jointText, p));
  const pick = (ps: typeof doc.parameters) => ps.find(bounded) ?? ps[0];
  const g = pick(geomOnly) ?? pick(geomAny), j = pick(poseOnly) ?? pick(poseAny);
  return { geom: g ? sweep(g, n) : null, pose: j ? sweep(j, n) : null };
}

async function main() {
  const text = readFileSync(file, "utf8");
  const backend = new InlineGeometryBackend();
  let t = performance.now();
  await backend.init({ wasmBinary: wasm });
  const kernelMs = performance.now() - t;

  // (not test/helpers: it imports vitest, which refuses to load outside a vitest run)
  const s = new CadSession(deserializeDocument(text), createDefaultRegistry(), new PlaneGCSSolver());
  t = performance.now();
  await s.recompute();
  const recomputeMs = performance.now() - t;
  const docBytes = JSON.stringify(s.doc).length;

  // the app's path: the meshes land first (what the person sees), the exact measuring follows
  t = performance.now();
  let meshesMs = 0, shown: Record<string, SolidEval> = {};
  const first = await backend.evaluate(s.doc, undefined, (r) => { meshesMs = performance.now() - t; shown = r.solids; });
  const coldMs = performance.now() - t;
  const stats = meshStats(Object.keys(shown).length ? shown : first.solids); // (a backend without staging answers once)
  const errors = Object.values(first.solids).filter((r) => r.error).map((r) => `${r.name}: ${r.error}`);

  const warm: number[] = [];
  for (let i = 0; i < repeats; i++) { t = performance.now(); await backend.evaluate(s.doc); warm.push(performance.now() - t); }

  // Slider edits, the way the parameters panel does them: set the expression, recompute, rebuild.
  // Every edit is to a value not seen before (as in a drag), then the original is restored (untimed).
  const sliders = slidersOf(s.doc, repeats);
  const measure = async (slider: Slider | null) => {
    if (!slider) return { edit: null, shown: null, recompute: null, name: null };
    const original = s.doc.parameters.find((p) => p.name === slider.name)!.expr;
    const edit: number[] = [], shownAt: number[] = [], editRecompute: number[] = [];
    for (const expr of [...slider.values, original]) {
      t = performance.now();
      const r = await s.dispatch("parameter.set", { name: slider.name, expression: expr });
      if (!r.ok) throw new Error(`parameter.set ${slider.name}=${expr}: ${r.error}`);
      const rc = performance.now() - t;
      t = performance.now();
      let at = 0;
      await backend.evaluate(s.doc, undefined, () => { at = performance.now() - t; });
      if (expr !== original) { editRecompute.push(rc); edit.push(performance.now() - t); shownAt.push(at); }
    }
    return { edit: ms(median(edit)), shown: ms(median(shownAt)), recompute: ms(median(editRecompute)), name: slider.name };
  };
  const geom = await measure(sliders.geom);
  const pose = await measure(sliders.pose);
  const cache = (backend as unknown as { cache: { hits: number; misses: number } }).cache;
  console.log(JSON.stringify({
    example: file.replace(/^.*\//, "").replace(/\.json$/, ""),
    kernelMs: ms(kernelMs), recomputeMs: ms(recomputeMs), coldMs: ms(coldMs), coldMeshesMs: ms(meshesMs), warmMs: ms(median(warm)),
    editMs: geom.edit, editMeshesMs: geom.shown, editRecomputeMs: geom.recompute, slider: geom.name,
    poseMs: pose.edit, poseMeshesMs: pose.shown, poseRecomputeMs: pose.recompute, poseSlider: pose.name,
    ...stats, docBytes, hits: cache.hits, misses: cache.misses, errors,
  }));
}

main().catch((e) => { console.error(e); process.exit(1); });
