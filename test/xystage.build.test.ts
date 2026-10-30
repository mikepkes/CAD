// End-to-end: a one-piece XY flexure stage. A carriage hangs in a frame on four
// vertical blades (two above, two below) and moves in X; a platform hangs in
// the carriage on four horizontal blades (two left, two right) and moves in Y.
// Two inputs, and each axis deliberately over-constrained: the blades on either
// side each want to pull their stage toward their own anchor as they bend, so
// they hold it centred — and must stretch to do it, so the stage stiffens with
// travel. The blades are `beam` elements; each stage's undriven axes (drift
// and turn) settle at minimum stored energy.
//   BUILD_XYSTAGE=/abs/out npx vitest run test/xystage.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { serializeDocument } from "../src/core/persistence";
import { collideFeatures, evaluateFeatures, exportFusedBlob } from "../src/core/features";
import { placeComponentSketches, resolveComponentWorld } from "../src/core/recompute";
import { resolveParameters } from "../src/core/parameters";
import { flexureState, flexureSweep } from "../src/sim/flexure";
import { applyPoint } from "../src/math/transform";
import { HINGE_MATERIALS as MATERIALS, DEFAULT_HINGE_MATERIAL as DEFAULT_MATERIAL, num } from "./flexure-materials";
import type { CadSession } from "../src/core/command/session";

const OUT = process.env.BUILD_XYSTAGE || "";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

