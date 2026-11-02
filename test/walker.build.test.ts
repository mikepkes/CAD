// End-to-end: a wind-walker in the spirit of Theo Jansen's beach animals. One crank
// turns a six-throw crankshaft; each throw drives a mirrored pair of Jansen legs
// (eleven bars each, on Jansen's proportions: crank, two links to the crank pin, a
// rocker and a rigid triangle on the fixed pivot, a link and the rigid foot
// triangle), so twelve legs walk with their phases 60° apart and their motions
// overlapping: at any moment some feet are on the ground, gliding along a flat
// stroke, while the rest lift and swing forward.
//
// The linkage is solved in the parameters: for each leg its joint positions are
// hidden parameters (circle-circle intersections of the bars around each loop,
// from the crank angle `t`), and every bar is a component on a revolute joint
// placed at its pivot and turned to the angle between its two pins. Drag `t` and
// everything follows; drag `s` and the whole walker scales.
//
// Built to go together as a real one does: in each throw the bars are stacked so
// the parts on every pin sit on adjacent layers, 1 mm apart, and every joint has a
// pin through it — the crank pin, a stub from a bulkhead at the fixed pivot, and at
// each moving joint a boss on one part through holes in the others (each part's
// bosses on one face, to print flat). The crankshaft is webs and a crank pin per
// throw with journals only between throws (the crank-pin bars sweep right through
// the shaft's axis), and bulkheads between the throws carry the journals.
//   BUILD_WALKER=/abs/out npx vitest run test/walker.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, sessionFromDoc, FULL, itFull, expectCommittedExample } from "./helpers";
import { rebuild } from "../src/core/build";
import { createDefaultRegistry } from "../src/core/command/builtins";
import { initKernel } from "../src/core/occ/kernel";
import { serializeDocument, deserializeDocument } from "../src/core/persistence";
import { collideFeatures, evaluateFeatures } from "../src/core/features";
import { placeComponentSketches } from "../src/core/recompute";
import { resolveParameters } from "../src/core/parameters";
import type { CadSession } from "../src/core/command/session";
import type { SolidEval } from "../src/core/features";

const OUT = process.env.BUILD_WALKER || "";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

// Jansen's proportions (his "holy numbers"); multiplied by the size `s` (mm per unit)
const J = { a: 38, b: 41.5, c: 39.3, d: 40.1, e: 55.8, f: 39.4, g: 36.7, h: 65.7, i: 49, j: 50, k: 61.9, l: 7.8, m: 15 };
// the rigid triangles in their own frames: B→C along x with E off it; D→F along x with the foot G off it
const E_LOCAL = { x: (J.b ** 2 + J.d ** 2 - J.e ** 2) / (2 * J.b), y: 0 };
E_LOCAL.y = Math.sqrt(J.d ** 2 - E_LOCAL.x ** 2);
const G_LOCAL = { x: (J.g ** 2 + J.i ** 2 - J.h ** 2) / (2 * J.g), y: 0 };
G_LOCAL.y = Math.sqrt(J.i ** 2 - G_LOCAL.x ** 2);

const PHASES = [0, 120, 240, 60, 180, 300];  // six throws: 60° apart, alternating so neighbours differ by 120°
const W = 8, T = 4, PITCH = 5, GAP = 8;      // bar width and thickness, layer pitch, bulkhead bay (mm)
const LAYERS = 8;                            // per throw: web, the two legs' six layers, web
const BLOCK = GAP + LAYERS * PITCH;
// Each leg's parts, layer by layer, so the parts on every moving pin sit on adjacent layers: C (upper
// link, triangle) on 1–2, E (triangle, knee link) on 2–3, F (knee link, foot) on 3–4, D (rocker, foot,
// lower link) on 3–5; the fixed pivot B's stub reaches 2–3 from the bulkhead. The rocker and the knee
// link share a layer (their edges never come within 18 mm). The mirrored twin takes the same stack
// turned over (layer 7 − n), so the two legs interleave on layers 1–6: no two of the four links on the
// shared crank pin share a layer, and every other pair that does stays 39 mm or more apart.
type Part = "Upper link" | "Upper triangle" | "Rocker" | "Knee link" | "Foot" | "Lower link";
const LAYER: Record<Part, number> = { "Upper link": 1, "Upper triangle": 2, Rocker: 3, "Knee link": 3, Foot: 4, "Lower link": 5 };
const layerOf = (part: Part, mirror: boolean) => (mirror ? LAYERS - 1 - LAYER[part] : LAYER[part]);
const HOLE = 2.3, PIN = 2, AXLE = 4;
const TOP = 44;                              // frame rails above everything that moves (units of s)

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const n = (v: number) => String(r4(v));

