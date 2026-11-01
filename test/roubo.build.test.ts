// A fully parametric Roubo workbench, built as real woodwork: laminated top,
// legs through-tenoned into the slab, stretchers mortise-and-tenoned into the
// legs, and a leg vise whose chop is kept parallel by a criss-cross (scissor)
// stabilizer — all driven by size parameters and a `viseGap`. Oak + steel.
//   BUILD_ROUBO=/abs/out npx vitest run test/roubo.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, expectCommittedExample } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { serializeDocument } from "../src/core/persistence";
import { collideFeatures, evaluateFeatures } from "../src/core/features";
import { placeComponentSketches } from "../src/core/recompute";
import { resolveParameters } from "../src/core/parameters";
import type { CadSession } from "../src/core/command/session";

const OUT = process.env.BUILD_ROUBO || "";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

// Design values. The five sizes are parameters (L, D, H, TT, LS) and every
// board is drawn from them: corner points and plane offsets are expressions,
// so dragging a slider resizes the whole bench, joinery and vise with it.
const N = {
  L: 1700, D: 500, H: 850, TT: 100, LS: 100,   // length, depth, height, top thick, leg section
  NB: 4,                                        // top laminations
  INSET: 130,                                   // leg inset from each end
  RAIL_H: 110, RAIL_T: 32, RAIL_Z: 170,         // stretcher height / thickness / height off the floor
  RTEN: 28,                                     // stretcher tenon length
  LA: 360, ARM_W: 30, ARM_T: 12,                // criss-cross: arm length, arm section
  CHOP_T: 42, CHOP_Z: 150,                      // vise chop thickness; its foot off the floor
};
// The bench is centred on the origin: x across ±L/2, y across ±D/2, z from −H/2 (floor) to H/2 (top surface).
const TEN = "LS*0.55", OFF = "LS*0.225";       // through-tenon side; its inset from the leg face
const legX = [`-L/2+${N.INSET}`, `L/2-${N.INSET}-LS`];
const legY = ["-D/2", "D/2-LS"];
const viseX = `-L/2+${N.INSET}+LS/2`;          // the vise's centre line: the front-left leg's middle
const crossZ = `-H/2+${N.CHOP_Z}+(H-${N.CHOP_Z})*0.4`; // criss-cross centre height
const CROSS_HALF = N.LA / 2 + 24;

/** A closed loop of expression-positioned corner points (sketch coordinates), as lines. */
async function rect(s: CadSession, sketch: string, u0: string, v0: string, u1: string, v1: string): Promise<void> {
  const ids: string[] = [];
  for (const [x, y] of [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]) ids.push((await dis(s, "sketch.addPoint", { sketch, x, y }))[0]);
  for (let i = 0; i < 4; i++) await dis(s, "sketch.addLine", { sketch, start: { ref: ids[i] }, end: { ref: ids[(i + 1) % 4] } });
}

/** A board: a component holding one block, drawn on `datum` from (u0, v0) to (u1, v1) and extruded `h` up. */
async function board(s: CadSession, name: string, datum: string, u0: string, v0: string, u1: string, v1: string, h: string, parent?: string): Promise<{ cmp: string; feat: string }> {
  const cmp = (await dis(s, "component.create", { name, ...(parent ? { parent } : {}) }))[0];
  const sid = (await dis(s, "sketch.create", { datum, component: cmp, name }))[0];
  await rect(s, sid, u0, v0, u1, v1);
  const feat = (await dis(s, "feature.extrude", { sketch: sid, distance: h, name }))[0];
  return { cmp, feat };
}

/** A through-mortise in `target` (a board's body): the footprint (u0, v0)–(u1, v1) on `datum`, cut through the whole board. */
async function mortise(s: CadSession, cmp: string, target: string, datum: string, u0: string, v0: string, u1: string, v1: string): Promise<void> {
  const sid = (await dis(s, "sketch.create", { datum, component: cmp, name: "Mortise" }))[0];
  await rect(s, sid, u0, v0, u1, v1);
  await dis(s, "feature.extrude", { sketch: sid, distance: "1", operation: "cut", extent: "throughAll", symmetric: true, body: target, name: "Mortise" });
}

