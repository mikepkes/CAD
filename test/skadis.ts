// End-to-end: a gravity holder for an IKEA SKÅDIS pegboard, after
// @MatthewGhost_3DPrint's "This 3D Printed Holder Clamps Using Gravity!": stand
// a shaver or a toothbrush in it and its own weight clamps it between two side
// pads; lift it out and the pads swing open.
//
// How it works, from the front (x across the board, z up; y comes out of the
// board toward −y):
//   - a flat sandwich lies against the board: the back plate, a layer with the
//     moving parts, then the cover, held together by six shouldered printed pins;
//   - in that layer a double-sided rack slides up and down. The item stands on
//     the C-shaped foot pinned to the rack's lower end, the foot open to the
//     front for the cord or the handle;
//   - a lower arm each side turns on a pivot pin, its pinion meshing one side of
//     the rack, and an upper arm the same length pivots above it. Each side pad
//     hangs on the ends of its two arms, so arms, pad and plate make a
//     parallelogram, and the pad stays upright as it swings.
// The item's weight pushes the foot and rack down, the pinions turn (equal and
// opposite), and both pads swing in and up until they meet it. Lifting the
// pads is what the weight pays for, so empty they fall back open and push the
// rack up: nothing but the item closes it. The front stays open: the item
// stands against the cover, between the pads, on the foot.
//
// It mounts like the original: a narrow strip with the SKÅDIS hook and peg
// hooks into the board, and the holder slides down onto it. A half-dovetail
// channel in the back plate captures the strip, closed at the top so the
// holder hangs on the strip's end (`lift` slides it on).
//
// Every part prints flat without supports: the plates, rack and arms (pinions
// included) on their backs, the pads and foot standing, the strip on its side
// (its hook in the layers), the pins on a flat.
//
// The checks are in test/skadis.build.test.ts, skadis.motion.test.ts and
// skadis.physics.test.ts (each builds it in a kernel of its own: the gears and
// the slotted board run more booleans than one kernel holds).
//   BUILD_SKADIS=/abs/out npx vitest run test/skadis.build.test.ts
import { expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { collideFeatures, evaluateFeatures } from "../src/core/features";
import { placeComponentSketches, placeParametricPoints } from "../src/core/recompute";
import { resolveParameters } from "../src/core/parameters";
import type { CadSession } from "../src/core/command/session";
import type { CadDocument } from "../src/core/document";

export const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

// ---- the SKÅDIS board ----
// IKEA publishes no drawing of the board; these are the community-measured
// figures every SKÅDIS accessory generator uses (e.g. the "Skadis" pegboard
// add-in's spec on the Autodesk App Store, and the parametric SKÅDIS generators
// on MakerWorld and Printables): 5 mm hardboard (±0.2 between batches),
// 5 × 15 mm slots with round ends, 40 mm apart along a row, rows 20 mm apart and
// every other row shifted 20 mm along, so a column repeats every 40 mm up.
export const BOARD = { t: 5, slotW: 5, slotH: 15, pitch: 40, row: 20 } as const;
// The strip's hook: a 4.4 mm fin (0.3 a side in the 5 mm slot) through the board
// (5 + 0.4 for a thick board) with a 3 mm lip dropping behind it, and a peg in
// the slot `hooks` below. The fin's flat bottom sits 1.4 mm up the slot's round
// end (r 2.5), clear of it where the fin's corners meet the arc (1.31 mm up).
// Fin + lip are 10.5 mm tall, so they pass the 15 mm slot with the strip lifted
// the 3.6 mm the lip hangs below the slot; the 7.5 mm peg has 4.4 mm of play.
export const HOOK = { t: 4.4, neck: BOARD.t + 0.4, neckH: 5.5, lip: 3, drop: 5, peg: 3.5, pegH: 7.5, seat: 1.4 } as const;

// ---- fits (mm) ----
export const C = 0.3;            // sliding / turning clearance, a side
export const PRESS = 0.1;        // a pin pressed into a plate, pad or foot
// ---- depth: the layers, out from the board's face ----
export const TB = 5;             // back plate (the strip's channel is 3.2 deep in it)
export const TM = 5;             // the moving layer: rack and arms
export const D_M0 = TB + C, D_M1 = D_M0 + TM;          // 5.3 … 10.3
export const TC = 3.5;           // cover
export const D_C0 = D_M1 + C, D_C1 = D_C0 + TC;        // 10.6 … 14.1
export const D_ITEM = D_C1 + 0.5;                      // the item's back, clear of the cover's pin heads
export const ITEM_D = 45, ITEM_H = 120;                // the stand-in: a shaver handle, `item` wide
// ---- the gearing and the linkage (x, z in the board's plane; z = 0 at the pinions) ----
export const MOD = 1.5, ZP = 14, RP = (MOD * ZP) / 2; // pinions: module 1.5, 14 teeth, pitch radius 10.5
export const WR = 8.5;           // the rack's pitch lines, each side of its middle
export const XL = WR + RP;       // the pivots, each side: 19
export const ZU = 26;            // the upper arms' pivots, above the lower ones
export const LA = 30;            // arm length, pivot to pad pin (both arms: a parallelogram)
export const A0 = 30;            // the arms' angle above the horizontal, open
export const DROP = 6.4;         // the rack's travel: the arms turn DROP/RP rad (34.9°)
export const DA = DROP / RP;
export const A1 = A0 + (DA * 180) / Math.PI;           // the arms' angle, shut
export const XC = XL + LA * Math.cos((A1 * Math.PI) / 180); // the pad pins, shut (31.7)
export const RACK_TEETH = 6, RACK_MID = -DROP / 2;     // the rack's teeth, centred on the travel
export const PX = XL + 6;        // the plates' half-width: a boss round each pivot (25)
export const PZ0 = -16, PZ1 = 34; // the plates' bottom and top
export const GZ = [8, -6];       // the rack's guide pins, on its middle
export const FOOT_PINS = [-21.5, -27.5];
export const Z_FOOT = -31;       // the foot's top: where the item stands
export const PAD_ZB = -5, PAD_ZT = ZU + 5; // the pads, about the lower pad pin
// ---- the strip ----
export const TS = 3;             // its thickness
export const SX0 = -7.5, SX1 = 7.5; // its back face across; the far side is cut back 45° to TS wider at the front
export const COL = SX0 + HOOK.t / 2; // the slot column its fin hooks into: x = −5.3
export const Z_STOP = 30;        // the strip's top, and the channel's closed end
export const ZS = Z_STOP - 9;    // the hook's neck: its bottom

export const S = (deg: number) => Math.sin((deg * Math.PI) / 180), Co = (deg: number) => Math.cos((deg * Math.PI) / 180);
export const n = (v: number) => String(Number(v.toPrecision(10)));

export const SLIDERS = {
  drop: { value: 0, min: 0, max: DROP, step: 0.1 },       // the drive: how far the item has pushed the rack down
  item: { value: 30, min: 20, max: 40, step: 1 },         // the item's width: the pads shut on it at full travel
  hooks: { value: 40, min: 40, max: 80, step: 40 },       // the strip's hook to its peg: one or two slot pitches
  arm: { value: 7, min: 5, max: 8, step: 0.5 },           // the arms' width
  lift: { value: 0, min: 0, max: 60, step: 1 },           // the holder slid up off its strip
};
export const HIDDEN: [string, string][] = [
  // the pads' grip faces: from the pad pin, so that at full travel they are `item` apart
  ["xin", `${n(XL + LA * Co(A0) - XC)} + item/2`],
  // what the pads hold at `drop`: the gap between their faces
  ["held", `2*(${n(XL)} + ${n(LA)}*cos(rad(${A0}) + drop/${n(RP)}) - ${n(XL + LA * Co(A0))} + xin)`],
  ["zpeg", `${ZS} - hooks + 0.4`],                        // the strip's peg: its bottom
  ["zsb", "zpeg - 3"],                                    // the strip's bottom
];

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

type X = number | string;
type P = [X, X];
const str = (v: X) => (typeof v === "number" ? n(v) : v);
const neg = (v: X): X => (typeof v === "number" ? -v : `-(${v})`);

/** A closed outline of expression points on a sketch. */
async function outline(s: CadSession, sk: string, pts: P[]) {
  const ids: string[] = [];
  for (const [x, y] of pts) ids.push((await dis(s, "sketch.addPoint", { sketch: sk, x: str(x), y: str(y) }))[0]);
  for (let i = 0; i < ids.length; i++) await dis(s, "sketch.addLine", { sketch: sk, start: { ref: ids[i] }, end: { ref: ids[(i + 1) % ids.length] } });
}
const rect = (u0: X, v0: X, u1: X, v1: X): P[] => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
type Seg = { x: number; y: number; via?: { x: number; y: number } };

type Where = { plane?: string; datum?: string; offset?: number; component: string };
/** One sketch of outlines (expression points), circles (number centres) and arc profiles, extruded. */
async function solid(s: CadSession, at: Where, name: string, shape: { outlines?: P[][]; circles?: [number, number, number][]; profiles?: Seg[][] }, distance: X, extra: Record<string, unknown> = {}): Promise<string> {
  const sk = (await dis(s, "sketch.create", { ...(at.datum ? { datum: at.datum } : { plane: at.plane, ...(at.offset ? { offset: at.offset } : {}) }), component: at.component, name }))[0];
  for (const o of shape.outlines ?? []) await outline(s, sk, o);
  for (const [u, v, r] of shape.circles ?? []) await dis(s, "sketch.addCircle", { sketch: sk, center: { x: u, y: v }, radius: r });
  for (const p of shape.profiles ?? []) await dis(s, "sketch.addProfile", { sketch: sk, segments: p });
  return (await dis(s, "feature.extrude", { sketch: sk, distance: str(distance), name, ...extra }))[0];
}

/** A pin's section: a circle of radius r at (u, v) with a flat `f` off its centre toward −`side` (to print on). */
function dShape(u: number, v: number, r: number, f: number, side: "u" | "-u" | "v" | "-v"): Seg[] {
  const h = Math.sqrt(r * r - f * f);
  const at = (a: number, b: number) => (side === "u" ? { x: u + a, y: v + b } : side === "-u" ? { x: u - a, y: v + b } : side === "v" ? { x: u + b, y: v + a } : { x: u + b, y: v - a });
  const p0 = at(f, -h), p1 = at(f, h), far = at(-r, 0);
  return [p0, { ...p1, via: far }];
}
/** A teardrop hole of radius r at (u, v), its point at 45° toward `up` (a direction in the sketch). */
function teardrop(u: number, v: number, r: number, up: [number, number]): Seg[] {
  const [a, b] = up, k = Math.SQRT1_2;
  const side = (sx: number) => ({ x: u + r * k * a + sx * r * k * -b, y: v + r * k * b + sx * r * k * a }); // tangent points ±45° off `up`
  const tip = { x: u + r * Math.SQRT2 * a, y: v + r * Math.SQRT2 * b }, low = { x: u - r * a, y: v - r * b };
  return [side(1), { ...side(-1), via: low }, tip];
}

// The moving parts live in a frame turned 90° about y (a gear rack runs along its
// sketch's u, and this one runs down): in it, u = −z and v = x on an XZ sketch,
// and an YZ sketch's u = y, v = x with its normal pointing down.
const fr = (x: number, z: number): [number, number] => [-z, x];

export async function buildSkadis(s: CadSession): Promise<Record<string, string>> {
  for (const [name, p] of Object.entries(SLIDERS)) await dis(s, "parameter.add", { name, expression: String(p.value), min: p.min, max: p.max, step: p.step });
  await dis(s, "parameter.add", { name: "board", expression: "1", boolean: true }); // show the board and a stand-in item (not printed)
  for (const [name, e] of HIDDEN) await dis(s, "parameter.add", { name, expression: e, hidden: true });

  // ---- materials: each part's build direction is its print axis ----
  const mat = async (name: string, color: string, printAxis: string, extra: Record<string, unknown> = {}) =>
    (await dis(s, "material.create", { name, kind: "printed", color, finish: "matte", layerHeight: 0.2, printAxis, youngsModulus: 3500, allowableStrain: 0.02, layerFactor: 0.5, ...extra }))[0];
  const tanFlat = await mat("PLA tan, flat", "#d8b98a", "y");
  const brownFlat = await mat("PLA brown, flat", "#7a5a40", "y");
  const brownSide = await mat("PLA brown, on its side", "#6a4a32", "x");
  const tanStanding = await mat("PLA tan, standing", "#d8b98a", "z");
  const grip = await mat("PLA brown, standing, knurled grip", "#7a5a40", "z", { texture: "knurl", textureScale: 1.5 });
  const pinMat = await mat("PETG natural, on its flat", "#efe9dc", "z", { finish: "satin", youngsModulus: 2000, allowableStrain: 0.03, layerFactor: 0.6 });
  const boardMat = (await dis(s, "material.create", { name: "SKÅDIS hardboard, white", kind: "painted", color: "#f2f1ec", roughness: 0.7 }))[0];
  const itemMat = (await dis(s, "material.create", { name: "Stand-in shaver", kind: "plastic", color: "#c9e33a", finish: "satin" }))[0];
  const part = async (name: string, material: string, parent?: string) => {
    const c = (await dis(s, "component.create", { name, ...(parent ? { parent } : {}) }))[0];
    await dis(s, "material.assign", { component: c, material });
    return c;
  };
  const ids: Record<string, string> = {};

  // ---- the strip: hooks into the board; the holder slides onto it ----
  const strip = await part("Strip", brownSide);
  await dis(s, "joint.create", { kind: "rigid", moved: strip, baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, name: "Strip on the board" });
  {
    const bot = (await dis(s, "plane.create", { base: "XY", offset: "zsb", name: "Strip bottom" }))[0];
    // its section: the back face 15 wide, the +x side cut back at 45° so the front is TS wider (the half-dovetail)
    const body = await solid(s, { datum: bot, component: strip }, "Strip", { outlines: [[[SX0, 0], [SX1, 0], [SX1 + TS, -TS], [SX0, -TS]]] }, `${Z_STOP} - zsb`);
    // the hook's fin, flush with its −x side: neck through the board, the lip down behind it
    const top = ZS + HOOK.neckH, nk = HOOK.neck;
    await solid(s, { plane: "YZ", offset: SX0, component: strip }, "Strip hook", {
      outlines: [[[-1, ZS], [nk, ZS], [nk, ZS - HOOK.drop + 1], [nk + 1, ZS - HOOK.drop], [nk + HOOK.lip, ZS - HOOK.drop], [nk + HOOK.lip, top - 1], [nk + HOOK.lip - 1, top], [-1, top]]],
    }, HOOK.t, { operation: "join", body });
    // the peg, in the slot `hooks` below
    await solid(s, { plane: "YZ", offset: SX0, component: strip }, "Strip peg", {
      outlines: [[[-1, "zpeg"], [HOOK.peg - 0.5, "zpeg"], [HOOK.peg, "zpeg + 0.5"], [HOOK.peg, `zpeg + ${HOOK.pegH - 0.5}`], [HOOK.peg - 0.5, `zpeg + ${HOOK.pegH}`], [-1, `zpeg + ${HOOK.pegH}`]]],
    }, HOOK.t, { operation: "join", body });
    ids.strip = body;
  }

  // ---- the holder: everything that slides onto the strip ----
  const holder = (await dis(s, "component.create", { name: "Holder" }))[0];
  await dis(s, "joint.create", { kind: "slider", moved: holder, baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 }, value: "lift", name: "Slide onto the strip" });
  const plateOutline: P[] = [[-PX + 4, PZ0], [PX - 4, PZ0], [PX, PZ0 + 4], [PX, PZ1 - 4], [PX - 4, PZ1], [-PX + 4, PZ1], [-PX, PZ1 - 4], [-PX, PZ0 + 4]];
  const pivots: [number, number][] = [[-XL, 0], [XL, 0], [-XL, ZU], [XL, ZU]];
  const guides: [number, number][] = GZ.map((z) => [0, z]);
  // the back plate: printed on its front face; the strip's channel opens on its back, its undercut side at 45°
  {
    const c = await part("Back plate", tanFlat, holder);
    const body = await solid(s, { plane: "XZ", component: c }, "Back plate", { outlines: [plateOutline] }, TB);
    await solid(s, { plane: "XZ", component: c }, "Back plate holes", { circles: pivots.map(([x, z]) => [x, z, 3 + PRESS]) }, TB, { operation: "cut", body });
    const d = TS + 0.2, w = 0.2; // the channel: 0.2 clear all round
    await solid(s, { plane: "XY", offset: PZ0 - 1, component: c }, "Strip channel", {
      outlines: [[[SX0 - w, 1], [SX1 + w - 1, 1], [SX1 + w + d, -d], [SX0 - w, -d]]],
    }, Z_STOP - (PZ0 - 1), { operation: "cut", body });
    ids.backPlate = body;
  }
  // the cover: printed on its back face; counterbores for the pins' heads
  {
    const c = await part("Cover", tanFlat, holder);
    const body = await solid(s, { plane: "XZ", offset: D_C0, component: c }, "Cover", { outlines: [plateOutline] }, TC);
    await solid(s, { plane: "XZ", offset: D_C0, component: c }, "Cover holes", { circles: [...pivots, ...guides].map(([x, z]) => [x, z, 3 + PRESS]) }, TC, { operation: "cut", body });
    await solid(s, { plane: "XZ", offset: D_C1 - 1.5, component: c }, "Cover counterbores", { circles: [...pivots, ...guides].map(([x, z]) => [x, z, 5 + C]) }, 1.5, { operation: "cut", body });
    ids.cover = body;
  }
  // the shouldered pins: a 6 mm shaft pressed through each plate, an 8 mm collar
  // between them that the arm or the rack turns or slides on (and that spaces the
  // plates), a slotted head in the cover. Printed on a flat (along z).
  for (const [k, [x, z]] of [...pivots, ...guides].entries()) {
    const guide = k >= pivots.length;
    const c = await part(guide ? `Guide pin ${k - pivots.length + 1}` : `Pivot pin ${k + 1}`, pinMat, holder);
    // one flat 2.1 below the axis for every section (0.9 off the 6 mm shaft), so no round overhangs past 45°
    const shaft = (d0: number, len: number, r: number, name: string, op?: string, body?: string) =>
      solid(s, { plane: "XZ", offset: d0, component: c }, name, { profiles: [dShape(x, z, r, 2.1, "-v")] }, len, op ? { operation: op, body } : {});
    const body = await shaft(TB, D_C0 - TB, 4, `Pin ${k + 1} collar`);
    if (!guide) await shaft(0, TB + 0.5, 3, `Pin ${k + 1} back`, "join", body);
    await shaft(D_C0 - 0.5, D_C1 - 1.5 - D_C0 + 0.5, 3, `Pin ${k + 1} shaft`, "join", body);
    await shaft(D_C1 - 1.5, 1.5, 5, `Pin ${k + 1} head`, "join", body);
    await solid(s, { plane: "XZ", offset: D_C1 - 0.6, component: c }, `Pin ${k + 1} slot`, { outlines: [rect(x - 0.5, z - 6, x + 0.5, z + 6)] }, 0.6, { operation: "cut", body }); // up the layers as it prints
    ids[`pin${k + 1}`] = body;
  }

  // ---- the moving parts, in the turned frame ----
  const frame = (await dis(s, "component.create", { name: "Linkage", parent: holder }))[0];
  await dis(s, "joint.create", { kind: "revolute", base: holder, moved: frame, baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 1, z: 0 }, value: "90", name: "Linkage frame" });
  const at = (x: number, z: number) => { const [u, v] = fr(x, z); return { x: u, y: 0, z: v }; };

  // the rack: two racks back to back, a bar through them with the guide slot
  const rack = await part("Rack", tanFlat, frame);
  await dis(s, "joint.create", { kind: "slider", base: frame, moved: rack, baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 1, y: 0, z: 0 }, value: "drop", name: "Rack" });
  const rim = WR - 1.25 * MOD + 0.5; // each rack's body reaches 0.5 past the middle, so the two join
  const rackR = (await dis(s, "feature.gear", { type: "rack", plane: "XZ", component: rack, module: MOD, teeth: RACK_TEETH, faceWidth: TM, offset: D_M0, x: RACK_MID, y: WR, rim, backlash: 0.1, name: "Rack, right" }))[0];
  await dis(s, "feature.gear", { type: "rack", plane: "XZ", component: rack, module: MOD, teeth: RACK_TEETH, faceWidth: TM, offset: D_M0, x: RACK_MID, y: -WR, rim, rotation: 180, backlash: 0.1, operation: "join", body: rackR, name: "Rack, left" });
  const RB = WR - 1.25 * MOD; // the bar: as wide as the roots
  const [ut, vt] = fr(0, 22), [ub] = fr(0, FOOT_PINS[1] - 3.5);
  await solid(s, { plane: "XZ", offset: D_M0, component: rack }, "Rack bar", { outlines: [rect(ut, -RB, ub, RB)] }, TM, { operation: "join", body: rackR });
  // the guide slot: both guide pins' collars, over the travel
  const [sg0] = fr(0, GZ[1] - 4 - C), [sg1] = fr(0, GZ[0] + DROP + 4 + C);
  await solid(s, { plane: "XZ", offset: D_M0, component: rack }, "Rack guide slot", { outlines: [rect(sg1, -(4 + C), sg0, 4 + C)] }, TM, { operation: "cut", body: rackR });
  await solid(s, { plane: "XZ", offset: D_M0, component: rack }, "Rack foot holes", { circles: FOOT_PINS.map((z) => [...fr(0, z), 2.5 + C] as [number, number, number]) }, TM, { operation: "cut", body: rackR });
  ids.rack = rackR;

  // the foot: a C open to the front under the item, a tab pinned in front of the rack's lower end
  const foot = await part("Foot", tanStanding, rack);
  {
    const RO = 15, RI = 7.5, OPEN = 6, DCEN = D_ITEM + ITEM_D / 2;
    const fo = Math.sqrt(RO * RO - OPEN * OPEN), fi = Math.sqrt(RI * RI - OPEN * OPEN);
    const yz = (d: number, x: number) => ({ x: -d, y: x }); // the frame's YZ sketch: u = y = −d, v = x
    const ring: Seg[] = [yz(DCEN + fo, OPEN), { ...yz(DCEN + fo, -OPEN), via: yz(DCEN - RO, 0) }, yz(DCEN + fi, -OPEN), { ...yz(DCEN + fi, OPEN), via: yz(DCEN - RI, 0) }];
    const [ufoot] = fr(0, Z_FOOT);
    const body = await solid(s, { plane: "YZ", offset: ufoot, component: foot }, "Foot ring", { profiles: [ring] }, 3.5);
    await solid(s, { plane: "YZ", offset: ufoot, component: foot }, "Foot neck", { outlines: [rect(-D_C0, -6, -(DCEN - RO + 1), 6)] }, 3.5, { operation: "join", body });
    // the tab, up the front of the rack (below the cover), with teardrop holes for its pins
    const [utab0] = fr(0, PZ0 - 2), [ufl] = fr(0, Z_FOOT);
    const TT = D_ITEM - C - D_C0; // the tab, behind the item's back
    await solid(s, { plane: "XZ", offset: D_C0, component: foot }, "Foot tab", { outlines: [rect(utab0, -6, ufl + 1, 6)] }, TT, { operation: "join", body });
    await solid(s, { plane: "XZ", offset: D_C0, component: foot }, "Foot tab holes", { profiles: FOOT_PINS.map((z) => teardrop(...fr(0, z), 2.5 + PRESS, [-1, 0])) }, TT, { operation: "cut", body });
    ids.foot = body;
  }
  // short pins, head behind: through the rack into the foot's tab; and (below) through each arm's end into its pad
  const shortPin = async (name: string, parent: string, x: number, z: number) => {
    const c = await part(name, pinMat, parent);
    const [u, v] = fr(x, z);
    const body = await solid(s, { plane: "XZ", offset: D_M0 - 1.8, component: c }, `${name} head`, { profiles: [dShape(u, v, 4, 1.75, "u")] }, 1.5); // behind the rack or arm
    await solid(s, { plane: "XZ", offset: D_M0 - 0.3, component: c }, `${name} shaft`, { profiles: [dShape(u, v, 2.5, 1.75, "u")] }, D_C0 + 3.5 - (D_M0 - 0.3), { operation: "join", body }); // 3.5 into the tab or pad
    return body;
  };
  for (const [k, z] of FOOT_PINS.entries()) ids[`footPin${k + 1}`] = await shortPin(`Foot pin ${k + 1}`, foot, 0, z);

  // the stand-in item: a rounded bar, `item` wide and ITEM_D deep, on the foot
  const item = await part("Stand-in item (not printed)", itemMat, rack);
  {
    const hx = "(item/2 - 0.05)", k = 8, d0 = D_ITEM, d1 = D_ITEM + ITEM_D;
    const pl: P[] = [[-(d0 + k), neg(hx)], [-(d1 - k), neg(hx)], [-d1, `-${hx} + ${k}`], [-d1, `${hx} - ${k}`], [-(d1 - k), hx], [-(d0 + k), hx], [-d0, `${hx} - ${k}`], [-d0, `-${hx} + ${k}`]];
    const [ui] = fr(0, Z_FOOT);
    const f = await solid(s, { plane: "YZ", offset: ui, component: item }, "Stand-in item", { outlines: [pl] }, ITEM_H, { direction: "reverse" });
    await dis(s, "feature.setCondition", { feature: f, when: "board" });
    ids.item = f;
  }

  // the arms: the lower ones carry the pinions, the upper ones the same length above
  const rp = n(RP), turn = (sg: number) => (sg > 0 ? `deg(drop/${rp})` : `-deg(drop/${rp})`);
  for (const [side, sg] of [["right", 1], ["left", -1]] as const) { // right first: the left pinion mirrors it
    const dir = (len: number, z0: number): [number, number] => fr(sg * (XL + len * Co(A0)), z0 + len * S(A0)); // along an arm, from its pivot
    const arm = async (name: string, z0: number, lower: boolean) => {
      const c = await part(name, brownFlat, frame);
      let body: string;
      if (lower) {
        // the pinion, meshed with the rack (the left one the mirror image of the right)
        if (sg > 0) body = (await dis(s, "feature.gear", { type: "spur", plane: "XZ", component: c, teeth: ZP, faceWidth: TM, bore: 8 + 2 * C, backlash: 0.1, mesh: { gear: rackR, along: -RACK_MID }, name: `Pinion, ${side}` }))[0];
        else {
          const right = Object.values(s.doc.features).find((f) => f.kind === "gear" && f.name === "Pinion, right") as { dims: Record<string, string> };
          body = (await dis(s, "feature.gear", { type: "spur", plane: "XZ", component: c, module: MOD, teeth: ZP, faceWidth: TM, offset: D_M0, bore: 8 + 2 * C, backlash: 0.1, x: right.dims.x, y: `-(${right.dims.y})`, rotation: `-(${right.dims.rotation})`, name: `Pinion, ${side}` }))[0];
        }
      } else {
        const [hu, hv] = fr(sg * XL, z0);
        body = await solid(s, { plane: "XZ", offset: D_M0, component: c }, `${name} hub`, { circles: [[hu, hv, 6]] }, TM);
      }
      // the bar out to the pad pin, rounded at its end
      const [u0, v0] = fr(sg * XL, z0), [u1, v1] = dir(LA, z0);
      const len = Math.hypot(u1 - u0, v1 - v0), nu = -(v1 - v0) / len, nv = (u1 - u0) / len, hw = "arm/2";
      const off = (u: number, v: number, sgn: number): P => [`${n(u)} + ${sgn}*${hw}*${n(nu)}`, `${n(v)} + ${sgn}*${hw}*${n(nv)}`];
      await solid(s, { plane: "XZ", offset: D_M0, component: c }, `${name} bar`, { outlines: [[off(u0, v0, 1), off(u1, v1, 1), off(u1, v1, -1), off(u0, v0, -1)]] }, TM, { operation: "join", body });
      await solid(s, { plane: "XZ", offset: D_M0, component: c }, `${name} end`, { circles: [[u1, v1, 5]] }, TM, { operation: "join", body });
      await solid(s, { plane: "XZ", offset: D_M0, component: c }, `${name} holes`, { circles: [[u0, v0, 4 + C], [u1, v1, 2.5 + C]] }, TM, { operation: "cut", body });
      // turns about its pivot pin with the pinion: drop/RP rad, the outer end up and in
      const [pu, pv] = fr(sg * XL, z0);
      await dis(s, "joint.create", { kind: "revolute", base: frame, moved: c, baseOrigin: { x: pu, y: 0, z: pv }, movedOrigin: { x: pu, y: 0, z: pv }, axis: { x: 0, y: -1, z: 0 }, value: turn(sg), name });
      ids[`${name}`] = body;
      return c;
    };
    const lowerArm = await arm(`Lower arm, ${side}`, 0, true);
    await arm(`Upper arm, ${side}`, ZU, false);

    // the pad: hangs on both arms' ends (a parallelogram, so it stays upright), turning back on the lower one
    const pad = await part(`Pad, ${side}`, grip, lowerArm);
    const [pl, plz] = [sg * (XL + LA * Co(A0)), LA * S(A0)]; // the lower pad pin, open
    const pinZ = [plz, plz + ZU];
    {
      const P0 = Math.abs(pl), D1 = D_ITEM + 28;
      // plan (d, |x|): a block round the pins beside the plates, a grip slab in front of the cover reaching in to `xin`
      const ribs: P[] = [];
      for (let d = D1 - 3, k = 0; d > D_C0 + 2; d -= 3, k++) ribs.push([d, P0 + (k % 2 ? 6 : 4.8)]);
      const plan: P[] = [[D_C1 + C, "xin"], [D_C1 + C, P0 - 6], [D_C0, P0 - 6], [D_C0, P0 + 6], ...ribs.reverse().map(([d, x]) => [d, x] as P), [D1, P0 + 6], [D1, "xin"]];
      const yz = ([d, x]: P): P => [neg(d), sg > 0 ? x : neg(x)];
      const top = plz + PAD_ZT, [utop] = fr(0, top);
      const body = await solid(s, { plane: "YZ", offset: utop, component: pad }, `Pad ${side}`, { outlines: [plan.map(yz)] }, PAD_ZT - PAD_ZB);
      // the pins' holes, from its back: teardrops, pointing up as it prints
      await solid(s, { plane: "XZ", offset: D_C0, component: pad }, `Pad ${side} holes`, { profiles: pinZ.map((z) => teardrop(...fr(pl, z), 2.5 + PRESS, [-1, 0])) }, 4, { operation: "cut", body });
      // hollow: a 3 mm grip wall, the ribbed outer wall, front and back walls round a pocket open top and bottom
      const pocket: P[] = [[D_C1 + C + 3.5, "xin + 3"], [D_C1 + C + 3.5, P0 + 3.2], [D1 - 2.5, P0 + 3.2], [D1 - 2.5, "xin + 3"]];
      await solid(s, { plane: "YZ", offset: utop, component: pad }, `Pad ${side} pocket`, { outlines: [pocket.map(yz)] }, PAD_ZT - PAD_ZB, { operation: "cut", body });
      ids[`pad${side}`] = body;
      const [u, v] = fr(pl, plz);
      await dis(s, "joint.create", { kind: "revolute", base: lowerArm, moved: pad, baseOrigin: { x: u, y: 0, z: v }, movedOrigin: { x: u, y: 0, z: v }, axis: { x: 0, y: -1, z: 0 }, value: turn(-sg), name: `Pad, ${side}` });
    }
    for (const [k, z] of pinZ.entries()) ids[`padPin${side}${k}`] = await shortPin(`Pad pin, ${side} ${k ? "upper" : "lower"}`, pad, pl, z);
  }

  // ---- context (not printed): a piece of board ----
  const board = await part("SKÅDIS board (not printed)", boardMat);
  await dis(s, "joint.create", { kind: "rigid", moved: board, baseOrigin: { x: COL, y: 0, z: ZS - HOOK.seat }, movedOrigin: { x: 0, y: 0, z: 0 }, name: "On the board" });
  {
    const sk = (await dis(s, "sketch.create", { plane: "XZ", component: board, name: "SKÅDIS board" }))[0];
    await dis(s, "sketch.addRectangle", { sketch: sk, corner: { x: -62, y: -138 }, opposite: { x: 72, y: 82 } });
    const b = (await dis(s, "feature.extrude", { sketch: sk, distance: String(BOARD.t), direction: "reverse", name: "SKÅDIS board" }))[0];
    const sl = (await dis(s, "sketch.create", { plane: "XZ", component: board, name: "SKÅDIS slots" }))[0];
    for (let j = -6; j <= 3; j++) {
      const z0 = BOARD.row * j, off = ((j % 2) + 2) % 2 ? BOARD.row : 0;
      for (let x = off - 2 * BOARD.pitch; x <= 50; x += BOARD.pitch) {
        if (x < -50) continue;
        await dis(s, "sketch.addSlot", { sketch: sl, p1: { x, y: z0 + BOARD.slotW / 2 }, p2: { x, y: z0 + BOARD.slotH - BOARD.slotW / 2 }, width: BOARD.slotW });
      }
    }
    const cut = (await dis(s, "feature.extrude", { sketch: sl, distance: String(BOARD.t), direction: "reverse", operation: "cut", body: b, name: "SKÅDIS slots" }))[0];
    for (const f of [b, cut]) await dis(s, "feature.setCondition", { feature: f, when: "board" });
    ids.board = b;
  }
  // every sketch a feature has built from is hidden: drawn, they'd show as loose outlines over the parts
  // (the pads' and arms' cuts) and, with `board` unticked, where the stand-ins were
  const used = new Set(Object.values(s.doc.features).flatMap((f) => { const k = (f as { sketchId?: string; sketch?: string }).sketchId ?? (f as { sketch?: string }).sketch; return k ? [k] : []; }));
  const loose = Object.values(s.doc.sketches).filter((k) => used.has(k.id) || ["SKÅDIS board", "SKÅDIS slots", "Stand-in item"].includes(k.name)).map((k) => k.id);
  const hid = await s.setVisibility(loose, false);
  if (!hid.ok) throw new Error(hid.error);

  await dis(s, "drawing.publish", { title: "SKÅDIS gravity holder" });
  return ids;
}

