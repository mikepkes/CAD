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
  let flLeg = { cmp: "", feat: "" };     // front-left leg hosts the vise + its criss-cross channel
  for (const y of legY) for (const x of legX) {
    const nm = legNames[li++];
    const legB = await board(s, `Leg ${nm}`, at(x, y, 0), [N.LS, N.LS, legTopZ]);
    const leg = legB.cmp;
    if (nm === "FL") flLeg = legB;
    // tenon: a reduced square carried from the slab underside up through it,
    // ending FLUSH with the top (the top is a reference surface — no proud
    // tenon). Its own child body, in leg-local coords.
    await board(s, `Tenon ${nm}`, { x: off, y: off, z: legTopZ }, [N.TEN, N.TEN, N.TT], leg);
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
  // chop runs from low on the leg UP to the benchtop surface, so it can clamp
  // small work right at bench height (bottom at z=150, top flush with the top).
  const chopW = N.LS + 60, chopT = 42, chopH = legTopZ + N.TT - 150;
  const csk = (await dis(s, "sketch.create", { plane: "XY", component: chop }))[0];
  await dis(s, "sketch.addRectangle", { sketch: csk, corner: { x: 0, y: 0 }, opposite: { x: chopW, y: chopT } });
  const chopFeat = (await dis(s, "feature.extrude", { sketch: csk, distance: String(chopH) }))[0];
  // screw (steel), own sub-component so it can be metal; runs back into the leg.
  const screw = (await dis(s, "component.create", { name: "Vise screw", parent: chop }))[0];
  const ssk = (await dis(s, "sketch.create", { plane: "XZ", component: screw }))[0];
  await dis(s, "sketch.addCircle", { sketch: ssk, center: { x: chopW / 2, y: chopH - 150 }, radius: 16 });
  await dis(s, "feature.extrude", { sketch: ssk, distance: String(chopT + N.LS + 30), direction: "reverse" });

  // garter / mounting flange: a black-steel plate the screw passes through,
  // bolted to the chop front face. Its own component so it rides with the chop.
  const garter = (await dis(s, "component.create", { name: "Vise garter", parent: chop }))[0];
  const gcx = chopW / 2, gcz = chopH - 150;              // centred on the screw axis
  const gsk = (await dis(s, "sketch.create", { plane: "XZ", component: garter }))[0];
  await dis(s, "sketch.addCircle", { sketch: gsk, center: { x: gcx, y: gcz }, radius: 46 });
  await dis(s, "sketch.addCircle", { sketch: gsk, center: { x: gcx, y: gcz }, radius: 17 }); // screw clears
  await dis(s, "feature.extrude", { sketch: gsk, distance: "10" });                 // -Y, onto the front face
  // four bolt heads in a ring around the flange (one extrude → one body)
  const bsk = (await dis(s, "sketch.create", { plane: "XZ", component: garter }))[0];
  for (let i = 0; i < 4; i++) { const a = (i * 90 + 45) * Math.PI / 180; await dis(s, "sketch.addCircle", { sketch: bsk, center: { x: gcx + 36 * Math.cos(a), y: gcz + 36 * Math.sin(a) }, radius: 4.5 }); }
  await dis(s, "feature.extrude", { sketch: bsk, distance: "12" });

  // chop slides along -Y (front) on a slider; closed = back face at the leg front.
  const chopPivotX = N.INSET + N.LS / 2 - chopW / 2;
  const P0 = at(chopPivotX, -chopT, 150);
  await dis(s, "joint.create", { kind: "slider", moved: chop, baseOrigin: P0, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: -1, z: 0 }, value: "viseGap", name: "Vise slide" });

  // criss-cross stabiliser — a real scissor. Both arms pivot about a CARRIER that
  // rides at the mid-gap (it slides out half as fast as the chop), so each arm's
  // ends land exactly on their leg pin and chop pin and never overshoot the chop.
  // Gap leg-pin → chop-pin  G = G0 + viseGap;  arm half-reach in Y = G/2, which is
  // (LA/2)·sinθ, so θ = asin(G/LA). This is a driven mechanism: carrier value and
  // both arm angles are all expressions of the one viseGap.
  const armIds: string[] = [];
  const zc = 150 + chopH * 0.4;                   // criss-cross centre height
  const G0 = 24;                                   // leg-pin → chop-pin gap when closed
  const cxW = chopPivotX + chopW / 2;              // criss-cross centre in world x
  const thetaExpr = `deg(asin((${G0}+viseGap)/${N.LA}))`;
  // carrier at the mid-gap: at viseGap=0 it sits at the leg face (y=0) and slides
  // −Y by viseGap/2 as the chop opens.
  const carrier = (await dis(s, "component.create", { name: "Crisscross carrier" }))[0];
  await dis(s, "joint.create", { kind: "slider", moved: carrier, baseOrigin: at(cxW, 0, zc), movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: -1, z: 0 }, value: "viseGap/2", name: "Crisscross centre" });
  // a steel pin: a cylinder along X through a point in the arm's local frame.
  const pin = async (parent: string, zLocal: number, len: number) => {
    const p = (await dis(s, "component.create", { name: "Pin", parent, position: { x: 0, y: 0, z: zLocal } }))[0];
    const sk = (await dis(s, "sketch.create", { plane: "YZ", component: p }))[0];
    await dis(s, "sketch.addCircle", { sketch: sk, center: { x: 0, y: 0 }, radius: N.ARM_W * 0.33 });
    await dis(s, "feature.extrude", { sketch: sk, distance: String(len), symmetric: true });
  };
  for (let i = 0; i < 2; i++) {
    const up = i === 0;
    // each arm is a bar CENTRED on the carrier (Z from −LA/2..LA/2), tilted ±θ.
    const arm = (await dis(s, "component.create", { name: `Crisscross arm ${i + 1}` }))[0];
    const ask = (await dis(s, "sketch.create", { plane: "YZ", component: arm }))[0];
    await dis(s, "sketch.addRectangle", { sketch: ask, corner: { x: -N.ARM_W / 2, y: -N.LA / 2 }, opposite: { x: N.ARM_W / 2, y: N.LA / 2 } });
    await dis(s, "feature.extrude", { sketch: ask, distance: String(N.ARM_T), ...(up ? {} : { direction: "reverse" }) }); // offset in X so they cross side-by-side
    await dis(s, "joint.create", { kind: "revolute", base: carrier, moved: arm, baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 1, y: 0, z: 0 }, value: up ? `-(${thetaExpr})` : thetaExpr, name: `Crisscross ${i + 1}` });
    await pin(arm, N.LA / 2, N.ARM_T * 3);          // top-end pin
    await pin(arm, -N.LA / 2, N.ARM_T * 3);         // bottom-end pin
    if (up) await pin(arm, 0, N.ARM_T * 3.4);       // shared centre pivot pin
    armIds.push(arm);
  }

  // ---- routed channels so the scissor recesses into BOTH jaws (leg + chop),
  // like a real criss-cross, instead of standing against / poking through flat wood.
  const crossHalfZ = N.LA / 2 + 24;
  {
    const cu = N.LS / 2;                            // criss-cross centre in leg-local x
    const chk = (await dis(s, "sketch.create", { plane: "XZ", component: flLeg.cmp }))[0];
    await dis(s, "sketch.addRectangle", { sketch: chk, corner: { x: cu - 24, y: zc - crossHalfZ }, opposite: { x: cu + 24, y: zc + crossHalfZ } });
    await dis(s, "feature.extrude", { sketch: chk, distance: "48", operation: "cut", symmetric: true, body: flLeg.feat });
  }
  {
    // pocket in the chop BACK face (chop-local y=chopT; that is −chopT along the
    // XZ normal) for the chop-side ends, so they seat into the chop, not through it.
    const cx = chopW / 2, czc = zc - 150;          // chop-local centre (chop base z = 150)
    const pk = (await dis(s, "sketch.create", { plane: "XZ", component: chop, offset: -chopT }))[0];
    await dis(s, "sketch.addRectangle", { sketch: pk, corner: { x: cx - 24, y: czc - crossHalfZ }, opposite: { x: cx + 24, y: czc + crossHalfZ } });
    await dis(s, "feature.extrude", { sketch: pk, distance: "50", operation: "cut", symmetric: true, body: chopFeat });
  }

  // ---- vise handwheel (cast iron) with turned wooden handles, on the screw front.
  // Spins about the screw axis (Y) as the vise racks: angle ∝ viseGap.
  const R = 100, hubR = 22, hubLen = 46, rimT = 15, rimW = 24;
  const wheelCenter = { x: chopW / 2, y: -34, z: chopH - 150 }; // chop-local, on the screw axis, in front
  const wheel = (await dis(s, "component.create", { name: "Vise wheel", parent: chop }))[0];
  // hub: cylinder along Y
  const hsk = (await dis(s, "sketch.create", { plane: "XZ", component: wheel }))[0];
  await dis(s, "sketch.addCircle", { sketch: hsk, center: { x: 0, y: 0 }, radius: hubR });
  await dis(s, "feature.extrude", { sketch: hsk, distance: String(hubLen), symmetric: true });
  // raised central boss (the cast nut cap), proud of the hub front (−Y)
  const bosk = (await dis(s, "sketch.create", { plane: "XZ", component: wheel }))[0];
  await dis(s, "sketch.addCircle", { sketch: bosk, center: { x: 0, y: 0 }, radius: 27 });
  await dis(s, "feature.extrude", { sketch: bosk, distance: String(hubLen / 2 + 12) });
  // rim: revolve a rectangular section about the Y axis → a ring
  const rsk = (await dis(s, "sketch.create", { plane: "YZ", component: wheel }))[0];
  await dis(s, "sketch.addRectangle", { sketch: rsk, corner: { x: -rimW / 2, y: R - rimT }, opposite: { x: rimW / 2, y: R } });
  await dis(s, "feature.revolve", { sketch: rsk, axis: { p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 } }, angle: "360" });
  // three curved (cast) spokes: a bowed constant-width bar, stamped at 0/120/240°.
  const ssk2 = (await dis(s, "sketch.create", { plane: "XZ", component: wheel }))[0];
  const ri = hubR - 4, ro = R - rimT + 3, hw = 8, bow = 20, mid = (ri + ro) / 2;
  const rot = (x: number, y: number, d: number) => { const a = (d * Math.PI) / 180, c = Math.cos(a), s2 = Math.sin(a); return { x: x * c - y * s2, y: x * s2 + y * c }; };
  for (const phi of [0, 120, 240]) {
    const A = rot(ri, -hw, phi), B = rot(ro, -hw, phi), C = rot(ro, hw, phi), D = rot(ri, hw, phi);
    const vL = rot(mid, -hw + bow, phi), vU = rot(mid, hw + bow, phi);
    await dis(s, "sketch.addProfile", { sketch: ssk2, segments: [
      { x: A.x, y: A.y }, { x: B.x, y: B.y, via: { x: vL.x, y: vL.y } }, { x: C.x, y: C.y }, { x: D.x, y: D.y, via: { x: vU.x, y: vU.y } },
    ] });
  }
  await dis(s, "feature.extrude", { sketch: ssk2, distance: "13", symmetric: true });
  const Rh = R - 6;                           // handles mount on the rim
  const handleAng = (i: number) => ((i * 120 + 90) * Math.PI) / 180;
  await dis(s, "joint.create", { kind: "revolute", base: chop, moved: wheel, baseOrigin: wheelCenter, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 1, z: 0 }, value: "viseGap*14.4", name: "Wheel spin" });

  // Handles + landings. Each turned knob points mostly RADIALLY outward with a
  // modest cant toward the operator (~22° off the wheel plane). The matching cast
  // LANDING shares the SAME cant, so its outer face is perpendicular to the handle
  // axis and the turned base seats flat on it (not at an angle on a flat-to-wheel
  // pad). Both are built axial (−Y) and tilted into pose by a fixed revolute joint
  // on the wheel, so they ride the wheel's spin. (Components only translate and a
  // custom plane won't follow a jointed frame, so the tilt must be a joint.)
  const handleIds: string[] = [];
  const landingIds: string[] = [];
  const T = Math.tan((22.5 * Math.PI) / 180);   // out-of-plane cant ≈ 22.5°
  const cantAng = (Math.acos(T / Math.hypot(1, T)) * 180) / Math.PI;
  const ySeat = -10;                             // seat point, just proud of the rim front
  for (let i = 0; i < 3; i++) {
    const th = handleAng(i);
    const c = Math.cos(th), sn = Math.sin(th);
    const seat = { x: Rh * c, y: ySeat, z: Rh * sn };
    const ax = { x: -sn, y: 0, z: c };           // cant axis: tilt −Y out to d=(c,−T,sn)
    // landing: a short cast boss coaxial with the handle, extending INTO the rim;
    // its outer (seat) face ends up perpendicular to the handle axis.
    const land = (await dis(s, "component.create", { name: `Handle landing ${i + 1}` }))[0];
    const lsk = (await dis(s, "sketch.create", { plane: "XZ", component: land }))[0];
    await dis(s, "sketch.addCircle", { sketch: lsk, center: { x: 0, y: 0 }, radius: 14 });
    await dis(s, "feature.extrude", { sketch: lsk, distance: "24", direction: "reverse" }); // +Y local → into the rim
    await dis(s, "joint.create", { kind: "revolute", base: wheel, moved: land, baseOrigin: seat, movedOrigin: { x: 0, y: 0, z: 0 }, axis: ax, value: String(cantAng), name: `Landing ${i + 1} cant` });
    landingIds.push(land);
    // handle: the turned knob, same cant, extending outward (−Y local → d).
    const h = (await dis(s, "component.create", { name: `Wheel handle ${i + 1}` }))[0];
    const psk = (await dis(s, "sketch.create", { plane: "YZ", component: h }))[0];
    await dis(s, "sketch.addPolyline", { sketch: psk, points: [
      { x: 0, y: 0 }, { x: 0, y: 11 }, { x: -5, y: 11 }, { x: -8, y: 8 }, { x: -24, y: 7 }, { x: -40, y: 13 }, { x: -52, y: 9 }, { x: -58, y: 0 },
    ] });
    await dis(s, "feature.revolve", { sketch: psk, axis: { p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 } }, angle: "360" });
    await dis(s, "joint.create", { kind: "revolute", base: wheel, moved: h, baseOrigin: seat, movedOrigin: { x: 0, y: 0, z: 0 }, axis: ax, value: String(cantAng), name: `Handle ${i + 1} cant` });
    handleIds.push(h);
  }

  // ---- materials: BEECH bench, steel screw/criss-cross, cast-iron wheel, and
  // walnut handles (a contrasting species, to show the library differentiates).
  const beech = (await dis(s, "material.create", { name: "Beech", kind: "wood", species: "beech" }))[0];
  const steel = (await dis(s, "material.create", { name: "Steel", kind: "metal", finish: "satin", color: "#8a8f96" }))[0];
  const blackIron = (await dis(s, "material.create", { name: "Black Cast Iron", kind: "metal", color: "#26292e", roughness: 0.5, metalness: 1.0 }))[0];
  const iron = (await dis(s, "material.create", { name: "Cast Iron", kind: "metal", color: "#93979d", roughness: 0.6, metalness: 0.72 }))[0];
  const walnut = (await dis(s, "material.create", { name: "Walnut", kind: "wood", species: "walnut" }))[0];
  await dis(s, "material.assign", { material: beech });
  await dis(s, "material.assign", { material: steel, component: screw });
  await dis(s, "material.assign", { material: blackIron, component: garter });   // flange + bolts inherit
  for (const a of armIds) await dis(s, "material.assign", { material: blackIron, component: a }); // criss-cross = black cast iron; pins inherit
  await dis(s, "material.assign", { material: iron, component: wheel });
  for (const l of landingIds) await dis(s, "material.assign", { material: iron, component: l });  // landings are cast too
  for (const h of handleIds) await dis(s, "material.assign", { material: walnut, component: h });

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
    // top(4)+legs(4)+tenons(4)+rails(4)+chop+screw+garter(flange+bolts=2)
    //   + 2 arms + 5 pins + wheel(hub+boss+rim+spokes=4) + 3 landings + 3 handles = 37
    expect(b0.count).toBe(37);

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
