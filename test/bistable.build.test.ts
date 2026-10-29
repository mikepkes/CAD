// End-to-end: a one-piece bistable switch. Two parallel curved beams span a
// stout ring frame and carry a shuttle at their middle; push the shuttle's knob
// and the beams snap through to their mirror shape, where it stays until pushed
// back. The beams are `beam` elements (large-deflection beams,
// src/sim/beam2d.ts), and so is the frame: the beams push its walls apart as
// they flip, and a frame that gives lets them relax and lose the second rest
// position (the first design, a U-frame, did just that when printed). Chisel
// finds both rest positions, the snap force and the strain on the way, with the
// frame bending as it does. Checked against the published result for this
// mechanism (Qiu, Lang & Slocum, "A curved-beam bistable mechanism", JMEMS 2004).
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
import { flexureEquilibria, flexureSweep } from "../src/sim/flexure";
import { materialForComponent } from "../src/core/document";
import { HINGE_MATERIALS as MATERIALS, DEFAULT_HINGE_MATERIAL as DEFAULT_MATERIAL, num, pickBy } from "./flexure-materials";
import type { CadSession } from "../src/core/command/session";

const OUT = process.env.BUILD_BISTABLE || "";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

// ---- dimensions (mm), plan view, printed flat ----
const Hz = 6;          // part height (Z) = the beams' width
const ws = 6;          // shuttle width: each half-beam runs from a frame wall to it
const gap = 10;        // between the two beams (y)
const N = 16;          // points along each drawn half-beam
const TRAVEL = 10;     // the shuttle's stroke (mm): past the second rest position everywhere
const FOOT_Y = -2;     // the shuttle's foot
const BOTTOM_Y = FOOT_Y - TRAVEL - 1; // the bottom bar's top: the foot clears it at full travel
const POST = [-2, gap + 2]; // each wall's middle, which holds the beam roots
const KNOB = 8;        // how far the knob stands out of the frame's face (Z)
// customize sliders: span (wall to wall), arch (each beam's rise over its
// thickness: bistable above about 2.3), and the frame's bar width.
const SLIDERS = {
  span: { value: 60, range: [50, 70], step: 1 },
  arch: { value: 4, range: [1.5, 5], step: 0.1 },
  frame: { value: 10, range: [6, 16], step: 1 }, // 5 mm bars still hold it at both spans
};
// The material sizes the beams. The strain it takes to snap a curved beam goes
// as thickness·rise/L² (about 35·t·h/L² here, L the beams' free length), and the
// snap force as E·t³·h/L³: so for an arch and span, each material gets the
// thickest beams that snap at 3/4 of its strain limit (capped at 4%, where
// the stroke runs out), but never under 0.6 mm (two perimeters).
const SNAP_STRAIN = pickBy((m) => Math.min(0.75 * m.strain, 0.04));
const THICKNESS = `max(0.6, (span - ${ws}) * sqrt(snapStrain / (35 * arch)))`;

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

