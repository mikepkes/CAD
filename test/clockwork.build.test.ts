// End-to-end: a clockwork of every kind of gear VibeCAD makes, all driven by one
// slider. Turn the knob (`turn`, degrees) and:
//   - a planetary stage reduces it 4:1 — the sun on the knob's shaft, three
//     planets riding a carrier inside a ring gear fixed to the base;
//   - the carrier's spur gear A drives a spur pair, a helical pair and a
//     herringbone pair stepping the speed back up, ×2 each;
//   - A also turns spur K in front of it, whose crank pin rides in a slot
//     under the rack (a Scotch yoke): turn the knob on and on and the rack
//     runs back and forth along the front, never off its posts, rocking a
//     pinion with a hand to and fro;
//   - a straight bevel pair turns the drive through 90° onto a cross shaft;
//   - a worm on the cross shaft drives a wheel with a hand: the slow "clock";
//   - spur G off A turns a Geneva crank: its pin steps a four-slot star a
//     quarter turn per turn of the crank, and locks it still in between.
// Every gear is one feature.gear, each pair placed by `mesh` (or, for the
// bevel and worm pairs, by the maths in feature.gear's description), so the
// teeth are phased to mesh at rest; every shaft is a component on a revolute
// joint whose value is `turn` times the gear ratios down the train, so they
// stay meshed as it turns. Printable: every gear has a 5 mm bore on a 4.8 mm
// pin and 0.1 mm of backlash a side.
//   BUILD_CLOCKWORK=/abs/out npx vitest run test/clockwork.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, describeExample, itFull, expectCommittedExample } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { serializeDocument } from "../src/core/persistence";
import { collideFeatures, gearValues } from "../src/core/features";
import type { GearFeature } from "../src/core/document";
import { placeComponentSketches } from "../src/core/recompute";
import { resolveParameters } from "../src/core/parameters";
import { wormGeometry } from "../src/core/geometry/gear";
import type { CadSession } from "../src/core/command/session";

const OUT = process.env.BUILD_CLOCKWORK || "";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

// ---- the gearing ----
const M = 2, MP = 1.5;                 // module: the train, the planetary stage
const Z = {
  sun: 12, planet: 12, ring: 36,       // ring = sun + 2·planet; (sun + ring)/3 planets is whole, so they fit
  A: 30,                               // on the carrier: drives the rack and B
  B: 15, C: 28,                        // spur B, helical C: one shaft (S2)
  D: 14, E: 28,                        // helical D, herringbone E: S3
  F: 14, H: 21,                        // herringbone F, bevel H: S4
  I: 14,                               // bevel I: the cross shaft, with the worm
  J: 24, starts: 1,                    // the worm wheel
  G: 12,                               // the Geneva crank's spur, meshing A
  K: 12,                               // the Scotch yoke's crank, meshing A in front
  rack: 17, P: 12,                     // the rack, and the pinion it rocks
};
const RANGE = 180;                     // turn: ±180°
const HELIX = 20, CHEVRON = 30;        // helical, herringbone helix angles
const WORM = { d: 16, L: 30 };         // worm pitch diameter, length
const FW = 7;                          // face width
const BORE = 5, PIN = 2.4;             // gear bores, pin radius (0.1 clearance)

// ---- the levels (z, mm): base top at 0 ----
const BASE_T = 6;
const L1 = 1, L2 = 12.5, L3 = 20.5;    // gear faces start here (each FW tall)
const CARRIER = { z0: 9.5, z1: 12.5 };
const KNOB = { z0: 21, z1: 29, r: 9 };

// ---- the layout: shaft centres (plan, mm) ----
const deg = Math.PI / 180;
const dir = (a: number) => ({ x: Math.cos(a * deg), y: Math.sin(a * deg) });
const add = (p: { x: number; y: number }, d: number, a: number) => ({ x: p.x + d * dir(a).x, y: p.y + d * dir(a).y });
const ANG = { S2: 100, S3: 180, S4: 225 };               // direction of each next shaft from the last
const S1 = { x: 0, y: 0 };
const S2 = add(S1, (M * (Z.A + Z.B)) / 2, ANG.S2);
const S3 = add(S2, (M * (Z.C + Z.D)) / 2, ANG.S3);
const S4 = add(S3, (M * (Z.E + Z.F)) / 2, ANG.S4);
// the bevel pair: H on S4 with its heel at L3; I on a cross shaft along X through H's apex, on S4's −X side
const H_APEX = L3 + (M * Z.I) / 2;                       // apex height = I's pitch radius above H's heel
const I_HEEL_X = S4.x - (M * Z.H) / 2;                   // I's heel plane: H's pitch radius from S4's axis
const W = wormGeometry(M, Z.starts, WORM.d, { backlash: 0.1 });
const WORM_X1 = I_HEEL_X - 14, WORM_X0 = WORM_X1 - WORM.L; // the worm, past a bearing post
const JC = { x: (WORM_X0 + WORM_X1) / 2, y: S4.y - (WORM.d + M * Z.J) / 2 }; // the wheel: beside the worm, like the gear test
const J_Z0 = H_APEX - FW / 2;                            // wheel faces, its middle on the worm's axis
// the Scotch yoke: K in front of A, its crank pin (radius YOKE.r, pointing at A at rest) in a slot
// across a plate under the rack, which rides on two posts at L_RACK, clear above A and K; the rack's
// teeth face A, and pinion P meshes them from behind, off to the left
const SK = add(S1, (M * (Z.A + Z.K)) / 2, -90);
const YOKE = { r: 7, pin: 1.5, gap: 0.15, z0: L2 + FW + 1, z1: L2 + FW + 3.5 }; // crank radius, pin radius, slot clearance, plate
const L_RACK = YOKE.z1;                                  // the rack's (and P's) bottom face
const RACK_Y = SK.y + 2;                                 // its pitch line: the body behind it, over the slot
const RACK_RIM = 6;
const P_ALONG = -30;                                     // P, along the rack from its middle
// the Geneva drive: crank shaft S5 off A, the star a centre distance GC from it
const GENEVA = { n: 4, a: 18, pin: 2.5, slot: 5.4, star: 18.2 }; // slots, crank radius, crank pin radius, slot width, star radius
const S5 = add(S1, (M * (Z.A + Z.G)) / 2, -10);
const GC = GENEVA.a / Math.sin(Math.PI / GENEVA.n);      // the crank pin enters each slot square to it
const STAR = add(S5, GC, 90);
const G_CRANK = { z0: L2 + FW + 1, z1: L2 + FW + 3.5 };  // the crank plate, above G
const G_STAR = { z0: G_CRANK.z1 + 1, z1: G_CRANK.z1 + 6 }; // the star and the locking disc

