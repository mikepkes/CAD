// End-to-end: a one-piece compliant gripper. Push the plunger and both jaws swing
// open; let go and they spring shut on whatever is between them. The plunger
// rides a parallelogram guide (two links), and a pushrod each side turns a jaw
// lever about its ground hinge, so the jaw tips move ~jaw/14× as far as the
// plunger. 8 parts, 10 flexure hinges and 3 closed loops, solved together for
// any plunger travel: Chisel reports each hinge's strain, the push force, and
// the jaw opening.
//   BUILD_GRIPPER=/abs/out npx vitest run test/gripper.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { serializeDocument } from "../src/core/persistence";
import { collideFeatures, evaluateFeatures, exportFusedBlob } from "../src/core/features";
import { InlineGeometryBackend } from "../src/core/geometry/backend";
import { readStoredZip, modelObjects, openEdges } from "./threemf-read";
import { placeComponentSketches, resolveComponentWorld } from "../src/core/recompute";
import { resolveParameters } from "../src/core/parameters";
import { flexureEquilibria, flexureState, flexureSweep } from "../src/sim/flexure";
import { applyPoint } from "../src/math/transform";
import { materialForComponent } from "../src/core/document";
import { HINGE_MATERIALS as MATERIALS, DEFAULT_HINGE_MATERIAL as DEFAULT_MATERIAL, num, pickBy } from "./flexure-materials";
import type { CadSession } from "../src/core/command/session";

const OUT = process.env.BUILD_GRIPPER || "";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

// ---- dimensions (mm), plan view, printed flat; symmetric about x = 0 ----
const Hz = 6;                 // part height (Z) = every hinge's width
const PUSH = 5;               // plunger stroke
const JAW = { value: 50, range: [40, 60] }; // jaw lever: pivot to finger
const Ox = 32, Oy = 40;       // jaw lever pivots at (±Ox, Oy) on the frame columns
const Qx = 18;                // pushrods at x = ±Qx: they meet the levers at (±Qx, Oy), 14 mm in from the pivots
const barY = 14;              // the plunger's crossbar top (the pushrods leave it here)
const stem = 4;               // plunger stem half-width
const guideY = [-40, -20];    // the two parallel guide links
const colIn = 29;             // frame columns' inner faces (x = ±29)
const hl = "(hingeL/2)";      // half a strip
// Grip springs: straight leaf springs from the left column to the plunger's
// stem, fixed-guided as the plunger rises; each adds 12EI/L³ of push, and so
// of grip. On the guide's side only: the plunger drifts toward it on the
// guide's arc by about what a bent blade's ends draw together (δ²/2R against
// 0.6·δ²/L), where a blade on the far side would be stretched by twice that.
// Up to three: between the guide links, then below and above them.
const SPRINGS = ["none", "1 spring", "2 springs", "3 springs"];
const SPRING_Y = [-30, -50, -10];
const SPRING_L = colIn - stem; // column face to stem face
// each material's spring strip: the thickest (up to 1.6 mm) that bends the full
// stroke at 70% of its strain limit (3·t·δ/L² at a fixed-guided blade's ends),
// but never under 0.6 mm (two perimeters)
const SPRING_T = pickBy((m) => Math.min(1.6, Math.max(0.6, (0.7 * m.strain * SPRING_L ** 2) / (3 * PUSH))));
const N = 12;                 // points along each drawn spring
// The skeleton: a stiff core (PLA) in every rigid part, for a multi-material
// print in a soft TPU. The model already takes the links as rigid; the core
// makes them so, leaving the hinges to bend. Under a skin this thick all round.
const SKIN = 1.2;
const SKELETON = MATERIALS[0]; // PLA

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

