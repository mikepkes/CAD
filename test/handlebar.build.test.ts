// A mountain-bike cockpit as an organic-surface showcase: a riser bar swept
// along a smooth 3D spine (curvature-continuous bends) whose section tapers
// from the 31.8 mm clamp to the 22.2 mm grip diameter; ergonomic lock-on grips
// whose section morphs from round into a palm wing; anodised lock-on collars and
// end plugs; and a stem with its faceplate, steerer, spacer and top cap.
// Width, rise, back-sweep, up-sweep, grip length and stem length are sliders.
//   BUILD_HANDLEBAR=/abs/out npx vitest run test/handlebar.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel, buildSpineSweep, facesC2 } from "../src/core/occ/kernel";
import { serializeDocument } from "../src/core/persistence";
import { collideFeatures, evaluateFeatures, analyzeBodies, spineSweepSpec, SolidEval } from "../src/core/features";
import type { SweepFeature } from "../src/core/document";
import { placeComponentSketches } from "../src/core/recompute";
import { resolveParameters } from "../src/core/parameters";
import type { CadSession } from "../src/core/command/session";

const OUT = process.env.BUILD_HANDLEBAR || "";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

// ---- the numbers a real riser bar is made to
const CLAMP_D = 31.8, GRIP_D = 22.2;            // bar diameters: stem clamp, grip section
const K = GRIP_D / CLAMP_D;                     // the taper, as a scale on the clamp section
const LE = 200;                                 // the grip section's straight run, back from the tip to the up/back-sweep bend
const KX = 85, B1 = 35, B2 = 40;                // the rise bend's corner (x) and the two bends' setbacks
const FIT = 0.1;                                // radial clearance of a bore over the bar
const COLLAR_W = 9, COLLAR_R = 15.3;            // lock-on collar width / outer radius
const PLUG_R = 12.2, PLUG_T = 5;                // end plug flange radius / thickness
const CLAMP_W = 42;                             // stem clamp width (along the bar)

/** A point on a grip section's axis, `d` mm in from the bar's tip, on side ±1 (expressions). */
const axisAt = (d: number | string, side: 1 | -1) => ({
  x: `${side < 0 ? "-" : ""}(width/2-(${d})*gx)`, y: `tipY-(${d})*gy`, z: `rise-(${d})*gz`,
});

interface Built { bar: string; parts: Record<string, string>; sectionSketches: string[] }

