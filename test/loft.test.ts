import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/model/parameters";
import type { CadSession } from "../src/core/command/session";

// feature.loft: a solid lofted through profile sketches on different planes.
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

function bodies(s: CadSession): SolidEval[] {
  const scope = resolveParameters(s.doc.parameters).scope;
  return Object.values(evaluateFeatures(s.doc, scope)).filter((b) => b.mesh);
}
function zRange(b: SolidEval): { lo: number; hi: number } {
  const p = b.mesh!.positions;
  let lo = Infinity, hi = -Infinity;
  for (let i = 2; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
  return { lo, hi };
}
/** Largest |x| among vertices whose z is within `tol` of `z`. */
function maxAbsXNear(b: SolidEval, z: number, tol = 2): number {
  const p = b.mesh!.positions;
  let m = 0;
  for (let i = 0; i < p.length; i += 3) if (Math.abs(p[i + 2] - z) < tol) m = Math.max(m, Math.abs(p[i]));
  return m;
}

describe("feature.loft", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  /** A 40×40 profile on XY and a `top`×`top` profile `h` above it. */
  async function twoProfiles(s: CadSession, bottom: number, top: number, h: number) {
    const a = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: a, corner: { x: -bottom / 2, y: -bottom / 2 }, opposite: { x: bottom / 2, y: bottom / 2 } });
    const b = (await s.dispatch("sketch.create", { plane: "XY", offset: h })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: b, corner: { x: -top / 2, y: -top / 2 }, opposite: { x: top / 2, y: top / 2 } });
    return { a, b };
  }

  it("lofts a tapered solid between two profiles on different planes", async () => {
    const s = realSession();
    const { a, b } = await twoProfiles(s, 40, 20, 40);
    const r = await s.dispatch("feature.loft", { sketches: [a, b] });
    expect(r.ok).toBe(true);
    const body = bodies(s);
    expect(body.length).toBe(1);
    expect(zRange(body[0])).toMatchObject({ lo: expect.closeTo(0, 1), hi: expect.closeTo(40, 1) });
    // wide at the bottom, narrow at the top → it really tapers
    expect(maxAbsXNear(body[0], 0)).toBeCloseTo(20, 0);
    expect(maxAbsXNear(body[0], 40)).toBeCloseTo(10, 0);
  });

  it("propagates an upstream profile edit to the loft", async () => {
    const s = realSession();
    const { a, b } = await twoProfiles(s, 40, 20, 40);
    await s.dispatch("feature.loft", { sketches: [a, b] });
    expect(maxAbsXNear(bodies(s)[0], 40)).toBeCloseTo(10, 0);

    // Widen the TOP profile (sketch b) to 36×36 → the top of the loft widens.
    const rectOp = s.timeline.filter((o) => o.type === "sketch.addRectangle")[1];
    await s.editOperation(rectOp.opId, { ...rectOp.params, corner: { x: -18, y: -18 }, opposite: { x: 18, y: 18 } });
    expect(maxAbsXNear(bodies(s)[0], 40)).toBeCloseTo(18, 0);
  });

  it("errors cleanly with fewer than two profiles", async () => {
    const s = realSession();
    const a = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: a, corner: { x: -10, y: -10 }, opposite: { x: 10, y: 10 } });
    const r = await s.dispatch("feature.loft", { sketches: [a] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/at least two/i);
  });
});
