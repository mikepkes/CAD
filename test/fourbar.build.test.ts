// End-to-end: a one-piece compliant four-bar that shows how flexures work. Four
// links joined by thin flexure strips, printed flat as a single part (in TPU, or
// another plastic: a `material` choice sizes the strips for it); push
// the finger pad and the crank turns about its ground flexure, the coupler
// carries the motion across, and the rocker's pointer swings — every joint is a
// strip of plastic bending, no pins. Modelled as four components joined by
// flexure joints with the loop closed at B, so Chisel solves the pose for any
// crank angle and reports each hinge's strain and the input torque.
//   BUILD_FOURBAR=/abs/out npx vitest run test/fourbar.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { serializeDocument } from "../src/core/persistence";
import { collideFeatures, evaluateFeatures, exportFusedBlob } from "../src/core/features";
import { placeComponentSketches } from "../src/core/recompute";
import { resolveParameters } from "../src/model/parameters";
import { flexureSweep, flexureStiffness } from "../src/sim/flexure";
import { materialForComponent } from "../src/core/document";
import type { CadSession } from "../src/core/command/session";

const OUT = process.env.BUILD_FOURBAR || "";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

// ---- dimensions (mm), plan view, printed flat ----
const Hz = 6;                          // part height (Z) = every hinge's width
const w = 6;                           // link bar width
// Pivots: a Grashof crank-rocker (crank 40, coupler 60.8, rocker 50, ground 60).
const O2 = { x: 0, y: 0 }, A = { x: 0, y: 40 }, B = { x: 60, y: 50 }, O4 = { x: 60, y: 0 };
const THETA = 20;                      // input range ±20°

// ---- the print material (a named choice: `material`) ----
// Each hinge is a strip that bends IN the print layers (printed flat), through
// the same angles whatever it's made of (up to ~20.2° at ±20° input: the pivots
// fix the kinematics). Its peak strain is ε = t·φ/2L, so per material the strip
// is sized to stay at ~80% of that material's limit: stiff plastics get the
// thinnest strip that prints well (0.8 mm, two perimeters) and a longer one;
// strain-tolerant ones keep the short 1 mm strip. Hinge stiffness k = E·w·t³/12L
// then lands within 2× of the TPU part's for every one but soft TPU 95A, which
// gets a thicker strip so it still springs back. Typical FDM values in the
// layer plane (E, MPa; strain limit for repeated flexing): tune to your
// filament. PLA hinges fatigue: expect hundreds of flexes, not thousands.
type HingeMaterial = { name: string; E: number; strain: number; t: number; L: number; color: string; finish: string };
const MATERIALS: HingeMaterial[] = [
  { name: "PLA", E: 3000, strain: 0.02, t: 0.8, L: 8.5, color: "#5b8def", finish: "matte" },
  { name: "PETG", E: 1900, strain: 0.03, t: 0.8, L: 6, color: "#3fb6a8", finish: "gloss" },
  { name: "ABS / ASA", E: 2000, strain: 0.025, t: 0.8, L: 7, color: "#e05a4f", finish: "satin" },
  { name: "Nylon", E: 1200, strain: 0.05, t: 1, L: 4.5, color: "#e8e2d0", finish: "satin" },
  { name: "PP (polypropylene)", E: 1000, strain: 0.1, t: 1, L: 4, color: "#d9dde3", finish: "satin" },
  // Bambu "TPU for AMS" printed flat: E from the datasheet; 8% is a conservative
  // service limit (elongation at break is > 650%). The part as first designed.
  { name: "TPU 68D (TPU for AMS)", E: 1190, strain: 0.08, t: 1, L: 4, color: "#e9b949", finish: "matte" },
  { name: "TPU 95A", E: 26, strain: 0.15, t: 2.4, L: 4, color: "#f28c4e", finish: "matte" },
];
const DEFAULT_MATERIAL = 5;
const num = (v: number) => String(Number(v.toPrecision(12)));

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

// Coordinates are linear in the hinge strip's thickness t and length L
// (parameters hingeT, hingeL), so each becomes `c + a·hingeT + b·hingeL`.
type Fn = (t: number, L: number) => number;
type P = { x: Fn; y: Fn };
const T0 = 1, L0 = 4;
function lin(f: Fn): string {
  const f0 = f(T0, L0), a = f(T0 + 1, L0) - f0, b = f(T0, L0 + 1) - f0, c = f0 - a * T0 - b * L0;
  if (Math.abs(f(T0 + 0.7, L0 + 2.3) - (c + a * (T0 + 0.7) + b * (L0 + 2.3))) > 1e-9) throw new Error("coordinate is not linear in hingeT, hingeL");
  const terms = [Math.abs(c) > 1e-12 ? num(c) : "", Math.abs(a) > 1e-12 ? `${num(a)}*hingeT` : "", Math.abs(b) > 1e-12 ? `${num(b)}*hingeL` : ""].filter(Boolean);
  return terms.length ? terms.join(" + ").replace(/\+ -/g, "- ") : "0";
}
const k_ = (v: number): Fn => () => v;
const pt = (x: number | Fn, y: number | Fn): P => ({ x: typeof x === "number" ? k_(x) : x, y: typeof y === "number" ? k_(y) : y });

