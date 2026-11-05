// The two-plate mould check (src/viewport/mouldability.ts): which faces each half forms, walls that need
// draft, and true undercuts — faces with material in the way of the half that would form them.
import { describe, it, expect } from "vitest";
import { mouldFlags, mouldCheck, partingSegments, mouldSummary, MOULD } from "../src/viewport/mouldability";

/** An axis-aligned box as a 12-triangle mesh with outward winding. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
  const P: number[] = [], I: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => { const k = P.length / 3; P.push(...a, ...b, ...c, ...d); I.push(k, k + 1, k + 2, k, k + 2, k + 3); };
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // top (+z)
  quad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]); // bottom (−z)
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // −y
  quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]); // +y
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]); // +x
  quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]); // −x
  return { positions: new Float32Array(P), indices: new Uint32Array(I) };
}
const Z = { x: 0, y: 0, z: 1 };
/** The verdict of the triangle whose first vertex is at (x, y, z). */
const at = (m: { positions: Float32Array; indices: Uint32Array }, f: Float32Array, x: number, y: number, z: number) => {
  for (let t = 0; t < m.indices.length; t += 3) {
    const i = m.indices[t] * 3;
    if (m.positions[i] === x && m.positions[i + 1] === y && m.positions[i + 2] === z) return f[m.indices[t]];
  }
  throw new Error("no such vertex");
};

describe("mouldFlags", () => {
  it("a plain block: top and bottom are formed, the walls need draft", () => {
    const m = box(0, 0, 0, 10, 10, 4);
    const [f] = mouldFlags([m], Z, 1);
    expect(at(m, f, 0, 0, 4)).toBe(MOULD.ok);    // top: the cavity
    expect(at(m, f, 0, 10, 0)).toBe(MOULD.core); // bottom: the core
    expect(at(m, f, 0, 0, 0)).toBe(MOULD.steep); // a vertical wall
    expect(mouldSummary([m], [f])).toEqual({ ok: 4, steep: 8, undercut: 0 });
  });

  it("a lip over air is formed by the core; a lip over the plate is an undercut", () => {
    const plate = box(0, 0, 0, 20, 10, 4);
    const post = box(20, 4, 0, 23, 6, 8);          // a post off the rim, outboard
    const lipOut = box(23, 4, 6, 26, 6, 8);        // its lip hangs over air (x 23–26)
    const lipIn = box(10, 4, 6, 13, 6, 8);         // a lip over the plate's top at x 10–13, z 6: material (the plate) below
    const flags = mouldFlags([plate, post, lipOut, lipIn], Z, 1);
    expect(at(lipOut, flags[2], 23, 6, 6)).toBe(MOULD.core);     // underside over air: the core reaches it
    expect(at(lipIn, flags[3], 10, 6, 6)).toBe(MOULD.undercut);  // underside over the plate: nothing reaches it
    expect(at(plate, flags[0], 0, 0, 4)).toBe(MOULD.ok);         // the plate top where nothing is above
  });

  it("the walls of a sideways blind pocket are boxed in: an undercut, not just steep", () => {
    // a block with a cap over a pocket: the pocket's roof looks down with material below (the block) and
    // the floor looks up with the cap above — both undercut
    const block = box(0, 0, 0, 10, 10, 4);
    const cap = box(0, 0, 6, 10, 10, 8);
    const flags = mouldFlags([block, cap], Z, 1);
    expect(at(block, flags[0], 0, 0, 4)).toBe(MOULD.undercut); // block top, under the cap
    expect(at(cap, flags[1], 0, 10, 6)).toBe(MOULD.undercut);  // cap underside, over the block
    expect(at(cap, flags[1], 0, 0, 8)).toBe(MOULD.ok);         // cap top: open above
  });

  it("the pull direction can be any axis", () => {
    const m = box(0, 0, 0, 4, 10, 10);
    const [f] = mouldFlags([m], { x: 1, y: 0, z: 0 }, 1);
    expect(at(m, f, 4, 0, 0)).toBe(MOULD.ok);    // +x face: the cavity
    expect(at(m, f, 0, 0, 10)).toBe(MOULD.steep); // the top is now a wall along the pull
  });
});

