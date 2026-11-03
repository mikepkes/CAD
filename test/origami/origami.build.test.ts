// A paper airplane — the classic dart — folded from a flat sheet, step by step,
// on one `fold` slider: 0 is the flat sheet, 6 the finished plane.
//   1  fold the top corners in to the centre line
//   2  fold the new slanted edges in to the centre line again
//   3  turn it over
//   4  fold it in half along the centre (the folded flaps outside)
//   5  stand it up on its keel (turn it about the wing line)
//   6  fold the wings out level
// Each step's line is drawn once on the flat sheet; folding in steps
// (core/sheetSequence.ts) carries it through every layer stacked there, so
// steps 2, 4 and 6 crease the earlier flaps with the sheet. The paper is
// white on top and coloured underneath, so the folds turn the colour out.
// Size it with `width` and `length` (A4 by default).
//   BUILD_ORIGAMI=/abs/out npx vitest run test/origami.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, describeExample, expectCommittedExample } from "../helpers";
import { initKernel } from "../../src/core/occ/kernel";
import { serializeDocument } from "../../src/core/persistence";
import { evaluateFeatures, SolidEval } from "../../src/core/features";
import { resolveParameters } from "../../src/core/parameters";
import { sequenceAngles, poseSequence, sequenceClashes, SheetSequence } from "../../src/core/sheetSequence";
import { applyPoint, applyVec, compose } from "../../src/math/transform";
import type { CadSession } from "../../src/core/command/session";

