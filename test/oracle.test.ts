import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import type { CadSession } from "../src/core/command/session";

// Reference-value ("oracle") suite: every feature kind is built through the
// command layer and its exact B-rep mass properties are checked against a
// closed-form answer — volume, surface area and centroid. Kernel upgrades,
// tolerance changes and feature-code refactors that bend geometry fail here
// before they reach a user's part.

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
const PI = Math.PI;

interface Expected { volume: number; area?: number; centroid?: { x?: number; y?: number; z?: number } }
interface Case { name: string; build: (s: CadSession) => Promise<unknown>; expect: Expected; /** relative tolerance (default 1e-6) */ tol?: number }

async function sketch(s: CadSession, params: Record<string, unknown> = { plane: "XY" }): Promise<string> {
  return (await s.dispatch("sketch.create", params)).createdIds[0];
}
async function rect(s: CadSession, sid: string, x0: number, y0: number, x1: number, y1: number) {
  await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: x0, y: y0 }, opposite: { x: x1, y: y1 } });
}
const box = (s: CadSession, x: number, y: number, z: number, at = { x: 0, y: 0, z: 0 }, extra: Record<string, unknown> = {}) =>
  s.dispatch("feature.primitive", { shape: "box", x, y, z, at, ...extra });

// Minkowski-rounded box (all 12 edges filleted at r, spherical corners): inner box a'b'c' grown by r.
const rounded = (a: number, b: number, c: number, r: number) => {
  const [p, q, t] = [a - 2 * r, b - 2 * r, c - 2 * r];
  return {
    volume: p * q * t + 2 * r * (p * q + q * t + p * t) + PI * r * r * (p + q + t) + (4 / 3) * PI * r ** 3,
    area: 2 * (p * q + q * t + p * t) + 2 * PI * r * (p + q + t) + 4 * PI * r * r,
  };
};