// ---- dimensions (mm), plan view, printed flat; symmetric about both axes ----
const Hz = 6;           // part height (Z) = the blades' width
const TRAVEL = 2;       // each input's range: ±TRAVEL
const P = 12;           // platform half-size
const S = 14;           // X blades at x = ±S
const YB = 8;           // Y blades at y = ±YB
const bar = 6;          // frame / carriage bar width
const N = 12;           // points along each drawn blade
// customize sliders: blade length and thickness
const SLIDERS = { blade: { value: 36, range: [24, 44], step: 1 }, thickness: { value: 0.8, range: [0.6, 1.2], step: 0.1 } };
// Layout, as expressions in `blade` (L): the carriage's side bars sit a blade
// beyond the platform, its top / bottom bars at y = ±(P + bar + 6); the frame a
// blade beyond those, and a gap wider than the travel outside the carriage.
const cIn = `(${P} + blade)`, cOut = `(${P} + blade + ${bar})`;      // carriage side bars: x
const cTopIn = P + bar, cTop = P + 2 * bar;                           // carriage top bar: y
const fIn = `(${cTop} + blade)`, fOut = `(${cTop} + blade + ${bar})`;  // frame top bar: y
const fSideIn = `(${cOut} + ${bar})`, fSideOut = `(${cOut} + ${2 * bar})`; // frame side bars: x

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}
type X = number | string;
async function solid(s: CadSession, comp: string, pts: [X, X][], first: boolean, name: string) {
  const sk = (await dis(s, "sketch.create", { plane: "XY", component: comp, name }))[0];
  const ids: string[] = [];
  for (const [x, y] of pts) ids.push((await dis(s, "sketch.addPoint", { sketch: sk, x: String(x), y: String(y) }))[0]);
  for (let i = 0; i < ids.length; i++) await dis(s, "sketch.addLine", { sketch: sk, start: { ref: ids[i] }, end: { ref: ids[(i + 1) % ids.length] } });
  await dis(s, "feature.extrude", { sketch: sk, distance: String(Hz), operation: first ? "new" : "join", name });
}
const rect = (x0: X, y0: X, x1: X, y1: X): [X, X][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const neg = (v: X) => (typeof v === "number" ? -v : `-${v}`);

/** A blade drawn as a strip from (a) to (b) along one axis, bent across it by
 *  `lateral` along the fixed-guided shape 3s² − 2s³ (exact for small deflection),
 *  so it follows its stage. */
function blade(along: "x" | "y", a: [X, X], b: [X, X], lateral: string): [X, X][] {
  const pts = Array.from({ length: N + 1 }, (_, k) => {
    const sv = k / N, p = num(3 * sv * sv - 2 * sv * sv * sv);
    const at = (i: 0 | 1) => `(${a[i]})*${num(1 - sv)} + (${b[i]})*${num(sv)}`;
    return along === "y" ? { u: `${at(0)} + ${p}*${lateral}`, v: at(1) } : { u: at(0), v: `${at(1)} + ${p}*${lateral}` };
  });
  // thickness across the blade
  if (along === "y") return [...pts.map((q): [X, X] => [`${q.u} - thickness/2`, q.v]), ...[...pts].reverse().map((q): [X, X] => [`${q.u} + thickness/2`, q.v])];
  return [...pts.map((q): [X, X] => [q.u, `${q.v} - thickness/2`]), ...[...pts].reverse().map((q): [X, X] => [q.u, `${q.v} + thickness/2`])];
}

async function buildStage(s: CadSession): Promise<void> {
  await dis(s, "parameter.add", { name: "x", expression: "0", min: -TRAVEL, max: TRAVEL, step: 0.1 });
  await dis(s, "parameter.add", { name: "y", expression: "0", min: -TRAVEL, max: TRAVEL, step: 0.1 });
  for (const [name, p] of Object.entries(SLIDERS)) await dis(s, "parameter.add", { name, expression: String(p.value), min: p.range[0], max: p.range[1], step: p.step });
  await dis(s, "parameter.add", { name: "material", expression: String(DEFAULT_MATERIAL), options: MATERIALS.map((m) => m.name) });
  const mats: string[] = [];
  for (const m of MATERIALS) mats.push((await dis(s, "material.create", { name: m.name, kind: "plastic", finish: m.finish, color: m.color, youngsModulus: m.E, allowableStrain: m.strain }))[0]);
  const part = async (name: string) => { const c = (await dis(s, "component.create", { name }))[0]; await dis(s, "material.assign", { component: c, materials: mats, by: "material" }); return c; };
  const frame = await part("Frame"), carriage = await part("X carriage"), platform = await part("Platform");

  // Frame: a ring, with the X blades hanging from its top and bottom bars.
  await solid(s, frame, rect(neg(fSideOut), fIn, fSideOut, fOut), true, "Frame top");
  await solid(s, frame, rect(neg(fSideOut), neg(fOut), fSideOut, neg(fIn)), false, "Frame bottom");
  await solid(s, frame, rect(neg(fSideOut), neg(fIn), neg(fSideIn), fIn), false, "Frame left");
  await solid(s, frame, rect(fSideIn, neg(fIn), fSideOut, fIn), false, "Frame right");
  for (const sy of [1, -1]) for (const sx of [-1, 1]) {
    await solid(s, frame, blade("y", [sx * S, sy > 0 ? fIn : neg(fIn)], [sx * S, sy * cTop], "x"), false, `X blade ${sy > 0 ? "top" : "bottom"} ${sx < 0 ? "left" : "right"}`);
  }
  // X carriage: a ring around the platform, with the Y blades reaching in.
  await solid(s, carriage, rect(neg(cOut), cTopIn, cOut, cTop), true, "Carriage top");
  await solid(s, carriage, rect(neg(cOut), -cTop, cOut, -cTopIn), false, "Carriage bottom");
  await solid(s, carriage, rect(neg(cOut), -cTopIn, neg(cIn), cTopIn), false, "Carriage left");
  await solid(s, carriage, rect(cIn, -cTopIn, cOut, cTopIn), false, "Carriage right");
  for (const sx of [-1, 1]) for (const sy of [1, -1]) {
    await solid(s, carriage, blade("x", [sx > 0 ? cIn : neg(cIn), sy * YB], [sx * P, sy * YB], "y"), false, `Y blade ${sx < 0 ? "left" : "right"} ${sy > 0 ? "top" : "bottom"}`);
  }
  // Platform.
  await solid(s, platform, rect(-P, -P, P, P), true, "Platform");

  // The carriage moves in X (driven), its drift and turn settle; the platform
  // moves in Y on the carriage (driven), its X drift and turn settle.
  const o = { x: 0, y: 0, z: 0 };
  await dis(s, "joint.create", { kind: "planar", base: frame, moved: carriage, baseOrigin: o, movedOrigin: o, planar: { x: "x" }, name: "X stage" });
  await dis(s, "joint.create", { kind: "planar", base: carriage, moved: platform, baseOrigin: o, movedOrigin: o, planar: { y: "y" }, name: "Y stage" });
  const beam = { width: Hz, thickness: "thickness" };
  for (const sy of [1, -1]) for (const sx of [-1, 1]) {
    await dis(s, "joint.create", { kind: "beam", base: frame, moved: carriage, baseOrigin: { x: sx * S, y: sy > 0 ? fIn : neg(fIn), z: 0 }, movedOrigin: { x: sx * S, y: sy * cTop, z: 0 }, beam, name: `X blade ${sy > 0 ? "top" : "bottom"} ${sx < 0 ? "left" : "right"}` });
  }
  for (const sx of [-1, 1]) for (const sy of [1, -1]) {
    await dis(s, "joint.create", { kind: "beam", base: carriage, moved: platform, baseOrigin: { x: sx > 0 ? cIn : neg(cIn), y: sy * YB, z: 0 }, movedOrigin: { x: sx * P, y: sy * YB, z: 0 }, beam, name: `Y blade ${sx < 0 ? "left" : "right"} ${sy > 0 ? "top" : "bottom"}` });
  }
}

const scopeAt = (s: CadSession, set: Record<string, number> = {}) =>
  resolveParameters(s.doc.parameters.map((p) => (p.name in set ? { ...p, expr: String(set[p.name]) } : p))).scope;
/** Where the platform's centre and its +X edge midpoint have gone. */
function platformAt(s: CadSession, x: number, y: number) {
  const world = resolveComponentWorld(s.doc, scopeAt(s, { x, y }));
  const T = world.get(Object.values(s.doc.components).find((c) => c.name === "Platform")!.id)!;
  const c = applyPoint(T, { x: 0, y: 0, z: 0 }), e = applyPoint(T, { x: P, y: 0, z: 0 });
  return { x: c.x, y: c.y, turn: (Math.atan2(e.y - c.y, e.x - c.x) * 180) / Math.PI };
}

describe("XY flexure stage", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("builds a frame, a carriage and a platform that print as one piece", async () => {
    const s = realSession();
    await buildStage(s);
    await s.recompute();
    if (OUT) writeFileSync(`${OUT}/xystage.chisel.json`, serializeDocument(s.doc));
    for (const sk of Object.values(s.doc.sketches)) expect(sk.status.conflicting, `sketch ${sk.name}`).toBe(false);
    const scope = scopeAt(s);
    placeComponentSketches(s.doc, scope);
    const bodies = Object.values(evaluateFeatures(s.doc, scope));
    for (const b of bodies) expect(b.error, b.name).toBeUndefined();
    expect(bodies.filter((b) => b.mesh).length).toBe(3);
    expect(collideFeatures(s.doc, scope).maxOverlap).toBeLessThan(0.01);
    const stl = exportFusedBlob(s.doc, scope, "stl");
    expect(stl && stl.size).toBeGreaterThan(10000);
    if (OUT) writeFileSync(`${OUT}/xystage.stl`, Buffer.from(await stl!.arrayBuffer()));
  }, 120000);

  it("goes where it's driven on both axes, centred and square: the blades hold it", async () => {
    const s = realSession();
    await buildStage(s);
    await s.recompute();
    const rows: string[] = [];
    for (const [x, y] of [[TRAVEL, 0], [0, TRAVEL], [TRAVEL, -TRAVEL], [-TRAVEL / 2, TRAVEL / 2]]) {
      const p = platformAt(s, x, y);
      rows.push(`(${x}, ${y}) → (${p.x.toFixed(4)}, ${p.y.toFixed(4)}), turned ${p.turn.toExponential(1)}°`);
      expect(p.x).toBeCloseTo(x, 3); // symmetry cancels each axis's drift…
      expect(p.y).toBeCloseTo(y, 3);
      expect(Math.abs(p.turn)).toBeLessThan(1e-3); // …and its turn
    }
    console.log(rows.join("\n"));
  }, 120000);

  // Each axis rides four blades: a small push meets 4 × 12EI/L³. Further out,
  // the over-constraint shows: each blade must stretch by 0.6·δ²/L (the draw-in
  // its bending wants), so the push stiffens roughly as 2.88·EA·δ³/L³ on top —
  // the reason a precision stage uses double parallelograms instead.
  it("is linear for a small push, and stiffens with travel as its blades stretch", async () => {
    const s = realSession();
    await buildStage(s);
    await s.recompute();
    const sc = scopeAt(s), m = MATERIALS[DEFAULT_MATERIAL];
    const L = sc.blade, EI = (m.E * Hz * sc.thickness ** 3) / 12, EA = m.E * Hz * sc.thickness;
    const small = 0.05, [p0] = flexureSweep(s.doc, "x", [small]);
    expect(p0.effort / ((48 * EI * small) / L ** 3)).toBeCloseTo(1, 1);
    const rows: string[] = [];
    for (const d of [0.5, 1, 1.5, 2]) {
      const [p] = flexureSweep(s.doc, "x", [d]);
      const linear = (48 * EI * d) / L ** 3, stretch = (2.88 * EA * d ** 3) / L ** 3;
      rows.push(`x ${d}: ${p.effort.toFixed(2)} N (linear ${linear.toFixed(2)}, + stretch ≈ ${stretch.toFixed(2)}), peak strain ${(p.utilisation * m.strain * 100).toFixed(2)}%`);
      expect(p.effort).toBeGreaterThan(linear);
      expect(p.effort).toBeLessThan(linear + stretch); // the stretched blades straighten a little, so it's a bound
      expect(p.effort).toBeGreaterThan(linear + 0.5 * stretch);
    }
    console.log(rows.join("\n"));
    // and the Y axis is the same
    const [q] = flexureSweep(s.doc, "y", [1]);
    expect(q.effort / flexureSweep(s.doc, "x", [1])[0].effort).toBeCloseTo(1, 2);
  }, 120000);

  it("in every material, at the corners of travel, the blades stay within the limit", async () => {
    const s = realSession();
    await buildStage(s);
    await s.recompute();
    const rows: string[] = [];
    for (const [i, m] of MATERIALS.entries()) {
      let worst = 0;
      for (const [x, y] of [[TRAVEL, TRAVEL], [-TRAVEL, TRAVEL], [TRAVEL, 0]]) {
        const st = flexureState(s.doc, { material: String(i), x: String(x), y: String(y) });
        expect(st.error, `${m.name} at (${x}, ${y})`).toBeUndefined();
        worst = Math.max(worst, st.utilisation);
      }
      rows.push(`${m.name}: worst blade ${(worst * m.strain * 100).toFixed(2)}% of ${m.strain * 100}%`);
      expect(worst, m.name).toBeLessThan(1);
    }
    console.log(rows.join("\n"));
  }, 300000);

  it("clears itself across the travel: the drawn blades bend with the stages", async () => {
    const s = realSession();
    await buildStage(s);
    for (const [x, y] of [[TRAVEL, TRAVEL], [-TRAVEL, TRAVEL], [TRAVEL, -TRAVEL]]) {
      await dis(s, "parameter.set", { name: "x", expression: String(x) });
      await dis(s, "parameter.set", { name: "y", expression: String(y) });
      await s.recompute();
      const scope = scopeAt(s);
      placeComponentSketches(s.doc, scope);
      const c = collideFeatures(s.doc, scope);
      expect(c.buildError).toBeUndefined();
      expect(c.maxOverlap, `(${x}, ${y}): ${JSON.stringify(c.overlaps)}`).toBeLessThan(0.05);
    }
  }, 300000);
});