describe("mouldFlags on a drafted round", () => {
  it("a 1° cone's facets never shut each other off: the rim is formed, not undercut", () => {
    // a frustum, r 14 at the bottom to 14 − 4·tan 1° at the top, as a 64-sided display mesh with
    // triangles whose normals jitter about the true cone normal
    const N = 64, h = 4, r0 = 14, r1 = 14 - h * Math.tan(Math.PI / 180);
    const P: number[] = [], I: number[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * 2 * Math.PI;
      P.push(r0 * Math.cos(a), r0 * Math.sin(a), 0, r1 * Math.cos(a), r1 * Math.sin(a), h);
    }
    P.push(0, 0, 0, 0, 0, h);
    const bc = 2 * N, tc = 2 * N + 1;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N, b0 = 2 * i, t0 = 2 * i + 1, b1 = 2 * j, t1 = 2 * j + 1;
      I.push(b0, b1, t1, b0, t1, t0);   // the side, outward
      I.push(bc, b1, b0);                // the bottom, facing −z
      I.push(tc, t0, t1);                // the top, facing +z
    }
    const m = { positions: new Float32Array(P), indices: new Uint32Array(I) };
    const [f] = mouldFlags([m], Z, 0.5);
    const s = mouldSummary([m], [f]);
    expect(s.undercut).toBe(0);
    expect(s.ok).toBeGreaterThanOrEqual(2 * N); // the ends, and the drafted side where its facets clear the threshold
  });
});

describe("mouldFlags with face ranges", () => {
  it("classifies a 1° cone's facets by their face: none is steep at a 0.5° threshold", () => {
    const N = 48, h = 4, r0 = 14, r1 = 14 - h * Math.tan(Math.PI / 180);
    const P: number[] = [], I: number[] = [];
    for (let i = 0; i < N; i++) { const a = (i / N) * 2 * Math.PI; P.push(r0 * Math.cos(a), r0 * Math.sin(a), 0, r1 * Math.cos(a), r1 * Math.sin(a), h); }
    for (let i = 0; i < N; i++) { const j = (i + 1) % N; I.push(2 * i, 2 * j, 2 * j + 1, 2 * i, 2 * j + 1, 2 * i + 1); }
    const m = { positions: new Float32Array(P), indices: new Uint32Array(I), faceRanges: [0, I.length] };
    const s = mouldSummary([m], mouldFlags([m], Z, 0.5));
    expect(s.steep).toBe(0);
    expect(s.undercut).toBe(0);
    expect(s.ok).toBe(2 * N);
  });
});

describe("the parting line", () => {
  it("runs round a barrel where its upper cone meets its lower one, and a plain block has none", () => {
    // a barrel: r 14 at mid-height, 1° in to each face, as two cones (two faces) sharing their vertices at the ridge
    const N = 32, h = 4, r1 = 14 - (h / 2) * Math.tan(Math.PI / 180), r0 = 14;
    const P: number[] = [], lower: number[] = [], upper: number[] = [], caps: number[] = [];
    for (let i = 0; i < N; i++) { const a = (i / N) * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a); P.push(r1 * c, r1 * s, 0, r0 * c, r0 * s, h / 2, r1 * c, r1 * s, h); }
    P.push(0, 0, 0, 0, 0, h);
    const bc = 3 * N, tc = 3 * N + 1;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      lower.push(3 * i, 3 * j, 3 * j + 1, 3 * i, 3 * j + 1, 3 * i + 1);
      upper.push(3 * i + 1, 3 * j + 1, 3 * j + 2, 3 * i + 1, 3 * j + 2, 3 * i + 2);
      caps.push(bc, 3 * j, 3 * i, tc, 3 * i + 2, 3 * j + 2);
    }
    const I = [...lower, ...upper, ...caps];
    const m = { positions: new Float32Array(P), indices: new Uint32Array(I), faceRanges: [0, lower.length, lower.length, upper.length] };
    const { flags, sides } = mouldCheck([m], Z, 0.5);
    expect(mouldSummary([m], flags).steep).toBe(0); // the ridge's triangles read as their cones, not as a seam
    const seg = partingSegments([m], sides);
    expect(seg.length / 6).toBe(N); // one segment per ridge edge
    for (let k = 0; k < seg.length; k += 3) expect(seg[k + 2]).toBeCloseTo(h / 2, 6); // all at the ridge
    const block = box(0, 0, 0, 10, 10, 4);
    const b = mouldCheck([block], Z, 1);
    expect(partingSegments([block], b.sides).length).toBe(0); // its walls are steep: no cavity/core edge
  });
});
