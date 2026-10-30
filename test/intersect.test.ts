import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import type { CadSession } from "../src/core/command/session";

// Boolean intersect: an extrude with operation "intersect" keeps only the volume
// common to it and the running body.
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
async function box(s: CadSession, x0: number, y0: number, x1: number, y1: number, dist: string, op?: string) {
  const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
  await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: x0, y: y0 }, opposite: { x: x1, y: y1 } });
  await s.dispatch("feature.extrude", { sketch: sid, distance: dist, ...(op ? { operation: op } : {}) });
}

describe("boolean intersect", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("keeps only the overlap of the tool and the running body", async () => {
    const s = realSession();
    await box(s, -20, -20, 20, 20, "40");                 // 40×40×40 cube, x,y ∈ [-20,20]
    await box(s, 0, 0, 40, 40, "40", "intersect");        // x,y ∈ [0,40] → overlap [0,20]
    const b = bodies(s);
    expect(b.length).toBe(1);
    expect(range(b[0], 0)).toMatchObject({ lo: expect.closeTo(0, 1), hi: expect.closeTo(20, 1) });
    expect(range(b[0], 1)).toMatchObject({ lo: expect.closeTo(0, 1), hi: expect.closeTo(20, 1) });
    expect(range(b[0], 2)).toMatchObject({ lo: expect.closeTo(0, 1), hi: expect.closeTo(40, 1) });
  });
});
