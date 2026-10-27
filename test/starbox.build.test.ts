// End-to-end: an androgynous snap-together star box for a claw machine, printed
// in TPU. ONE component, instanced twice: the second copy is flipped 180° about
// the star's symmetry axis, so its 5 barbed tongues land in the first copy's 5
// undercut pockets (tongues and pockets alternate around the star's flat edges).
// Proves the two copies close without interpenetrating, and that the snaps are
// real: without the pockets, the barbs dig into the mating wall.
//   BUILD_STARBOX=/abs/out npx vitest run test/starbox.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, sessionFromDoc } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { deserializeDocument, serializeDocument } from "../src/core/persistence";
import { collideFeatures, evaluateFeatures, exportFeatureBlob } from "../src/core/features";
import { importSTEP, measureVolume } from "replicad";
import { expandAssembly, instanceSolids } from "../src/core/assembly";
import { placeComponentSketches } from "../src/core/recompute";
import { resolveParameters } from "../src/model/parameters";
import type { CadSession } from "../src/core/command/session";
import type { CadDocument } from "../src/core/document";

const OUT = process.env.BUILD_STARBOX || "";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

// ---- the customize sliders (mm) ----
// `width` is across the side tips (the claw's grab), `height` the closed box.
// Everything that sizes the box follows them; the snap hardware below does not —
// its fit and strain are set by the material, not the box size.
const WIDTH = 64, HEIGHT = 28;
const WIDTH_RANGE = [64, 100], HEIGHT_RANGE = [22, 40];

// ---- fixed design values (mm) ----
const N = 5, RATIO = 17.7 / 39;    // valley / tip radius: the star's proportions (46° tips) at every size
const rTip = 3.5, rValley = 2.5;   // rounded tips/valleys: nothing sharp for a claw to catch
const wall = 2.6, floor = 2;
const rBase = 1.5;                 // outer bottom-edge round
const clr = 0.25;                  // tongue-to-mating-wall clearance
// Tongue: rooted near the floor for a long free span, thick at the root and
// thinning toward the barb along a curved back, so bending strain (∝ t/L²) is low
// and spread over many print layers instead of peaking at one. v1 (2 mm thick,
// free only above z = 13.4) reached ~10.8% strain across the layers and broke.
const tRoot = 3.5, tTip = 2.4, wT = 7, L = 7; // root/tip thickness, width, rise above the rim
const zRoot = 4;                   // where the tongue leaves the wall (free span above)
const relief = 0.35;               // cut into the own wall behind the tongue: a 0.6 mm printable gap
const bh = 1.1;                    // barb protrusion: the undercut that holds the box shut
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

// Every coordinate is exactly linear in R and H, so each becomes an expression
// `c + a·R + b·H` in the document's parameters, fitted from three evaluations and
// checked against a fourth (a non-linear coordinate fails here, loudly).
const R0 = 39, H0 = 14;
const num = (v: number) => String(Number(v.toPrecision(12)));
function lin(f: (R: number, H: number) => number): string {
  const f0 = f(R0, H0), a = f(R0 + 1, H0) - f0, b = f(R0, H0 + 1) - f0, c = f0 - a * R0 - b * H0;
  const R1 = R0 + 7.3, H1 = H0 - 2.1;
  if (Math.abs(f(R1, H1) - (c + a * R1 + b * H1)) > 1e-7) throw new Error("coordinate is not linear in R and H");
  const terms = [Math.abs(c) > 1e-12 ? num(c) : "", Math.abs(a) > 1e-12 ? `${num(a)}*R` : "", Math.abs(b) > 1e-12 ? `${num(b)}*H` : ""].filter(Boolean);
  return terms.length ? terms.join(" + ").replace(/\+ -/g, "- ") : "0";
}

