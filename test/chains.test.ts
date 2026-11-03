import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { echoSession } from "./helpers";
import { featureChains } from "../src/core/geometry/chains";
import { featureActive } from "../src/core/features";
import { hasImplicitTargets, planEvaluation, featureWeight } from "../src/core/geometry/pool";
import { geometryCapabilities, poolSizeFor, MAX_POOL } from "../src/core/geometry/capabilities";
import { resolveParameters } from "../src/core/parameters";
import { deserializeDocument } from "../src/core/persistence";
import { createDefaultRegistry } from "../src/core/command/builtins";
import { rebuild } from "../src/core/build";
import type { CadDocument, FeatureDef } from "../src/core/document";

// The split of a model into independent chains of features (no kernel needed): every
// active feature lands in exactly one chain, features that share a body share a chain,
// and anything the split can't predict makes it refuse (null: build whole).
const example = (name: string): CadDocument => {
  const doc = deserializeDocument(readFileSync(fileURLToPath(new URL(`../public/examples/${name}.json`, import.meta.url)), "utf8"));
  rebuild(doc, createDefaultRegistry());
  return doc;
};
const chainsOf = (doc: CadDocument) => featureChains(doc, resolveParameters(doc.parameters).scope);
/** The chain (by its id) that holds a feature. */
const of2 = (chains: { id: string; features: string[] }[], id: string) => chains.find((ch) => ch.features.includes(id))!.id;

describe("feature chains", () => {
  it.each([["walker", 74], ["gyroscope", 3], ["roubo", 34], ["motor", 10], ["clockwork", 45]])("%s splits into %i chains, every feature in one", (name, n) => {
    const doc = example(name as string);
    const chains = chainsOf(doc)!;
    expect(chains).not.toBeNull();
    expect(chains.length).toBe(n);
    const all = chains.flatMap((c) => c.features);
    expect(all.length).toBe(new Set(all).size);
    const scope = resolveParameters(doc.parameters).scope;
    expect(all.sort()).toEqual(Object.values(doc.features).filter((f) => featureActive(f, scope)).map((f) => f.id).sort()); // the active ones (the motor's configuration switches many off)
    for (const c of chains) expect(c.id).toBe(c.features[0]);
  });

  it("keeps a model that cuts and joins one body as one chain", () => {
    const doc = example("starbox"); // one body, a chain of cuts and joins; also an assembly pattern
    expect(chainsOf(doc)).toBeNull(); // the pattern makes it unsafe: built whole
  });

  it("joins the features that share a body, by name or by recency", async () => {
    const s = echoSession();
    const box = async (x: number) => {
      const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
      await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: x - 5, y: -5 }, opposite: { x: x + 5, y: 5 } });
      return (await s.dispatch("feature.extrude", { sketch: sid, distance: "10" })).createdIds[0];
    };
    const a = await box(0), b = await box(30), c = await box(60);
    const cutSk = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addCircle", { sketch: cutSk, center: { x: 0, y: 0 }, radius: 2 });
    const cutA = (await s.dispatch("feature.extrude", { sketch: cutSk, distance: "10", operation: "cut", body: a })).createdIds[0];
    const cutLast = (await s.dispatch("feature.extrude", { sketch: cutSk, distance: "10", operation: "cut" })).createdIds[0]; // into c, the most recent
    const chains = chainsOf(s.doc)!;
    const of = (id: string) => chains.find((ch) => ch.features.includes(id))!.id;
    expect(chains.length).toBe(3);
    expect(of(cutA)).toBe(a);
    expect(of(cutLast)).toBe(c);
    expect(of(b)).toBe(b);
    expect(hasImplicitTargets(s.doc, resolveParameters(s.doc.parameters).scope)).toBe(true);
    // a Voronoi pattern cuts its body (named, or the most recent)
    s.doc.features.vor1 = { id: "vor1", kind: "voronoi", name: "Voronoi", cellsExpr: "12", seed: 1, webExpr: "2", body: b } as FeatureDef;
    s.doc.features.vor2 = { id: "vor2", kind: "voronoi", name: "Voronoi 2", cellsExpr: "12", seed: 1, webExpr: "2" } as FeatureDef;
    expect(chainsOf(s.doc)!.length).toBe(3);
    expect(of2(chainsOf(s.doc)!, "vor1")).toBe(b);
    expect(of2(chainsOf(s.doc)!, "vor2")).toBe(c);
    // a mirror of every body reads them all: no safe split
    await s.dispatch("feature.mirror", { plane: "YZ" });
    expect(chainsOf(s.doc)).toBeNull();
  });

  it("refuses a sketch on a face (it re-resolves against every body)", async () => {
    const s = echoSession();
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: -5, y: -5 }, opposite: { x: 5, y: 5 } });
    const f = (await s.dispatch("feature.extrude", { sketch: sid, distance: "10" })).createdIds[0];
    const sid2 = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sid2, corner: { x: 20, y: -5 }, opposite: { x: 30, y: 5 } });
    await s.dispatch("feature.extrude", { sketch: sid2, distance: "10" });
    expect(chainsOf(s.doc)!.length).toBe(2);
    s.doc.sketches[sid2].faceRef = { body: f, face: `${f}:top` } as never;
    expect(chainsOf(s.doc)).toBeNull();
  });
});