function bodies(s: CadSession): { count: number; byName: Record<string, { lo: number[]; hi: number[] }> } {
  const scope = resolveParameters(s.doc.parameters).scope;
  placeComponentSketches(s.doc, scope);
  const sol = Object.values(evaluateFeatures(s.doc, scope)).filter((b) => b.mesh && b.bounds);
  const byName: Record<string, { lo: number[]; hi: number[] }> = {};
  for (const b of sol) {
    const c = s.doc.components[s.doc.sketches[b.sketchId]?.componentId ?? ""]?.name ?? "?";
    const lo = [b.bounds!.min.x, b.bounds!.min.y, b.bounds!.min.z], hi = [b.bounds!.max.x, b.bounds!.max.y, b.bounds!.max.z];
    const was = byName[c];
    byName[c] = was ? { lo: lo.map((v, i) => Math.min(v, was.lo[i])), hi: hi.map((v, i) => Math.max(v, was.hi[i])) } : { lo, hi };
  }
  return { count: sol.length, byName };
}

async function buildRoubo(s: CadSession): Promise<{ chop: string; armIds: string[] }> {
  // ---- parameters: the model is driven entirely by these ----
  // [name, value, min, max, step, label, description] — every one in millimetres
  const P: [string, number, number, number, number, string, string][] = [
    ["L", N.L, 1200, 2400, 10, "Length", "Overall length of the bench top"],
    ["D", N.D, 400, 700, 10, "Depth", "Front to back across the top"],
    ["H", N.H, 750, 950, 5, "Height", "Floor to the top surface; about your wrist height when standing"],
    ["TT", N.TT, 60, 140, 5, "Top thickness", "How thick the laminated top is"],
    ["LS", N.LS, 70, 130, 5, "Leg size", "The legs' square section"],
    ["viseGap", 60, 0, 170, 5, "Vise opening", "How far the leg vise's chop stands open"],
  ];
  for (const [name, val, min, max, step, label, description] of P) await dis(s, "parameter.add", { name, expression: String(val), min, max, step, label, unit: "mm", description });

  // the planes everything is drawn on: the floor, the slab's underside, the stretchers' underside, the leg fronts
  const floor = (await dis(s, "plane.create", { base: "XY", offset: "-H/2", name: "Floor" }))[0];
  const under = (await dis(s, "plane.create", { base: "XY", offset: "H/2-TT", name: "Slab underside" }))[0];
  const railPlane = (await dis(s, "plane.create", { base: "XY", offset: `-H/2+${N.RAIL_Z}`, name: "Stretchers" }))[0];
  const front = (await dis(s, "plane.create", { base: "XZ", offset: "D/2", name: "Leg fronts" }))[0]; // XZ's normal is −Y: offset D/2 is y = −D/2

  // ---- top: laminated boards; the outer two take the leg tenons
  const topBoards: { cmp: string; feat: string }[] = [];
  for (let i = 0; i < N.NB; i++) {
    topBoards.push(await board(s, `Top ${i + 1}`, under, "-L/2", `-D/2+D*${i}/${N.NB}`, "L/2", `-D/2+D*${i + 1}/${N.NB}-0.8`, "TT"));
  }

  // ---- legs, each with a through-tenon up through the slab, flush with the top
  const legNames = ["FL", "FR", "BL", "BR"];
  let li = 0;
  const legs: Record<string, { cmp: string; feat: string }> = {};
  for (const y of legY) for (const x of legX) {
    const nm = legNames[li++];
    const leg = await board(s, `Leg ${nm}`, floor, x, y, `${x}+LS`, `${y}+LS`, "H-TT");
    legs[nm] = leg;
    const tu0 = `${x}+${OFF}`, tv0 = `${y}+${OFF}`, tu1 = `${x}+${OFF}+${TEN}`, tv1 = `${y}+${OFF}+${TEN}`;
    await board(s, `Tenon ${nm}`, under, tu0, tv0, tu1, tv1, "TT", leg.cmp);
    const host = topBoards[y === legY[0] ? 0 : N.NB - 1];
    await mortise(s, host.cmp, host.feat, under, tu0, tv0, tu1, tv1);
  }

  // ---- stretchers: front and back rails between the legs, end rails across, each tenoned
  // RTEN into a leg at both ends, through a mortise cut in that leg to the tenon's size
  const legMortise = async (nm: string, u0: string, v0: string, u1: string, v1: string) => {
    const sid = (await dis(s, "sketch.create", { datum: railPlane, component: legs[nm].cmp, name: "Rail mortise" }))[0];
    await rect(s, sid, u0, v0, u1, v1);
    await dis(s, "feature.extrude", { sketch: sid, distance: String(N.RAIL_H), operation: "cut", body: legs[nm].feat, name: "Rail mortise" });
  };
  const rx0 = `-L/2+${N.INSET}+LS-${N.RTEN}`, rx1 = `L/2-${N.INSET}-LS+${N.RTEN}`;
  for (const [name, yc, l, r] of [["Front rail", "-D/2+LS/2", "FL", "FR"], ["Back rail", "D/2-LS/2", "BL", "BR"]]) {
    const v0 = `${yc}-${N.RAIL_T / 2}`, v1 = `${yc}+${N.RAIL_T / 2}`;
    await board(s, name, railPlane, rx0, v0, rx1, v1, String(N.RAIL_H));
    await legMortise(l, rx0, v0, `-L/2+${N.INSET}+LS`, v1);
    await legMortise(r, `L/2-${N.INSET}-LS`, v0, rx1, v1);
  }
  const ry0 = `-D/2+LS-${N.RTEN}`, ry1 = `D/2-LS+${N.RTEN}`;
  for (const [name, xc, f, b] of [["End rail L", `-L/2+${N.INSET}+LS/2`, "FL", "BL"], ["End rail R", `L/2-${N.INSET}-LS/2`, "FR", "BR"]]) {
    const u0 = `${xc}-${N.RAIL_T / 2}`, u1 = `${xc}+${N.RAIL_T / 2}`;
    await board(s, name, railPlane, u0, ry0, u1, ry1, String(N.RAIL_H));
    await legMortise(f, u0, ry0, u1, "-D/2+LS");
    await legMortise(b, u0, "D/2-LS", u1, ry1);
  }
  const flLeg = legs.FL;   // the front-left leg holds the vise and its criss-cross channel

  // ---- leg vise on the front-left leg. The chop is drawn in its own frame: x across its
  // middle, y from its front face (0) back to the leg (CHOP_T), z up from its foot. It rises
  // to the benchtop surface, so it can clamp small work right at bench height.
  const chop = (await dis(s, "component.create", { name: "Vise chop" }))[0];
  const chopW = "(LS+60)", chopH = `(H-${N.CHOP_Z})`, screwZ = `H-${N.CHOP_Z}-150`; // the screw: 150 below the top
  const csk = (await dis(s, "sketch.create", { plane: "XY", component: chop, name: "Vise chop" }))[0];
  await rect(s, csk, `-${chopW}/2`, "0", `${chopW}/2`, String(N.CHOP_T));
  const chopFeat = (await dis(s, "feature.extrude", { sketch: csk, distance: chopH, name: "Vise chop" }))[0];
  // the chop slides out along −Y from the front-left leg's face by viseGap
  await dis(s, "joint.create", { kind: "slider", moved: chop, baseOrigin: { x: viseX, y: `-D/2-${N.CHOP_T}`, z: `-H/2+${N.CHOP_Z}` }, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: -1, z: 0 }, value: "viseGap", name: "Vise slide" });

  // the steel screw, on its own frame at the screw axis on the chop's front face, back through chop and leg
  const screw = (await dis(s, "component.create", { name: "Vise screw", parent: chop }))[0];
  await dis(s, "joint.create", { kind: "rigid", base: chop, moved: screw, baseOrigin: { x: 0, y: 0, z: screwZ }, movedOrigin: { x: 0, y: 0, z: 0 }, name: "Screw seat" });
  const ssk = (await dis(s, "sketch.create", { plane: "XZ", component: screw, name: "Vise screw" }))[0];
  await dis(s, "sketch.addCircle", { sketch: ssk, center: { x: 0, y: 0 }, radius: 16 });
  await dis(s, "feature.extrude", { sketch: ssk, distance: `LS+${N.CHOP_T + 30}`, direction: "reverse", name: "Vise screw" });

  // garter: a black-steel flange the screw passes through, bolted to the chop's front face
  const garter = (await dis(s, "component.create", { name: "Vise garter", parent: chop }))[0];
  await dis(s, "joint.create", { kind: "rigid", base: chop, moved: garter, baseOrigin: { x: 0, y: 0, z: screwZ }, movedOrigin: { x: 0, y: 0, z: 0 }, name: "Garter seat" });
  const gsk = (await dis(s, "sketch.create", { plane: "XZ", component: garter, name: "Garter" }))[0];
  await dis(s, "sketch.addCircle", { sketch: gsk, center: { x: 0, y: 0 }, radius: 46 });
  await dis(s, "sketch.addCircle", { sketch: gsk, center: { x: 0, y: 0 }, radius: 17 }); // the screw clears
  const flange = (await dis(s, "feature.extrude", { sketch: gsk, distance: "10", name: "Garter" }))[0]; // −Y, onto the front face
  const bsk = (await dis(s, "sketch.create", { plane: "XZ", component: garter, name: "Garter bolts" }))[0];
  for (let i = 0; i < 4; i++) { const a = (i * 90 + 45) * Math.PI / 180; await dis(s, "sketch.addCircle", { sketch: bsk, center: { x: 36 * Math.cos(a), y: 36 * Math.sin(a) }, radius: 4.5 }); }
  await dis(s, "feature.extrude", { sketch: bsk, distance: "12", operation: "join", body: flange, name: "Garter bolts" }); // heads on the flange: one part

  // criss-cross stabiliser: a real scissor, solved. Both arms pivot about a carrier at the
  // mid-gap (it slides out half as fast as the chop); each arm's chop-end pin rides a vertical
  // slot in the chop (a pin-slot joint), so the kernel finds the arm angle as the vise racks.
  const armIds: string[] = [];
  const carrier = (await dis(s, "component.create", { name: "Crisscross carrier" }))[0];
  await dis(s, "joint.create", { kind: "slider", moved: carrier, baseOrigin: { x: viseX, y: "-D/2", z: crossZ }, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: -1, z: 0 }, value: "viseGap/2", name: "Crisscross centre" });
  const chopSlot = { x: 0, y: N.CHOP_T - 10, z: 0 };   // the slot in the chop (chop frame), 10 mm in from its back
  const pin = async (parent: string, zLocal: number, len: number) => {
    const p = (await dis(s, "component.create", { name: "Pin", parent, position: { x: 0, y: 0, z: zLocal } }))[0];
    const sk = (await dis(s, "sketch.create", { plane: "YZ", component: p, name: "Pin" }))[0];
    await dis(s, "sketch.addCircle", { sketch: sk, center: { x: 0, y: 0 }, radius: N.ARM_W * 0.33 });
    await dis(s, "feature.extrude", { sketch: sk, distance: String(len), symmetric: true, name: "Pin" });
  };
  for (let i = 0; i < 2; i++) {
    const up = i === 0;
    const arm = (await dis(s, "component.create", { name: `Crisscross arm ${i + 1}` }))[0];
    const ask = (await dis(s, "sketch.create", { plane: "YZ", component: arm, name: `Crisscross arm ${i + 1}` }))[0];
    await dis(s, "sketch.addRectangle", { sketch: ask, corner: { x: -N.ARM_W / 2, y: -N.LA / 2 }, opposite: { x: N.ARM_W / 2, y: N.LA / 2 } });
    for (const z of [-N.LA / 2 + N.ARM_W / 2, 0, N.LA / 2 - N.ARM_W / 2]) await dis(s, "sketch.addCircle", { sketch: ask, center: { x: 0, y: z }, radius: N.ARM_W * 0.33 + 0.3 }); // holes for the pins
    await dis(s, "feature.extrude", { sketch: ask, distance: String(N.ARM_T), ...(up ? {} : { direction: "reverse" }), name: `Crisscross arm ${i + 1}` }); // side by side in X
    const chopEndZ = up ? -N.LA / 2 + N.ARM_W / 2 : N.LA / 2 - N.ARM_W / 2;   // the end pin's centre
    await dis(s, "joint.create", { kind: "pin-slot", base: carrier, moved: arm, baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 1, y: 0, z: 0 }, pin: { x: 0, y: 0, z: chopEndZ }, slotBase: chop, slotPoint: chopSlot, slotDir: { x: 0, y: 0, z: 1 }, name: `Crisscross ${i + 1}` });
    await pin(arm, N.LA / 2 - N.ARM_W / 2, N.ARM_T * 3);
    await pin(arm, -N.LA / 2 + N.ARM_W / 2, N.ARM_T * 3);
    if (up) await pin(arm, 0, N.ARM_T * 3.4);   // the shared centre pivot
    armIds.push(arm);
  }

  // ---- the screw's bore, through the chop and the leg behind it (a point at the screw axis is the circle's centre)
  const bore = async (cmp: string, target: string, sketchOn: Record<string, unknown>, u: string, v: string, name: string) => {
    const sid = (await dis(s, "sketch.create", { ...sketchOn, component: cmp, name }))[0];
    const c = (await dis(s, "sketch.addPoint", { sketch: sid, x: u, y: v }))[0];
    await dis(s, "sketch.addCircle", { sketch: sid, center: { ref: c }, radius: 17 });
    await dis(s, "feature.extrude", { sketch: sid, distance: "1", operation: "cut", extent: "throughAll", symmetric: true, body: target, name });
  };
  await bore(chop, chopFeat, { plane: "XZ" }, "0", screwZ, "Screw bore");
  await bore(flLeg.cmp, flLeg.feat, { datum: front }, viseX, "H/2-150", "Screw bore");

  // ---- channels so the scissor sits recessed into both jaws, the leg and the chop
  {
    const chk = (await dis(s, "sketch.create", { datum: front, component: flLeg.cmp, name: "Criss-cross channel" }))[0];
    await rect(s, chk, `${viseX}-24`, `${crossZ}-${CROSS_HALF}`, `${viseX}+24`, `${crossZ}+${CROSS_HALF}`);
    await dis(s, "feature.extrude", { sketch: chk, distance: "64", operation: "cut", symmetric: true, body: flLeg.feat, name: "Criss-cross channel" });
  }
  {
    // a pocket in the chop's back face (chop frame y = CHOP_T: the XZ plane offset −CHOP_T)
    const czc = `(H-${N.CHOP_Z})*0.4`;
    const pk = (await dis(s, "sketch.create", { plane: "XZ", component: chop, offset: -N.CHOP_T, name: "Criss-cross pocket" }))[0];
    await rect(s, pk, "-24", `${czc}-${CROSS_HALF}`, "24", `${czc}+${CROSS_HALF}`);
    await dis(s, "feature.extrude", { sketch: pk, distance: "64", operation: "cut", symmetric: true, body: chopFeat, name: "Criss-cross pocket" }); // 32 deep: a 10 mm front wall
  }

  // ---- vise handwheel (cast iron) with turned wooden handles, on the screw front.
  // Spins about the screw axis (Y) as the vise racks: angle ∝ viseGap.
  const R = 100, hubR = 22, hubLen = 46, rimT = 15, rimW = 24;
  const wheelCenter = { x: 0, y: -34, z: screwZ }; // chop frame: on the screw axis, in front
  const wheel = (await dis(s, "component.create", { name: "Vise wheel", parent: chop }))[0];
  // hub: cylinder along Y
  const hsk = (await dis(s, "sketch.create", { plane: "XZ", component: wheel }))[0];
  await dis(s, "sketch.addCircle", { sketch: hsk, center: { x: 0, y: 0 }, radius: hubR });
  const hub = (await dis(s, "feature.extrude", { sketch: hsk, distance: String(hubLen), symmetric: true, name: "Wheel" }))[0]; // the wheel is one casting: the rest joins the hub
  // raised central boss (the cast nut cap), proud of the hub front (−Y)
  const bosk = (await dis(s, "sketch.create", { plane: "XZ", component: wheel }))[0];
  await dis(s, "sketch.addCircle", { sketch: bosk, center: { x: 0, y: 0 }, radius: 27 });
  await dis(s, "feature.extrude", { sketch: bosk, distance: String(hubLen / 2 + 12), operation: "join", body: hub, name: "Wheel boss" });
  // rim: revolve a rectangular section about the Y axis → a ring
  const rsk = (await dis(s, "sketch.create", { plane: "YZ", component: wheel }))[0];
  await dis(s, "sketch.addRectangle", { sketch: rsk, corner: { x: -rimW / 2, y: R - rimT }, opposite: { x: rimW / 2, y: R } });
  await dis(s, "feature.revolve", { sketch: rsk, axis: { p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 } }, angle: "360", operation: "join", body: hub, name: "Wheel rim" });
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
  await dis(s, "feature.extrude", { sketch: ssk2, distance: "13", symmetric: true, operation: "join", body: hub, name: "Wheel spokes" });
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

  // the shop drawing goes with it: the viewer offers it as a PDF
  await dis(s, "drawing.publish", { title: "Roubo workbench" });
  // how it reads in the viewer: a title and a line about it
  await dis(s, "document.describe", { title: "Roubo workbench", description: "A full-size woodworking bench with a leg vise. Size it to your shop, then download the shop drawing and cut list." });

  return { chop, armIds };
}

