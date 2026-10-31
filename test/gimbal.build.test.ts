// End-to-end: a two-axis flexure gimbal, the kind under a satellite's
// fine-steering mirror. A base plate carries two yoke posts; an outer ring
// rides on them through two cross-blade pivots (axis X); the mirror platform
// rides inside the ring on a second pair at right angles (axis Y, carried by the
// ring). Each pivot is two titanium blades crossing at 90° at their midpoints,
// one half of each blade clamped to either part. Driving `alpha` tilts the ring
// (and so the mirror) about X, `beta` tilts the platform about the ring's Y.
//
// The blades as `flexure` joints, not `beam`s. A cross-blade pivot whose blades
// cross at their midpoints is exactly the solver's small-length flexural pivot:
// turning one clamp by φ about the crossing bends each blade into a constant-
// moment arc (the end shear vanishes at λ = ½, Wittrick 1948), so a blade's
// stiffness is E·I/L and its outer-fibre strain t·φ/2L — the formulas in
// src/sim/flexure.ts. Each blade is one flexure joint about the pivot's axis;
// two blades per pivot, two pivots per axis, so an axis meets 4·E·I/L and the
// readout lists all eight blades. (A `beam` joint bends in its parts' XY plane,
// so it cannot hold a blade standing in a vertical plane.) What this model does
// not carry: the centre shift of a real cross-blade pivot (its rotation centre
// wanders by a fraction of L·φ² as it turns — 0.27 mm·fraction at 8°), the
// blades' stiffening under the hung mass, and any inertia (there is no mass in
// the solver, so no first mode: a hand estimate is logged, labelled).
//   BUILD_GIMBAL=/abs/out npx vitest run test/gimbal.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { serializeDocument } from "../src/core/persistence";
import { collideFeatures, evaluateFeatures, exportFusedBlob } from "../src/core/features";
import { placeComponentSketches, resolveComponentWorld } from "../src/core/recompute";
import { resolveParameters } from "../src/core/parameters";
import { flexureState, flexureStiffness, flexureStrain, flexureSweep } from "../src/sim/flexure";
import { applyPoint, applyVec } from "../src/math/transform";
import type { CadSession } from "../src/core/command/session";

const OUT = process.env.BUILD_GIMBAL || "";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

// ---- the blades: Ti-6Al-4V, as specified ----
const TI = { name: "Ti-6Al-4V", E: 114000, strain: 0.005 }; // MPa; 0.5% allowable
const BLADE = { L: 14, t: 0.4, w: 10 };                      // mm: free length, thickness, width (along the axis)
const RANGE = 8;                                             // ±8° steering on each axis
const PLAT_R = 44;

// ---- fixed dimensions (mm); everything else is an expression in the parameters ----
const BASE_T = 6;     // base plate
const RING_H = 10;    // the ring's half-height; its radial width is 8
const PLAT_T = 3;     // the platform's half-thickness
const MIRROR = { r: 20, t: 2 };
const CLAMP = 5;      // a clamp block's thickness (along the pivot's up direction)
const EMB = 1;        // how far a blade's end runs into its clamp
const GAP = 2;        // between the two blades of a pivot, along its axis
const CLR = 2;        // radial clearance either side of a pivot's blades

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

type X = number | string;
type Plane = { plane: "XY" | "XZ" | "YZ"; offset?: number } | { datum: string };
/** Extrude a closed outline (sketch u,v; expressions allowed) in `comp`. `op`
 *  true starts the component's body, false joins it. `symmetric` extrudes
 *  `distance` centred on the plane. */
