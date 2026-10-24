import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/model/parameters";
import type { CadSession } from "../src/core/command/session";

// Parametric face references: a sketch created on a body face re-resolves to that
// face's CURRENT plane each rebuild, so it (and anything built on it) tracks the
// face when upstream geometry changes — instead of freezing at the pick location.
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
/** The boss: the highest-sitting body (greatest min-z). */
const boss = (bs: SolidEval[]) => bs.slice().sort((a, b) => zRange(b).lo - zRange(a).lo)[0];

describe("parametric face references", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  /** A box (height h) with a boss on its top face, referenced parametrically. */
  async function boxWithTopBoss(s: CadSession, h: string) {
    const base = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: base, corner: { x: -20, y: -20 }, opposite: { x: 20, y: 20 } });
    const boxOp = await s.dispatch("feature.extrude", { sketch: base, distance: h });
    // Sketch on the top face (+Z). faceRef re-resolves it each rebuild.
    const top = (await s.dispatch("sketch.create", {
      planeDef: { origin: { x: 0, y: 0, z: 20 }, normal: { x: 0, y: 0, z: 1 } },
      faceRef: { normal: { x: 0, y: 0, z: 1 }, point: { x: 0, y: 0, z: 20 } },
    })).createdIds[0];
    await s.dispatch("sketch.addCircle", { sketch: top, center: { x: 0, y: 0 }, radius: 8 });
    await s.dispatch("feature.extrude", { sketch: top, distance: "10" });
    return { boxOpId: boxOp.opId!, base };
  }

  it("lands a face-sketch boss on the face it was drawn on", async () => {
    const s = realSession();
    await boxWithTopBoss(s, "20");
    const b = boss(bodies(s));
    expect(zRange(b).lo).toBeCloseTo(20, 1);
    expect(zRange(b).hi).toBeCloseTo(30, 1);
  });

  it("tracks the face when the upstream body changes height", async () => {
    const s = realSession();
    const { boxOpId, base } = await boxWithTopBoss(s, "20");
    expect(zRange(boss(bodies(s))).lo).toBeCloseTo(20, 1);

    // Grow the box: the top face moves to z=50, and the boss must follow it.
    await s.editOperation(boxOpId, { sketch: base, distance: "50" });
    const b = boss(bodies(s));
    expect(b.error).toBeUndefined();
    expect(zRange(b).lo).toBeCloseTo(50, 1); // rode up with the face (was frozen at 20 before)
    expect(zRange(b).hi).toBeCloseTo(60, 1);
  });

  it("tracks a parameter-driven height change too", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "h", expression: "20" });
    await boxWithTopBoss(s, "h");
    expect(zRange(boss(bodies(s))).lo).toBeCloseTo(20, 1);
    const hOp = s.timeline.find((o) => o.type === "parameter.add")!;
    await s.editOperation(hOp.opId, { name: "h", expression: "35" });
    expect(zRange(boss(bodies(s))).lo).toBeCloseTo(35, 1);
  });
});