const CASES: Case[] = [
  { name: "box 10×20×30", build: (s) => box(s, 10, 20, 30), expect: { volume: 6000, area: 2200, centroid: { x: 0, y: 0, z: 0 } } },
  { name: "cylinder r5 h10", build: (s) => s.dispatch("feature.primitive", { shape: "cylinder", radius: 5, height: 10 }), expect: { volume: 250 * PI, area: 150 * PI, centroid: { x: 0, y: 0, z: 0 } } },
  { name: "sphere r7", build: (s) => s.dispatch("feature.primitive", { shape: "sphere", radius: 7 }), expect: { volume: (4 / 3) * PI * 343, area: 196 * PI, centroid: { x: 0, y: 0, z: 0 } } },
  { name: "cone r6 h9", build: (s) => s.dispatch("feature.primitive", { shape: "cone", radius: 6, height: 9 }), expect: { volume: 108 * PI, area: 36 * PI + 6 * PI * Math.sqrt(117), centroid: { z: -4.5 + 9 / 4 } } },
  {
    name: "frustum r6→r3 h9", build: (s) => s.dispatch("feature.primitive", { shape: "cone", radius: 6, radius2: 3, height: 9 }),
    expect: { volume: 189 * PI, area: 45 * PI + 9 * PI * Math.sqrt(90), centroid: { z: (9 * (36 + 36 + 27)) / (4 * 63) - 4.5 } },
  },
  { name: "torus R10 r2", build: (s) => s.dispatch("feature.primitive", { shape: "torus", radius: 10, tube: 2 }), expect: { volume: 80 * PI * PI, area: 80 * PI * PI, centroid: { x: 0, y: 0, z: 0 } } },
  {
    name: "extruded annulus r10/r4 × 5",
    build: async (s) => {
      const sid = await sketch(s);
      await s.dispatch("sketch.addCircle", { sketch: sid, center: { x: 0, y: 0 }, radius: 10 });
      await s.dispatch("sketch.addCircle", { sketch: sid, center: { x: 0, y: 0 }, radius: 4 });
      return s.dispatch("feature.extrude", { sketch: sid, distance: "5", region: { x: 7, y: 0 } });
    },
    expect: { volume: 420 * PI, area: 308 * PI, centroid: { x: 0, y: 0, z: 2.5 } },
  },
  {
    name: "symmetric extrude 10×10 × 6",
    build: async (s) => { const sid = await sketch(s); await rect(s, sid, 0, 0, 10, 10); return s.dispatch("feature.extrude", { sketch: sid, distance: "6", symmetric: true }); },
    expect: { volume: 600, area: 440, centroid: { x: 5, y: 5, z: 0 } },
  },
  {
    name: "revolved washer (r5..10, h4)",
    build: async (s) => {
      const sid = await sketch(s, { plane: "XZ" });
      await rect(s, sid, 5, 0, 10, 4);
      return s.dispatch("feature.revolve", { sketch: sid, axis: { p1: { x: 0, y: 0 }, p2: { x: 0, y: 1 } } });
    },
    expect: { volume: 300 * PI, area: 270 * PI },
  },
  { name: "box 20³ filleted r2 (all edges)", build: async (s) => { await box(s, 20, 20, 20); return s.dispatch("feature.fillet", { radius: "2" }); }, expect: { ...rounded(20, 20, 20, 2), centroid: { x: 0, y: 0, z: 0 } }, tol: 1e-5 },
  {
    name: "box 20³ chamfered 2 (vertical edges)",
    build: async (s) => { await box(s, 20, 20, 20); return s.dispatch("feature.chamfer", { distance: "2", edges: { parallelTo: "Z" } }); },
    expect: { volume: 8000 - 4 * 2 * 20, area: 2400 + 4 * (-80 - 4 + 40 * Math.SQRT2), centroid: { x: 0, y: 0, z: 0 } },
  },
  {
    name: "through hole Ø6 in box 20³",
    build: async (s) => { await box(s, 20, 20, 20); return s.dispatch("feature.hole", { at: [{ x: 0, y: 0, z: 10 }], diameter: "6", throughAll: true }); },
    expect: { volume: 8000 - 180 * PI, area: 2400 - 18 * PI + 120 * PI, centroid: { x: 0, y: 0, z: 0 } },
  },
  {
    name: "counterbored hole Ø6, cb Ø10×4",
    build: async (s) => { await box(s, 20, 20, 20); return s.dispatch("feature.hole", { at: [{ x: 0, y: 0, z: 10 }], diameter: "6", throughAll: true, counterbore: { diameter: "10", depth: "4" } }); },
    expect: { volume: 8000 - 180 * PI - 64 * PI },
  },
  {
    name: "shell 40×40×30 open top, wall 2",
    build: async (s) => { await box(s, 40, 40, 30, { x: 0, y: 0, z: 15 }); return s.dispatch("feature.shell", { thickness: "2", openFaces: { inPlane: { plane: "XY", offset: 30 } } }); },
    expect: { volume: 48000 - 36 * 36 * 28 },
  },
  {
    name: "cut pocket 10×10×5 from the bottom of box 20³",
    build: async (s) => { await box(s, 20, 20, 20); const sid = await sketch(s, { plane: "XY", offset: -10 }); await rect(s, sid, -5, -5, 5, 5); return s.dispatch("feature.extrude", { sketch: sid, distance: "5", operation: "cut" }); },
    expect: { volume: 7500, area: 2400 + 200, centroid: { x: 0, y: 0, z: 0.5 } },
  },
  {
    name: "hemisphere (sphere r10 ∩ box)",
    build: async (s) => { await s.dispatch("feature.primitive", { shape: "sphere", radius: 10 }); return box(s, 40, 40, 20, { x: 0, y: 0, z: 10 }, { operation: "intersect" }); },
    expect: { volume: (2 / 3) * PI * 1000, area: 300 * PI, centroid: { x: 0, y: 0, z: 3.75 } },
  },
  {
    name: "linear pattern ×3 of a 10 cube, step 20",
    build: async (s) => { await box(s, 10, 10, 10); return s.dispatch("feature.pattern", { mode: "linear", count: 3, step: { x: 20, y: 0, z: 0 } }); },
    expect: { volume: 3000, area: 1800, centroid: { x: 20, y: 0, z: 0 } },
  },
  {
    name: "mirror of an offset 10 cube across YZ",
    build: async (s) => { await box(s, 10, 10, 10, { x: 10, y: 0, z: 0 }); return s.dispatch("feature.mirror", { plane: "YZ" }); },
    expect: { volume: 2000, area: 1200, centroid: { x: 0, y: 0, z: 0 } },
  },
  {
    name: "ruled loft square 10 → square 6 over 10 (pyramid frustum)",
    build: async (s) => {
      const a = await sketch(s); await rect(s, a, -5, -5, 5, 5);
      const b = await sketch(s, { plane: "XY", offset: 10 }); await rect(s, b, -3, -3, 3, 3);
      return s.dispatch("feature.loft", { sketches: [a, b], ruled: true });
    },
    expect: { volume: (10 / 3) * (100 + 36 + 60), area: 100 + 36 + 4 * ((10 + 6) / 2) * Math.hypot(10, 2), centroid: { x: 0, y: 0, z: (10 * (100 + 120 + 108)) / (4 * 196) } },
  },
  {
    name: "sweep r2 circle along a 20 line",
    build: async (s) => {
      const prof = await sketch(s); await s.dispatch("sketch.addCircle", { sketch: prof, center: { x: 0, y: 0 }, radius: 2 });
      const path = await sketch(s, { plane: "XZ" }); await s.dispatch("sketch.addLine", { sketch: path, start: { x: 0, y: 0 }, end: { x: 0, y: 20 } });
      return s.dispatch("feature.sweep", { profile: prof, path });
    },
    expect: { volume: 80 * PI, area: 88 * PI, centroid: { x: 0, y: 0, z: 10 } },
  },
];

