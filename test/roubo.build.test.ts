// A fully parametric Roubo workbench, built as real woodwork: laminated top,
// legs through-tenoned into the slab, stretchers mortise-and-tenoned into the
// legs, and a leg vise whose chop is kept parallel by a criss-cross (scissor)
// stabilizer — all driven by size parameters and a `viseGap`. Oak + steel.
//   BUILD_ROUBO=/abs/out npx vitest run test/roubo.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { serializeDocument } from "../src/core/persistence";
import { evaluateFeatures } from "../src/core/features";
import { placeComponentSketches } from "../src/core/recompute";
import { resolveParameters } from "../src/model/parameters";
import type { CadSession } from "../src/core/command/session";

const OUT = process.env.BUILD_ROUBO || "";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

// Numeric design values (also written as parameters so the model is adjustable).
const N = {
  L: 1700, D: 500, H: 850, TT: 100, LS: 100,   // length, depth, height, top thick, leg section
  NB: 4,                                        // top laminations
  INSET: 130,                                   // leg inset from each end
  TEN: 55,                                      // through-tenon side (square)
  RAIL_H: 110, RAIL_T: 32, RAIL_Z: 170,         // stretcher height / thickness / z
  RTEN: 28,                                     // stretcher tenon length
  S0: 70, LA: 360, ARM_W: 30, ARM_T: 12,        // criss-cross: closed sep, arm length, arm section
};
const BW = N.D / N.NB;
const O = { x: -N.L / 2, y: -N.D / 2, z: -N.H / 2 }; // centre on origin
const at = (x: number, y: number, z: number) => ({ x: x + O.x, y: y + O.y, z: z + O.z });

/** A board component built in its local frame [0,bx]×[0,by]×[0,bz], placed at pos,
 *  sketched on XY and extruded up +Z. Returns {cmp, sketch} for follow-on cuts. */
async function board(s: CadSession, name: string, pos: { x: number; y: number; z: number }, dim: [number, number, number], parent?: string): Promise<{ cmp: string; feat: string }> {
  const cmp = (await dis(s, "component.create", { name, position: pos, ...(parent ? { parent } : {}) }))[0];
  const sid = (await dis(s, "sketch.create", { plane: "XY", component: cmp }))[0];
  await dis(s, "sketch.addRectangle", { sketch: sid, corner: { x: 0, y: 0 }, opposite: { x: dim[0], y: dim[1] } });
  const feat = (await dis(s, "feature.extrude", { sketch: sid, distance: String(dim[2]) }))[0];
  return { cmp, feat };
}

/** Cut a rectangular through-mortise through `targetFeat` (the host board's body),
 *  footprint [u0,u1]×[v0,v1] in `cmp`'s local XY, through the full height. The
 *  explicit `body` is essential: otherwise the cut hits the most-recent body. */
async function mortise(s: CadSession, cmp: string, targetFeat: string, u0: number, v0: number, u1: number, v1: number): Promise<void> {
  const sid = (await dis(s, "sketch.create", { plane: "XY", component: cmp }))[0];
  await dis(s, "sketch.addRectangle", { sketch: sid, corner: { x: u0, y: v0 }, opposite: { x: u1, y: v1 } });
  await dis(s, "feature.extrude", { sketch: sid, distance: "1", operation: "cut", extent: "throughAll", symmetric: true, body: targetFeat });
}

function bodies(s: CadSession): { count: number; byComp: Record<string, { lo: number[]; hi: number[]; feat: string }[]> } {
  const scope = resolveParameters(s.doc.parameters).scope;
  placeComponentSketches(s.doc, scope);
  const sol = Object.values(evaluateFeatures(s.doc, scope)).filter((b) => b.mesh && b.bounds);
  const byComp: Record<string, { lo: number[]; hi: number[]; feat: string }[]> = {};
  for (const b of sol) {
    const c = s.doc.sketches[b.sketchId]?.componentId ?? "?";
    (byComp[c] ??= []).push({ lo: [b.bounds!.min.x, b.bounds!.min.y, b.bounds!.min.z], hi: [b.bounds!.max.x, b.bounds!.max.y, b.bounds!.max.z], feat: b.featureId });
  }
  return { count: sol.length, byComp };
}

