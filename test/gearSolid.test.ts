// feature.gear: every gear type as one parametric feature, the printable
// extras, the command's checks, and — the point of a gear — that meshed pairs
// placed by `mesh` (or by the documented maths, for bevel and worm pairs) turn
// on revolute joints without their teeth ever interpenetrating, while a pair a
// half tooth out of phase does collide (so the check can fail).
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, itFull } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { collideFeatures, evaluateFeatures, SolidEval } from "../src/core/features";
import { placeComponentSketches } from "../src/core/recompute";
import { resolveParameters } from "../src/core/parameters";
import { bevelGeometry, wormGeometry, meshRotation, rackPinionRotation } from "../src/core/geometry/gear";
import type { CadSession } from "../src/core/command/session";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}
const solidsOf = (s: CadSession): Record<string, SolidEval> => {
  const scope = resolveParameters(s.doc.parameters).scope;
  placeComponentSketches(s.doc, scope);
  return evaluateFeatures(s.doc, scope);
};

/** Overlap of every body pair with the driver parameter `t` set to each angle (posing the joints). */
function overlapsAt(s: CadSession, angles: number[]): number[] {
  return angles.map((th) => {
    const params = s.doc.parameters.map((p) => (p.name === "t" ? { ...p, expr: String(th) } : p));
    const scope = resolveParameters(params).scope;
    const posed = { ...s.doc, parameters: params, sketches: Object.fromEntries(Object.entries(s.doc.sketches).map(([k, v]) => [k, { ...v }])) };
    placeComponentSketches(posed, scope);
    const c = collideFeatures(posed, scope);
    expect(c.buildError, `t=${th}`).toBeUndefined();
    return c.maxOverlap;
  });
}

const ANGLES = [0, 7, 19, 41];

