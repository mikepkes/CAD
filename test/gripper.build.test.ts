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
import { placeComponentSketches, resolveComponentWorld } from "../src/core/recompute";
import { resolveParameters } from "../src/model/parameters";
import { flexureEquilibria, flexureState, flexureSweep } from "../src/sim/flexure";
import { applyPoint } from "../src/math/transform";
import { materialForComponent } from "../src/core/document";
import { HINGE_MATERIALS as MATERIALS, DEFAULT_HINGE_MATERIAL as DEFAULT_MATERIAL, pickBy } from "./flexure-materials";
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
const neg = (v: X) => (typeof v === "number" ? -v : `-(${v})`);
/** Half a flexure strip at (cx, cy) running along ±y (`dir` +1 up, −1 down)
 *  or ±x: the strip is split at its pivot, each part owning the half on its side. */
const halfY = (cx: X, cy: X, dir: 1 | -1): [X, X][] => rect(`${cx} - hingeT/2`, cy, `${cx} + hingeT/2`, `${cy} + ${dir}*(${hl} + 0.2)`);
const halfX = (cx: X, cy: X, dir: 1 | -1): [X, X][] => rect(cx, `${cy} - hingeT/2`, `${cx} + ${dir}*(${hl} + 0.2)`, `${cy} + hingeT/2`);
/** Mirror a left-side outline to the right. */
const mirror = (pts: [X, X][]): [X, X][] => pts.map(([x, y]) => [neg(x), y]);

async function buildGripper(s: CadSession): Promise<void> {
  await dis(s, "parameter.add", { name: "push", expression: "0", min: 0, max: PUSH, step: 0.1 });
  await dis(s, "parameter.add", { name: "jaw", expression: String(JAW.value), min: JAW.range[0], max: JAW.range[1], step: 1 });
  await dis(s, "parameter.add", { name: "material", expression: String(DEFAULT_MATERIAL), options: MATERIALS.map((m) => m.name) });
  await dis(s, "parameter.add", { name: "hingeT", expression: pickBy((m) => m.t) });
  await dis(s, "parameter.add", { name: "hingeL", expression: pickBy((m) => m.L) });
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

  // Frame: a base, two columns up to the jaw pivots.
  await solid(s, frame, rect(-Ox - 3, -80, Ox + 3, -74), true, "Base");
  for (const side of [-1, 1]) {
    const col = rect(-Ox - 3, -74, -colIn, `${Oy} - ${hl}`);
    await solid(s, frame, side < 0 ? col : mirror(col), false, `Column ${side < 0 ? "left" : "right"}`);
    const pivot = halfY(-Ox, Oy, -1);
    await solid(s, frame, side < 0 ? pivot : mirror(pivot), false, `Hinge jaw ${side < 0 ? "left" : "right"} (frame half)`);
  }
  for (const y of guideY) await solid(s, frame, halfX(Pg, y, -1), false, `Hinge guide ${y} (frame half)`);

  // Plunger: a stem with a pad to push, a crossbar carrying both pushrods.
  await solid(s, plunger, rect(-stem, -58, stem, barY - 6), true, "Stem");
  await solid(s, plunger, rect(-10, -60, 10, -54), false, "Pad");
  await solid(s, plunger, rect(-Qx - 4, barY - 6, Qx + 4, `${Py} - ${hl}`), false, "Crossbar");
  for (const y of guideY) await solid(s, plunger, halfX(Ps, y, 1), false, `Hinge guide ${y} (plunger half)`);
  for (const side of [-1, 1]) { const h = halfY(-Qx, Py, -1); await solid(s, plunger, side < 0 ? h : mirror(h), false, `Hinge rod ${side < 0 ? "left" : "right"} (plunger half)`); }

  // Guide links: parallel, frame to stem.
  for (const [g, y] of [[guide1, guideY[0]], [guide2, guideY[1]]] as const) {
    await solid(s, g, halfX(Pg, y, 1), true, `Hinge guide ${y} (link, frame end)`);
    await solid(s, g, rect(`${Pg} + ${hl}`, y - 3, `${Ps} - ${hl}`, y + 3), false, `Guide link ${y}`);
    await solid(s, g, halfX(Ps, y, -1), false, `Hinge guide ${y} (link, plunger end)`);
  }

  // Pushrods and jaw levers, left then mirrored right.
  for (const [rod, lever, side] of [[rodL, leverL, -1], [rodR, leverR, 1]] as const) {
    const m = (pts: [X, X][]) => (side < 0 ? pts : mirror(pts));
    await solid(s, rod, m(halfY(-Qx, Py, 1)), true, "Hinge rod (rod, plunger end)");
    await solid(s, rod, m(rect(-Qx - 3, `${Py} + ${hl}`, -Qx + 3, `${Oy} - ${hl}`)), false, "Pushrod");
    await solid(s, rod, m(halfY(-Qx, Oy, -1)), false, "Hinge rod (rod, lever end)");
    await solid(s, lever, m(halfY(-Qx, Oy, 1)), true, "Hinge rod (lever half)");
    await solid(s, lever, m(halfY(-Ox, Oy, 1)), false, "Hinge jaw (lever half)");
    // the lever: a beam across both hinges, the jaw arm rising from its outer end
    await solid(s, lever, m(rect(-Ox - 3, `${Oy} + ${hl}`, -Qx + 3, `${Oy} + ${hl} + 6`)), false, "Lever");
    await solid(s, lever, m(rect(-Ox - 3, `${Oy} + ${hl} + 6`, -Ox + 3, `${Oy} + jaw`)), false, "Jaw arm");
    await solid(s, lever, m(rect(-Ox + 2.9, `${Oy} + jaw - 6`, -3, `${Oy} + jaw`)), false, "Finger");
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
      expect(p.flexures.length).toBe(10);
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

  it("in every material, and at both jaw lengths, the hinges stay within the limit and the loops close", async () => {
    const s = realSession();
    await buildGripper(s);
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
      rows.push(`${m.name}, jaw ${jaw}: worst hinge ${(worst * m.strain * 100).toFixed(2)}% of ${m.strain * 100}%`);
    }
    console.log(rows.join("\n"));
  }, 120000);

  // The part as built clears itself through the stroke: with the as-designed
  // strip and the longest (PLA), at both jaw lengths.
  for (const name of ["TPU 68D (TPU for AMS)", "PLA"]) {
    it(`clears itself through the stroke, in ${name}`, async () => {
      const s = realSession();
      await buildGripper(s);
      await dis(s, "parameter.set", { name: "material", expression: String(MATERIALS.findIndex((m) => m.name === name)) });
      for (const jaw of JAW.range) {
        await dis(s, "parameter.set", { name: "jaw", expression: String(jaw) });
        await s.recompute();
        expect(materialForComponent(s.doc, Object.values(s.doc.components).find((c) => c.name === "Frame")!.id)?.name).toBe(name);
        for (const push of [0, PUSH / 2, PUSH]) {
          const params = s.doc.parameters.map((p) => (p.name === "push" ? { ...p, expr: String(push) } : p));
          const scope = resolveParameters(params).scope;
          const posed = { ...s.doc, parameters: params, sketches: Object.fromEntries(Object.entries(s.doc.sketches).map(([k, v]) => [k, { ...v }])) };
          placeComponentSketches(posed, scope);
          const c = collideFeatures(posed, scope);
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