async function solid(s: CadSession, comp: string, pl: Plane, pts: X[][], first: boolean, distance: X, name: string, symmetric = false) {
  const sk = (await dis(s, "sketch.create", { ...pl, component: comp, name }))[0];
  const ids: string[] = [];
  for (const [x, y] of pts) ids.push((await dis(s, "sketch.addPoint", { sketch: sk, x: String(x), y: String(y) }))[0]);
  for (let i = 0; i < ids.length; i++) await dis(s, "sketch.addLine", { sketch: sk, start: { ref: ids[i] }, end: { ref: ids[(i + 1) % ids.length] } });
  await dis(s, "feature.extrude", { sketch: sk, distance: String(distance), operation: first ? "new" : "join", name, ...(symmetric ? { symmetric: true } : {}) });
}
/** Revolve a rectangle (u radial, v = z) sketched on XZ about the Z axis. */
async function turned(s: CadSession, comp: string, r0: X, r1: X, z0: X, z1: X, first: boolean, name: string) {
  const sk = (await dis(s, "sketch.create", { plane: "XZ", component: comp, name }))[0];
  const ids: string[] = [];
  for (const [x, y] of rect(r0, z0, r1, z1)) ids.push((await dis(s, "sketch.addPoint", { sketch: sk, x: String(x), y: String(y) }))[0]);
  for (let i = 0; i < ids.length; i++) await dis(s, "sketch.addLine", { sketch: sk, start: { ref: ids[i] }, end: { ref: ids[(i + 1) % ids.length] } });
  await dis(s, "feature.revolve", { sketch: sk, axis: { p1: { x: 0, y: 0 }, p2: { x: 0, y: 1 } }, operation: first ? "new" : "join", name });
}
const rect = (x0: X, y0: X, x1: X, y1: X): X[][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** Half a blade, in a sketch whose u axis is across the pivot and whose v axis
 *  is up, with the pivot centre at (0, H). Blade A runs up along (1, 1)/√2,
 *  blade B along (−1, 1)/√2; each half runs from the crossing to EMB inside
 *  its clamp (the lower half to the base-side clamp, the upper to the moved). */
function bladeHalf(which: "A" | "B", half: "lower" | "upper"): X[][] {
  const s0 = half === "lower" ? `-(L/2 + ${EMB})` : "0", s1 = half === "lower" ? "0" : `(L/2 + ${EMB})`;
  const pt = (s: string, q: string): X[] => [which === "A" ? `(${s} - ${q})/sqrt(2)` : `(${q} - ${s})/sqrt(2)`, `H + (${s} + ${q})/sqrt(2)`];
  return [pt(s0, "-t/2"), pt(s1, "-t/2"), pt(s1, "t/2"), pt(s0, "t/2")];
}

/** The two blades of one pivot: each a datum plane square to the pivot axis at
 *  the blade's near face, so an extrude by `w` spans it. `axis` X: the planes are
 *  offsets of YZ (normal +X), the blade lies at [from, from + w]. Axis Y: offsets
 *  of XZ, whose normal is −Y, so the extrude runs from the far face. */
async function bladePlanes(s: CadSession, axis: "X" | "Y", centre: string): Promise<[string, string]> {
  const near = (from: string) => (axis === "X" ? from : `-((${from}) + w)`);
  const a = (await dis(s, "plane.create", { base: axis === "X" ? "YZ" : "XZ", offset: near(`${centre} - w - ${GAP / 2}`), name: `Blade A plane (${centre})` }))[0];
  const b = (await dis(s, "plane.create", { base: axis === "X" ? "YZ" : "XZ", offset: near(`${centre} + ${GAP / 2}`), name: `Blade B plane (${centre})` }))[0];
  return [a, b];
}

export async function buildGimbal(s: CadSession): Promise<void> {
  // the drives
  await dis(s, "parameter.add", { name: "alpha", expression: "0", min: -RANGE, max: RANGE, step: 0.5 });
  await dis(s, "parameter.add", { name: "beta", expression: "0", min: -RANGE, max: RANGE, step: 0.5 });
  // the blades
  await dis(s, "parameter.add", { name: "L", expression: String(BLADE.L), min: 10, max: 16, step: 0.5 });
  await dis(s, "parameter.add", { name: "t", expression: String(BLADE.t), min: 0.25, max: 0.6, step: 0.05 });
  await dis(s, "parameter.add", { name: "w", expression: String(BLADE.w), min: 6, max: 14, step: 1 });
  // the steer the posts are sized for: the pivots rise so the tilted ring clears the base
  await dis(s, "parameter.add", { name: "range", expression: String(RANGE), min: RANGE, max: 15, step: 1 });
  await dis(s, "parameter.add", { name: "platR", expression: String(PLAT_R), min: 36, max: 50, step: 1 });
  // derived: a blade's clamp faces sit cL above and below the crossing; a
  // pivot's two blades span ±hw along its axis; the pivots, the ring and the
  // posts step outward from the platform's edge
  await dis(s, "parameter.add", { name: "cL", expression: "L/(2*sqrt(2))" });
  await dis(s, "parameter.add", { name: "hw", expression: `w + ${GAP / 2}` });
  await dis(s, "parameter.add", { name: "pY", expression: `platR + ${CLR} + hw` });           // inner pivots at (0, ±pY, H)
  await dis(s, "parameter.add", { name: "Rin", expression: `pY + hw + ${CLR + 1}` });          // the ring's inner radius (its pad face 2 in from it)
  await dis(s, "parameter.add", { name: "Rout", expression: "Rin + 8" });
  await dis(s, "parameter.add", { name: "pX", expression: `Rout + hw + ${CLR + 2}` });         // outer pivots at (±pX, 0, H)
  await dis(s, "parameter.add", { name: "H", expression: `${BASE_T + 3} + ${RING_H}*cos(rad(range)) + Rout*sin(rad(range))` });

  const ti = (await dis(s, "material.create", { name: TI.name, kind: "metal", finish: "brushed", color: "#9aa0a6", youngsModulus: TI.E, allowableStrain: TI.strain }))[0];
  const al = (await dis(s, "material.create", { name: "Aluminium 6061", kind: "metal", finish: "satin", color: "#b9bdc3" }))[0];
  const black = (await dis(s, "material.create", { name: "Aluminium, black anodised", kind: "painted", color: "#3a3d44", roughness: 0.6 }))[0];
  const mirror = (await dis(s, "material.create", { name: "Mirror", kind: "metal", finish: "polished", color: "#e8ecf0" }))[0];
  const part = async (name: string, material: string, parent?: string) => {
    const c = (await dis(s, "component.create", { name, ...(parent ? { parent } : {}) }))[0];
    await dis(s, "material.assign", { component: c, material });
    return c;
  };
  const base = await part("Base", al), ring = await part("Ring", black), plat = await part("Platform", al);
  const mir = await part("Mirror", mirror, plat);

  // Base: a plate, and a yoke post under each outer pivot up to its clamp.
  await solid(s, base, { plane: "XY" }, rect(`-(pX + hw + 5)`, `-(Rout + 4)`, `pX + hw + 5`, `Rout + 4`), true, BASE_T, "Base plate");
  for (const sg of [1, -1]) {
    const cx = sg > 0 ? "pX" : "-pX";
    await solid(s, base, { plane: "XY" }, rect(`${cx} - hw - 1`, `-(cL + 2)`, `${cx} + hw + 1`, `cL + 2`), false, `H - cL - ${CLAMP}`, `Yoke post ${sg > 0 ? "+X" : "-X"}`);
  }
  // Ring: an annulus with a flat pad outside at each outer pivot and inside at
  // each inner pivot, for the clamps to seat on.
  await turned(s, ring, "Rin", "Rout", `H - ${RING_H}`, `H + ${RING_H}`, true, "Ring");
  // (one pad per sketch: a sketch of two disjoint rectangles joined onto the
  // revolve built a wrong solid — see the report with this example)
  await solid(s, ring, { plane: "XZ" }, rect("Rout - 2", `H - ${RING_H}`, "Rout + 2", `H + ${RING_H}`), false, "2*(cL + 3)", "Outer pad +X", true);
  await solid(s, ring, { plane: "XZ" }, rect("-(Rout + 2)", `H - ${RING_H}`, "-(Rout - 2)", `H + ${RING_H}`), false, "2*(cL + 3)", "Outer pad -X", true);
  await solid(s, ring, { plane: "YZ" }, rect("Rin - 2", `H - ${RING_H}`, "Rin + 2", `H + ${RING_H}`), false, "2*(cL + 3)", "Inner pad +Y", true);
  await solid(s, ring, { plane: "YZ" }, rect("-(Rin + 2)", `H - ${RING_H}`, "-(Rin - 2)", `H + ${RING_H}`), false, "2*(cL + 3)", "Inner pad -Y", true);
  // Platform: a disc, with the mirror on it.
  await turned(s, plat, 0, "platR", `H - ${PLAT_T}`, `H + ${PLAT_T}`, true, "Platform");
  await turned(s, mir, 0, MIRROR.r, `H + ${PLAT_T}`, `H + ${PLAT_T + MIRROR.t}`, true, "Mirror");

  // The pivots. Each clamp is its own part, rigid on the part it bolts to, and
  // carries the half of each blade on its side of the crossing.
  const flex = { kind: "flexure", flexure: { length: "L", width: "w", thickness: "t", material: ti } };
  let outer = 0, inner = 0;
  for (const sg of [1, -1]) {
    const tag = sg > 0 ? "+X" : "-X", cx = sg > 0 ? "pX" : "-pX";
    const [pa, pb] = await bladePlanes(s, "X", cx);
    // the yoke's clamp: a block on the post, below the crossing
    const yoke = await part(`Yoke clamp ${tag}`, ti, base);
    await solid(s, yoke, { plane: "XZ" }, rect(`${cx} - hw - 1`, `H - cL - ${CLAMP}`, `${cx} + hw + 1`, "H - cL"), true, "2*(cL + 2)", "Yoke clamp", true);
    await solid(s, yoke, { datum: pa }, bladeHalf("A", "lower"), false, "w", "Blade A (yoke half)");
    await solid(s, yoke, { datum: pb }, bladeHalf("B", "lower"), false, "w", "Blade B (yoke half)");
    // the ring's clamp: an arm from the ring's pad out over the crossing
    const arm = await part(`Ring clamp ${tag}`, ti, ring);
    const [x0, x1] = sg > 0 ? ["Rout + 2", "pX + hw + 1"] : ["-(pX + hw + 1)", "-(Rout + 2)"];
    await solid(s, arm, { plane: "XZ" }, rect(x0, "H + cL", x1, `H + cL + ${CLAMP}`), true, "2*(cL + 2)", "Ring arm", true);
    await solid(s, arm, { datum: pa }, bladeHalf("A", "upper"), false, "w", "Blade A (ring half)");
    await solid(s, arm, { datum: pb }, bladeHalf("B", "upper"), false, "w", "Blade B (ring half)");
    for (const blade of ["A", "B"]) {
      const at = { x: cx, y: 0, z: "H" };
      await dis(s, "joint.create", { ...flex, base, moved: ring, axis: { x: 1, y: 0, z: 0 }, baseOrigin: at, movedOrigin: at, ...(outer++ === 0 ? { value: "alpha" } : { closes: true }), name: `Outer ${tag} blade ${blade}` });
    }
  }
  for (const sg of [1, -1]) {
    const tag = sg > 0 ? "+Y" : "-Y", cy = sg > 0 ? "pY" : "-pY";
    const [pa, pb] = await bladePlanes(s, "Y", cy);
    // the ring's clamp: a block in from the ring's inner pad, below the crossing
    const block = await part(`Ring clamp ${tag}`, ti, ring);
    const [y0, y1] = sg > 0 ? ["pY - hw - 1", "Rin - 2"] : ["-(Rin - 2)", "-(pY - hw - 1)"];
    await solid(s, block, { plane: "YZ" }, rect(y0, `H - cL - ${CLAMP}`, y1, "H - cL"), true, "2*(cL + 2)", "Ring clamp", true);
    await solid(s, block, { datum: pa }, bladeHalf("A", "lower"), false, "w", "Blade A (ring half)");
    await solid(s, block, { datum: pb }, bladeHalf("B", "lower"), false, "w", "Blade B (ring half)");
    // the platform's clamp: a riser on the disc and an arm out over the crossing
    const arm = await part(`Platform clamp ${tag}`, ti, plat);
    const [r0, r1] = sg > 0 ? ["platR - 6", "platR"] : ["-platR", "-(platR - 6)"];
    const [a0, a1] = sg > 0 ? ["platR - 6", "pY + hw + 1"] : ["-(pY + hw + 1)", "-(platR - 6)"];
    await solid(s, arm, { plane: "YZ" }, rect(r0, `H + ${PLAT_T}`, r1, `H + cL + ${CLAMP}`), true, "2*(cL + 2)", "Riser", true);
    await solid(s, arm, { plane: "YZ" }, rect(a0, "H + cL", a1, `H + cL + ${CLAMP}`), false, "2*(cL + 2)", "Platform arm", true);
    await solid(s, arm, { datum: pa }, bladeHalf("A", "upper"), false, "w", "Blade A (platform half)");
    await solid(s, arm, { datum: pb }, bladeHalf("B", "upper"), false, "w", "Blade B (platform half)");
    for (const blade of ["A", "B"]) {
      const at = { x: 0, y: cy, z: "H" };
      await dis(s, "joint.create", { ...flex, base: ring, moved: plat, axis: { x: 0, y: 1, z: 0 }, baseOrigin: at, movedOrigin: at, ...(inner++ === 0 ? { value: "beta" } : { closes: true }), name: `Inner ${tag} blade ${blade}` });
    }
  }
}

const RAD = Math.PI / 180;
const scopeOf = (s: CadSession) => resolveParameters(s.doc.parameters).scope;
const byName = (s: CadSession, n: string) => Object.values(s.doc.components).find((c) => c.name === n)!.id;
/** The platform's and the ring's world frames at a steer, and the mirror's centre. */
function posed(s: CadSession, alpha: number, beta: number) {
  const params = s.doc.parameters.map((p) => (p.name === "alpha" ? { ...p, expr: String(alpha) } : p.name === "beta" ? { ...p, expr: String(beta) } : p));
  const scope = resolveParameters(params).scope;
  const world = resolveComponentWorld(s.doc, scope);
  const plat = world.get(byName(s, "Platform"))!, ring = world.get(byName(s, "Ring"))!;
  const up = { x: 0, y: 0, z: 1 };
  // where the two axes cross, on the platform; and the mirror face's centre, PLAT_T + MIRROR.t above it
  return { scope, platNormal: applyVec(plat, up), ringNormal: applyVec(ring, up), crossing: applyPoint(plat, { x: 0, y: 0, z: scope.H }), mirrorCentre: applyPoint(plat, { x: 0, y: 0, z: scope.H + PLAT_T + MIRROR.t }) };
}
/** Per-axis stiffness the blades should add up to: 4 × E·I/L (two blades per pivot, two pivots). */
const kAxis = (sc: Record<string, number>) => 4 * flexureStiffness(TI.E, { length: sc.L, width: sc.w, thickness: sc.t });
const tilt = (n: { x: number; y: number; z: number }) => Math.acos(Math.min(1, n.z / Math.hypot(n.x, n.y, n.z))) / RAD;

/** Pose the gimbal and check nothing but the split blades (a sliver at each
 *  crossing, w·t²/4·tan φ) touches. */
async function clearAt(s: CadSession, alpha: number, beta: number) {
  const params = s.doc.parameters.map((p) => (p.name === "alpha" ? { ...p, expr: String(alpha) } : p.name === "beta" ? { ...p, expr: String(beta) } : p));
  const scope = resolveParameters(params).scope;
  const doc = { ...s.doc, parameters: params, sketches: Object.fromEntries(Object.entries(s.doc.sketches).map(([k, v]) => [k, { ...v }])) };
  placeComponentSketches(doc, scope);
  const c = collideFeatures(doc, scope);
  expect(c.buildError, `alpha ${alpha} beta ${beta}`).toBeUndefined();
  const sliver = (scope.w * scope.t ** 2 / 4) * Math.tan(RANGE * RAD) + 0.05;
  for (const o of c.overlaps) expect(o.volume, `${o.a} × ${o.b} at alpha ${alpha}, beta ${beta}`).toBeLessThan(Math.max(0.2, sliver));
  await new Promise((r) => setTimeout(r, 0));
}

describe("flexure gimbal", () => {
  // one session for the file: building the recipe is quick, but every test
  // that follows only poses or re-parametrises it (the slider tests put their
  // parameter back), so it is built once here
  let s: CadSession;
  beforeAll(async () => {
    await initKernel({ wasmBinary: wasm });
    s = realSession();
    await buildGimbal(s);
    await s.recompute();
  }, 120000);

  it("builds: base, ring, platform, mirror and eight pivot clamps, touching and nowhere overlapping", async () => {
    if (OUT) writeFileSync(`${OUT}/gimbal.chisel.json`, serializeDocument(s.doc));
    for (const sk of Object.values(s.doc.sketches)) expect(sk.status.conflicting, `sketch ${sk.name}`).toBe(false);
    for (const pl of Object.values(s.doc.planes)) expect(pl.error, pl.name).toBeUndefined();
    const scope = scopeOf(s);
    placeComponentSketches(s.doc, scope);
    const bodies = Object.values(evaluateFeatures(s.doc, scope));
    for (const b of bodies) expect(b.error, b.name).toBeUndefined();
    expect(bodies.filter((b) => b.mesh).length).toBe(12);
    const rest = collideFeatures(s.doc, scope);
    for (const o of rest.overlaps) expect(o.volume, `${o.a} × ${o.b}`).toBeLessThan(0.01);
    expect(rest.maxOverlap).toBeLessThan(0.01);
    // the pivots sit where the parameters say, the mirror's face at its centre
    expect(scope.pX).toBeCloseTo(scope.Rout + scope.w + 1 + CLR + 2, 9);
    expect(scope.H).toBeCloseTo(BASE_T + 3 + RING_H * Math.cos(RANGE * RAD) + scope.Rout * Math.sin(RANGE * RAD), 9);
    const stl = exportFusedBlob(s.doc, scope, "stl");
    expect(stl && stl.size).toBeGreaterThan(10000);
    if (OUT) writeFileSync(`${OUT}/gimbal.stl`, Buffer.from(await stl!.arrayBuffer()));
    console.log(`pivots at x = ±${scope.pX}, y = ±${scope.pY}, height ${scope.H.toFixed(1)}; ring ${scope.Rin}–${scope.Rout}; blades ${scope.L} × ${scope.w} × ${scope.t} mm`);
  }, 180000);

  it("alpha tilts the ring and the mirror about X, beta the mirror about the ring's Y, about one fixed point", async () => {
    const rest = posed(s, 0, 0);
    for (const [a, b] of [[RANGE, 0], [0, RANGE], [-RANGE, RANGE], [5, -3]]) {
      const p = posed(s, a, b);
      // the ring only follows alpha; the platform's normal is Rx(alpha)·Ry(beta)·z
      expect(tilt(p.ringNormal)).toBeCloseTo(Math.abs(a), 6);
      expect(p.ringNormal.x).toBeCloseTo(0, 9);
      expect(tilt(p.platNormal)).toBeCloseTo(Math.acos(Math.cos(a * RAD) * Math.cos(b * RAD)) / RAD, 6);
      expect(Math.abs(p.platNormal.x)).toBeCloseTo(Math.abs(Math.sin(b * RAD)), 6);
      expect(Math.abs(p.platNormal.y)).toBeCloseTo(Math.abs(Math.sin(a * RAD) * Math.cos(b * RAD)), 6);
      // both axes pass through one point on the platform's centre line: it never
      // translates, and the mirror's face, 5 mm above it, swings by at most 5·sin φ
      for (const k of ["x", "y", "z"] as const) expect(p.crossing[k]).toBeCloseTo(rest.crossing[k], 6);
      const swing = Math.hypot(p.mirrorCentre.x - rest.mirrorCentre.x, p.mirrorCentre.y - rest.mirrorCentre.y, p.mirrorCentre.z - rest.mirrorCentre.z);
      expect(swing).toBeLessThanOrEqual((PLAT_T + MIRROR.t) * Math.sqrt(2 - 2 * Math.cos(a * RAD) * Math.cos(b * RAD)) + 1e-9);
      // every blade reads its axis's drive
      const st = flexureState(s.doc, { alpha: String(a), beta: String(b) });
      expect(st.error).toBeUndefined();
      expect(st.flexures.length).toBe(8);
      for (const f of st.flexures) expect(f.angle, f.name).toBeCloseTo(f.name.startsWith("Outer") ? a : b, 6);
    }
  }, 180000);

  it("at ±8° on both axes the blades stay well within Ti-6Al-4V's 0.5%: t·φ/2L = 0.2%", async () => {
    const sc = scopeOf(s);
    const expected = flexureStrain({ length: sc.L, width: sc.w, thickness: sc.t }, RANGE);
    expect(expected).toBeCloseTo((BLADE.t * RANGE * RAD) / (2 * BLADE.L), 12);
    let peak = 0;
    for (const a of [-RANGE, 0, RANGE]) for (const b of [-RANGE, 0, RANGE]) {
      const st = flexureState(s.doc, { alpha: String(a), beta: String(b) });
      expect(st.error, `alpha ${a} beta ${b}`).toBeUndefined();
      expect(st.utilisation, `alpha ${a} beta ${b}`).toBeLessThan(1);
      peak = Math.max(peak, ...st.flexures.map((f) => f.strain));
      for (const f of st.flexures) expect(f.allowable).toBe(TI.strain);
    }
    expect(peak).toBeCloseTo(expected, 9);
    expect(peak / TI.strain).toBeCloseTo(0.4, 2);
    console.log(`peak blade strain ${(peak * 100).toFixed(3)}% at ±${RANGE}° (limit ${TI.strain * 100}%)`);
  }, 180000);

  it("each axis meets 4·E·I/L ≈ 1.7 N·m/rad: the torque grows linearly, zero at rest, the same on both axes", async () => {
    const sc = scopeOf(s);
    const k = kAxis(sc);
    expect(k).toBeCloseTo((4 * TI.E * BLADE.w * BLADE.t ** 3) / (12 * BLADE.L), 6);
    expect(k / 1000).toBeGreaterThan(1.6); // N·m/rad
    expect(k / 1000).toBeLessThan(1.8);
    const angles = [-RANGE, -RANGE / 2, 0, RANGE / 2, RANGE];
    for (const drive of ["alpha", "beta"]) {
      const poses = flexureSweep(s.doc, drive, angles);
      for (const p of poses) expect(p.error, `${drive} ${p.value}`).toBeUndefined();
      expect(Math.abs(poses[2].effort)).toBeLessThan(1e-6);
      for (const p of poses) if (p.value !== 0) expect(p.effort / (p.value * RAD), `${drive} ${p.value}`).toBeCloseTo(k, 3); // N·mm per radian
      // stored energy: ½·k·φ² on the driven axis alone
      expect(poses[4].energy).toBeCloseTo(0.5 * k * (RANGE * RAD) ** 2, 6);
      console.log(`${drive}: stiffness ${(poses[4].effort / (RANGE * RAD) / 1000).toFixed(3)} N·m/rad (4·EI/L = ${(k / 1000).toFixed(3)}); torque at ${RANGE}° ${poses[4].effort.toFixed(0)} N·mm; stored ${poses[4].energy.toFixed(2)} mJ`);
    }
    // with both axes steered the energies add: no coupling in this model
    const both = flexureState(s.doc, { alpha: String(RANGE), beta: String(RANGE) });
    expect(both.energy).toBeCloseTo(k * (RANGE * RAD) ** 2, 6);
    // a thicker or shorter blade follows t³/L (no geometry rebuild: the solver reads the sections)
    for (const [L, t] of [[10, 0.6], [16, 0.25]]) {
      const q = flexureSweep({ ...s.doc, parameters: s.doc.parameters.map((x) => (x.name === "L" ? { ...x, expr: String(L) } : x.name === "t" ? { ...x, expr: String(t) } : x)) }, "alpha", [RANGE])[0];
      expect(q.effort / (RANGE * RAD)).toBeCloseTo(kAxis({ ...sc, L, t }), 3);
    }
    // what the solver has no mass for: a hand estimate of the inner axis's first
    // mode, the platform and mirror as discs (Al 2.70, glass-like 2.5 g/cm³) and
    // the two platform clamps as point masses at their blade crossings (Ti 4.43)
    const disc = (rho: number, r: number, h: number) => { const m = rho * Math.PI * r * r * h; return { m, J: m * (r * r / 4 + h * h / 12) }; };
    const plat = disc(2.70e-6, sc.platR, 2 * PLAT_T), mir = disc(2.5e-6, MIRROR.r, MIRROR.t); // kg (mm³ × kg/mm³)
    const clampM = 4.43e-6 * 2 * (sc.cL + 2) * (sc.pY + sc.hw + 1 - (sc.platR - 6)) * CLAMP;
    const J = plat.J + mir.J + 2 * clampM * sc.pY ** 2; // kg·mm²
    const f1 = Math.sqrt((k * 1e-3) / (J * 1e-6)) / (2 * Math.PI); // k: N·mm/rad → N·m/rad; J: kg·mm² → kg·m²
    console.log(`estimate (no inertia in the solver): inner axis J ≈ ${(J * 1e-6).toExponential(2)} kg·m², first mode ≈ ${f1.toFixed(0)} Hz`);
  }, 180000);

  it("clears itself at every corner of ±8° on both axes", async () => {
    for (const a of [-RANGE, RANGE]) for (const b of [-RANGE, RANGE]) await clearAt(s, a, b);
    await clearAt(s, RANGE / 2, -RANGE);
  }, 300000);

  // Each customize slider at both ends: the part still builds, sits clear at
  // rest and clears itself steered to a corner.
  for (const [name, ends] of [["L", [10, 16]], ["t", [0.25, 0.6]], ["w", [6, 14]], ["range", [RANGE, 15]], ["platR", [36, 50]]] as const) {
    it(`builds and clears itself with ${name} at ${ends[0]} and ${ends[1]}`, async () => {
      const saved = s.doc.parameters.find((p) => p.name === name)!.expr;
      for (const v of ends) {
        await dis(s, "parameter.set", { name, expression: String(v) });
        await s.recompute();
        for (const sk of Object.values(s.doc.sketches)) expect(sk.status.conflicting, `${name} = ${v}: sketch ${sk.name}`).toBe(false);
        const scope = scopeOf(s);
        placeComponentSketches(s.doc, scope);
        const bodies = Object.values(evaluateFeatures(s.doc, scope));
        for (const b of bodies) expect(b.error, `${name} = ${v}: ${b.name}`).toBeUndefined();
        expect(bodies.filter((b) => b.mesh).length).toBe(12);
        const rest = collideFeatures(s.doc, scope);
        expect(rest.buildError, `${name} = ${v}`).toBeUndefined();
        expect(rest.maxOverlap, `${name} = ${v}`).toBeLessThan(0.01);
        await clearAt(s, RANGE, RANGE);
        const st = flexureState(s.doc, { alpha: String(RANGE), beta: String(-RANGE) });
        expect(st.error).toBeUndefined();
        expect(st.utilisation, `${name} = ${v}`).toBeLessThan(1);
      }
      await dis(s, "parameter.set", { name, expression: saved }); // back to the design
      await s.recompute();
    }, 600000);
  }
});
