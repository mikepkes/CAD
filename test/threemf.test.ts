// The 3MF writer: a valid stored zip (CRC-32 checked against the standard
// check value), welded watertight meshes, and one object gathering the parts.
import { describe, it, expect } from "vitest";
import { crc32, meshesTo3mf, weld } from "../src/core/export/threemf";
import { readStoredZip, modelObjects, openEdges } from "./threemf-read";

/** A box as a display mesh would give it: four vertices of its own per face. */
function box(x0: number, y0: number, z0: number, s: number) {
  const positions: number[] = [], indices: number[] = [];
  const faces = [
    [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
    [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
    [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
  ];
  for (const f of faces) {
    const b = positions.length / 3;
    for (const [i, j, k] of f) positions.push(x0 + i * s, y0 + j * s, z0 + k * s);
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  return { positions, indices };
}

describe("3MF export", () => {
  it("CRC-32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("welds a display mesh's per-face vertices into a closed solid", () => {
    const b = box(0, 0, 0, 1);
    const w = weld(b.positions, b.indices);
    expect(w.vertices.length / 3).toBe(8);
    expect(w.triangles.length / 3).toBe(12);
  });

  it("writes one object made of a part per material, each watertight, named and coloured", () => {
    const bytes = meshesTo3mf([
      { name: "TPU", color: "#e9b949", ...box(0, 0, 0, 10) },
      { name: "PLA & co", color: "#5b8def", ...box(2, 2, 2, 4) },
    ], "switch");
    const files = readStoredZip(bytes);
    expect(Object.keys(files).sort()).toEqual(["3D/3dmodel.model", "[Content_Types].xml", "_rels/.rels"]);
    expect(files["_rels/.rels"]).toContain('Target="/3D/3dmodel.model"');
    const xml = files["3D/3dmodel.model"];
    expect(xml).toContain('unit="millimeter"');
    expect(xml).toContain('<base name="TPU" displaycolor="#E9B949FF"/>');
    expect(xml).toMatch(/<object id="4" type="model" name="switch"><components>\s*<component objectid="2"\/>\s*<component objectid="3"\/>/);
    expect(xml).toMatch(/<build><item objectid="4"\/><\/build>/);
    const objects = modelObjects(xml);
    expect(objects.map((o) => o.name)).toEqual(["TPU", "PLA & co"]);
    for (const o of objects) expect(openEdges(o)).toBe(0);
    expect(objects[1].min).toEqual({ x: 2, y: 2, z: 2 }); // in place, not re-centred
  });
});
