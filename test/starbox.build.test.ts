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

// ---- dimensions (mm) ----
const Ro = 39, Ri = 17.7, N = 5;   // true 5-point star; ~64mm across once the tips are rounded
const rTip = 3.5, rValley = 2.5;   // rounded tips/valleys: nothing sharp for a claw to catch
const wall = 2.6, floor = 2, H = 14; // half height → 28mm closed
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
// Tongues sit toward the valley end of each edge: inside a 46° tip the inner
// bands of neighbouring edges converge, and the mating tongue would collide.
const sAlong = 6.5;
// Anti-twist keys: short, stiff, barb-free tabs on the tip half of every edge
// that carries a pocket. With all tongues on edges of one handedness, a twist one
// way slid every mating wall off its barb at once (v2 turned 3° freely and came
// apart). A key bears on the mating wall in the opposite direction to the clip on
// the same edge, so every edge resists both ways. Keys are short (4 mm) so they
// clear the other half's keys near the narrow tips.
const tKey = 1.6, wKey = 4.6, hKey = 4, keyTipDist = 13.3; // thickness, width, rise, centre distance from the tip

type P2 = { x: number; y: number };
const V: P2[] = Array.from({ length: 2 * N }, (_, i) => {
  const r = i % 2 ? Ri : Ro, a = ((90 + (i * 180) / N) * Math.PI) / 180;
  return { x: r * Math.cos(a), y: r * Math.sin(a) };
});
const dirOf = (k: number) => {
  const A = V[k], B = V[(k + 1) % V.length], d = Math.hypot(B.x - A.x, B.y - A.y);
  return { x: (B.x - A.x) / d, y: (B.y - A.y) / d };
};
/** Star offset inward by `d` (CCW outline, so the left normal points inward). */
function insetStar(d: number): P2[] {
  return V.map((_, k) => {
    const j = (k + V.length - 1) % V.length;
    const u1 = dirOf(j), u2 = dirOf(k);
    const n1 = { x: -u1.y, y: u1.x }, n2 = { x: -u2.y, y: u2.x };
    const c1 = V[j].x * n1.x + V[j].y * n1.y + d, c2 = V[k].x * n2.x + V[k].y * n2.y + d;
    const det = n1.x * n2.y - n1.y * n2.x;
    return { x: (c1 * n2.y - c2 * n1.y) / det, y: (n1.x * c2 - n2.x * c1) / det };
  });
}

// Profiles in an edge-perpendicular plane: (inward distance from the outer star
// line, height). A sketch on planeDef{normal: edge direction} has u = the edge's
// left (= inward for a CCW star) and v = +Z, so these are sketch coords directly.
type Seg = P2 & { via?: P2 };
const a = wall + clr;
const zb1 = H + L - 2.4, zb0 = zb1 - 0.6;
const rFil = 1.5; // floor-to-back fillet
// Tongue + barb: 45° retaining face (prints without support), shallow lead-in
// ramp, a curved back (a 3-point arc whose thickness falls fastest near the
// root), a filleted foot on the floor, and a rounded top to the relief slot.
const TONGUE: Seg[] = [
  { x: wall - 0.4, y: floor - 0.5 },
  { x: a + tRoot + rFil, y: floor - 0.5 },
  { x: a + tRoot + rFil, y: floor },
  { x: a + tRoot, y: floor + rFil, via: { x: a + tRoot + rFil * (1 - Math.SQRT1_2), y: floor + rFil * (1 - Math.SQRT1_2) } },
  { x: a + tTip, y: H + L, via: { x: a + tTip + (tRoot - tTip) * 0.25, y: (floor + rFil + H + L) / 2 } },
  { x: a + 0.3, y: H + L },
  { x: a - bh, y: zb1 },
  { x: a - bh, y: zb0 },
  { x: a, y: zb0 - bh },
  { x: a, y: zRoot },
  // the relief slot's rounded end (a half circle across the 0.6 mm gap)
  { x: wall - relief, y: zRoot, via: { x: (wall - relief + a) / 2, y: zRoot - (a - wall + relief) / 2 } },
  { x: wall - 0.4, y: zRoot },
];
// Relief: cut into the own wall behind the tongue (before the tongue is joined),
// so the tongue stands free of its own wall by a printable 0.6 mm, ending in the
// same half circle the tongue's foot fills up to.
const RELIEF: Seg[] = [
  { x: a + 0.5, y: H + 0.5 },
  { x: wall - relief, y: H + 0.5 },
  { x: wall - relief, y: zRoot },
  { x: a, y: zRoot, via: { x: (wall - relief + a) / 2, y: zRoot - (a - wall + relief) / 2 } },
  { x: a + 0.5, y: zRoot },
];
// pocket = the barb grown by ~0.2mm, then mapped through the flip (z → 2H - z)
const POCKET: Seg[] = [
  [a + 0.5, zb0 - bh - 0.75], [a - bh - 0.3, zb0 + 0.05], [a - bh - 0.3, zb1 + 0.4], [a + 0.5, H + L + 0.9],
].map(([x, z]) => ({ x, y: 2 * H - z }));

