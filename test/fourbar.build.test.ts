// End-to-end: a one-piece compliant four-bar that shows how flexures work. Four
// TPU links joined by thin flexure strips, printed flat as a single part; push
// the finger pad and the crank turns about its ground flexure, the coupler
// carries the motion across, and the rocker's pointer swings — every joint is a
// strip of plastic bending, no pins. Modelled as four components joined by
// flexure joints with the loop closed at B, so Chisel solves the pose for any
// crank angle and reports each hinge's strain and the input torque.
//   BUILD_FOURBAR=/abs/out npx vitest run test/fourbar.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { serializeDocument } from "../src/core/persistence";
import { collideFeatures, evaluateFeatures, exportFusedBlob } from "../src/core/features";
import { placeComponentSketches } from "../src/core/recompute";
import { resolveParameters } from "../src/model/parameters";
import { flexureSweep, flexureStiffness } from "../src/sim/flexure";
import type { CadSession } from "../src/core/command/session";

const OUT = process.env.BUILD_FOURBAR || "";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

// ---- dimensions (mm), plan view, printed flat ----
const Hz = 6;                          // part height (Z) = every hinge's width
const w = 6;                           // link bar width
const hinge = { length: 4, thickness: 1 }; // flexure strip: 1 mm thick bends in the strong XY direction
// Pivots: a Grashof crank-rocker (crank 40, coupler 60.8, rocker 50, ground 60).
const O2 = { x: 0, y: 0 }, A = { x: 0, y: 40 }, B = { x: 60, y: 50 }, O4 = { x: 60, y: 0 };
const THETA = 20;                      // input range ±20°
// Bambu "TPU for AMS" printed flat (XY): E from the datasheet; 8% allowable
// strain is a conservative service limit (elongation at break is > 650%).
const TPU = { youngsModulus: 1190, allowableStrain: 0.08 };

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

type P = { x: number; y: number };
/** Extrude a closed outline (plan, mm) by Hz in `comp`: the component's first
 *  shape starts its body, the rest join it. */