describe("parametric Roubo workbench (joinery + criss-cross vise)", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("builds, joints the vise + criss-cross, and every size slider resizes it", async () => {
    const s = realSession();
    const { chop } = await buildRoubo(s);
    await s.recompute();
    if (OUT) writeFileSync(`${OUT}/roubo.vibecad.json`, serializeDocument(s.doc));
    expectCommittedExample(s, "roubo");

    const b0 = bodies(s);
    // top(4)+legs(4)+tenons(4)+rails(4)+chop+screw+garter + 2 arms + 5 pins + wheel + 3 landings + 3 handles = 33
    expect(b0.count).toBe(33);

    const chopName = s.doc.components[chop].name;
    const chopFront = () => bodies(s).byName[chopName].lo[1];
    const set = async (name: string, v: number) => { await dis(s, "parameter.set", { name, expression: String(v) }); await s.recompute(); };
    await set("viseGap", 0);
    const closed = chopFront();
    await set("viseGap", 150);
    expect(closed - chopFront()).toBeCloseTo(150, 0); // the chop racks out by the gap
    await set("viseGap", 60);

    // the slab: one board per lamination, together L × D × TT, its top at H/2
    const slab = (b: ReturnType<typeof bodies>) => {
      const tops = Object.entries(b.byName).filter(([n]) => n.startsWith("Top ")).map(([, v]) => v);
      return { x: Math.max(...tops.map((t) => t.hi[0])) - Math.min(...tops.map((t) => t.lo[0])), y: Math.max(...tops.map((t) => t.hi[1])) - Math.min(...tops.map((t) => t.lo[1])), z0: Math.min(...tops.map((t) => t.lo[2])), z1: Math.max(...tops.map((t) => t.hi[2])) };
    };
    const leg = (b: ReturnType<typeof bodies>) => b.byName["Leg FL"];
    let sl = slab(b0);
    expect(sl.x).toBeCloseTo(1700, 0); expect(sl.y).toBeCloseTo(499.2, 0); expect(sl.z1 - sl.z0).toBeCloseTo(100, 0);

    await set("L", 2100); await set("D", 600); await set("H", 900); await set("TT", 80); await set("LS", 120);
    const b1 = bodies(s);
    expect(b1.count).toBe(33);
    sl = slab(b1);
    expect(sl.x).toBeCloseTo(2100, 0);
    expect(sl.y).toBeCloseTo(599.2, 0);
    expect(sl.z1 - sl.z0).toBeCloseTo(80, 0);
    expect(sl.z1).toBeCloseTo(450, 0);                                   // the top surface at H/2
    const l = leg(b1);
    expect(l.hi[0] - l.lo[0]).toBeCloseTo(120, 0);                       // leg section follows LS
    expect(l.lo[2]).toBeCloseTo(-450, 0);                                // on the floor at −H/2
    expect(l.lo[0]).toBeCloseTo(-1050 + N.INSET, 0);                     // inset from the end, which moved with L
    expect(b1.byName[chopName].hi[2]).toBeCloseTo(450, 0);              // the chop still rises to the top surface
    expect(b1.byName[chopName].hi[0] - b1.byName[chopName].lo[0]).toBeCloseTo(180, 0); // and is LS + 60 wide
    console.log(`roubo: ${b0.count} bodies; vise racks 150 mm; L, D, H, TT and LS each resize it`);
    if (process.env.ROUBO_OVERLAPS) {
      const sc = resolveParameters(s.doc.parameters).scope; placeComponentSketches(s.doc, sc);
      for (const o of collideFeatures(s.doc, sc).overlaps) console.log(`overlap ${o.a} × ${o.b}: ${o.volume.toFixed(1)} mm³`);
    }
  }, 240000);
});
