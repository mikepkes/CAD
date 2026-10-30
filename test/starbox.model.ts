// The androgynous snap-together star box for a claw machine, as a builder. It is
// printed in TPU, or PLA, PETG, ABS/ASA or nylon: a `material` choice sizes the
// snaps for each (see MATERIALS). ONE component, instanced twice: the second copy
// is flipped 180° about the star's symmetry axis, so its 5 barbed tongues land in
// the first copy's 5 undercut pockets (tongues and pockets alternate around the
// star's flat edges). test/starbox.build.test.ts and
// test/starbox.materials.test.ts check it, and the former writes the example:
//   BUILD_STARBOX=/abs/out npx vitest run test/starbox.build.test.ts
import { evaluateFeatures, exportFeatureBlob } from "../src/core/features";
import { importSTEP, measureVolume } from "replicad";
import { expandAssembly } from "../src/core/assembly";
import { placeComponentSketches } from "../src/core/recompute";
import { resolveParameters } from "../src/core/parameters";
import { solveBeam, rectSection } from "../src/sim/beam2d";
import type { CadSession } from "../src/core/command/session";
import type { CadDocument } from "../src/core/document";

// ---- the customize sliders (mm) ----
// `width` is across the side tips (the claw's grab), `height` the closed box.
// Everything that sizes the box follows them; the snap hardware below does not —
// its fit and strain are set by the material, not the box size.
export const WIDTH = 64, HEIGHT = 28;
export const WIDTH_RANGE = [64, 100], HEIGHT_RANGE = [22, 40];

// ---- the print material (a named choice: `material`) ----
// The snap tongue stands upright, so it bends ACROSS the print layers, the weak
// direction. Its peak strain goes as t·δ/L² and the force to deflect it as
// E·t³·δ/L³ (t thickness, δ how far the mating wall pushes the barb, L free span).
// So per material, the tongue thickness and its deflection are picked to keep the
// strain at that material's across-layer limit while the box closes and pulls open
// with about the force of the TPU 68D box that was printed and works (~13 N in,
// ~26 N out per snap, 30° lead-in, 45° retention face). Stiff plastics get a
// thinner tongue; slippier ones (lower μ) a slightly steeper lead-in, so the
// closing force stays put. Values are typical FDM ones (E and strain limit across
// the layers): tune them to your filament. The derivation is the test "sizes the
// snaps per material" below, with the beam solver.
//   E (MPa), strain: across-layer modulus and design strain limit; mu: friction
//   tRoot/tTip: tongue thickness at the root and the barb; deflect: δ at the
//   default height (it scales with the free span², so strain stays put — capped at
//   DEFLECT_MAX, which leaves 0.8 mm of wall behind the pocket); clr: fit
//   clearance; leadIn/retain: barb face angles from the closing direction (45° is
//   the steepest overhang that prints without support).
export type PrintMaterial = { name: string; E: number; strain: number; mu: number; tRoot: number; tTip: number; deflect: number; clr: number; leadIn: number; retain: number; color: string; finish: string };
export const MATERIALS: PrintMaterial[] = [
  { name: "PLA", E: 2500, strain: 0.010, mu: 0.35, tRoot: 2.5, tTip: 1.75, deflect: 0.75, clr: 0.2, leadIn: 27, retain: 45, color: "#5b8def", finish: "matte" },
  { name: "PETG", E: 1600, strain: 0.020, mu: 0.4, tRoot: 2.35, tTip: 1.6, deflect: 1.1, clr: 0.25, leadIn: 27, retain: 45, color: "#3fb6a8", finish: "gloss" },
  { name: "ABS / ASA", E: 1800, strain: 0.015, mu: 0.3, tRoot: 2.5, tTip: 1.7, deflect: 1.0, clr: 0.3, leadIn: 26, retain: 45, color: "#e05a4f", finish: "satin" },
  { name: "Nylon", E: 900, strain: 0.030, mu: 0.25, tRoot: 3.0, tTip: 2.05, deflect: 1.2, clr: 0.25, leadIn: 26, retain: 45, color: "#e8e2d0", finish: "satin" },
  { name: "TPU 68D (TPU for AMS)", E: 600, strain: 0.015, mu: 0.5, tRoot: 3.5, tTip: 2.4, deflect: 0.85, clr: 0.25, leadIn: 30, retain: 45, color: "#f2c14e", finish: "matte" },
  { name: "TPU 95A", E: 26, strain: 0.06, mu: 0.6, tRoot: 4.9, tTip: 3.4, deflect: 1.4, clr: 0.3, leadIn: 30, retain: 45, color: "#f28c4e", finish: "matte" },
];
export const DEFAULT_MATERIAL = 4; // TPU 68D: the box as printed
const DEFLECT_MAX = 1.5;

