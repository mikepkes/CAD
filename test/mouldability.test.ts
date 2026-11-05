// The two-plate mould check (src/viewport/mouldability.ts): which faces each half forms, walls that need
// draft, and true undercuts — faces with material in the way of the half that would form them.
import { describe, it, expect } from "vitest";
import { mouldFlags, mouldSummary, MOULD } from "../src/viewport/mouldability";

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
    expect(at(m, f, 0, 10, 0)).toBe(MOULD.ok);   // bottom: the core
    expect(at(m, f, 0, 0, 0)).toBe(MOULD.steep); // a vertical wall
    expect(mouldSummary([m], [f])).toEqual({ ok: 4, steep: 8, undercut: 0 });
  });

  it("a lip over air is formed by the core; a lip over the plate is an undercut", () => {
    const plate = box(0, 0, 0, 20, 10, 4);
    const post = box(20, 4, 0, 23, 6, 8);          // a post off the rim, outboard
    const lipOut = box(23, 4, 6, 26, 6, 8);        // its lip hangs over air (x 23–26)
    const lipIn = box(10, 4, 6, 13, 6, 8);         // a lip over the plate's top at x 10–13, z 6: material (the plate) below
    const flags = mouldFlags([plate, post, lipOut, lipIn], Z, 1);
    expect(at(lipOut, flags[2], 23, 6, 6)).toBe(MOULD.ok);       // underside over air: the core reaches it
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
