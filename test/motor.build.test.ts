// End-to-end: a parametric motor to design around — every NEMA stepper frame
// from 8 to 42, the four hobby servo classes (micro 9 g to quarter scale), and
// AC/DC servo motors on the square 40–130 mm flanges, picked from a dropdown.
// Each comes in at its catalogue size (flange, mounting holes, pilot, shaft,
// typical length); the length and the shaft are sliders over that. The shaft is
// a component of its own on a revolute joint: plain, with one flat (D-cut), two
// flats or a keyway and its key, out the front or out both ends. The wiring is
// modelled for clearance: a bare connector socket (open for its plug) or a
// cable through a strain relief, off the back or the side.
// The mounting holes are tapped into a full front cap (NEMA 8–17), or clear
// through a flange plate with the body relieved behind it for the bolts' nuts
// (NEMA 23 up, servo motors); each frame comes with its usual kind, either can
// be picked. A stepper's back shows what a real one does: the tie-rods' Phillips
// heads in their counterbores and the shaft's end in the rear bearing; behind a
// flange plate the tie-rods sit beside the corner holes, their heads on the plate.
//
// Coordinates: the shaft turns about Z; z = 0 is the mounting face (a motor's
// flange face, a servo's case top), the body hangs below it, the shaft points up.
//   BUILD_MOTOR=/abs/out npx vitest run test/motor.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, sessionFromDoc, describeExample, forkSession, expectCommittedExample, FULL } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { serializeDocument, deserializeDocument } from "../src/core/persistence";
import { collideFeatures, evaluateFeatures } from "../src/core/features";
import { placeComponentSketches, resolveComponentWorld } from "../src/core/recompute";
import { expandAssembly } from "../src/core/assembly";
import { resolveParameters } from "../src/core/parameters";
import { rebuild } from "../src/core/build";
import { createDefaultRegistry } from "../src/core/command/builtins";
import { applyPoint } from "../src/math/transform";
import type { CadSession } from "../src/core/command/session";

const OUT = process.env.BUILD_MOTOR || "";
const BUILD = FULL || !!OUT;
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

// ---- the catalogue ----
// A motor (stepper or flanged servo motor):
//   A flange square, c1 its corner chamfer, capF front cap / flange thickness,
//   A2 body square, c2 its chamfer, capR rear cap length, B mounting-hole spacing
//   (square pattern; a servo motor's holes sit on its PCD, B = PCD/√2), hr hole
//   radius (tapping drill, or the clearance hole through a flange), hd hole depth,
//   D × P the pilot (register) boss, L a common body length, sd × sl the shaft
//   (diameter, length from the mounting face).
//   Pilots: the NEMA (ICS 16) figures for steppers, Ø15 × 1.5 on a NEMA 8, Ø22 × 2 on
//   11–17, Ø38.1 × 1.6 on 23/24, Ø73 × 1.6 on 34, Ø55.52 × 1.6 on 42; servo motors as
//   the 40–130 mm ST-series drawings have them, a spigot Ø30/50/70 × 3, Ø95/110 × 5.
// A hobby servo:
//   Lc × Wc the case, H (as L) its height, tab the mounting ears' overall length,
//   tabT their thickness and tabTop how far below the case top they sit, holes
//   at ±hx (and ±hy across when there are two per ear), boss bd × bh round the
//   output at ox from the centre, sd × sl the output spline, horn its arm.
// The wiring: cw × ch the socket (or strain relief), cd its depth, cab the cable's diameter.
type Motor = { A: number; c1: number; capF: number; A2: number; c2: number; capR: number; B: number; hr: number; hd: number; D: number; P: number };
type Servo = { Lc: number; Wc: number; tab: number; tabT: number; tabTop: number; hx: number; hy: number; thr: number; bd: number; bh: number; ox: number; horn: number };
type Wiring = { cw: number; ch: number; cd: number; cab: number };
type Size = { name: string; servo: boolean; L: number; sd: number; sl: number; rear: number } & Motor & Servo & Wiring;

// what the other kind's dimensions read as (unused, but kept sane so every sketch still solves)
const M0: Motor = { A: 42.3, c1: 4, capF: 8, A2: 42.3, c2: 5, capR: 9, B: 31, hr: 1.25, hd: 4.5, D: 22, P: 2 };
const S0: Servo = { Lc: 40.7, Wc: 19.7, tab: 54.5, tabT: 2.5, tabTop: 8.5, hx: 24.4, hy: 5, thr: 2.1, bd: 13, bh: 4, ox: 10.05, horn: 18 };
const stepper = (name: string, m: Motor, L: number, sd: number, sl: number, w: Wiring): Size => ({ name, servo: false, L, sd, sl, rear: Math.round(sl * 0.6), ...S0, ...m, ...w });
const servo = (name: string, s: Servo, H: number, sd: number, sl: number, w: Wiring): Size => ({ name, servo: true, L: H, sd, sl, rear: 10, ...M0, ...s, ...w });
const flanged = (name: string, A: number, capF: number, capR: number, pcd: number, hr: number, D: number, P: number, L: number, sd: number, sl: number, w: Wiring): Size =>
  stepper(name, { A, c1: Math.round(A * 0.06), capF, A2: A - 2, c2: Math.round(A * 0.08), capR, B: +(pcd / Math.SQRT2).toFixed(2), hr, hd: capF, D, P }, L, sd, sl, w);

const isStepper = (z: Size) => !z.servo && z.name.includes("stepper");
/** A stepper's through-bolt head radius (M2 on a NEMA 8 to M6 on a 42), kept inside the rear cap's chamfered corner. */
const screwHead = (z: Size) => {
  const nominal = z.A < 25 ? 1.75 : z.A < 30 ? 2.25 : z.A < 50 ? 2.75 : z.A < 70 ? 3.5 : z.A < 100 ? 4.25 : 5;
  const corner = (z.A2 - z.c1) / Math.SQRT2; // the chamfer line's distance from the centre, on the diagonal
  return +Math.min(nominal, corner - z.B / Math.SQRT2 - 0.1).toFixed(2);
};

// the mounting holes: tapped (blind, threaded) or clear through a flange plate
const nativeThrough = (z: Size) => (z.servo ? 0 : isStepper(z) && z.A < 50 ? 0 : 1);
/** The mounting screws' nominal size (M2 … M8). */
const thread = (z: Size) => {
  if (isStepper(z) && z.A < 50) return z.A < 25 ? 2 : z.A < 30 ? 2.5 : 3;
  const d = 2 * z.hr;
  return d >= 8.4 ? 8 : d >= 6.4 ? 6 : d >= 5 ? 5 : d >= 4.3 ? 4 : 3;
};
const PITCH: Record<number, number> = { 2: 0.4, 2.5: 0.45, 3: 0.5, 4: 0.7, 5: 0.8, 6: 1, 8: 1.25 };
/** A clearance hole's radius: the catalogue's where the frame comes with through holes, else ISO 273 medium. */
const clearance = (z: Size) => (nativeThrough(z) ? z.hr : +((thread(z) * 1.1 + 0.1) / 2).toFixed(2));
/** A tapped hole's depth: the catalogue's where the frame comes tapped, else 1.5 diameters (within the cap). */
const tapDepth = (z: Size) => (nativeThrough(z) ? Math.min(0.8 * z.capF, 1.5 * thread(z)) : z.hd);
/** Room on a flange plate for the tie-rods beside its holes, clear of the pilot (none on a NEMA 8). */
const tieRodRoom = (z: Size) => {
  const sr = screwHead(z), ty = z.B / 2 - (clearance(z) + sr + 1.5);
  return isStepper(z) && Math.hypot(z.B / 2, ty) - (counterbore(z) + 0.22 * sr) - 0.5 > z.D / 2 ? 1 : 0;
};
/** The counterbore round a tie-rod's head: a little wider than the head, as far as the rear cap's corner allows. */
const counterbore = (z: Size) => {
  const sr = screwHead(z), room = (z.A2 - z.c1) / Math.SQRT2 - z.B / Math.SQRT2;
  return +Math.max(sr + 0.15, Math.min(1.18 * sr, room - 0.22 * sr - 0.15)).toFixed(2);
};
const HOLES = ["Tapped (threaded)", "Through a flange plate"];