async function buildHandlebar(s: CadSession): Promise<Built> {
  // ---- parameters (sliders) and the derived geometry (hidden)
  const P: [string, number, number, number, number][] = [
    ["width", 760, 720, 800, 5],          // width, tip to tip
    ["rise", 30, 25, 50, 5],          // the grip section's height above the clamp, at the tips
    ["backsweep", 9, 5, 12, 1],       // degrees, back toward the rider
    ["upsweep", 5, 3, 7, 1],          // degrees, up
    ["gripLen", 135, 120, 145, 5], // the rubber, collar excluded
    ["stemLen", 50, 40, 70, 5],
  ];
  for (const [name, val, min, max, step] of P) await dis(s, "parameter.add", { name, expression: String(val), min, max, step });
  const H: [string, string][] = [
    ["gx", "cos(rad(upsweep))*cos(rad(backsweep))"], ["gy", "-cos(rad(upsweep))*sin(rad(backsweep))"], ["gz", "sin(rad(upsweep))"],
    ["tipY", `${LE}*gy`], ["k2x", `width/2-${LE}*gx`], ["k2z", `rise-${LE}*gz`],
    ["riseRun", `sqrt((k2x-${KX})^2+k2z^2)`], ["rdx", `(k2x-${KX})/riseRun`], ["rdz", "k2z/riseRun"],
  ];
  for (const [name, expression] of H) await dis(s, "parameter.add", { name, expression, hidden: true });

  const comp = async (name: string, parent?: string) => (await dis(s, "component.create", { name, ...(parent ? { parent } : {}) }))[0];
  const sketch = async (component: string, name: string, plane = "XY") => (await dis(s, "sketch.create", { plane, component, name }))[0];
  const sectionSketches: string[] = [];
  const section = async (component: string, name: string) => { const id = await sketch(component, name, "YZ"); sectionSketches.push(id); return id; };
  const parts: Record<string, string> = {};

  // ---- the bar: one sweep along a 3D B-spline spine (its control polygon:
  // straight through the clamp, a rise bend, a sweep bend, straight to the tip),
  // its section scaled from the clamp diameter to the grip diameter. (Drawn solid: the tube's bore
  // is never seen behind the end plugs, and a solid bar keeps every boolean against it light.)
  const cockpit = await comp("Cockpit");
  const barC = await comp("Bar", cockpit);
  const barFrame = await sketch(barC, "Bar spine frame");
  const barSec = await section(barC, "Bar section");
  await dis(s, "sketch.addCircle", { sketch: barSec, center: { x: 0, y: 0 }, radius: CLAMP_D / 2 });
  const half: { x: string; y: string; z: string }[] = [
    { x: "20", y: "0", z: "0" }, { x: "50", y: "0", z: "0" }, { x: `${KX}`, y: "0", z: "0" },
    { x: `${KX}+${B1}*rdx`, y: "0", z: `${B1}*rdz` },
    { x: `k2x-${B2}*rdx`, y: "0", z: `k2z-${B2}*rdz` },
    { x: "k2x", y: "0", z: "k2z" },
    { x: `k2x+${B2}*gx`, y: `${B2}*gy`, z: `k2z+${B2}*gz` },
    { x: `k2x+${(LE + B2) / 2}*gx`, y: `${(LE + B2) / 2}*gy`, z: `k2z+${(LE + B2) / 2}*gz` },
    { x: "width/2", y: "tipY", z: "rise" },
  ];
  const spinePts = [...half.slice().reverse().map((p) => ({ ...p, x: `-(${p.x})` })), ...half];
  const grip0 = LE - B2 + 5; // the taper starts just inside the sweep bend: the whole straight grip section is 22.2
  const bar = (await dis(s, "feature.sweep", {
    profile: barSec, path: barFrame, points: spinePts, name: "Bar",
    scale: [
      { at: 0, value: K }, { at: grip0, value: K }, { at: "pathLength/2-60", value: 1 },
      { at: "pathLength/2+60", value: 1 }, { at: `pathLength-${grip0}`, value: K }, { at: "pathLength", value: K },
    ],
  }))[0];
  parts.bar = bar;

  // ---- per side: grip, collar, end plug
  for (const side of [1, -1] as const) {
    const tag = side > 0 ? "R" : "L";
    // grip: from the collar (gripLen in from the tip) to the tip; its section morphs from
    // round into a palm wing that reaches back (toward the rider: −y, which is +u on the left
    // and −u on the right, as the section's u axis is up × the spine's direction)
    const gripC = await comp(`Grip ${tag}`, cockpit);
    const gFrame = await sketch(gripC, `Grip ${tag} axis`);
    const back = -side;                                     // the wing's direction in section u
    const shapes: { at: string; draw: (sk: string) => Promise<void> }[] = [
      { at: "0", draw: async (sk) => { await dis(s, "sketch.addCircle", { sketch: sk, center: { x: 0, y: 0 }, radius: 15.6 }); } },
      { at: "0.3*pathLength", draw: async (sk) => { await dis(s, "sketch.addEllipse", { sketch: sk, center: { x: back * 0.4, y: 0 }, rx: 16.4, ry: 16 }); } },
      { at: "0.62*pathLength", draw: async (sk) => { await dis(s, "sketch.addEllipse", { sketch: sk, center: { x: back * 4.2, y: 0.3 }, rx: 20.4, ry: 16 }); } },
      { at: "pathLength-12", draw: async (sk) => { await dis(s, "sketch.addEllipse", { sketch: sk, center: { x: back * 9.6, y: 0.8 }, rx: 25.6, ry: 15.6 }); } },
      { at: "pathLength", draw: async (sk) => { await dis(s, "sketch.addEllipse", { sketch: sk, center: { x: back * 9.2, y: 0.8 }, rx: 24.6, ry: 14.8 }); } },
    ];
    const sections: { sketch: string; at: string }[] = [];
    for (const [i, sh] of shapes.entries()) {
      const sk = await section(gripC, `Grip ${tag} section ${i + 1}`);
      await sh.draw(sk);
      await dis(s, "sketch.addCircle", { sketch: sk, center: { x: 0, y: 0 }, radius: GRIP_D / 2 + FIT }); // the bore
      sections.push({ sketch: sk, at: sh.at });
    }
    parts[`grip${tag}`] = (await dis(s, "feature.sweep", { path: gFrame, points: [axisAt("gripLen", side), axisAt(0, side)], sections, name: `Grip ${tag}` }))[0];

    // lock-on collar: a machined ring inboard of the grip, swept along the same axis
    const colC = await comp(`Collar ${tag}`, cockpit);
    const cFrame = await sketch(colC, `Collar ${tag} axis`);
    const cSec = await section(colC, `Collar ${tag} section`);
    await dis(s, "sketch.addRing", { sketch: cSec, center: { x: 0, y: 0 }, outerRadius: COLLAR_R, innerRadius: GRIP_D / 2 + FIT });
    const collar = (await dis(s, "feature.sweep", { profile: cSec, path: cFrame, points: [axisAt(`gripLen+${COLLAR_W}`, side), axisAt("gripLen", side)], name: `Collar ${tag}` }))[0];
    parts[`collar${tag}`] = collar;

    // end plug: a domed flange on the bar's end (a scale law rolls its face over)
    const plugC = await comp(`End plug ${tag}`, cockpit);
    const pFrame = await sketch(plugC, `End plug ${tag} axis`);
    const pSec = await section(plugC, `End plug ${tag} flange`);
    await dis(s, "sketch.addCircle", { sketch: pSec, center: { x: 0, y: 0 }, radius: PLUG_R });
    const plug = (await dis(s, "feature.sweep", {
      profile: pSec, path: pFrame, points: [axisAt(0, side), axisAt(-PLUG_T, side)], name: `End plug ${tag}`,
      scale: [{ at: 0, value: 1 }, { at: 1.6, value: 1 }, { at: "pathLength", value: 0.6 }],
    }))[0];
    parts[`plug${tag}`] = plug;
  }

  // ---- the stem: steerer clamp, a waisted neck swept with changing sections, the bar clamp
  const stemC = await comp("Stem", cockpit);
  const pt = async (sk: string, x: string | number, y: string | number) => ({ ref: (await dis(s, "sketch.addPoint", { sketch: sk, x, y }))[0] });
  const steerBase = (await dis(s, "plane.create", { base: "XY", offset: "-20", name: "Stem underside" }))[0];
  const sc = (await dis(s, "sketch.create", { datum: steerBase, component: stemC, name: "Steerer clamp" }))[0];
  await dis(s, "sketch.addCircle", { sketch: sc, center: await pt(sc, 0, "-stemLen"), radius: 22 });
  const stem = (await dis(s, "feature.extrude", { sketch: sc, distance: "40", name: "Stem" }))[0];
  // its rims rounded before anything joins it (a short stem's bar clamp cuts into the rim)
  for (const z of [-20, 20]) await dis(s, "feature.fillet", { radius: "2", body: stem, edges: { inPlane: { plane: "XY", offset: z } }, name: "Steerer clamp rim" });
  const nFrame = await sketch(stemC, "Neck axis");
  const neck: { at: string; w: number; h: number; r: number }[] = [
    { at: "0", w: 30, h: 36, r: 9 }, { at: "0.5*pathLength", w: 25, h: 31, r: 8 }, { at: "pathLength", w: 34, h: 38, r: 9 },
  ];
  const neckSecs: { sketch: string; at: string }[] = [];
  for (const [i, n] of neck.entries()) {
    const sk = await section(stemC, `Neck section ${i + 1}`);
    await dis(s, "sketch.addRectangle", { sketch: sk, corner: { x: -n.w / 2, y: -n.h / 2 }, opposite: { x: n.w / 2, y: n.h / 2 }, cornerRadius: n.r });
    neckSecs.push({ sketch: sk, at: n.at });
  }
  await dis(s, "feature.sweep", { path: nFrame, points: [{ x: 0, y: "-stemLen+12", z: 0 }, { x: 0, y: -14, z: 0 }], sections: neckSecs, operation: "join", body: stem, name: "Stem neck" });
  const clampBlock = await sketch(stemC, "Bar clamp", "YZ");
  await dis(s, "sketch.addRectangle", { sketch: clampBlock, corner: { x: -19, y: -23.5 }, opposite: { x: -1, y: 23.5 }, cornerRadius: 6 });
  await dis(s, "feature.extrude", { sketch: clampBlock, distance: String(CLAMP_W), symmetric: true, operation: "join", body: stem, name: "Stem bar clamp" });
  // machined edges: the clamp's sides rounded
  for (const x of [-CLAMP_W / 2, CLAMP_W / 2]) await dis(s, "feature.fillet", { radius: "1.5", body: stem, edges: { inPlane: { plane: "YZ", offset: x } }, name: "Clamp edge" });
  // the faceplate: the clamp's front half, a 2 mm gap between them
  const faceC = await comp("Faceplate", cockpit);
  const fp = await sketch(faceC, "Faceplate", "YZ");
  await dis(s, "sketch.addRectangle", { sketch: fp, corner: { x: 1, y: -23.5 }, opposite: { x: 19, y: 23.5 }, cornerRadius: 6 });
  const face = (await dis(s, "feature.extrude", { sketch: fp, distance: String(CLAMP_W), symmetric: true, name: "Faceplate" }))[0];
  for (const x of [-CLAMP_W / 2, CLAMP_W / 2]) await dis(s, "feature.fillet", { radius: "1.5", body: face, edges: { inPlane: { plane: "YZ", offset: x } }, name: "Faceplate edge" });
  parts.stem = stem; parts.faceplate = face;
  // bores: the bar through clamp and faceplate, the steerer through the stem
  for (const [c, body] of [[stemC, stem], [faceC, face]] as const) {
    const b = await sketch(c, "Bar bore", "YZ");
    await dis(s, "sketch.addCircle", { sketch: b, center: { x: 0, y: 0 }, radius: CLAMP_D / 2 + FIT / 2 });
    await dis(s, "feature.extrude", { sketch: b, distance: "1", extent: "throughAll", symmetric: true, operation: "cut", body, name: "Bar bore" });
    // the four faceplate bolts' holes (M5 clearance)
    const h = await sketch(c, "Bolt holes", "XZ");
    for (const x of [-14, 14]) for (const z of [-19.5, 19.5]) await dis(s, "sketch.addCircle", { sketch: h, center: { x, y: z }, radius: 2.7 });
    // into the stem (−y) as deep as the shanks go, so the holes never reach the steerer clamp; through the faceplate (+y)
    await dis(s, "feature.extrude", { sketch: h, ...(body === face ? { distance: "20", direction: "reverse" } : { distance: "16" }), operation: "cut", body, name: "Bolt holes" });
  }
  const sb = (await dis(s, "sketch.create", { datum: steerBase, component: stemC, name: "Steerer bore" }))[0];
  await dis(s, "sketch.addCircle", { sketch: sb, center: await pt(sb, 0, "-stemLen"), radius: 14.4 });
  await dis(s, "feature.extrude", { sketch: sb, distance: "1", extent: "throughAll", symmetric: true, operation: "cut", body: stem, name: "Steerer bore" });

  // faceplate bolts: socket heads on the plate's face, shanks through the holes into the stem
  const boltC = await comp("Faceplate bolts", cockpit);
  const heads = (await dis(s, "sketch.create", { plane: "XZ", offset: -19, component: boltC, name: "Bolt heads" }))[0]; // XZ's normal is −Y: offset −19 is y = 19
  for (const x of [-14, 14]) for (const z of [-19.5, 19.5]) await dis(s, "sketch.addCircle", { sketch: heads, center: { x, y: z }, radius: 4 });
  const bolts = (await dis(s, "feature.extrude", { sketch: heads, distance: "5", direction: "reverse", name: "Faceplate bolts" }))[0]; // out of the plate, +y
  const shanks = (await dis(s, "sketch.create", { plane: "XZ", offset: -19, component: boltC, name: "Bolt shanks" }))[0];
  for (const x of [-14, 14]) for (const z of [-19.5, 19.5]) await dis(s, "sketch.addCircle", { sketch: shanks, center: { x, y: z }, radius: 2.5 });
  await dis(s, "feature.extrude", { sketch: shanks, distance: "30", operation: "join", body: bolts, name: "Bolt shanks" }); // into the plate and the stem, −y
  const sockets = (await dis(s, "sketch.create", { plane: "XZ", offset: -24, component: boltC, name: "Bolt sockets" }))[0];
  for (const x of [-14, 14]) for (const z of [-19.5, 19.5]) await dis(s, "sketch.addPolygon", { sketch: sockets, center: { x, y: z }, vertex: { x: x + 2.3, y: z }, sides: 6 });
  await dis(s, "feature.extrude", { sketch: sockets, distance: "3", operation: "cut", body: bolts, name: "Bolt sockets" });
  parts.bolts = bolts;

  // steerer tube, a spacer under the stem and the top cap over it
  const steerC = await comp("Steerer", cockpit);
  const st = (await dis(s, "sketch.create", { plane: "XY", offset: -75, component: steerC, name: "Steerer" }))[0];
  await dis(s, "sketch.addRing", { sketch: st, center: await pt(st, 0, "-stemLen"), outerRadius: 14.3, innerRadius: 12.6 });
  parts.steerer = (await dis(s, "feature.extrude", { sketch: st, distance: "92", name: "Steerer" }))[0]; // its top 3 mm below the stem's
  const spC = await comp("Spacer", cockpit);
  const sp = (await dis(s, "sketch.create", { plane: "XY", offset: -30, component: spC, name: "Spacer" }))[0];
  await dis(s, "sketch.addRing", { sketch: sp, center: await pt(sp, 0, "-stemLen"), outerRadius: 17.5, innerRadius: 14.4 });
  parts.spacer = (await dis(s, "feature.extrude", { sketch: sp, distance: "10", name: "Spacer" }))[0];
  const capC = await comp("Top cap", cockpit);
  const cap = (await dis(s, "sketch.create", { plane: "XY", offset: 20, component: capC, name: "Top cap" }))[0];
  await dis(s, "sketch.addCircle", { sketch: cap, center: await pt(cap, 0, "-stemLen"), radius: 17 });
  const topCap = (await dis(s, "feature.extrude", { sketch: cap, distance: "5", name: "Top cap" }))[0];
  await dis(s, "feature.fillet", { radius: "2", body: topCap, edges: { inPlane: { plane: "XY", offset: 25 } }, name: "Top cap round" });
  parts.topCap = topCap;

  // ---- materials: a brushed aluminium bar; rubber grips with a hex pad pattern wrapped round
  // them; a red anodised stem, faceplate, top cap, lock-on collars and end plugs; titanium bolts;
  // a black anodised steerer and spacer
  const mat = async (name: string, p: Record<string, unknown>) => (await dis(s, "material.create", { name, ...p }))[0];
  const brushed = await mat("Brushed aluminium", { kind: "metal", finish: "brushed", color: "#d3d6da", textureAxis: "x" });
  const blackAno = await mat("Black anodised aluminium", { kind: "metal", finish: "satin", color: "#2a2c30", roughness: 0.3 });
  const redAno = await mat("Red anodised aluminium", { kind: "metal", finish: "satin", color: "#c0261c", roughness: 0.24 });
  const titanium = await mat("Titanium", { kind: "metal", finish: "satin", color: "#b9b3a8", roughness: 0.2 });
  const rubber = await mat("Grip rubber", { kind: "rubber", color: "#232427", texture: "hex", textureScale: 3.2, textureWrap: true });
  const assign = async (material: string, component: string) => dis(s, "material.assign", { material, component });
  await assign(brushed, barC); await assign(blackAno, steerC); await assign(blackAno, spC);
  for (const t of ["R", "L"]) {
    const byName = (n: string) => Object.values(s.doc.components).find((c) => c.name === n)!.id;
    await assign(rubber, byName(`Grip ${t}`)); await assign(redAno, byName(`Collar ${t}`)); await assign(redAno, byName(`End plug ${t}`));
  }
  await assign(redAno, stemC); await assign(redAno, faceC); await assign(redAno, capC); await assign(titanium, boltC);

  // the sketches are drawing aids (sections, spine frames, outlines): hide them, so the cockpit shows clean
  const aids = [...Object.keys(s.doc.sketches), steerBase];
  const hid = await s.setVisibility(aids, false);
  if (!hid.ok) throw new Error(hid.error);
  return { bar, parts, sectionSketches };
}