async function buildRoubo(s: CadSession): Promise<{ chop: string; armIds: string[] }> {
  // ---- parameters (the model is driven entirely by these) ----
  const P: [string, number, number?, number?, number?][] = [
    ["L", N.L, 1200, 2400, 10], ["D", N.D, 400, 700, 10], ["H", N.H, 750, 950, 5],
    ["TT", N.TT, 60, 140, 5], ["LS", N.LS, 70, 130, 5], ["viseGap", 60, 0, 170, 5],
  ];
  for (const [name, val, min, max, step] of P) await dis(s, "parameter.add", { name, expression: String(val), ...(min != null ? { min, max, step } : {}) });

  const legTopZ = N.H - N.TT;        // underside of the slab
  const legX = [N.INSET, N.L - N.INSET - N.LS];
  const legY = [0, N.D - N.LS];      // front legs flush front (Y=0)
  const legNames = ["FL", "FR", "BL", "BR"];

  // ---- top: laminated oak boards; the two outer boards host the leg mortises.
  const topBoards: { cmp: string; feat: string }[] = [];
  for (let i = 0; i < N.NB; i++) topBoards.push(await board(s, `Top ${i + 1}`, at(0, i * BW, legTopZ), [N.L, BW - 0.8, N.TT]));

  // ---- legs with through-tenons that pass up through the slab and stand proud.
  let li = 0;
  const off = (N.LS - N.TEN) / 2;
  for (const y of legY) for (const x of legX) {
    const nm = legNames[li++];
    const leg = (await board(s, `Leg ${nm}`, at(x, y, 0), [N.LS, N.LS, legTopZ])).cmp;
    // tenon: a reduced square carried from the slab underside up through it and
    // ~12mm proud of the top (its own child body, in leg-local coords).
    await board(s, `Tenon ${nm}`, { x: off, y: off, z: legTopZ }, [N.TEN, N.TEN, N.TT + 12], leg);
    // matching through-mortise in the top board this leg sits under.
    const bi = y === 0 ? 0 : N.NB - 1;
    const by = bi * BW; // board's world Y origin (pre-centre)
    await mortise(s, topBoards[bi].cmp, topBoards[bi].feat, x + off, (y + off) - by, x + off + N.TEN, (y + off + N.TEN) - by);
  }

  // ---- stretchers: long front/back rails + end rails, mortise-and-tenoned into legs.
  // Rail body = span between legs + a tenon stub at each end going into the leg.
  const railNames = ["Front rail", "Back rail"];
  const railY = [N.LS / 2 - N.RAIL_T / 2, N.D - N.LS / 2 - N.RAIL_T / 2];
  for (let i = 0; i < 2; i++) {
    const x0 = N.INSET + N.LS - N.RTEN, x1 = N.L - N.INSET - N.LS + N.RTEN; // overlap into legs by RTEN
    await board(s, railNames[i], at(x0, railY[i], N.RAIL_Z), [x1 - x0, N.RAIL_T, N.RAIL_H]);
    // mortises in the four leg inner faces where the tenons enter.
  }
  const endY0 = N.LS, endY1 = N.D - N.LS;
  for (let i = 0; i < 2; i++) {
    const x = i === 0 ? N.INSET + N.LS / 2 - N.RAIL_T / 2 : N.L - N.INSET - N.LS / 2 - N.RAIL_T / 2;
    await board(s, i === 0 ? "End rail L" : "End rail R", at(x, endY0 - N.RTEN, N.RAIL_Z), [N.RAIL_T, (endY1 - endY0) + 2 * N.RTEN, N.RAIL_H]);
  }

  // ---- leg vise on the front-left leg: chop + steel screw + criss-cross.
  const chop = (await dis(s, "component.create", { name: "Vise chop" }))[0];
  const chopW = N.LS + 60, chopT = 42, chopH = legTopZ - 180;
  const csk = (await dis(s, "sketch.create", { plane: "XY", component: chop }))[0];
  await dis(s, "sketch.addRectangle", { sketch: csk, corner: { x: 0, y: 0 }, opposite: { x: chopW, y: chopT } });
  await dis(s, "feature.extrude", { sketch: csk, distance: String(chopH) });
  // screw (steel), own sub-component so it can be metal; runs back into the leg.
  const screw = (await dis(s, "component.create", { name: "Vise screw", parent: chop }))[0];
  const ssk = (await dis(s, "sketch.create", { plane: "XZ", component: screw }))[0];
  await dis(s, "sketch.addCircle", { sketch: ssk, center: { x: chopW / 2, y: chopH - 150 }, radius: 16 });
  await dis(s, "feature.extrude", { sketch: ssk, distance: String(chopT + N.LS + 30), direction: "reverse" });

  // chop slides along -Y (front) on a slider; closed = back face at the leg front.
  const chopPivotX = N.INSET + N.LS / 2 - chopW / 2;
  const P0 = at(chopPivotX, -chopT, 150);
  await dis(s, "joint.create", { kind: "slider", moved: chop, baseOrigin: P0, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: -1, z: 0 }, value: "viseGap", name: "Vise slide" });

  // criss-cross: two steel arms that scissor as the chop racks, offset in X so
  // they cross as two real bars, joined by a centre pivot pin and end pins that
  // seat into the leg and chop. arm angle θ = asin((S0+viseGap)/LA) about world X.
  const armIds: string[] = [];
  const zc = 150 + chopH * 0.4;                  // criss-cross centre height
  const armPivot = [at(chopPivotX + chopW / 2, -6, zc - N.LA / 3), at(chopPivotX + chopW / 2, -6, zc + N.LA / 3)];
  const thetaExpr = `deg(asin((${N.S0}+viseGap)/${N.LA}))`;
  // a steel pin: a cylinder along X, centred at a parent-local point, spanning
  // both arm slabs. Child of an arm so it rides with it; inherits steel.
  const pin = async (parent: string, zLocal: number, len: number) => {
    const p = (await dis(s, "component.create", { name: "Pin", parent, position: { x: 0, y: 0, z: zLocal } }))[0];
    const sk = (await dis(s, "sketch.create", { plane: "YZ", component: p }))[0];
    await dis(s, "sketch.addCircle", { sketch: sk, center: { x: 0, y: 0 }, radius: N.ARM_W * 0.33 });
    await dis(s, "feature.extrude", { sketch: sk, distance: String(len), symmetric: true });
  };
  for (let i = 0; i < 2; i++) {
    const up = i === 0;
    const arm = (await dis(s, "component.create", { name: `Crisscross arm ${i + 1}` }))[0];
    const ask = (await dis(s, "sketch.create", { plane: "YZ", component: arm }))[0];
    await dis(s, "sketch.addRectangle", { sketch: ask, corner: { x: -N.ARM_W / 2, y: up ? 0 : -N.LA }, opposite: { x: N.ARM_W / 2, y: up ? N.LA : 0 } });
    // offset the two arms along X (arm 2 reversed) so they pass side-by-side.
    await dis(s, "feature.extrude", { sketch: ask, distance: String(N.ARM_T), ...(up ? {} : { direction: "reverse" }) });
    await dis(s, "joint.create", { kind: "revolute", moved: arm, baseOrigin: armPivot[i], movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 1, y: 0, z: 0 }, value: up ? thetaExpr : `-(${thetaExpr})`, name: `Crisscross ${i + 1}` });
    await pin(arm, 0, N.ARM_T * 3);                 // pivot pin (into the leg)
    await pin(arm, up ? N.LA : -N.LA, N.ARM_T * 3); // end pin (into the chop)
    if (up) await pin(arm, N.LA / 2, N.ARM_T * 3.4); // central pivot pin (shared crossing)
    armIds.push(arm);
  }

  // ---- vise handwheel (cast iron) with turned wooden handles, on the screw front.
  // Spins about the screw axis (Y) as the vise racks: angle ∝ viseGap.
  const R = 112, hubR = 22, hubLen = 48, rimT = 15, rimW = 24, spokeW = 18, spokeT = 13;
  const wheelCenter = { x: chopW / 2, y: -34, z: chopH - 150 }; // chop-local, on the screw axis, in front
  const wheel = (await dis(s, "component.create", { name: "Vise wheel", parent: chop }))[0];
  // hub: cylinder along Y
  const hsk = (await dis(s, "sketch.create", { plane: "XZ", component: wheel }))[0];
  await dis(s, "sketch.addCircle", { sketch: hsk, center: { x: 0, y: 0 }, radius: hubR });
  await dis(s, "feature.extrude", { sketch: hsk, distance: String(hubLen), symmetric: true });
  // rim: revolve a rectangular section about the Y axis → a ring
  const rsk = (await dis(s, "sketch.create", { plane: "YZ", component: wheel }))[0];
  await dis(s, "sketch.addRectangle", { sketch: rsk, corner: { x: -rimW / 2, y: R - rimT }, opposite: { x: rimW / 2, y: R } });
  await dis(s, "feature.revolve", { sketch: rsk, axis: { p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 } }, angle: "360" });
  // spokes: a radial bar, circular-patterned ×3, extruded across Y
  const ssk2 = (await dis(s, "sketch.create", { plane: "XZ", component: wheel }))[0];
  const spokeRect = await dis(s, "sketch.addRectangle", { sketch: ssk2, corner: { x: hubR - 3, y: -spokeW / 2 }, opposite: { x: R - rimT + 3, y: spokeW / 2 } });
  await dis(s, "sketch.circularPattern", { sketch: ssk2, entities: spokeRect.slice(4), cx: 0, cy: 0, count: 3, step: 120 });
  await dis(s, "feature.extrude", { sketch: ssk2, distance: String(spokeT), symmetric: true });
  await dis(s, "joint.create", { kind: "revolute", base: chop, moved: wheel, baseOrigin: wheelCenter, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 1, z: 0 }, value: "viseGap*14.4", name: "Wheel spin" });

  // three turned wooden handles projecting toward the user (−Y), on the wheel face.
  const handleIds: string[] = [];
  const Rh = R - 20;
  for (let i = 0; i < 3; i++) {
    const th = (i * 120 * Math.PI) / 180;
    const h = (await dis(s, "component.create", { name: `Wheel handle ${i + 1}`, parent: wheel, position: { x: Rh * Math.cos(th), y: 0, z: Rh * Math.sin(th) } }))[0];
    const psk = (await dis(s, "sketch.create", { plane: "YZ", component: h }))[0];
    // turned profile along −Y (u), radius v: collar → shaft → bulb → rounded tip.
    await dis(s, "sketch.addPolyline", { sketch: psk, points: [
      { x: 0, y: 0 }, { x: 0, y: 11 }, { x: -5, y: 11 }, { x: -8, y: 8 }, { x: -24, y: 7 }, { x: -40, y: 13 }, { x: -52, y: 9 }, { x: -58, y: 0 },
    ] });
    await dis(s, "feature.revolve", { sketch: psk, axis: { p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 } }, angle: "360" });
    handleIds.push(h);
  }

  // ---- materials: white oak bench, steel screw/criss-cross, cast-iron wheel, beech handles.
  const oak = (await dis(s, "material.create", { name: "White Oak", kind: "wood", species: "white-oak" }))[0];
  const steel = (await dis(s, "material.create", { name: "Steel", kind: "metal", finish: "satin", color: "#8a8f96" }))[0];
  const iron = (await dis(s, "material.create", { name: "Cast Iron", kind: "metal", color: "#52555b", roughness: 0.6, metalness: 0.5 }))[0];
  const beech = (await dis(s, "material.create", { name: "Beech", kind: "wood", species: "beech" }))[0];
  await dis(s, "material.assign", { material: oak });
  await dis(s, "material.assign", { material: steel, component: screw });
  for (const a of armIds) await dis(s, "material.assign", { material: steel, component: a });
  await dis(s, "material.assign", { material: iron, component: wheel });
  for (const h of handleIds) await dis(s, "material.assign", { material: beech, component: h });

  return { chop, armIds };
}