// sockets: JST-PH (small steppers), 4-pin housings (NEMA 23 up), round M17-style (servo motors), a servo's lead
const W_XS: Wiring = { cw: 8, ch: 4.5, cd: 3, cab: 3 };
const W_S: Wiring = { cw: 13, ch: 5.5, cd: 4.5, cab: 4 };
const W_M: Wiring = { cw: 15, ch: 7, cd: 6, cab: 6 };
const W_L: Wiring = { cw: 20, ch: 10, cd: 8, cab: 8 };
const W_SERVO: Wiring = { cw: 6, ch: 3, cd: 3, cab: 2.5 };
const W_SERVO_L: Wiring = { cw: 8, ch: 4, cd: 4, cab: 3.5 };
const W_ROUND: Wiring = { cw: 18, ch: 18, cd: 10, cab: 8 };

export const SIZES: Size[] = [
  stepper("NEMA 8 stepper (20 mm)", { A: 20.3, c1: 1.5, capF: 5, A2: 20.3, c2: 2, capR: 5, B: 16, hr: 0.8, hd: 2.5, D: 15, P: 1.5 }, 30, 4, 12, W_XS),
  stepper("NEMA 11 stepper (28 mm)", { A: 28.2, c1: 2.5, capF: 6, A2: 28.2, c2: 3.5, capR: 6, B: 23, hr: 1.05, hd: 3, D: 22, P: 2 }, 40, 5, 20, W_XS),
  stepper("NEMA 14 stepper (35 mm)", { A: 35.2, c1: 3, capF: 7, A2: 35.2, c2: 4, capR: 7, B: 26, hr: 1.25, hd: 3.5, D: 22, P: 2 }, 34, 5, 20, W_S),
  stepper("NEMA 17 stepper (42 mm)", { A: 42.3, c1: 3.5, capF: 8, A2: 42.3, c2: 5, capR: 9, B: 31, hr: 1.25, hd: 4.5, D: 22, P: 2 }, 48, 5, 24, W_S),
  stepper("NEMA 23 stepper (57 mm)", { A: 56.4, c1: 4, capF: 7.5, A2: 56.4, c2: 6, capR: 9, B: 47.14, hr: 2.55, hd: 7.5, D: 38.1, P: 1.6 }, 56, 6.35, 20.6, W_M),
  stepper("NEMA 24 stepper (60 mm)", { A: 60, c1: 4.5, capF: 7.5, A2: 60, c2: 6.5, capR: 9, B: 47.14, hr: 2.55, hd: 7.5, D: 38.1, P: 1.6 }, 65, 8, 21, W_M),
  stepper("NEMA 34 stepper (86 mm)", { A: 86, c1: 6, capF: 10, A2: 86, c2: 9, capR: 12, B: 69.6, hr: 2.75, hd: 10, D: 73, P: 1.6 }, 80, 14, 32, W_L),
  stepper("NEMA 42 stepper (110 mm)", { A: 110, c1: 8, capF: 12, A2: 110, c2: 12, capR: 14, B: 88.9, hr: 4.25, hd: 12, D: 55.52, P: 1.6 }, 150, 19, 40, W_L),
  servo("Micro servo (9 g, SG90)", { Lc: 22.8, Wc: 12.2, tab: 32.2, tabT: 2.5, tabTop: 4.3, hx: 13.9, hy: 0, thr: 1, bd: 11.8, bh: 4, ox: 5.5, horn: 14 }, 22.7, 4.8, 7, W_SERVO),
  servo("Mini servo (HS-82 class)", { Lc: 29.8, Wc: 12, tab: 39.4, tabT: 2.5, tabTop: 5.5, hx: 17.2, hy: 0, thr: 1, bd: 11.6, bh: 4.6, ox: 8.4, horn: 16 }, 25, 4.9, 8, W_SERVO),
  servo("Standard servo (MG996R, S3003)", S0, 37, 5.8, 9, W_SERVO_L),
  servo("Large servo (¼ scale, HS-805)", { Lc: 65.9, Wc: 30.2, tab: 84, tabT: 4, tabTop: 14, hx: 37.5, hy: 10, thr: 2.6, bd: 22, bh: 5.4, ox: 16.95, horn: 32 }, 52, 8, 12, W_SERVO_L),
  flanged("Servo motor, 40 mm flange", 40, 8, 20, 46, 1.75, 30, 3, 80, 8, 28, { ...W_ROUND, cw: 12, ch: 12 }),
  flanged("Servo motor, 60 mm flange", 60, 7.5, 25, 70, 2.75, 50, 3, 110, 14, 30, W_ROUND),
  flanged("Servo motor, 80 mm flange", 80, 8, 30, 90, 3, 70, 3, 130, 19, 35, W_ROUND),
  flanged("Servo motor, 110 mm flange", 110, 12, 35, 130, 4.5, 95, 5, 170, 19, 55, W_ROUND),
  flanged("Servo motor, 130 mm flange", 130, 14, 40, 145, 4.5, 110, 5, 180, 22, 57, W_ROUND),
];
const DEFAULT_SIZE = 3; // NEMA 17
const SHAFTS = ["Plain round", "One flat (D-cut)", "Two flats (double D)", "Keyway and key"];
const ENDS = ["Single shaft (front)", "Double shaft (front and rear)"];
const WIRING = ["Connector on the side", "Connector on the back", "Cable on the side", "Cable on the back"];

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}
type X = number | string;
const num = (v: number) => String(+v.toFixed(4));