// A closed loop: each vertex is a point; `arc` makes the edge INTO that vertex a
// circular arc about `c`, swept ccw or not. Coordinates are functions of (R, H).
type Fn = (R: number, H: number) => number;
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
const a = wall + clr;
const zb1 = (H: number) => H + L - 2.4, zb0 = (H: number) => zb1(H) - 0.6;
const rFil = 1.5; // floor-to-back fillet
const at = (x: Fn, y: Fn, arc?: Vtx["arc"]): Vtx => ({ x, y, ...(arc ? { arc } : {}) });
const reliefEnd = { cx: k_((wall - relief + a) / 2), cy: k_(zRoot) };
// Tongue + barb: 45° retaining face (prints without support), shallow lead-in
// ramp, a curved back tapering from tRoot to tTip fastest near the root (12
// segments, so the section changes from layer to layer), a filleted foot on the
// floor, and a rounded top to the relief slot.
const BACK = 12;
const TONGUE: Vtx[] = [
  at(k_(wall - 0.4), k_(floor - 0.5)),
  at(k_(a + tRoot + rFil), k_(floor - 0.5)),
  at(k_(a + tRoot + rFil), k_(floor)),
  at(k_(a + tRoot), k_(floor + rFil), { cx: k_(a + tRoot + rFil), cy: k_(floor + rFil), ccw: false }),
  ...Array.from({ length: BACK }, (_, i) => {
    const s = (i + 1) / BACK;
    return at(k_(a + tTip + (tRoot - tTip) * (1 - s) ** 2), (_R, H) => floor + rFil + s * (H + L - floor - rFil));
  }),
  at(k_(a + 0.3), (_R, H) => H + L),
  at(k_(a - bh), (_R, H) => zb1(H)),
  at(k_(a - bh), (_R, H) => zb0(H)),
  at(k_(a), (_R, H) => zb0(H) - bh),
  at(k_(a), k_(zRoot)),
  at(k_(wall - relief), k_(zRoot), { ...reliefEnd, ccw: false }),
  at(k_(wall - 0.4), k_(zRoot)),
];
// Relief: cut into the own wall behind the tongue (before the tongue is joined),
// so the tongue stands free of its own wall by a printable 0.6 mm, ending in the
// same half circle the tongue's foot fills up to.
const RELIEF: Vtx[] = [
  at(k_(a + 0.5), (_R, H) => H + 0.5),
  at(k_(wall - relief), (_R, H) => H + 0.5),
  at(k_(wall - relief), k_(zRoot)),
  at(k_(a), k_(zRoot), { ...reliefEnd, ccw: true }),
  at(k_(a + 0.5), k_(zRoot)),
];
// pocket = the barb grown by ~0.2mm, then mapped through the flip (z → 2H − z)
const POCKET: Vtx[] = ([
  [a + 0.5, (H: number) => zb0(H) - bh - 0.75], [a - bh - 0.3, (H: number) => zb0(H) + 0.05],
  [a - bh - 0.3, (H: number) => zb1(H) + 0.4], [a + 0.5, (H: number) => H + L + 0.9],
] as [number, (H: number) => number][]).map(([x, z]) => at(k_(x), (_R, H) => 2 * H - z(H)));
// Key: rises hKey above the rim inside the mating wall (outer face at the same
// clearance as a tongue), fused to the own rim below; chamfered at the top so it
// leads into the mating wall.
const KEY: Vtx[] = [
  at(k_(wall - 0.4), (_R, H) => H - 2),
  at(k_(a + tKey), (_R, H) => H - 2),
  at(k_(a + tKey), (_R, H) => H + hKey - 0.6),
  at(k_(a + tKey - 0.6), (_R, H) => H + hKey),
  at(k_(a + 0.5), (_R, H) => H + hKey),
  at(k_(a), (_R, H) => H + hKey - 0.5),
  at(k_(a), (_R, H) => H),
  at(k_(wall - 0.4), (_R, H) => H),
];

// The flip (180° about the Y axis at rim height) maps edge k to edge 9-k, so the
// even edges hit one edge of each mirror pair: tongues there, pockets opposite.
const MALE = [0, 2, 4, 6, 8];

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
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