/** Extrude a closed outline (plan, mm) by Hz in `comp`: the component's first
 *  shape starts its body, the rest join it. */
async function solid(s: CadSession, comp: string, pts: P[], first: boolean, name: string) {
  const sk = (await dis(s, "sketch.create", { plane: "XY", component: comp, name }))[0];
  const ids: string[] = [];
  for (const q of pts) ids.push((await dis(s, "sketch.addPoint", { sketch: sk, x: lin(q.x), y: lin(q.y) }))[0]);
  for (let i = 0; i < ids.length; i++) await dis(s, "sketch.addLine", { sketch: sk, start: { ref: ids[i] }, end: { ref: ids[(i + 1) % ids.length] } });
  await dis(s, "feature.extrude", { sketch: sk, distance: String(Hz), operation: first ? "new" : "join", name });
}
const rect = (x0: number | Fn, y0: number | Fn, x1: number | Fn, y1: number | Fn): P[] => [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)];
/** A bar of width `wd` from p to q (centreline), both moved up by `dy`. */
function bar(p: { x: number; y: number }, q: { x: number; y: number }, wd: number, dy: Fn): P[] {
  const L = Math.hypot(q.x - p.x, q.y - p.y), n = { x: (-(q.y - p.y) / L) * (wd / 2), y: ((q.x - p.x) / L) * (wd / 2) };
  const at = (x: number, y: number) => pt(x, (t, l) => y + dy(t, l));
  return [at(p.x + n.x, p.y + n.y), at(p.x - n.x, p.y - n.y), at(q.x - n.x, q.y - n.y), at(q.x + n.x, q.y + n.y)];
}
const hl: Fn = (_t, L) => L / 2; // half a strip
/** Half a flexure strip at pivot c, running along +y (`up`) or −y from it. The
 *  strip is split at the pivot: each link owns the half on its side, so the
 *  hinge bends about its centre (the small-length flexural pivot). */
const half = (c: { x: number; y: number }, up: boolean) => rect(
  (t) => c.x - t / 2, up ? c.y : (_t, L) => c.y - L / 2 - 0.2,
  (t) => c.x + t / 2, up ? (_t, L) => c.y + L / 2 + 0.2 : c.y);