// ---- measuring
function evaluate(s: CadSession): Record<string, SolidEval> {
  const scope = resolveParameters(s.doc.parameters).scope;
  placeComponentSketches(s.doc, scope);
  return evaluateFeatures(s.doc, scope);
}
type V = [number, number, number];
const val = (s: CadSession, n: string) => s.doc.parameters.find((p) => p.name === n)!.value;
/** The bar's radius at mesh vertices within `half` mm of a point on its axis (distance from the axis line). */
function radiusAt(b: SolidEval, o: V, axis: V, half = 2): { min: number; max: number } {
  const p = b.mesh!.positions;
  let min = Infinity, max = 0;
  for (let i = 0; i < p.length; i += 3) {
    const d: V = [p[i] - o[0], p[i + 1] - o[1], p[i + 2] - o[2]];
    const along = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
    if (Math.abs(along) > half) continue;
    const r = Math.hypot(d[0] - along * axis[0], d[1] - along * axis[1], d[2] - along * axis[2]);
    min = Math.min(min, r); max = Math.max(max, r);
  }
  return { min, max };
}
function gripAxis(s: CadSession): { tip: V; g: V } {
  const v = (n: string) => val(s, n);
  return { tip: [v("width") / 2, v("tipY"), v("rise")], g: [v("gx"), v("gy"), v("gz")] };
}
describe("handlebar: an organic riser-bar cockpit", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("builds, measures like a real bar, is smooth, and is clear", async () => {
    const s = realSession();
    const { bar, parts } = await buildHandlebar(s);
    await s.recompute();
    if (OUT) writeFileSync(`${OUT}/handlebar.json`, serializeDocument(s.doc));

    const solids = evaluate(s);
    for (const r of Object.values(solids)) expect(r.error, `${r.name}: ${r.error}`).toBeUndefined();
    const bodies = Object.values(solids).filter((b) => b.mesh);
    // bar, 2 grips, 2 collars, 2 plugs, stem, faceplate, bolts, steerer, spacer, top cap
    expect(bodies.length).toBe(13);

    // the clamp: 31.8 at the centre; the grip section: 22.2; the width tip to tip
    const b = solids[bar];
    const rc = radiusAt(b, [0, 0, 0], [1, 0, 0]);
    expect(rc.max).toBeCloseTo(CLAMP_D / 2, 1);
    const { tip, g } = gripAxis(s);
    const at = (d: number): V => [tip[0] - d * g[0], tip[1] - d * g[1], tip[2] - d * g[2]];
    for (const d of [10, 60, 120, 150]) expect(radiusAt(b, at(d), g).max, `grip section ${d} mm in`).toBeCloseTo(GRIP_D / 2, 1);
    const span = b.bounds!.max.x - b.bounds!.min.x;
    const capOverhang = (GRIP_D / 2) * Math.sqrt(1 - g[0] * g[0]); // the tip faces are square to the swept-back grip section
    expect(span - 2 * capOverhang).toBeCloseTo(val(s, "width"), 0);

    // smoothness: the bar and the grips are each ONE swept surface (plus flat ends and, for a
    // grip, its bore), C2 all through — no knot where the curvature jumps — and any edge between
    // two of their faces that isn't a square-cut end is curvature-continuous (G2)
    const scope0 = resolveParameters(s.doc.parameters).scope;
    const an = analyzeBodies(s.doc, scope0);
    for (const id of [bar, parts.gripR, parts.gripL]) {
      const f = s.doc.features[id] as SweepFeature;
      const shape = buildSpineSweep(spineSweepSpec(s.doc, scope0, f));
      const faces = facesC2(shape);
      shape.delete();
      expect(faces.filter((x) => x.type !== "PLANE").length, `${f.name}: swept faces`).toBe(id === bar ? 1 : 2);
      for (const x of faces) expect(x.c2, `${f.name}: a ${x.type} face is C2 throughout`).toBe(true);
      const a = an.find((x) => x.featureId === id)!;
      for (const e of a.edges.filter((e) => e.angleDeg < 45)) expect(e.continuity, `${a.name}: ${e.name}`).toBe("G2");
      // the curvature stays bounded: nothing tighter than an 8 mm radius (the wing ellipse's tightest is ~9), so no kinks or ripples
      expect(a.stats.kMax, a.name).toBeLessThan(1 / 8);
    }

    // clear: nothing interpenetrates (the bores have a 0.1 mm fit)
    const sc = resolveParameters(s.doc.parameters).scope;
    placeComponentSketches(s.doc, sc);
    const col = collideFeatures(s.doc, sc);
    expect(col.buildError).toBeUndefined();
    for (const o of col.overlaps) expect(o.volume, `${o.a} hits ${o.b}`).toBeLessThan(1);
    console.log(`handlebar: ${bodies.length} bodies; clamp Ø${(2 * rc.max).toFixed(2)}, width ${(span - 2 * capOverhang).toFixed(1)}`);
  }, 1200000);

  it("builds cleanly, and stays clear, at the ends of every slider", async () => {
    const s = realSession();
    const { bar } = await buildHandlebar(s);
    await s.recompute();
    for (const p of s.doc.parameters.filter((q) => q.min != null && q.max != null)) {
      for (const v of [p.min!, p.max!]) {
        const r = await s.dispatch("parameter.set", { name: p.name, expression: String(v) });
        expect(r.ok, `${p.name} = ${v}`).toBe(true);
        const solids = evaluate(s);
        for (const o of Object.values(solids)) expect(o.error, `${p.name} = ${v}: ${o.name}`).toBeUndefined();
        const b = solids[bar];
        const { tip, g } = gripAxis(s);
        expect(radiusAt(b, [0, 0, 0], [1, 0, 0]).max, `${p.name} = ${v}: clamp`).toBeCloseTo(CLAMP_D / 2, 1);
        expect(radiusAt(b, [tip[0] - 60 * g[0], tip[1] - 60 * g[1], tip[2] - 60 * g[2]], g).max, `${p.name} = ${v}: grip`).toBeCloseTo(GRIP_D / 2, 1);
        if (p.name === "width") expect(b.bounds!.max.x - b.bounds!.min.x - GRIP_D * Math.sqrt(1 - g[0] * g[0])).toBeCloseTo(v, 0);
        const sc = resolveParameters(s.doc.parameters).scope;
        placeComponentSketches(s.doc, sc);
        const col = collideFeatures(s.doc, sc);
        expect(col.buildError, `${p.name} = ${v}`).toBeUndefined();
        for (const o of col.overlaps) expect(o.volume, `${p.name} = ${v}: ${o.a} hits ${o.b}`).toBeLessThan(1);
      }
      await s.dispatch("parameter.set", { name: p.name, expression: p.expr });
    }
  }, 2400000);
});