// ---------------------------------------------------------------------------

export const scopeOf = (doc: CadDocument, over: Record<string, number> = {}) => {
  const params = doc.parameters.map((p) => (p.name in over ? { ...p, expr: String(over[p.name]) } : p));
  return { params, scope: resolveParameters(params).scope };
};
/** The model posed with parameters overridden, its sketches placed for that pose (as the motion study does). */
export function posed(s: CadSession, over: Record<string, number> = {}, joints: (d: CadDocument) => CadDocument["joints"] = (d) => d.joints) {
  const { params, scope } = scopeOf(s.doc, over);
  // sketch points written as expressions move with the parameters (as the motion study re-places them)
  const sketches = Object.fromEntries(Object.entries(s.doc.sketches).map(([k, v]) => {
    const sk = { ...v, entities: Object.fromEntries(Object.entries(v.entities).map(([i, e]) => [i, { ...e }])) };
    placeParametricPoints(sk, scope);
    return [k, sk];
  }));
  const base: CadDocument = { ...s.doc, parameters: params, sketches, joints: Object.fromEntries(Object.entries(s.doc.joints).map(([k, v]) => [k, { ...v }])) };
  const doc: CadDocument = { ...base, joints: joints(base) };
  placeComponentSketches(doc, scope);
  return { doc, scope };
}
export const componentOf = (doc: CadDocument, sketchId: string) => doc.components[doc.sketches[sketchId]?.componentId ?? ""]?.name ?? "?";
/** Each part's bodies (volume, centroid, mesh) at a pose. */
export function parts(s: CadSession, over: Record<string, number> = {}) {
  const { doc, scope } = posed(s, over);
  const out = evaluateFeatures(doc, scope);
  const by: Record<string, { volume: number; centroid: { x: number; y: number; z: number }; meshes: { positions: ArrayLike<number>; indices: ArrayLike<number> }[] }> = {};
  for (const b of Object.values(out)) {
    if (!b.mesh || !b.volume) continue;
    const name = componentOf(doc, b.sketchId), c = b.centroid!;
    const was = by[name] ?? { volume: 0, centroid: { x: 0, y: 0, z: 0 }, meshes: [] };
    const v = was.volume + b.volume;
    by[name] = {
      volume: v,
      centroid: { x: (was.centroid.x * was.volume + c.x * b.volume) / v, y: (was.centroid.y * was.volume + c.y * b.volume) / v, z: (was.centroid.z * was.volume + c.z * b.volume) / v },
      meshes: [...was.meshes, b.mesh],
    };
  }
  return { doc, scope, by, out };
}
export const clear = (doc: CadDocument, scope: Record<string, number>, label: string) => {
  const c = collideFeatures(doc, scope);
  expect(c.buildError, label).toBeUndefined();
  for (const o of c.overlaps) expect(o.volume, `${o.a} × ${o.b} at ${label}`).toBeLessThan(0.01);
  return c;
};
/** The document with only these parts' features (a cheaper collision check between them). */
export const only = (doc: CadDocument, names: string[]): CadDocument => ({
  ...doc, features: Object.fromEntries(Object.entries(doc.features).filter(([, f]) => names.includes(componentOf(doc, (f as { sketchId?: string }).sketchId ?? "")))),
});
/** The joints with one rigid joint's base origin moved (a part nudged off its seat). */
export const nudge = (name: string, by: { x?: number; y?: number; z?: number }) => (d: CadDocument) =>
  Object.fromEntries(Object.entries(d.joints).map(([k, j]) => [k, j.name === name ? { ...j, originExprs: undefined, baseOrigin: { x: j.baseOrigin.x + (by.x ?? 0), y: j.baseOrigin.y + (by.y ?? 0), z: j.baseOrigin.z + (by.z ?? 0) } } : j]));

export const RHO = 1.24e-3;   // PLA, g/mm³ (solid; infill only makes the parts lighter, all alike)
export const G = 9.81e-3;     // N per g
export const PRINTED = ["Strip", "Back plate", "Cover", "Rack", "Foot", "Lower arm, left", "Lower arm, right", "Upper arm, left", "Upper arm, right", "Pad, left", "Pad, right",
  "Pivot pin 1", "Pivot pin 2", "Pivot pin 3", "Pivot pin 4", "Guide pin 1", "Guide pin 2", "Foot pin 1", "Foot pin 2",
  "Pad pin, left lower", "Pad pin, left upper", "Pad pin, right lower", "Pad pin, right upper"];
export const MOVING = PRINTED.filter((k) => /Rack|Foot|arm|Pad/.test(k));

/** A fresh kernel and the model, built. */
export async function built(): Promise<CadSession> {
  await initKernel({ wasmBinary: wasm });
  const s = realSession();
  await buildSkadis(s);
  await s.recompute();
  return s;
}