// Key: rises hKey above the rim inside the mating wall (outer face at the same
// clearance as a tongue), fused to the own rim below; chamfered at the top so it
// leads into the mating wall.
const KEY: Seg[] = [
  { x: wall - 0.4, y: H - 2 },
  { x: a + tKey, y: H - 2 },
  { x: a + tKey, y: H + hKey - 0.6 },
  { x: a + tKey - 0.6, y: H + hKey },
  { x: a + 0.5, y: H + hKey },
  { x: a, y: H + hKey - 0.5 },
  { x: a, y: H },
  { x: wall - 0.4, y: H },
];

// The flip (180° about the Y axis at rim height) maps edge k to edge 9-k, so the
// even edges hit one edge of each mirror pair: tongues there, pockets opposite.
const MALE = [0, 2, 4, 6, 8];

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

/** A star polyline with rounded tips (even corners) and valleys (odd corners). */
async function roundedStar(s: CadSession, sketch: string, pts: P2[], rT: number, rV: number) {
  const ids = await dis(s, "sketch.addPolyline", { sketch, points: pts });
  const corners = ids.slice(pts.length); // createdIds = [...lines, ...points]
  await dis(s, "sketch.filletCorners", { sketch, points: corners.filter((_, i) => i % 2 === 0), size: rT });
  await dis(s, "sketch.filletCorners", { sketch, points: corners.filter((_, i) => i % 2 === 1), size: rV });
}

/** Sketch `profile` on the plane through `at` normal to edge k, extrude it `width` symmetrically. */
async function edgeFeature(s: CadSession, comp: string, k: number, at: P2, profile: Seg[], width: number, operation: "join" | "cut", name: string) {
  const u = dirOf(k);
  const sid = (await dis(s, "sketch.create", { component: comp, name, planeDef: { origin: { x: at.x, y: at.y, z: 0 }, normal: { x: u.x, y: u.y, z: 0 } } }))[0];
  await dis(s, "sketch.addProfile", { sketch: sid, segments: profile });
  await dis(s, "feature.extrude", { sketch: sid, distance: String(width), symmetric: true, operation, name });
}

async function buildStarBox(s: CadSession, opts: { pockets?: boolean; keys?: boolean } = {}): Promise<void> {
  const half = (await dis(s, "component.create", { name: "Star half" }))[0];
  const tpu = (await dis(s, "material.create", { name: "TPU", kind: "plastic", finish: "matte", color: "#f2c14e" }))[0];
  await dis(s, "material.assign", { material: tpu, component: half });

  // shell: rounded star prism, softened bottom edge, cavity cut from the floor up
  const outer = (await dis(s, "sketch.create", { plane: "XY", component: half, name: "Star" }))[0];
  await roundedStar(s, outer, V, rTip, rValley);
  await dis(s, "feature.extrude", { sketch: outer, distance: String(H), name: "Shell" });
  await dis(s, "feature.fillet", { radius: String(rBase), edges: { inPlane: { plane: "XY", offset: 0 } }, name: "Base round" });
  const inner = (await dis(s, "sketch.create", { plane: "XY", offset: floor, component: half, name: "Cavity" }))[0];
  // inset of a rounded outline: tip radii shrink by the wall, valley radii grow
  await roundedStar(s, inner, insetStar(wall), rTip - wall, rValley + wall);
  await dis(s, "feature.extrude", { sketch: inner, distance: String(H), operation: "cut", name: "Cavity" });

  for (const k of MALE) {
    const A = V[k], B = V[k + 1], u = dirOf(k);
    const c = { x: (A.x + B.x) / 2 + sAlong * u.x, y: (A.y + B.y) / 2 + sAlong * u.y };
    await edgeFeature(s, half, k, c, RELIEF, wT + 1, "cut", `Relief ${k}`);
    await edgeFeature(s, half, k, c, TONGUE, wT, "join", `Tongue ${k}`);
    // the mirror edge's pocket sits where the flipped copy's tongue lands: x → -x
    if (opts.pockets !== false) await edgeFeature(s, half, 9 - k, { x: -c.x, y: c.y }, POCKET, wT + 1, "cut", `Pocket ${9 - k}`);
    // ...and a key on that edge's tip half (odd edges run valley → tip)
    if (opts.keys !== false) {
      const j = 9 - k, tip = V[(j + 1) % V.length], uj = dirOf(j);
      await edgeFeature(s, half, j, { x: tip.x - keyTipDist * uj.x, y: tip.y - keyTipDist * uj.y }, KEY, wKey, "join", `Key ${j}`);
    }
  }

  await dis(s, "component.connector", { component: half, name: "seat", origin: { x: 0, y: 0, z: 0 } });
  await dis(s, "component.connector", { component: half, name: "rim", origin: { x: 0, y: 0, z: H } });
  const pair = (await dis(s, "assembly.pattern", { source: half, count: 2, name: "Box" }))[0];
  await dis(s, "joint.template", { pattern: pair, kind: "rigid", base: { role: "root", origin: { x: 0, y: 0, z: 0 } }, moved: { role: "self", component: half, port: "seat" }, appliesTo: "first", name: "Bottom" });
  // the same part, flipped onto the first about the star's symmetry axis
  await dis(s, "joint.template", { pattern: pair, kind: "revolute", base: { role: "root", origin: { x: 0, y: 0, z: H } }, moved: { role: "self", component: half, port: "rim" }, axis: { x: 0, y: 1, z: 0 }, value: "180", appliesTo: "rest", name: "Top (flipped)" });
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
    expect(hi[2] - lo[2]).toBeCloseTo(2 * H, 1); // the halves meet rim to rim

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
