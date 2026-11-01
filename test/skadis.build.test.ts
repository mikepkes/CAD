// End-to-end: a gravity holder for an IKEA SKÅDIS pegboard. Drop something in
// and its weight shuts the jaws on it; lift it out and they swing open.
//
// The mechanism, seen from the side (y out from the board, z up). Two cheeks
// hang on the board, one on each column of slots, and carry everything between
// them on four pins:
//   - two jaws, one near the board and one in front, each hanging from a pivot
//     pin at the top like a pendulum: a pad on its lower end faces the object,
//     and a short lever reaches out the other way from the pivot to a stub pin;
//   - the cradle, a U that slides up and down between them on two guide pins:
//     the object stands on the tray at its bottom, and its arms reach up to the
//     jaws' stub pins, which ride in slots in them.
// Weight on the tray pulls the cradle down, the stubs go down with it, and each
// jaw swings its pad in until both meet the object: the grip is the weight
// (less what it takes to swing the jaws), in proportion to it. Lift the object
// and the jaws, which hang with their centre of mass inboard of the pivot, swing
// back out, lifting the cradle with them: they are pendulums pushed off their
// rest, so the further they close the harder they pull back open. A 45° lead-in
// on each pad lets an object pry closed jaws apart on the way in, and pushing it
// down drags them open; the cheeks and the pivot pins above the pads keep a tall
// object from toppling.
//
// Every part prints without supports: the cheeks and jaws on their sides (every
// outline in the layers, the hooks too), the cradle standing up, the pins on a
// flat, the tie bars on their backs. The pins and tie bars are trapped in blind
// pockets when the second cheek is pressed on.
//
//   BUILD_SKADIS=/abs/out npx vitest run test/skadis.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { serializeDocument } from "../src/core/persistence";
import { collideFeatures, evaluateFeatures, exportFeatureBytes } from "../src/core/features";
import { placeComponentSketches, placeParametricPoints, resolveComponentWorld } from "../src/core/recompute";
import { resolveParameters } from "../src/core/parameters";
import { applyPoint } from "../src/math/transform";
import type { CadSession } from "../src/core/command/session";
import type { CadDocument } from "../src/core/document";

const OUT = process.env.BUILD_SKADIS || "";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

// ---- the SKÅDIS board ----
// IKEA publishes no drawing of the board; these are the community-measured
// figures every SKÅDIS accessory generator uses (e.g. the "Skadis" pegboard
// add-in's spec on the Autodesk App Store, and the parametric SKÅDIS generators
// on MakerWorld and Printables): 5 mm hardboard (±0.2 between batches),
// 5 × 15 mm slots with round ends, 40 mm apart along a row, rows 20 mm apart and
// every other row shifted 20 mm along, so a column repeats every 40 mm up.
const BOARD = { t: 5, slotW: 5, slotH: 15, pitch: 40, row: 20 } as const;
// The hooks: a 4.4 mm fin (0.3 a side in the 5 mm slot) that reaches through the
// board (5 + 0.4 for a thick board) and drops a 5 mm lip behind it, and a peg in
// the slot 40 mm below that stops the holder swinging out. The fin's flat bottom
// sits 1.4 mm up the slot's round end (r 2.5), clear of it where the fin's corners
// meet the arc (1.31 mm up). Fin + lip are 10.5 mm tall, so they pass the 15 mm
// slot with the holder lifted the 3.6 mm the lip hangs below the slot; the 7.5 mm
// peg has 4.4 mm of play above it in its slot for that.
const HOOK = { t: 4.4, neck: BOARD.t + 0.4, neckH: 5.5, lip: 3, drop: 5, peg: 3.5, pegH: 7.5, seat: 1.4 } as const;

// ---- fits (mm) ----
const C = 0.3;          // sliding / turning clearance, a side
const RP = 3;           // the pins (Ø6, a 0.9 mm flat to print on)
const FLAT = 0.9;       // flat depth: the round left above it overhangs ≤ 45°
const HOLE = RP + C;    // the jaws turn on the pins; the cradle slides on two
const POCKET = RP + 0.1; // the pins sit snug in the cheeks' blind pockets
const STUB = 2.5;       // the jaws' stub pins (Ø5) into the cradle
const SC = STUB + C;    // the stub slots' clearance radius
const LEVER = 4.5;      // the lever's rounded tip (its straight edges 4 each side)
const BOSS = 6.5;       // the jaw's boss round its pivot
const TP = 5;           // the cradle's arms (x)
const TRAY = 3.5;       // the tray and the cradle's bottom bar (z)
const CH = 3;           // the pads' 45° lead-in
const PAD_TOP = -9;     // the pads' top, under the pivot pins
const TIE = 8;          // tie bars: 8 × 8 with a 5 mm tenon each end
const JAW_MAX = 20;     // the jaws turn 0…20° from open to shut on the smallest object
const S = Math.sin((JAW_MAX * Math.PI) / 180), Co = Math.cos((JAW_MAX * Math.PI) / 180);
const n = (v: number) => String(Number(v.toPrecision(10)));
const R2 = Math.SQRT2;
const W = SC * R2;      // a stub slot's half-width, so its 45° roof clears the stub