/** Expressions for the intersection of circles (P1, r1) and (P2, r2), on side `sign` of P1→P2. */
function meet(p1: [string, string], r1: string, p2: [string, string], r2: string, sign: 1 | -1): [string, string] {
  const dx = `(${p2[0]}-${p1[0]})`, dz = `(${p2[1]}-${p1[1]})`, D = `sqrt(${dx}^2+${dz}^2)`;
  const a = `((${r1})^2-(${r2})^2+${D}^2)/(2*${D})`, h = `sqrt(max(0,(${r1})^2-(${a})^2))`;
  return [`${p1[0]}+${a}*${dx}/${D}${sign > 0 ? "-" : "+"}${h}*${dz}/${D}`, `${p1[1]}+${a}*${dz}/${D}${sign > 0 ? "+" : "-"}${h}*${dx}/${D}`];
}

/** A pin standing off one face of a part, at its corner `at`: `dir` +1 along +Y from the part's back
 *  face, −1 along −Y from its front face; `len` from that face (so it runs through the part first). */
type Boss = { at: number; dir: 1 | -1; len: number };

/** The boss: a PIN-radius cylinder at the pin centre `c`, joined to the part's body. */
async function boss(s: CadSession, comp: string, body: string, c: { x: string; y: string }, b: Boss, name: string) {
  const sk = (await dis(s, "sketch.create", { plane: "XZ", offset: b.dir > 0 ? 0 : -T, component: comp, name }))[0];
  const p = (await dis(s, "sketch.addPoint", { sketch: sk, x: c.x, y: c.y }))[0];
  await dis(s, "sketch.addCircle", { sketch: sk, center: { ref: p }, radius: PIN });
  await dis(s, "feature.extrude", { sketch: sk, distance: n(b.len), ...(b.dir > 0 ? { direction: "reverse" } : {}), operation: "join", body, name });
}

/** A flat bar from its pivot (local origin) along +x for `len` (expression), rounded ends, a pin
 *  hole at each end but the one (0 or 1) carrying a boss. */
async function bar(s: CadSession, comp: string, len: string, name: string, pin?: Boss) {
  const sk = (await dis(s, "sketch.create", { plane: "XZ", component: comp, name }))[0];
  const p = async (x: string, y: number) => (await dis(s, "sketch.addPoint", { sketch: sk, x, y: n(y) }))[0];
  const a0 = await p("0", -W / 2), a1 = await p(len, -W / 2), b1 = await p(len, W / 2), b0 = await p("0", W / 2);
  const c0 = await p("0", 0), c1 = await p(len, 0);
  await dis(s, "sketch.addLine", { sketch: sk, start: { ref: a0 }, end: { ref: a1 } });
  await dis(s, "sketch.addArc", { sketch: sk, center: { ref: c1 }, start: { ref: a1 }, end: { ref: b1 }, ccw: true });
  await dis(s, "sketch.addLine", { sketch: sk, start: { ref: b1 }, end: { ref: b0 } });
  await dis(s, "sketch.addArc", { sketch: sk, center: { ref: c0 }, start: { ref: b0 }, end: { ref: a0 }, ccw: true });
  for (const [k, c] of [c0, c1].entries()) if (pin?.at !== k) await dis(s, "sketch.addCircle", { sketch: sk, center: { ref: c }, radius: HOLE });
  const body = (await dis(s, "feature.extrude", { sketch: sk, distance: String(T), direction: "reverse", name }))[0];
  if (pin) await boss(s, comp, body, { x: pin.at ? len : "0", y: "0" }, pin, `${name} pin`);
}

/** A rigid triangle plate with rounded corners: pins at the local origin, along +x at `x1` (units of
 *  the linkage, scaled by `s`) and at (x2, y2), its outline offset W/2 out from the pin centres all
 *  round so each pin hole sits inside the plate; a hole at each corner in `holes`, a boss at `pin`'s. */
