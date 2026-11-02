// Every bundled example is a regression test. Each one must:
//   1. replay, and build every body without error on BOTH geometry paths (the
//      mesh-instancing render path, and the rebuild path used by collision /
//      motion study / export) with the same result, matching its committed
//      geometry snapshot;
//   2. sit without interpenetration at rest, and stay clear while every joint-
//      driving parameter is swept (bounded ones across their range, a bare
//      revolute drive through 360°) — and, with flexures, close every loop and
//      keep each hinge under its material's allowable strain throughout;
//   3. build without error at the min and max of every customize slider.
// An example under examples/ or public/examples/ is picked up automatically; its
// first run writes the snapshot to commit alongside it.
//
// The checks live here; test/examples.test.ts, examples.b.test.ts and
// examples.c.test.ts run them, each for a third of the examples (by a hash of
// the name, so adding one doesn't move the others' snapshots), so the three
// run in parallel. An example in OWN_KERNEL runs them in a test file of its
// own (test/examples.<name>.test.ts), so in a kernel of its own: OCC keeps some
// memory from every boolean (tens of MB for a pair of helical gears), and a gear
// train's collision sweep, sharing the kernel with every other example, ran it
// out of memory. A file holding the same model as one already listed (an old copy
// under examples/, maybe without the titles and labels) is checked once.
//
// The default run sweeps each drive at three of its six samples (its ends and
// one in between; a bare revolute drive every 90°, not 30°), and leaves a
// drive's own slider ends to that sweep; the extended run (`npm run test:full`)
// does every sample. An example with KNOWN_OVERLAPS always gets every sample, as
// its trace is snapshotted.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { sessionFromDoc, FULL } from "./helpers";
import { deserializeDocument } from "../src/core/persistence";
import { InlineGeometryBackend } from "../src/core/geometry/backend";
import { evaluateFeatures } from "../src/core/features";
import { expandAssembly } from "../src/core/assembly";
import { placeComponentSketches } from "../src/core/recompute";
import { resolveParameters } from "../src/core/parameters";
import { flexureState, hasFlexures } from "../src/sim/flexure";
import type { SolidEval, CollisionResult } from "../src/core/features";
import { isReferenceBody, type CadDocument } from "../src/core/document";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

// public/examples/ first: it is what the app serves, so an old copy of the same model under examples/ is the one dropped
const DIRS = ["../public/examples/", "../examples/"];
/** The model a file holds: its recipe without the display-only commands (titles, labels), which build nothing. */
const DISPLAY_ONLY = new Set(["document.describe", "parameter.describe"]);
const digest = (url: URL) => {
  const d = JSON.parse(readFileSync(url, "utf8")) as { operations: { type: string; params: unknown; suppressed?: boolean }[]; hidden?: string[] };
  const model = { ops: d.operations.filter((o) => !DISPLAY_ONLY.has(o.type)).map((o) => [o.type, o.params, !!o.suppressed]), hidden: d.hidden ?? [] };
  return createHash("sha256").update(JSON.stringify(model)).digest("hex");
};
export const EXAMPLES = DIRS.flatMap((d) => {
  const dir = new URL(d, import.meta.url);
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => ({ name: `${d.replace("../", "")}${f}`, url: new URL(f, dir) }));
}).filter((e, i, all) => all.findIndex((o) => digest(o.url) === digest(e.url)) === i);

/** Which of `shards` test files checks an example: stable per name. */
export const shardOf = (name: string, shards: number) => createHash("sha256").update(name).digest().readUInt32BE(0) % shards;

/** Examples checked in a kernel (a test file) of their own — see above; the handlebar too, whose
 *  freeform collision checks are slow enough to want running beside the others, not after them. */
export const OWN_KERNEL = ["public/examples/clockwork.json", "public/examples/skadis.json", "public/examples/handlebar.json", "public/examples/walker.json"];