// The layers across the board (x): cheek | rear jaw | cradle | front jaw | cheek,
// 0.3 apart. The pads and the tray span the gap between the cheeks.
// In y (out from the board) the object's axis is at `yc`, the pivots `px` each
// side of it and the stubs `la` further out. z = 0 is the pivots' height.
const SLIDERS = {
  jaw: { value: 0, min: 0, max: JAW_MAX, step: 0.5 },     // the drive: jaw angle, 0 = open (empty)
  size: { value: 30, min: 20, max: 48, step: 1 },         // the largest object: the jaws' opening
  hooks: { value: 40, min: 40, max: 80, step: 40 },       // hook spacing: one or two slot pitches
  wall: { value: 4, min: 3, max: 6, step: 0.5 },          // cheek thickness
  arm: { value: 7, min: 5, max: 10, step: 0.5 },          // jaw arm width
};
// Derived values, as hidden parameters (each in the ones above it).
const HIDDEN: [string, string][] = [
  ["gx", "hooks + 4.4 - 2*wall"],                         // between the cheeks (the fins are flush with their outer faces)
  ["tj", `(gx - ${TP})/2 - ${2 * C}`],                    // a jaw's layer
  ["dy", "13"],                                           // each pivot this far outboard of its pad's face: the pad hangs inboard
  ["px", "size/2 + dy"],                                  // the pivots, each side of the axis
  // the pads' contact corner (the foot of each pad's face) hc under the pivot, so
  // that at JAW_MAX the gap is a third of the opening
  ["hc", `(px - dy*${n(Co)} - size/6)/${n(S)}`],
  ["la", "max(10, hc/4)"],                                // lever: pivot to stub (≥ 10 clears the pivot pin by the cradle's arm)
  ["pdp", `arm + ${CH + 2}`],                             // pad depth: the arm comes down behind the lead-in
  ["tv", `la*${n(S)}`],                                   // the cradle's travel
  ["yc", `px + la + ${n(W + 1.8)} + 1.6`],                // the axis: the cradle's rear arm 1.6 off the board
  ["zt", "-hc - 1.5"],                                    // the tray's top: the object stands just under the pads
  ["tw", "size/4"],                                       // the tray's half-depth
  ["zg", `${-(LEVER + 5)} - tv`],                         // the guide pins: under the levers' tips at full travel, 2 mm of arm between the slots
  ["zb", `zt - ${TRAY + 2 + TIE + 2} - tv`],              // the cheeks' bottom: tie bars under the cradle at full travel
  ["ztop", "max(11.5, zb + 54)"],                         // the cheeks' top
  ["zs", `ztop - ${HOOK.neckH + 6}`],                     // the hook's neck: its bottom
  ["yf", "2*yc"],                                         // the cheeks' front
  ["pd", "wall - 1.2"],                                   // blind pocket depth (1.2 mm skin outside)
  // the board's registration: the hook row has a slot at ±hooks/2
  ["zbd", `zs - ${HOOK.seat} - 20*(hooks/40 - 2*floor(hooks/80))`],
  // what the jaws hold at `jaw`: the gap at the contact corners
  ["held", "2*(px - dy*cos(rad(jaw)) - hc*sin(rad(jaw)))"],
];

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

type X = number | string;
type P = [X, X];
const str = (v: X) => (typeof v === "number" ? n(v) : v);

/** A closed outline of expression points on a sketch. */
async function outline(s: CadSession, sk: string, pts: P[]) {
  const ids: string[] = [];
  for (const [x, y] of pts) ids.push((await dis(s, "sketch.addPoint", { sketch: sk, x: str(x), y: str(y) }))[0]);
  for (let i = 0; i < ids.length; i++) await dis(s, "sketch.addLine", { sketch: sk, start: { ref: ids[i] }, end: { ref: ids[(i + 1) % ids.length] } });
}
/** Circles of fixed radius at expression centres. */
async function circles(s: CadSession, sk: string, cs: [X, X, number][]) {
  for (const [x, y, r] of cs) {
    const c = (await dis(s, "sketch.addPoint", { sketch: sk, x: str(x), y: str(y) }))[0];
    await dis(s, "sketch.addCircle", { sketch: sk, center: { ref: c }, radius: r });
  }
}
const rect = (y0: X, z0: X, y1: X, z1: X): P[] => [[y0, z0], [y1, z0], [y1, z1], [y0, z1]];

/** World y of a distance out from the board: the board is behind (+y), and the
 *  holder comes out toward −y, the app's front. */
const out = (v: X): X => (typeof v === "number" ? -v : `-(${v})`);

type Where = { datum?: string; plane?: string; component: string; fromBoard?: boolean };
/** One sketch (outlines and/or circles) extruded. With `fromBoard`, the sketch's
 *  y values are distances out from the board. */
async function solid(s: CadSession, at: Where, name: string, shape: { outlines?: P[][]; circles?: [X, X, number][] }, distance: X, extra: Record<string, unknown> = {}): Promise<string> {
  const sk = (await dis(s, "sketch.create", { ...(at.datum ? { datum: at.datum } : { plane: at.plane }), component: at.component, name }))[0];
  const f = at.fromBoard ? out : (v: X) => v;
  for (const o of shape.outlines ?? []) await outline(s, sk, o.map(([y, z]) => [f(y), z] as P));
  if (shape.circles?.length) await circles(s, sk, shape.circles.map(([y, z, r]) => [f(y), z, r] as [X, X, number]));
  return (await dis(s, "feature.extrude", { sketch: sk, distance: str(distance), name, ...extra }))[0];
}