async function plate(s: CadSession, comp: string, x1: number, x2: number, y2: number, name: string, holes: number[], pin?: Boss) {
  const sk = (await dis(s, "sketch.create", { plane: "XZ", component: comp, name }))[0];
  const V = [[0, 0], [x1, 0], [x2, y2]];
  const ccw = y2 > 0;                       // the mirrored twin's triangle winds the other way
  const r = W / 2;
  // each edge's outward normal (scale doesn't change it)
  const out = V.map((a, k) => {
    const b = V[(k + 1) % 3], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
    return ccw ? [dy / l, -dx / l] : [-dy / l, dx / l];
  });
  const pt = (k: number, o: number[]) => dis(s, "sketch.addPoint", { sketch: sk, x: `${n(V[k][0])}*s+${n(r * o[0])}`, y: `${n(V[k][1])}*s+${n(r * o[1])}` }).then((q) => q[0]);
  const centres: string[] = [];
  for (const [x, y] of V) centres.push((await dis(s, "sketch.addPoint", { sketch: sk, x: `${n(x)}*s`, y: `${n(y)}*s` }))[0]);
  // edge k runs from vertex k to k+1, offset out; the corner at vertex k+1 is an arc round it
  const starts: string[] = [], ends: string[] = [];
  for (let k = 0; k < 3; k++) { starts.push(await pt(k, out[k])); ends.push(await pt((k + 1) % 3, out[k])); }
  for (let k = 0; k < 3; k++) {
    await dis(s, "sketch.addLine", { sketch: sk, start: { ref: starts[k] }, end: { ref: ends[k] } });
    await dis(s, "sketch.addArc", { sketch: sk, center: { ref: centres[(k + 1) % 3] }, start: { ref: ends[k] }, end: { ref: starts[(k + 1) % 3] }, ccw });
  }
  for (const k of holes) await dis(s, "sketch.addCircle", { sketch: sk, center: { ref: centres[k] }, radius: HOLE });
  const body = (await dis(s, "feature.extrude", { sketch: sk, distance: String(T), direction: "reverse", name }))[0];
  if (pin) await boss(s, comp, body, { x: `${n(V[pin.at][0])}*s`, y: `${n(V[pin.at][1])}*s` }, pin, `${name} pin`);
}

