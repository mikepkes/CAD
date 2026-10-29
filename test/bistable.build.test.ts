// End-to-end: a one-piece bistable switch. Two parallel curved beams span a
// U-frame and carry a shuttle at their middle; push the shuttle's button and the
// beams snap through to their mirror shape, where it stays until pushed back.
// The beams are `beam` elements (large-deflection beams, src/sim/beam2d.ts) and
// the shuttle rides a slider (symmetry keeps it on a straight line), so Chisel
// finds both rest positions, the snap force and the strain on the way. Checked
// against the published result for this mechanism (Qiu, Lang & Slocum, "A
// curved-beam bistable mechanism", JMEMS 2004).
//   BUILD_BISTABLE=/abs/out npx vitest run test/bistable.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { serializeDocument } from "../src/core/persistence";
import { collideFeatures, evaluateFeatures, exportFusedBlob } from "../src/core/features";
import { placeComponentSketches } from "../src/core/recompute";
import { resolveParameters } from "../src/model/parameters";
import { flexureEquilibria } from "../src/sim/flexure";
import { materialForComponent } from "../src/core/document";
import { HINGE_MATERIALS as MATERIALS, DEFAULT_HINGE_MATERIAL as DEFAULT_MATERIAL, num } from "./flexure-materials";
import type { CadSession } from "../src/core/command/session";

const OUT = process.env.BUILD_BISTABLE || "";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

// ---- dimensions (mm), plan view, printed flat ----
const Hz = 6;          // part height (Z) = the beams' width
const ws = 6;          // shuttle width: each half-beam runs from a frame wall to it
const gap = 10;        // between the two beams (y)
const wall = 6;        // frame wall / bar width
const N = 16;          // points along each drawn half-beam
// customize sliders: span (wall to wall), rise (each beam's arch), thickness
// (the strip, in plane). A curved beam is bistable when rise/thickness is over
// about 2.3; the strain it takes to snap goes as thickness·rise/span².
const TRAVEL = 8; // the shuttle's stroke (mm): past the second rest position at every rise
const SLIDERS = { span: { value: 76, range: [50, 80], step: 1 }, rise: { value: 3.2, range: [1.8, 4], step: 0.1 }, thickness: { value: 0.8, range: [0.6, 1.2], step: 0.1 } };

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

/** A half-beam drawn as a strip from the wall (x = side·span/2, y0) to the
 *  shuttle (x = side·ws/2, y0 + rise): its rest shape is half a cosine (level at
 *  both ends); as the shuttle travels down by `travel`, it follows the
 *  fixed-guided deflection shape 3s² − 2s³ (exact for small deflections, and
 *  level at both ends again), so the drawn strip bends with the shuttle. */
function halfBeam(side: -1 | 1, y0: number): [X, X][] {
  const pts = Array.from({ length: N + 1 }, (_, k) => {
    const sv = k / N, c = (1 - Math.cos(Math.PI * sv)) / 2, p = 3 * sv * sv - 2 * sv * sv * sv;
    const x = `${num(side * (1 - sv) / 2)}*span + ${num(side * sv * ws / 2)}`;
    const y = `${y0} + ${num(c)}*rise - ${num(p)}*travel`;
    return { x, y };
  });
  return [...pts.map((q): [X, X] => [q.x, `${q.y} + thickness/2`]), ...pts.reverse().map((q): [X, X] => [q.x, `${q.y} - thickness/2`])];
}

