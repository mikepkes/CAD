// Folding in steps (core/sheetSequence.ts), as pure geometry: folds through the
// layers earlier folds stacked, layers kept a gap apart, the flap rule, turns,
// and the posing, meshing and checking the viewport and the examples use.
import { describe, it, expect } from "vitest";
import { planSequence, sequenceAngles, poseSequence, sequenceClashes, sequenceFaces, sequenceMesh, sequenceUVs, polyArea, SeqFoldDef } from "../src/core/sheetSequence";
import { applyPoint, IDENTITY } from "../src/math/transform";

const PI = Math.PI;
const rect = (w: number, h: number) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
/** Fold a 100 × 60 sheet in half (x = 50, the right half over), then in half again (y = 30) through both layers. */
const twice = (second: Partial<SeqFoldDef> = {}): SeqFoldDef[] => [
  { id: "half", a: { x: 50, y: 0 }, b: { x: 50, y: 60 }, angle: PI, step: 1 },
  { id: "quarter", a: { x: 0, y: 30 }, b: { x: 50, y: 30 }, angle: PI, step: 2, ...second },
];
const centre = (poly: { x: number; y: number }[]) => poly.reduce((a, p) => ({ x: a.x + p.x / poly.length, y: a.y + p.y / poly.length }), { x: 0, y: 0 });
const sweepClear = (seq: ReturnType<typeof planSequence>, steps: number) => {
  const bad: number[] = [];
  for (let k = 0; k <= steps * 50; k++) if (sequenceClashes(seq, sequenceAngles(seq, k / 50), 0.5).length) bad.push(k / 50);
  return bad;
};