// ---- the drive: every shaft's turn as `turn` times the ratios to it ----
const carrier = `turn*${Z.sun}/(${Z.sun}+${Z.ring})`;
const s2 = `-${carrier}*${Z.A}/${Z.B}`;
const s3 = `${carrier}*${Z.A}/${Z.B}*${Z.C}/${Z.D}`;
const s4 = `-${carrier}*${Z.A}/${Z.B}*${Z.C}/${Z.D}*${Z.E}/${Z.F}`;
const cross = `${carrier}*${Z.A}/${Z.B}*${Z.C}/${Z.D}*${Z.E}/${Z.F}*${Z.H}/${Z.I}`; // −(S4)·H/I, about +X
const dial = `${cross}*${Z.starts}/${Z.J}`;
const planet = `-(turn - ${carrier})*${Z.sun}/${Z.planet}`;    // relative to the carrier
const kTurn = `(-${carrier}*${Z.A}/${Z.K})`;
const rack = `-${YOKE.r}*sin(rad(${kTurn}))`;                 // mm along X: the crank pin's x (at 90° at rest)
const pinion = `(${rack})*360/(pi*${M}*${Z.P})`;              // rolled along by the rack
const crank = `(-${carrier}*${Z.A}/${Z.G})`;
/** The star's turn for a crank turned `t`: whole steps of 360/n, plus the step in progress while the pin is in a slot
 *  (|ψ| < 90 − 180/n from the line of centres), where the slot follows the pin: atan2(sin ψ, GC/a − cos ψ). */
const genevaStar = (t: string) => {
  const step = 360 / GENEVA.n, half = 180 / GENEVA.n, win = 90 - half;
  const psi = `max(-${win}, min(${win}, ${t} - 180 - 360*floor(${t}/360)))`;
  return `-${step}*floor(${t}/360) - deg(atan2(sin(rad(${psi})), 1/sin(pi/${GENEVA.n}) - cos(rad(${psi})))) - ${half}`;
};
const star = genevaStar(crank);

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Circles (plan) extruded `h` up from z0 in `comp`: one body. */
async function discs(s: CadSession, comp: string, z0: number, h: number, cs: { x: number; y: number; r: number }[], name: string, holes: { x: number; y: number; r: number }[] = []) {
  const sk = (await dis(s, "sketch.create", { plane: "XY", offset: z0, component: comp, name }))[0];
  for (const c of [...cs, ...holes]) await dis(s, "sketch.addCircle", { sketch: sk, center: { x: r3(c.x), y: r3(c.y) }, radius: c.r });
  await dis(s, "feature.extrude", { sketch: sk, distance: String(h), name });
}
/** A box (plan rectangle x0..x1 × y0..y1, z0..z1) in `comp`. */
async function block(s: CadSession, comp: string, x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, name: string, radius = 0) {
  const sk = (await dis(s, "sketch.create", { plane: "XY", offset: z0, component: comp, name }))[0];
  await dis(s, "sketch.addRectangle", { sketch: sk, corner: { x: r3(x0), y: r3(y0) }, opposite: { x: r3(x1), y: r3(y1) }, ...(radius ? { cornerRadius: radius } : {}) });
  await dis(s, "feature.extrude", { sketch: sk, distance: String(r3(z1 - z0)), name });
}