describe("sharing the chains out", () => {
  const scopeOf = (doc: CadDocument) => resolveParameters(doc.parameters).scope;

  it("gives the heaviest chain a worker of its own: the roubo's modelled vise-screw thread", () => {
    const doc = example("roubo");
    const thread = Object.values(doc.features).find((f) => f.kind === "thread")!;
    expect(featureWeight(thread)).toBeGreaterThan(200); // 330 mm at a 12 mm pitch: seconds of sweeping and booleans
    const plan = planEvaluation(doc, scopeOf(doc), 4)!;
    const own = plan.find((p) => p.only.includes(thread.id))!;
    const chain = featureChains(doc, scopeOf(doc))!.find((c) => c.features.includes(thread.id))!;
    expect(own.only).toEqual(chain.features); // the screw and its thread, nothing else
    expect(plan.flatMap((p) => p.only).sort()).toEqual(Object.keys(doc.features).sort());
  });

  it("weighs features by what they cost to build", () => {
    const f = (x: object) => x as FeatureDef;
    expect(featureWeight(f({ kind: "extrude" }))).toBe(1);
    expect(featureWeight(f({ kind: "thread", spec: { pitch: 2, length: 6, representation: "cosmetic" } }))).toBe(1);
    expect(featureWeight(f({ kind: "thread", spec: { pitch: 2, length: 6, representation: "modeled" } }))).toBe(30);
    expect(featureWeight(f({ kind: "gear", gearType: "spur" }))).toBeLessThan(featureWeight(f({ kind: "gear", gearType: "herringbone" })));
    expect(featureWeight(undefined)).toBe(1);
  });

  it("keeps a chain on the worker it was given, so that worker's cache keeps hitting", () => {
    const doc = example("clockwork");
    const placed = new Map<string, number>();
    const first = planEvaluation(doc, scopeOf(doc), 3, placed)!;
    expect(placed.size).toBe(45);
    expect(planEvaluation(doc, scopeOf(doc), 3, placed)).toEqual(first); // the same plan again
    expect(planEvaluation(doc, scopeOf(doc), 3)).toEqual(first); // and from nothing: it depends only on the model
    // a chain placed elsewhere (by an earlier model's plan) stays where it is
    const [moved] = featureChains(doc, scopeOf(doc))!;
    const to = (placed.get(moved.id)! + 1) % 3;
    placed.set(moved.id, to);
    const again = planEvaluation(doc, scopeOf(doc), 3, placed)!;
    expect(again.find((p) => p.worker === to)!.only).toEqual(expect.arrayContaining(moved.features));
    // a placement on a worker the pool no longer has is made afresh
    placed.set(moved.id, 7);
    expect(planEvaluation(doc, scopeOf(doc), 3, placed)!.flatMap((p) => p.only).sort()).toEqual(first.flatMap((p) => p.only).sort());
    expect(placed.get(moved.id)).toBeLessThan(3);
  });
});

