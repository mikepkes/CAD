// feature.sheet.edit (a paper model's folds, cuts and progress edited in place: the Folds panel's command) and the
// panel's pure model (src/ui/foldsModel.ts: steps, moves, operations, the planner's errors by step).
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import type { CadSession } from "../src/core/command/session";
import type { SheetFeature, SheetFoldDef } from "../src/core/document";
import {
  addFolds, compactSteps, foldOp, foldsToParams, insertStep, isValley, moveFold, plainParam, removeFold, splitFoldErrors,
  stepCount, stepGroups, toggleValley, uniqueName, withAngle, withOp,
} from "../src/ui/foldsModel";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

const ok = async (s: CadSession, type: string, params: Record<string, unknown>) => {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds;
};
const sheetOf = (s: CadSession, id: string) => s.doc.features[id] as SheetFeature;

/** A 150 square paper on XY with three construction lines (the two midlines and a diagonal) and a sheet: ids. */
async function paper(s: CadSession) {
  const [sk] = await ok(s, "sketch.create", { plane: "XY", name: "Paper" });
  const rect = await ok(s, "sketch.addRectangle", { sketch: sk, corner: { x: -75, y: -75 }, opposite: { x: 75, y: 75 } });
  const line = async (a: [number, number], b: [number, number]) => (await ok(s, "sketch.addLine", { sketch: sk, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, construction: true }))[0];
  const v = await line([0, -75], [0, 75]);
  const h = await line([-75, 0], [75, 0]);
  const d = await line([-75, -75], [75, 75]);
  const [sheet] = await ok(s, "feature.sheet", { sketch: sk, name: "Paper", thickness: 0.1, radius: 0 });
  return { sk, edge: rect[4], v, h, d, sheet };
}