// ---- fixed design values (mm) ----
export const N = 5, RATIO = 17.7 / 39;    // valley / tip radius: the star's proportions (46° tips) at every size
const rTip = 3.5, rValley = 2.5;   // rounded tips/valleys: nothing sharp for a claw to catch
export const wall = 2.6, floor = 2;
const rBase = 1.5;                 // outer bottom-edge round
// Tongue: rooted near the floor for a long free span, thick at the root and
// thinning toward the barb along a curved back, so bending strain (∝ t/L²) is low
// and spread over many print layers instead of peaking at one. v1 (2 mm thick,
// free only above z = 13.4) reached ~10.8% strain across the layers and broke.
export const wT = 7, L = 7;               // width, rise above the rim (thickness: per material)
const zRoot = 4;                   // where the tongue leaves the wall (free span above)
const relief = 0.35;               // cut into the own wall behind the tongue: a 0.6 mm printable gap
// The barb protrudes `barb` = clearance + deflection: the undercut that holds the
// box shut (per material, above).
// Tongues sit near the valley end of each edge (a fixed distance from it): inside
// a 46° tip the inner bands of neighbouring edges converge, and the mating tongue
// would collide.
const tongueValleyDist = 6.89;
// Anti-twist keys: short, stiff, barb-free tabs on the tip half of every edge
// that carries a pocket. With all tongues on edges of one handedness, a twist one
// way slid every mating wall off its barb at once (v2 turned 3° freely and came
// apart). A key bears on the mating wall in the opposite direction to the clip on
// the same edge, so every edge resists both ways. Keys are short (4 mm) so they
// clear the other half's keys near the narrow tips; they sit a fixed distance
// from the tip, so a bigger star only opens the gap between key and tongue
// (below ~62 mm across, a key meets the other half's tongue on its edge).
const tKey = 1.6, wKey = 4.6, hKey = 4, keyTipDist = 13.3; // thickness, width, rise, centre distance from the tip

// ---- geometry, as functions of R (sharp-tip radius) and H (half height) ----
type P2 = { x: number; y: number };
const angleOf = (i: number) => ((90 + (i * 180) / N) * Math.PI) / 180;
const verts = (R: number): P2[] => Array.from({ length: 2 * N }, (_, i) => {
  const r = i % 2 ? R * RATIO : R;
  return { x: r * Math.cos(angleOf(i)), y: r * Math.sin(angleOf(i)) };
});
const unit = (p: P2): P2 => { const m = Math.hypot(p.x, p.y); return { x: p.x / m, y: p.y / m }; };
const dirOf = (k: number): P2 => { const V = verts(1); const B = V[(k + 1) % V.length]; return unit({ x: B.x - V[k].x, y: B.y - V[k].y }); };
// half the tip angle: the sharp tip's distance to a rounded tip's centre is rTip/sin of it
const halfTip = Math.acos(-(dirOf(9).x * dirOf(0).x + dirOf(9).y * dirOf(0).y)) / 2;
/** The sharp-tip radius R that puts the rounded side tips `width` apart. */
const R_EXPR = `(width/2 - ${rTip})/cos(rad(18)) + ${rTip}/sin(${halfTip})`;
/** Star offset inward by `d` (CCW outline, so the left normal points inward). */
function insetStar(R: number, d: number): P2[] {
  const V = verts(R);
  return V.map((_, k) => {
    const j = (k + V.length - 1) % V.length;
    const u1 = dirOf(j), u2 = dirOf(k);
    const n1 = { x: -u1.y, y: u1.x }, n2 = { x: -u2.y, y: u2.x };
    const c1 = V[j].x * n1.x + V[j].y * n1.y + d, c2 = V[k].x * n2.x + V[k].y * n2.y + d;
    const det = n1.x * n2.y - n1.y * n2.x;
    return { x: (c1 * n2.y - c2 * n1.y) / det, y: (n1.x * c2 - n2.x * c1) / det };
  });
}
/** Round the corner at P (edges in from `prev`, out to `next`) with radius r:
 *  tangent points, centre, and sweep (convex corners turn ccw on a CCW loop). */