async function buildBistable(s: CadSession): Promise<void> {
  // the drive: how far the shuttle has been pushed down (mm); it rests again
  // just short of 2·rise, the beams' mirror shape
  await dis(s, "parameter.add", { name: "travel", expression: "0", min: 0, max: TRAVEL, step: 0.1 });
  for (const [name, p] of Object.entries(SLIDERS)) await dis(s, "parameter.add", { name, expression: String(p.value), min: p.range[0], max: p.range[1], step: p.step });
  await dis(s, "parameter.add", { name: "material", expression: String(DEFAULT_MATERIAL), options: MATERIALS.map((m) => m.name) });
  const mats: string[] = [];
  for (const m of MATERIALS) mats.push((await dis(s, "material.create", { name: m.name, kind: "plastic", finish: m.finish, color: m.color, youngsModulus: m.E, allowableStrain: m.strain }))[0]);
  const part = async (name: string) => { const c = (await dis(s, "component.create", { name }))[0]; await dis(s, "material.assign", { component: c, materials: mats, by: "material" }); return c; };
  const frame = await part("Frame"), shuttle = await part("Shuttle");

  // Frame: a U, open at the top so the shuttle's button stands out of it.
  await solid(s, frame, rect(`-span/2 - ${wall}`, -28, "span/2 + " + wall, -22), true, "Base");
  await solid(s, frame, rect(`-span/2 - ${wall}`, -22, "-span/2", gap + 6), false, "Left wall");
  await solid(s, frame, rect("span/2", -22, `span/2 + ${wall}`, gap + 6), false, "Right wall");
  // the beams belong to the frame (they're drawn following the shuttle)
  for (const y0 of [0, gap]) for (const side of [-1, 1] as const) await solid(s, frame, halfBeam(side, y0), false, `Beam ${y0 ? "upper" : "lower"} ${side < 0 ? "left" : "right"}`);

  // Shuttle: through both beams' middles, with a button above the frame.
  await solid(s, shuttle, rect(-ws / 2, -6, ws / 2, `${gap} + rise + 16`), true, "Shuttle");
  await solid(s, shuttle, rect(-9, `${gap} + rise + 16`, 9, `${gap} + rise + 22`), false, "Button");

  // The shuttle slides straight down (the beams' symmetry holds it there); the
  // beams store the energy.
  const o = { x: 0, y: 0, z: 0 };
  await dis(s, "joint.create", { kind: "slider", base: frame, moved: shuttle, baseOrigin: o, movedOrigin: o, axis: { x: 0, y: -1, z: 0 }, value: "travel", name: "Guide" });
  for (const y0 of [0, gap]) for (const side of [-1, 1] as const) {
    await dis(s, "joint.create", {
      kind: "beam", base: frame, moved: shuttle,
      baseOrigin: { x: `${side}*span/2`, y: y0, z: 0 }, movedOrigin: { x: side * ws / 2, y: `${y0} + rise`, z: 0 },
      beam: { width: Hz, thickness: "thickness", profile: "cosine" }, name: `Beam ${y0 ? "upper" : "lower"} ${side < 0 ? "left" : "right"}`,
    });
  }
}

const scopeOf = (s: CadSession) => resolveParameters(s.doc.parameters).scope;
/** The force (N) to push the shuttle: its effort per mm of travel. */
const newtons = (_s: CadSession, effort: number) => effort;