describe("feature.sheet.edit", () => {
  it("adds a fold in step 1, then a second step, replacing the folds and keeping the rest", async () => {
    const s = realSession();
    const p = await paper(s);
    await ok(s, "feature.sheet.edit", { feature: p.sheet, folds: [{ line: p.v, angle: 180, step: 1 }] });
    expect(sheetOf(s, p.sheet).folds).toEqual([{ line: p.v, angleExpr: "180", step: 1 }]);
    await ok(s, "parameter.add", { name: "fold", expression: "2", min: 0, max: 2 });
    const r = await s.dispatch("feature.sheet.edit", { feature: p.sheet, folds: [{ line: p.v, angle: 180, step: 1 }, { line: p.h, angle: -180, direction: "mountain", step: 2 }], progress: "fold" });
    expect(r.ok).toBe(true);
    expect(r.message).toBe("Paper: 2 folds in 2 steps");
    const f = sheetOf(s, p.sheet);
    expect(f.folds).toEqual([{ line: p.v, angleExpr: "180", step: 1 }, { line: p.h, angleExpr: "-180", direction: "mountain", step: 2 }]);
    expect(f.progressExpr).toBe("fold");
    expect(f.thicknessExpr).toBe("0.1"); // untouched
    expect(f.radiusExpr).toBe("0");
    // it is one timeline operation, undone in one step
    expect(s.timeline.filter((o) => o.type === "feature.sheet.edit")).toHaveLength(2);
    s.undo(); s.undo(); s.undo();
    expect(sheetOf(s, p.sheet).folds).toBeUndefined();
  });

  it("refuses a fold or cut that isn't a line of the sheet's sketch, and leaves the sheet as it was", async () => {
    const s = realSession();
    const p = await paper(s);
    const bad = await s.dispatch("feature.sheet.edit", { feature: p.sheet, folds: [{ line: "ln999", angle: 180, step: 1 }] });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/fold "ln999" isn't a line of Paper/);
    const pt = Object.values(s.doc.sketches[p.sk].entities).find((e) => e.kind === "point")!.id;
    const badCut = await s.dispatch("feature.sheet.edit", { feature: p.sheet, cuts: [pt] });
    expect(badCut.ok).toBe(false);
    expect(badCut.error).toMatch(/cut ".*" isn't a line/);
    expect((await s.dispatch("feature.sheet.edit", { feature: "nope" })).error).toMatch(/No feature "nope"/);
    expect(sheetOf(s, p.sheet).folds).toBeUndefined();
    expect(sheetOf(s, p.sheet).cuts).toBeUndefined();
  });

  it("checks steps as feature.sheet does: every fold a step, an angle unless a collapse, `with` in the same step", async () => {
    const s = realSession();
    const p = await paper(s);
    const e1 = await s.dispatch("feature.sheet.edit", { feature: p.sheet, folds: [{ line: p.v, angle: 180, step: 1 }, { line: p.h, angle: 180 }] });
    expect(e1.error).toMatch(/give every fold a `step`/);
    const e2 = await s.dispatch("feature.sheet.edit", { feature: p.sheet, folds: [{ line: p.v, step: 1 }] });
    expect(e2.error).toMatch(/give fold ".*" an `angle`/);
    const e3 = await s.dispatch("feature.sheet.edit", { feature: p.sheet, folds: [{ line: p.v, angle: 180, step: 1, collapse: true }, { line: p.h, step: 2, collapse: true, with: p.v }] });
    expect(e3.error).toMatch(/made in another step/);
    const e4 = await s.dispatch("feature.sheet.edit", { feature: p.sheet, folds: [{ line: p.v, angle: 90 }], progress: "1" });
    expect(e4.error).toMatch(/`progress` runs folds made in steps/);
    // a collapse's crease may be solved (no angle)
    expect((await s.dispatch("feature.sheet.edit", { feature: p.sheet, folds: [{ line: p.v, angle: 180, step: 1, collapse: true }, { line: p.h, step: 1, collapse: true, direction: "valley" }] })).ok).toBe(true);
  });

  it("sets cuts, the held point and the thickness; [] and null clear them; a line is a fold or a cut", async () => {
    const s = realSession();
    const p = await paper(s);
    await ok(s, "feature.sheet.edit", { feature: p.sheet, cuts: [p.d], fixed: { x: -30, y: 10 }, thickness: 0.05 });
    let f = sheetOf(s, p.sheet);
    expect(f.cuts).toEqual([p.d]);
    expect(f.fixed).toEqual({ x: -30, y: 10 });
    expect(f.thicknessExpr).toBe("0.05");
    const both = await s.dispatch("feature.sheet.edit", { feature: p.sheet, folds: [{ line: p.d, angle: 180, step: 1 }] });
    expect(both.error).toMatch(/both a fold and a cut/);
    await ok(s, "feature.sheet.edit", { feature: p.sheet, cuts: [], fixed: null });
    f = sheetOf(s, p.sheet);
    expect(f.cuts).toBeUndefined();
    expect(f.fixed).toBeUndefined();
    expect((await s.dispatch("feature.sheet.edit", { feature: p.sheet, fixed: { x: "a", y: 1 } })).ok).toBe(false);
  });

  it("refuses a feature that isn't a sheet", async () => {
    const s = realSession();
    const [sk] = await ok(s, "sketch.create", { plane: "XY" });
    await ok(s, "sketch.addRectangle", { sketch: sk, corner: { x: 0, y: 0 }, opposite: { x: 10, y: 10 } });
    const [ext] = await ok(s, "feature.extrude", { sketch: sk, distance: "5" });
    expect((await s.dispatch("feature.sheet.edit", { feature: ext, cuts: [] })).error).toMatch(/isn't a sheet/);
  });
});

describe("the Folds panel's paper, folded (kernel)", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("New paper's commands, then folds added a step at a time, build and fold", async () => {
    const s = realSession();
    // what createPaper (src/ui/FoldsPanel.tsx) dispatches
    await ok(s, "parameter.add", { name: "fold", expression: "0", min: 0, max: 1, step: 0.01 });
    const [sk] = await ok(s, "sketch.create", { plane: "XY", name: "Paper" });
    await ok(s, "sketch.addRectangle", { sketch: sk, corner: { x: -75, y: -75 }, opposite: { x: 75, y: 75 } });
    const [sheet] = await ok(s, "feature.sheet", { sketch: sk, name: "Paper", thickness: 0.1, radius: 0 });
    await ok(s, "feature.sheet.edit", { feature: sheet, progress: "fold" });
    const [mat] = await ok(s, "material.create", { name: "Paper", kind: "paper", color: "#f4f1ea", backColor: "#b33a2e" });
    await ok(s, "material.assign", { material: mat });
    const rows = () => evaluateFeatures(s.doc, resolveParameters(s.doc.parameters).scope);
    expect(rows()[sheet].error).toBeUndefined();
    // the user draws two construction lines and adds them as steps 1 and 2 (as the panel does)
    const line = async (a: [number, number], b: [number, number]) => (await ok(s, "sketch.addLine", { sketch: sk, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, construction: true }))[0];
    const v = await line([0, -75], [0, 75]);
    let folds = addFolds(sheetOf(s, sheet).folds ?? [], [v], 1);
    await ok(s, "feature.sheet.edit", { feature: sheet, folds: foldsToParams(folds) });
    const h = await line([-75, 0], [0, 0]); // across the half that stays: where it crosses the layer, flat
    folds = addFolds(sheetOf(s, sheet).folds ?? [], [h], stepCount(sheetOf(s, sheet).folds ?? []) + 1);
    await ok(s, "feature.sheet.edit", { feature: sheet, folds: foldsToParams(folds) });
    expect(sheetOf(s, sheet).folds!.map((f) => [f.line, f.step])).toEqual([[v, 1], [h, 2]]);
    for (const at of ["0", "1", "2"]) {
      await ok(s, "parameter.set", { name: "fold", expression: at });
      const r = rows()[sheet];
      expect(r.error, `fold = ${at}`).toBeUndefined();
      expect(r.mesh, `fold = ${at}`).toBeTruthy();
    }
    // folded in half twice: a quarter of the square's footprint
    const b = rows()[sheet].bounds!;
    expect(b.max.x - b.min.x).toBeLessThan(80);
    expect(b.max.y - b.min.y).toBeLessThan(80);
  }, 120000);
});

describe("folds model (the panel's edits)", () => {
  const F = (line: string, step?: number, extra: Partial<SheetFoldDef> = {}): SheetFoldDef => ({ line, angleExpr: "180", ...(step != null ? { step } : {}), ...extra });

  it("groups folds by step, empty steps and folds made at once included", () => {
    const g = stepGroups([F("a", 2), F("b", 1), F("c", 2)]);
    expect(g.map((x) => [x.step, x.folds.map((f) => f.index)])).toEqual([[1, [1]], [2, [0, 2]]]);
    expect(stepGroups([F("a"), F("b")]).map((x) => x.step)).toEqual([0]);
    expect(stepCount([F("a", 3)])).toBe(3);
    expect(stepGroups([F("a", 3)]).map((x) => x.folds.length)).toEqual([0, 0, 1]);
  });

  it("adds folds to a step or a new one, inserts steps, renumbers", () => {
    const base = [F("a", 1), F("b", 2)];
    expect(addFolds(base, ["c"], 3).map((f) => [f.line, f.step])).toEqual([["a", 1], ["b", 2], ["c", 3]]);
    expect(addFolds(base, ["c"], 9).map((f) => f.step)).toEqual([1, 2, 3]); // compacted
    expect(addFolds(base, ["c"], 1)[2]).toEqual({ line: "c", angleExpr: "180", direction: "valley", step: 1 });
    expect(addFolds([F("a")], ["c"], undefined)[1].step).toBeUndefined();
    // a step before step 2, holding the new fold
    expect(addFolds(insertStep(base, 2), ["c"], 2).map((f) => [f.line, f.step])).toEqual([["a", 1], ["b", 3], ["c", 2]]);
    expect(insertStep(base, 1).map((f) => f.step)).toEqual([2, 3]);
    expect(compactSteps([F("a", 2), F("b", 5)]).map((f) => f.step)).toEqual([1, 2]);
  });

  it("removes and moves folds, dropping a `with` left pointing across steps", () => {
    const folds = [F("a", 1, { collapse: true }), F("b", 1, { collapse: true, with: "a" }), F("c", 2)];
    expect(removeFold(folds, 0)).toEqual([{ line: "b", angleExpr: "180", step: 1, collapse: true }, F("c", 2)]);
    expect(removeFold([F("a", 1), F("c", 2)], 0)).toEqual([F("c", 1)]);
    // b later: it joins step 2, and its `with` (a, in step 1) goes
    expect(moveFold(folds, 1, 1).map((f) => [f.line, f.step, f.with])).toEqual([["a", 1, undefined], ["b", 2, undefined], ["c", 2, undefined]]);
    // a earlier, out of a shared first step: a new step 1 of its own
    expect(moveFold(folds, 0, -1).map((f) => [f.line, f.step])).toEqual([["a", 1], ["b", 2], ["c", 3]]);
    // c later, alone in the last step: nothing to do
    expect(moveFold(folds, 2, 1).map((f) => f.step)).toEqual([1, 1, 2]);
    // c earlier, alone: joins step 1
    expect(moveFold(folds, 2, -1).map((f) => f.step)).toEqual([1, 1, 1]);
  });

  it("maps operations to the fold's flags and back", () => {
    const f = F("a", 1, { direction: "valley" });
    expect(foldOp(f)).toBe("fold");
    for (const op of ["fold", "turn", "collapse", "through", "reverse-inside", "reverse-outside", "bend"] as const) expect(foldOp(withOp(f, op))).toBe(op);
    expect(withOp(f, "through", "up")).toMatchObject({ collapse: true, through: "up" });
    expect(withOp(withOp(f, "turn"), "fold").turn).toBeUndefined();
    expect(withOp(F("a", 1, { collapse: true, with: "b" }), "turn").with).toBeUndefined();
    expect(withOp({ line: "a", step: 1, collapse: true }, "fold").angleExpr).toBe("180"); // a plain fold needs an angle
  });

  it("valley / mountain flips the angle's sign, and a typed angle sets the direction", () => {
    expect(isValley(F("a"))).toBe(true);
    const m = toggleValley(F("a"));
    expect(m).toMatchObject({ angleExpr: "-180", direction: "mountain" });
    expect(isValley(m)).toBe(false);
    expect(toggleValley({ line: "a", angleExpr: "ang" }).angleExpr).toBe("-(ang)");
    expect(toggleValley({ line: "a", angleExpr: "-(ang)" }).angleExpr).toBe("ang");
    expect(toggleValley({ line: "a", collapse: true, direction: "valley" })).toEqual({ line: "a", collapse: true, direction: "mountain" });
    expect(withAngle(F("a"), "-90")).toMatchObject({ angleExpr: "-90", direction: "mountain" });
    expect(withAngle(F("a"), "").angleExpr).toBeUndefined();
    expect(foldsToParams([{ line: "a", angleExpr: "90", radiusExpr: "0", step: 1 }])).toEqual([{ line: "a", angle: "90", radius: "0", step: 1 }]);
  });

  it("splits the planner's error by the step it names", () => {
    const err = 'step 4 (fold "ln85", "ln89", …): the layer at (61.9, 35.4) would pass through the paper at crease "ln29"; step 4 (fold "ln85", "ln89", …): the layer at (1, 2) and the layer at (3, 4) lie in each other';
    const { top, byStep } = splitFoldErrors(err);
    expect(top).toEqual([]);
    expect(byStep[4]).toHaveLength(2);
    expect(byStep[4][0]).toMatch(/^step 4 \(fold "ln85"/);
    expect(splitFoldErrors("step 2: a turn is a step of its own").byStep[2]).toEqual(["step 2: a turn is a step of its own"]);
    expect(splitFoldErrors('fold "ln3" isn\'t a line of sketch "Paper"')).toEqual({ top: ['fold "ln3" isn\'t a line of sketch "Paper"'], byStep: {} });
    expect(splitFoldErrors(undefined)).toEqual({ top: [], byStep: {} });
  });

  it("names: a plain parameter, a free name", () => {
    expect(plainParam("fold", ["fold", "size"])).toBe("fold");
    expect(plainParam("fold*2", ["fold"])).toBeNull();
    expect(plainParam("other", ["fold"])).toBeNull();
    expect(uniqueName("fold", ["fold", "fold2"])).toBe("fold3");
    expect(uniqueName("fold", [])).toBe("fold");
  });
});
