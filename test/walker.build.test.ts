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
// Built for clearance as a real one is: every bar has its own layer in its throw,
// the crankshaft is webs and a crank pin per throw with journals only between
// throws (the crank-pin bars sweep right through the shaft's axis), and bulkheads
// between the throws carry the journals and short stubs for the fixed pivots.
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
const LAYERS = 12;                           // per throw: web, c, BCE, j k f DFG, j' k' f' DFG', web
const BLOCK = GAP + LAYERS * PITCH;
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

/** A flat bar from its pivot (local origin) along +x for `len` (expression), rounded ends, a pin hole at each. */
async function bar(s: CadSession, comp: string, len: string, name: string) {
  const sk = (await dis(s, "sketch.create", { plane: "XZ", component: comp, name }))[0];
  const p = async (x: string, y: number) => (await dis(s, "sketch.addPoint", { sketch: sk, x, y: n(y) }))[0];
  const a0 = await p("0", -W / 2), a1 = await p(len, -W / 2), b1 = await p(len, W / 2), b0 = await p("0", W / 2);
  const c0 = await p("0", 0), c1 = await p(len, 0);
  await dis(s, "sketch.addLine", { sketch: sk, start: { ref: a0 }, end: { ref: a1 } });
  await dis(s, "sketch.addArc", { sketch: sk, center: { ref: c1 }, start: { ref: a1 }, end: { ref: b1 }, ccw: true });
  await dis(s, "sketch.addLine", { sketch: sk, start: { ref: b1 }, end: { ref: b0 } });
  await dis(s, "sketch.addArc", { sketch: sk, center: { ref: c0 }, start: { ref: b0 }, end: { ref: a0 }, ccw: true });
  for (const c of [c0, c1]) await dis(s, "sketch.addCircle", { sketch: sk, center: { ref: c }, radius: HOLE });
  await dis(s, "feature.extrude", { sketch: sk, distance: String(T), direction: "reverse", name });
}

/** A rigid triangle plate with rounded corners: pins at the local origin, along +x at `x1` (units of
 *  the linkage, scaled by `s`) and at (x2, y2), its outline offset W/2 out from the pin centres all
 *  round so each pin hole sits inside the plate; holes at the first two pins. */
async function plate(s: CadSession, comp: string, x1: number, x2: number, y2: number, name: string) {
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
  for (const c of centres.slice(0, 2)) await dis(s, "sketch.addCircle", { sketch: sk, center: { ref: c }, radius: HOLE });
  await dis(s, "feature.extrude", { sketch: sk, distance: String(T), direction: "reverse", name });
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
    const off = L.mirror ? 4 : 0;   // the twin's own bars sit in the layers beyond
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
    await place("Rocker", 1, B, P("D"), (c) => bar(s, c, S(J.c), "Rocker"));
    await place("Upper triangle", 2, B, P("C"), (c) => plate(s, c, J.b, E_LOCAL.x, sgn * E_LOCAL.y, "Upper triangle"));
    await place("Upper link", 3 + off, P("A"), P("C"), (c) => bar(s, c, S(J.j), "Upper link"));
    await place("Lower link", 4 + off, P("A"), P("D"), (c) => bar(s, c, S(J.k), "Lower link"));
    await place("Knee link", 5 + off, P("E"), P("F"), (c) => bar(s, c, S(J.f), "Knee link"));
    await place("Foot", 6 + off, P("D"), P("F"), (c) => plate(s, c, J.g, G_LOCAL.x, sgn * G_LOCAL.y, "Foot"));
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
    if (k < PHASES.length) {
      // stubs for this throw's fixed pivots (B and its mirror), through the web's layer and the two bars on it
      for (const sx of ["-", ""]) {
        const ssk = await xz(y0 + GAP - 2 - 0.01, `Pivot ${k + 1}`, frame);
        await circleAt(ssk, `${sx}${S(J.a)}`, `-${S(J.l)}`, PIN);
        await fjoin(ssk, layerY(k, 3) - (y0 + GAP - 2) - 0.5, `Pivot ${k + 1}`);
      }
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
