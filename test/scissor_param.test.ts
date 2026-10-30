// Builds a PARAMETRIC scissor lift and serializes it as an example file.
//
// Unlike the joint-driven motion scissor, this model is a *parametric pattern*:
// one crossing "X" of two angled bars, repeated `stages` times up +Z. Because
// the repeat count is a parameter, the number of linkages is itself tunable from
// the Customize panel — which patterns allow and jointed assemblies cannot (a
// pattern stamps rigid copies, so it trades the live pivot motion for a count
// you can drive). `stages` carries step:1 so its slider only lands on integers.
//
// The two bars are built from dimensioned sketch points whose coordinates are
// expressions of openAngle / linkLength / linkWidth, so opening angle and link
// size stay fully parametric too. distanceX/distanceY are signed (PlaneGCS
// `difference`), so the negative-coordinate corners are unambiguous.
//
//   BUILD_SCISSOR=/abs/out npx vitest run test/_scissor_param.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { serializeDocument } from "../src/core/persistence";
import { evaluateFeatures } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import type { CadSession } from "../src/core/command/session";

const OUT = process.env.BUILD_SCISSOR || "";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

// Expression fragments shared by every corner (parameter-driven).
const SIN = "sin(rad(openAngle))", COS = "cos(rad(openAngle))";
const HX = `linkWidth/2*${SIN}`, HZ = `linkWidth/2*${COS}`; // half-width across the bar
const LX = `linkLength*${COS}`, LZ = `linkLength*${SIN}`;    // span of one bar
// rise of one X stage = vertical span of a bar — the pattern step up +Z.
const RISE = LZ;

type Corner = { x: string; z: string; sx: number; sz: number }; // expr + numeric seed
const c = (x: string, z: string, sx: number, sz: number): Corner => ({ x, z, sx, sz });

// Seeds evaluated at the defaults (openAngle 45°, L 60, W 6) so the solver starts near.
const S = Math.SQRT1_2, L0 = 60, W0 = 6, h = W0 / 2;
const hx = h * S, hz = h * S, lx = L0 * S, lz = L0 * S;

// Bar A: bottom-left (0,0) → top-right (Lcos, Lsin). Bar B mirrors it.
const BAR_A: Corner[] = [
  c(`-${HX}`, `${HZ}`, -hx, hz),
  c(`${HX}`, `-${HZ}`, hx, -hz),
  c(`${LX}+${HX}`, `${LZ}-${HZ}`, lx + hx, lz - hz),
  c(`${LX}-${HX}`, `${LZ}+${HZ}`, lx - hx, lz + hz),
];
const BAR_B: Corner[] = [
  c(`${LX}-${HX}`, `-${HZ}`, lx - hx, -hz),
  c(`${LX}+${HX}`, `${HZ}`, lx + hx, hz),
  c(`${HX}`, `${LZ}+${HZ}`, hx, lz + hz),
  c(`-${HX}`, `${LZ}-${HZ}`, -hx, lz - hz),
];

async function bar(s: CadSession, corners: Corner[], operation: "new" | "join"): Promise<void> {
  const [sid, origin] = await dis(s, "sketch.create", { plane: "XZ" });
  const ids = await dis(s, "sketch.addPolyline", { sketch: sid, points: corners.map((p) => ({ x: p.sx, y: p.sz })) });
  const pts = ids.slice(corners.length); // [...lines, ...points]
  for (let i = 0; i < corners.length; i++) {
    await dis(s, "sketch.addDimension", { sketch: sid, type: "distanceX", a: origin, b: pts[i], expression: corners[i].x });
    await dis(s, "sketch.addDimension", { sketch: sid, type: "distanceY", a: origin, b: pts[i], expression: corners[i].z });
  }
  await dis(s, "feature.extrude", { sketch: sid, distance: "thickness", operation });
}

function topZ(s: CadSession): number {
  const bodies = Object.values(evaluateFeatures(s.doc, resolveParameters(s.doc.parameters).scope)).filter((b) => b.mesh);
  let hi = -Infinity, n = 0;
  for (const b of bodies) { n++; for (let i = 2; i < b.mesh!.positions.length; i += 3) hi = Math.max(hi, b.mesh!.positions[i]); }
  return n ? hi : NaN;
}

describe("build parametric scissor lift", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("patterns one X by a parametric count and stays parametric in angle/size", async () => {
    const s = realSession();
    await dis(s, "parameter.add", { name: "stages", expression: "3", min: 1, max: 8, step: 1 });
    await dis(s, "parameter.add", { name: "openAngle", expression: "45", min: 20, max: 70 });
    await dis(s, "parameter.add", { name: "linkLength", expression: "60", min: 40, max: 100 });
    await dis(s, "parameter.add", { name: "linkWidth", expression: "6", min: 3, max: 12 });
    await dis(s, "parameter.add", { name: "thickness", expression: "4", min: 2, max: 10 });

    await bar(s, BAR_A, "new");
    await bar(s, BAR_B, "join");
    await dis(s, "feature.pattern", { mode: "linear", count: "stages", step: { x: 0, y: 0, z: RISE }, name: "Linkages" });

    await s.recompute();

    // Serialize the CLEAN construction before the sweeps below append parameter.set
    // ops (which would otherwise override the Customize sliders on load).
    if (OUT) writeFileSync(`${OUT}/scissor.chisel.json`, serializeDocument(s.doc));

    // One fused body; height is (stages) × rise.
    const setParam = async (name: string, expr: string) => { await dis(s, "parameter.set", { name, expression: expr }); await s.recompute(); };

    const rise = L0 * S; // ≈ 42.4mm per stage at the defaults
    const h3 = topZ(s);
    expect(h3).toBeGreaterThan(rise * 3 - 2);
    expect(h3).toBeLessThan(rise * 3 + 6); // top bar's half-width overhang only

    await setParam("stages", "5");
    const h5 = topZ(s);
    expect(h5).toBeGreaterThan(h3 + rise * 1.8); // two more stages → clearly taller

    await setParam("stages", "3");
    await setParam("openAngle", "25"); // flatter → much lower
    expect(topZ(s)).toBeLessThan(h3 * 0.7);

    await setParam("openAngle", "45");
    console.log(`scissor: stages 3 → topZ ${h3.toFixed(1)}mm; stages 5 → ${h5.toFixed(1)}mm; rise/stage ≈ ${rise.toFixed(1)}mm`);
  }, 120000);
});