export async function buildSkadis(s: CadSession): Promise<Record<string, string>> {
  for (const [name, p] of Object.entries(SLIDERS)) await dis(s, "parameter.add", { name, expression: String(p.value), min: p.min, max: p.max, step: p.step });
  await dis(s, "parameter.add", { name: "board", expression: "1", boolean: true }); // show the board and an object (not printed)
  for (const [name, e] of HIDDEN) await dis(s, "parameter.add", { name, expression: e, hidden: true });

  // ---- materials: each part's build direction is its print axis ----
  const pla = (name: string, color: string, printAxis: string) =>
    dis(s, "material.create", { name, kind: "printed", color, finish: "matte", layerHeight: 0.2, printAxis, youngsModulus: 3500, allowableStrain: 0.02, layerFactor: 0.5 }).then((r) => r[0]);
  const frameSide = await pla("PLA graphite, on its side", "#3b4048", "x");
  const frameFlat = await pla("PLA graphite, flat", "#3b4048", "z");
  const jawSide = await pla("PLA orange, on its side", "#f08a24", "x");
  const cradleUp = await pla("PLA orange, standing", "#f08a24", "z");
  const petg = (await dis(s, "material.create", { name: "PETG natural, on its flat", kind: "printed", color: "#e9e4d8", finish: "satin", layerHeight: 0.2, printAxis: "y", youngsModulus: 2000, allowableStrain: 0.03, layerFactor: 0.6 }))[0];
  const boardMat = (await dis(s, "material.create", { name: "SKÅDIS hardboard, white", kind: "painted", color: "#f2f1ec", roughness: 0.7 }))[0];
  const objMat = (await dis(s, "material.create", { name: "Held object", kind: "plastic", color: "#5aa9e6", finish: "gloss" }))[0];
  const part = async (name: string, material: string) => {
    const c = (await dis(s, "component.create", { name }))[0];
    await dis(s, "material.assign", { component: c, material });
    return c;
  };
  const datum = async (offset: string, name: string) => (await dis(s, "plane.create", { base: "YZ", offset, name }))[0];
  const ids: Record<string, string> = {};

  // datum planes across x: the cheeks' faces and the layers
  const X = {
    cheekLout: await datum("-gx/2 - wall", "Cheek L, outer face"),
    cheekLin: await datum("-gx/2", "Cheek L, inner face"),
    cheekRin: await datum("gx/2", "Cheek R, inner face"),
    cheekRout: await datum("gx/2 + wall", "Cheek R, outer face"),
    gapL: await datum(`-gx/2 + ${C}`, "Rear jaw layer"),             // the rear jaw's outer face; the pads and tray start here
    rearIn: await datum(`${-(TP / 2 + C)}`, "Rear jaw, inner face"),
    cradle: await datum(`${-TP / 2}`, "Cradle"),
    frontIn: await datum(`${TP / 2 + C}`, "Front jaw, inner face"),
  };

  // ---- the cheeks: a side plate each, with its hook and peg; blind pockets for the pins and tie bars ----
  const pins: [X, X][] = [["yc - px", 0], ["yc + px", 0], ["yc - px - la", "zg"], ["yc + px + la", "zg"]];
  const tieY: X[] = ["10", "yf - 14"], tieZ = `zb + ${TIE / 2 + 2}`;
  for (const side of ["L", "R"] as const) {
    const c = await part(`Cheek ${side}`, frameSide);
    const face = side === "L" ? X.cheekLout : X.cheekRout, inn = side === "L" ? X.cheekLin : X.cheekRin;
    const into = side === "L" ? {} : { direction: "reverse" }; // from the outer face inward
    // a plate, its lower front corner cut back at 45°
    const body = await solid(s, { datum: face, component: c, fromBoard: true }, `Cheek ${side}`, {
      outlines: [[[0, "zb"], ["yf - 9", "zb"], ["yf", "zb + 9"], ["yf", "ztop"], [0, "ztop"]]],
    }, "wall", into);
    ids[`cheek${side}`] = body;
    // the hook: neck through the board, lip down behind it (small lead-ins on the lip)
    const zs = "zs", nk = HOOK.neck, top = `zs + ${HOOK.neckH}`;
    await solid(s, { datum: face, component: c, fromBoard: true }, `Hook ${side}`, {
      outlines: [[[1, zs], [-nk, zs], [-nk, `zs - ${HOOK.drop - 1}`], [-(nk + 1), `zs - ${HOOK.drop}`], [-(nk + HOOK.lip), `zs - ${HOOK.drop}`],
        [-(nk + HOOK.lip), `${top} - 1`], [-(nk + HOOK.lip - 1), top], [1, top]]],
    }, HOOK.t, { ...into, operation: "join", body });
    // the peg, in the slot 40 below
    const zp = `zs - ${BOARD.pitch} + 0.4`;
    await solid(s, { datum: face, component: c, fromBoard: true }, `Peg ${side}`, {
      outlines: [[[1, zp], [-(HOOK.peg - 0.5), zp], [-HOOK.peg, `${zp} + 0.5`], [-HOOK.peg, `${zp} + ${HOOK.pegH - 0.5}`], [-(HOOK.peg - 0.5), `${zp} + ${HOOK.pegH}`], [1, `${zp} + ${HOOK.pegH}`]]],
    }, HOOK.t, { ...into, operation: "join", body });
    // a window between the pivots, over the tray: the mechanism shows, and it's lighter
    const wy0 = "yc - px + 8", wy1 = "yc + px - 8", wz0 = "zt + 3", wz1 = 4, k = 4;
    await solid(s, { datum: face, component: c, fromBoard: true }, `Window ${side}`, {
      outlines: [[[`${wy0} + ${k}`, wz0], [`${wy1} - ${k}`, wz0], [wy1, `${wz0} + ${k}`], [wy1, wz1 - k], [`${wy1} - ${k}`, wz1], [`${wy0} + ${k}`, wz1], [wy0, wz1 - k], [wy0, `${wz0} + ${k}`]]],
    }, "wall", { ...into, operation: "cut", body });
    // pockets from the inner face
    await solid(s, { datum: inn, component: c, fromBoard: true }, `Pockets ${side}`, {
      circles: pins.map(([y, z]) => [y, z, POCKET] as [X, X, number]),
      outlines: tieY.map((y) => rect(`${y} - ${TIE / 2 + 0.1}`, `${tieZ} - ${TIE / 2 + 0.1}`, `${y} + ${TIE / 2 + 0.1}`, `${tieZ} + 1.1`)),
    }, "pd", { ...(side === "L" ? { direction: "reverse" } : {}), operation: "cut", body });
  }

  // ---- pins: four alike, on a flat; each in its own frame at its centre ----
  for (const [k, [y, z]] of pins.entries()) {
    const c = await part(`Pin ${k + 1}`, petg);
    await dis(s, "joint.create", { kind: "rigid", moved: c, baseOrigin: { x: 0, y: out(y), z }, movedOrigin: { x: 0, y: 0, z: 0 }, name: `Pin ${k + 1} seat` });
    const sk = (await dis(s, "sketch.create", { plane: "YZ", component: c, name: `Pin ${k + 1}` }))[0];
    const zf = Math.sqrt(RP * RP - (RP - FLAT) ** 2);
    await dis(s, "sketch.addProfile", { sketch: sk, segments: [{ x: -(RP - FLAT), y: -zf }, { x: -(RP - FLAT), y: zf, via: { x: RP, y: 0 } }] });
    ids[`pin${k + 1}`] = (await dis(s, "feature.extrude", { sketch: sk, distance: "gx + 2*pd - 0.4", symmetric: true, name: `Pin ${k + 1}` }))[0];
  }

  // ---- tie bars: hold the cheeks apart and square; tenons flush with the bottom ----
  for (const [k, y] of tieY.entries()) {
    const c = await part(`Tie bar ${k + 1}`, frameFlat);
    await dis(s, "joint.create", { kind: "rigid", moved: c, baseOrigin: { x: 0, y: out(y), z: tieZ }, movedOrigin: { x: 0, y: 0, z: 0 }, name: `Tie bar ${k + 1} seat` });
    const b = await solid(s, { plane: "YZ", component: c }, `Tie bar ${k + 1}`, { outlines: [rect(-TIE / 2, -TIE / 2, TIE / 2, TIE / 2)] }, "gx", { symmetric: true });
    await solid(s, { plane: "YZ", component: c }, `Tenons ${k + 1}`, { outlines: [rect(-TIE / 2, -TIE / 2, TIE / 2, 1)] }, "gx + 2*pd - 0.4", { symmetric: true, operation: "join", body: b });
    ids[`tie${k + 1}`] = b;
  }

  // ---- the cradle: a U in the middle layer (world frame at rest), the tray across its bottom ----
  const cradle = await part("Cradle", cradleUp);
  // each arm: a leg up from the bottom bar, widening at 45° to carry the guide slot and the stub slot
  const arm = (sg: 1 | -1): P[] => {
    const o = (v: string) => (sg < 0 ? `yc - (${v})` : `yc + (${v})`);
    const yo = `px + la + ${n(W + 1.8)}`, yi = `px + la*${n(Co)} - ${n(W + 1.8)}`, lo = `px + la + 3`, li = `px + la - 3`;
    const zw = `zg - ${HOLE + 2}`, top = `${n(W + 2)} + la*${n((1 - Co) / 2)}`;
    return [[o(lo), "zt - 1"], [o(li), "zt - 1"], [o(li), `${zw} - (${li} - (${yi}))`], [o(yi), zw], [o(yi), top], [o(yo), top], [o(yo), zw], [o(lo), `${zw} - (${yo} - (${lo}))`]];
  };
  const body = await solid(s, { datum: X.cradle, component: cradle, fromBoard: true }, "Cradle", {
    outlines: [rect(`yc - px - la - 3`, `zt - ${TRAY}`, `yc + px + la + 3`, "zt")],
  }, TP);
  for (const sg of [-1, 1] as const) await solid(s, { datum: X.cradle, component: cradle, fromBoard: true }, `Cradle arm ${sg < 0 ? "rear" : "front"}`, { outlines: [arm(sg)] }, TP, { operation: "join", body });
  await solid(s, { datum: X.gapL, component: cradle, fromBoard: true }, "Tray", { outlines: [rect("yc - tw", `zt - ${TRAY}`, "yc + tw", "zt")] }, `gx - ${2 * C}`, { operation: "join", body });
  // the slots: each stub swings in la(1 − cos θ) as it drops, under a 45° roof; each
  // guide pin runs the travel, under a 45° roof (the roofs print without support)
  const slots = (sg: 1 | -1): P[][] => {
    const o = (v: string) => (sg < 0 ? `yc - (${v})` : `yc + (${v})`);
    const a = "px + la", b = `px + la*${n(Co)}`, w = n(W);
    const stub: P[] = [[o(`${a} + ${w}`), -SC], [o(`${b} - ${w}`), -SC], [o(`${b} - ${w}`), 0], [o(`(${a} + ${b})/2`), `${w} + la*${n((1 - Co) / 2)}`], [o(`${a} + ${w}`), 0]];
    const eave = `zg + tv + ${n(HOLE * (R2 - 1))}`; // where the 45° roof meets the slot's sides, tangent to its round
    const guide: P[] = [[o(`${a} - ${HOLE}`), `zg - ${HOLE}`], [o(`${a} + ${HOLE}`), `zg - ${HOLE}`], [o(`${a} + ${HOLE}`), eave], [o(a), `zg + tv + ${n(HOLE * R2)}`], [o(`${a} - ${HOLE}`), eave]];
    return [stub, guide];
  };
  await solid(s, { datum: X.cradle, component: cradle, fromBoard: true }, "Cradle slots", { outlines: [...slots(-1), ...slots(1)] }, TP, { operation: "cut", body });
  ids.cradle = body;
  await dis(s, "joint.create", { kind: "slider", moved: cradle, baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: -1 }, value: "la*sin(rad(jaw))", name: "Cradle" });

  // ---- the jaws: one part, twice (the front one turned round). Each is drawn in
  // its own frame with its stub pin at the origin, so the pin-slot joint's pin is
  // fixed; (s, t) is inward from the pivot and up. ----
  for (const which of ["Rear", "Front"] as const) {
    const sg = which === "Rear" ? 1 : -1;
    const c = await part(`Jaw, ${which.toLowerCase()}`, jawSide);
    const Y = (sv: X) => (sg > 0 ? `-(${str(sv)}) - la` : `(${str(sv)}) + la`); // s → the jaw's local y (the rear jaw's inward is −y)
    const at = (sv: X, t: X): P => [Y(sv), t];
    const layer = which === "Rear" ? X.gapL : X.frontIn;
    const pad: P[] = [at("dy - pdp", PAD_TOP), at(`dy - ${CH}`, PAD_TOP), at("dy", PAD_TOP - CH), at("dy", "-hc"), at("dy - pdp", "-hc")];
    // the arm from the boss down to the pad, the pad
    const body = await solid(s, { datum: layer, component: c }, `Jaw ${which}`, { outlines: [[at("-arm/2", 0), at("arm/2", 0), at("dy - 5", PAD_TOP), ...pad.slice(1), at("dy - pdp", PAD_TOP)]] }, "tj");
    // the lever out to the stub (its straight edges inside the round tip), the boss, the tip: each its own sketch
    await solid(s, { datum: layer, component: c }, `Lever ${which}`, { outlines: [[at(0, -4), at("-la", -4), at("-la", 4), at(0, 4)]] }, "tj", { operation: "join", body });
    await solid(s, { datum: layer, component: c }, `Boss ${which}`, { circles: [[Y(0), 0, BOSS]] }, "tj", { operation: "join", body });
    await solid(s, { datum: layer, component: c }, `Lever tip ${which}`, { circles: [[Y("-la"), 0, LEVER]] }, "tj", { operation: "join", body });
    // the pad spans the gap between the cheeks
    await solid(s, { datum: X.gapL, component: c }, `Pad ${which}`, { outlines: [pad] }, `gx - ${2 * C}`, { operation: "join", body });
    await solid(s, { datum: layer, component: c }, `Pivot ${which}`, { circles: [[Y(0), 0, HOLE]] }, "tj", { operation: "cut", body });
    // the stub pin, into the cradle's arm (0.5 short of its far face)
    await solid(s, { datum: which === "Rear" ? X.rearIn : X.frontIn, component: c }, `Stub ${which}`, { circles: [[0, 0, STUB]] }, TP + C - 0.5, { operation: "join", body, ...(which === "Front" ? { direction: "reverse" } : {}) });
    ids[`jaw${which}`] = body;
    // turns about its pivot so the stub stays in the cradle's slot (the slot is the cradle's z = 0)
    await dis(s, "joint.create", {
      kind: "pin-slot", moved: c, baseOrigin: { x: 0, y: out(sg > 0 ? "yc - px" : "yc + px"), z: 0 }, movedOrigin: { x: 0, y: sg > 0 ? "-la" : "la", z: 0 },
      axis: { x: 1, y: 0, z: 0 }, value: sg > 0 ? "-jaw" : "jaw", pin: { x: 0, y: 0, z: 0 }, slotBase: cradle, slotPoint: { x: 0, y: 0, z: 0 }, slotDir: { x: 0, y: 1, z: 0 },
      name: `Jaw, ${which.toLowerCase()}`,
    });
  }

  // ---- context (not printed): a piece of board, and the object, riding the tray ----
  const board = await part("SKÅDIS board (not printed)", boardMat);
  await dis(s, "joint.create", { kind: "rigid", moved: board, baseOrigin: { x: 0, y: 0, z: "zbd" }, movedOrigin: { x: 0, y: 0, z: 0 }, name: "On the board" });
  {
    const sk = (await dis(s, "sketch.create", { plane: "XZ", component: board, name: "SKÅDIS board" }))[0];
    await dis(s, "sketch.addRectangle", { sketch: sk, corner: { x: -70, y: -98 }, opposite: { x: 70, y: 42 } });
    const b = (await dis(s, "feature.extrude", { sketch: sk, distance: String(BOARD.t), direction: "reverse", name: "SKÅDIS board" }))[0]; // behind the holder (+y)
    const sl = (await dis(s, "sketch.create", { plane: "XZ", component: board, name: "SKÅDIS slots" }))[0];
    for (let j = -4; j <= 1; j++) {
      const z0 = BOARD.row * j, off = ((j % 2) + 2) % 2 ? BOARD.row : 0;
      for (let x = off - 4 * BOARD.pitch; x <= 60; x += BOARD.pitch) {
        if (x < -60) continue;
        await dis(s, "sketch.addSlot", { sketch: sl, p1: { x, y: z0 + BOARD.slotW / 2 }, p2: { x, y: z0 + BOARD.slotH - BOARD.slotW / 2 }, width: BOARD.slotW });
      }
    }
    const cut = (await dis(s, "feature.extrude", { sketch: sl, distance: String(BOARD.t), direction: "reverse", operation: "cut", body: b, name: "SKÅDIS slots" }))[0];
    for (const f of [b, cut]) await dis(s, "feature.setCondition", { feature: f, when: "board" });
    ids.board = b;
  }
  const obj = await part("Held object (not printed)", objMat);
  await dis(s, "joint.create", { kind: "rigid", base: cradle, moved: obj, baseOrigin: { x: 0, y: out("yc"), z: "zt" }, movedOrigin: { x: 0, y: 0, z: 0 }, name: "On the tray" });
  {
    // a rounded-off bar as deep as the jaws hold and no wider than fits between the cheeks
    const hy = "(held/2 - 0.05)", hx = "(min(held, gx - 2)/2)", k = `(0.3*min(${hx}, ${hy}))`;
    const o: P[] = [[`-${hx} + ${k}`, `-${hy}`], [`${hx} - ${k}`, `-${hy}`], [hx, `-${hy} + ${k}`], [hx, `${hy} - ${k}`], [`${hx} - ${k}`, hy], [`-${hx} + ${k}`, hy], [`-${hx}`, `${hy} - ${k}`], [`-${hx}`, `-${hy} + ${k}`]];
    const f = await solid(s, { plane: "XY", component: obj }, "Held object", { outlines: [o] }, "30 - zt");
    await dis(s, "feature.setCondition", { feature: f, when: "board" });
    ids.object = f;
  }

  // the stand-ins' sketches would draw as loose outlines with `board` unticked
  const loose = Object.values(s.doc.sketches).filter((k) => ["SKÅDIS board", "SKÅDIS slots", "Held object"].includes(k.name)).map((k) => k.id);
  const hid = await s.setVisibility(loose, false);
  if (!hid.ok) throw new Error(hid.error);

  await dis(s, "drawing.publish", { title: "SKÅDIS gravity holder" });
  return ids;
}