export async function buildWalker(s: CadSession): Promise<{ legs: string[] }> {
  await dis(s, "parameter.add", { name: "t", expression: "0", min: 0, max: 360, step: 1 });
  await dis(s, "parameter.add", { name: "s", expression: "2", min: 1.5, max: 3, step: 0.1 });
  const S = (u: number) => `${n(u)}*s`;

  const mat = async (name: string, p: Record<string, unknown>) => (await dis(s, "material.create", { name, ...p }))[0];
  const frameMat = await mat("Black anodised", { kind: "metal", finish: "satin", color: "#34363b", roughness: 0.36 });
  const steel = await mat("Brushed steel", { kind: "metal", finish: "brushed", color: "#c9cdd2", textureAxis: "y" });
  const legMat = await mat("PLA, ivory", { kind: "printed", finish: "satin", color: "#efe6cf", layerHeight: 0.2, printAxis: "y" });

  // ---- the linkage, solved in hidden parameters: one set per leg ----
  // a leg's crank angle; its mirror twin (the leg facing the other way on the same crank pin)
  // is the same leg at 180° − angle, reflected in x
  type Leg = { key: string; mirror: boolean; throw: number };
  const legs: Leg[] = [];
  for (let k = 0; k < PHASES.length; k++) for (const mirror of [false, true]) legs.push({ key: `w${k}${mirror ? "m" : ""}`, mirror, throw: k });
  const hidden = (name: string, expression: string) => dis(s, "parameter.add", { name, expression, hidden: true });
  for (const L of legs) {
    const ang = L.mirror ? `(180-(t+${PHASES[L.throw]}))` : `(t+${PHASES[L.throw]})`;
    const P = (q: string): [string, string] => [`${L.key}${q}x`, `${L.key}${q}z`];
    const B: [string, string] = [`(-${S(J.a)})`, `(-${S(J.l)})`];
    await hidden(P("A")[0], `${S(J.m)}*cos(rad(${ang}))`);
    await hidden(P("A")[1], `${S(J.m)}*sin(rad(${ang}))`);
    const set = async (q: string, v: [string, string]) => { await hidden(P(q)[0], v[0]); await hidden(P(q)[1], v[1]); };
    await set("C", meet(P("A"), S(J.j), B, S(J.b), -1));
    await set("D", meet(P("A"), S(J.k), B, S(J.c), 1));
    await set("E", meet(B, S(J.d), P("C"), S(J.e), 1));
    await set("F", meet(P("E"), S(J.f), P("D"), S(J.g), -1));
  }

  // ---- the legs: every bar a component on a revolute joint at its pivot, turned to its pins' angle ----
  const layerY = (k: number, layer: number) => k * BLOCK + GAP + layer * PITCH;
  const down = { x: 0, y: -1, z: 0 };  // rotation about −Y turns +x toward +z
  const legComps: string[] = [];
  for (const L of legs) {
    const P = (q: string): [string, string] => [`${L.key}${q}x`, `${L.key}${q}z`];
    const B: [string, string] = [`(-${S(J.a)})`, `(-${S(J.l)})`];
    const place = async (name: string, layer: number, from: [string, string], to: [string, string], build: (c: string) => Promise<void>) => {
      const c = (await dis(s, "component.create", { name: `${name} ${L.key}` }))[0];
      await build(c);
      await dis(s, "material.assign", { component: c, material: legMat });
      const angle = `deg(atan2(${to[1]}-${from[1]}, ${to[0]}-${from[0]}))`;
      await dis(s, "joint.create", {
        kind: "revolute", moved: c, axis: down,
        baseOrigin: { x: L.mirror ? `-(${from[0]})` : from[0], y: n(layerY(L.throw, layer)), z: from[1] },
        movedOrigin: { x: 0, y: 0, z: 0 },
        value: L.mirror ? `180-${angle}` : angle,
        name: `${name} ${L.key}`,
      });
      legComps.push(c);
    };
    const sgn = L.mirror ? -1 : 1;   // a mirrored part's frame is reflected: its off-axis points swap sides
    const lay = (part: Part) => layerOf(part, L.mirror);
    // a boss on `carrier` at its corner `at`, reaching through the parts on `others` to 0.5 mm past the last
    const pin = (carrier: Part, at: number, ...others: Part[]): Boss => {
      const span = Math.max(...others.map((o) => Math.abs(lay(o) - lay(carrier))));
      return { at, dir: lay(others[0]) > lay(carrier) ? 1 : -1, len: span * PITCH + T + 0.5 };
    };
    await place("Rocker", lay("Rocker"), B, P("D"), (c) => bar(s, c, S(J.c), "Rocker", pin("Rocker", 1, "Foot", "Lower link")));
    await place("Upper triangle", lay("Upper triangle"), B, P("C"), (c) => plate(s, c, J.b, E_LOCAL.x, sgn * E_LOCAL.y, "Upper triangle", [0, 1, 2]));
    await place("Upper link", lay("Upper link"), P("A"), P("C"), (c) => bar(s, c, S(J.j), "Upper link", pin("Upper link", 1, "Upper triangle")));
    await place("Lower link", lay("Lower link"), P("A"), P("D"), (c) => bar(s, c, S(J.k), "Lower link"));
    await place("Knee link", lay("Knee link"), P("E"), P("F"), (c) => bar(s, c, S(J.f), "Knee link", pin("Knee link", 0, "Upper triangle")));
    await place("Foot", lay("Foot"), P("D"), P("F"), (c) => plate(s, c, J.g, G_LOCAL.x, sgn * G_LOCAL.y, "Foot", [0], pin("Foot", 1, "Knee link")));
  }

  // ---- the crankshaft: per throw two webs and a crank pin; journals in the bays between throws ----
  const crank = (await dis(s, "component.create", { name: "Crankshaft" }))[0];
  await dis(s, "material.assign", { component: crank, material: steel });
  let first = "";
  const join = async (sk: string, dist: number, name: string) => {
    const f = (await dis(s, "feature.extrude", { sketch: sk, distance: String(dist), direction: "reverse", ...(first ? { operation: "join", body: first } : {}), name }))[0];
    if (!first) first = f;
  };
  const xz = (y: number, name: string, comp = crank) => dis(s, "sketch.create", { plane: "XZ", offset: -y, component: comp, name }).then((r) => r[0]);
  const circleAt = async (sk: string, x: string, z: string, r: number) => {
    const c = (await dis(s, "sketch.addPoint", { sketch: sk, x, y: z }))[0];
    await dis(s, "sketch.addCircle", { sketch: sk, center: { ref: c }, radius: r });
  };
  for (let k = 0; k < PHASES.length; k++) {
    const ph = (PHASES[k] * Math.PI) / 180;
    const ax = `${n(J.m * Math.cos(ph))}*s`, az = `${n(J.m * Math.sin(ph))}*s`;
    // the journal through this throw's bulkhead, from the last throw's outer web
    const jy = k === 0 ? 0 : layerY(k - 1, LAYERS - 1) + T;
    const jsk = await xz(jy, `Journal ${k + 1}`);
    await circleAt(jsk, "0", "0", AXLE);
    await join(jsk, layerY(k, 0) - jy + 0.01, `Journal ${k + 1}`);
    for (const layer of [0, LAYERS - 1]) {
      const wsk = await xz(layerY(k, layer), `Web ${k + 1}`);
      // a web: a bar from the shaft to the crank pin, as a stadium
      const pts: string[] = [];
      const nx = -Math.sin(ph), nz = Math.cos(ph), hw = AXLE + 2;
      for (const [x, z] of [[`${n(-nx * hw)}`, `${n(-nz * hw)}`], [`${ax}+${n(-nx * hw)}`, `${az}+${n(-nz * hw)}`], [`${ax}+${n(nx * hw)}`, `${az}+${n(nz * hw)}`], [`${n(nx * hw)}`, `${n(nz * hw)}`]]) {
        pts.push((await dis(s, "sketch.addPoint", { sketch: wsk, x, y: z }))[0]);
      }
      const c0 = (await dis(s, "sketch.addPoint", { sketch: wsk, x: "0", y: "0" }))[0];
      const c1 = (await dis(s, "sketch.addPoint", { sketch: wsk, x: ax, y: az }))[0];
      await dis(s, "sketch.addLine", { sketch: wsk, start: { ref: pts[0] }, end: { ref: pts[1] } });
      await dis(s, "sketch.addArc", { sketch: wsk, center: { ref: c1 }, start: { ref: pts[1] }, end: { ref: pts[2] }, ccw: true });
      await dis(s, "sketch.addLine", { sketch: wsk, start: { ref: pts[2] }, end: { ref: pts[3] } });
      await dis(s, "sketch.addArc", { sketch: wsk, center: { ref: c0 }, start: { ref: pts[3] }, end: { ref: pts[0] }, ccw: true });
      await join(wsk, T, `Web ${k + 1}`);
    }
    const psk = await xz(layerY(k, 0) + T - 0.01, `Crank pin ${k + 1}`);
    await circleAt(psk, ax, az, PIN);
    await join(psk, (LAYERS - 2) * PITCH + 1.02, `Crank pin ${k + 1}`);
  }
  {
    const end = layerY(PHASES.length - 1, LAYERS - 1) + T;
    const jsk = await xz(end, "Journal, end");
    await circleAt(jsk, "0", "0", AXLE);
    await join(jsk, GAP, "Journal, end");
  }
  await dis(s, "joint.create", { kind: "revolute", moved: crank, axis: down, baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, value: "t", name: "Crank" });

  // ---- the frame: a bulkhead in each bay, pivot stubs into the next throw, rails over the top ----
  const frame = (await dis(s, "component.create", { name: "Frame" }))[0];
  await dis(s, "material.assign", { component: frame, material: frameMat });
  let fbody = "";
  const fjoin = async (sk: string, dist: number, name: string) => {
    const f = (await dis(s, "feature.extrude", { sketch: sk, distance: String(dist), direction: "reverse", ...(fbody ? { operation: "join", body: fbody } : {}), name }))[0];
    if (!fbody) fbody = f;
  };
  const halfX = `${n(J.a + 6)}*s+${W}`, low = `-${n(J.l + 4)}*s-${W}`, top = `${n(TOP)}*s`;
  for (let k = 0; k <= PHASES.length; k++) {
    const y0 = k === 0 ? 0 : layerY(k - 1, LAYERS - 1) + T + 1;
    const sk = await xz(y0, `Bulkhead ${k + 1}`, frame);
    const corner: string[] = [];
    for (const [x, z] of [[`-(${halfX})`, low], [halfX, low], [halfX, `${top}+${W}`], [`-(${halfX})`, `${top}+${W}`]]) corner.push((await dis(s, "sketch.addPoint", { sketch: sk, x, y: z }))[0]);
    for (let q = 0; q < 4; q++) await dis(s, "sketch.addLine", { sketch: sk, start: { ref: corner[q] }, end: { ref: corner[(q + 1) % 4] } });
    await circleAt(sk, "0", "0", AXLE + 0.4);   // the journal's bearing
    await fjoin(sk, GAP - 2, `Bulkhead ${k + 1}`);
    // stubs for the fixed pivots on either side: through the web's layer and on through the rocker and
    // the triangle on B, to 0.5 mm past the further — the leg's from this bulkhead into the next throw,
    // its mirrored twin's from the next bulkhead back into the last
    if (k < PHASES.length) {
      const ssk = await xz(y0 + GAP - 2 - 0.01, `Pivot ${k + 1}`, frame);
      await circleAt(ssk, `-${S(J.a)}`, `-${S(J.l)}`, PIN);
      const far = Math.max(layerOf("Rocker", false), layerOf("Upper triangle", false));
      await fjoin(ssk, layerY(k, far) + T + 0.5 - (y0 + GAP - 2), `Pivot ${k + 1}`);
    }
    if (k > 0) {
      const ssk = await xz(y0 + 0.01, `Pivot ${k}, mirrored`, frame);
      await circleAt(ssk, S(J.a), `-${S(J.l)}`, PIN);
      const far = Math.min(layerOf("Rocker", true), layerOf("Upper triangle", true));
      await dis(s, "feature.extrude", { sketch: ssk, distance: n(y0 + 0.01 - (layerY(k - 1, far) - 0.5)), operation: "join", body: fbody, name: `Pivot ${k}, mirrored` });
    }
  }
  // two rails along the top, tying the bulkheads together
  const width = layerY(PHASES.length - 1, LAYERS - 1) + T + GAP;
  for (const sx of [-1, 1]) {
    // YZ planes: u is y, v is z, the normal +X (so each rail is drawn on its inner face's plane and extruded outward)
    const rp = (await dis(s, "plane.create", { base: "YZ", offset: sx < 0 ? `-(${halfX})` : `${halfX}-${W}`, name: "Rail plane" }))[0];
    const sk = (await dis(s, "sketch.create", { datum: rp, component: frame, name: "Rail" }))[0];
    const c2: string[] = [];
    for (const [y, z] of [["0", top], [String(width), top], [String(width), `${top}+${W}`], ["0", `${top}+${W}`]]) c2.push((await dis(s, "sketch.addPoint", { sketch: sk, x: y, y: z }))[0]);
    for (let q = 0; q < 4; q++) await dis(s, "sketch.addLine", { sketch: sk, start: { ref: c2[q] }, end: { ref: c2[(q + 1) % 4] } });
    await dis(s, "feature.extrude", { sketch: sk, distance: String(W), operation: "join", body: fbody, name: "Rail" });
  }
  return { legs: legComps };
}