function fillet(prev: P2, P: P2, next: P2, r: number) {
  const uin = unit({ x: P.x - prev.x, y: P.y - prev.y }), uout = unit({ x: next.x - P.x, y: next.y - P.y });
  const phi = Math.acos(-(uin.x * uout.x + uin.y * uout.y)); // angle between the edges at P
  const d = r / Math.tan(phi / 2), bis = unit({ x: uout.x - uin.x, y: uout.y - uin.y }), h = r / Math.sin(phi / 2);
  return { t1: { x: P.x - uin.x * d, y: P.y - uin.y * d }, t2: { x: P.x + uout.x * d, y: P.y + uout.y * d }, c: { x: P.x + bis.x * h, y: P.y + bis.y * h }, ccw: uin.x * uout.y - uin.y * uout.x > 0 };
}

// The snap's dimensions, as document parameters (set by the material).
type Snap = { clearance: number; barb: number; tongueRoot: number; tongueTip: number; leadH: number; retainDrop: number };

// Every coordinate is exactly linear in R, H and the snap dimensions, so each
// becomes an expression `c + a·R + b·H + …` in the document's parameters, fitted
// from one evaluation per variable and checked at another point (a non-linear
// coordinate fails here, loudly).
const R0 = 39, H0 = 14;
type Vars = { R: number; H: number } & Snap;
const V0: Vars = { R: R0, H: H0, clearance: 0.25, barb: 1.1, tongueRoot: 3.5, tongueTip: 2.4, leadH: 2.4, retainDrop: 1.1 };
const num = (v: number) => String(Number(v.toPrecision(12)));
function lin(f: Fn): string {
  const keys = Object.keys(V0) as (keyof Vars)[];
  const ev = (v: Vars) => f(v.R, v.H, v);
  const f0 = ev(V0), coef = keys.map((k) => ev({ ...V0, [k]: V0[k] + 1 }) - f0);
  const c = f0 - keys.reduce((sum, k, i) => sum + coef[i] * V0[k], 0);
  const V1 = Object.fromEntries(keys.map((k, i) => [k, V0[k] + 0.37 * (i + 1) - 1.3])) as Vars;
  if (Math.abs(ev(V1) - keys.reduce((sum, k, i) => sum + coef[i] * V1[k], c)) > 1e-7) throw new Error("coordinate is not linear in the parameters");
  const terms = [Math.abs(c) > 1e-12 ? num(c) : "", ...keys.map((k, i) => (Math.abs(coef[i]) > 1e-12 ? `${num(coef[i])}*${k}` : ""))].filter(Boolean);
  return terms.length ? terms.join(" + ").replace(/\+ -/g, "- ") : "0";
}

// A closed loop: each vertex is a point; `arc` makes the edge INTO that vertex a
// circular arc about `c`, swept ccw or not. Coordinates are functions of (R, H)
// and the snap dimensions.
type Fn = (R: number, H: number, m: Snap) => number;
type Vtx = { x: Fn; y: Fn; arc?: { cx: Fn; cy: Fn; ccw: boolean } };
const k_ = (v: number): Fn => () => v;

/** The rounded star (or its inset): points on each tangent, arcs at the corners. */
function starLoop(vertsAt: (R: number) => P2[], rT: number, rV: number): Vtx[] {
  const corner = (R: number, i: number) => { const V = vertsAt(R), n = V.length; return fillet(V[(i + n - 1) % n], V[i], V[(i + 1) % n], i % 2 ? rV : rT); };
  const out: Vtx[] = [];
  for (let i = 0; i < 2 * N; i++) {
    out.push({ x: (R) => corner(R, i).t1.x, y: (R) => corner(R, i).t1.y });
    out.push({ x: (R) => corner(R, i).t2.x, y: (R) => corner(R, i).t2.y, arc: { cx: (R) => corner(R, i).c.x, cy: (R) => corner(R, i).c.y, ccw: corner(R0, i).ccw } });
  }
  return out;
}