describe("geometry capabilities", () => {
  it("reads the host", () => {
    const web = geometryCapabilities({ Worker: class {}, navigator: { hardwareConcurrency: 8 } });
    expect(web).toMatchObject({ workers: true, cores: 8, threads: false, desktop: false, poolSize: 1 });
    const desktop = geometryCapabilities({ Worker: class {}, navigator: { hardwareConcurrency: 8 }, window: { __TAURI_INTERNALS__: {} } });
    expect(desktop).toMatchObject({ desktop: true, poolSize: 2 });
    const isolated = geometryCapabilities({ Worker: class {}, crossOriginIsolated: true, SharedArrayBuffer: class {} });
    expect(isolated.threads).toBe(true);
    expect(geometryCapabilities({}).poolSize).toBe(1); // no workers at all
  });
  it("sizes the pool: an explicit choice, else the desktop's two (within half its cores), else one", () => {
    expect(poolSizeFor({ cores: 12, desktop: true }, {})).toBe(2);
    expect(poolSizeFor({ cores: 4, desktop: true }, {})).toBe(2);
    expect(poolSizeFor({ cores: 2, desktop: true }, {})).toBe(1);
    expect(poolSizeFor({ cores: 12, desktop: true }, { location: { search: "?pool=4" } })).toBe(MAX_POOL);
    expect(poolSizeFor({ cores: 12, desktop: true }, { location: { search: "?pool=9" } })).toBe(MAX_POOL);
    expect(poolSizeFor({ cores: 1, desktop: true }, {})).toBe(1);
    expect(poolSizeFor({ cores: 12, desktop: false }, {})).toBe(1);
    expect(poolSizeFor({ cores: 12, desktop: false }, { location: { search: "?pool=3" } })).toBe(3);
    expect(poolSizeFor({ cores: 12, desktop: true }, { location: { search: "?pool=1" } })).toBe(1);
    expect(poolSizeFor({ cores: 12, desktop: false }, { localStorage: { getItem: () => "2" } })).toBe(2);
    expect(poolSizeFor({ cores: 12, desktop: false }, { localStorage: { getItem: () => "lots" } })).toBe(1);
  });
});

describe("resolveParameters memo", () => {
  it("gives fresh copies with the right values, and follows a change", () => {
    const params = [{ id: "p1", name: "a", expr: "2", value: 0 }, { id: "p2", name: "b", expr: "a*3", value: 0 }];
    const r1 = resolveParameters(params);
    expect(r1.scope).toEqual({ a: 2, b: 6 });
    const r2 = resolveParameters(params);
    expect(r2.scope).toEqual({ a: 2, b: 6 });
    expect(r2.resolved).not.toBe(r1.resolved);
    expect(r2.resolved[1]).not.toBe(r1.resolved[1]);
    r2.resolved[1].value = 99; // a caller's edit never reaches another caller
    expect(resolveParameters(params).resolved[1].value).toBe(6);
    params[0].expr = "5";
    expect(resolveParameters(params).scope).toEqual({ a: 5, b: 15 });
    // an error keeps the last value, and that value is part of what is memoized
    const bad = [{ id: "p1", name: "a", expr: "nope", value: 7 }];
    expect(resolveParameters(bad).resolved[0]).toMatchObject({ value: 7, error: expect.any(String) });
    bad[0].value = 8;
    expect(resolveParameters(bad).resolved[0].value).toBe(8);
    // a warning (out of extents) too
    const wide = [{ id: "p1", name: "a", expr: "50", value: 0, min: 0, max: 10 }];
    expect(resolveParameters(wide).resolved[0].warning).toMatch(/above max/);
    expect(resolveParameters(wide).resolved[0].warning).toMatch(/above max/);
    wide[0].max = 100;
    expect(resolveParameters(wide).resolved[0].warning).toBeUndefined();
  });
});