async function buildMotor(s: CadSession): Promise<void> {
  const pick = (f: (z: Size) => number) => `pick(size, ${SIZES.map((z) => num(f(z))).join(", ")})`;
  // the controls
  await dis(s, "parameter.add", { name: "size", expression: String(DEFAULT_SIZE), options: SIZES.map((z) => z.name) });
  await dis(s, "parameter.add", { name: "length", expression: pick((z) => z.L), min: 12, max: 250, step: 0.5 });
  await dis(s, "parameter.add", { name: "holes", expression: pick(nativeThrough), options: HOLES });
  await dis(s, "parameter.add", { name: "shaft", expression: "1", options: SHAFTS });
  await dis(s, "parameter.add", { name: "shaft_d", expression: pick((z) => z.sd), min: 2, max: 25, step: 0.05 });
  await dis(s, "parameter.add", { name: "shaft_len", expression: pick((z) => z.sl), min: 4, max: 100, step: 0.5 });
  await dis(s, "parameter.add", { name: "ends", expression: "0", options: ENDS });
  await dis(s, "parameter.add", { name: "rear_len", expression: pick((z) => z.rear), min: 3, max: 60, step: 0.5 });
  await dis(s, "parameter.add", { name: "wiring", expression: "2", options: WIRING });
  await dis(s, "parameter.add", { name: "horn", expression: "1", boolean: true });
  await dis(s, "parameter.add", { name: "angle", expression: "0", min: 0, max: 360, step: 1 });

  // the catalogue, per size
  const hidden = (name: string, expression: string) => dis(s, "parameter.add", { name, expression, hidden: true });
  await hidden("fh", pick((z) => (z.servo ? 1 : 0))); // a hobby servo
  await hidden("fm", "1 - fh");                        // a motor (stepper or flanged servo motor)
  for (const k of ["A", "c1", "capF", "A2", "c2", "capR", "B", "hr", "D", "P", "Lc", "Wc", "tab", "tabT", "tabTop", "hx", "hy", "thr", "bd", "bh", "ox", "horn_len", "cw", "ch", "cd", "cab"] as const) {
    await hidden(k, pick((z) => z[(k === "horn_len" ? "horn" : k) as keyof Size] as number));
  }
  await hidden("two", "min(1, hy)"); // two holes per ear
  // the length can't leave the caps (or a servo's ears and its lead) no room
  await hidden("Lb", "max(length, fm*(capF + capR + 4) + fh*(tabTop + tabT + ch + 4))");
  // the shaft rises from the pilot (a servo's from its boss), and always stands clear of it
  await hidden("zs", "fm*P + fh*bh");
  await hidden("sL", "max(shaft_len, zs + 2)");
  await hidden("r", "shaft_d/2");
  await hidden("ax", "fh*ox"); // where the shaft turns
  // the shaft's form: flats, a keyway (ISO 6885 key for the diameter)
  await hidden("flat1", "fm*pick(shaft, 0, 1, 1, 0)");
  await hidden("flat2", "fm*pick(shaft, 0, 0, 1, 0)");
  await hidden("keyed", "fm*pick(shaft, 0, 0, 0, 1)");
  await hidden("fd", "0.1*shaft_d");               // flat depth: 0.5 on a 5 mm shaft
  await hidden("run", "sL - zs");                  // the shaft's exposed run
  await hidden("fl", "0.75*run");                  // flat length, from the tip
  const ge = (a: number) => `min(1, max(0, floor(shaft_d - ${a} + 1)))`;
  await hidden("kb", `min(0.4*shaft_d, 2 + ${ge(8)} + ${ge(10)} + ${ge(12)} + ${ge(17)} + 2*${ge(22)})`);
  await hidden("kh", `min(0.4*shaft_d, 2 + ${ge(8)} + ${ge(10)} + ${ge(12)} + ${ge(17)} + ${ge(22)})`);
  await hidden("t1", `min(0.3*shaft_d, 1.2 + 0.6*${ge(8)} + 0.7*${ge(10)} + 0.5*${ge(12)} + 0.5*${ge(17)} + 0.5*${ge(22)})`);
  await hidden("kl", "0.7*run");
  await hidden("kz", "zs + 0.15*run");
  await hidden("rear", "fm*ends");
  // the wiring
  await hidden("side", "pick(wiring, 1, 0, 1, 0)");
  await hidden("conn", "pick(wiring, 1, 1, 0, 0)");
  await hidden("half", "fm*A2/2 + fh*Lc/2");                            // the rear part's half-width (X)
  await hidden("cz", "fm*(capR/2 - Lb) + fh*(1.5 + ch/2 - Lb)");        // a side socket's height
  await hidden("bx", "ch/2 + 1.5 - half");                              // a back socket's offset (clear of a rear shaft)
  await hidden("lead", "4*cab + 12");                                   // the cable stub shown for clearance
  // the mounting holes: through a flange plate (its body relieved behind, clear of a nut on each bolt) or tapped
  await hidden("thru", "fm*holes");
  await hidden("tm", pick(thread));                                     // the screws' nominal size
  await hidden("hcl", pick(clearance));                                 // a clearance hole's radius
  await hidden("ft", "capF - thru*0.4*capF");                           // the flange plate's thickness
  await hidden("dl", "B*0.7071 - 0.9*tm - 0.8");                        // the relief's line, on the diagonal, a nut's width in from the holes
  // a stepper's tie-rods: heads in counterbores at the back (and on a flange plate, beside its holes); the rear bearing round the shaft's end
  await hidden("fst", pick((z) => (isStepper(z) ? 1 : 0)));
  await hidden("sr", pick(screwHead));                                  // head radius
  await hidden("hh", "0.6*sr");                                         // head height
  await hidden("cbr", pick(counterbore));                               // counterbore radius
  await hidden("cc", "0.22*sr");                                        // its mouth's 45° chamfer
  await hidden("vc", "(0.84*hh*hh - sr*sr)/(1.2*hh)");                  // a pan head's dome: its centre, up from the head's underside
  await hidden("tr", pick(tieRodRoom));
  await hidden("ty", "B/2 - thru*tr*(hcl + sr + 1.5)");                    // the tie-rods at (±B/2, ±ty): the corners, or beside a plate's holes
  await hidden("rbo", "max(r + 1.5, min(1.4*r + 0.09*A2, sqrt(B*B/4 + ty*ty) - cbr - cc - 1))"); // bearing outer radius, clear of the screws
  await hidden("bpd", "0.3*capR");                                      // bearing pocket depth
  await hidden("sbd", "0.6*capR");                                      // how far the shaft's end runs into the cap

  // materials, after a black NEMA 23: anodised caps with the front face machined bright, a black laminated stack
  const mat = async (name: string, p: Record<string, unknown>) => (await dis(s, "material.create", { name, ...p }))[0];
  const anod = await mat("Aluminium, black anodised", { kind: "metal", finish: "satin", color: "#232427", roughness: 0.42, metalness: 0.6 });
  const bright = await mat("Aluminium, machined", { kind: "metal", finish: "brushed", color: "#dfe2e6", roughness: 0.32, textureAxis: "x" });
  const stack = await mat("Laminated stator, black", { kind: "painted", color: "#1b1c1e", roughness: 0.55, texture: "ribs", textureAxis: "z", textureScale: 0.8 });
  const steel = await mat("Steel, ground", { kind: "metal", finish: "satin", color: "#d6d9dd", roughness: 0.22 });
  const caseMat = await mat("Servo case, black ABS", { kind: "plastic", finish: "satin", color: "#1d1e21" });
  const horn = await mat("Horn, white nylon", { kind: "plastic", finish: "matte", color: "#eeeeea" });
  const nylon = await mat("Connector, natural nylon", { kind: "plastic", finish: "satin", color: "#efeadc" });
  const relief = await mat("Strain relief, black", { kind: "plastic", finish: "matte", color: "#18191b" });
  const pvc = await mat("Cable, black PVC", { kind: "rubber", color: "#141416" });
  const zinc = await mat("Steel, zinc plated", { kind: "metal", finish: "satin", color: "#c9ccd0", roughness: 0.3 });
  const shield = await mat("Bearing shield, steel", { kind: "metal", finish: "satin", color: "#b4b8bd", roughness: 0.35 });
  const part = async (name: string, material: string, parent?: string) => {
    const c = (await dis(s, "component.create", { name, ...(parent ? { parent } : {}) }))[0];
    await dis(s, "material.assign", { component: c, material });
    return c;
  };
  const housing = await part("Housing", anod), face = await part("Machined face", bright), stator = await part("Stator", stack);
  const caseC = await part("Servo case", caseMat);
  const shaftC = await part("Shaft", steel), hornC = await part("Horn", horn, shaftC);
  const screwsC = await part("Screws", zinc), bearingC = await part("Rear bearing", shield);
  const connC = await part("Connector", nylon), reliefC = await part("Strain relief", relief), cable = await part("Cable", pvc);

  // ---- sketch helpers: every coordinate an expression ----
  const sketch = async (comp: string, plane: "XY" | "XZ" | "YZ", name: string) => (await dis(s, "sketch.create", { plane, component: comp, name }))[0];
  const point = async (sk: string, x: X, y: X) => (await dis(s, "sketch.addPoint", { sketch: sk, x: String(x), y: String(y) }))[0];
  const loop = async (sk: string, pts: [X, X][]) => {
    const ids: string[] = [];
    for (const [x, y] of pts) ids.push(await point(sk, x, y));
    for (let i = 0; i < ids.length; i++) await dis(s, "sketch.addLine", { sketch: sk, start: { ref: ids[i] }, end: { ref: ids[(i + 1) % ids.length] } });
  };
  const rect = (sk: string, x0: X, y0: X, x1: X, y1: X) => loop(sk, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
  /** A square of half-width `h` with its corners chamfered by `c`, centred on the origin. */
  const octagon = (sk: string, h: string, c: string) => loop(sk, [
    [`${h} - ${c}`, `-${h}`], [h, `${c} - ${h}`], [h, `${h} - ${c}`], [`${h} - ${c}`, h],
    [`${c} - ${h}`, h], [`-${h}`, `${h} - ${c}`], [`-${h}`, `${c} - ${h}`], [`${c} - ${h}`, `-${h}`],
  ]);
  const circle = async (sk: string, x: X, y: X, rad: string) => {
    const c = await point(sk, x, y);
    const [ci] = await dis(s, "sketch.addCircle", { sketch: sk, center: { ref: c }, radius: 1 });
    await dis(s, "sketch.addDimension", { sketch: sk, type: "radius", circle: ci, expression: rad });
  };
  /** Extrude `sk` from `from` to `from + dist` along its plane's normal (or symmetric about the plane), built while `when`. */
  const solid = async (sk: string, name: string, o: { from?: string; dist: string; op?: "new" | "join" | "cut"; body?: string; symmetric?: boolean; when?: string }) => {
    const [f] = await dis(s, "feature.extrude", { sketch: sk, distance: o.dist, operation: o.op ?? "new", name, ...(o.from ? { startOffset: o.from } : {}), ...(o.body ? { body: o.body } : {}), ...(o.symmetric ? { symmetric: true } : {}) });
    if (o.when) await dis(s, "feature.setCondition", { feature: f, when: o.when });
    return f;
  };

  // ---- a motor: front cap (flange) with its machined face, pilot and mounting holes; the stator; the rear cap ----
  let sk = await sketch(housing, "XY", "Flange");
  await octagon(sk, "A/2", "c1");
  // (the face is a skin of its own: anodised, then machined back to bare metal)
  const front = await solid(sk, "Flange", { from: "-capF", dist: "capF - 0.4", when: "fm" });
  sk = await sketch(housing, "XY", "Pilot");
  await circle(sk, 0, 0, "D/2");
  await solid(sk, "Pilot", { from: "-0.4", dist: "P + 0.4", op: "join", body: front, when: "fm" });
  sk = await sketch(face, "XY", "Machined face");
  await octagon(sk, "A/2", "c1");
  const faceBody = await solid(sk, "Machined face", { from: "-0.4", dist: "0.4", when: "fm" });
  sk = await sketch(face, "XY", "Pilot bore");
  await circle(sk, 0, 0, "D/2");
  await solid(sk, "Pilot bore", { from: "-1", dist: "2", op: "cut", body: faceBody, when: "fm" });
  const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  // through a flange plate: clearance holes, and the cap behind the plate relieved at the corners
  sk = await sketch(housing, "XY", "Mounting holes");
  for (const [sx, sy] of corners) await circle(sk, `${sx}*B/2`, `${sy}*B/2`, "hcl");
  await solid(sk, "Mounting holes", { from: "-capF - 1", dist: "capF + 2", op: "cut", body: front, when: "thru" });
  sk = await sketch(housing, "XY", "Relief");
  for (const [sx, sy] of corners) await loop(sk, [[`${sx}*(1.4142*dl - A/2 - 1)`, `${sy}*(A/2 + 1)`], [`${sx}*(A/2 + 1)`, `${sy}*(A/2 + 1)`], [`${sx}*(A/2 + 1)`, `${sy}*(1.4142*dl - A/2 - 1)`]]);
  await solid(sk, "Relief", { from: "-capF - 1", dist: "capF + 1 - ft", op: "cut", body: front, when: "thru" });
  // tapped: drilled and threaded, one feature per frame (a hole's position and thread are numbers)
  for (const [i, z] of SIZES.entries()) {
    if (z.servo) continue;
    const b = z.B / 2, tm = thread(z), depth = tapDepth(z);
    const [h] = await dis(s, "feature.hole", {
      name: `Tapped holes, M${tm}`, body: front, at: corners.map(([sx, sy]) => ({ x: sx * b, y: sy * b, z: 0 })),
      diameter: num(tm - PITCH[tm]), depth: num(depth),
      thread: { form: "metric", pitch: PITCH[tm], diameter: tm, length: +(depth - 0.5 * tm).toFixed(2), internal: true, representation: "cosmetic" },
    });
    await dis(s, "feature.setCondition", { feature: h, when: `(1 - holes)*max(0, 1 - abs(size - ${i}))` });
  }
  sk = await sketch(face, "XY", "Mounting holes, face");
  for (const [sx, sy] of corners) await circle(sk, `${sx}*B/2`, `${sy}*B/2`, "thru*hcl + (1 - thru)*tm/2");
  await solid(sk, "Mounting holes, face", { from: "-1", dist: "2", op: "cut", body: faceBody, when: "fm" });
  sk = await sketch(stator, "XY", "Stator");
  await octagon(sk, "A2/2", "max(c2, thru*(A2 - 1.4142*dl))"); // relieved with the flange plate's front cap
  await solid(sk, "Stator", { from: "capR - Lb", dist: "Lb - capR - capF", when: "fm" });
  sk = await sketch(housing, "XY", "Rear cap");
  await octagon(sk, "A2/2", "c1");
  const rearCap = await solid(sk, "Rear cap", { from: "-Lb", dist: "capR", when: "fm" });
  // a stepper's tie-rods: Phillips pan heads just below the face, in counterbores chamfered at the mouth,
  // at the back (and on a flange plate). Turned profiles, drawn on planes through the screws' rows (y = ±ty)
  // in u (along x) and v (up z), each revolved about its screw's axis.
  const rows = new Map<number, string>();
  for (const sy of [1, -1]) rows.set(sy, (await dis(s, "plane.create", { origin: { x: 0, y: `${sy}*ty`, z: 0 }, normal: { x: 0, y: 1, z: 0 }, name: `Tie-rod row ${sy > 0 ? "+" : "−"}Y` }))[0]);
  /** Revolve a profile about the screw at (sx·B/2, sy·ty): points as (radius, height out of the face) — the face
   *  at `z0`, outwards `o` — with `arc` the index of a point the profile reaches by an arc about `arc.c` instead of a line. */
  const turned = async (comp: string, sx: number, sy: number, z0: string, o: number, name: string, pts: [string, string][], op: "new" | "join" | "cut", when: string, body?: string, arc?: { at: number; c: [string, string] }) => {
    const sk = (await dis(s, "sketch.create", { datum: rows.get(sy), component: comp, name }))[0];
    const at = ([du, dz]: [string, string]): [string, string] => [`${sx}*B/2 + ${sx}*(${du})`, `${z0} + ${o}*(${dz})`];
    const ids: string[] = [];
    for (const q of pts) ids.push(await point(sk, ...at(q)));
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i], b = ids[(i + 1) % ids.length];
      if (arc && (i + 1) % ids.length === arc.at) {
        const c = await point(sk, ...at(arc.c));
        await dis(s, "sketch.addArc", { sketch: sk, center: { ref: c }, start: { ref: a }, end: { ref: b }, ccw: sx * o > 0 });
      } else await dis(s, "sketch.addLine", { sketch: sk, start: { ref: a }, end: { ref: b } });
    }
    const [[x0, y0], [x1, y1]] = [at(["0", "-10"]), at(["0", "10"])];
    const [axis] = await dis(s, "sketch.addLine", { sketch: sk, start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, construction: true });
    const [f] = await dis(s, "feature.revolve", { sketch: sk, axisLine: axis, operation: op, name, ...(body ? { body } : {}) });
    await dis(s, "feature.setCondition", { feature: f, when });
    return f;
  };
  const tieRods = async (end: "back" | "front", bodies: string[], when: string) => {
    const z0 = end === "back" ? "-Lb" : "0", o = end === "back" ? -1 : 1, deep = "-(0.3 + hh)";
    let heads = "";
    for (const [sx, sy] of corners) {
      // the counterbore, its mouth chamfered 45°
      for (const body of bodies) {
        await turned(end === "back" ? housing : body === front ? housing : face, sx, sy, z0, o, `Screw counterbore, ${end}`,
          [["0", "1"], ["cbr + cc + 1", "1"], ["cbr", "-cc"], ["cbr", deep], ["0", deep]], "cut", when, body);
      }
      // the pan head: a short side, then a shallow dome up to the axis
      const h = await turned(screwsC, sx, sy, z0, o, `Screw head, ${end}`,
        [["0", deep], ["sr", deep], ["sr", `${deep} + 0.4*hh`], ["0", "-0.3"]], heads ? "join" : "new", when, heads || undefined, { at: 3, c: ["0", `${deep} + vc`] });
      heads ||= h;
      // the Phillips recess's cone
      await turned(screwsC, sx, sy, z0, o, `Phillips cone, ${end}`, [["0", "1"], ["0.3*sr", "1"], ["0.3*sr", "-0.3"], ["0", "-0.3 - 0.55*hh"]], "cut", when, heads);
    }
    // and its four wings
    for (const [nm, w, h] of [["Phillips recess", "0.62*sr", "0.12*sr"], ["Phillips recess, across", "0.12*sr", "0.62*sr"]]) {
      sk = await sketch(screwsC, "XY", `${nm}, ${end}`);
      for (const [sx, sy] of corners) await rect(sk, `${sx}*B/2 - ${w}`, `${sy}*ty - ${h}`, `${sx}*B/2 + ${w}`, `${sy}*ty + ${h}`);
      await solid(sk, `${nm}, ${end}`, end === "back" ? { from: "-Lb - 1", dist: "1.3 + 0.35*hh", op: "cut", body: heads, when } : { from: "-0.3 - 0.35*hh", dist: "1.3 + 0.35*hh", op: "cut", body: heads, when });
    }
  };
  await tieRods("back", [rearCap], "fst");
  await tieRods("front", [front, faceBody], "fst*thru*tr");
  // the rear bearing in its pocket, its shield ringed between the races, and the bore the shaft's end runs in
  sk = await sketch(housing, "XY", "Bearing pocket");
  await circle(sk, 0, 0, "rbo");
  await solid(sk, "Bearing pocket", { from: "-Lb - 1", dist: "bpd + 1", op: "cut", body: rearCap, when: "fst" });
  sk = await sketch(housing, "XY", "Shaft bore");
  await circle(sk, 0, 0, "r + 0.05");
  await solid(sk, "Shaft bore", { from: "-Lb - 1", dist: "sbd + 1.5", op: "cut", body: rearCap, when: "fst" });
  sk = await sketch(bearingC, "XY", "Rear bearing");
  await circle(sk, 0, 0, "rbo");
  const bearing = await solid(sk, "Rear bearing", { from: "-Lb + 0.4", dist: "bpd - 0.4", when: "fst" });
  sk = await sketch(bearingC, "XY", "Shield");
  await circle(sk, 0, 0, "0.85*rbo");
  await solid(sk, "Shield", { from: "-Lb", dist: "0.65", op: "cut", body: bearing, when: "fst" });
  sk = await sketch(bearingC, "XY", "Inner race");
  await circle(sk, 0, 0, "max(r + 0.8, 0.5*rbo)");
  await solid(sk, "Inner race", { from: "-Lb + 0.4", dist: "0.5", op: "join", body: bearing, when: "fst" });
  sk = await sketch(bearingC, "XY", "Bearing bore");
  await circle(sk, 0, 0, "r + 0.05");
  await solid(sk, "Bearing bore", { from: "-Lb - 1", dist: "bpd + 2", op: "cut", body: bearing, when: "fst" });

  // ---- a hobby servo: the case, its mounting ears and their holes, the boss round the output ----
  sk = await sketch(caseC, "XY", "Case");
  await rect(sk, "-Lc/2", "-Wc/2", "Lc/2", "Wc/2");
  const caseBody = await solid(sk, "Case", { from: "-Lb", dist: "Lb", when: "fh" });
  sk = await sketch(caseC, "XY", "Mounting ears");
  await rect(sk, "-tab/2", "-Wc/2", "tab/2", "Wc/2");
  await solid(sk, "Mounting ears", { from: "-tabTop - tabT", dist: "tabT", op: "join", body: caseBody, when: "fh" });
  sk = await sketch(caseC, "XY", "Ear holes");
  for (const sx of [1, -1]) await circle(sk, `${sx}*hx`, 0, "thr");
  await solid(sk, "Ear holes", { from: "-tabTop - tabT - 1", dist: "tabT + 2", op: "cut", body: caseBody, when: "fh*(1 - two)" });
  sk = await sketch(caseC, "XY", "Ear holes, pairs");
  for (const [sx, sy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) await circle(sk, `${sx}*hx`, `${sy}*hy`, "thr");
  await solid(sk, "Ear holes, pairs", { from: "-tabTop - tabT - 1", dist: "tabT + 2", op: "cut", body: caseBody, when: "fh*two" });
  sk = await sketch(caseC, "XY", "Output boss");
  await circle(sk, "ox", 0, "bd/2");
  await solid(sk, "Output boss", { dist: "bh", op: "join", body: caseBody, when: "fh" });

  // ---- the shaft (drawn about its own axis; the joint puts it at x = ax and turns it) ----
  sk = await sketch(shaftC, "XY", "Shaft");
  await circle(sk, 0, 0, "r");
  const shaftBody = await solid(sk, "Shaft", { from: "zs", dist: "run" });
  // flats: cut across the tip, through the whole width (XZ sketches are drawn in x, z)
  sk = await sketch(shaftC, "XZ", "Flat");
  await rect(sk, "r - fd", "sL - fl", "r + 1", "sL + 1");
  await solid(sk, "Flat", { dist: "shaft_d + 2", symmetric: true, op: "cut", body: shaftBody, when: "flat1" });
  sk = await sketch(shaftC, "XZ", "Second flat");
  await rect(sk, "-r - 1", "sL - fl", "fd - r", "sL + 1");
  await solid(sk, "Second flat", { dist: "shaft_d + 2", symmetric: true, op: "cut", body: shaftBody, when: "flat2" });
  // a keyway, and the key standing proud of it
  sk = await sketch(shaftC, "XZ", "Keyway");
  await rect(sk, "r - t1", "kz", "r + 1", "kz + kl");
  await solid(sk, "Keyway", { dist: "kb", symmetric: true, op: "cut", body: shaftBody, when: "keyed" });
  sk = await sketch(shaftC, "XZ", "Key");
  await rect(sk, "r - t1", "kz", "r - t1 + kh", "kz + kl");
  await solid(sk, "Key", { dist: "kb", symmetric: true, when: "keyed" });
  sk = await sketch(shaftC, "XY", "Rear shaft");
  await circle(sk, 0, 0, "r");
  await solid(sk, "Rear shaft", { from: "-Lb - rear_len", dist: "rear_len + fst*sbd", when: "rear" });
  // a single-shaft stepper still shows the shaft's end, in the rear bearing
  sk = await sketch(shaftC, "XY", "Shaft end");
  await circle(sk, 0, 0, "r");
  await solid(sk, "Shaft end", { from: "-Lb + 0.2", dist: "sbd - 0.2", when: "fst*(1 - rear)" });
  // a servo's horn: a single arm on the spline
  sk = await sketch(hornC, "XY", "Horn hub");
  await circle(sk, 0, 0, "max(1.25*r + 1.5, 3.5)");
  const hub = await solid(sk, "Horn hub", { from: "sL", dist: "0.18*horn_len", when: "fh*horn" });
  sk = await sketch(hornC, "XY", "Horn arm");
  await loop(sk, [[0, "-max(1.25*r + 1.5, 3.5)*0.8"], ["horn_len", "-0.11*horn_len"], ["horn_len", "0.11*horn_len"], [0, "max(1.25*r + 1.5, 3.5)*0.8"]]);
  await solid(sk, "Horn arm", { from: "sL", dist: "0.12*horn_len", op: "join", body: hub, when: "fh*horn" });
  sk = await sketch(hornC, "XY", "Horn tip");
  await circle(sk, "horn_len", 0, "0.11*horn_len");
  await solid(sk, "Horn tip", { from: "sL", dist: "0.12*horn_len", op: "join", body: hub, when: "fh*horn" });

  // ---- the wiring, out of the side (−X, near the back) or the back (−Z, beside a rear shaft) ----
  // side: YZ sketches are drawn in y, z and extrude along +X, so each part starts at its outer end
  sk = await sketch(connC, "YZ", "Socket, side");
  await rect(sk, "-cw/2", "cz - ch/2", "cw/2", "cz + ch/2");
  const sideSocket = await solid(sk, "Socket, side", { from: "-half - cd", dist: "cd", when: "side*conn" });
  sk = await sketch(connC, "YZ", "Socket opening, side"); // where the plug goes in
  await rect(sk, "0.6 - cw/2", "cz - ch/2 + 0.6", "cw/2 - 0.6", "cz + ch/2 - 0.6");
  await solid(sk, "Socket opening, side", { from: "-half - cd - 1", dist: "1 + 0.7*cd", op: "cut", body: sideSocket, when: "side*conn" });
  sk = await sketch(reliefC, "YZ", "Strain relief, side");
  await rect(sk, "-cw/2", "cz - ch/2", "cw/2", "cz + ch/2");
  await solid(sk, "Strain relief, side", { from: "-half - cd", dist: "cd", when: "side*(1 - conn)" });
  sk = await sketch(cable, "YZ", "Cable, side");
  await circle(sk, 0, "cz", "cab/2");
  await solid(sk, "Cable, side", { from: "-half - cd - lead", dist: "lead", when: "side*(1 - conn)" });
  // back: XY sketches extrude along +Z
  sk = await sketch(connC, "XY", "Socket, back");
  await rect(sk, "bx - ch/2", "-cw/2", "bx + ch/2", "cw/2");
  const backSocket = await solid(sk, "Socket, back", { from: "-Lb - cd", dist: "cd", when: "(1 - side)*conn" });
  sk = await sketch(connC, "XY", "Socket opening, back");
  await rect(sk, "bx - ch/2 + 0.6", "0.6 - cw/2", "bx + ch/2 - 0.6", "cw/2 - 0.6");
  await solid(sk, "Socket opening, back", { from: "-Lb - cd - 1", dist: "1 + 0.7*cd", op: "cut", body: backSocket, when: "(1 - side)*conn" });
  sk = await sketch(reliefC, "XY", "Strain relief, back");
  await rect(sk, "bx - ch/2", "-cw/2", "bx + ch/2", "cw/2");
  await solid(sk, "Strain relief, back", { from: "-Lb - cd", dist: "cd", when: "(1 - side)*(1 - conn)" });
  sk = await sketch(cable, "XY", "Cable, back");
  await circle(sk, "bx", 0, "cab/2");
  await solid(sk, "Cable, back", { from: "-Lb - cd - lead", dist: "lead", when: "(1 - side)*(1 - conn)" });

  // the sketches (and the tie-rods' datum planes) only lay out the solids: hide them, so the motor shows clean
  const hid = await s.setVisibility([...Object.keys(s.doc.sketches), ...rows.values()], false);
  if (!hid.ok) throw new Error(hid.error);

  // the shaft turns about Z on its axis
  await dis(s, "joint.create", { kind: "revolute", moved: shaftC, axis: { x: 0, y: 0, z: 1 }, baseOrigin: { x: "ax", y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, value: "angle", name: "Shaft" });

  await describeExample(s, { title: "Motor", description: "A stepper, hobby servo or servo motor at its catalogue size, to design a mount around: pick the frame, then set the length, the shaft and where the wires come out." }, {
    size: { label: "Motor", description: "NEMA stepper frames, hobby servo classes, and servo motors by flange size" },
    length: { label: "Body length", unit: "mm", description: "Behind the mounting face (a servo's case height); starts at the frame's common length" },
    holes: { label: "Mounting holes", description: "Tapped into the front cap (NEMA 8–17), or clear through a flange plate with the body relieved behind for the nuts (NEMA 23 up, servo motors); starts at the frame's usual kind" },
    shaft: { label: "Shaft", description: "A flat or a keyway for a coupling or pulley to grip (a hobby servo always has its spline)" },
    shaft_d: { label: "Shaft diameter", unit: "mm" },
    shaft_len: { label: "Shaft length", unit: "mm", description: "From the mounting face to the tip" },
    ends: { label: "Shaft ends", description: "A double-shaft motor carries a second shaft out of the back, for an encoder or a handwheel" },
    rear_len: { label: "Rear shaft length", unit: "mm" },
    wiring: { label: "Wiring", description: "A bare connector socket, open for its plug, or a cable through a strain relief, modelled for clearance" },
    horn: { label: "Servo horn", description: "A single-arm horn on a hobby servo's spline" },
    angle: { label: "Shaft angle", unit: "°" },
  });
}

const scopeAt = (s: CadSession, set: Record<string, number> = {}) =>
  resolveParameters(s.doc.parameters.map((p) => (p.name in set ? { ...p, expr: String(set[p.name]) } : p))).scope;
const comp = (s: CadSession, name: string) => Object.values(s.doc.components).find((c) => c.name === name)!.id;

/** Bodies built (by name) and their overlaps, at these settings: set as the
 *  sliders set them (so the sketches re-solve, and are checked), on a fork. */
async function evaluateAt(base: CadSession, set: Record<string, number>) {
  const s = await forkSession(base);
  for (const [name, v] of Object.entries(set)) await dis(s, "parameter.set", { name, expression: String(v) });
  await s.recompute();
  for (const sk of Object.values(s.doc.sketches)) expect(sk.status.conflicting, `${JSON.stringify(set)}: sketch ${sk.name}`).toBe(false);
  const scope = scopeAt(s);
  const geo = expandAssembly(s.doc, scope);
  placeComponentSketches(geo, scope);
  const solids = evaluateFeatures(geo, scope);
  placeComponentSketches(s.doc, scope);
  const c = collideFeatures(s.doc, scope);
  return { solids: Object.values(solids).filter((b) => b.mesh), collide: c };
}
const bodyNamed = (b: ReturnType<typeof evaluateAt>["solids"], name: string) => b.find((x) => x.name === name);

describe("Motor", () => {
  let motor: CadSession;
  beforeAll(async () => {
    await initKernel({ wasmBinary: wasm });
    if (BUILD) { motor = realSession(); await buildMotor(motor); }
    else { const doc = deserializeDocument(readFileSync(fileURLToPath(new URL("../public/examples/motor.json", import.meta.url)), "utf8")); rebuild(doc, createDefaultRegistry()); motor = sessionFromDoc(doc); }
    await motor.recompute();
  }, 120000);

  it.runIf(BUILD)("builds the committed example", async () => {
    if (OUT) writeFileSync(`${OUT}/motor.vibecad.json`, serializeDocument(motor.doc));
    expectCommittedExample(motor, "motor");
  });

  it("comes in at each frame's catalogue size: flange, pilot, holes, shaft", () => {
    const rows: string[] = [];
    for (const [i, z] of SIZES.entries()) {
      const sc = scopeAt(motor, { size: i });
      expect(sc.fh, z.name).toBe(z.servo ? 1 : 0);
      expect(sc.length).toBeCloseTo(z.L, 6);
      expect(sc.shaft_d).toBeCloseTo(z.sd, 6);
      expect(sc.shaft_len).toBeCloseTo(z.sl, 6);
      if (!z.servo) {
        // the mounting holes sit inside the flange, clear of its chamfered corners and of the pilot
        const corner = (z.A / 2 - z.c1) * Math.SQRT2 / 2 + z.A / 2 * Math.SQRT2 / 2; // chamfer line's distance from the centre (on the diagonal)
        expect(z.B / 2 * Math.SQRT2 + Math.max(z.hr, clearance(z)), `${z.name}: holes clear the corners`).toBeLessThan(corner);
        expect(z.B / 2 * Math.SQRT2 - Math.max(z.hr, clearance(z)), `${z.name}: holes clear the pilot`).toBeGreaterThan(z.D / 2);
        expect(z.sd, `${z.name}: shaft inside the pilot`).toBeLessThan(z.D);
        if (isStepper(z)) {
          // the through-bolts' heads inside the rear cap's corners, the bearing inside them
          const sc = scopeAt(motor, { size: i });
          expect(z.B / Math.SQRT2 + sc.sr, `${z.name}: screw heads inside the corners`).toBeLessThan((z.A2 - z.c1) / Math.SQRT2);
          expect(sc.rbo, `${z.name}: bearing round the shaft`).toBeGreaterThan(sc.r + 1);
          expect(sc.rbo, `${z.name}: bearing clear of the screws`).toBeLessThan(z.B / Math.SQRT2 - sc.cbr);
          expect(sc.holes, `${z.name}: its usual holes`).toBe(z.A < 50 ? 0 : 1);
        }
        {
          // through a plate: the relief's line clear of the pilot, the holes and a nut on them clear of it
          const sc = scopeAt(motor, { size: i, holes: 1 });
          expect(sc.dl, z.name).toBeGreaterThan(z.D / 2);
          expect(z.B / Math.SQRT2 - sc.dl, z.name).toBeGreaterThan(sc.hcl);
          expect(sc.ft + 0.01, `${z.name}: plate deep enough for the tie-rods' heads`).toBeGreaterThan(sc.fst * (sc.hh + 0.3));
        }
        // the socket fits the rear cap's side, and on its back beside a rear shaft
        expect(z.ch, z.name).toBeLessThan(z.capR);
        expect(z.cw, z.name).toBeLessThan(z.A2 - 2 * z.c1);
        expect(-(z.A2 / 2) + 1.5 + z.ch + 0.5, `${z.name}: back socket clears the rear shaft`).toBeLessThan(-z.sd / 2);
      } else {
        // ear holes beyond the case and inside the ear; the boss on the case top; the horn clear of the boss
        expect(z.hx - z.thr, z.name).toBeGreaterThan(z.Lc / 2);
        expect(z.hx + z.thr, z.name).toBeLessThan(z.tab / 2);
        expect(z.ox + z.bd / 2, z.name).toBeLessThanOrEqual(z.Lc / 2 + 0.01);
        expect(z.sd, z.name).toBeLessThan(z.bd);
      }
      rows.push(`${z.name}: ${z.servo ? `${z.Lc}×${z.Wc}×${z.L} case, ears ${z.tab}` : `${z.A} flange, holes ${z.B} sq, pilot ${z.D}`}, shaft ${z.sd}×${z.sl}`);
    }
    console.log(rows.join("\n"));
  });

  it("puts each frame's pilot at its standard size", () => {
    const pilots: Record<string, [number, number]> = {
      "NEMA 8 stepper (20 mm)": [15, 1.5], "NEMA 11 stepper (28 mm)": [22, 2], "NEMA 14 stepper (35 mm)": [22, 2],
      "NEMA 17 stepper (42 mm)": [22, 2], "NEMA 23 stepper (57 mm)": [38.1, 1.6], "NEMA 24 stepper (60 mm)": [38.1, 1.6],
      "NEMA 34 stepper (86 mm)": [73, 1.6], "NEMA 42 stepper (110 mm)": [55.52, 1.6],
      "Servo motor, 40 mm flange": [30, 3], "Servo motor, 60 mm flange": [50, 3], "Servo motor, 80 mm flange": [70, 3],
      "Servo motor, 110 mm flange": [95, 5], "Servo motor, 130 mm flange": [110, 5],
    };
    for (const [i, z] of SIZES.entries()) {
      if (z.servo) continue;
      const sc = scopeAt(motor, { size: i });
      expect([sc.D, sc.P], z.name).toEqual(pilots[z.name]);
    }
  });

  it("sizes the key by ISO 6885 for the shaft", () => {
    for (const [d, b, h, t] of [[6, 2, 2, 1.2], [8, 3, 3, 1.8], [10, 4, 4, 2.5], [14, 5, 5, 3], [19, 6, 6, 3.5], [22, 8, 7, 4]]) {
      const sc = scopeAt(motor, { shaft_d: d });
      expect([sc.kb, sc.kh, sc.t1].map((v) => +v.toFixed(3)), `Ø${d}`).toEqual([b, h, t]);
    }
  });

  it("turns the shaft about its axis, at the servo's output off-centre", () => {
    for (const size of [DEFAULT_SIZE, 10]) {
      for (const angle of [0, 90, 200]) {
        const W = resolveComponentWorld(motor.doc, scopeAt(motor, { size, angle })).get(comp(motor, "Shaft"))!;
        const sc = scopeAt(motor, { size });
        const c = applyPoint(W, { x: 0, y: 0, z: 5 }), e = applyPoint(W, { x: 1, y: 0, z: 5 });
        expect(c.x).toBeCloseTo(sc.ax, 6);
        expect(c.y).toBeCloseTo(0, 6);
        expect(c.z).toBeCloseTo(5, 6);
        expect(((Math.atan2(e.y - c.y, e.x - c.x) * 180) / Math.PI + 360) % 360).toBeCloseTo(angle % 360, 4);
      }
      // the horn rides on the shaft
      const H = resolveComponentWorld(motor.doc, scopeAt(motor, { size, angle: 90 })).get(comp(motor, "Horn"))!;
      expect(applyPoint(H, { x: 1, y: 0, z: 0 }).y).toBeCloseTo(1, 6);
    }
  });

  // every size, as it comes, with its connector or cable each way: built, clear of itself
  const sizes = SIZES.map((_, i) => i);
  for (const i of sizes) {
    it(`builds ${SIZES[i].name}, every wiring, every shaft, nothing overlapping`, async () => {
      const other = SIZES[i].servo ? 0 : 1 - nativeThrough(SIZES[i]); // the other kind of mounting hole
      const configs: Record<string, number>[] = [{ size: i, wiring: 0, shaft: 1 }, { size: i, wiring: 2, shaft: 3, ends: 1, holes: other }];
      if (FULL || i === DEFAULT_SIZE || i === 10) configs.push({ size: i, wiring: 1, shaft: 2, ends: 1 }, { size: i, wiring: 3, shaft: 0, ends: 1 }, { size: i, wiring: 3, shaft: 3, angle: 135 });
      for (const set of configs) {
        const { solids, collide } = await evaluateAt(motor, set);
        const at = JSON.stringify(set);
        for (const b of solids) expect(b.error, `${at} ${b.name}`).toBeUndefined();
        expect(collide.buildError, at).toBeUndefined();
        expect(collide.maxOverlap, `${at}: ${JSON.stringify(collide.overlaps)}`).toBeLessThan(0.01);
        const names = solids.map((b) => b.name);
        const servo = SIZES[i].servo;
        expect(names, at).toContain(servo ? "Case" : "Flange");
        expect(Object.keys(motor.doc.planes).every((id) => motor.doc.hidden?.includes(id)), "datum planes hidden").toBe(true);
        expect(names, at).toContain("Shaft");
        expect(names.includes("Rear shaft"), at).toBe(!servo && !!set.ends);
        const stepper = isStepper(SIZES[i]);
        expect(names.includes("Shaft end"), at).toBe(stepper && !set.ends);
        const thru = !servo && (set.holes ?? nativeThrough(SIZES[i])) === 1;
        expect(names.includes("Screw head, back"), at).toBe(stepper);
        expect(names.includes("Screw head, front"), at).toBe(thru && !!tieRodRoom(SIZES[i]));
        expect(names.includes("Rear bearing"), at).toBe(stepper);
        expect(names.includes("Key"), at).toBe(!servo && set.shaft === 3);
        expect(names.includes("Horn hub"), at).toBe(servo);
        const side = set.wiring === 0 || set.wiring === 2, conn = set.wiring < 2;
        expect(names.includes(side ? "Cable, side" : "Cable, back"), at).toBe(!conn);
        expect(names.includes(side ? (conn ? "Socket, side" : "Strain relief, side") : (conn ? "Socket, back" : "Strain relief, back")), at).toBe(true);
        // a connector is the bare socket: no plug in it, no cable off it
        expect(names.filter((n) => n.startsWith("Plug") || (conn && n.startsWith("Cable"))), at).toEqual([]);
      }
    }, 120000);
  }

  it("cuts the flats and the keyway it says, to their depth", async () => {
    const sd = SIZES[DEFAULT_SIZE].sd;
    const shaftOf = async (shaft: number) => bodyNamed((await evaluateAt(motor, { size: DEFAULT_SIZE, shaft })).solids, "Shaft")!;
    // (by volume: a body's bounds are the B-rep's, loose round a cylinder)
    const r = sd / 2, h = 0.1 * sd, run = SIZES[DEFAULT_SIZE].sl - SIZES[DEFAULT_SIZE].P, fl = 0.75 * run;
    const segment = r * r * Math.acos((r - h) / r) - (r - h) * Math.sqrt(2 * r * h - h * h); // the flat's cross-section
    const round = (await shaftOf(0)).volume!;
    expect(round).toBeCloseTo(Math.PI * r * r * run, 0);
    expect(round - (await shaftOf(1)).volume!).toBeCloseTo(segment * fl, 1); // a D: 4.5 across the flat on a 5 mm shaft
    expect(round - (await shaftOf(2)).volume!).toBeCloseTo(2 * segment * fl, 1);
    const kl = 0.7 * run, t1 = 1.2, kb = 2; // ISO 6885 for Ø5 (b capped at 0.4 d)
    const keyway = round - (await shaftOf(3)).volume!;
    expect(keyway).toBeGreaterThan(kb * (t1 - (r - Math.sqrt(r * r - 1))) * kl); // at least the slot below the chord
    expect(keyway).toBeLessThan(kb * t1 * kl);
    const key = bodyNamed((await evaluateAt(motor, { size: DEFAULT_SIZE, shaft: 3 })).solids, "Key")!.bounds!;
    expect(key.max.x).toBeCloseTo(sd / 2 - 1.2 + 2, 2); // proud of the shaft by kh − t1
  }, 60000);

  it("taps the holes, or puts them through a flange plate with the body relieved behind", async () => {
    for (const size of [DEFAULT_SIZE, 4]) {
      const vol = async (holes: number) => {
        const { solids, collide } = await evaluateAt(motor, { size, holes });
        expect(collide.maxOverlap).toBeLessThan(0.01);
        return { flange: bodyNamed(solids, "Flange")!.volume!, stator: bodyNamed(solids, "Stator")!.volume!, front: bodyNamed(solids, "Screw head, front") };
      };
      const tapped = await vol(0), through = await vol(1);
      expect(through.stator, SIZES[size].name).toBeLessThan(tapped.stator * 0.95); // the corners relieved
      expect(through.flange).toBeLessThan(tapped.flange);
      expect(tapped.front).toBeUndefined();
      expect(through.front!.bounds!.max.z).toBeLessThan(0); // the tie-rods' heads below the mounting face
    }
    // the tapped holes carry their thread
    const tapped = Object.values(motor.doc.features).filter((f) => f.kind === "hole");
    expect(tapped.map((f) => f.name)).toEqual(SIZES.filter((z) => !z.servo).map((z) => `Tapped holes, M${thread(z)}`));
  }, 60000);

  it("follows the length and the shaft sliders", async () => {
    const { solids } = await evaluateAt(motor, { length: 70, shaft_d: 6.35, shaft_len: 30 });
    const rear = bodyNamed(solids, "Rear cap")!.bounds!, shaft = bodyNamed(solids, "Shaft")!.bounds!;
    expect(rear.min.z).toBeCloseTo(-70, 3);
    // the tie-rods' pan heads: their domes 0.3 under the back face, the underside a head's height in
    const heads = bodyNamed(solids, "Screw head, back")!, sc = scopeAt(motor, { length: 70 });
    expect(heads.bounds!.min.z).toBeGreaterThan(-70 + 0.3 - 0.01); // (the Phillips cone takes the dome's crown)
    expect(heads.bounds!.min.z).toBeLessThan(-70 + 0.3 + 0.15);
    expect(heads.bounds!.max.z).toBeCloseTo(-70 + 0.3 + sc.hh, 1);
    const flat = 4 * Math.PI * sc.sr ** 2 * sc.hh; // a flat-topped head
    expect(heads.volume!).toBeLessThan(flat * 0.95);   // domed, and the recess cut
    expect(heads.volume!).toBeGreaterThan(flat * 0.6);
    expect(shaft.max.z).toBeCloseTo(30, 3);
    expect(shaft.max.y - shaft.min.y).toBeCloseTo(6.35, 2);
  }, 60000);
});
