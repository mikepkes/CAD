// Layer order as data (core/sheetLayers.ts): read from a plan after each step, checked by Flat-Folder's conditions,
// and the fold operations that declare it — an inside reverse fold puts a point between a flap's layers, an outside
// one wraps it round them (the same shape; a different order).
import { describe, it, expect } from "vitest";
import { planSequence, sequenceAngles, poseSequence, sequenceClashes, sequenceFaces, sequencePaper, SeqFoldDef } from "../src/core/sheetSequence";
import { layerOrderOf, validateLayers, layerRanks } from "../src/core/sheetLayers";
import { applyPoint, IDENTITY, rotationAbout, translation, compose } from "../src/math/transform";

const PI = Math.PI;
const rect = (w: number, h: number) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
const facetAt = (seq: ReturnType<typeof planSequence>, x: number, y: number) =>
  seq.facets.findIndex((fc) => fc.poly.every((p, i) => { const r = fc.poly[(i + 1) % fc.poly.length]; return (r.x - p.x) * (y - p.y) - (r.y - p.y) * (x - p.x) >= -1e-9; }));
const sweepClear = (seq: ReturnType<typeof planSequence>, from: number, to: number, margin: number) => {
  const bad: number[] = [];
  for (let k = from * 20; k <= to * 20; k++) if (sequenceClashes(seq, sequenceAngles(seq, k / 20), margin).length) bad.push(k / 20);
  return bad;
};

describe("layer order", () => {
  it("a two-layer flap: the order after each step, as data, the ranks a gap apart", () => {
    const seq = planSequence(rect(100, 60), [
      { id: "half", a: { x: 50, y: 0 }, b: { x: 50, y: 60 }, angle: PI, step: 1 },
      { id: "quarter", a: { x: 0, y: 30 }, b: { x: 50, y: 30 }, angle: PI, step: 2 },
    ], { x: 10, y: 10 }, 0.1);
    expect(seq.layers?.length).toBe(2);
    // after step 1: the right half lies on the left (two facets each, cut by step 2's line): b above a
    const L1 = seq.layers![0], T1 = poseSequence(seq, sequenceAngles(seq, 1));
    expect(L1.above.length).toBe(2);
    for (const [a, b] of L1.above) {
      const za = applyPoint(T1[a], { ...seq.facets[a].poly[0], z: 0 }).z, zb = applyPoint(T1[b], { ...seq.facets[b].poly[0], z: 0 }).z;
      expect((zb - za) * L1.families[0].n.z).toBeGreaterThan(0); // b above a along the family's normal
      expect(Math.sign(zb - za)).toBe(seq.facets[b].poly.every((p) => p.x >= 50 - 1e-9) ? 1 : -1); // the right half is the higher
    }
    // after step 2: four layers, every pair ordered, ranks 0…3 in one stack
    const L2 = seq.layers![1];
    expect(L2.above.length).toBe(6);
    const T = poseSequence(seq, sequenceAngles(seq, 2));
    const ranks = layerRanks(L2, seq.facets.length);
    expect([...ranks].sort()).toEqual([0, 1, 2, 3]);
    const z = seq.facets.map((f, i) => applyPoint(T[i], { ...f.poly[0], z: 0 }).z);
    seq.facets.forEach((_, i) => expect(z[i]).toBeCloseTo(ranks[i] * 0.1, 9)); // a gap per rank
  });

  it("the checker: a layer passing through a crease folded flat is named, with the crease", () => {
    // A and B: a sheet folded in half at x = 50 (B on A's top); C: a loose layer lying between them, across the crease
    const A = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 60 }, { x: 0, y: 60 }];
    const B = [{ x: 50, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 50, y: 60 }];
    const C = [{ x: 20, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 50 }, { x: 20, y: 50 }];
    const TB = compose(translation({ x: 0, y: 0, z: 0.2 }), rotationAbout({ x: 0, y: 1, z: 0 }, PI, { x: 50, y: 0, z: 0 }));
    const polys = [A, B, C], T = [IDENTITY, TB, translation({ x: 0, y: 0, z: 0.1 })];
    const order = layerOrderOf(polys, T, 0.1, 100, 1);
    const errs = validateLayers(polys, T, order, [{ facets: [0, 1], a: { x: 50, y: 0 }, b: { x: 50, y: 60 }, fold: '"half"', made: true }], 0.1, 100, 'step 1 (fold "half")');
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('would pass through the paper at crease "half"');
    expect(errs[0]).toContain("(40.0, 30.0)"); // the layer named by where it is on the sheet
    // the same layer outside the fold is fine
    const ok = validateLayers(polys, [IDENTITY, TB, translation({ x: 0, y: 0, z: 0.3 })], layerOrderOf(polys, [IDENTITY, TB, translation({ x: 0, y: 0, z: 0.3 })], 0.1, 100, 1), [{ facets: [0, 1], a: { x: 50, y: 0 }, b: { x: 50, y: 60 }, fold: '"half"', made: true }], 0.1, 100);
    expect(ok).toEqual([]);
  });

});

