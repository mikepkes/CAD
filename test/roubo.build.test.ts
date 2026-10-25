// Builds a Roubo-style workbench as a wood assembly: each board, leg and
// stretcher is its own component (built in its local frame, placed by the
// component transform), and the leg vise's chop is on a SLIDER joint driven by
// a `viseGap` parameter — a working, joint-driven vice. Serializes to an example.
//   BUILD_ROUBO=/abs/out npx vitest run test/roubo.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { serializeDocument } from "../src/core/persistence";
import { evaluateFeatures } from "../src/core/features";
import { placeComponentSketches } from "../src/core/recompute";
import { resolveParameters } from "../src/model/parameters";
import type { CadSession } from "../src/core/command/session";

const OUT = process.env.BUILD_ROUBO || "";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

// Bench dimensions (mm).
const LEN = 1700, DEPTH = 546, TOP_Z = 90, TOP_BOT = 800;
const LEG = 90, LEG_H = 800;
const NB = 7, BW = DEPTH / NB;          // top laminations
const RAIL_Z = 150, RAIL_H = 80;
// Centre the whole bench on the origin so it frames well from any orbit.
const O = { x: -LEN / 2, y: -DEPTH / 2, z: -(LEG_H + TOP_Z) / 2 };
const at = (x: number, y: number, z: number) => ({ x: x + O.x, y: y + O.y, z: z + O.z });

/** A board = its own component, built in local frame [0,bx]×[0,by]×[0,bz] and
 *  placed at `pos`. (Sketch on XY, extruded up +Z.) */
async function board(s: CadSession, name: string, pos: { x: number; y: number; z: number }, dim: [number, number, number]): Promise<string> {
  const cmp = (await dis(s, "component.create", { name, position: pos }))[0];
  const sid = (await dis(s, "sketch.create", { plane: "XY", component: cmp }))[0];
  await dis(s, "sketch.addRectangle", { sketch: sid, corner: { x: 0, y: 0 }, opposite: { x: dim[0], y: dim[1] } });
  await dis(s, "feature.extrude", { sketch: sid, distance: String(dim[2]) });
  return cmp;
}

function bounds(s: CadSession, filter?: (name: string) => boolean): { bodies: number; byName: Record<string, { minY: number; maxY: number; minZ: number; maxZ: number }> } {
  const scope = resolveParameters(s.doc.parameters).scope;
  placeComponentSketches(s.doc, scope);
  const solids = Object.values(evaluateFeatures(s.doc, scope)).filter((b) => b.mesh && b.bounds);
  const byName: Record<string, { minY: number; maxY: number; minZ: number; maxZ: number }> = {};
  let bodies = 0;
  for (const b of solids) {
    const comp = s.doc.sketches[b.sketchId]?.componentId;
    const nm = comp ? s.doc.components[comp]?.name ?? comp : b.name;
    if (filter && !filter(nm)) continue;
    bodies++;
    byName[nm] = { minY: b.bounds!.min.y, maxY: b.bounds!.max.y, minZ: b.bounds!.min.z, maxZ: b.bounds!.max.z };
  }
  return { bodies, byName };
}

