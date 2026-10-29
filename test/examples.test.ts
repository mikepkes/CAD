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
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sessionFromDoc } from "./helpers";
import { deserializeDocument } from "../src/core/persistence";
import { InlineGeometryBackend } from "../src/core/geometry/backend";
import { evaluateFeatures } from "../src/core/features";
import { expandAssembly } from "../src/core/assembly";
import { placeComponentSketches } from "../src/core/recompute";
import { resolveParameters } from "../src/model/parameters";
import { flexureState, hasFlexures } from "../src/sim/flexure";
import type { SolidEval, CollisionResult } from "../src/core/features";
import type { CadDocument } from "../src/core/document";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

const DIRS = ["../examples/", "../public/examples/"];
const EXAMPLES = DIRS.flatMap((d) => {
  const dir = new URL(d, import.meta.url);
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => ({ name: `${d.replace("../", "")}${f}`, url: new URL(f, dir) }));
});

/** Examples whose bodies interpenetrate BY CONSTRUCTION, with why. Their overlap
 *  at rest and at every motion sample is snapshotted instead (so any change shows
 *  up in review), and the entry must go once the example is fixed (asserted). */
const KNOWN_OVERLAPS: Record<string, string> = {
  "public/examples/roubo.json":
    "clearance cuts are missing: rail/leg tenons sit in legs and top with no mortise, the vise screw passes " +
    "Leg FL with no bore, the crisscross arms pass the chop with no slot, pins have no holes, handles no bores",
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
function motionSamples(doc: CadDocument): { name: string; values: number[] }[] {
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

describe("bundled examples", () => {
  const backend = new InlineGeometryBackend();
  beforeAll(async () => { await backend.init({ wasmBinary: wasm }); }, 60000);

  it("finds the examples", () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(6);
    for (const k of Object.keys(KNOWN_OVERLAPS)) expect(EXAMPLES.map((e) => e.name), `stale KNOWN_OVERLAPS entry ${k}`).toContain(k);
  });

  for (const ex of EXAMPLES) {
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
      }, 300000);

      it("is clear at rest and while its joints are driven", async () => {
        const s = await load(ex.url);
        const known = KNOWN_OVERLAPS[ex.name];
        const trace: string[] = [];
        const check = (c: CollisionResult, at: string) => {
          expect(c.buildError, at).toBeUndefined();
          if (known) trace.push(`${at}: ${c.overlaps.map((o) => `${pairKey(o)} ${r1(o.volume)}`).sort().join(", ")}`);
          else for (const o of c.overlaps) expect(o.volume, `${o.a} hits ${o.b} at ${at}`).toBeLessThan(1);
        };

        const rest = await backend.collide(s.doc);
        check(rest, "rest");
        if (known) expect(rest.maxOverlap, `${ex.name} no longer overlaps: remove its KNOWN_OVERLAPS entry`).toBeGreaterThan(1);
        const samples = motionSamples(s.doc);
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
      }, 600000);

      // Through the same path as the slider: set the parameter and recompute, so
      // sketches re-solve and expression-positioned geometry moves.
      it("builds at the ends of every customize slider", async () => {
        const s = await load(ex.url);
        for (const p of [...s.doc.parameters]) {
          const ends = p.values?.length ? [Math.min(...p.values), Math.max(...p.values)] : p.min != null && p.max != null ? [p.min, p.max] : [];
          for (const v of ends) {
            const r = await s.dispatch("parameter.set", { name: p.name, expression: String(v) });
            expect(r.ok, `${p.name} = ${v}: ${r.error}`).toBe(true);
            for (const sk of Object.values(s.doc.sketches)) expect(sk.status.conflicting, `${p.name} = ${v}: sketch ${sk.name} conflicts`).toBe(false);
            const c = await backend.collide(s.doc);
            expect(c.buildError, `${p.name} = ${v}`).toBeUndefined();
          }
          await s.dispatch("parameter.set", { name: p.name, expression: p.expr }); // back to its saved value
        }
      }, 900000);
    });
  }
});