async function buildFourBar(s: CadSession): Promise<void> {
  await dis(s, "parameter.add", { name: "theta", expression: "0", min: -THETA, max: THETA, step: 1 });
  // what it's printed in: sizes the hinge strips (see MATERIALS)
  await dis(s, "parameter.add", { name: "material", expression: String(DEFAULT_MATERIAL), options: MATERIALS.map((m) => m.name) });
  const pick = (f: (m: HingeMaterial) => number) => `pick(material, ${MATERIALS.map((m) => num(f(m))).join(", ")})`;
  await dis(s, "parameter.add", { name: "hingeT", expression: pick((m) => m.t) }); // strip thickness (bends this way)
  await dis(s, "parameter.add", { name: "hingeL", expression: pick((m) => m.L) }); // strip length
  const mats: string[] = [];
  for (const m of MATERIALS) mats.push((await dis(s, "material.create", { name: m.name, kind: "plastic", finish: m.finish, color: m.color, youngsModulus: m.E, allowableStrain: m.strain }))[0]);
  const link = async (name: string) => { const c = (await dis(s, "component.create", { name }))[0]; await dis(s, "material.assign", { component: c, materials: mats, by: "material" }); return c; };
  const ground = await link("Ground"), crank = await link("Crank"), coupler = await link("Coupler"), rocker = await link("Rocker");
  const neg = (f: Fn): Fn => (t, L) => -f(t, L);
  const add = (v: number, f: Fn): Fn => (t, L) => v + f(t, L);

  // Ground: a base bar with a pedestal under each ground hinge.
  await solid(s, ground, rect(-12, -16, 72, -8), true, "Base");
  await solid(s, ground, rect(O2.x - 4, -8.2, O2.x + 4, neg(hl)), false, "Pedestal O2");
  await solid(s, ground, rect(O4.x - 4, -8.2, O4.x + 4, neg(hl)), false, "Pedestal O4");
  await solid(s, ground, half(O2, false), false, "Hinge O2 (ground half)");
  await solid(s, ground, half(O4, false), false, "Hinge O4 (ground half)");

  // Crank (input): O2 → A, with a lever arm and finger pad to push.
  await solid(s, crank, half(O2, true), true, "Hinge O2 (crank half)");
  await solid(s, crank, rect(-w / 2, hl, w / 2, add(A.y, neg(hl))), false, "Crank bar");
  await solid(s, crank, half(A, false), false, "Hinge A (crank half)");
  await solid(s, crank, rect(-26, 19, -w / 2 + 0.1, 23), false, "Lever");
  await solid(s, crank, rect(-36, 12, -24, 30), false, "Finger pad");

  // Coupler: a block above each coupler hinge, joined by a bar.
  await solid(s, coupler, half(A, true), true, "Hinge A (coupler half)");
  await solid(s, coupler, rect(A.x - 4, add(A.y, hl), A.x + 4, add(A.y + 6, hl)), false, "Block A");
  await solid(s, coupler, half(B, true), false, "Hinge B (coupler half)");
  await solid(s, coupler, rect(B.x - 4, add(B.y, hl), B.x + 4, add(B.y + 6, hl)), false, "Block B");
  await solid(s, coupler, bar(A, B, w, add(3, hl)), false, "Coupler bar");

  // Rocker (output): O4 → B, with a long pointer to show the swing.
  await solid(s, rocker, half(O4, true), true, "Hinge O4 (rocker half)");
  await solid(s, rocker, rect(O4.x - w / 2, hl, O4.x + w / 2, add(B.y, neg(hl))), false, "Rocker bar");
  await solid(s, rocker, half(B, false), false, "Hinge B (rocker half)");
  await solid(s, rocker, rect(O4.x + w / 2 - 0.1, 28.5, 92, 31.5), false, "Pointer arm");
  await solid(s, rocker, [pt(91.9, 26), pt(102, 30), pt(91.9, 34)], false, "Pointer tip");

  // Flexure joints: crank driven, coupler and rocker solved, the loop closed at B.
  const flex = { kind: "flexure", axis: { x: 0, y: 0, z: 1 }, flexure: { length: "hingeL", width: Hz, thickness: "hingeT" } };
  const at = (p: { x: number; y: number }) => ({ x: p.x, y: p.y, z: 0 });
  await dis(s, "joint.create", { ...flex, base: ground, moved: crank, baseOrigin: at(O2), movedOrigin: at(O2), value: "theta", name: "Hinge O2" });
  await dis(s, "joint.create", { ...flex, base: crank, moved: coupler, baseOrigin: at(A), movedOrigin: at(A), solve: true, name: "Hinge A" });
  await dis(s, "joint.create", { ...flex, base: ground, moved: rocker, baseOrigin: at(O4), movedOrigin: at(O4), solve: true, name: "Hinge O4" });
  await dis(s, "joint.create", { ...flex, base: coupler, moved: rocker, baseOrigin: at(B), movedOrigin: at(B), closes: true, name: "Hinge B" });
}

const sweep = Array.from({ length: 9 }, (_, k) => -THETA + (2 * THETA * k) / 8);

