import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deserializeDocument } from "../src/core/persistence";
import { sessionFromDoc } from "./helpers";
import type { CadDocument } from "../src/core/document";
import type { Scope } from "../src/math/expr";
import { resolveParameters } from "../src/core/parameters";
import { sweepGuide, sweepGuides } from "../src/core/sweepGuides";
import type { SweepFeature } from "../src/core/document";
import type { Vec3 } from "../src/math/vec";

// A 3D sweep's construction drawn from its real definition: the spine through its points and the sections on it,
// for the bundled handlebar (the bar: one round section tapered by a scale law; each grip: five sections morphing).

let doc: CadDocument, scope: Scope;
beforeAll(async () => {
  const s = sessionFromDoc(deserializeDocument(readFileSync(fileURLToPath(new URL("../public/examples/handlebar.json", import.meta.url)), "utf8")));
  await s.recompute();
  doc = s.doc; scope = resolveParameters(doc.parameters).scope;
});
const named = (n: string) => Object.values(doc.features).find((f) => f.kind === "sweep" && f.name === n) as SweepFeature;
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** A section loop's mean distance from its centroid (a circle's radius). */
const radius = (loop: Vec3[]) => {
  const pts = loop.slice(0, -1), c = pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length, z: a.z + p.z / pts.length }), { x: 0, y: 0, z: 0 });
  return pts.reduce((a, p) => a + dist(p, c), 0) / pts.length;
};

describe("sweep guides", () => {
  it("draws the bar's spine tip to tip, and its section tapering from the clamp to the grips", () => {
    const g = sweepGuide(doc, scope, named("Bar"))!;
    expect(g).not.toBeNull();
    expect(g.sketchId).toBe(named("Bar").pathSketch);
    const w = scope.width, tipY = scope.tipY, rise = scope.rise;
    expect(dist(g.spine[0], { x: -w / 2, y: tipY, z: rise })).toBeLessThan(1e-6);
    expect(dist(g.spine.at(-1)!, { x: w / 2, y: tipY, z: rise })).toBeLessThan(1e-6);
    // the middle of the spine passes through the stem clamp at the origin
    expect(dist(g.spine[g.spine.length >> 1], { x: 0, y: 0, z: 0 })).toBeLessThan(0.5);
    // profiles at even steps, every one closed; 31.8 mm at the clamp, 22.2 mm at the grips
    expect(g.sections.length).toBeGreaterThanOrEqual(5);
    for (const s of g.sections) for (const loop of s) expect(dist(loop[0], loop.at(-1)!)).toBeLessThan(1e-9);
    const r = g.sections.map((s) => radius(s[0]));
    expect(r[0]).toBeCloseTo(11.1, 1);
    expect(r.at(-1)!).toBeCloseTo(11.1, 1);
    expect(Math.max(...r)).toBeCloseTo(15.9, 1);
    // each profile sits square to the spine, centred on it
    for (const s of g.sections) {
      const pts = s[0].slice(0, -1), c = pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length, z: a.z + p.z / pts.length }), { x: 0, y: 0, z: 0 });
      expect(Math.min(...g.spine.map((p) => dist(p, c)))).toBeLessThan(2);
    }
  });

  it("puts each of a grip's five sections at its station, a ring (outer and bore) each", () => {
    const g = sweepGuide(doc, scope, named("Grip R"))!;
    expect(g.sections).toHaveLength(5);
    for (const s of g.sections) expect(s).toHaveLength(2);
    // round at the collar end, swelling into the palm wing at the tip; the bore stays the bar's
    const outer = g.sections.map((s) => radius(s[0])), bore = g.sections.map((s) => radius(s[1]));
    expect(outer[0]).toBeCloseTo(15.6, 1);
    expect(Math.max(...outer)).toBeGreaterThan(18);
    for (const b of bore) expect(b).toBeCloseTo(11.2, 1);
    expect(dist(g.spine.at(-1)!, { x: scope.width / 2, y: scope.tipY, z: scope.rise })).toBeLessThan(1e-6);
  });

  it("follows the parameters", () => {
    const wide = { ...scope, width: 800 };
    const g = sweepGuide(doc, resolveParameters(doc.parameters.map((p) => (p.name === "width" ? { ...p, expr: "800" } : p))).scope, named("Bar"))!;
    expect(g.spine.at(-1)!.x).toBeCloseTo(wide.width / 2, 6);
  });

  it("draws only the 3D sweeps whose path sketch is shown, and that are on", () => {
    expect(sweepGuides(doc, scope, new Set())).toEqual([]);
    const bar = named("Bar"), grip = named("Grip R");
    const shown = new Set([bar.pathSketch, grip.pathSketch]);
    expect(sweepGuides(doc, scope, shown).map((g) => g.featureId).sort()).toEqual([bar.id, grip.id].sort());
    expect(sweepGuides(doc, scope, shown, (f) => f.id !== grip.id).map((g) => g.featureId)).toEqual([bar.id]);
    // worked out once while nothing changes
    expect(sweepGuides(doc, scope, shown)[0]).toBe(sweepGuides(doc, scope, shown)[0]);
  });
});