describe("folding in steps", () => {
  it("folds in half, then in half again through both layers: four layers a gap apart", () => {
    const seq = planSequence(rect(100, 60), twice(), { x: 10, y: 10 }, 0.1);
    expect(seq.facets.length).toBe(4);
    expect(seq.facets.reduce((s, f) => s + polyArea(f.poly), 0)).toBeCloseTo(6000, 9);
    // the second fold creased both layers: its line on each, valley on one and mountain on the other (seen from the paper's top)
    const q = seq.creases.filter((c) => c.folds.includes(1));
    expect(q.length).toBe(2);
    expect(q.map((c) => Math.sign(c.angle)).sort()).toEqual([-1, 1]);
    for (const c of q) { expect(c.a.y).toBeCloseTo(30, 9); expect(c.b.y).toBeCloseTo(30, 9); }
    // done: every facet over the held quarter, each layer on its own level
    const T = poseSequence(seq, sequenceAngles(seq));
    const levels = seq.facets.map((f, i) => {
      const c = applyPoint(T[i], { ...centre(f.poly), z: 0 });
      expect(c.x).toBeGreaterThan(0); expect(c.x).toBeLessThan(50);
      expect(c.y).toBeGreaterThan(0); expect(c.y).toBeLessThan(30);
      expect(Math.abs(T[i].z.z)).toBeCloseTo(1, 9);
      return c.z;
    }).sort((a, b) => a - b);
    expect(levels[0]).toBeCloseTo(0, 9);
    for (let i = 1; i < 4; i++) expect(levels[i] - levels[i - 1]).toBeGreaterThanOrEqual(0.1 - 1e-9);
    expect(levels[3]).toBeLessThan(0.5);
    expect(sweepClear(seq, 2)).toEqual([]);
  });

  it("a fold along a line through stacked layers carries the layers inside the flap with it", () => {
    // the second fold drawn on the bottom layer, but folding down (mountain): the top layer is inside the fold's way
    const seq = planSequence(rect(100, 60), twice({ angle: -PI }), { x: 10, y: 10 }, 0.1);
    expect(seq.facets.length).toBe(4);
    expect(sweepClear(seq, 2)).toEqual([]);
  });

  it("folds only the flap: a corner of the top layer, the layer under it uncreased", () => {
    const seq = planSequence(rect(100, 60), [
      { id: "half", a: { x: 50, y: 0 }, b: { x: 50, y: 60 }, angle: PI, step: 1 },
      // drawn on the right half (the top layer once folded, face down): its corner folds up and back
      // over it — a mountain seen from that layer's own top
      { id: "corner", a: { x: 80, y: 60 }, b: { x: 100, y: 40 }, angle: -PI, step: 2 },
    ], { x: 10, y: 10 }, 0.1);
    expect(seq.creases.filter((c) => c.folds.includes(1)).length).toBe(1); // one layer creased
    expect(seq.facets.length).toBe(3);
    expect(sweepClear(seq, 2)).toEqual([]);
    // folded the other way (down, into the layer under it) it takes that layer along: both creased
    const into = planSequence(rect(100, 60), [
      { id: "half", a: { x: 50, y: 0 }, b: { x: 50, y: 60 }, angle: PI, step: 1 },
      { id: "corner", a: { x: 80, y: 60 }, b: { x: 100, y: 40 }, angle: PI, step: 2 },
    ], { x: 10, y: 10 }, 0.1);
    expect(into.creases.filter((c) => c.folds.includes(1)).length).toBe(2);
    expect(sweepClear(into, 2)).toEqual([]);
  });

  it("turns the whole model over without creasing it", () => {
    const seq = planSequence(rect(100, 60), [
      { id: "half", a: { x: 50, y: 0 }, b: { x: 50, y: 60 }, angle: PI, step: 1 },
      { id: "over", a: { x: 0, y: 30 }, b: { x: 100, y: 30 }, angle: PI, step: 2, turn: true },
    ], { x: 10, y: 10 }, 0.1);
    expect(seq.facets.length).toBe(2);
    expect(seq.creases.length).toBe(1);
    const T = poseSequence(seq, sequenceAngles(seq));
    for (const t of T) expect(Math.abs(t.z.z)).toBeCloseTo(1, 9);
    // the held facet now faces down: turned over
    const held = seq.facets.findIndex((f) => centre(f.poly).x < 50);
    expect(T[held].z.z).toBeCloseTo(-1, 9);
    expect(sweepClear(seq, 2)).toEqual([]);
  });

  it("names what's wrong: the held part in the flap, two folds of one step moving the same paper, a concave sheet", () => {
    expect(() => planSequence(rect(100, 60), [{ id: "f", a: { x: 50, y: 0 }, b: { x: 50, y: 60 }, angle: PI, step: 1, flip: true }], { x: 10, y: 10 }, 0.1))
      .toThrow(/held by/);
    expect(() => planSequence(rect(100, 60), [
      { id: "a", a: { x: 50, y: 0 }, b: { x: 50, y: 60 }, angle: PI, step: 1 },
      { id: "b", a: { x: 75, y: 0 }, b: { x: 75, y: 60 }, angle: PI, step: 1 },
    ], { x: 10, y: 10 }, 0.1)).toThrow(/move the same paper/);
    expect(() => planSequence([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 20 }, { x: 100, y: 60 }, { x: 0, y: 60 }], [], { x: 10, y: 10 }, 0.1)).toThrow(/convex/);
  });

  it("the steps run on one progress value, eased, one at a time", () => {
    const seq = planSequence(rect(100, 60), twice(), { x: 10, y: 10 }, 0.1);
    expect(sequenceAngles(seq, 0)).toEqual([0, 0]);
    expect(sequenceAngles(seq, 0.5)[0]).toBeCloseTo(PI / 2, 12);
    expect(sequenceAngles(seq, 0.5)[1]).toBe(0);
    expect(sequenceAngles(seq, 1)).toEqual([PI, 0]);
    expect(sequenceAngles(seq, 1.25)[1]).toBeCloseTo(PI * 0.15625, 12); // smoothstep(¼)
    expect(sequenceAngles(seq, 9)).toEqual([PI, PI]);
  });

  it("is one flat face until a crease is made; then a face per side of each made crease", () => {
    const seq = planSequence(rect(100, 60), twice(), { x: 10, y: 10 }, 0.1);
    const flat = sequenceFaces(seq, sequenceAngles(seq, 0));
    expect(flat.length).toBe(1);
    expect(flat[0].loops.length).toBe(1);
    expect(Math.abs(polyArea(flat[0].loops[0]))).toBeCloseTo(6000, 9);
    expect(flat[0].loops[0].length).toBe(4); // the corners only: no vertex left on a straight edge
    expect(sequenceFaces(seq, sequenceAngles(seq, 1)).length).toBe(2);
    expect(sequenceFaces(seq, sequenceAngles(seq, 2)).length).toBe(4);
  });

  it("meshes a pose: front faces on the paper's top, flat coordinates as uvs, edges for the creases made", () => {
    const seq = planSequence(rect(100, 60), twice(), { x: 10, y: 10 }, 0.1);
    const flat = sequenceMesh(seq, sequenceAngles(seq, 0), IDENTITY);
    expect(flat.indices.length / 3).toBe(seq.facets.reduce((s, f) => s + f.poly.length - 2, 0));
    for (let i = 0; i < flat.positions.length / 3; i++) {
      expect(flat.positions[3 * i]).toBeCloseTo(flat.uvs[2 * i], 4);
      expect(flat.positions[3 * i + 1]).toBeCloseTo(flat.uvs[2 * i + 1], 4);
      expect(flat.normals[3 * i + 2]).toBe(1);
    }
    // CCW seen from +z: the front faces up
    const [a, b, c] = [0, 1, 2].map((k) => flat.indices[k]);
    const P = (i: number) => ({ x: flat.positions[3 * i], y: flat.positions[3 * i + 1] });
    expect((P(b).x - P(a).x) * (P(c).y - P(a).y) - (P(b).y - P(a).y) * (P(c).x - P(a).x)).toBeGreaterThan(0);
    const done = sequenceMesh(seq, sequenceAngles(seq, 2), IDENTITY);
    expect(done.edges.length / 6 - flat.edges.length / 6).toBe(seq.creases.length);
    // and back: the flat point under each vertex of the posed mesh
    const uv = sequenceUVs(seq, sequenceAngles(seq, 2), IDENTITY, done.positions);
    for (let i = 0; i < uv.length; i++) expect(uv[i]).toBeCloseTo(done.uvs[i], 3);
  });
});