function body(s: CadSession): SolidEval {
  const out = evaluateFeatures(s.doc, resolveParameters(s.doc.parameters).scope);
  const errors = Object.values(out).filter((r) => r.error).map((r) => `${r.name}: ${r.error}`);
  if (errors.length) throw new Error(errors.join("; "));
  const bodies = Object.values(out).filter((r) => r.mesh);
  if (bodies.length !== 1) throw new Error(`expected one body, got ${bodies.length}`);
  return bodies[0];
}

const close = (actual: number | undefined, expected: number, tol: number, scale: number) =>
  actual !== undefined && Math.abs(actual - expected) <= tol * Math.max(Math.abs(expected), scale);

describe("oracle: exact mass properties match closed-form values", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it.each(CASES)("$name", async (c) => {
    const s = realSession();
    const r = await c.build(s) as { ok?: boolean; error?: string } | undefined;
    if (r && r.ok === false) throw new Error(`build failed: ${r.error}`);
    const b = body(s);
    const tol = c.tol ?? 1e-6;
    const size = Math.cbrt(Math.abs(c.expect.volume)); // centroids compare against the part's size
    const report = { volume: [b.volume, c.expect.volume], area: [b.area, c.expect.area], centroid: [b.centroid, c.expect.centroid] };
    expect(close(b.volume, c.expect.volume, tol, 1), JSON.stringify(report)).toBe(true);
    if (c.expect.area !== undefined) expect(close(b.area, c.expect.area, tol, 1), JSON.stringify(report)).toBe(true);
    for (const k of ["x", "y", "z"] as const) {
      const want = c.expect.centroid?.[k];
      if (want !== undefined) expect(close(b.centroid?.[k], want, tol, size), `${k}: ${JSON.stringify(report)}`).toBe(true);
    }
  });
});