/** Examples whose bodies interpenetrate BY CONSTRUCTION, with why. Their overlap
 *  at rest and at every motion sample is snapshotted instead (so any change shows
 *  up in review), and the entry must go once the example is fixed (asserted). */
const KNOWN_OVERLAPS: Record<string, string> = {
  "public/examples/roubo.json":
    "the handwheel's three handle landings and handle spigots are seated into its rim: they are separate parts " +
    "only so each can be canted by a joint (one casting, and a press fit, in the real thing)",
};

const r1 = (v: number | undefined) => (v == null ? null : Math.round(v * 10) / 10);

/** Geometry fingerprint: per body, its exact B-rep volume and bounds (0.1 mm). */
function fingerprint(solids: Record<string, SolidEval>) {
  return Object.values(solids).filter((b) => b.mesh).sort((a, b) => a.featureId.localeCompare(b.featureId)).map((b) => ({
    body: b.featureId,
    name: b.name,
    volume: r1(b.volume),
    min: b.bounds ? [r1(b.bounds.min.x), r1(b.bounds.min.y), r1(b.bounds.min.z)] : null,
    max: b.bounds ? [r1(b.bounds.max.x), r1(b.bounds.max.y), r1(b.bounds.max.z)] : null,
  }));
}

/** Closed-mesh volume (divergence theorem): comparable across both paths, which
 *  don't all record the exact B-rep volume (the incremental cache skips it). */
function meshVolume(pos: ArrayLike<number>, idx: ArrayLike<number>): number {
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const [p, q, r] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3];
    v += pos[p] * (pos[q + 1] * pos[r + 2] - pos[q + 2] * pos[r + 1])
      - pos[p + 1] * (pos[q] * pos[r + 2] - pos[q + 2] * pos[r])
      + pos[p + 2] * (pos[q] * pos[r + 1] - pos[q + 1] * pos[r]);
  }
  return Math.abs(v / 6);
}

const pairKey = (o: CollisionResult["overlaps"][number]) => [o.aId, o.bId].sort().join(" × ");

/** Sample values for every parameter that drives a joint (or joint template):
 *  across [min, max] (or its value list) when bounded; through 360° when it is a
 *  bare revolute drive. An unbounded slider has no known range, so it is skipped. */
function motionSamples(doc: CadDocument, every = FULL): { name: string; values: number[] }[] {
  // The default run's subset: a drive's ends, and one sample in between that is
  // neither an end nor (for a range centred on rest) the rest pose; a revolute
  // drive every 90°. The bodies are rigid between samples, so what the extra
  // samples add is the in-between phases of a mechanism (a gear's tooth, a
  // Geneva's step), which the generator tests and the extended run cover.
  const pick = (values: number[]) => (every || values.length <= 3 ? values : values.length === 6 ? [0, 2, 5].map((k) => values[k]) : values.filter((_, k) => k % 3 === 0));
  return allMotionSamples(doc).map((m) => ({ ...m, values: pick(m.values) }));
}

function allMotionSamples(doc: CadDocument): { name: string; values: number[] }[] {
  const drives = [...Object.values(doc.joints), ...Object.values(doc.jointTemplates ?? {})].flatMap((j) => [
    { kind: j.kind, expr: (j.valueExpr ?? "").trim() },
    ...("planar" in j && j.planar ? Object.values(j.planar).map((e) => ({ kind: j.kind, expr: String(e).trim() })) : []), // a planar joint's driven axes
  ]);
  const out: { name: string; values: number[] }[] = [];
  for (const p of doc.parameters) {
    const uses = drives.filter((d) => new RegExp(`\\b${p.name}\\b`).test(d.expr));
    if (!uses.length) continue;
    if (p.values?.length) out.push({ name: p.name, values: p.values });
    else if (p.min != null && p.max != null) out.push({ name: p.name, values: Array.from({ length: 6 }, (_, k) => p.min! + ((p.max! - p.min!) * k) / 5) });
    else if (uses.some((d) => d.kind === "revolute" && d.expr === p.name)) out.push({ name: p.name, values: Array.from({ length: 12 }, (_, k) => k * 30) });
  }
  return out;
}

