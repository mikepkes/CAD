import { describe, it, expect } from "vitest";
import { meshesToThreeMF } from "../src/core/export/threemf";

const tri = (name: string) => ({ name, positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]), indices: new Uint32Array([0, 1, 2]) });

describe("3MF export", () => {
  it("writes a zip (OPC) package with the three required parts", () => {
    const z = meshesToThreeMF([tri("Ring 1"), tri("Ring 2")]);
    // local file header signature "PK\x03\x04"
    expect([z[0], z[1], z[2], z[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
    const eocd = z.length - 22; // no archive comment
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50); // end-of-central-dir signature
    expect(dv.getUint16(eocd + 10, true)).toBe(3);       // three entries
    const text = new TextDecoder("utf-8").decode(z);     // stored (uncompressed) → readable
    expect(text).toContain("[Content_Types].xml");
    expect(text).toContain("_rels/.rels");
    expect(text).toContain("3D/3dmodel.model");
    expect(text).toContain('unit="millimeter"');
    expect((text.match(/<object /g) || []).length).toBe(2); // one object per body
    expect(text).toContain('name="Ring 1"');
  });

  it("escapes XML-special characters in body names", () => {
    const z = meshesToThreeMF([tri('A & <B>')]);
    const text = new TextDecoder("utf-8").decode(z);
    expect(text).toContain("A &amp; &lt;B&gt;");
  });

  it("handles a real-sized mesh without overflowing the stack", () => {
    // Regression: the zip writer must never spread a mesh-sized array into a
    // call (that throws RangeError: Maximum call stack size exceeded on real
    // geometry, while 3-vertex fixtures pass). 60k vertices ≈ a printable part.
    const n = 60000;
    const positions = new Float32Array(n * 3).map((_, i) => i * 0.001);
    const indices = new Uint32Array(n).map((_, i) => i);
    const z = meshesToThreeMF([{ name: "big", positions, indices }]);
    expect([z[0], z[1], z[2], z[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
    expect(dv.getUint32(z.length - 22, true)).toBe(0x06054b50); // valid EOCD at the end
  });
});