export async function buildClockwork(s: CadSession): Promise<Record<string, string>> {
  await dis(s, "parameter.add", { name: "turn", expression: "0", min: -RANGE, max: RANGE, step: 1 });

  const mat = async (name: string, kind: string, color: string, finish?: string) => (await dis(s, "material.create", { name, kind, color, ...(finish ? { finish } : {}) }))[0];
  const brass = await mat("Brass", "metal", "#e3c46e", "polished");
  const bronze = await mat("Bronze", "metal", "#caa07c", "satin");
  const steel = await mat("Steel", "metal", "#c9cdd2", "brushed");
  const slate = await mat("Base, painted", "painted", "#2f343c");
  const part = async (name: string, material: string, parent?: string) => {
    const c = (await dis(s, "component.create", { name, ...(parent ? { parent } : {}) }))[0];
    await dis(s, "material.assign", { component: c, material });
    return c;
  };
  const joint = (moved: string, at: { x: number; y: number; z: number }, axis: { x: number; y: number; z: number }, value: string, name: string, kind = "revolute", base?: string) =>
    dis(s, "joint.create", { kind, moved, ...(base ? { base } : {}), baseOrigin: at, movedOrigin: at, axis, value, name });
  const up = { x: 0, y: 0, z: 1 }, alongX = { x: 1, y: 0, z: 0 };
  const at = (p: { x: number; y: number }, z = 0) => ({ x: r3(p.x), y: r3(p.y), z });
  const ids: Record<string, string> = {};
  const gear = async (key: string, comp: string, params: Record<string, unknown>) => { ids[key] = (await dis(s, "feature.gear", { component: comp, backlash: 0.1, ...params }))[0]; return ids[key]; };

  // ---- the frame: base plate, the rack's rails, the pins, the cross shaft's bearings ----
  const frame = await part("Frame", slate);
  const pins = await part("Pins", steel);
  const xs = [JC.x - 30, WORM_X0 - 12], xe = [66, S2.x + 22, STAR.x + GENEVA.star + 6];
  await block(s, frame, Math.min(...xs), SK.y - 20, Math.max(...xe), S2.y + 24, -BASE_T, 0, "Base plate", 8);
  // the rack's posts, under its ends: it slides along their tops
  const post = { y0: RACK_Y - 2.5 - RACK_RIM + 0.5, y1: RACK_Y - 2.5 - 0.5 };
  await block(s, frame, -50, post.y0, -42, post.y1, 0, L_RACK, "Rack post, left");
  await block(s, frame, 42, post.y0, 50, post.y1, 0, L_RACK, "Rack post, right");
  for (const [x, name] of [[WORM_X1 + 3, "Bearing, bevel side"], [WORM_X0 - 9, "Bearing, far"]] as const) {
    const sk = (await dis(s, "sketch.create", { plane: "YZ", offset: x, component: frame, name }))[0];
    await dis(s, "sketch.addRectangle", { sketch: sk, corner: { x: r3(S4.y - 7), y: 0 }, opposite: { x: r3(S4.y + 7), y: r3(H_APEX + 7) }, cornerRadius: 3 });
    await dis(s, "sketch.addCircle", { sketch: sk, center: { x: r3(S4.y), y: r3(H_APEX) }, radius: PIN + 0.2 });
    await dis(s, "feature.extrude", { sketch: sk, distance: "6", name });
  }
  await discs(s, pins, 0, L3 + FW, [{ ...S2, r: PIN }, { ...S3, r: PIN }], "Pins S2, S3");
  await discs(s, pins, 0, L3 + 4, [{ ...S4, r: PIN }], "Pin S4");
  await discs(s, pins, 0, J_Z0 + FW, [{ ...JC, r: PIN }], "Pin, wheel");
  await discs(s, pins, 0, G_STAR.z1, [{ ...S5, r: PIN }, { ...STAR, r: PIN }], "Pins, Geneva");
  await discs(s, pins, 0, L2 + FW, [{ ...SK, r: PIN }], "Pin, crank K");

  // ---- the planetary stage: ring fixed, sun on the knob, carrier out at 12/48 ----
  const ringC = await part("Ring", brass);
  await gear("ring", ringC, { type: "ring", module: MP, teeth: Z.ring, faceWidth: L1 + FW + 1, rim: 3.5, name: "Ring gear" });
  const carrierC = await part("Carrier", brass);
  const planets: string[] = [];
  for (let i = 0; i < 3; i++) {
    const c = await part(`Planet ${i + 1}`, bronze);
    await gear(`planet${i}`, c, { type: "spur", teeth: Z.planet, faceWidth: FW, offset: L1, bore: BORE, mesh: { gear: ids.ring, angle: 90 + 120 * i }, name: `Planet ${i + 1}` });
    planets.push(c);
  }
  const drive = await part("Drive", steel);
  await gear("sun", drive, { type: "spur", teeth: Z.sun, faceWidth: FW, mesh: { gear: ids.planet0, angle: 270 }, name: "Sun" });
  await discs(s, drive, L1 + FW, KNOB.z0 - (L1 + FW), [{ x: 0, y: 0, r: PIN }], "Drive shaft");
  await discs(s, drive, KNOB.z0, KNOB.z1 - KNOB.z0, [{ x: 0, y: 0, r: KNOB.r }], "Knob");
  await discs(s, drive, KNOB.z1, 8, [{ x: 5.5, y: 0, r: 2.2 }], "Knob handle");
  // the carrier: a plate over the planets with a pin for each, and spur A on top
  const pr = (MP * (Z.sun + Z.planet)) / 2;
  // a three-armed spider, so the planets show through spur A's spokes
  await discs(s, carrierC, CARRIER.z0, CARRIER.z1 - CARRIER.z0, [{ x: 0, y: 0, r: 8 }], "Carrier hub", [{ x: 0, y: 0, r: BORE / 2 + 0.1 }]);
  const hubId = Object.keys(s.doc.features).at(-1)!;
  for (let i = 0; i < 3; i++) {
    const a = 90 + 120 * i, c = add(S1, pr + 3, a), w = 3.5;
    const pts = [add({ x: 5 * dir(a).x, y: 5 * dir(a).y }, w, a + 90), add({ x: 5 * dir(a).x, y: 5 * dir(a).y }, w, a - 90), add(c, w, a - 90), add(c, w, a + 90)];
    const sk = (await dis(s, "sketch.create", { plane: "XY", offset: CARRIER.z0, component: carrierC, name: `Carrier arm ${i + 1}` }))[0];
    const pids: string[] = [];
    for (const q of pts) pids.push((await dis(s, "sketch.addPoint", { sketch: sk, x: r3(q.x), y: r3(q.y) }))[0]);
    for (let k = 0; k < 4; k++) await dis(s, "sketch.addLine", { sketch: sk, start: { ref: pids[k] }, end: { ref: pids[(k + 1) % 4] } });
    await dis(s, "feature.extrude", { sketch: sk, distance: String(CARRIER.z1 - CARRIER.z0), operation: "join", body: hubId, name: `Carrier arm ${i + 1}` });
  }
  await discs(s, carrierC, L1, CARRIER.z0 - L1, [0, 1, 2].map((i) => ({ ...add(S1, pr, 90 + 120 * i), r: PIN })), "Planet pins");

  // ---- spur A on the carrier: it drives the train, the Geneva crank and the rack's crank ----
  await gear("A", carrierC, { type: "spur", module: M, teeth: Z.A, faceWidth: FW, bore: BORE + 0.2, spokes: 5, hubDiameter: 12, offset: L2, rotation: -96, name: "Spur A" });

  // ---- the rack on a Scotch yoke: K's crank pin, in a slot across the plate under the rack, carries it
  // back and forth as K turns on; the rack rocks P to and fro ----
  const crankKC = await part("Crank K", bronze);
  await gear("K", crankKC, { type: "spur", teeth: Z.K, faceWidth: FW, bore: BORE, mesh: { gear: ids.A, angle: -90 }, name: "Spur K" });
  await discs(s, crankKC, L2 + FW, YOKE.z1 - 0.2 - (L2 + FW), [{ x: r3(SK.x), y: r3(SK.y + YOKE.r), r: YOKE.pin }], "Crank pin");
  const rackC = await part("Rack", brass);
  await gear("rack", rackC, { type: "rack", module: M, teeth: Z.rack, faceWidth: FW, y: r3(RACK_Y), offset: L_RACK, rim: RACK_RIM, name: "Rack" });
  {
    // the yoke: a plate under the rack's middle, slotted across (along Y) for the pin, room for its whole circle
    const sk = (await dis(s, "sketch.create", { plane: "XY", offset: YOKE.z0, component: rackC, name: "Yoke" }))[0];
    const w = YOKE.pin + YOKE.gap, half = 6;
    await dis(s, "sketch.addRectangle", { sketch: sk, corner: { x: -half, y: r3(SK.y - YOKE.r - w - 3) }, opposite: { x: half, y: r3(SK.y + YOKE.r + w + 3) }, cornerRadius: 2 });
    await dis(s, "sketch.addRectangle", { sketch: sk, corner: { x: r3(-w), y: r3(SK.y - YOKE.r - w) }, opposite: { x: r3(w), y: r3(SK.y + YOKE.r + w) }, cornerRadius: r3(w - 0.01) });
    await dis(s, "feature.extrude", { sketch: sk, distance: String(r3(YOKE.z1 - YOKE.z0)), name: "Yoke" });
  }
  const pinionC = await part("Pinion P", bronze);
  await gear("P", pinionC, { type: "spur", teeth: Z.P, faceWidth: FW, bore: BORE, mesh: { gear: ids.rack, along: P_ALONG }, name: "Pinion P" });
  const SP = { x: P_ALONG, y: RACK_Y + (M * Z.P) / 2 };
  await discs(s, pins, 0, L_RACK + FW, [{ ...SP, r: PIN }], "Pin, pinion P");
  await block(s, pinionC, SP.x - 1.5, SP.y + 2, SP.x + 1.5, SP.y + 13, L_RACK + FW, L_RACK + FW + 1.5, "Pinion hand");

  // ---- S2: spur B (meshing A), helical C above it ----
  const s2C = await part("Shaft 2", brass);
  await gear("B", s2C, { type: "spur", teeth: Z.B, faceWidth: FW, bore: BORE, hubDiameter: 11, hubLength: L3 - L2 - FW, mesh: { gear: ids.A, angle: ANG.S2 }, name: "Spur B" });
  await gear("C", s2C, { type: "helical", module: M, teeth: Z.C, faceWidth: FW, helixAngle: HELIX, bore: BORE, spokes: 5, x: r3(S2.x), y: r3(S2.y), offset: L3, name: "Helical C" });
  // ---- S3: helical D (meshing C), herringbone E below it ----
  const s3C = await part("Shaft 3", bronze);
  await gear("D", s3C, { type: "helical", teeth: Z.D, faceWidth: FW, bore: BORE, mesh: { gear: ids.C, angle: ANG.S3 }, name: "Helical D" });
  await gear("E", s3C, { type: "herringbone", module: M, teeth: Z.E, faceWidth: FW, helixAngle: CHEVRON, bore: BORE, spokes: 5, hubDiameter: 11, hubLength: L3 - L1 - FW, x: r3(S3.x), y: r3(S3.y), offset: L1, name: "Herringbone E" });
  // ---- S4: herringbone F (meshing E), bevel H above it ----
  const s4C = await part("Shaft 4", brass);
  await gear("F", s4C, { type: "herringbone", teeth: Z.F, faceWidth: FW, bore: BORE, hubDiameter: 11, hubLength: L3 - L1 - FW, mesh: { gear: ids.E, angle: ANG.S4 }, name: "Herringbone F" });
  await gear("H", s4C, { type: "bevel", module: M, teeth: Z.H, mateTeeth: Z.I, faceWidth: FW, bore: BORE, x: r3(S4.x), y: r3(S4.y), offset: L3, name: "Bevel H" });

  // ---- the cross shaft: bevel I (heel on a YZ plane, normal +X toward the apex), the worm, the shaft ----
  const crossC = await part("Cross shaft", steel);
  // H and I touch on H's 180° (−X) and I's −90° (down): phase so a tooth faces a space, s_H + s_I ≡ ½
  const sH = ((180 * Z.H) / 360) % 1;
  await gear("I", crossC, { type: "bevel", plane: "YZ", module: M, teeth: Z.I, mateTeeth: Z.H, faceWidth: FW, bore: BORE, offset: r3(I_HEEL_X), x: r3(S4.y), y: r3(H_APEX), rotation: r3(-90 - ((0.5 - sH) * 360) / Z.I), name: "Bevel I" });
  await gear("worm", crossC, { type: "worm", plane: "YZ", module: M, teeth: Z.starts, wormDiameter: WORM.d, faceWidth: WORM.L, bore: BORE, offset: r3(WORM_X0), x: r3(S4.y), y: r3(H_APEX), name: "Worm" });
  {
    const sk = (await dis(s, "sketch.create", { plane: "YZ", offset: r3(WORM_X0 - 12), component: crossC, name: "Cross shaft" }))[0];
    await dis(s, "sketch.addCircle", { sketch: sk, center: { x: r3(S4.y), y: r3(H_APEX) }, radius: PIN });
    await dis(s, "feature.extrude", { sketch: sk, distance: String(r3(I_HEEL_X + 4 - (WORM_X0 - 12))), name: "Cross shaft" });
  }

  // ---- the wheel: a helical gear at the worm's lead angle, with a hand ----
  const wheelC = await part("Wheel", brass);
  // phase (see the worm test in gearSolid.test.ts): a space under a thread where they touch, at the wheel's mid-plane
  const xt = WORM_X0 - JC.x + W.lead / 2;
  const sR = (((-xt / W.axialPitch) % 1) + 1) % 1;
  const midTwist = ((FW / 2) * Math.tan(W.leadAngle)) / ((M * Z.J) / 2) / deg;
  await gear("J", wheelC, { type: "helical", module: M, teeth: Z.J, faceWidth: FW, helixAngle: `deg(atan(${Z.starts}*${M}/${WORM.d}))`, bore: BORE, spokes: 6, x: r3(JC.x), y: r3(JC.y), offset: r3(J_Z0), rotation: r3(90 - ((0.5 - sR) * 360) / Z.J - midTwist), name: "Worm wheel" });
  await block(s, wheelC, JC.x + 2, JC.y - 1.5, JC.x + 19, JC.y + 1.5, J_Z0 + FW, J_Z0 + FW + 1.5, "Hand");

  // ---- the Geneva drive: crank and locking disc on G's shaft, the star on its own pin ----
  // Frame: the star's slots sit at 45° + 90°k, its locking arcs face the crank at 270° + 90°k; the crank pin
  // rests pointing away from the star (270°), and the cut in the locking disc turns with it.
  const g = GENEVA, bore = [{ ...S5, r: BORE / 2 }];
  const crankC = await part("Geneva crank", bronze);
  await gear("G", crankC, { type: "spur", teeth: Z.G, faceWidth: FW, bore: BORE, hubDiameter: 11, hubLength: G_CRANK.z0 - (L2 + FW), mesh: { gear: ids.A, angle: -10 }, name: "Spur G" });
  await discs(s, crankC, G_CRANK.z0, G_CRANK.z1 - G_CRANK.z0, [{ ...S5, r: g.a + 4 }], "Crank plate", bore);
  await discs(s, crankC, G_CRANK.z1, G_STAR.z1 - G_CRANK.z1, [{ ...add(S5, g.a, 270), r: g.pin }], "Crank pin");
  // the locking disc rides in the star's arcs while the pin is out; it is cut away where the star swings through
  const edge = 180 / g.n - Math.asin(g.slot / 2 / g.star) / deg;             // where a slot's side meets the rim, off the arc's centre line
  const rArc = Math.hypot(GC - g.star * Math.cos(edge * deg), g.star * Math.sin(edge * deg));
  await discs(s, crankC, G_CRANK.z1, G_STAR.z1 - G_CRANK.z1, [{ ...S5, r: r3(rArc - 0.3) }], "Locking disc", bore);
  const lockId = Object.keys(s.doc.features).at(-1)!;
  {
    const sk = (await dis(s, "sketch.create", { plane: "XY", offset: G_CRANK.z1, component: crankC, name: "Locking disc relief" }))[0];
    const c = add(S5, GC, 270);
    await dis(s, "sketch.addCircle", { sketch: sk, center: { x: r3(c.x), y: r3(c.y) }, radius: g.star + 0.8 });
    await dis(s, "feature.extrude", { sketch: sk, distance: String(G_STAR.z1 - G_CRANK.z1), operation: "cut", body: lockId, name: "Locking disc relief" });
  }
  const starC = await part("Geneva star", brass);
  await discs(s, starC, G_STAR.z0, G_STAR.z1 - G_STAR.z0, [{ ...STAR, r: g.star }], "Star", [{ ...STAR, r: BORE / 2 }]);
  const starId = Object.keys(s.doc.features).at(-1)!;
  {
    const sk = (await dis(s, "sketch.create", { plane: "XY", offset: G_STAR.z0, component: starC, name: "Star slots" }))[0];
    const r0 = GC - g.a - g.pin - 0.5, r1 = g.star + 2;               // the pin reaches GC − a from the star's centre
    for (let k = 0; k < g.n; k++) {
      const a = 45 + (360 / g.n) * k;
      const pts = [add(add(STAR, r0, a), g.slot / 2, a + 90), add(add(STAR, r1, a), g.slot / 2, a + 90), add(add(STAR, r1, a), g.slot / 2, a - 90), add(add(STAR, r0, a), g.slot / 2, a - 90)];
      const pids: string[] = [];
      for (const q of pts) pids.push((await dis(s, "sketch.addPoint", { sketch: sk, x: r3(q.x), y: r3(q.y) }))[0]);
      for (let i = 0; i < 4; i++) await dis(s, "sketch.addLine", { sketch: sk, start: { ref: pids[i] }, end: { ref: pids[(i + 1) % 4] } });
    }
    await dis(s, "feature.extrude", { sketch: sk, distance: String(G_STAR.z1 - G_STAR.z0), operation: "cut", body: starId, name: "Star slots" });
  }
  {
    const sk = (await dis(s, "sketch.create", { plane: "XY", offset: G_STAR.z0, component: starC, name: "Star locking arcs" }))[0];
    for (let k = 0; k < g.n; k++) { const c = add(STAR, GC, 270 + (360 / g.n) * k); await dis(s, "sketch.addCircle", { sketch: sk, center: { x: r3(c.x), y: r3(c.y) }, radius: r3(rArc) }); }
    await dis(s, "feature.extrude", { sketch: sk, distance: String(G_STAR.z1 - G_STAR.z0), operation: "cut", body: starId, name: "Star locking arcs" });
  }
  await block(s, starC, STAR.x + 3, STAR.y - 1.5, STAR.x + 9, STAR.y + 1.5, G_STAR.z1, G_STAR.z1 + 1.5, "Star hand");

  // ---- the joints: one drive, every ratio written out ----
  await joint(drive, at(S1), up, "turn", "Knob");
  await joint(carrierC, at(S1), up, carrier, "Carrier");
  for (let i = 0; i < 3; i++) await joint(planets[i], at(add(S1, pr, 90 + 120 * i)), up, planet, `Planet ${i + 1}`, "revolute", carrierC);
  await joint(crankKC, at(SK), up, kTurn, "Crank K");
  await joint(rackC, at(S1), alongX, rack, "Rack", "slider");
  await joint(pinionC, at(SP), up, pinion, "Pinion P");
  await joint(s2C, at(S2), up, s2, "Shaft 2");
  await joint(s3C, at(S3), up, s3, "Shaft 3");
  await joint(s4C, at(S4), up, s4, "Shaft 4");
  await joint(crossC, { x: r3(I_HEEL_X), y: r3(S4.y), z: r3(H_APEX) }, alongX, cross, "Cross shaft");
  await joint(wheelC, at(JC), up, dial, "Wheel");
  await joint(crankC, at(S5), up, crank, "Geneva crank");
  await joint(starC, at(STAR), up, star, "Geneva star");
  // the cut parts' sketches would draw as loose circles over them
  const cuts = Object.values(s.doc.sketches).filter((k) => ["Locking disc", "Locking disc relief", "Star", "Star slots", "Star locking arcs"].includes(k.name)).map((k) => k.id);
  const hid = await s.setVisibility(cuts, false);
  if (!hid.ok) throw new Error(hid.error);
  // how it reads in the customize viewer: a title, a line about it, and each control's label and unit
  await describeExample(s, {"title": "Clockwork", "description": "Every kind of gear VibeCAD makes, all turned by one knob: a planetary stage, spur, helical and herringbone pairs, a rack on a Scotch yoke that runs back and forth, bevels, a worm and a Geneva drive."}, {"turn": {"label": "Knob", "unit": "°", "description": "Turn the knob: every gear train follows"}});
  return ids;
}