type X = number | string;
async function solid(s: CadSession, comp: string, pts: [X, X][], op: boolean | "cut", name: string, height: X = Hz, z = 0): Promise<string> {
  const sk = (await dis(s, "sketch.create", { plane: "XY", ...(z ? { offset: z } : {}), component: comp, name }))[0];
  const ids: string[] = [];
  for (const [x, y] of pts) ids.push((await dis(s, "sketch.addPoint", { sketch: sk, x: String(x), y: String(y) }))[0]);
  for (let i = 0; i < ids.length; i++) await dis(s, "sketch.addLine", { sketch: sk, start: { ref: ids[i] }, end: { ref: ids[(i + 1) % ids.length] } });
  return (await dis(s, "feature.extrude", { sketch: sk, distance: String(height), operation: op === "cut" ? "cut" : op ? "new" : "join", name }))[0];
}
const rect = (x0: X, y0: X, x1: X, y1: X): [X, X][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const neg = (v: X) => (typeof v === "number" ? -v : `-(${v})`);
/** Half a flexure strip at (cx, cy) running along ±y (`dir` +1 up, −1 down)
 *  or ±x: the strip is split at its pivot, each part owning the half on its side. */
const halfY = (cx: X, cy: X, dir: 1 | -1): [X, X][] => rect(`${cx} - hingeT/2`, cy, `${cx} + hingeT/2`, `${cy} + ${dir}*(${hl} + 0.2)`);
const halfX = (cx: X, cy: X, dir: 1 | -1): [X, X][] => rect(cx, `${cy} - hingeT/2`, `${cx} + ${dir}*(${hl} + 0.2)`, `${cy} + hingeT/2`);
/** Mirror a left-side outline to the right. */
const mirror = (pts: [X, X][]): [X, X][] => pts.map(([x, y]) => [neg(x), y]);

/** A spring strip drawn from the left column's face to the stem as the
 *  plunger rises `push` and drifts left on the guide's arc: the fixed-guided
 *  shape 3s² − 2s³ (level at both ends), so it bends with it. */
function springStrip(y0: number): [X, X][] {
  const side = -1;
  const R = `(${SPRING_L} - hingeL)`, drift = `(${R} - sqrt(${R}^2 - push^2))`; // the guide links' pivots are R apart
  const pts = Array.from({ length: N + 1 }, (_, k) => {
    const t = k / N, p = 3 * t * t - 2 * t * t * t;
    return { x: `${side * colIn} + ${num(t)}*(${side * (stem - colIn)} - ${drift})`, y: `${y0} + ${num(p)}*push` };
  });
  return [...pts.map((q): [X, X] => [q.x, `${q.y} + springT/2`]), ...pts.reverse().map((q): [X, X] => [q.x, `${q.y} - springT/2`])];
}

/** The k-th of something counted by `springs` (k from 1) is there while springs ≥ k. */
const nth = (k: number) => (k === 1 ? "springs" : `max(0, springs - ${k - 1})`);

async function buildGripper(s: CadSession, opts: { springs?: number; skeleton?: boolean } = {}): Promise<void> {
  await dis(s, "parameter.add", { name: "push", expression: "0", min: 0, max: PUSH, step: 0.1 });
  await dis(s, "parameter.add", { name: "jaw", expression: String(JAW.value), min: JAW.range[0], max: JAW.range[1], step: 1 });
  await dis(s, "parameter.add", { name: "material", expression: String(DEFAULT_MATERIAL), options: MATERIALS.map((m) => m.name) });
  // how many grip springs: the grip's strength
  await dis(s, "parameter.add", { name: "springs", expression: String(opts.springs ?? 1), options: SPRINGS });
  // a PLA core in every link, for a two-material print (exports as a 3MF)
  await dis(s, "parameter.add", { name: "skeleton", expression: opts.skeleton ? "1" : "0", boolean: true });
  await dis(s, "parameter.add", { name: "hingeT", expression: pickBy((m) => m.t) });
  await dis(s, "parameter.add", { name: "hingeL", expression: pickBy((m) => m.L) });
  await dis(s, "parameter.add", { name: "springT", expression: SPRING_T });
  const mats: string[] = [];
  for (const m of MATERIALS) mats.push((await dis(s, "material.create", { name: m.name, kind: "plastic", finish: m.finish, color: m.color, youngsModulus: m.E, allowableStrain: m.strain }))[0]);
  const part = async (name: string) => { const c = (await dis(s, "component.create", { name }))[0]; await dis(s, "material.assign", { component: c, materials: mats, by: "material" }); return c; };
  const frame = await part("Frame"), plunger = await part("Plunger");
  const guide1 = await part("Guide lower"), guide2 = await part("Guide upper");
  const leverL = await part("Jaw left"), leverR = await part("Jaw right");
  const rodL = await part("Pushrod left"), rodR = await part("Pushrod right");

  // pivots: guide hinges sit a half-strip clear of the column and the stem, so
  // each strip bends free of both
  const Pg = `(${-colIn} + ${hl})`, Ps = `(${-stem} - ${hl})`;
  const Py = `(${barY} + ${hl})`; // the pushrods' plunger hinges, a half-strip above the crossbar

  // Each rigid part's core: its bars inset by the skin (overlapping where the
  // bars meet, so the core is one piece), clear of every hinge strip's root.
  const S = SKIN, inset = (x0: X, y0: X, x1: X, y1: X) => rect(`${x0} + ${S}`, `${y0} + ${S}`, `${x1} - ${S}`, `${y1} - ${S}`);
  const cores = new Map<string, [X, X][][]>();
  const colCore = inset(-Ox - 3, -80, -colIn, `${Oy} - ${hl}`);
  cores.set(frame, [inset(-Ox - 3, -80, Ox + 3, -74), colCore, mirror(colCore)]);
  cores.set(plunger, [inset(-10, -60, 10, -54), inset(-stem, -60, stem, `${Py} - ${hl}`), inset(-Qx - 4, barY - 6, Qx + 4, `${Py} - ${hl}`)]);
  for (const [g, y] of [[guide1, guideY[0]], [guide2, guideY[1]]] as const) cores.set(g, [inset(`${Pg} + ${hl}`, y - 3, `${Ps} - ${hl}`, y + 3)]);
  for (const [rod, lever, side] of [[rodL, leverL, -1], [rodR, leverR, 1]] as const) {
    const m = (pts: [X, X][]) => (side < 0 ? pts : mirror(pts));
    cores.set(rod, [m(inset(-Qx - 3, `${Py} + ${hl}`, -Qx + 3, `${Oy} - ${hl}`))]);
    cores.set(lever, [
      m(inset(-Ox - 3, `${Oy} + ${hl}`, -Qx + 3, `${Oy} + ${hl} + 6`)), // the lever
      m(inset(-Ox - 3, `${Oy} + ${hl}`, -Ox + 3, `${Oy} + jaw`)), // the jaw arm, down into the lever
      m(inset(-Ox - 3, `${Oy} + jaw - 6`, -3, `${Oy} + jaw`)), // the finger, across from the arm
    ]);
  }
  const skeletonParts: [string, string][] = [];
  /** Cut a part's core pockets (only while `skeleton` is ticked): run right
   *  after the part's own solids, so the cuts land on its body. */
  const pockets = async (part: string, name: string) => {
    skeletonParts.push([part, name]);
    for (const [k, r] of cores.get(part)!.entries()) {
      const f = await solid(s, part, r, "cut", `${name} pocket ${k + 1}`, Hz - 2 * SKIN, SKIN);
      await dis(s, "feature.setCondition", { feature: f, when: "skeleton" });
    }
  };

  // Frame: a base, two columns up to the jaw pivots.
  await solid(s, frame, rect(-Ox - 3, -80, Ox + 3, -74), true, "Base");
  for (const side of [-1, 1]) {
    const col = rect(-Ox - 3, -74, -colIn, `${Oy} - ${hl}`);
    await solid(s, frame, side < 0 ? col : mirror(col), false, `Column ${side < 0 ? "left" : "right"}`);
    const pivot = halfY(-Ox, Oy, -1);
    await solid(s, frame, side < 0 ? pivot : mirror(pivot), false, `Hinge jaw ${side < 0 ? "left" : "right"} (frame half)`);
  }
  for (const y of guideY) await solid(s, frame, halfX(Pg, y, -1), false, `Hinge guide ${y} (frame half)`);
  // the grip springs, drawn bending with the plunger (the frame owns them)
  for (const [k, y] of SPRING_Y.entries()) {
    const f = await solid(s, frame, springStrip(y), false, `Spring ${k + 1}`);
    await dis(s, "feature.setCondition", { feature: f, when: nth(k + 1) });
  }
  await pockets(frame, "Frame");

  // Plunger: a stem with a pad to push, a crossbar carrying both pushrods.
  await solid(s, plunger, rect(-stem, -58, stem, barY - 6), true, "Stem");
  await solid(s, plunger, rect(-10, -60, 10, -54), false, "Pad");
  await solid(s, plunger, rect(-Qx - 4, barY - 6, Qx + 4, `${Py} - ${hl}`), false, "Crossbar");
  for (const y of guideY) await solid(s, plunger, halfX(Ps, y, 1), false, `Hinge guide ${y} (plunger half)`);
  for (const side of [-1, 1]) { const h = halfY(-Qx, Py, -1); await solid(s, plunger, side < 0 ? h : mirror(h), false, `Hinge rod ${side < 0 ? "left" : "right"} (plunger half)`); }
  await pockets(plunger, "Plunger");

  // Guide links: parallel, frame to stem.
  for (const [g, y] of [[guide1, guideY[0]], [guide2, guideY[1]]] as const) {
    await solid(s, g, halfX(Pg, y, 1), true, `Hinge guide ${y} (link, frame end)`);
    await solid(s, g, rect(`${Pg} + ${hl}`, y - 3, `${Ps} - ${hl}`, y + 3), false, `Guide link ${y}`);
    await solid(s, g, halfX(Ps, y, -1), false, `Hinge guide ${y} (link, plunger end)`);
    await pockets(g, `Guide ${y}`);
  }

  // Pushrods and jaw levers, left then mirrored right.
  for (const [rod, lever, side] of [[rodL, leverL, -1], [rodR, leverR, 1]] as const) {
    const m = (pts: [X, X][]) => (side < 0 ? pts : mirror(pts));
    await solid(s, rod, m(halfY(-Qx, Py, 1)), true, "Hinge rod (rod, plunger end)");
    await solid(s, rod, m(rect(-Qx - 3, `${Py} + ${hl}`, -Qx + 3, `${Oy} - ${hl}`)), false, "Pushrod");
    await solid(s, rod, m(halfY(-Qx, Oy, -1)), false, "Hinge rod (rod, lever end)");
    await pockets(rod, `Pushrod ${side < 0 ? "left" : "right"}`);
    await solid(s, lever, m(halfY(-Qx, Oy, 1)), true, "Hinge rod (lever half)");
    await solid(s, lever, m(halfY(-Ox, Oy, 1)), false, "Hinge jaw (lever half)");
    // the lever: a beam across both hinges, the jaw arm rising from its outer end
    await solid(s, lever, m(rect(-Ox - 3, `${Oy} + ${hl}`, -Qx + 3, `${Oy} + ${hl} + 6`)), false, "Lever");
    await solid(s, lever, m(rect(-Ox - 3, `${Oy} + ${hl} + 6`, -Ox + 3, `${Oy} + jaw`)), false, "Jaw arm");
    await solid(s, lever, m(rect(-Ox + 2.9, `${Oy} + jaw - 6`, -3, `${Oy} + jaw`)), false, "Finger");
    await pockets(lever, `Jaw ${side < 0 ? "left" : "right"}`);
  }

  // The skeleton's cores, each a part of its own riding on its link (a child
  // component, so it moves with it) in PLA, filling the pockets cut above.
  for (const [parent, name] of skeletonParts) {
    const core = (await dis(s, "component.create", { name: `${name} core`, parent }))[0];
    await dis(s, "material.assign", { component: core, material: mats[0] });
    for (const [k, r] of cores.get(parent)!.entries()) {
      const f = await solid(s, core, r, k === 0, `${name} core ${k + 1}`, Hz - 2 * SKIN, SKIN);
      await dis(s, "feature.setCondition", { feature: f, when: "skeleton" });
    }
  }

  // Joints. The drive: the lower guide link turns so the plunger rises `push`.
  const flex = { kind: "flexure", axis: { x: 0, y: 0, z: 1 }, flexure: { length: "hingeL", width: Hz, thickness: "hingeT" } };
  const at = (x: X, y: X) => ({ x, y, z: 0 });
  const J = (base: string, moved: string, p: { x: X; y: X; z: number }, extra: Record<string, unknown>, name: string) =>
    dis(s, "joint.create", { ...flex, base, moved, baseOrigin: p, movedOrigin: p, ...extra, name });
  await J(frame, guide1, at(Pg, guideY[0]), { value: `deg(asin(push/(${Ps} - ${Pg})))` }, "Guide lower (frame)");
  await J(guide1, plunger, at(Ps, guideY[0]), { solve: true }, "Guide lower (plunger)");
  await J(frame, guide2, at(Pg, guideY[1]), { solve: true }, "Guide upper (frame)");
  await J(guide2, plunger, at(Ps, guideY[1]), { closes: true }, "Guide upper (plunger)");
  for (const [rod, lever, side, n] of [[rodL, leverL, -1, "left"], [rodR, leverR, 1, "right"]] as const) {
    await J(frame, lever, at(side * Ox, Oy), { solve: true }, `Jaw ${n} (frame)`);
    await J(lever, rod, at(side * Qx, Oy), { solve: true }, `Pushrod ${n} (jaw)`);
    await J(rod, plunger, at(side * Qx, Py), { closes: true }, `Pushrod ${n} (plunger)`);
  }
  // the grip springs: beams from the frame's columns to the stem, there while
  // `springs` counts them
  for (const [k, y] of SPRING_Y.entries()) {
    await dis(s, "joint.create", {
      kind: "beam", base: frame, moved: plunger, baseOrigin: at(-colIn, y), movedOrigin: at(-stem, y),
      beam: { width: Hz, thickness: "springT", when: nth(k + 1) }, name: `Spring ${k + 1}`,
    });
  }
}

const scopeOf = (s: CadSession) => resolveParameters(s.doc.parameters).scope;
/** The jaw tips' gap (mm) at a plunger travel, and how far each tip sits from
 *  the centre line (equal when the jaws open symmetrically). */
function jaws(s: CadSession, push: number) {
  const params = s.doc.parameters.map((p) => (p.name === "push" ? { ...p, expr: String(push) } : p));
  const scope = resolveParameters(params).scope;
  const world = resolveComponentWorld(s.doc, scope);
  const id = (n: string) => Object.values(s.doc.components).find((c) => c.name === n)!.id;
  const tipY = Oy + scope.jaw - 3;
  const L = applyPoint(world.get(id("Jaw left"))!, { x: -3, y: tipY, z: 0 }), R = applyPoint(world.get(id("Jaw right"))!, { x: 3, y: tipY, z: 0 });
  return { gap: R.x - L.x, left: -L.x, right: R.x };
}
const pushes = Array.from({ length: 11 }, (_, k) => (PUSH * k) / 10);

describe("compliant gripper", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("builds eight parts that print as one piece", async () => {
    const s = realSession();
    await buildGripper(s);
    await s.recompute();
    if (OUT) writeFileSync(`${OUT}/gripper.chisel.json`, serializeDocument(s.doc));
    for (const sk of Object.values(s.doc.sketches)) expect(sk.status.conflicting, `sketch ${sk.name}`).toBe(false);
    const scope = scopeOf(s);
    placeComponentSketches(s.doc, scope);
    const bodies = Object.values(evaluateFeatures(s.doc, scope));
    for (const b of bodies) expect(b.error, b.name).toBeUndefined();
    expect(bodies.filter((b) => b.mesh).length).toBe(8);
    expect(collideFeatures(s.doc, scope).maxOverlap).toBeLessThan(0.01); // they only touch, at the split strips
    const stl = exportFusedBlob(s.doc, scope, "stl");
    expect(stl && stl.size).toBeGreaterThan(10000);
    if (OUT) writeFileSync(`${OUT}/gripper.stl`, Buffer.from(await stl!.arrayBuffer()));
  }, 120000);

  it("pushing the plunger opens both jaws, amplified: three loops close, every hinge within its limit", async () => {
    const s = realSession();
    await buildGripper(s);
    await s.recompute();
    const poses = flexureSweep(s.doc, "push", pushes);
    for (const p of poses) {
      expect(p.error, `push ${p.value}`).toBeUndefined();
      expect(p.utilisation, `push ${p.value}`).toBeLessThan(1);
      expect(p.flexures.filter((f) => !f.beam).length).toBe(10);
    }
    const rest = jaws(s, 0), open = jaws(s, PUSH);
    const gain = (open.gap - rest.gap) / 2 / PUSH; // each tip's travel per mm of plunger
    console.log(`jaws ${rest.gap.toFixed(1)} → ${open.gap.toFixed(1)} mm for ${PUSH} mm of push (×${gain.toFixed(2)} per tip; lever ratio jaw/14 = ${(scopeOf(s).jaw / 14).toFixed(2)}); ` +
      `asymmetry ${Math.abs(open.left - open.right).toFixed(2)} mm; push force ${poses.map((p) => p.effort.toFixed(1)).join(" ")} N; peak strain ${(Math.max(...poses.map((p) => p.utilisation)) * MATERIALS[DEFAULT_MATERIAL].strain * 100).toFixed(1)}%`);
    expect(rest.gap).toBeCloseTo(6, 6);
    expect(gain).toBeGreaterThan(0.75 * (scopeOf(s).jaw / 14)); // the levers amplify (less a little geometry)
    expect(gain).toBeLessThan(1.1 * (scopeOf(s).jaw / 14));
    expect(Math.abs(open.left - open.right)).toBeLessThan(1); // the guide keeps the plunger (nearly) square
    // a spring: the push grows with travel, and it has nowhere to rest but closed
    for (let k = 1; k < poses.length; k++) expect(poses[k].effort).toBeGreaterThan(poses[k - 1].effort);
    const st = flexureEquilibria(s.doc, "push", 0, PUSH, 20);
    expect(st.multistable).toBe(false);
    const rests = st.states.filter((q) => q.stable).map((q) => q.value);
    expect(rests.length).toBe(1);
    expect(rests[0]).toBeCloseTo(0, 6);
  }, 120000);

  it("each grip spring adds 12EI/L³ to the push, and so to the grip, without changing how it moves", async () => {
    const rows: string[] = [];
    let last: { force: number; gap: number } | undefined;
    for (const springs of [0, 1, 2, 3]) {
      const s = realSession();
      await buildGripper(s, { springs });
      await s.recompute();
      const [half, full] = flexureSweep(s.doc, "push", [PUSH / 2, PUSH]);
      const sc = scopeOf(s), gain = (jaws(s, PUSH).gap - jaws(s, 0).gap) / 2 / PUSH;
      const k = (12 * MATERIALS[DEFAULT_MATERIAL].E * (Hz * sc.springT ** 3) / 12) / SPRING_L ** 3;
      // held open on something at half stroke, each tip squeezes it with
      // (push force)/(2·gain), by virtual work
      rows.push(`${SPRINGS[springs]}: push ${full.effort.toFixed(1)} N at ${PUSH} mm; grip ${(half.effort / (2 * gain)).toFixed(2)} N per jaw held half open; springs at ${(Math.max(0, ...full.flexures.filter((f) => f.beam).map((f) => f.strain)) * 100).toFixed(2)}%`);
      expect(full.utilisation).toBeLessThan(1);
      if (last) {
        expect((full.effort - last.force) / (k * PUSH)).toBeGreaterThan(0.95); // one more fixed-guided blade
        expect((full.effort - last.force) / (k * PUSH)).toBeLessThan(1.1);
        expect(jaws(s, PUSH).gap).toBeCloseTo(last.gap, 6); // the springs place nothing
      }
      last = { force: full.effort, gap: jaws(s, PUSH).gap };
    }
    console.log(rows.join("\n"));
  }, 300000);

  it("ticking skeleton puts a PLA core in every link, sealed in its skin and riding with it, and it saves as a two-part 3MF", async () => {
    const s = realSession();
    await buildGripper(s, { skeleton: true });
    await s.recompute();
    for (const push of [0, PUSH]) {
      await dis(s, "parameter.set", { name: "push", expression: String(push) });
      await s.recompute();
      const scope = scopeOf(s);
      placeComponentSketches(s.doc, scope);
      const bodies = Object.values(evaluateFeatures(s.doc, scope)).filter((b) => b.mesh);
      expect(bodies.length).toBe(16); // eight links, eight cores
      const c = collideFeatures(s.doc, scope);
      expect(c.buildError).toBeUndefined();
      // a core never touches anything but the pocket it fills
      for (const o of c.overlaps) expect(/core/.test(o.a) || /core/.test(o.b), `${o.a} × ${o.b} at push ${push}`).toBe(false);
    }
    await dis(s, "parameter.set", { name: "push", expression: "0" });
    await s.recompute();
    const geo = new InlineGeometryBackend();
    await geo.init({ wasmBinary: wasm });
    const bytes = (await geo.exportBytes(s.doc, null, "3mf"))!;
    if (OUT) writeFileSync(`${OUT}/gripper-skeleton.3mf`, bytes);
    const objects = modelObjects(readStoredZip(bytes)["3D/3dmodel.model"]);
    expect(objects.map((o) => o.name).sort()).toEqual([SKELETON.name, MATERIALS[DEFAULT_MATERIAL].name].sort());
    for (const o of objects) expect(openEdges(o), o.name).toBe(0);
    const pla = objects.find((o) => o.name === SKELETON.name)!;
    expect(pla.min.z).toBeCloseTo(SKIN, 3);
    expect(pla.max.z).toBeCloseTo(Hz - SKIN, 3);
  }, 300000);

  it("in every material, and at both jaw lengths, the hinges and all three springs stay within the limit and the loops close", async () => {
    const s = realSession();
    await buildGripper(s, { springs: 3 });
    await s.recompute();
    const rows: string[] = [];
    for (const [i, m] of MATERIALS.entries()) for (const jaw of JAW.range) {
      let worst = 0;
      for (const push of pushes) {
        const st = flexureState(s.doc, { material: String(i), jaw: String(jaw), push: String(push) });
        expect(st.error, `${m.name} jaw ${jaw} push ${push}`).toBeUndefined();
        worst = Math.max(worst, st.utilisation);
      }
      expect(worst, `${m.name} jaw ${jaw}`).toBeLessThan(1);
      rows.push(`${m.name}, jaw ${jaw}: worst hinge or spring ${(worst * m.strain * 100).toFixed(2)}% of ${m.strain * 100}%`);
    }
    console.log(rows.join("\n"));
  }, 120000);

  // The part as built clears itself through the stroke: with the as-designed
  // strip and the longest (PLA), at both jaw lengths.
  for (const name of ["TPU 68D (TPU for AMS)", "PLA"]) {
    it(`clears itself through the stroke, with all its springs, in ${name}`, async () => {
      const s = realSession();
      await buildGripper(s, { springs: 3 });
      await dis(s, "parameter.set", { name: "material", expression: String(MATERIALS.findIndex((m) => m.name === name)) });
      for (const jaw of JAW.range) {
        await dis(s, "parameter.set", { name: "jaw", expression: String(jaw) });
        await s.recompute();
        expect(materialForComponent(s.doc, Object.values(s.doc.components).find((c) => c.name === "Frame")!.id)?.name).toBe(name);
        for (const push of [0, PUSH / 2, PUSH]) {
          // posed for real: the springs are drawn following `push`
          await dis(s, "parameter.set", { name: "push", expression: String(push) });
          await s.recompute();
          const scope = scopeOf(s);
          placeComponentSketches(s.doc, scope);
          const c = collideFeatures(s.doc, scope);
          expect(c.buildError).toBeUndefined();
          // the split strip halves cross in a sliver as each hinge bends: Hz·t²/4·tan φ
          const sliver = (Hz * scope.hingeT ** 2 / 4) * Math.tan((21 * Math.PI) / 180) + 0.2;
          for (const o of c.overlaps) expect(o.volume, `${o.a} × ${o.b}, jaw ${jaw}, push ${push}`).toBeLessThan(Math.max(1, sliver));
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }, 300000);
  }
});