describe("bistable switch", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("builds a frame with its beams and a shuttle that print as one piece", async () => {
    const s = realSession();
    await buildBistable(s);
    await s.recompute();
    if (OUT) writeFileSync(`${OUT}/bistable.chisel.json`, serializeDocument(s.doc));
    const scope = scopeOf(s);
    placeComponentSketches(s.doc, scope);
    const bodies = Object.values(evaluateFeatures(s.doc, scope));
    for (const b of bodies) expect(b.error, b.name).toBeUndefined();
    expect(bodies.filter((b) => b.mesh).length).toBe(2);
    expect(collideFeatures(s.doc, scope).maxOverlap).toBeLessThan(0.01); // the beams only touch the shuttle
    const stl = exportFusedBlob(s.doc, scope, "stl");
    expect(stl && stl.size).toBeGreaterThan(10000);
    if (OUT) writeFileSync(`${OUT}/bistable.stl`, Buffer.from(await stl!.arrayBuffer()));
  }, 120000);

  it("rests in two places and snaps between them as the curved-beam bistable mechanism predicts", async () => {
    const s = realSession();
    await buildBistable(s);
    await s.recompute();
    const st = flexureEquilibria(s.doc, "travel", 0, TRAVEL, 50);
    const sc = scopeOf(s), E = MATERIALS[DEFAULT_MATERIAL].E;
    const EI = (E * Hz * sc.thickness ** 3) / 12, L = sc.span - ws, h = sc.rise;
    const stable = st.states.filter((q) => q.stable).map((q) => q.value);
    const between = st.poses.filter((p) => p.value > 0 && p.value < stable[1]);
    const top = newtons(s, st.snap!.effort) / ((2 * EI * h) / L ** 3), bottom = newtons(s, Math.min(...between.map((p) => p.effort))) / ((2 * EI * h) / L ** 3);
    console.log(`rests at travel ${stable.map((v) => v.toFixed(2)).join(" and ")} mm (2·rise = ${2 * h}); snap ${newtons(s, st.snap!.effort).toFixed(2)} N = ${top.toFixed(0)}·EIh/L³ per beam (paper ≈ 740), pull back ${bottom.toFixed(0)} (≈ −370); peak strain ${(Math.max(...between.map((p) => p.utilisation)) * MATERIALS[DEFAULT_MATERIAL].strain * 100).toFixed(2)}%`);
    expect(st.multistable).toBe(true);
    expect(stable[0]).toBeCloseTo(0, 6);
    expect(stable[1] / (2 * h)).toBeGreaterThan(0.85); // just short of the mirror shape (2·rise)
    expect(stable[1] / (2 * h)).toBeLessThan(1);
    expect(top / 740).toBeGreaterThan(0.85);
    expect(top / 740).toBeLessThan(1.15);
    expect(-bottom / 370).toBeGreaterThan(0.75); // the paper gives this one only roughly
    expect(-bottom / 370).toBeLessThan(1.25);
  }, 120000);

  it("in every material, the beams stay within its strain limit through the snap", async () => {
    const s = realSession();
    await buildBistable(s);
    await s.recompute();
    const rows: string[] = [];
    for (const [i, m] of MATERIALS.entries()) {
      await dis(s, "parameter.set", { name: "material", expression: String(i) });
      await s.recompute();
      expect(materialForComponent(s.doc, Object.values(s.doc.components).find((c) => c.name === "Frame")!.id)?.name).toBe(m.name);
      const st = flexureEquilibria(s.doc, "travel", 0, TRAVEL, 40);
      expect(st.multistable, m.name).toBe(true); // stiffness scales the forces, not where it rests
      const second = st.states.filter((q) => q.stable)[1].value;
      const worst = Math.max(...st.poses.filter((p) => p.value <= second).map((p) => p.utilisation)); // pushing on past it bends further
      rows.push(`${m.name}: worst ${(worst * m.strain * 100).toFixed(2)}% of ${m.strain * 100}%, snap ${newtons(s, st.snap!.effort).toFixed(2)} N`);
      expect(worst, m.name).toBeLessThan(1);
    }
    console.log(rows.join("\n"));
  }, 300000);

  it("is bistable only where the arch is tall enough for its thickness", async () => {
    const s = realSession();
    await buildBistable(s);
    const at = async (rise: number, thickness: number) => {
      await dis(s, "parameter.set", { name: "rise", expression: String(rise) });
      await dis(s, "parameter.set", { name: "thickness", expression: String(thickness) });
      await s.recompute();
      return flexureEquilibria(s.doc, "travel", 0, TRAVEL, 40).multistable;
    };
    expect(await at(4, 0.6)).toBe(true);    // rise/thickness 6.7
    expect(await at(1.8, 1.2)).toBe(false); // 1.5: it just springs back
  }, 300000);

  it("clears itself through the whole throw: the drawn beams bend with the shuttle", async () => {
    const s = realSession();
    await buildBistable(s);
    for (const pos of [2, 4, 6, TRAVEL]) {
      await dis(s, "parameter.set", { name: "travel", expression: String(pos) });
      await s.recompute();
      for (const sk of Object.values(s.doc.sketches)) expect(sk.status.conflicting, `sketch ${sk.name}`).toBe(false);
      const scope = scopeOf(s);
      placeComponentSketches(s.doc, scope);
      const c = collideFeatures(s.doc, scope);
      expect(c.buildError).toBeUndefined();
      expect(c.maxOverlap, `travel ${pos}: ${JSON.stringify(c.overlaps)}`).toBeLessThan(0.05);
    }
  }, 300000);
});