/** A diamond folded in half on its long axis (step 1): a two-layer flap, its point at the top. */
const diamond = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
const HELD = { x: -0.4, y: -0.2 };
const flap = (reverse: "inside" | "outside", bend = false): SeqFoldDef[] => [
  { id: "spine", a: { x: 0, y: -1 }, b: { x: 0, y: 1 }, angle: PI, step: 1 },
  // the reverse crease, drawn on the right half (the top layer once folded): from the spine at y = 0.4 to the edge
  { id: "rev", a: { x: 0, y: 0.4 }, b: { x: 0.3, y: 0.7 }, angle: PI, step: 2, reverse, ...(bend ? { bend: true } : {}) },
];

describe("paper overlay", () => {
  it("a flap folded onto a layer: the raw edges as segments, and a contact shadow on the layer beneath along the flap's edge, fading away from it", () => {
    const seq = planSequence(rect(100, 60), [{ id: "half", a: { x: 60, y: 0 }, b: { x: 60, y: 60 }, angle: PI, step: 1 }], { x: 10, y: 10 }, 0.1);
    const flat = sequencePaper(seq, sequenceAngles(seq, 0), IDENTITY), folded = sequencePaper(seq, sequenceAngles(seq, 1), IDENTITY);
    expect(flat.outline.length).toBe(6 * seq.outline.length);
    expect(flat.shadow.indices.length).toBe(0); // one layer: nothing lies on anything
    // the flap (x > 60, 40 wide) lands on the base at x in [20, 60]; its raw edge at x = 20 casts a strip on the base, x from 20 outward (toward 0)
    const P = folded.shadow.positions, C = folded.shadow.colors;
    expect(folded.shadow.indices.length).toBeGreaterThan(0);
    const xs = [...Array(P.length / 3)].map((_, i) => P[3 * i]), zs = [...Array(P.length / 3)].map((_, i) => P[3 * i + 2]);
    expect(Math.max(...xs)).toBeLessThan(20.01); // nothing under the flap, nothing beyond the sheet's own edges
    expect(Math.min(...xs)).toBeGreaterThan(20 - 2); // a strip a couple of mm wide
    for (const z of zs) expect(z).toBeGreaterThan(0);
    expect(Math.max(...zs)).toBeLessThan(0.05); // just off the base layer, toward the flap
    // darkest at the edge, clear at the strip's far side
    const alphaAt = (x: number) => Math.max(...[...Array(P.length / 3)].map((_, i) => (Math.abs(P[3 * i] - x) < 1e-6 ? C[4 * i + 3] : -1)));
    expect(alphaAt(20)).toBeGreaterThan(0.1);
    expect(alphaAt(Math.min(...xs))).toBeLessThan(1e-6);
    // the bend: a rounded strip over the crease once it's folded, none on the flat sheet; folded flat, its arc
    // spans from the base's edge (z 0) to the flap's (a gap up), bulging just past x = 60; a sharp fold leaves a
    // light stress mark along its crest, a crease not made yet nothing at all
    expect(flat.bends.indices.length).toBe(0); expect(flat.marks.dark.length + flat.marks.light.length).toBe(0);
    expect(folded.bends.indices.length).toBeGreaterThan(0);
    const B = folded.bends.positions, bx = [...Array(B.length / 3)].map((_, i) => B[3 * i]), bz = [...Array(B.length / 3)].map((_, i) => B[3 * i + 2]);
    expect(Math.min(...bz)).toBeCloseTo(0, 6); expect(Math.max(...bz)).toBeCloseTo(0.1, 6);
    expect(Math.max(...bx)).toBeGreaterThan(60.02); expect(Math.max(...bx)).toBeLessThan(60.2);
    expect(folded.marks.light.length).toBe(6); expect(folded.marks.dark.length).toBe(0);
    // a crease folded only a little is a valley mark, no strip yet
    const slight = planSequence(rect(100, 60), [{ id: "half", a: { x: 60, y: 0 }, b: { x: 60, y: 60 }, angle: 5 * PI / 180, step: 1 }], { x: 10, y: 10 }, 0.1);
    const sp = sequencePaper(slight, sequenceAngles(slight, 1), IDENTITY);
    expect(sp.marks.dark.length).toBe(6); expect(sp.bends.indices.length).toBe(0);
  });
});