async function load(url: URL) {
  const s = sessionFromDoc(deserializeDocument(readFileSync(url, "utf8")));
  await s.recompute();
  return s;
}

/** The checks, for the examples `which` picks (by name, e.g. "public/examples/gimbal.json"). */
export function defineExampleSuite(which: (name: string) => boolean): void {
  describe("bundled examples", () => {
    const backend = new InlineGeometryBackend();
    beforeAll(async () => { await backend.init({ wasmBinary: wasm }); }, 60000);

    it("finds the examples", () => {
      expect(EXAMPLES.length).toBeGreaterThanOrEqual(6);
      for (const k of [...Object.keys(KNOWN_OVERLAPS), ...OWN_KERNEL]) expect(EXAMPLES.map((e) => e.name), `stale entry ${k}`).toContain(k);
    });

    for (const ex of EXAMPLES.filter((e) => which(e.name))) {
      describe(ex.name, () => {
        it("replays, builds on both geometry paths, and matches its snapshot", async () => {
          const s = await load(ex.url);
          for (const sk of Object.values(s.doc.sketches)) expect(sk.status.conflicting, `sketch ${sk.name} conflicts`).toBe(false);

          // Render path (what the viewport shows).
          const rendered = Object.values((await backend.evaluate(s.doc)).solids);
          for (const row of rendered) expect(row.error, `${row.name}: ${row.error}`).toBeUndefined();
          const bodies = rendered.filter((b) => b.mesh);
          expect(bodies.length).toBeGreaterThan(0);

          // Rebuild path (collision, motion study, export): the same bodies.
          const scope = resolveParameters(s.doc.parameters).scope;
          const geo = expandAssembly(s.doc, scope);
          placeComponentSketches(geo, scope);
          const rebuilt = evaluateFeatures(geo, scope);
          for (const row of Object.values(rebuilt)) expect(row.error, `${row.name}: ${row.error}`).toBeUndefined();
          expect(Object.values(rebuilt).filter((b) => b.mesh).length).toBe(bodies.length);
          for (const b of bodies) {
            const r = rebuilt[b.featureId];
            expect(r?.mesh, `${b.name} missing on the rebuild path`).toBeTruthy();
            const vr = meshVolume(b.mesh!.positions, b.mesh!.indices), vb = meshVolume(r.mesh!.positions, r.mesh!.indices);
            expect(Math.abs(vr - vb) / Math.max(vr, 1), `${b.name} volume differs between paths (${vr} vs ${vb})`).toBeLessThan(2e-3);
          }

          expect(fingerprint(rebuilt)).toMatchSnapshot();
        }, 120000);

        it("is clear at rest and while its joints are driven", async () => {
          const s = await load(ex.url);
          const known = KNOWN_OVERLAPS[ex.name];
          const trace: string[] = [];
          const check = (c: CollisionResult, at: string, limit = 1) => {
            expect(c.buildError, at).toBeUndefined();
            if (known) trace.push(`${at}: ${c.overlaps.map((o) => `${pairKey(o)} ${r1(o.volume)}`).sort().join(", ")}`);
            else for (const o of c.overlaps) expect(o.volume, `${o.a} hits ${o.b} at ${at}`).toBeLessThan(limit);
          };

          const rest = await backend.collide(s.doc);
          check(rest, "rest", 0.01); // at rest parts only touch (a bent flexure strip may sliver, below 1 mm³, once driven)
          if (known) expect(rest.maxOverlap, `${ex.name} no longer overlaps: remove its KNOWN_OVERLAPS entry`).toBeGreaterThan(1);
          const samples = motionSamples(s.doc, FULL || !!known);
          for (const { name, values } of samples) {
            // the other drives stay at their saved values
            const others = Object.fromEntries(samples.filter((m) => m.name !== name).map((m) => [m.name, String(s.doc.parameters.find((p) => p.name === m.name)!.value)]));
            for (const v of values) {
              const overrides = { ...others, [name]: String(v) };
              check(await backend.collide(s.doc, overrides), `${name} = ${r1(v)}`);
              // a compliant mechanism also has to close its loops and keep every hinge under its strain limit
              if (hasFlexures(s.doc)) {
                const f = flexureState(s.doc, overrides);
                expect(f.error, `${name} = ${r1(v)}`).toBeUndefined();
                expect(f.utilisation, `flexure strain / allowable at ${name} = ${r1(v)}`).toBeLessThan(1);
              }
            }
          }
          if (known) expect(trace).toMatchSnapshot();
        }, 300000);

        // The download: a compliant part prints at rest, as one piece, and all of
        // it. (Its drives were zeroed for the print along with every size the
        // drive's expression mentioned, so the gripper printed with no hinges.)
        it("prints all of itself: the download holds every body", async () => {
          const s = await load(ex.url);
          if (!hasFlexures(s.doc)) return;
          // every body but a reference part's (a stand-in, a board): those aren't made, so aren't in the file
          const bodies = Object.values((await backend.evaluate(s.doc)).solids).filter((b) => b.mesh && !isReferenceBody(s.doc, b));
          const modelled = bodies.reduce((v, b) => v + meshVolume(b.mesh!.positions, b.mesh!.indices), 0);
          const stl = (await backend.exportBytes(s.doc, null, "stl"))!;
          const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength), n = dv.getUint32(80, true);
          const pos = new Float32Array(9 * n), idx = Uint32Array.from({ length: 3 * n }, (_, i) => i);
          for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) pos[9 * t + k] = dv.getFloat32(84 + 50 * t + 12 + 4 * k, true);
          const printed = meshVolume(pos, idx);
          expect(Math.abs(printed - modelled) / modelled, `printed ${r1(printed)} mm³ of ${r1(modelled)}`).toBeLessThan(5e-3);
        }, 120000);

        // Through the same path as the slider: set the parameter and recompute, so
        // sketches re-solve and expression-positioned geometry moves.
        // (In the default run a joint's drive skips the build here when the
        // motion sweep above has already built and collided the model at both
        // its ends; its sketches are still re-solved there and checked.)
        it("builds at the ends of every customize slider", async () => {
          const s = await load(ex.url);
          const endsOf = (p: CadDocument["parameters"][number]) => (p.values?.length ? [Math.min(...p.values), Math.max(...p.values)] : p.min != null && p.max != null ? [p.min, p.max] : []);
          const swept = new Set(FULL ? [] : motionSamples(s.doc).filter((m) => {
            const ends = endsOf(s.doc.parameters.find((q) => q.name === m.name)!);
            return ends.length && ends.every((e) => m.values.includes(e));
          }).map((m) => m.name));
          for (const p of [...s.doc.parameters]) {
            const ends = endsOf(p);
            for (const v of ends) {
              const r = await s.dispatch("parameter.set", { name: p.name, expression: String(v) });
              expect(r.ok, `${p.name} = ${v}: ${r.error}`).toBe(true);
              for (const sk of Object.values(s.doc.sketches)) expect(sk.status.conflicting, `${p.name} = ${v}: sketch ${sk.name} conflicts`).toBe(false);
              if (swept.has(p.name)) continue;
              const c = await backend.collide(s.doc);
              expect(c.buildError, `${p.name} = ${v}`).toBeUndefined();
            }
            await s.dispatch("parameter.set", { name: p.name, expression: p.expr }); // back to its saved value
          }
        }, 1800000); // a freeform example (the handlebar) takes minutes here on a busy machine
      });
    }
  });
}
