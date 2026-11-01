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