describe("reverse folds", () => {
  it("an inside reverse fold: the point between the flap's layers, its spine reversed", () => {
    const gap = 0.01;
    const seq = planSequence(diamond, flap("inside"), HELD, gap);
    const T = poseSequence(seq, sequenceAngles(seq, 2));
    const z = (x: number, y: number) => applyPoint(T[facetAt(seq, x, y)], { x, y, z: 0 }).z;
    // the point's layers: the mirror image of where they were across the crease (the tip (0.02, 0.95) reflected in
    // the line lands at (0.55, 0.42); x mirrored by the spine fold), each layer in the flap's plane
    const tipR = applyPoint(T[facetAt(seq, 0.02, 0.95)], { x: 0.02, y: 0.95, z: 0 }), tipL = applyPoint(T[facetAt(seq, -0.02, 0.95)], { x: -0.02, y: 0.95, z: 0 });
    for (const p of [tipR, tipL]) { expect(p.x).toBeCloseTo(-0.55, 1); expect(p.y).toBeCloseTo(0.42, 1); expect(Math.abs(p.z)).toBeLessThan(0.1); }
    // layer order: body L (held, z 0) and R (on its top) either side of the point
    const bodyL = z(-0.4, 0.2), bodyR = z(0.4, 0.2), pointL = z(-0.05, 0.9), pointR = z(0.05, 0.9);
    expect(bodyL).toBeLessThan(pointL); expect(pointL).toBeLessThan(pointR); expect(pointR).toBeLessThan(bodyR);
    // every crease on the point reversed: the spine beyond the crease is now a valley where it was a mountain
    const spine = (lo: number, hi: number) => seq.creases.filter((c) => Math.abs(c.a.x) < 1e-6 && Math.abs(c.b.x) < 1e-6 && Math.min(c.a.y, c.b.y) >= lo - 1e-6 && Math.max(c.a.y, c.b.y) <= hi + 1e-6);
    const body = spine(-1, 0.4), point = spine(0.4, 1);
    expect(body.length).toBeGreaterThan(0); expect(point.length).toBeGreaterThan(0);
    for (const c of body) expect(Math.sign(c.angle)).toBe(1);
    for (const c of point) expect(Math.sign(c.angle)).toBe(-1);
    // the layer order holds the checks; the keyframes are clear of clashes (the rigid swing between them isn't:
    // the point's layers settle through each other by a few gaps at the end — the bending transition is the fix)
    expect(seq.layers?.length).toBe(2);
    expect(sweepClear(seq, 0, 1, 0.02)).toEqual([]);
    expect(sequenceClashes(seq, sequenceAngles(seq, 2), 0.02)).toEqual([]);
  });

  it("an outside reverse fold wraps the point round the flap; on a flap wider than the point it's refused", () => {
    // a strip folded in half lengthwise (two layers 100 × 15), its end reversed at 45° over the outside
    const strip = [
      { id: "spine", a: { x: 0, y: 15 }, b: { x: 100, y: 15 }, angle: PI, step: 1 },
      { id: "rev", a: { x: 70, y: 15 }, b: { x: 85, y: 0 }, angle: PI, step: 2, reverse: "outside" as const },
    ];
    const seq = planSequence(rect(100, 30), strip, { x: 10, y: 5 }, 0.1);
    const T = poseSequence(seq, sequenceAngles(seq, 2));
    const z = (x: number, y: number) => applyPoint(T[facetAt(seq, x, y)], { x, y, z: 0 }).z;
    // the end turned square off the strip (the tip at (100, 7.5) lands at (77.5, −15)), its layers either side of the body
    const tip = applyPoint(T[facetAt(seq, 99, 7)], { x: 99, y: 7, z: 0 });
    expect(tip.x).toBeCloseTo(78, 0); expect(tip.y).toBeCloseTo(-14, 0);
    const bodyB = z(50, 5), bodyT = z(50, 25), pointB = z(95, 7), pointT = z(95, 23);
    expect(pointB).toBeLessThan(bodyB); expect(bodyB).toBeLessThan(bodyT); expect(bodyT).toBeLessThan(pointT);
    expect(sequenceClashes(seq, sequenceAngles(seq, 2), 0.2)).toEqual([]);
    // on the diamond, the point folded back would lie across the body: its spine would have to pass through the body
    expect(() => planSequence(diamond, flap("outside"), HELD, 0.01)).toThrow(/pass through the paper at crease/);
  });

  it("bending between the keyframes: the point goes through, nothing passes through anything, and the paper ends rigid", () => {
    const gap = 0.01;
    const rigid = planSequence(diamond, flap("inside"), HELD, gap);
    const t0 = Date.now();
    const seq = planSequence(diamond, flap("inside", true), HELD, gap);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(5000);
    // the same keyframe when done: every point of the sheet where the rigid plan put it
    const Tr = poseSequence(rigid, sequenceAngles(rigid, 2)), Tb = poseSequence(seq, sequenceAngles(seq, 2));
    for (const [x, y] of [[0.05, 0.9], [-0.05, 0.9], [0.4, 0.2], [-0.4, 0.2], [0.02, 0.5]]) {
      const a = applyPoint(Tr[facetAt(rigid, x, y)], { x, y, z: 0 }), b = applyPoint(Tb[facetAt(seq, x, y)], { x, y, z: 0 });
      expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(1e-6);
    }
    // the mesh's seams merge back: as many faces as the rigid plan, before and after the step
    expect(sequenceFaces(seq, sequenceAngles(seq, 1)).length).toBe(sequenceFaces(rigid, sequenceAngles(rigid, 1)).length);
    expect(sequenceFaces(seq, sequenceAngles(seq, 2)).length).toBe(sequenceFaces(rigid, sequenceAngles(rigid, 2)).length);
    // along the way the point's layers part and the spine opens; no facet passes through another
    expect(sweepClear(seq, 1, 2, 0.03)).toEqual([]);
  });

  it("a point of four layers nests about the crease at the middle of its stack, the flaps folded over its faces staying with their halves", () => {
    // a strip folded in half (S0 under, S1 on top, joined at the far edge), then each layer's near edge folded over onto
    // its own face — S0's under S0, S1's on S1 — so at the near edge two flaps lie on the stack's faces, each a taco
    // with its layer: f0 S0 S1 f1 from the bottom. The creases joining layers are then f0–S0 (a face), S0–S1 (the
    // middle: the strip's folded edge), S1–f1 (the other face). Reverse-folding the end inside, the point nests about
    // the middle crease — each half (S0 with its flap, S1 with its) turned inside out: S0 f0 f1 S1 — not about the
    // first taco found, which would put one flap's layers outermost
    const gap = 0.1, strip = planSequence(rect(100, 40), [
      { id: "half", a: { x: 0, y: 20 }, b: { x: 100, y: 20 }, angle: PI, step: 1 },
      { id: "underFlap", a: { x: 0, y: 5 }, b: { x: 100, y: 5 }, angle: -PI, step: 2 },      // S0's edge, folded under (drawn on S0)
      { id: "overFlap", a: { x: 0, y: 35 }, b: { x: 100, y: 35 }, angle: -PI, step: 3 },     // S1's edge, folded up over (drawn on S1, which faces down)
      { id: "rev", a: { x: 70, y: 20 }, b: { x: 85, y: 5 }, angle: PI, step: 4, reverse: "inside" },
    ], { x: 10, y: 12 }, gap);
    const T3 = poseSequence(strip, sequenceAngles(strip, 3)), T4 = poseSequence(strip, sequenceAngles(strip, 4));
    const z = (T: typeof T3, x: number, y: number) => applyPoint(T[facetAt(strip, x, y)], { x, y, z: 0 }).z;
    // after step 3: f0 S0 S1 f1 at the near edge (flat y 2, 12, 28, 38), four layers a gap apart
    const near3 = [z(T3, 50, 2), z(T3, 50, 12), z(T3, 50, 28), z(T3, 50, 38)];
    for (let i = 1; i < 4; i++) expect(near3[i] - near3[i - 1]).toBeCloseTo(gap, 6);
    // after the reverse fold: the body as it was, the point's layers between S0 and S1 — S0's then f0's, f1's then S1's
    const body = [z(T4, 50, 2), z(T4, 50, 12), z(T4, 50, 28), z(T4, 50, 38)], point = [z(T4, 95, 12), z(T4, 95, 2), z(T4, 95, 38), z(T4, 95, 28)];
    expect(body[0]).toBeLessThan(body[1]); expect(body[1]).toBeLessThan(point[0]);
    for (let i = 1; i < 4; i++) expect(point[i]).toBeGreaterThan(point[i - 1]);
    expect(point[3]).toBeLessThan(body[2]); expect(body[2]).toBeLessThan(body[3]);
    expect(strip.layers?.length).toBe(4);
  });

  it("an inside reverse fold needs a spine; a crimp is two reverse folds in one step", () => {
    expect(() => planSequence(rect(100, 60), [{ id: "rev", a: { x: 60, y: 0 }, b: { x: 80, y: 60 }, angle: PI, step: 1, reverse: "inside" }], { x: 10, y: 10 }, 0.1)).toThrow(/spine/);
    const seq = planSequence(diamond, [
      flap("inside")[0],
      { id: "crimpA", a: { x: 0, y: 0.3 }, b: { x: 0.3, y: 0.6 }, angle: PI, step: 2, reverse: "inside" },
      { id: "crimpB", a: { x: 0, y: 0.55 }, b: { x: 0.3, y: 0.85 }, angle: PI, step: 2, reverse: "inside" },
    ], HELD, 0.01);
    expect(seq.steps).toBe(2);
    expect(seq.layers?.length).toBe(2);
  });
});