async function buildStarBox(s: CadSession, opts: { pockets?: boolean; keys?: boolean } = {}): Promise<void> {
  await dis(s, "parameter.add", { name: "width", expression: String(WIDTH), min: WIDTH_RANGE[0], max: WIDTH_RANGE[1], step: 1 });
  await dis(s, "parameter.add", { name: "height", expression: String(HEIGHT), min: HEIGHT_RANGE[0], max: HEIGHT_RANGE[1], step: 1 });
  await dis(s, "parameter.add", { name: "R", expression: R_EXPR });     // sharp-tip radius
  await dis(s, "parameter.add", { name: "H", expression: "height/2" }); // one half's height
  const half = (await dis(s, "component.create", { name: "Star half" }))[0];
  const tpu = (await dis(s, "material.create", { name: "TPU", kind: "plastic", finish: "matte", color: "#f2c14e" }))[0];
  await dis(s, "material.assign", { material: tpu, component: half });

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
  const pair = (await dis(s, "assembly.pattern", { source: half, count: 2, name: "Box" }))[0];
  await dis(s, "joint.template", { pattern: pair, kind: "rigid", base: { role: "root", origin: { x: 0, y: 0, z: 0 } }, moved: { role: "self", component: half, port: "seat" }, appliesTo: "first", name: "Bottom" });
  // the same part, flipped onto the first about the star's symmetry axis
  await dis(s, "joint.template", { pattern: pair, kind: "revolute", base: { role: "root", origin: { x: 0, y: 0, z: 0 } }, moved: { role: "self", component: half, port: "flip" }, axis: { x: 0, y: 1, z: 0 }, value: "180", appliesTo: "rest", name: "Top (flipped)" });
}

function expanded(s: CadSession): { doc: CadDocument; scope: ReturnType<typeof resolveParameters>["scope"] } {
  const scope = resolveParameters(s.doc.parameters).scope;
  const doc = expandAssembly(s.doc, scope);
  placeComponentSketches(doc, scope);
  return { doc, scope };
}

/** Interference (mm³) between the half and a flipped copy twisted by each angle
 *  (degrees) about the vertical axis — how far the closed box can be wrung. */
async function twistOverlaps(s: CadSession, angles: number[]): Promise<number[]> {
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

/** Closed-mesh volume (divergence theorem). */
function meshVolume(pos: ArrayLike<number>, idx: ArrayLike<number>): number {
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const [p, q, r] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3];
    v += pos[p] * (pos[q + 1] * pos[r + 2] - pos[q + 2] * pos[r + 1])
      - pos[p + 1] * (pos[q] * pos[r + 2] - pos[q + 2] * pos[r])
      + pos[p + 2] * (pos[q] * pos[r + 1] - pos[q + 1] * pos[r]);
  }
  return Math.abs(v / 6);
}