// Profiles in an edge-perpendicular plane: (inward distance from the outer star
// line, height). A sketch on a point-and-normal plane whose normal is the edge
// direction has u = the edge's left (= inward for a CCW star) and v = +Z.
const a = (m: Snap) => wall + m.clearance; // a tongue's outer face
const zb1 = (H: number, m: Snap) => H + L - m.leadH, zb0 = (H: number, m: Snap) => zb1(H, m) - 0.6; // the barb band
const rFil = 1.5; // floor-to-back fillet
const at = (x: Fn, y: Fn, arc?: Vtx["arc"]): Vtx => ({ x, y, ...(arc ? { arc } : {}) });
const reliefEnd = { cx: ((_R, _H, m) => (wall - relief + a(m)) / 2) as Fn, cy: k_(zRoot) };
// Tongue + barb: retaining face (45° prints without support), shallow lead-in
// ramp, a curved back tapering from tongueRoot to tongueTip fastest near the root (12
// segments, so the section changes from layer to layer), a filleted foot on the
// floor, and a rounded top to the relief slot.
const BACK = 12;
const TONGUE: Vtx[] = [
  at(k_(wall - 0.4), k_(floor - 0.5)),
  at((_R, _H, m) => a(m) + m.tongueRoot + rFil, k_(floor - 0.5)),
  at((_R, _H, m) => a(m) + m.tongueRoot + rFil, k_(floor)),
  at((_R, _H, m) => a(m) + m.tongueRoot, k_(floor + rFil), { cx: (_R, _H, m) => a(m) + m.tongueRoot + rFil, cy: k_(floor + rFil), ccw: false }),
  ...Array.from({ length: BACK }, (_, i) => {
    const s = (i + 1) / BACK;
    return at((_R, _H, m) => a(m) + m.tongueTip + (m.tongueRoot - m.tongueTip) * (1 - s) ** 2, (_R, H) => floor + rFil + s * (H + L - floor - rFil));
  }),
  at((_R, _H, m) => a(m) + 0.3, (_R, H) => H + L),
  at((_R, _H, m) => a(m) - m.barb, (_R, H, m) => zb1(H, m)),
  at((_R, _H, m) => a(m) - m.barb, (_R, H, m) => zb0(H, m)),
  at((_R, _H, m) => a(m), (_R, H, m) => zb0(H, m) - m.retainDrop),
  at((_R, _H, m) => a(m), k_(zRoot)),
  at(k_(wall - relief), k_(zRoot), { ...reliefEnd, ccw: false }),
  at(k_(wall - 0.4), k_(zRoot)),
];
// Relief: cut into the own wall behind the tongue (before the tongue is joined),
// so the tongue stands free of its own wall by a printable 0.6 mm, ending in the
// same half circle the tongue's foot fills up to.
const RELIEF: Vtx[] = [
  at((_R, _H, m) => a(m) + 0.5, (_R, H) => H + 0.5),
  at(k_(wall - relief), (_R, H) => H + 0.5),
  at(k_(wall - relief), k_(zRoot)),
  at((_R, _H, m) => a(m), k_(zRoot), { ...reliefEnd, ccw: true }),
  at((_R, _H, m) => a(m) + 0.5, k_(zRoot)),
];
// pocket = the barb grown by ~0.2mm, then mapped through the flip (z → 2H − z)
const POCKET: Vtx[] = ([
  [(m) => a(m) + 0.5, (H, m) => zb0(H, m) - m.retainDrop - 0.75], [(m) => a(m) - m.barb - 0.3, (H, m) => zb0(H, m) + 0.05],
  [(m) => a(m) - m.barb - 0.3, (H, m) => zb1(H, m) + 0.4], [(m) => a(m) + 0.5, (H) => H + L + 0.9],
] as [(m: Snap) => number, (H: number, m: Snap) => number][]).map(([x, z]) => at((_R, _H, m) => x(m), (_R, H, m) => 2 * H - z(H, m)));
// Key: rises hKey above the rim inside the mating wall (outer face at the same
// clearance as a tongue), fused to the own rim below; chamfered at the top so it
// leads into the mating wall.
const KEY: Vtx[] = [
  at(k_(wall - 0.4), (_R, H) => H - 2),
  at((_R, _H, m) => a(m) + tKey, (_R, H) => H - 2),
  at((_R, _H, m) => a(m) + tKey, (_R, H) => H + hKey - 0.6),
  at((_R, _H, m) => a(m) + tKey - 0.6, (_R, H) => H + hKey),
  at((_R, _H, m) => a(m) + 0.5, (_R, H) => H + hKey),
  at((_R, _H, m) => a(m), (_R, H) => H + hKey - 0.5),
  at((_R, _H, m) => a(m), (_R, H) => H),
  at(k_(wall - 0.4), (_R, H) => H),
];