const OUT = process.env.BUILD_ORIGAMI || "";
const wasm = readFileSync(fileURLToPath(new URL("../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

const STEPS = 6;
const deg = Math.PI / 180;
// the second folds bisect the first: 22.5° off the centre line; the wing line bisects again (11.25°)
const S2 = "sin(rad(22.5))", C2 = "cos(rad(22.5))", TW = "tan(rad(11.25))";
const REACH = `min(width/2/${S2}, length/${C2})`; // the second fold runs from the nose to the sheet's edge (or its tail)

async function buildOrigami(s: CadSession): Promise<{ sheet: string; lines: Record<string, string> }> {
  for (const [name, val, min, max, step] of [["width", 210, 150, 240, 1], ["length", 297, 260, 340, 1], ["fold", STEPS, 0, STEPS, 0.01]] as const) {
    await dis(s, "parameter.add", { name, expression: String(val), min, max, step });
  }
  const sk = (await dis(s, "sketch.create", { plane: "XY", name: "Sheet" }))[0];
  // the sheet: nose at the top (y = length), tail along the x axis
  const corners: string[] = [];
  for (const [x, y] of [["-width/2", "0"], ["width/2", "0"], ["width/2", "length"], ["-width/2", "length"]]) corners.push((await dis(s, "sketch.addPoint", { sketch: sk, x, y }))[0]);
  for (let i = 0; i < 4; i++) await dis(s, "sketch.addLine", { sketch: sk, start: { ref: corners[i] }, end: { ref: corners[(i + 1) % 4] } });
  const line = async (a: [string, string], b: [string, string]) =>
    (await dis(s, "sketch.addLine", { sketch: sk, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, construction: true }))[0];
  const nose: [string, string] = ["0", "length"];
  const lines = {
    cornerL: await line(nose, ["-width/2", "length-width/2"]),
    cornerR: await line(nose, ["width/2", "length-width/2"]),
    edgeL: await line(nose, [`-${REACH}*${S2}`, `length-${REACH}*${C2}`]),
    edgeR: await line(nose, [`${REACH}*${S2}`, `length-${REACH}*${C2}`]),
    centre: await line(["0", "0"], nose),
    wingL: await line(nose, [`-length*${TW}`, "0"]),
    wingR: await line(nose, [`length*${TW}`, "0"]),
  };
  const sheet = (await dis(s, "feature.sheet", {
    sketch: sk, name: "Paper airplane", thickness: 0.1, radius: 0,
    fixed: { x: -10, y: 20 }, // held by the keel, near the tail
    progress: "fold",
    folds: [
      { line: lines.cornerL, step: 1, angle: 180 },
      { line: lines.cornerR, step: 1, angle: 180 },
      { line: lines.edgeL, step: 2, angle: 180 },
      { line: lines.edgeR, step: 2, angle: 180 },
      { line: lines.centre, step: 3, angle: 180, turn: true },
      { line: lines.centre, step: 4, angle: -180 },
      { line: lines.wingL, step: 5, angle: 90, turn: true },
      { line: lines.wingL, step: 6, angle: 90 },
      { line: lines.wingR, step: 6, angle: 90 },
    ],
  }))[0];
  // origami paper: white on top, red underneath — the outside of the finished plane
  const mat = (await dis(s, "material.create", { name: "Origami paper", kind: "paper", color: "#f4f1ea", backColor: "#a81c2c" }))[0];
  await dis(s, "material.assign", { material: mat });
  // the fold lines are the model's, not the paper's: only the creases folded so far show
  const hid = await s.setHidden([sk]);
  if (!hid.ok) throw new Error(`hide: ${hid.error}`);
  // how it reads in the customize viewer: a title, a line about it, and each control's label and unit
  await describeExample(s, {"title": "Paper airplane", "description": "The classic dart, folded from a flat sheet step by step. Slide through the folds, or change the paper."}, {"width": {"label": "Paper width", "unit": "mm", "description": "210 mm is an A4 sheet"}, "length": {"label": "Paper length", "unit": "mm", "description": "297 mm is an A4 sheet"}, "fold": {"label": "Fold", "unit": "of 6", "description": "0 is the flat sheet; 6 the finished plane"}});
  return { sheet, lines };
}

function evaluate(s: CadSession, overrides: Record<string, number> = {}): Record<string, SolidEval> {
  const scope = { ...resolveParameters(s.doc.parameters).scope, ...overrides };
  return evaluateFeatures(s.doc, scope);
}

/** Where a flat point of the sheet is (world), the sheet posed at `progress`. */
function placeOf(seq: SheetSequence, frame: Parameters<typeof compose>[0], progress: number) {
  const T = poseSequence(seq, sequenceAngles(seq, progress));
  const facetOf = (p: { x: number; y: number }) => seq.facets.findIndex((f) => f.poly.every((a, i) => {
    const b = f.poly[(i + 1) % f.poly.length];
    return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= -1e-6;
  }));
  return {
    at(x: number, y: number) { const k = facetOf({ x, y }); expect(k, `(${x}, ${y}) on the sheet`).toBeGreaterThanOrEqual(0); return applyPoint(compose(frame, T[k]), { x, y, z: 0 }); },
    normal(x: number, y: number) { const k = facetOf({ x, y }); return applyVec(compose(frame, T[k]), { x: 0, y: 0, z: 1 }); },
  };
}

describe("origami: a paper airplane folded step by step", () => {
  let s: CadSession;
  let ids: { sheet: string; lines: Record<string, string> };
  beforeAll(async () => {
    await initKernel({ wasmBinary: wasm });
    s = realSession();
    ids = await buildOrigami(s);
    await s.recompute();
  }, 120000);

  it("builds the finished plane from one sheet of A4", async () => {
    if (OUT) writeFileSync(`${OUT}/origami.json`, serializeDocument(s.doc));
    expectCommittedExample(s, "origami");
    for (const sk of Object.values(s.doc.sketches)) expect(sk.status.conflicting, `sketch ${sk.name}`).toBe(false);
    const out = evaluate(s);
    for (const r of Object.values(out)) expect(r.error, r.name).toBeUndefined();
    const b = out[ids.sheet];
    expect(b.surface).toBe(true);
    expect(b.area).toBeCloseTo(210 * 297, 3); // folding keeps the paper
    const seq = b.sheet!.sequence!;
    expect(seq.plan.steps).toBe(STEPS);
    // every fold creases every layer of its flap: the wing folds go through the flaps folded in steps 1 and 2
    const creasesOf = (line: string) => seq.plan.creases.filter((c) => c.folds.some((j) => seq.plan.folds[j].id === line && !seq.plan.folds[j].turn));
    expect(creasesOf(ids.lines.cornerL).length).toBe(1);
    expect(creasesOf(ids.lines.edgeL).length).toBe(2);   // the sheet and the corner flap on it
    expect(creasesOf(ids.lines.centre).length).toBe(1);
    expect(creasesOf(ids.lines.wingL).length).toBe(4);   // the sheet, the edge flap, and the corner flap (in two pieces since step 2)
    expect(creasesOf(ids.lines.wingR).length).toBe(4);
    // the mesh carries the paper's flat coordinates, so its fibres stay put as it folds
    expect(b.mesh!.uvs!.length).toBe((b.mesh!.positions.length / 3) * 2);
  }, 120000);

  it("is the classic dart when done: wings level and span-symmetric, the keel straight down under them", async () => {
    const seq = evaluate(s)[ids.sheet].sheet!.sequence!;
    const P = placeOf(seq.plan, seq.frame, STEPS);
    const W = 210, H = 297, keel = H * Math.tan(11.25 * deg), gap = 0.1;
    const nose = P.at(0, H - 1e-3), tipL = P.at(-W / 2, 0), tipR = P.at(W / 2, 0), hingeL = P.at(-keel + 1e-3, 0), hingeR = P.at(keel - 1e-3, 0), spine = P.at(0, 0);
    // the wings lie level, at one height, their tips equally either side of the keel
    expect(Math.abs(P.normal(-W / 2 + 5, 10).z)).toBeCloseTo(1, 6);
    expect(Math.abs(P.normal(W / 2 - 5, 10).z)).toBeCloseTo(1, 6);
    expect(tipL.z).toBeCloseTo(tipR.z, 1);
    expect(Math.hypot(tipL.x - hingeL.x, tipL.y - hingeL.y)).toBeCloseTo(W / 2 - keel, 0);
    expect(Math.hypot(tipR.x - hingeR.x, tipR.y - hingeR.y)).toBeCloseTo(W / 2 - keel, 0);
    // ... opposite ways: the tips (the tail's corners, swept back 11.25° off square to the wing roots) a span apart
    expect(Math.abs(Math.hypot(tipL.x - tipR.x, tipL.y - tipR.y) - 2 * (W / 2 - keel) * Math.cos(11.25 * deg))).toBeLessThan(1.5);
    // the keel hangs straight down from the wing roots: the tail edge runs from the root down to the
    // spine, 11.25° off square to the root line (the wing line's slant)
    expect(Math.abs(P.normal(-5, 10).z)).toBeLessThan(1e-6);
    expect(hingeL.z - spine.z).toBeCloseTo(keel * Math.cos(11.25 * deg), 0);
    expect(Math.hypot(spine.x - hingeL.x, spine.y - hingeL.y)).toBeCloseTo(keel * Math.sin(11.25 * deg), 0);
    // the nose is the tip of every fold: the wing roots run back from it, level
    expect(nose.z).toBeCloseTo(hingeL.z, 0);
    expect(Math.hypot(hingeL.x - nose.x, hingeL.y - nose.y, hingeL.z - nose.z)).toBeCloseTo(H / Math.cos(11.25 * deg), 0);
    // the folded flaps meet on the centre line (classic dart): the corner and the edge fold their tips to it
    const near = (a: { x: number; y: number; z: number }, b: typeof a) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    expect(near(P.at(-W / 2 + 1e-3, H - 1e-3), P.at(-1e-3, H - W / 2))).toBeLessThan(10 * gap);                  // the corner, folded to the centre
    expect(near(P.at(-W / 2 + 1e-3, H - W / 2 - 1e-3), P.at(-1e-3, H - W / Math.SQRT2))).toBeLessThan(10 * gap); // the edge's top, folded to the centre
    // wing tops are the paper's underside (coloured): their top's normal (+z of the sheet) points down
    expect(P.normal(-W / 2 + 5, 10).z).toBeLessThan(0);
    expect(P.normal(W / 2 - 5, 10).z).toBeLessThan(0);
  });

  it("never passes through itself, from flat to finished", () => {
    const seq = evaluate(s)[ids.sheet].sheet!.sequence!.plan;
    const hits: string[] = [];
    for (let k = 0; k <= STEPS * 40; k++) {
      const p = k / 40;
      const c = sequenceClashes(seq, sequenceAngles(seq, p), 0.5);
      if (c.length) hits.push(`fold ${p}: facets ${c.map(([a, b]) => `${a}×${b}`).join(", ")}`);
    }
    expect(hits).toEqual([]);
  });

  it("folds part-way through each step, and lies flat at 0", () => {
    const at = (fold: number) => { const r = evaluate(s, { fold })[ids.sheet]; expect(r.error).toBeUndefined(); return r; };
    const flat = at(0);
    expect(flat.bounds!.min.z).toBeCloseTo(0, 6);
    expect(flat.bounds!.max.z).toBeCloseTo(0, 6);
    expect([flat.bounds!.min.x, flat.bounds!.max.x, flat.bounds!.min.y, flat.bounds!.max.y]).toEqual([-105, 105, 0, 297].map((v) => expect.closeTo(v, 4)));
    // half way through the corners: they stand up off the sheet
    const corners = at(0.5);
    expect(corners.bounds!.max.z).toBeGreaterThan(30);
    expect(corners.bounds!.min.z).toBeCloseTo(0, 6);
    // the corners and edges folded in: a dart-shaped sheet, layers stacked a paper thickness apart
    const two = at(2);
    expect(two.bounds!.max.z).toBeGreaterThan(0.2);
    expect(two.bounds!.max.z).toBeLessThan(1);
    expect(two.bounds!.max.x - two.bounds!.min.x).toBeCloseTo(210, 3); // the tail is still full width
    // folded in half: half as wide
    const four = at(4);
    expect(four.bounds!.max.x - four.bounds!.min.x).toBeLessThan(106);
    for (const fold of [1.5, 2.5, 3.5, 4.5, 5.5]) at(fold);
  }, 120000);

  it("folds at every size the sliders allow", async () => {
    for (const [width, length] of [[150, 260], [240, 260], [150, 340], [240, 340]]) {
      await dis(s, "parameter.set", { name: "width", expression: String(width) });
      await dis(s, "parameter.set", { name: "length", expression: String(length) });
      const out = evaluate(s);
      const b = out[ids.sheet];
      expect(b.error, `${width} × ${length}`).toBeUndefined();
      expect(b.area).toBeCloseTo(width * length, 2);
      const seq = b.sheet!.sequence!.plan;
      for (const p of [1, 2, 3.5, 5, 5.5, 6]) expect(sequenceClashes(seq, sequenceAngles(seq, p), 0.5), `${width} × ${length} at fold ${p}`).toEqual([]);
    }
    await dis(s, "parameter.set", { name: "width", expression: "210" });
    await dis(s, "parameter.set", { name: "length", expression: "297" });
  }, 120000);
});