/** The walker posed at crank angle `t`: each leg's world foot point (the triangle's far corner), from the solved parameters. */
function feet(s: CadSession, t: number): { x: number; z: number }[] {
  const params = s.doc.parameters.map((p) => (p.name === "t" ? { ...p, expr: String(t) } : p));
  const sc = resolveParameters(params).scope;
  const out: { x: number; z: number }[] = [];
  for (const key of Object.keys(sc).filter((k) => /^w\dm?Dx$/.test(k)).map((k) => k.slice(0, -2))) {
    const mirror = key.endsWith("m");
    const D = { x: sc[`${key}Dx`], z: sc[`${key}Dz`] }, F = { x: sc[`${key}Fx`], z: sc[`${key}Fz`] };
    const a = Math.atan2(F.z - D.z, F.x - D.x), s2 = sc.s;
    const gx = D.x + s2 * (G_LOCAL.x * Math.cos(a) - G_LOCAL.y * Math.sin(a)), gz = D.z + s2 * (G_LOCAL.x * Math.sin(a) + G_LOCAL.y * Math.cos(a));
    out.push({ x: mirror ? -gx : gx, z: gz });
  }
  return out;
}

/** Where a line along Y through (x, z) runs inside a body: its [y0, y1] spans, from its mesh. */
function runsAlongY(b: SolidEval, x: number, z: number): [number, number][] {
  const bb = b.bounds!;
  if (x < bb.min.x || x > bb.max.x || z < bb.min.z || z > bb.max.z) return [];
  const P = b.mesh!.positions, I = b.mesh!.indices, ys: number[] = [];
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3, p = I[i + 1] * 3, c = I[i + 2] * 3;
    const ux = P[p] - P[a], uz = P[p + 2] - P[a + 2], vx = P[c] - P[a], vz = P[c + 2] - P[a + 2];
    const d = ux * vz - vx * uz;
    if (Math.abs(d) < 1e-12) continue;   // a facet edge-on to the line
    const u = ((x - P[a]) * vz - vx * (z - P[a + 2])) / d, v = (ux * (z - P[a + 2]) - (x - P[a]) * uz) / d;
    if (u < 0 || v < 0 || u + v > 1) continue;
    ys.push(P[a + 1] + u * (P[p + 1] - P[a + 1]) + v * (P[c + 1] - P[a + 1]));
  }
  ys.sort((p, q) => p - q);
  expect(ys.length % 2, `${b.name}: a line through its mesh crosses it an odd number of times`).toBe(0);
  const out: [number, number][] = [];
  for (let i = 0; i < ys.length; i += 2) out.push([ys[i], ys[i + 1]]);
  return mergeRuns(out);
}