// The flip (180° about the Y axis at rim height) maps edge k to edge 9-k, so the
// even edges hit one edge of each mirror pair: tongues there, pockets opposite.
const MALE = [0, 2, 4, 6, 8];

export async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

/** Draw a closed loop of expression-positioned points, lines and arcs. */
async function loop(s: CadSession, sketch: string, vs: Vtx[]) {
  const ids: string[] = [];
  for (const v of vs) ids.push((await dis(s, "sketch.addPoint", { sketch, x: lin(v.x), y: lin(v.y) }))[0]);
  for (let i = 0; i < vs.length; i++) {
    const from = ids[(i + vs.length - 1) % vs.length], to = ids[i], arc = vs[i].arc;
    if (arc) await dis(s, "sketch.addArc", { sketch, center: { x: lin(arc.cx), y: lin(arc.cy) }, start: { ref: from }, end: { ref: to }, ccw: arc.ccw });
    else await dis(s, "sketch.addLine", { sketch, start: { ref: from }, end: { ref: to } });
  }
}

/** Sketch `profile` on a plane square to edge k through the point `at` (which
 *  moves with the parameters), and extrude it `width` symmetrically. */
async function edgeFeature(s: CadSession, comp: string, k: number, atP: (R: number) => P2, profile: Vtx[], width: number, operation: "join" | "cut", name: string) {
  const u = dirOf(k);
  const plane = (await dis(s, "plane.create", { name, origin: { x: lin((R) => atP(R).x), y: lin((R) => atP(R).y), z: 0 }, normal: { x: u.x, y: u.y, z: 0 } }))[0];
  const sid = (await dis(s, "sketch.create", { component: comp, name, datum: plane }))[0];
  await loop(s, sid, profile);
  await dis(s, "feature.extrude", { sketch: sid, distance: String(width), symmetric: true, operation, name });
}

