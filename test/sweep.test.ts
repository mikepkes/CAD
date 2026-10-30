import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import type { CadSession } from "../src/core/command/session";

// feature.sweep: drag a closed profile along an open path (its spine).
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

function bodies(s: CadSession): SolidEval[] {
  const scope = resolveParameters(s.doc.parameters).scope;
  return Object.values(evaluateFeatures(s.doc, scope)).filter((b) => b.mesh);
}
function range(b: SolidEval, axis: 0 | 1 | 2): { lo: number; hi: number } {
  const p = b.mesh!.positions;
  let lo = Infinity, hi = -Infinity;
  for (let i = axis; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
  return { lo, hi };
}

describe("feature.sweep", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  async function circleProfile(s: CadSession, r: number) {
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addCircle", { sketch: sid, center: { x: 0, y: 0 }, radius: r });
    return sid;
  }

  it("sweeps a circle along a straight vertical path → a cylinder", async () => {
    const s = realSession();
    const prof = await circleProfile(s, 5);
    // path on XZ: a line from (0,0) to (0,40) → world (0,0,0)→(0,0,40)
    const path = (await s.dispatch("sketch.create", { plane: "XZ" })).createdIds[0];
    await s.dispatch("sketch.addLine", { sketch: path, start: { x: 0, y: 0 }, end: { x: 0, y: 40 } });
    const r = await s.dispatch("feature.sweep", { profile: prof, path });
    expect(r.ok).toBe(true);
    const b = bodies(s);
    expect(b.length).toBe(1);
    expect(range(b[0], 2)).toMatchObject({ lo: expect.closeTo(0, 1), hi: expect.closeTo(40, 1) }); // along Z
    expect(range(b[0], 0)).toMatchObject({ lo: expect.closeTo(-5, 1), hi: expect.closeTo(5, 1) });  // circle radius
  });

  it("follows a bent (elbow) path", async () => {
    const s = realSession();
    const prof = await circleProfile(s, 4);
    // path on XZ: up to (0,30) then across to (20,30) → world vertical then +X
    const path = (await s.dispatch("sketch.create", { plane: "XZ" })).createdIds[0];
    const l1 = await s.dispatch("sketch.addLine", { sketch: path, start: { x: 0, y: 0 }, end: { x: 0, y: 30 } });
    await s.dispatch("sketch.addLine", { sketch: path, start: { ref: l1.createdIds[2] }, end: { x: 20, y: 30 } });
    const r = await s.dispatch("feature.sweep", { profile: prof, path });
    expect(r.ok).toBe(true);
    const b = bodies(s);
    expect(b.length).toBe(1);
    // the elbow reaches up to z≈30 and across to x≈20 (+ the 4mm profile)
    expect(range(b[0], 2).hi).toBeGreaterThan(29);
    expect(range(b[0], 0).hi).toBeGreaterThan(19);
  });

  it("sweeps a HOLLOW (ring) profile into a tube", async () => {
    const s = realSession();
    // ring profile: outer r=10, inner r=7
    const prof = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addRing", { sketch: prof, center: { x: 0, y: 0 }, outerRadius: 10, innerRadius: 7 });
    // straight vertical path on XZ
    const path = (await s.dispatch("sketch.create", { plane: "XZ" })).createdIds[0];
    await s.dispatch("sketch.addLine", { sketch: path, start: { x: 0, y: 0 }, end: { x: 0, y: 40 } });
    const r = await s.dispatch("feature.sweep", { profile: prof, path });
    expect(r.ok).toBe(true);
    const b = bodies(s);
    expect(b.length).toBe(1);
    expect(b[0].error).toBeUndefined();
    // Vertex radii: a tube has a bore (~7) as well as the outer wall (~10); a
    // solid rod would have no vertices near r=7.
    const p = b[0].mesh!.positions;
    let rMin = Infinity, rMax = 0;
    for (let i = 0; i < p.length; i += 3) {
      const rad = Math.hypot(p[i], p[i + 1]);
      rMin = Math.min(rMin, rad); rMax = Math.max(rMax, rad);
    }
    expect(rMax).toBeCloseTo(10, 0); // outer wall
    expect(rMin).toBeCloseTo(7, 0);  // bore — proves it's hollow, not solid
  });

  it("errors when the path has no open chain", async () => {
    const s = realSession();
    const prof = await circleProfile(s, 5);
    // a closed square is not an open path
    const path = (await s.dispatch("sketch.create", { plane: "XZ" })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: path, corner: { x: 0, y: 0 }, opposite: { x: 20, y: 20 } });
    const r = await s.dispatch("feature.sweep", { profile: prof, path });
    // command dispatches (sketches exist) but evaluation finds no open path.
    expect(r.ok).toBe(true);
    const scope = resolveParameters(s.doc.parameters).scope;
    const evals = evaluateFeatures(s.doc, scope);
    const swp = Object.values(evals).find((e) => e.featureId.startsWith("swp"));
    expect(swp?.error).toMatch(/open chain/i);
  });
});