/** The model with `turn` set: sketches placed for that pose, as the motion study does. */
function posed(s: CadSession, turn: number) {
  const params = s.doc.parameters.map((p) => (p.name === "turn" ? { ...p, expr: String(turn) } : p));
  const scope = resolveParameters(params).scope;
  const doc = { ...s.doc, parameters: params, sketches: Object.fromEntries(Object.entries(s.doc.sketches).map(([k, v]) => [k, { ...v }])) };
  placeComponentSketches(doc, scope);
  return { doc, scope };
}

describe("clockwork", () => {
  let s: CadSession;
  let ids: Record<string, string>;
  beforeAll(async () => {
    await initKernel({ wasmBinary: wasm });
    s = realSession();
    ids = await buildClockwork(s);
    await s.recompute();
  }, 180000);

  // Building every body clean (on both geometry paths), and clear at rest and as
  // `turn` is swept, is the example suite's (test/examples.clockwork.test.ts),
  // on the committed example this generator must reproduce.
  it("builds the committed example: every gear type, each on its planned shaft", async () => {
    if (OUT) writeFileSync(`${OUT}/clockwork.json`, serializeDocument(s.doc));
    expectCommittedExample(s, "clockwork");
    for (const sk of Object.values(s.doc.sketches)) expect(sk.status.conflicting, `sketch ${sk.name}`).toBe(false);
    const types = new Set(Object.values(s.doc.features).flatMap((f) => (f.kind === "gear" ? [f.gearType] : [])));
    expect([...types].sort()).toEqual(["bevel", "helical", "herringbone", "rack", "ring", "spur", "worm"]);
    // the meshed placements land on the planned shafts
    const scope = resolveParameters(s.doc.parameters).scope; // the placement maths, without building (gearValues is what the build reads)
    const v = (k: string) => gearValues(structuredClone(s.doc.features[ids[k]]) as GearFeature, scope);
    for (const [k, p] of [["A", S1], ["B", S2], ["D", S3], ["F", S4], ["G", S5], ["K", SK], ["P", { x: P_ALONG, y: RACK_Y + (M * Z.P) / 2 }]] as const) {
      expect(v(k).x, k).toBeCloseTo(p.x, 3);
      expect(v(k).y, k).toBeCloseTo(p.y, 3);
    }
    expect(Math.hypot(v("sun").x, v("sun").y)).toBeLessThan(1e-9);
    console.log(`shafts: S2 (${r3(S2.x)}, ${r3(S2.y)}), S3 (${r3(S3.x)}, ${r3(S3.y)}), S4 (${r3(S4.x)}, ${r3(S4.y)}); bevel apex z ${H_APEX}; wheel at (${r3(JC.x)}, ${r3(JC.y)}); ` +
      `ratios: carrier 1/${(Z.sun + Z.ring) / Z.sun}, cross shaft ×${(Z.sun / (Z.sun + Z.ring)) * (Z.A / Z.B) * (Z.C / Z.D) * (Z.E / Z.F) * (Z.H / Z.I)}, wheel 1/${1 / ((Z.sun / (Z.sun + Z.ring)) * (Z.A / Z.B) * (Z.C / Z.D) * (Z.E / Z.F) * (Z.H / Z.I) / Z.J)}`);
  });

  it("the joints turn every shaft by the ratio of its gearing", async () => {
    posed(s, 96); // placing the components evaluates every joint
    const ev = (name: string) => Object.values(s.doc.joints).find((x) => x.name === name)!.valueValue;
    const c = 96 * Z.sun / (Z.sun + Z.ring);
    expect(ev("Knob")).toBeCloseTo(96, 9);
    expect(ev("Carrier")).toBeCloseTo(c, 9);
    expect(ev("Planet 1")).toBeCloseTo(-(96 - c) * Z.sun / Z.planet, 9);
    const k = -c * Z.A / Z.K;
    expect(ev("Crank K")).toBeCloseTo(k, 9);
    expect(ev("Rack")).toBeCloseTo(-YOKE.r * Math.sin(k * deg), 9);
    expect(ev("Pinion P")).toBeCloseTo(-YOKE.r * Math.sin(k * deg) * 360 / (Math.PI * M * Z.P), 9);
    expect(ev("Shaft 2")).toBeCloseTo(-c * Z.A / Z.B, 9);
    expect(ev("Shaft 3")).toBeCloseTo(c * Z.A / Z.B * Z.C / Z.D, 9);
    expect(ev("Shaft 4")).toBeCloseTo(-c * Z.A / Z.B * Z.C / Z.D * Z.E / Z.F, 9);
    expect(ev("Cross shaft")).toBeCloseTo(c * Z.A / Z.B * Z.C / Z.D * Z.E / Z.F * Z.H / Z.I, 9);
    expect(ev("Wheel")).toBeCloseTo(c * Z.A / Z.B * Z.C / Z.D * Z.E / Z.F * Z.H / Z.I * Z.starts / Z.J, 9);
    expect(ev("Geneva crank")).toBeCloseTo(-c * Z.A / Z.G, 9);
  }, 60000);

  // the star dwells while the pin is out, and steps a quarter turn while it's in a slot, against the crank's turn
  it("the Geneva star steps a quarter turn per crank turn, and dwells between", async () => {
    const at = (crankDeg: number) => { posed(s, crankDeg / (-(Z.sun / (Z.sun + Z.ring)) * Z.A / Z.G)); return Object.values(s.doc.joints).find((x) => x.name === "Geneva star")!.valueValue; };
    for (const t of [0, 60, 130, -100, -130]) expect(at(t), `crank ${t}`).toBeCloseTo(0, 6);   // dwell
    expect(at(180)).toBeCloseTo(-45, 6);                                                        // mid-step
    for (const t of [230, 300, 490]) expect(at(t), `crank ${t}`).toBeCloseTo(-90, 6);
    expect(at(-180)).toBeCloseTo(45, 6);
    expect(at(720 + 180)).toBeCloseTo(-225, 6);
    // the slot follows the pin: through the step, the star's slot points at the crank pin
    for (const t of [140, 160, 180, 200, 220]) {
      const pin = add(S5, GENEVA.a, 270 + t);
      const slot = 315 + at(t);                                                                    // the slot that meets the pin at crank 135° rests at 315°
      expect(Math.cos((Math.atan2(pin.y - STAR.y, pin.x - STAR.x) / deg - slot) * deg), `crank ${t}`).toBeCloseTo(1, 6);
    }
  }, 60000);

  // the rack turns round by itself: K's crank carries it ±YOKE.r however far the knob is turned, out
  // to an end of its travel where the crank lies along the rack (turn = 144° + 576°k one way, −144° the
  // other) and back, so it never leaves its posts; P rocks with it
  it("the rack runs back and forth on its own as the knob turns on", async () => {
    const at = (t: number) => { posed(s, t); const j = (n: string) => Object.values(s.doc.joints).find((x) => x.name === n)!.valueValue!; return { x: j("Rack"), p: j("Pinion P") }; };
    const T = 360 / (((Z.sun / (Z.sun + Z.ring)) * Z.A) / Z.K); // a turn of K: 576° of the knob
    for (const t of [T / 4, T / 4 + T, T / 4 + 3 * T, -3 * T / 4]) expect(at(t).x, `turn ${t}`).toBeCloseTo(YOKE.r, 6);
    for (const t of [-T / 4, 3 * T / 4, 3 * T / 4 + 2 * T]) expect(at(t).x, `turn ${t}`).toBeCloseTo(-YOKE.r, 6);
    // it reverses: out to an end and back as the knob turns one way, and never past
    let last = at(0).x, dir = 1, turnarounds = 0;
    for (let t = 5; t <= 2 * T; t += 5) {
      const { x, p } = at(t);
      expect(Math.abs(x)).toBeLessThanOrEqual(YOKE.r + 1e-9);
      expect(p).toBeCloseTo((x * 360) / (Math.PI * M * Z.P), 9);
      if (Math.sign(x - last) === -dir) { dir = -dir; turnarounds++; }
      last = x;
    }
    expect(turnarounds).toBe(4);
    // the knob's slider reaches both turnarounds
    expect(RANGE).toBeGreaterThan(T / 4);
  }, 60000);

  // clear with the rack at an end of its travel (the crank pin at the end of the slot), from the slider's
  // own range and (extended run) a few turns on, the other end and back through the middle
  for (const t of [144, -144, 576 + 144, 576 + 288 + 50]) {
    (t === 144 ? it : itFull)(`the Scotch yoke and rack are clear at turn = ${t}°`, async () => {
      const { doc, scope } = posed(s, t);
      const c = collideFeatures(doc, scope);
      expect(c.buildError).toBeUndefined();
      for (const o of c.overlaps) expect(o.volume, `${o.a} × ${o.b} at turn ${t}`).toBeLessThan(0.01);
    }, 180000);
  }

  // the check can fail: knock one shaft half a tooth out of phase and its teeth hit
  // (extended run: test/gearSolid.test.ts makes the same check on a spur pair in the default run)
  itFull("collides when a shaft is half a tooth out", async () => {
    const { doc, scope } = posed(s, 0);
    const j = Object.values(doc.joints).find((x) => x.name === "Shaft 4")!;
    const slipped = { ...doc, joints: { ...doc.joints, [j.id]: { ...j, valueExpr: `${j.valueExpr} + ${180 / Z.F}` } } };
    placeComponentSketches(slipped, scope);
    const c = collideFeatures(slipped, scope);
    const hit = c.overlaps.find((o) => /Herringbone/.test(o.a) && /Herringbone/.test(o.b));
    expect(hit?.volume ?? 0).toBeGreaterThan(1);
  }, 120000);

  // through a Geneva step (the pin enters a slot at crank 135° and leaves at 225°), with the pin in the slot and the
  // star swinging past the locking disc: mid-step by default, and just in and about to leave in the extended run.
  // (The example suite's sweep of `turn` never reaches a step: the crank turns 0.625 × turn.)
  for (const crankDeg of [195, 140, 220]) {
    (crankDeg === 195 ? it : itFull)(`the Geneva drive is clear at crank = ${crankDeg}°`, async () => {
      const { doc, scope } = posed(s, crankDeg / (-(Z.sun / (Z.sun + Z.ring)) * Z.A / Z.G));
      const c = collideFeatures(doc, scope);
      expect(c.buildError).toBeUndefined();
      for (const o of c.overlaps) expect(o.volume, `${o.a} × ${o.b} at crank ${crankDeg}`).toBeLessThan(0.01);
    }, 120000);
  }

  // (Meshed and clear as `turn` is swept, from its rest and to the ends of its slider: the example suite's,
  // test/examples.clockwork.test.ts, on the committed example this builds.)
});