export async function buildStarBox(s: CadSession, opts: { pockets?: boolean; keys?: boolean } = {}): Promise<void> {
  await dis(s, "parameter.add", { name: "width", expression: String(WIDTH), min: WIDTH_RANGE[0], max: WIDTH_RANGE[1], step: 1 });
  await dis(s, "parameter.add", { name: "height", expression: String(HEIGHT), min: HEIGHT_RANGE[0], max: HEIGHT_RANGE[1], step: 1 });
  await dis(s, "parameter.add", { name: "R", expression: R_EXPR });     // sharp-tip radius
  await dis(s, "parameter.add", { name: "H", expression: "height/2" }); // one half's height
  // checked: the closed box (both halves); unchecked (the default): one half, as you print it
  await dis(s, "parameter.add", { name: "fullBox", expression: "0", boolean: true });
  // what it's printed in: sizes the snaps (see MATERIALS)
  await dis(s, "parameter.add", { name: "material", expression: String(DEFAULT_MATERIAL), options: MATERIALS.map((m) => m.name) });
  const pick = (f: (m: PrintMaterial) => number) => `pick(material, ${MATERIALS.map((m) => num(f(m))).join(", ")})`;
  await dis(s, "parameter.add", { name: "clearance", expression: pick((m) => m.clr) });
  await dis(s, "parameter.add", { name: "tongueRoot", expression: pick((m) => m.tRoot) });
  await dis(s, "parameter.add", { name: "tongueTip", expression: pick((m) => m.tTip) });
  await dis(s, "parameter.add", { name: "leadIn", expression: pick((m) => m.leadIn) });     // degrees from the closing direction,
  await dis(s, "parameter.add", { name: "retention", expression: pick((m) => m.retain) }); // at the default height
  // how far the mating wall pushes the barb: the material's value at the default
  // height, scaled with the tongue's free span² (root to barb) so its strain stays put
  await dis(s, "parameter.add", { name: "deflection0", expression: pick((m) => m.deflect) });
  await dis(s, "parameter.add", { name: "leadH", expression: "(clearance + deflection0 + 0.3)/tan(rad(leadIn))" }); // the lead-in ramp's height
  const span = (H: string | number) => `(${H} + ${num(L - zRoot - 0.3)} - leadH)`;
  await dis(s, "parameter.add", { name: "deflection", expression: `min(${DEFLECT_MAX}, deflection0 * (${span("H")}/${span(H0)})^2)` });
  await dis(s, "parameter.add", { name: "barb", expression: "clearance + deflection" });
  await dis(s, "parameter.add", { name: "retainDrop", expression: "barb/tan(rad(retention))" }); // the retaining face's height
  const half = (await dis(s, "component.create", { name: "Star half" }))[0];
  const mats: string[] = [];
  for (const m of MATERIALS) mats.push((await dis(s, "material.create", { name: m.name, kind: "plastic", finish: m.finish, color: m.color, youngsModulus: m.E, allowableStrain: m.strain }))[0]);
  await dis(s, "material.assign", { component: half, materials: mats, by: "material" });

  // shell: rounded star prism, softened bottom edge, cavity cut from the floor up
  const outer = (await dis(s, "sketch.create", { plane: "XY", component: half, name: "Star" }))[0];
  await loop(s, outer, starLoop(verts, rTip, rValley));
  await dis(s, "feature.extrude", { sketch: outer, distance: "H", name: "Shell" });
  await dis(s, "feature.fillet", { radius: String(rBase), edges: { inPlane: { plane: "XY", offset: 0 } }, name: "Base round" });
  const inner = (await dis(s, "sketch.create", { plane: "XY", offset: floor, component: half, name: "Cavity" }))[0];
  // inset of a rounded outline: tip radii shrink by the wall, valley radii grow
  await loop(s, inner, starLoop((R) => insetStar(R, wall), rTip - wall, rValley + wall));
  await dis(s, "feature.extrude", { sketch: inner, distance: "H", operation: "cut", name: "Cavity" });

  for (const k of MALE) {
    const u = dirOf(k), j = 9 - k, uj = dirOf(j);
    // even edges run tip → valley: the tongue sits tongueValleyDist short of the valley
    const c = (R: number) => { const B = verts(R)[k + 1]; return { x: B.x - tongueValleyDist * u.x, y: B.y - tongueValleyDist * u.y }; };
    await edgeFeature(s, half, k, c, RELIEF, wT + 1, "cut", `Relief ${k}`);
    await edgeFeature(s, half, k, c, TONGUE, wT, "join", `Tongue ${k}`);
    // the mirror edge's pocket sits where the flipped copy's tongue lands: x → −x
    if (opts.pockets !== false) await edgeFeature(s, half, j, (R) => ({ x: -c(R).x, y: c(R).y }), POCKET, wT + 1, "cut", `Pocket ${j}`);
    // ...and a key on that edge's tip half (odd edges run valley → tip)
    if (opts.keys !== false) {
      const kc = (R: number) => { const T = verts(R)[(j + 1) % (2 * N)]; return { x: T.x - keyTipDist * uj.x, y: T.y - keyTipDist * uj.y }; };
      await edgeFeature(s, half, j, kc, KEY, wKey, "join", `Key ${j}`);
    }
  }

  await dis(s, "component.connector", { component: half, name: "seat", origin: { x: 0, y: 0, z: 0 } });
  // seated at the closed height and turned half a turn about the ground's Y axis,
  // a point at z lands at height − z: the copy's rim meets this rim
  await dis(s, "component.connector", { component: half, name: "flip", origin: { x: 0, y: 0, z: "height" } });
  const pair = (await dis(s, "assembly.pattern", { source: half, count: "1 + fullBox", name: "Box" }))[0];
  await dis(s, "joint.template", { pattern: pair, kind: "rigid", base: { role: "root", origin: { x: 0, y: 0, z: 0 } }, moved: { role: "self", component: half, port: "seat" }, appliesTo: "first", name: "Bottom" });
  // the same part, flipped onto the first about the star's symmetry axis
  await dis(s, "joint.template", { pattern: pair, kind: "revolute", base: { role: "root", origin: { x: 0, y: 0, z: 0 } }, moved: { role: "self", component: half, port: "flip" }, axis: { x: 0, y: 1, z: 0 }, value: "180", appliesTo: "rest", name: "Top (flipped)" });
}

