import { describe, it, expect } from "vitest";
import { meshFacets, meshHinges, dihedral, bendPath, hingeStiffness, fitPanel } from "../src/core/sheetBend";
import { applyPoint } from "../src/math/transform";
import { planSequence, poseSequence, sequenceAngles, sequenceFaces } from "../src/core/sheetSequence";

describe("bending paper (sheetBend)", () => {
  it("measures a fold valley-positive, with the gradient the angle really has", () => {
    // a → b along x, c to the left (+y), d to the right; d raised: both halves turn toward the top
    const x = Float64Array.from([0, 0, 0, 1, 0, 0, 0.4, 1, 0.1, 0.6, -0.8, 0.5]);
    const h = { a: 0, b: 1, c: 2, d: 3 };
    const { th, g } = dihedral(x, h);
    expect(th).toBeGreaterThan(0);
    const e = 1e-6;
    for (let v = 0; v < 4; v++) for (let p = 0; p < 3; p++) {
      const y = Float64Array.from(x); y[3 * v + p] += e;
      const z = Float64Array.from(x); z[3 * v + p] -= e;
      const fd = (dihedral(y, h).th - dihedral(z, h).th) / (2 * e);
      expect(fd).toBeCloseTo([g[v].x, g[v].y, g[v].z][p], 5);
    }
    // folded past flat it keeps counting (unwrapped from where it was)
    const flat = Float64Array.from([0, 0, 0, 1, 0, 0, 0.5, 1, 0, 0.5, 1, 0.01]);
    expect(dihedral(flat, h, 3).th).toBeGreaterThan(3);
  });

  it("meshes facets that meet at a T-junction into one conforming mesh, no edge longer than asked", () => {
    const polys = [[{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 1 }], [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 0, y: 2 }], [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }]];
    const m = meshFacets(polys, 0.4, 1e-9);
    let area = 0;
    for (const [a, b, c] of m.tris) {
      const A = m.verts[a], B = m.verts[b], C = m.verts[c], ar = ((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)) / 2;
      expect(ar).toBeGreaterThan(0); // CCW, none degenerate
      area += ar;
      for (const [u, v] of [[A, B], [B, C], [C, A]]) expect(Math.hypot(u.x - v.x, u.y - v.y)).toBeLessThanOrEqual(0.4 + 1e-9);
    }
    expect(area).toBeCloseTo(4, 9);
    // conforming: every interior edge has a triangle each side (only the outline's edges are single)
    const hinges = meshHinges(m.tris), edges = m.tris.length * 3;
    const outline = edges - 2 * hinges.length;
    let perimeter = 0;
    const half = new Set(m.tris.flatMap((T) => [0, 1, 2].map((i) => `${T[i]},${T[(i + 1) % 3]}`)));
    for (const T of m.tris) for (let i = 0; i < 3; i++) if (!half.has(`${T[(i + 1) % 3]},${T[i]}`)) { const A = m.verts[T[i]], B = m.verts[T[(i + 1) % 3]]; perimeter += Math.hypot(A.x - B.x, A.y - B.y); }
    expect(perimeter).toBeCloseTo(8, 9);
    expect(outline).toBeGreaterThan(0);
  });

  it("folds a strip about a driven crease, the rest of it staying flat and unstretched", () => {
    // a 4 × 1 strip creased across at x = 2, held at the left end: the crease driven to 90° valley
    const polys = [[{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 1 }], [{ x: 2, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 1 }, { x: 2, y: 1 }]];
    const m = meshFacets(polys, 0.5, 1e-9);
    const hinges = meshHinges(m.tris).map((h) => {
      const A = m.verts[h.a], B = m.verts[h.b], crease = Math.abs(A.x - 2) < 1e-9 && Math.abs(B.x - 2) < 1e-9;
      return { ...h, k: hingeStiffness(m.verts, h) * (crease ? 1000 : 1), rest: 0, ...(crease ? { to: Math.PI / 2 } : {}) };
    });
    const x0 = Float64Array.from(m.verts.flatMap((p) => [p.x, p.y, 0]));
    const fixed = m.verts.map((p, i) => (p.x < 0.6 ? i : -1)).filter((i) => i >= 0);
    const path = bendPath({ flat: m.verts, tris: m.tris, x0, hinges, fixed, thickness: 0.01 }, 8);
    const end = path[path.length - 1];
    // the far end stands straight up from the crease
    m.verts.forEach((p, i) => {
      if (p.x < 2 - 1e-9) { expect(end[3 * i + 2]).toBeCloseTo(0, 3); return; }
      expect(end[3 * i]).toBeCloseTo(2, 2);
      expect(end[3 * i + 2]).toBeCloseTo(p.x - 2, 2);
    });
    // and every panel lands where its corners are
    for (const [a, b, c] of m.tris) {
      const X = [a, b, c].map((i) => ({ x: end[3 * i], y: end[3 * i + 1], z: end[3 * i + 2] })) as [any, any, any];
      const T = fitPanel([m.verts[a], m.verts[b], m.verts[c]], X);
      [a, b, c].forEach((i, k) => { const q = applyPoint(T, { ...m.verts[i], z: 0 }); expect(Math.hypot(q.x - X[k].x, q.y - X[k].y, q.z - X[k].z)).toBeLessThan(1e-3); });
    }
  });

  it("runs as a step of a sequence: the panels posed, joined, the seams no fold lines", () => {
    // a square folded in half (step 1), then a bending collapse (step 2) opening that fold to 90°
    const sq = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];
    const seq = planSequence(sq, [
      { id: "half", a: { x: 0, y: -1 }, b: { x: 0, y: 1 }, angle: Math.PI, step: 1 },
      { id: "open", a: { x: 0, y: -1 }, b: { x: 0, y: 1 }, angle: Math.PI / 2, step: 2, collapse: true, bend: true },
    ], { x: -0.5, y: 0 }, 0.01);
    expect(seq.facets.length).toBeGreaterThan(10); // meshed
    expect(seq.creases.some((c) => c.bend)).toBe(true);
    for (const s of [1, 1.5, 2]) {
      const T = poseSequence(seq, sequenceAngles(seq, s));
      for (const c of seq.creases) for (const q of [c.a, c.b]) {
        const a = applyPoint(T[c.facets[0]], { ...q, z: 0 }), b = applyPoint(T[c.facets[1]], { ...q, z: 0 });
        expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(0.02);
      }
    }
    // done: the right half stands square to the left (which is held flat)
    const T = poseSequence(seq, sequenceAngles(seq, 2));
    const at = (x: number, y: number) => seq.facets.findIndex((f) => f.poly.every((p, i) => { const r = f.poly[(i + 1) % f.poly.length]; return (r.x - p.x) * (y - p.y) - (r.y - p.y) * (x - p.x) >= -1e-9; }));
    expect(Math.abs(T[at(-0.5, 0.1)].z.z)).toBeCloseTo(1, 2);
    expect(Math.abs(T[at(0.5, 0.1)].z.z)).toBeLessThan(0.05);
    // before the step the sheet's halves are each one face; after it, panels apart where the paper bent (a seam
    // that ends flat merges back into its face)
    expect(sequenceFaces(seq, sequenceAngles(seq, 1)).length).toBe(2);
    expect(sequenceFaces(seq, sequenceAngles(seq, 2)).length).toBeGreaterThanOrEqual(2);
    expect(sequenceFaces(seq, sequenceAngles(seq, 1.5)).length).toBeGreaterThan(2);
  });
});