// ---------------------------------------------------------------------------

const scopeOf = (doc: CadDocument, over: Record<string, number> = {}) => {
  const params = doc.parameters.map((p) => (p.name in over ? { ...p, expr: String(over[p.name]) } : p));
  return { params, scope: resolveParameters(params).scope };
};
/** The model posed with parameters overridden, its sketches placed for that pose (as the motion study does). */
function posed(s: CadSession, over: Record<string, number> = {}) {
  const { params, scope } = scopeOf(s.doc, over);
  // sketch points written as expressions move with the parameters (as the motion study re-places them)
  const sketches = Object.fromEntries(Object.entries(s.doc.sketches).map(([k, v]) => {
    const sk = { ...v, entities: Object.fromEntries(Object.entries(v.entities).map(([i, e]) => [i, { ...e }])) };
    placeParametricPoints(sk, scope);
    return [k, sk];
  }));
  const doc: CadDocument = { ...s.doc, parameters: params, sketches, joints: Object.fromEntries(Object.entries(s.doc.joints).map(([k, v]) => [k, { ...v }])) };
  placeComponentSketches(doc, scope);
  return { doc, scope };
}
const componentOf = (doc: CadDocument, sketchId: string) => doc.components[doc.sketches[sketchId]?.componentId ?? ""]?.name ?? "?";
/** Each part's bodies (volume, centroid, mesh) at a pose. */
function parts(s: CadSession, over: Record<string, number> = {}) {
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

const RHO = 1.24e-3;   // PLA, g/mm³ (solid; infill only makes the parts lighter, all alike)
const G = 9.81e-3;     // N per g
const MOVING = ["Cradle", "Jaw, rear", "Jaw, front"];

describe("SKÅDIS gravity holder", () => {
  let s: CadSession;
  beforeAll(async () => {
    await initKernel({ wasmBinary: wasm });
    s = realSession();
    await buildSkadis(s);
    await s.recompute();
  }, 300000);

  it("builds: eleven printed parts and the board, every body clean, one body per part", async () => {
    if (OUT) writeFileSync(`${OUT}/skadis.json`, serializeDocument(s.doc));
    for (const sk of Object.values(s.doc.sketches)) expect(sk.status.conflicting, `sketch ${sk.name}`).toBe(false);
    const { by, out } = parts(s);
    for (const b of Object.values(out)) expect(b.error, b.name).toBeUndefined();
    const names = Object.keys(by).sort();
    expect(names).toEqual(["Cheek L", "Cheek R", "Cradle", "Held object (not printed)", "Jaw, front", "Jaw, rear", "Pin 1", "Pin 2", "Pin 3", "Pin 4", "SKÅDIS board (not printed)", "Tie bar 1", "Tie bar 2"]);
    for (const [name, p] of Object.entries(by)) expect(p.meshes.length, name).toBe(1);
    // the two jaws are one part: the same volume
    expect(by["Jaw, front"].volume).toBeCloseTo(by["Jaw, rear"].volume, 3);
    const grams = Object.entries(by).filter(([k]) => !/not printed/.test(k)).map(([k, p]) => `${k} ${(p.volume * RHO).toFixed(1)} g`);
    console.log(`parts (solid PLA): ${grams.join(", ")}`);
    expect(s.doc.drawing?.title).toBe("SKÅDIS gravity holder");
    if (OUT) {
      // one STL per printed part, as modelled (turn each to its print axis in the slicer)
      for (const b of Object.values(out)) {
        if (!b.mesh) continue;
        const name = componentOf(s.doc, b.sketchId);
        if (/not printed/.test(name)) continue;
        const { doc, scope } = posed(s);
        const bytes = await exportFeatureBytes(doc, scope, b.featureId, "stl");
        if (bytes) writeFileSync(`${OUT}/skadis-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.stl`, bytes);
      }
    }
  }, 300000);

  it("fits the SKÅDIS board: a fin in a slot each side at the slot pitch, a lip behind the board, a peg in the slot below", async () => {
    for (const hooks of [40, 80]) {
      const { doc, scope, by } = parts(s, { hooks });
      // read the hooks off the cheeks' own geometry: whatever reaches behind the board's face
      for (const [side, sg] of [["Cheek L", -1], ["Cheek R", 1]] as const) {
        const m = by[side].meshes[0], v: { x: number; y: number; z: number }[] = [];
        for (let i = 0; i < m.positions.length; i += 3) if (m.positions[i + 1] > 0.01) v.push({ x: m.positions[i], y: m.positions[i + 1], z: m.positions[i + 2] });
        const span = (f: (p: { x: number; y: number; z: number }) => number, q = v) => [Math.min(...q.map(f)), Math.max(...q.map(f))];
        const [x0, x1] = span((p) => p.x);
        expect((x0 + x1) / 2, `${side} fin centre, hooks ${hooks}`).toBeCloseTo((sg * hooks) / 2, 4); // on the slot column
        expect(x1 - x0).toBeCloseTo(HOOK.t, 4);                                                         // 0.3 a side in the 5 mm slot
        expect(BOARD.slotW - (x1 - x0)).toBeCloseTo(2 * C, 4);
        const top = v.filter((p) => p.z > scope.zs - 20), peg = v.filter((p) => p.z < scope.zs - 20);
        const slotBottom = scope.zs - HOOK.seat, arcRise = BOARD.slotW / 2 - Math.sqrt((BOARD.slotW / 2) ** 2 - (HOOK.t / 2) ** 2);
        expect(span((p) => p.y, top)[1]).toBeCloseTo(BOARD.t + 0.4 + HOOK.lip, 4);                      // through the board and a lip behind it
        expect(Math.min(...top.filter((p) => p.y > BOARD.t).map((p) => p.z))).toBeLessThan(slotBottom - 3); // the lip drops 3.6 below the slot's bottom
        expect(span((p) => p.z, top.filter((p) => p.y < BOARD.t))[0] - slotBottom).toBeGreaterThan(arcRise); // in the slot, the fin's corners clear its round end
        const [t0, t1] = span((p) => p.z, top);
        expect(t1 - t0).toBeLessThan(BOARD.slotH - 4);                                                   // fin + lip pass the slot, lifted
        const [p0, p1] = span((p) => p.z, peg);
        expect(p0 - (slotBottom - BOARD.pitch)).toBeGreaterThan(arcRise);                                // the peg sits in the slot 40 below…
        expect(slotBottom - BOARD.pitch + BOARD.slotH - arcRise - p1).toBeGreaterThan(HOOK.drop - HOOK.seat + 0.5); // …with room to lift the lip in
      }
      // nothing hits the board: the fins sit in the slots, the cheeks on its face
      const c = collideFeatures(doc, scope);
      expect(c.buildError).toBeUndefined();
      for (const o of c.overlaps) expect(o.volume, `${o.a} × ${o.b} at hooks ${hooks}`).toBeLessThan(0.01);
      // the check can fail: drop the holder 1.5 mm (as if the slots were higher) and the fins hit the slots' ends
      const sunk = { ...doc, joints: Object.fromEntries(Object.entries(doc.joints).map(([k, j]) => [k, j.name === "On the board" ? { ...j, originExprs: { base: { z: "zbd + 1.5" } } } : j])) };
      placeComponentSketches(sunk, scope);
      const hit = collideFeatures(sunk, scope).overlaps.filter((o) => /board/.test(o.a + o.b));
      expect(hit.length).toBeGreaterThanOrEqual(2);
    }
  }, 600000);

  it("closes as the cradle drops: each jaw turns by `jaw`, the pads from the opening to a third of it", async () => {
    const rows: string[] = [];
    for (const size of [20, 30, 48]) {
      let last = Infinity;
      for (const jaw of [0, 5, 10, 15, 20]) {
        const { doc, scope } = posed(s, { size, jaw });
        const world = resolveComponentWorld(doc, scope);
        const comp = (name: string) => Object.values(doc.components).find((c) => c.name === name)!.id;
        const jv = (name: string) => Object.values(doc.joints).find((j) => j.name === name)!;
        expect(jv("Jaw, rear").error).toBeUndefined();
        expect(jv("Jaw, rear").valueValue).toBeCloseTo(-jaw, 6); // the pin-slot solves the jaw from the cradle's drop
        expect(jv("Jaw, front").valueValue).toBeCloseTo(jaw, 6);
        const drop = -applyPoint(world.get(comp("Cradle"))!, { x: 0, y: 0, z: 0 }).z;
        expect(drop).toBeCloseTo(scope.la * Math.sin((jaw * Math.PI) / 180), 6);
        // the contact corners (foot of each pad's lead-in), in each jaw's own frame
        const rear = applyPoint(world.get(comp("Jaw, rear"))!, { x: 0, y: -scope.dy - scope.la, z: -scope.hc });
        const front = applyPoint(world.get(comp("Jaw, front"))!, { x: 0, y: scope.dy + scope.la, z: -scope.hc });
        const gap = rear.y - front.y; // the board is behind, at +y
        expect(gap).toBeCloseTo(scope.held, 6);
        expect((rear.y + front.y) / 2).toBeCloseTo(-scope.yc, 6); // symmetric about the axis
        expect(gap).toBeLessThan(last);
        last = gap;
        if (jaw === 0) expect(gap).toBeCloseTo(size, 6);
        if (jaw === JAW_MAX) { expect(gap).toBeCloseTo(size / 3, 6); rows.push(`size ${size}: ${size} → ${gap.toFixed(1)} mm over ${drop.toFixed(1)} mm of travel; lever ${scope.la} mm, pads ${scope.hc.toFixed(1)} mm under the pivots (×${(scope.la / scope.hc).toFixed(2)})`); }
      }
    }
    console.log(rows.join("\n"));
  }, 120000);

  // The motion study sweeps `jaw` at the saved sizes (test/examples.test.ts); here, the corners of the sliders.
  const POSES: Record<string, number>[] = [
    { jaw: 7 }, { jaw: 14 }, { jaw: 20 },
    { size: 20, jaw: 0 }, { size: 20, jaw: 20 }, { size: 48, jaw: 0 }, { size: 48, jaw: 20 },
    { arm: 10, jaw: 20 }, { arm: 5, jaw: 0 }, { wall: 3, jaw: 20 }, { wall: 6, jaw: 20 },
    { hooks: 80, size: 48, jaw: 10 }, { size: 48, arm: 10, wall: 6, jaw: 20 },
  ];
  for (const over of POSES) {
    const label = Object.entries(over).map(([k, v]) => `${k} ${v}`).join(", ");
    it(`is clear at ${label}`, async () => {
      const { doc, scope } = posed(s, over);
      const c = collideFeatures(doc, scope);
      expect(c.buildError).toBeUndefined();
      for (const o of c.overlaps) expect(o.volume, `${o.a} × ${o.b} at ${label}`).toBeLessThan(0.01);
    }, 600000);
  }

  // Virtual work: the moving parts' weight against the jaw angle. Empty, it must
  // rise as the jaws close (so they fall open); an object on the tray adds its
  // weight times the drop, and closes them once it outweighs that.
  it("falls open when empty, and an object's weight shuts it: grip in proportion to the weight", async () => {
    const rows: string[] = [], checks: (() => void)[] = [];
    for (const size of [20, 30, 48]) {
      const th = Array.from({ length: 9 }, (_, k) => (JAW_MAX * k) / 8);
      const U = th.map((jaw) => { const { by } = parts(s, { size, jaw }); return MOVING.reduce((u, k) => u + by[k].volume * RHO * by[k].centroid.z, 0); }); // g·mm
      const sc = scopeOf(s.doc, { size }).scope;
      let worst = 0;
      const slopes: number[] = [];
      for (let k = 1; k < th.length; k++) {
        const dU = (U[k] - U[k - 1]) / (((th[k] - th[k - 1]) * Math.PI) / 180); // g·mm per rad
        slopes.push(dU);
        const mid = (((th[k] + th[k - 1]) / 2) * Math.PI) / 180;
        worst = Math.max(worst, dU / (sc.la * Math.cos(mid)));                     // the mass whose drop just balances it
      }
      // the squeeze on a 100 g object, per pad, held half shut: virtual work over the pads' travel
      const mid = (JAW_MAX / 2) * Math.PI / 180, kk = 4;
      const dU = (U[kk + 1] - U[kk - 1]) / ((2 * (JAW_MAX / 8) * Math.PI) / 180);
      const ds = sc.hc * Math.cos(mid) - sc.dy * Math.sin(mid);                    // each pad's inward travel per rad
      const grip = (G * (100 * sc.la * Math.cos(mid) - dU)) / (2 * ds);
      console.log(`size ${size}: dU/dθ ${slopes.map((v) => v.toFixed(0)).join(" ")} g·mm/rad`);
      checks.push(() => {
        for (const [k, v] of slopes.entries()) expect(v, `size ${size}, jaw ${th[k]}…${th[k + 1]}`).toBeGreaterThan(0); // empty, the jaws fall open
          expect(worst).toBeLessThan(1.25 * size);                                   // a light object shuts it: under 25 g a size 20, 60 g a size 48 (solid PLA parts)
        expect(grip).toBeGreaterThan(0.05);                                          // a 100 g object is held, at every size
      });
      rows.push(`size ${size}: empty it opens with ${(dU * G / 1000).toFixed(4)} N·m to spare at ${JAW_MAX / 2}°; closes on anything over ${worst.toFixed(0)} g; a 100 g object is gripped with ${grip.toFixed(2)} N a pad`);
    }
    console.log(rows.join("\n"));
    for (const c of checks) c();
  }, 600000);

  // Each part on its print bed: the face it lies on, and no face (other than
  // the bed) facing down more than 45° from the vertical.
  it("prints without supports: every part has a flat face on the bed and no overhang past 45°", async () => {
    const BED: Record<string, { x: number; y: number; z: number }> = {
      "Cheek L": { x: -1, y: 0, z: 0 }, "Cheek R": { x: 1, y: 0, z: 0 },                // on their outer faces, the hooks in the layers
      "Jaw, rear": { x: -1, y: 0, z: 0 }, "Jaw, front": { x: 1, y: 0, z: 0 },          // on their sides, the stub pin up
      "Cradle": { x: 0, y: 0, z: -1 },                                                 // standing, on its bottom bar and tray
      "Pin 1": { x: 0, y: -1, z: 0 }, "Pin 2": { x: 0, y: -1, z: 0 }, "Pin 3": { x: 0, y: -1, z: 0 }, "Pin 4": { x: 0, y: -1, z: 0 }, // on their flats
      "Tie bar 1": { x: 0, y: 0, z: -1 }, "Tie bar 2": { x: 0, y: 0, z: -1 },          // on their backs, the tenons flush
    };
    const axisOf: Record<string, string> = {};
    for (const c of Object.values(s.doc.components)) { const m = c.materialId ? s.doc.materials[c.materialId] : undefined; if (m) axisOf[c.name] = m.printAxis ?? "z"; }
    const rows: string[] = [];
    for (const over of [{}, { size: 20, arm: 5, wall: 3 }, { size: 48, arm: 10, wall: 6, hooks: 80 }]) {
      const { by } = parts(s, over);
      for (const [name, bed] of Object.entries(BED)) {
        // the material's print axis is this direction
        expect(axisOf[name], name).toBe(bed.x ? "x" : bed.y ? "y" : "z");
        const m = by[name].meshes[0], P = m.positions, I = m.indices;
        const along = (i: number) => P[3 * i] * bed.x + P[3 * i + 1] * bed.y + P[3 * i + 2] * bed.z;
        let bedLevel = -Infinity;
        for (let i = 0; i < P.length / 3; i++) bedLevel = Math.max(bedLevel, along(i));
        let onBed = 0, overhang = 0, worstDown = 0;
        for (let t = 0; t < I.length; t += 3) {
          const [a, b, c] = [I[t], I[t + 1], I[t + 2]];
          const u = [P[3 * b] - P[3 * a], P[3 * b + 1] - P[3 * a + 1], P[3 * b + 2] - P[3 * a + 2]], w = [P[3 * c] - P[3 * a], P[3 * c + 1] - P[3 * a + 1], P[3 * c + 2] - P[3 * a + 2]];
          const nx = u[1] * w[2] - u[2] * w[1], ny = u[2] * w[0] - u[0] * w[2], nz = u[0] * w[1] - u[1] * w[0], len = Math.hypot(nx, ny, nz);
          if (len < 1e-12) continue;
          const down = (nx * bed.x + ny * bed.y + nz * bed.z) / len, area = len / 2;      // its normal along the bed's (1 = facing the bed)
          const flat = Math.abs(along(a) - bedLevel) < 1e-3 && Math.abs(along(b) - bedLevel) < 1e-3 && Math.abs(along(c) - bedLevel) < 1e-3;
          if (flat && down > 0.999) onBed += area;
          else if (down > Math.SQRT1_2 + 1e-3) { overhang += area; worstDown = Math.max(worstDown, down); }
        }
        expect(onBed, `${name}: on the bed`).toBeGreaterThan(name.startsWith("Pin") ? 100 : 300);
        expect(overhang, `${name}: overhanging area at ${JSON.stringify(over)} (steepest ${(Math.acos(worstDown) * 180 / Math.PI).toFixed(2)}° off the bed)`).toBeLessThan(0.01);
        void worstDown;
        if (!Object.keys(over).length) rows.push(`${name} ${onBed.toFixed(0)} mm² on the bed`);
      }
    }
    console.log(rows.join(", "));
  }, 600000);
});