/** Runs along a line, those that touch or overlap joined. */
function mergeRuns(runs: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const r of [...runs].sort((p, q) => p[0] - q[0])) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1e-3) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

// Replaying the generator is some thousands of commands, each re-solving a 74-body
// assembly, so the default run checks the linkage on the committed example (its
// bodies building on both paths, and staying clear through a crank turn, are the
// example suite's: test/examples.walker.test.ts); the extended run, or a build,
// replays the generator and checks it reproduces that file.
const BUILD = FULL || !!OUT;

describe("Jansen walker", () => {
  let s: CadSession;
  beforeAll(async () => {
    await initKernel({ wasmBinary: wasm });
    if (BUILD) {
      s = realSession();
      await buildWalker(s);
    } else {
      s = sessionFromDoc(deserializeDocument(readFileSync(fileURLToPath(new URL("../public/examples/walker.json", import.meta.url)), "utf8")));
      rebuild(s.doc, createDefaultRegistry()); // replay the timeline (the parameters are in it); the solids aren't needed
    }
  }, 1800000);

  it.runIf(BUILD)("builds the committed example: every bar, the crankshaft and the frame", async () => {
    await s.recompute();
    if (OUT) writeFileSync(`${OUT}/walker.vibecad.json`, serializeDocument(s.doc));
    expectCommittedExample(s, "walker");
    const sc = resolveParameters(s.doc.parameters).scope;
    placeComponentSketches(s.doc, sc);
    const sol = Object.values(evaluateFeatures(s.doc, sc));
    for (const b of sol) expect(b.error, b.name).toBeUndefined();
    expect(sol.filter((b) => b.mesh).length).toBe(12 * 6 + 2);
  }, 1800000);

  it("closes the linkage at every crank angle: the solved pins sit on their bars' circles all the way round", () => {
    expect(s.doc.parameters.filter((p) => !p.hidden).map((p) => p.name)).toEqual(["t", "s"]);
    for (let t = 0; t < 360; t += 15) {
      const q = resolveParameters(s.doc.parameters.map((p) => (p.name === "t" ? { ...p, expr: String(t) } : p))).scope;
      const len = (k: string, a: string, b: string) => Math.hypot(q[`${k}${a}x`] - q[`${k}${b}x`], q[`${k}${a}z`] - q[`${k}${b}z`]) / q.s;
      expect(len("w0", "A", "C")).toBeCloseTo(J.j, 6);
      expect(len("w3m", "A", "D")).toBeCloseTo(J.k, 6);
      expect(len("w5", "E", "F")).toBeCloseTo(J.f, 6);
      expect(len("w2m", "D", "F")).toBeCloseTo(J.g, 6);
    }
  });

  it("walks: each foot traces a flat ground stroke, and at every moment several feet are on the ground", () => {
    const ground = Math.min(...Array.from({ length: 72 }, (_, i) => Math.min(...feet(s, i * 5).map((f) => f.z))));
    for (let t = 0; t < 360; t += 10) {
      const down = feet(s, t).filter((f) => f.z < ground + 2);   // within 2 mm of the ground line
      expect(down.length, `t = ${t}`).toBeGreaterThanOrEqual(4);
    }
  });

  it("goes together: a pin runs through every part on each of a leg's six joints, and the parts on a moving joint sit adjacent", () => {
    const sc = resolveParameters(s.doc.parameters).scope;
    const doc = { ...s.doc, sketches: Object.fromEntries(Object.entries(s.doc.sketches).map(([k, v]) => [k, { ...v }])) };
    placeComponentSketches(doc, sc);
    const bodies = Object.values(evaluateFeatures(doc, sc)).filter((b) => b.mesh);
    const compName = (b: SolidEval) => Object.values(doc.components).find((c) => c.sketches.includes(b.sketchId))?.name;
    const byName = new Map(bodies.map((b) => [compName(b), b]));
    const JOINTS: Record<string, Part[]> = {
      A: ["Upper link", "Lower link"], B: ["Rocker", "Upper triangle"], C: ["Upper triangle", "Upper link"],
      D: ["Rocker", "Foot", "Lower link"], E: ["Upper triangle", "Knee link"], F: ["Knee link", "Foot"],
    };
    const problems: string[] = [];
    for (const key of Object.keys(sc).filter((k) => /^w\dm?Ax$/.test(k)).map((k) => k.slice(0, -2))) {
      const mirror = key.endsWith("m");
      for (const [q, parts] of Object.entries(JOINTS)) {
        const x = (q === "B" ? -J.a * sc.s : sc[`${key}${q}x`]) * (mirror ? -1 : 1), z = q === "B" ? -J.l * sc.s : sc[`${key}${q}z`];
        // each part's slab: along a line 3 mm off the pin's axis, between its hole (2.3) and its edge (4)
        const slabs = parts.map((p) => {
          const runs = runsAlongY(byName.get(`${p} ${key}`)!, x + 1.8, z + 2.4);
          expect(runs.length, `${p} ${key} at ${q}`).toBe(1);
          return runs[0];
        }).sort((a, b) => a[0] - b[0]);
        // the pin: wherever any body is solid on the axis (a hole's facets come no nearer than 2.2)
        const axis = mergeRuns(bodies.flatMap((b) => runsAlongY(b, x + 0.0123, z + 0.0071)));
        if (!axis.some(([lo, hi]) => slabs.every(([a, b]) => lo <= a + 1e-3 && hi >= b - 1e-3))) {
          problems.push(`${key} ${q}: parts ${slabs.map((r) => r.map((v) => v.toFixed(1)).join("–")).join(", ")}; pin ${axis.map((r) => r.map((v) => v.toFixed(1)).join("–")).join(", ") || "none"}`);
        }
        if (q !== "A" && q !== "B") {
          const gap = Math.max(...slabs.slice(1).map((r, i) => r[0] - slabs[i][1]));
          if (gap > PITCH - T + 1e-3) problems.push(`${key} ${q}: a ${gap.toFixed(1)} mm gap between its parts`);
        }
      }
    }
    expect(problems).toEqual([]);
  }, 600000);

  // the suite sweeps `t` every 90° by default; these phases fall between its samples
  for (const t of [47, 133]) {
    itFull(`is clear at t = ${t}°: no bar, web or stub runs into another`, () => {
      const params = s.doc.parameters.map((p) => (p.name === "t" ? { ...p, expr: String(t) } : p));
      const sc = resolveParameters(params).scope;
      const doc = { ...s.doc, parameters: params, sketches: Object.fromEntries(Object.entries(s.doc.sketches).map(([k, v]) => [k, { ...v }])) };
      placeComponentSketches(doc, sc);
      const c = collideFeatures(doc, sc);
      expect(c.buildError).toBeUndefined();
      for (const o of c.overlaps) expect(o.volume, `${o.a} × ${o.b} at t ${t}`).toBeLessThan(0.05);
    }, 600000);
  }
});