async function solid(s: CadSession, comp: string, pts: P[], first: boolean, name: string) {
  const sk = (await dis(s, "sketch.create", { plane: "XY", component: comp, name }))[0];
  await dis(s, "sketch.addPolyline", { sketch: sk, points: pts });
  await dis(s, "feature.extrude", { sketch: sk, distance: String(Hz), operation: first ? "new" : "join", name });
}
const rect = (x0: number, y0: number, x1: number, y1: number): P[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
/** A bar of width `wd` from p to q (centreline). */
function bar(p: P, q: P, wd: number): P[] {
  const L = Math.hypot(q.x - p.x, q.y - p.y), n = { x: (-(q.y - p.y) / L) * (wd / 2), y: ((q.x - p.x) / L) * (wd / 2) };
  return [{ x: p.x + n.x, y: p.y + n.y }, { x: p.x - n.x, y: p.y - n.y }, { x: q.x - n.x, y: q.y - n.y }, { x: q.x + n.x, y: q.y + n.y }];
}
/** Half a flexure strip at pivot c, running along +y (`up`) or −y from it. The
 *  strip is split at the pivot: each link owns the half on its side, so the
 *  hinge bends about its centre (the small-length flexural pivot). */
const half = (c: P, up: boolean) => rect(c.x - hinge.thickness / 2, up ? c.y : c.y - hinge.length / 2 - 0.2, c.x + hinge.thickness / 2, up ? c.y + hinge.length / 2 + 0.2 : c.y);
const hl = hinge.length / 2;

async function buildFourBar(s: CadSession): Promise<void> {
  await dis(s, "parameter.add", { name: "theta", expression: "0", min: -THETA, max: THETA, step: 1 });
  const tpu = (await dis(s, "material.create", { name: "TPU for AMS", kind: "plastic", finish: "matte", color: "#e9b949", ...TPU }))[0];
  const link = async (name: string) => { const c = (await dis(s, "component.create", { name }))[0]; await dis(s, "material.assign", { material: tpu, component: c }); return c; };
  const ground = await link("Ground"), crank = await link("Crank"), coupler = await link("Coupler"), rocker = await link("Rocker");

  // Ground: a base bar with a pedestal under each ground hinge.
  await solid(s, ground, rect(-12, -16, 72, -8), true, "Base");
  await solid(s, ground, rect(O2.x - 4, -8.2, O2.x + 4, -hl), false, "Pedestal O2");
  await solid(s, ground, rect(O4.x - 4, -8.2, O4.x + 4, -hl), false, "Pedestal O4");
  await solid(s, ground, half(O2, false), false, "Hinge O2 (ground half)");
  await solid(s, ground, half(O4, false), false, "Hinge O4 (ground half)");

  // Crank (input): O2 → A, with a lever arm and finger pad to push.
  await solid(s, crank, half(O2, true), true, "Hinge O2 (crank half)");
  await solid(s, crank, rect(-w / 2, hl, w / 2, A.y - hl), false, "Crank bar");
  await solid(s, crank, half(A, false), false, "Hinge A (crank half)");
  await solid(s, crank, rect(-26, 19, -w / 2 + 0.1, 23), false, "Lever");
  await solid(s, crank, rect(-36, 12, -24, 30), false, "Finger pad");

  // Coupler: a block above each coupler hinge, joined by a bar.
  await solid(s, coupler, half(A, true), true, "Hinge A (coupler half)");
  await solid(s, coupler, rect(A.x - 4, A.y + hl, A.x + 4, A.y + hl + 6), false, "Block A");
  await solid(s, coupler, half(B, true), false, "Hinge B (coupler half)");
  await solid(s, coupler, rect(B.x - 4, B.y + hl, B.x + 4, B.y + hl + 6), false, "Block B");
  await solid(s, coupler, bar({ x: A.x, y: A.y + hl + 3 }, { x: B.x, y: B.y + hl + 3 }, w), false, "Coupler bar");

  // Rocker (output): O4 → B, with a long pointer to show the swing.
  await solid(s, rocker, half(O4, true), true, "Hinge O4 (rocker half)");
  await solid(s, rocker, rect(O4.x - w / 2, hl, O4.x + w / 2, B.y - hl), false, "Rocker bar");
  await solid(s, rocker, half(B, false), false, "Hinge B (rocker half)");
  await solid(s, rocker, rect(O4.x + w / 2 - 0.1, 28.5, 92, 31.5), false, "Pointer arm");
  await solid(s, rocker, [{ x: 91.9, y: 26 }, { x: 102, y: 30 }, { x: 91.9, y: 34 }], false, "Pointer tip");

  // Flexure joints: crank driven, coupler and rocker solved, the loop closed at B.
  const flex = { kind: "flexure", axis: { x: 0, y: 0, z: 1 }, flexure: { length: hinge.length, width: Hz, thickness: hinge.thickness } };
  const at = (p: P) => ({ x: p.x, y: p.y, z: 0 });
  await dis(s, "joint.create", { ...flex, base: ground, moved: crank, baseOrigin: at(O2), movedOrigin: at(O2), value: "theta", name: "Hinge O2" });
  await dis(s, "joint.create", { ...flex, base: crank, moved: coupler, baseOrigin: at(A), movedOrigin: at(A), solve: true, name: "Hinge A" });
  await dis(s, "joint.create", { ...flex, base: ground, moved: rocker, baseOrigin: at(O4), movedOrigin: at(O4), solve: true, name: "Hinge O4" });
  await dis(s, "joint.create", { ...flex, base: coupler, moved: rocker, baseOrigin: at(B), movedOrigin: at(B), closes: true, name: "Hinge B" });
}

const sweep = Array.from({ length: 9 }, (_, k) => -THETA + (2 * THETA * k) / 8);

describe("compliant four-bar", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("builds four links that print as one piece", async () => {
    const s = realSession();
    await buildFourBar(s);
    await s.recompute();
    if (OUT) writeFileSync(`${OUT}/fourbar.chisel.json`, serializeDocument(s.doc));
    const scope = resolveParameters(s.doc.parameters).scope;
    placeComponentSketches(s.doc, scope);
    const bodies = Object.values(evaluateFeatures(s.doc, scope));
    for (const b of bodies) expect(b.error, b.name).toBeUndefined();
    expect(bodies.filter((b) => b.mesh).length).toBe(4);
    // at rest the links only touch (at the split hinge strips); fused they are one solid
    expect(collideFeatures(s.doc, scope).maxOverlap).toBeLessThan(0.01);
    const stl = exportFusedBlob(s.doc, scope, "stl");
    expect(stl && stl.size).toBeGreaterThan(10000);
    if (OUT) writeFileSync(`${OUT}/fourbar.stl`, Buffer.from(await stl!.arrayBuffer()));
  }, 120000);

  it("moves through ±20°: the loop closes, every hinge stays under the TPU limit, the output swings", async () => {
    const s = realSession();
    await buildFourBar(s);
    await s.recompute();
    const poses = flexureSweep(s.doc, "theta", sweep);
    for (const p of poses) {
      expect(p.error, `theta ${p.value}`).toBeUndefined();
      expect(p.utilisation, `theta ${p.value}`).toBeLessThan(1);
    }
    const out = poses.map((p) => p.flexures.find((f) => f.name === "Hinge O4")!.angle);
    const swing = Math.max(...out) - Math.min(...out);
    expect(swing).toBeGreaterThan(20); // the pointer visibly swings
    // stiffer the further it is pushed: torque grows with |theta| and is zero at rest
    expect(Math.abs(poses[4].effort)).toBeLessThan(1e-3);
    expect(Math.abs(poses[8].effort)).toBeGreaterThan(Math.abs(poses[6].effort));
    const k = flexureStiffness(TPU.youngsModulus, { length: hinge.length, width: Hz, thickness: hinge.thickness });
    console.log(`hinge k = ${k.toFixed(0)} N·mm/rad; output swing ${swing.toFixed(1)}° for ±${THETA}° input; ` +
      `at +${THETA}°: torque ${poses[8].effort.toFixed(0)} N·mm, peak strain ${(Math.max(...poses[8].flexures.map((f) => f.strain)) * 100).toFixed(1)}% (limit ${TPU.allowableStrain * 100}%)`);
  }, 120000);

  it("the links clear each other through the motion (only the hinge strips kink)", async () => {
    const s = realSession();
    await buildFourBar(s);
    await s.recompute();
    for (const th of [-THETA, -THETA / 2, THETA / 2, THETA]) {
      const params = s.doc.parameters.map((p) => (p.name === "theta" ? { ...p, expr: String(th) } : p));
      const scope = resolveParameters(params).scope;
      const posed = { ...s.doc, parameters: params, sketches: Object.fromEntries(Object.entries(s.doc.sketches).map(([k, v]) => [k, { ...v }])) };
      placeComponentSketches(posed, scope);
      const c = collideFeatures(posed, scope);
      expect(c.buildError).toBeUndefined();
      // the split strip halves overlap in a sliver as the hinge bends: < 1 mm³ per hinge
      for (const o of c.overlaps) expect(o.volume, `${o.a} × ${o.b} at theta ${th}`).toBeLessThan(1);
    }
  }, 120000);
});