describe("compliant four-bar", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("builds four links that print as one piece", async () => {
    const s = realSession();
    await buildFourBar(s);
    await s.recompute();
    if (OUT) writeFileSync(`${OUT}/fourbar.chisel.json`, serializeDocument(s.doc));
    const scope = resolveParameters(s.doc.parameters).scope;
    placeComponentSketches(s.doc, scope);
    const bodies = Object.values(evaluateFeatures(s.doc, scope));
    for (const b of bodies) expect(b.error, b.name).toBeUndefined();
    expect(bodies.filter((b) => b.mesh).length).toBe(4);
    // at rest the links only touch (at the split hinge strips); fused they are one solid
    expect(collideFeatures(s.doc, scope).maxOverlap).toBeLessThan(0.01);
    const stl = exportFusedBlob(s.doc, scope, "stl");
    expect(stl && stl.size).toBeGreaterThan(10000);
    if (OUT) writeFileSync(`${OUT}/fourbar.stl`, Buffer.from(await stl!.arrayBuffer()));
  }, 120000);

  it("moves through ±20°: the loop closes, every hinge stays under the TPU limit, the output swings", async () => {
    const m = MATERIALS[DEFAULT_MATERIAL];
    const s = realSession();
    await buildFourBar(s);
    await s.recompute();
    const poses = flexureSweep(s.doc, "theta", sweep);
    for (const p of poses) {
      expect(p.error, `theta ${p.value}`).toBeUndefined();
      expect(p.utilisation, `theta ${p.value}`).toBeLessThan(1);
    }
    const out = poses.map((p) => p.flexures.find((f) => f.name === "Hinge O4")!.angle);
    const swing = Math.max(...out) - Math.min(...out);
    expect(swing).toBeGreaterThan(20); // the pointer visibly swings
    // stiffer the further it is pushed: torque grows with |theta| and is zero at rest
    expect(Math.abs(poses[4].effort)).toBeLessThan(1e-3);
    expect(Math.abs(poses[8].effort)).toBeGreaterThan(Math.abs(poses[6].effort));
    const k = flexureStiffness(m.E, { length: m.L, width: Hz, thickness: m.t });
    console.log(`hinge k = ${k.toFixed(0)} N·mm/rad; output swing ${swing.toFixed(1)}° for ±${THETA}° input; ` +
      `at +${THETA}°: torque ${poses[8].effort.toFixed(0)} N·mm, peak strain ${(Math.max(...poses[8].flexures.map((f) => f.strain)) * 100).toFixed(1)}% (limit ${m.strain * 100}%)`);
  }, 120000);

  it("the links clear each other through the motion (only the hinge strips kink)", async () => {
    const s = realSession();
    await buildFourBar(s);
    await s.recompute();
    await clearThroughMotion(s);
  }, 120000);

  // Every other material: sized so its hinges stay under its strain limit (at
  // ~80% of it) through the full ±20°, and the part still builds, closes its loop
  // and clears itself through the motion.
  const breathe = () => new Promise((r) => setTimeout(r, 0));
  for (const [i, m] of MATERIALS.entries()) {
    if (i === DEFAULT_MATERIAL) continue;
    it(`printed in ${m.name}: hinges within the strain limit through ±${THETA}°, links clear`, async () => {
      const s = realSession();
      await buildFourBar(s);
      await dis(s, "parameter.set", { name: "material", expression: String(i) });
      await s.recompute();
      const scope = resolveParameters(s.doc.parameters).scope;
      expect([scope.hingeT, scope.hingeL]).toEqual([m.t, m.L]);
      for (const j of Object.values(s.doc.joints)) expect([j.flexure!.thickness, j.flexure!.length]).toEqual([m.t, m.L]);
      expect(materialForComponent(s.doc, s.doc.joints[Object.keys(s.doc.joints)[0]].moved)?.name).toBe(m.name);
      const poses = flexureSweep(s.doc, "theta", sweep);
      for (const p of poses) {
        expect(p.error, `theta ${p.value}`).toBeUndefined();
        expect(p.utilisation, `theta ${p.value}`).toBeLessThan(0.9);
      }
      const peak = Math.max(...poses.map((p) => p.utilisation));
      expect(peak, "not over-built: the strip uses most of what the material allows").toBeGreaterThan(0.4);
      console.log(`${m.name}: strip ${m.t} × ${m.L} mm, k ${flexureStiffness(m.E, { length: m.L, width: Hz, thickness: m.t }).toFixed(0)} N·mm/rad, ` +
        `peak strain ${(peak * m.strain * 100).toFixed(2)}% of ${m.strain * 100}%, torque at +${THETA}° ${poses[8].effort.toFixed(0)} N·mm`);
      await breathe();
      placeComponentSketches(s.doc, scope);
      const rest = collideFeatures(s.doc, scope);
      expect(rest.buildError).toBeUndefined();
      expect(rest.maxOverlap).toBeLessThan(0.01);
      await breathe();
      await clearThroughMotion(s);
    }, 300000);
  }
});

/** Pose the part across ±THETA and check only the bending strips overlap: the
 *  two halves of a split strip cross in a sliver as the hinge bends, two
 *  triangles of legs t/2 and (t/2)·tan φ, i.e. Hz·t²/4·tan φ (< 1 mm³ for the
 *  1 mm strip). Anything bigger is the links themselves colliding. */
async function clearThroughMotion(s: CadSession) {
  for (const th of [-THETA, -THETA / 2, THETA / 2, THETA]) {
    const params = s.doc.parameters.map((p) => (p.name === "theta" ? { ...p, expr: String(th) } : p));
    const scope = resolveParameters(params).scope;
    const posed = { ...s.doc, parameters: params, sketches: Object.fromEntries(Object.entries(s.doc.sketches).map(([k, v]) => [k, { ...v }])) };
    placeComponentSketches(posed, scope);
    const c = collideFeatures(posed, scope);
    expect(c.buildError).toBeUndefined();
    const sliver = (Hz * scope.hingeT ** 2 / 4) * Math.tan((21 * Math.PI) / 180) + 0.2;
    for (const o of c.overlaps) expect(o.volume, `${o.a} × ${o.b} at theta ${th}`).toBeLessThan(Math.max(1, sliver));
    await new Promise((r) => setTimeout(r, 0));
  }
}