/** Tick the fullBox checkbox: show both halves, closed. */
export async function closeBox(s: CadSession): Promise<void> {
  await dis(s, "parameter.set", { name: "fullBox", expression: "1" });
  await s.recompute();
}

export function expanded(s: CadSession): { doc: CadDocument; scope: ReturnType<typeof resolveParameters>["scope"] } {
  const scope = resolveParameters(s.doc.parameters).scope;
  const doc = expandAssembly(s.doc, scope);
  placeComponentSketches(doc, scope);
  return { doc, scope };
}

/** Interference (mm³) between the half and a flipped copy twisted by each angle
 *  (degrees) about the vertical axis — how far the closed box can be wrung. */
export async function twistOverlaps(s: CadSession, angles: number[]): Promise<number[]> {
  const scope = resolveParameters(s.doc.parameters).scope;
  const H = scope.H;
  placeComponentSketches(s.doc, scope);
  const src = Object.values(evaluateFeatures(s.doc, scope)).filter((b) => b.mesh);
  const half = await importSTEP(exportFeatureBlob(s.doc, scope, src[0].featureId, "step")!);
  return angles.map((th) => {
    const top = half.clone().rotate(180, [0, 0, H], [0, 1, 0]).rotate(th, [0, 0, 0], [0, 0, 1]);
    try { return measureVolume(half.clone().intersect(top)); } catch { return 0; } // disjoint
  });
}

/** One snap tongue as the document sizes it, through the beam solver: a tapered
 *  cantilever free from zRoot to the barb band (its back as in TONGUE), pushed
 *  `deflection` by the mating wall. Bending across the layers, so E is the
 *  material's across-layer modulus. Linear-elastic and with the mating wall rigid:
 *  an upper bound (the wall's free top edge bows and takes a share). */
export function tongueBeam(scope: Record<string, number>, E: number): { force: number; strain: number } {
  const H = scope.H, len = H + L - scope.leadH - 0.3 - zRoot, n = 40, z0 = floor + rFil;
  const t = (z: number) => { const u = (z - z0) / (H + L - z0); return scope.tongueTip + (scope.tongueRoot - scope.tongueTip) * (1 - u) ** 2; };
  const r = solveBeam({
    nodes: Array.from({ length: n + 1 }, (_, k) => ({ x: (len * k) / n, y: 0 })),
    elements: Array.from({ length: n }, (_, k) => ({ a: k, b: k + 1, ...rectSection(E, wT, t(zRoot + (len * (k + 0.5)) / n)) })),
    fixed: [{ node: 0, dof: 0 }, { node: 0, dof: 1 }, { node: 0, dof: 2 }],
  }, { prescribed: [{ node: n, dof: 1, value: scope.deflection }] });
  if (!r.converged) throw new Error("beam did not converge");
  return { force: r.reactions[`${n}:1`], strain: Math.max(...r.elements.map((e) => e.maxStrain)) };
}

/** Force along the closing direction to ride a barb face at `deg` from it, for a
 *  tongue that pushes back with P (the classic snap-fit W = P(μ + tan α)/(1 − μ tan α)). */
export const faceForce = (P: number, mu: number, deg: number) => { const t = Math.tan((deg * Math.PI) / 180); return (P * (mu + t)) / (1 - mu * t); };

/** The document's parameters for a material and height, without a rebuild. */
export function snapScope(s: CadSession, material: number, height: number): Record<string, number> {
  const set: Record<string, string> = { material: String(material), height: String(height) };
  return resolveParameters(s.doc.parameters.map((p) => (p.name in set ? { ...p, expr: set[p.name] } : p))).scope;
}

/** Closed-mesh volume (divergence theorem). */
export function meshVolume(pos: ArrayLike<number>, idx: ArrayLike<number>): number {
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const [p, q, r] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3];
    v += pos[p] * (pos[q + 1] * pos[r + 2] - pos[q + 2] * pos[r + 1])
      - pos[p + 1] * (pos[q] * pos[r + 2] - pos[q + 2] * pos[r])
      + pos[p + 2] * (pos[q] * pos[r + 1] - pos[q + 1] * pos[r]);
  }
  return Math.abs(v / 6);
}

