import { describe, it, expect } from "vitest";
import { makeThreadNormalMap } from "../src/viewport/threadTexture";
import type { ThreadDecal } from "../src/core/document";

const decal = (over: Partial<ThreadDecal> = {}): ThreadDecal => ({
  at: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 }, radius: 5, length: 16, form: "metric", pitch: 1.5, ...over,
});

describe("thread normal map", () => {
  it("builds an RGBA normal map that actually varies (not a flat surface)", () => {
    const tex = makeThreadNormalMap(decal({ length: 16 }));
    expect(tex.image.width).toBe(512);
    expect(tex.image.height).toBe(128); // one pitch tall (single start)
    expect(tex.repeat.y).toBeCloseTo(16 / 1.5, 4); // tiled length/lead times
    const d = tex.image.data as Uint8Array;
    // Blue ≈ 255 (normals point mostly outward); green (axial tilt) swings around 128.
    let minG = 255, maxG = 0;
    for (let i = 1; i < d.length; i += 4) { minG = Math.min(minG, d[i]); maxG = Math.max(maxG, d[i]); }
    expect(maxG - minG).toBeGreaterThan(40); // the flanks tilt the normal in V
    expect(tex.userData.depth).toBeCloseTo(0.6134 * 1.5, 3);
  });

  it("a multi-start thread's tile is one lead tall", () => {
    const tex = makeThreadNormalMap(decal({ starts: 2, length: 20 }));
    expect(tex.image.height).toBe(256);          // 128 per pitch × 2 starts
    expect(tex.repeat.y).toBeCloseTo(20 / (1.5 * 2), 4);
  });

  it("every form produces a valid map", () => {
    for (const form of ["metric", "unified", "acme", "trapezoidal", "square", "buttress", "ballscrew"] as const) {
      const tex = makeThreadNormalMap(decal({ form, pitch: 2 }));
      expect(tex.image.data.length).toBe(512 * (tex.image.height as number) * 4);
    }
  });
});