describe("androgynous snap-together star box", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("two copies of one part close into a 64×61×28 star without interpenetrating", async () => {
    const s = realSession();
    await buildStarBox(s);
    await s.recompute();
    if (OUT) writeFileSync(`${OUT}/starbox.chisel.json`, serializeDocument(s.doc));

    const { doc, scope } = expanded(s);
    const bodies = Object.values(evaluateFeatures(doc, scope)).filter((b) => b.mesh);
    expect(bodies.length).toBe(2);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const body of bodies) {
      const p = body.mesh!.positions;
      for (let i = 0; i < p.length; i++) { lo[i % 3] = Math.min(lo[i % 3], p[i]); hi[i % 3] = Math.max(hi[i % 3], p[i]); }
      // shell + 5 tongues − cavity − 5 pockets − base round
      expect(meshVolume(p, body.mesh!.indices)).toBeGreaterThan(12000);
      expect(meshVolume(p, body.mesh!.indices)).toBeLessThan(12600);
    }
    expect(hi[0] - lo[0]).toBeCloseTo(64, 0);
    expect(hi[1] - lo[1]).toBeCloseTo(61.2, 0);
    expect(hi[2] - lo[2]).toBeCloseTo(HEIGHT, 1); // the halves meet rim to rim

    const c = collideFeatures(doc, scope);
    expect(c.buildError).toBeUndefined();
    expect(c.maxOverlap).toBeLessThan(0.05);
  }, 180000);

  // Regression: the rebuild path (collision, motion study) used to drop cloned
  // offset/face sketch planes onto XY and skip sketch-less modifiers (the base
  // round), so its instances differed from what the render path showed.
  it("the rebuild path builds the same two halves as the mesh-instancing path", async () => {
    const s = realSession();
    await buildStarBox(s);
    await s.recompute();
    const { doc, scope } = expanded(s);
    const rebuilt = evaluateFeatures(doc, scope);
    placeComponentSketches(s.doc, scope);
    const fast = Object.values(instanceSolids(s.doc, scope, evaluateFeatures(s.doc, scope))).filter((b) => b.mesh);
    expect(fast.length).toBe(2);
    for (const f of fast) {
      const r = rebuilt[f.featureId];
      expect(r?.error).toBeUndefined();
      expect(r.volume!).toBeCloseTo(f.volume!, 0);
      for (const k of ["min", "max"] as const) for (const ax of ["x", "y", "z"] as const) expect(r.bounds![k][ax]).toBeCloseTo(f.bounds![k][ax], 1); // tessellation differs with orientation
    }
  }, 180000);

  it("the committed example (public/examples/starbox.json) loads and closes cleanly", async () => {
    const json = readFileSync(fileURLToPath(new URL("../public/examples/starbox.json", import.meta.url)), "utf8");
    const s = sessionFromDoc(deserializeDocument(json));
    await s.recompute(); // replays operations → derived state, as the app's load path does
    const { doc, scope } = expanded(s);
    expect(Object.values(evaluateFeatures(doc, scope)).filter((b) => b.mesh).length).toBe(2);
    const c = collideFeatures(doc, scope);
    expect(c.buildError).toBeUndefined();
    expect(c.maxOverlap).toBeLessThan(0.05);
  }, 180000);

  it("twisting the closed box either way binds: each edge has a clip and an opposing key", async () => {
    const s = realSession();
    await buildStarBox(s);
    await s.recompute();
    const [neg, zero, pos] = await twistOverlaps(s, [-1.5, 0, 1.5]);
    console.log(`twist with keys: -1.5° ${neg.toFixed(2)} mm³, 0° ${zero.toFixed(2)}, +1.5° ${pos.toFixed(2)}`);
    expect(zero).toBeLessThan(0.05);
    expect(neg).toBeGreaterThan(1);
    expect(pos).toBeGreaterThan(1);
  }, 180000);

  // The v2 failure, kept as a check that the keys are what fixes it.
  it("without the keys, a twist one way slides every barb free", async () => {
    const s = realSession();
    await buildStarBox(s, { keys: false });
    await s.recompute();
    const [neg, pos] = await twistOverlaps(s, [-1.5, 3]);
    console.log(`twist without keys: -1.5° ${neg.toFixed(2)} mm³, +3° ${pos.toFixed(2)}`);
    expect(neg).toBeGreaterThan(1);
    expect(pos).toBeLessThan(0.05);
  }, 180000);

  // Size and height are customize sliders: every corner of their range must
  // still close cleanly, measure what was asked for, and resist a twist.
  for (const width of WIDTH_RANGE) for (const height of HEIGHT_RANGE) {
    it(`stays sound at width ${width} × height ${height}`, async () => {
      const s = realSession();
      await buildStarBox(s);
      await dis(s, "parameter.set", { name: "width", expression: String(width) });
      await dis(s, "parameter.set", { name: "height", expression: String(height) });
      await s.recompute();
      const { doc, scope } = expanded(s);
      const bodies = Object.values(evaluateFeatures(doc, scope)).filter((b) => b.mesh);
      expect(bodies.length).toBe(2);
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const b of bodies) for (let i = 0; i < b.mesh!.positions.length; i++) { lo[i % 3] = Math.min(lo[i % 3], b.mesh!.positions[i]); hi[i % 3] = Math.max(hi[i % 3], b.mesh!.positions[i]); }
      expect(hi[0] - lo[0]).toBeCloseTo(width, 1);
      expect(hi[2] - lo[2]).toBeCloseTo(height, 1);
      const c = collideFeatures(doc, scope);
      expect(c.buildError).toBeUndefined();
      expect(c.maxOverlap, JSON.stringify(c.overlaps)).toBeLessThan(0.05);
      const [neg, pos] = await twistOverlaps(s, [-1.5, 1.5]);
      expect(neg).toBeGreaterThan(1);
      expect(pos).toBeGreaterThan(1);
    }, 300000);
  }

  it("the snaps engage: without the pockets every barb digs into the mating wall", async () => {
    const s = realSession();
    await buildStarBox(s, { pockets: false });
    await s.recompute();
    const { doc, scope } = expanded(s);
    const c = collideFeatures(doc, scope);
    // ~9mm³ of barb sits behind the 2.15mm lip at each of the 10 snaps
    expect(c.maxOverlap).toBeGreaterThan(60);
  }, 180000);
});