describe("feature.gear", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  // These two measure the sharp solids against the profile maths, so their gears are made without
  // the edge break (`chamfer`, on by default; test/gearChamfer.test.ts checks it). The meshed pairs
  // below keep it, so they turn clear with their edges broken.
  const sharp = (s: CadSession, params: Record<string, unknown>) => dis(s, "feature.gear", { ...params, chamfer: false });

  it("builds every gear type as one feature, sized as the maths says", async () => {
    const s = realSession();
    const m = 2;
    const ids: Record<string, string> = {};
    ids.spur = (await sharp(s, { type: "spur", module: m, teeth: 20, faceWidth: 8 }))[0];
    ids.helical = (await sharp(s, { type: "helical", module: m, teeth: 20, faceWidth: 8, helixAngle: 20, x: 60 }))[0];
    ids.herringbone = (await sharp(s, { type: "herringbone", module: m, teeth: 20, faceWidth: 10, x: 120 }))[0];
    ids.ring = (await sharp(s, { type: "ring", module: m, teeth: 36, faceWidth: 6, rim: 5, y: 100 }))[0];
    ids.ringHerringbone = (await sharp(s, { type: "ring", module: m, teeth: 36, faceWidth: 8, helixAngle: 20, herringbone: true, x: 100, y: 100 }))[0];
    ids.rack = (await sharp(s, { type: "rack", module: m, teeth: 10, faceWidth: 8, y: -60 }))[0];
    ids.rackHelical = (await sharp(s, { type: "rack", module: m, teeth: 10, faceWidth: 8, helixAngle: 20, x: 80, y: -60 }))[0];
    ids.bevel = (await sharp(s, { type: "bevel", module: m, teeth: 16, mateTeeth: 24, faceWidth: 8, x: -60 }))[0];
    ids.worm = (await sharp(s, { type: "worm", module: m, teeth: 1, wormDiameter: 16, faceWidth: 30, x: -60, y: -60 }))[0];
    const out = solidsOf(s);
    for (const [k, id] of Object.entries(ids)) expect(out[id].error, k).toBeUndefined();
    const b = (k: string) => out[ids[k]].bounds!, v = (k: string) => out[ids[k]].volume!;
    // round gears: tip radius m(N/2 + 1), the face width tall; volume between the root and tip discs
    for (const k of ["spur", "helical", "herringbone"]) {
      const h = k === "herringbone" ? 10 : 8;
      expect(b(k).max.x - b(k).min.x, k).toBeCloseTo(44, 2);
      expect(b(k).max.z - b(k).min.z, k).toBeCloseTo(h, 3);
      expect(v(k), k).toBeGreaterThan(Math.PI * 17.5 ** 2 * h);
      expect(v(k), k).toBeLessThan(Math.PI * 22 ** 2 * h);
    }
    // a helical gear is the spur's profile twisted: the same volume
    expect(v("helical")).toBeCloseTo(v("spur"), 0);
    // ring: outer radius root + rim = 36 + 2.5 + 5; the bore is the toothed hole (tips at r 34)
    expect(b("ring").max.x - b("ring").min.x).toBeCloseTo(2 * 43.5, 2);
    expect(v("ring")).toBeGreaterThan(Math.PI * (43.5 ** 2 - 38.5 ** 2) * 6);
    expect(v("ring")).toBeLessThan(Math.PI * (43.5 ** 2 - 34 ** 2) * 6);
    expect(v("ringHerringbone") / 8).toBeCloseTo(v("ring") / 6, 0);
    // rack: 10 pitches long, tips at +m, body 2.5m below the roots
    expect(b("rack").max.x - b("rack").min.x).toBeCloseTo(10 * Math.PI * m, 3);
    expect(b("rack").max.y - (-60)).toBeCloseTo(m, 3);
    expect(v("rackHelical")).toBeCloseTo(v("rack"), -1);
    // bevel: heel radius ≈ the tip, the teeth stop well short of the apex
    const bg = bevelGeometry(m, 16, 24);
    expect(b("bevel").max.z).toBeCloseTo(8 * Math.cos(bg.pitchAngle), 3);
    expect(b("bevel").max.x - b("bevel").min.x).toBeGreaterThan(2 * bg.pitchRadius);
    // worm: tip diameter 16 + 2m, the length along the normal
    expect(b("worm").max.x - b("worm").min.x).toBeCloseTo(20, 1);
    expect(b("worm").max.z - b("worm").min.z).toBeCloseTo(30, 3);
    const w = wormGeometry(m, 1, 16);
    expect(v("worm")).toBeGreaterThan(Math.PI * w.rootRadius ** 2 * 30);
    expect(v("worm")).toBeLessThan(Math.PI * w.tipRadius ** 2 * 30);
  }, 120000);

  it("adds a bore (round, D-flat, keyed), a hub and spokes", async () => {
    const s = realSession();
    const base = { type: "spur", module: 2, teeth: 24, faceWidth: 6 };
    const plain = (await sharp(s, { ...base }))[0];
    const bored = (await sharp(s, { ...base, bore: 8, x: 60 }))[0];
    const dShaft = (await sharp(s, { ...base, bore: 8, dFlat: 7, x: 120 }))[0];
    const keyed = (await sharp(s, { ...base, bore: 8, keyway: 3, x: 180 }))[0];
    const hubbed = (await sharp(s, { ...base, bore: 8, hubDiameter: 16, hubLength: 5, y: 60 }))[0];
    const spoked = (await sharp(s, { ...base, bore: 8, hubDiameter: 16, hubLength: 5, spokes: 5, x: 60, y: 60 }))[0];
    const out = solidsOf(s);
    for (const id of [plain, bored, dShaft, keyed, hubbed, spoked]) expect(out[id].error).toBeUndefined();
    const v = (id: string) => out[id].volume!;
    expect(v(plain) - v(bored)).toBeCloseTo(Math.PI * 16 * 6, 1);
    expect(v(dShaft)).toBeGreaterThan(v(bored)); // the flat leaves material in the bore
    expect(v(keyed)).toBeLessThan(v(bored));     // the key slot takes more out
    // the slot adds its rectangle beyond the chord, less the circle's cap it overlaps
    const yk = Math.sqrt(16 - 2.25), cap = 8 * (2 * Math.asin(1.5 / 4) - Math.sin(2 * Math.asin(1.5 / 4)));
    expect(v(bored) - v(keyed)).toBeCloseTo((3 * (5.5 - yk) - cap) * 6, 1);
    expect(v(hubbed) - v(bored)).toBeCloseTo(Math.PI * (64 - 16) * 5, 0);
    expect(out[hubbed].bounds!.max.z).toBeCloseTo(11, 3);
    expect(v(spoked)).toBeLessThan(v(hubbed) * 0.8);
  }, 120000);

  it("follows its parameters: module and teeth are expressions", async () => {
    const s = realSession();
    await dis(s, "parameter.add", { name: "m", expression: "1.5", min: 0.5, max: 3 });
    await dis(s, "parameter.add", { name: "z", expression: "18", min: 8, max: 40, step: 1 });
    const id = (await dis(s, "feature.gear", { type: "helical", module: "m", teeth: "z", faceWidth: "4*m" }))[0];
    let out = solidsOf(s);
    expect(out[id].bounds!.max.x).toBeCloseTo(1.5 * 10, 2);
    await dis(s, "parameter.set", { name: "z", expression: "30" });
    await dis(s, "parameter.set", { name: "m", expression: "1" });
    out = solidsOf(s);
    expect(out[id].error).toBeUndefined();
    expect(out[id].bounds!.max.x).toBeCloseTo(16, 2);
    expect(out[id].bounds!.max.z).toBeCloseTo(4, 3);
  }, 120000);

  it("rejects gears that can't be made, before building anything", async () => {
    const s = realSession();
    const bad = async (params: Record<string, unknown>, msg: RegExp) => {
      const r = await s.dispatch("feature.gear", params);
      expect(r.ok, JSON.stringify(params)).toBe(false);
      expect(r.error).toMatch(msg);
    };
    await bad({ type: "spur", teeth: 2 }, /at least 3/);
    await bad({ type: "spur", module: 0 }, /module/);
    await bad({ type: "spur", module: "nope" }, /nope/);
    await bad({ type: "spur", teeth: 12.5 }, /whole number/);
    await bad({ type: "helical", helixAngle: 0 }, /helixAngle/);
    await bad({ type: "helical", helixAngle: 70 }, /under 60/);
    await bad({ type: "spur", herringbone: true }, /ring or rack/);
    await bad({ type: "spur", module: 1, teeth: 12, bore: 11 }, /no wall/);
    await bad({ type: "spur", bore: 5, dFlat: 6 }, /dFlat/);
    await bad({ type: "worm", teeth: 12 }, /starts/);
    await bad({ type: "spur", sketch: "sketch999" }, /No sketch/);
    await bad({ type: "kite" }, /type/);
    const g = (await dis(s, "feature.gear", { type: "spur", module: 2, teeth: 20 }))[0];
    await bad({ type: "spur", module: 1.5, teeth: 12, mesh: { gear: g } }, /module/);
    await bad({ type: "helical", teeth: 12, helixAngle: 20, mesh: { gear: g } }, /straight-cut/);
    await bad({ type: "bevel", teeth: 12, mesh: { gear: g } }, /spur, helical or herringbone/);
    await bad({ type: "spur", teeth: 12, plane: "XZ", mesh: { gear: g } }, /another plane/);
    const h = (await dis(s, "feature.gear", { type: "helical", module: 2, teeth: 20, helixAngle: 20 }))[0];
    await bad({ type: "helical", teeth: 12, helixAngle: 20, mesh: { gear: h } }, /-20/);
    expect(Object.values(s.doc.features).length).toBe(2);
  });

  it("makes its own placement sketch in a component, and the gear moves with it", async () => {
    const s = realSession();
    const comp = (await dis(s, "component.create", { name: "Wheel" }))[0];
    const [id, sk] = await dis(s, "feature.gear", { type: "spur", module: 1, teeth: 30, component: comp, plane: "XZ", name: "Wheel" });
    expect(s.doc.sketches[sk].componentId).toBe(comp);
    expect(s.doc.features[id].kind).toBe("gear");
    await dis(s, "joint.create", { kind: "slider", moved: comp, baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 }, value: "25" });
    const out = solidsOf(s);
    expect(out[id].error).toBeUndefined();
    // on XZ the axis is −Y; the slider lifted it 25 along Z
    expect(out[id].bounds!.max.y).toBeCloseTo(0, 3);
    expect(out[id].bounds!.min.y).toBeCloseTo(-5, 3);
    expect((out[id].bounds!.max.z + out[id].bounds!.min.z) / 2).toBeCloseTo(25, 3);
  }, 120000);
});