describe("folding in steps: collapses", () => {
  // a 60 × 60 corner of a box: the floor held, one wall already up (a step of its own), then a collapse raises the
  // other — driven — while the corner square between them folds in on its diagonal, solved so the paper stays joined
  const sq = [{ x: -40, y: -40 }, { x: 20, y: -40 }, { x: 20, y: 20 }, { x: -40, y: 20 }];
  const corner = (extra: Partial<SeqFoldDef> = {}): SeqFoldDef[] => [
    { id: "wallA", a: { x: -40, y: 0 }, b: { x: 0, y: 0 }, angle: PI / 2, step: 1, collapse: true },
    { id: "wallB", a: { x: 0, y: -40 }, b: { x: 0, y: 0 }, angle: PI / 2, step: 2, collapse: true, ...extra },
    { id: "edgeA", a: { x: 0, y: 0 }, b: { x: 0, y: 20 }, angle: 1, step: 2, collapse: true, solve: true },
    { id: "edgeB", a: { x: 0, y: 0 }, b: { x: 20, y: 0 }, angle: 0, step: 2, collapse: true, solve: true },
    { id: "diag", a: { x: 0, y: 0 }, b: { x: 20, y: 20 }, angle: 1, step: 2, collapse: true, solve: true },
  ];
  const gapAt = (seq: ReturnType<typeof planSequence>, p: number) => {
    const T = poseSequence(seq, sequenceAngles(seq, p));
    let worst = 0;
    for (const c of seq.creases) for (const q of [c.a, c.b]) {
      const a = applyPoint(T[c.facets[0]], { ...q, z: 0 }), b = applyPoint(T[c.facets[1]], { ...q, z: 0 });
      worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
    }
    return worst;
  };

  it("raises a box's wall while its corner folds in, the paper joined all the way", () => {
    const seq = planSequence(sq, corner(), { x: -20, y: -20 }, 0.1);
    expect(seq.collapses?.map((c) => c.step)).toEqual([1, 2]);
    // (within half a millimetre: the corner starts from a fold that can open either way, where the solve takes a
    // sample or two to settle onto the path)
    for (let k = 0; k <= 40; k++) expect(gapAt(seq, k / 20), `fold ${k / 20}`).toBeLessThan(0.5);
    expect(sweepClear(seq, 2)).toEqual([]);
    // done: both walls stand square to the floor, and the corner's two halves lie on each other
    const T = poseSequence(seq, sequenceAngles(seq));
    const facetAt = (x: number, y: number) => seq.facets.findIndex((f) => f.poly.every((a, i) => { const b = f.poly[(i + 1) % f.poly.length]; return (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) >= -1e-9; }));
    expect(Math.abs(T[facetAt(-20, 10)].z.z)).toBeLessThan(1e-6);
    expect(Math.abs(T[facetAt(10, -20)].z.z)).toBeLessThan(1e-6);
    expect(Math.abs(dot(T[facetAt(15, 5)].z, T[facetAt(5, 15)].z))).toBeCloseTo(1, 6);
    // part-way, the corner is folded part-way too: neither flat nor closed
    const half = poseSequence(seq, sequenceAngles(seq, 1.5));
    expect(Math.abs(dot(half[facetAt(15, 5)].z, half[facetAt(5, 15)].z))).toBeLessThan(0.99);
  });

  it("carries a crease through a stack, the stack turning as one", () => {
    // a strip folded in half, then the doubled end turned back over a crease drawn on the bottom layer only
    const seq = planSequence(rect(100, 20), [
      { id: "half", a: { x: 50, y: 0 }, b: { x: 50, y: 20 }, angle: PI, step: 1 },
      { id: "end", a: { x: 30, y: 0 }, b: { x: 30, y: 20 }, angle: PI, step: 2, collapse: true, through: "both" },
    ], { x: 45, y: 10 }, 0.1);
    // both layers creased there: on the bottom layer at x = 30, and on the folded one where it lies over it (x = 70)
    const xs = seq.creases.filter((c) => c.folds.some((j) => seq.folds[j].id.startsWith("end"))).map((c) => Math.round(c.a.x)).sort();
    expect(xs).toEqual([30, 70]);
    expect(sweepClear(seq, 2)).toEqual([]);
    for (let k = 0; k <= 40; k++) expect(gapAt(seq, k / 20), `fold ${k / 20}`).toBeLessThan(1);
  });

  it("names what it can't do: a collapse needs a driven crease; its folds are its own step", () => {
    expect(() => planSequence(sq, corner({ angle: 1, solve: true }), { x: -20, y: -20 }, 0.1)).toThrow(/driven/);
    expect(() => planSequence(sq, [...corner(), { id: "plain", a: { x: -40, y: -30 }, b: { x: 20, y: -30 }, angle: PI, step: 2 }], { x: -20, y: -20 }, 0.1)).toThrow(/step of its own/);
  });
});

const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => a.x * b.x + a.y * b.y + a.z * b.z;