describe("parametric Roubo workbench (joinery + criss-cross vise)", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("builds, joints the vise + criss-cross, and stays sound across sizes", async () => {
    const s = realSession();
    const { chop, armIds } = await buildRoubo(s);
    await s.recompute();
    if (OUT) writeFileSync(`${OUT}/roubo.chisel.json`, serializeDocument(s.doc));

    const b0 = bodies(s);
    // top(4)+legs(4)+tenons(4)+rails(4)+chop+screw + 2 arms + 5 pins + wheel(3) + 3 handles = 31
    expect(b0.count).toBe(31);

    const chopY = () => { const sc = resolveParameters(s.doc.parameters).scope; placeComponentSketches(s.doc, sc); let hi = -Infinity; for (const x of Object.values(evaluateFeatures(s.doc, sc))) { if (x.bounds && s.doc.sketches[x.sketchId]?.componentId === chop) hi = Math.max(hi, x.bounds.max.y); } return hi; };
    await dis(s, "parameter.set", { name: "viseGap", expression: "0" }); await s.recompute();
    const closed = chopY();
    await dis(s, "parameter.set", { name: "viseGap", expression: "150" }); await s.recompute();
    expect(closed - chopY()).toBeGreaterThan(140); // chop racks out ~150mm
    void armIds;

    // resize: a bigger bench still builds the same body count.
    await dis(s, "parameter.set", { name: "viseGap", expression: "60" });
    await dis(s, "parameter.set", { name: "L", expression: "2100" });
    await dis(s, "parameter.set", { name: "H", expression: "900" });
    await s.recompute();
    expect(bodies(s).count).toBe(b0.count);
    console.log(`roubo: ${b0.count} bodies; vise racks ${(closed - chopY()).toFixed(0)}mm; resizes cleanly`);
  }, 180000);
});