// ---- meshing -----------------------------------------------------------------------------

const Z = { x: 0, y: 0, z: 1 };
type V = { x: number | string; y: number | string; z: number | string };
const dimsOf = (s: CadSession, id: string) => (s.doc.features[id] as { dims: Record<string, string> }).dims;
const valuesOf = (s: CadSession, id: string) => (s.doc.features[id] as { dimValues: Record<string, number> }).dimValues;

/** A gear in its own component, on a joint to the root: connectors at `at`, else at the gear's centre (its x, y expressions). */
async function gearOn(s: CadSession, name: string, params: Record<string, unknown>, joint: { kind?: "revolute" | "slider"; axis?: { x: number; y: number; z: number }; value: string; at?: V }): Promise<string> {
  const comp = (await dis(s, "component.create", { name }))[0];
  const id = (await dis(s, "feature.gear", { component: comp, name, ...params }))[0];
  const d = dimsOf(s, id);
  const at = joint.at ?? { x: d.x ?? 0, y: d.y ?? 0, z: 0 };
  await dis(s, "joint.create", { kind: joint.kind ?? "revolute", moved: comp, baseOrigin: at, movedOrigin: at, axis: joint.axis ?? Z, value: joint.value, name: `${name} joint` });
  return id;
}

// The spur (with the check that can fail) and the ring, planet, rack and pinion
// run by default; the helical, herringbone, bevel and worm pairs (the slowest
// booleans: a worm pair alone took 40 s) in the extended run. By default every
// one of those pairs is also built and collided meshing in the clockwork
// example (test/examples.clockwork.test.ts), which turns them through its sweep.
describe("feature.gear: meshed pairs turn without interpenetrating", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);
  const drive = async (s: CadSession) => { await dis(s, "parameter.add", { name: "t", expression: "0", min: -360, max: 360 }); await dis(s, "parameter.add", { name: "slip", expression: "0" }); };

  it("spur, placed by mesh at an angle: clear as they turn, colliding half a tooth out", async () => {
    const s = realSession(); await drive(s);
    const a = await gearOn(s, "A", { type: "spur", module: 2, teeth: 19, faceWidth: 6, rotation: 4 }, { value: "t" });
    const b = await gearOn(s, "B", { type: "spur", teeth: 13, faceWidth: 6, mesh: { gear: a, angle: 65 } }, { value: "-t*19/13 + slip" });
    solidsOf(s);
    // the expressions agree with the plain maths
    const turn = (d: number) => ((d % 360) + 360) % 360;
    expect(turn(valuesOf(s, b).rotation)).toBeCloseTo(turn(meshRotation("external", 19, 4, 13, 65)), 6);
    expect(Math.hypot(valuesOf(s, b).x, valuesOf(s, b).y)).toBeCloseTo(32, 6);
    expect(valuesOf(s, b).module).toBe(2);
    for (const o of overlapsAt(s, ANGLES)) expect(o).toBeLessThan(0.01);
    await dis(s, "parameter.set", { name: "slip", expression: String(180 / 13) });
    expect(overlapsAt(s, [0])[0]).toBeGreaterThan(1);
  }, 240000);

  itFull("helical (opposite hands) and herringbone pairs", async () => {
    for (const type of ["helical", "herringbone"]) {
      const s = realSession(); await drive(s);
      const a = await gearOn(s, "A", { type, module: 1.5, teeth: 22, faceWidth: 9, helixAngle: type === "helical" ? 25 : 30 }, { value: "t" });
      const b = await gearOn(s, "B", { type, teeth: 14, faceWidth: 9, mesh: { gear: a, angle: 180 } }, { value: "-t*22/14" });
      expect(dimsOf(s, b).helixAngle).toBe(type === "helical" ? "-25" : "-30");
      for (const o of overlapsAt(s, ANGLES)) expect(o, type).toBeLessThan(0.01);
    }
  }, 240000);

  it("a ring turning round a held planet, and a rack under a pinion", async () => {
    const s = realSession(); await drive(s);
    // the planet turns t about a fixed centre; the ring follows the same way, t·12/36
    const ring = await gearOn(s, "Ring", { type: "ring", module: 2, teeth: 36, faceWidth: 6 }, { value: "t*12/36" });
    const planet = await gearOn(s, "Planet", { type: "spur", teeth: 12, faceWidth: 6, mesh: { gear: ring, angle: 150 } }, { value: "t" });
    // the pinion turns t; the rack slides t·π·m·N/360 the way the pinion's lowest teeth move
    const rack = await gearOn(s, "Rack", { type: "rack", module: 2, teeth: 9, faceWidth: 6, y: -70 }, { kind: "slider", axis: { x: 1, y: 0, z: 0 }, value: "t*pi*2*12/360", at: { x: 0, y: 0, z: 0 } });
    const pinion = await gearOn(s, "Pinion", { type: "spur", teeth: 12, faceWidth: 6, mesh: { gear: rack, along: 3 } }, { value: "t" });
    const out = solidsOf(s);
    expect(out[planet].error).toBeUndefined();
    const turn = (d: number) => ((d % 360) + 360) % 360;
    expect(turn(valuesOf(s, pinion).rotation)).toBeCloseTo(turn(rackPinionRotation(2, 12, 3)), 6);
    expect(valuesOf(s, pinion).y).toBeCloseTo(-70 + 12, 6);
    for (const o of overlapsAt(s, ANGLES)) expect(o).toBeLessThan(0.01);
  }, 240000);

  itFull("a straight bevel pair at 90° (placed by the documented maths)", async () => {
    const s = realSession(); await drive(s);
    const m = 2, N1 = 16, N2 = 24;
    await gearOn(s, "Pinion", { type: "bevel", module: m, teeth: N1, mateTeeth: N2, faceWidth: 8 }, { value: "t" });
    // gear 2's heel on a YZ plane m·N1/2 behind gear 1's axis (its normal +X toward the apex), centred m·N2/2 up — the apex height
    const rp1 = (m * N1) / 2, rp2 = (m * N2) / 2;
    expect(bevelGeometry(m, N1, N2).apexHeight).toBeCloseTo(rp2, 9);
    // they touch on gear 1's 180° and gear 2's −90°: phase so that s1 + s2 ≡ ½
    const s1 = ((180 * N1) / 360) % 1;
    const rot2 = -90 - ((0.5 - s1) * 360) / N2;
    const b = await gearOn(s, "Gear", { plane: "YZ", type: "bevel", module: m, teeth: N2, mateTeeth: N1, faceWidth: 8, offset: -rp1, y: rp2, rotation: rot2 },
      { axis: { x: 1, y: 0, z: 0 }, value: `-t*${N1}/${N2}`, at: { x: -rp1, y: 0, z: rp2 } });
    expect(solidsOf(s)[b].error).toBeUndefined();
    for (const o of overlapsAt(s, ANGLES)) expect(o).toBeLessThan(0.01);
  }, 240000);

  itFull("a worm and its wheel (a helical gear at the lead angle)", async () => {
    const s = realSession(); await drive(s);
    const m = 2, starts = 1, dW = 16, N = 24, b = 8, L = 40;
    const w = wormGeometry(m, starts, dW, { backlash: 0.1 });
    const a = (dW + m * N) / 2;
    // the worm along +X (a YZ sketch, offset to start at x = −L/2), its axis at y = a; it turns t
    await gearOn(s, "Worm", { plane: "YZ", type: "worm", module: m, teeth: starts, wormDiameter: dW, faceWidth: L, offset: -L / 2, x: a },
      { axis: { x: 1, y: 0, z: 0 }, value: "t", at: { x: 0, y: a, z: 0 } });
    // the wheel turns t·starts/N; phased so a space sits under a thread where they touch (the worm's local 180°),
    // measured at the wheel's mid-plane (a helical gear's section turns tan β / r per mm up its face)
    const xt = -L / 2 + w.lead / 2;
    const sR = (((-xt / w.axialPitch) % 1) + 1) % 1;
    const rot = 90 - ((0.5 - sR) * 360) / N - ((((b / 2) * Math.tan(w.leadAngle)) / ((m * N) / 2)) * 180) / Math.PI;
    const g = await gearOn(s, "Wheel", { type: "helical", module: m, teeth: N, faceWidth: b, helixAngle: (w.leadAngle * 180) / Math.PI, offset: -b / 2, rotation: rot }, { value: `t*${starts}/${N}` });
    expect(solidsOf(s)[g].error).toBeUndefined();
    for (const o of overlapsAt(s, [0, 90, 200, 333])) expect(o).toBeLessThan(0.01);
  }, 240000);
});