type X = number | string;
async function solid(s: CadSession, comp: string, pts: [X, X][], first: boolean, name: string, height: X = Hz) {
  const sk = (await dis(s, "sketch.create", { plane: "XY", component: comp, name }))[0];
  const ids: string[] = [];
  for (const [x, y] of pts) ids.push((await dis(s, "sketch.addPoint", { sketch: sk, x: String(x), y: String(y) }))[0]);
  for (let i = 0; i < ids.length; i++) await dis(s, "sketch.addLine", { sketch: sk, start: { ref: ids[i] }, end: { ref: ids[(i + 1) % ids.length] } });
  await dis(s, "feature.extrude", { sketch: sk, distance: String(height), operation: first ? "new" : "join", name });
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

/** `u` builds the first design, a U-frame open at the top, its walls standing
 *  on a long base: kept to show why it failed (the base bends, the walls splay
 *  and tilt, and the beams lose their second rest position). `rigid` holds the
 *  walls still, as the beams alone would behave. */
async function buildBistable(s: CadSession, opts: { span?: number; arch?: number; frame?: number; u?: boolean; rigid?: boolean; swaying?: boolean } = {}): Promise<void> {
  // the drive: how far the shuttle has been pushed down (mm); it rests again
  // just short of 2·rise, the beams' mirror shape
  await dis(s, "parameter.add", { name: "travel", expression: "0", min: 0, max: TRAVEL, step: 0.1 });
  for (const [name, p] of Object.entries(SLIDERS)) {
    const v = (opts as Record<string, number | undefined>)[name] ?? p.value;
    await dis(s, "parameter.add", { name, expression: String(v), min: p.range[0], max: p.range[1], step: p.step });
  }
  await dis(s, "parameter.add", { name: "material", expression: String(DEFAULT_MATERIAL), options: MATERIALS.map((m) => m.name) });
  await dis(s, "parameter.add", { name: "snapStrain", expression: SNAP_STRAIN });
  await dis(s, "parameter.add", { name: "thickness", expression: THICKNESS });
  await dis(s, "parameter.add", { name: "rise", expression: "arch * thickness" });
  const mats: string[] = [];
  for (const m of MATERIALS) mats.push((await dis(s, "material.create", { name: m.name, kind: "plastic", finish: m.finish, color: m.color, youngsModulus: m.E, allowableStrain: m.strain }))[0]);
  const part = async (name: string) => { const c = (await dis(s, "component.create", { name }))[0]; await dis(s, "material.assign", { component: c, materials: mats, by: "material" }); return c; };
  const frame = await part("Frame"), shuttle = await part("Shuttle");
  // where the frame bends: the walls' middles (holding the beam roots) and the
  // top bar float on the bars that join them to the rest, and settle. They're
  // drawn as part of the frame (they move by hundredths of a mm), so these
  // carry no geometry of their own.
  const walls = { [-1]: await part("Left wall"), [1]: await part("Right wall") } as Record<-1 | 1, string>;
  const top = opts.u ? "" : await part("Top bar");
  const o = { x: 0, y: 0, z: 0 };
  const free = (moved: string, name: string) => dis(s, "joint.create", { kind: "planar", base: frame, moved, baseOrigin: o, movedOrigin: o, planar: opts.rigid ? { x: "0", y: "0", angle: "0" } : {}, name });

  // Frame: a closed ring of `frame`-wide bars around the beams, so each wall is
  // held at both ends and the beams' push only bends short lengths of stout
  // bar. The shuttle's knob stands out of the ring's face, to push down and to
  // push back up.
  const bottom = opts.u ? BOTTOM_Y - 11 : BOTTOM_Y; // the U's base sat well below
  const topY = `${gap} + rise + 7`; // the top bar's underside: the shuttle's top clears it
  const wallTop: X = opts.u ? gap + 6 : `${topY} + frame`;
  await solid(s, frame, rect("-span/2 - frame", `${bottom} - frame`, "span/2 + frame", bottom), true, "Bottom bar");
  await solid(s, frame, rect("-span/2 - frame", bottom, "-span/2", wallTop), false, "Left wall");
  await solid(s, frame, rect("span/2", bottom, "span/2 + frame", wallTop), false, "Right wall");
  if (!opts.u) await solid(s, frame, rect("-span/2", topY, "span/2", `${topY} + frame`), false, "Top bar");
  for (const side of [-1, 1] as const) for (const y0 of [0, gap]) await solid(s, frame, halfBeam(side, y0), false, `Beam ${y0 ? "upper" : "lower"} ${side < 0 ? "left" : "right"}`);

  // Shuttle: through both beams' middles, with a knob standing out of the
  // frame's face (the U had a button above it).
  if (opts.u) {
    await solid(s, shuttle, rect(-ws / 2, FOOT_Y, ws / 2, `${gap} + rise + 16`), true, "Shuttle");
    await solid(s, shuttle, rect(-9, `${gap} + rise + 16`, 9, `${gap} + rise + 22`), false, "Button");
  } else {
    await solid(s, shuttle, rect(-ws / 2, FOOT_Y, ws / 2, `${gap} + rise + 6`), true, "Shuttle");
    await solid(s, shuttle, rect(-ws / 2, `${gap} + rise + 1`, ws / 2, `${gap} + rise + 6`), false, "Knob", Hz + KNOB);
  }

  // The shuttle is pushed straight down `travel`; the walls and the top bar
  // settle, every way. The beams and the frame's bars store the energy.
  // (Left free, mid-snap the shuttle sways and tilts a degree or so, the beams'
  // second mode, for ~2% less energy and the same peak force and rests: see
  // the `swaying` test. Held square, a study is repeatable and the drawn beams
  // stay on it.)
  await dis(s, "joint.create", { kind: "planar", base: frame, moved: shuttle, baseOrigin: o, movedOrigin: o, planar: opts.swaying ? { y: "-travel" } : { x: "0", y: "-travel", angle: "0" }, name: "Shuttle" });
  if (top) await free(top, "Top bar");
  for (const side of [-1, 1] as const) {
    const n = side < 0 ? "left" : "right";
    await free(walls[side], `Wall ${n}`);
    // each frame bar from a bar's middle, which symmetry holds square, along
    // the bar and up (or down) the wall to its middle
    const wallX = `${side}*(span/2 + frame/2)`, lowY = `${bottom} - frame/2`, highY = `${topY} + frame/2`;
    await dis(s, "joint.create", {
      kind: "beam", base: frame, moved: walls[side],
      baseOrigin: { x: 0, y: lowY, z: 0 }, movedOrigin: { x: wallX, y: POST[0], z: 0 },
      beam: { width: Hz, thickness: "frame", via: [{ x: wallX, y: lowY }] }, name: `Frame ${n} below`,
    });
    if (top) {
      await dis(s, "joint.create", {
        kind: "beam", base: top, moved: walls[side],
        baseOrigin: { x: 0, y: highY, z: 0 }, movedOrigin: { x: wallX, y: POST[1], z: 0 },
        beam: { width: Hz, thickness: "frame", via: [{ x: wallX, y: highY }] }, name: `Frame ${n} above`,
      });
    }
    for (const y0 of [0, gap]) {
      await dis(s, "joint.create", {
        kind: "beam", base: walls[side], moved: shuttle,
        baseOrigin: { x: `${side}*span/2`, y: y0, z: 0 }, movedOrigin: { x: side * ws / 2, y: `${y0} + rise`, z: 0 },
        beam: { width: Hz, thickness: "thickness", profile: "cosine" }, name: `Beam ${y0 ? "upper" : "lower"} ${n}`,
      });
    }
  }
}

const scopeOf = (s: CadSession) => resolveParameters(s.doc.parameters).scope;
const restsOf = (st: ReturnType<typeof flexureEquilibria>) => st.states.filter((q) => q.stable).map((q) => q.value);
const fmt = (vs: number[]) => vs.map((v) => v.toFixed(2)).join(" and ");

describe("bistable switch", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("builds a ring frame with its beams and a shuttle that print as one piece", async () => {
    const s = realSession();
    await buildBistable(s);
    await s.recompute();
    if (OUT) writeFileSync(`${OUT}/bistable.chisel.json`, serializeDocument(s.doc));
    const scope = scopeOf(s);
    expect(scope.thickness).toBeGreaterThan(0.85); // TPU 68D: stout beams, a firm snap
    placeComponentSketches(s.doc, scope);
    const bodies = Object.values(evaluateFeatures(s.doc, scope));
    for (const b of bodies) expect(b.error, b.name).toBeUndefined();
    expect(bodies.filter((b) => b.mesh).length).toBe(2);
    expect(collideFeatures(s.doc, scope).maxOverlap).toBeLessThan(0.01); // the beams only touch the shuttle
    const stl = exportFusedBlob(s.doc, scope, "stl");
    expect(stl && stl.size).toBeGreaterThan(10000);
    if (OUT) writeFileSync(`${OUT}/bistable.stl`, Buffer.from(await stl!.arrayBuffer()));
  }, 120000);

  it("held in a rigid frame, it rests in two places and snaps as the curved-beam bistable mechanism predicts", async () => {
    const s = realSession();
    await buildBistable(s, { rigid: true });
    await s.recompute();
    const st = flexureEquilibria(s.doc, "travel", 0, TRAVEL, 50);
    const sc = scopeOf(s), E = MATERIALS[DEFAULT_MATERIAL].E;
    const EI = (E * Hz * sc.thickness ** 3) / 12, L = sc.span - ws, h = sc.rise;
    const stable = restsOf(st);
    const between = st.poses.filter((p) => p.value > 0 && p.value < stable[1]);
    const top = st.snap!.effort / ((2 * EI * h) / L ** 3), bottom = Math.min(...between.map((p) => p.effort)) / ((2 * EI * h) / L ** 3);
    console.log(`rigid frame: rests at travel ${fmt(stable)} mm (2·rise = ${(2 * h).toFixed(2)}); snap ${st.snap!.effort.toFixed(2)} N = ${top.toFixed(0)}·EIh/L³ per beam (paper ≈ 740), pull back ${bottom.toFixed(0)} (≈ −370); peak strain ${(Math.max(...between.map((p) => p.utilisation)) * MATERIALS[DEFAULT_MATERIAL].strain * 100).toFixed(2)}%`);
    expect(st.multistable).toBe(true);
    expect(stable[0]).toBeCloseTo(0, 6);
    expect(stable[1] / (2 * h)).toBeGreaterThan(0.85); // just short of the mirror shape (2·rise)
    expect(stable[1] / (2 * h)).toBeLessThan(1);
    expect(top / 740).toBeGreaterThan(0.85);
    expect(top / 740).toBeLessThan(1.15);
    expect(-bottom / 370).toBeGreaterThan(0.75); // the paper gives this one only roughly
    expect(-bottom / 370).toBeLessThan(1.25);
  }, 120000);

  // The first design, printed: it sprang back unless its walls were squeezed.
  it("the frame decides it: the U-frame's walls splay and it springs back; the ring holds a firm second rest", async () => {
    const at = async (opts: Parameters<typeof buildBistable>[1]) => {
      const s = realSession();
      await buildBistable(s, opts);
      await s.recompute();
      return flexureEquilibria(s.doc, "travel", 0, TRAVEL, 32);
    };
    const rigid = await at({ rigid: true }), ring = await at({}), u = await at({ u: true });
    const thinRing = await at({ frame: SLIDERS.frame.range[0] });
    console.log(`rests: rigid ${fmt(restsOf(rigid))} (snap ${rigid.snap!.effort.toFixed(1)} N); ring ${fmt(restsOf(ring))} (snap ${ring.snap!.effort.toFixed(1)} N); ` +
      `thinnest ring ${fmt(restsOf(thinRing))} (snap ${thinRing.snap?.effort.toFixed(1)} N); U-frame ${fmt(restsOf(u))}`);
    expect(u.multistable).toBe(false);
    expect(ring.multistable).toBe(true);
    expect(thinRing.multistable).toBe(true);
    expect(ring.snap!.effort).toBeGreaterThan(10); // N, in TPU 68D: a firm click (the U-frame's beams needed ~2)
    expect(ring.snap!.effort / rigid.snap!.effort).toBeGreaterThan(0.75);
    expect(restsOf(ring)[1] / restsOf(rigid)[1]).toBeGreaterThan(0.95);
  }, 300000);

  it("pushed by its knob alone, mid-snap the shuttle sways and tilts a little, for the same peak force and rests", async () => {
    const square = realSession(), free = realSession();
    await buildBistable(square);
    await buildBistable(free, { swaying: true });
    await square.recompute();
    await free.recompute();
    const sh = Object.values(free.doc.joints).find((j) => j.name === "Shuttle")!;
    const rows: string[] = [];
    let tilted = 0;
    for (const t of [1, 2, 3, 4, 5, 6, 7]) {
      sh.planarValue = { x: 0.05, y: -t, angle: 0.5 }; // a nudge: square, it sits on a saddle
      const [a] = flexureSweep(square.doc, "travel", [t]), [b] = flexureSweep(free.doc, "travel", [t]);
      tilted = Math.max(tilted, Math.abs(sh.planarValue!.angle));
      rows.push(`${t} mm: square ${a.effort.toFixed(2)} N, ${a.energy.toFixed(2)} mJ; free ${b.effort.toFixed(2)} N, ${b.energy.toFixed(2)} mJ, turned ${sh.planarValue!.angle.toFixed(2)}°, sideways ${sh.planarValue!.x.toFixed(3)} mm`);
      expect(b.energy).toBeLessThanOrEqual(a.energy + 1e-9);
      expect(b.energy / a.energy).toBeGreaterThan(0.97);
      if (t <= 1) expect(b.effort / a.effort).toBeCloseTo(1, 2); // the peak comes before it sways
      if (t >= 7) expect(Math.abs(sh.planarValue!.angle)).toBeLessThan(1e-3); // and it's square again at rest
    }
    console.log(rows.join("\n"));
    expect(tilted).toBeGreaterThan(0.2);
    expect(tilted).toBeLessThan(3);
  }, 300000);

  it("in every material, it is bistable and the beams stay within its strain limit through the snap", async () => {
    const s = realSession();
    await buildBistable(s);
    await s.recompute();
    const rows: string[] = [];
    for (const [i, m] of MATERIALS.entries()) {
      await dis(s, "parameter.set", { name: "material", expression: String(i) });
      await s.recompute();
      expect(materialForComponent(s.doc, Object.values(s.doc.components).find((c) => c.name === "Frame")!.id)?.name).toBe(m.name);
      const st = flexureEquilibria(s.doc, "travel", 0, TRAVEL, 32);
      expect(st.multistable, m.name).toBe(true);
      const second = restsOf(st)[1];
      const worst = Math.max(...st.poses.filter((p) => p.value <= second).map((p) => p.utilisation)); // pushing on past it bends further
      const sc = scopeOf(s);
      rows.push(`${m.name}: beams ${sc.thickness.toFixed(2)} thick, rise ${sc.rise.toFixed(2)}; rests ${fmt(restsOf(st))}; worst ${(worst * m.strain * 100).toFixed(2)}% of ${m.strain * 100}%, snap ${st.snap!.effort.toFixed(2)} N`);
      expect(worst, m.name).toBeLessThan(1);
    }
    console.log(rows.join("\n"));
  }, 300000);

  it("stays bistable, within the strain limit, at every corner of the span and frame sliders", async () => {
    const rows: string[] = [];
    for (const span of SLIDERS.span.range) for (const frame of SLIDERS.frame.range) {
      const s = realSession();
      await buildBistable(s, { span, frame });
      await s.recompute();
      const st = flexureEquilibria(s.doc, "travel", 0, TRAVEL, 32);
      rows.push(`span ${span}, frame ${frame}: rests ${fmt(restsOf(st))}, snap ${st.snap?.effort.toFixed(1)} N`);
      expect(st.multistable, `span ${span}, frame ${frame}`).toBe(true);
      const second = restsOf(st)[1];
      expect(Math.max(...st.poses.filter((p) => p.value <= second).map((p) => p.utilisation))).toBeLessThan(1);
    }
    console.log(rows.join("\n"));
  }, 300000);

  it("is bistable only where the arch is tall enough for its thickness", async () => {
    const s = realSession();
    await buildBistable(s);
    const at = async (arch: number) => {
      await dis(s, "parameter.set", { name: "arch", expression: String(arch) });
      await s.recompute();
      return flexureEquilibria(s.doc, "travel", 0, TRAVEL, 32).multistable;
    };
    expect(await at(SLIDERS.arch.range[1])).toBe(true);
    expect(await at(SLIDERS.arch.range[0])).toBe(false); // it just springs back
  }, 300000);

  it("clears itself through the whole throw: the drawn beams bend with the shuttle", async () => {
    const s = realSession();
    await buildBistable(s);
    for (const pos of [2.5, 5, 7.5, TRAVEL]) {
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