describe("build Roubo workbench (wood assembly + leg vise)", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("assembles the bench from boards and the vise chop slides on its joint", async () => {
    const s = realSession();
    await dis(s, "parameter.add", { name: "viseGap", expression: "40", min: 0, max: 160, step: 5 });

    // Top: laminated boards running the length, stacked across the width.
    for (let i = 0; i < NB; i++) await board(s, `Top board ${i + 1}`, at(0, i * BW, TOP_BOT), [LEN, BW - 0.6, TOP_Z]);

    // Legs (flush with the front edge, Roubo style).
    const legX = [100, LEN - 100 - LEG];
    const legY = [0, DEPTH - LEG];
    const legName = ["Leg FL", "Leg FR", "Leg BL", "Leg BR"];
    let k = 0;
    for (const y of legY) for (const x of legX) await board(s, legName[k++], at(x, y, 0), [LEG, LEG, LEG_H]);

    // Stretchers: two long rails front/back + two end rails, a jointed-looking base.
    await board(s, "Front rail", at(190, 10, RAIL_Z), [LEN - 380, 40, RAIL_H]);
    await board(s, "Back rail", at(190, DEPTH - 50, RAIL_Z), [LEN - 380, 40, RAIL_H]);
    await board(s, "End rail L", at(100, LEG, RAIL_Z), [LEG, DEPTH - 2 * LEG, RAIL_H]);
    await board(s, "End rail R", at(LEN - 100 - LEG, LEG, RAIL_Z), [LEG, DEPTH - 2 * LEG, RAIL_H]);

    // ---- Leg vise: the chop (moving jaw) rides a SLIDER joint on the front-left leg.
    // Chop local box [0,120]×[0,40]×[0,500]; its joint seats local origin at P and
    // slides it along -Y (away from the leg face at Y=0) by `viseGap`.
    const chop = (await dis(s, "component.create", { name: "Vise chop" }))[0];
    const chopSk = (await dis(s, "sketch.create", { plane: "XY", component: chop }))[0];
    await dis(s, "sketch.addRectangle", { sketch: chopSk, corner: { x: 0, y: 0 }, opposite: { x: 120, y: 40 } });
    await dis(s, "feature.extrude", { sketch: chopSk, distance: "500" });
    // Screw: a cylinder from the chop's front face back through the chop into the
    // leg (handle at the front). Its own child component so it can be steel.
    const screw = (await dis(s, "component.create", { name: "Vise screw", parent: chop }))[0];
    const scrSk = (await dis(s, "sketch.create", { plane: "XZ", component: screw }))[0];
    await dis(s, "sketch.addCircle", { sketch: scrSk, center: { x: 60, y: 250 }, radius: 14 });
    await dis(s, "feature.extrude", { sketch: scrSk, distance: "130", direction: "reverse" });

    const P = at(100 + LEG / 2 - 60, -40, 300); // centre the 120-wide chop on the 90 leg
    await dis(s, "joint.create", { kind: "slider", moved: chop, baseOrigin: P, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: -1, z: 0 }, value: "viseGap", name: "Vise slide" });

    // ---- Materials: white oak everywhere (document default), steel screw.
    const oak = (await dis(s, "material.create", { name: "White Oak", kind: "wood", species: "white-oak" }))[0];
    const steel = (await dis(s, "material.create", { name: "Steel", kind: "metal", finish: "satin", color: "#8a8f96" }))[0];
    await dis(s, "material.assign", { material: oak });                    // root = default
    await dis(s, "material.assign", { material: steel, component: screw });

    await s.recompute();

    // Serialize the clean construction (before the sweeps append parameter.set ops).
    if (OUT) writeFileSync(`${OUT}/roubo.chisel.json`, serializeDocument(s.doc));

    // 7 top + 4 legs + 4 rails + chop + screw = 17 bodies; 16 components under root.
    const all = bounds(s);
    expect(all.bodies).toBe(17);
    expect(Object.keys(s.doc.components).length).toBe(1 + 7 + 4 + 4 + 1 + 1); // root + boards + chop + screw
    expect(Object.keys(s.doc.materials).length).toBe(2); // oak + steel

    // The vise WORKS: the whole chop (board + screw) rides the slider. Closing
    // (viseGap 0) seats the chop's back face at the leg front (Y≈0); opening
    // (viseGap 160) pulls the whole assembly 160mm forward (−Y).
    const chopSpan = () => {
      const sc = resolveParameters(s.doc.parameters).scope; placeComponentSketches(s.doc, sc);
      let lo = Infinity, hi = -Infinity, boardBack = -Infinity;
      for (const b of Object.values(evaluateFeatures(s.doc, sc))) {
        if (!b.bounds || s.doc.sketches[b.sketchId]?.componentId !== chop) continue;
        lo = Math.min(lo, b.bounds.min.y); hi = Math.max(hi, b.bounds.max.y);
        if (b.bounds.max.z - b.bounds.min.z > 100) boardBack = Math.max(boardBack, b.bounds.max.y); // the tall jaw board (not the screw)
      }
      return { lo, hi, boardBack };
    };
    await dis(s, "parameter.set", { name: "viseGap", expression: "0" }); await s.recompute();
    const closed = chopSpan();
    await dis(s, "parameter.set", { name: "viseGap", expression: "160" }); await s.recompute();
    const open = chopSpan();
    expect(Math.abs(closed.boardBack - O.y)).toBeLessThan(1);        // closed: jaw back at the leg front (world y = O.y)
    expect(Math.abs((open.lo - closed.lo) - -160)).toBeLessThan(1);  // whole chop slid 160mm
    expect(Math.abs((open.hi - closed.hi) - -160)).toBeLessThan(1);
    console.log(`roubo: ${all.bodies} bodies; vise jaw back ${closed.boardBack.toFixed(0)}mm (closed) → chop slid ${(open.lo - closed.lo).toFixed(0)}mm open`);
  }, 120000);
});
