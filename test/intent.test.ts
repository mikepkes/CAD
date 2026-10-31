import { describe, it, expect, beforeAll, vi } from "vitest";
import { realSession } from "./helpers";
import { featureRows, FeatureRow } from "../src/model/concepts/featureCatalog";
import { resolve, fuzzy, parseNumber, tokenize, moveSelection, buildCtx, VIEWS, IntentCtx, IntentAction } from "../src/ui/concepts/intent/intent";
import { parseIntent } from "../src/model/concepts/intents";
import { execute, Executor } from "../src/ui/concepts/intent/execute";

const ACTIONS = [
  { id: "view.frame", label: "Frame selection / fit" },
  { id: "view.front", label: "View: Front" },
  { id: "edit.undo", label: "Undo" },
  { id: "sketch.construction", label: "Toggle construction" },
  { id: "intent.open", label: "Intent line" },
];

const ctxOf = (rows: FeatureRow[], extra: Partial<IntentCtx> = {}): IntentCtx => ({
  rows, params: [{ name: "h", value: 12, min: 2, max: 40 }, { name: "wall_t", value: 3 }], views: VIEWS, actions: ACTIONS, intents: ["mass <= 120"], timelineLength: 99, ...extra,
});
const top = (text: string, ctx: IntentCtx) => resolve(text, ctx)[0];
const actions = (text: string, ctx: IntentCtx) => resolve(text, ctx).map((s) => s.action);

describe("intent grammar: pieces", () => {
  it("fuzzy ranks exact > prefix > word prefix > subsequence > none", () => {
    const e = fuzzy("front", "front"), p = fuzzy("fro", "front"), w = fuzzy("rad", "Bend radius"), s = fuzzy("exd", "Extrude 1"), n = fuzzy("zzz", "front");
    expect(e).toBe(1);
    expect(p).toBeGreaterThan(w); expect(w).toBeGreaterThan(s); expect(s).toBeGreaterThan(n); expect(n).toBe(0);
    expect(fuzzy("Upright Wall", "upright wall")).toBe(1);
  });
  it("parses numbers with units and rejects words", () => {
    expect(parseNumber("12")).toBe(12); expect(parseNumber("12mm")).toBe(12); expect(parseNumber("-1.5")).toBe(-1.5);
    expect(parseNumber("30deg")).toBe(30); expect(parseNumber("30°")).toBe(30); expect(parseNumber("2,5")).toBe(2.5);
    expect(parseNumber("front")).toBeNull(); expect(parseNumber("")).toBeNull(); expect(parseNumber("1e5")).toBeNull();
  });
  it("tokenizes, splitting '=' and joining a trailing unit", () => {
    expect(tokenize("h=12")).toEqual(["h", "=", "12"]);
    expect(tokenize("Extrude 1 distance 12 mm")).toEqual(["extrude", "1", "distance", "12mm"]);
  });
  it("moves the selection with wrap", () => {
    expect(moveSelection(0, 1, 3)).toBe(1); expect(moveSelection(2, 1, 3)).toBe(0); expect(moveSelection(0, -1, 3)).toBe(2); expect(moveSelection(0, 1, 0)).toBe(0);
  });
});

describe("intent grammar: resolve", () => {
  let rows: FeatureRow[];
  let ctx: IntentCtx;
  beforeAll(async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "h", expression: "12" });
    const sk = await s.dispatch("sketch.create", { plane: "XY" });
    const sid = sk.createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 0, y: 0 }, opposite: { x: 40, y: 20 } });
    await s.dispatch("feature.extrude", { sketch: sid, distance: "h*2" });
    await s.dispatch("feature.fillet", { radius: "1.5" });
    await s.dispatch("feature.shell", { thickness: "2", openFaces: { parallelTo: "XY" } });
    rows = featureRows(s.doc, s.timeline, s.rollbackIndex, {});
    expect(rows.map((r) => r.spec.kind)).toEqual(["extrude", "fillet", "shell"]);
    ctx = ctxOf(rows);
  });

  it("returns nothing for an empty line", () => {
    expect(resolve("", ctx)).toEqual([]);
    expect(resolve("   ", ctx)).toEqual([]);
  });

  it("'<param> <number>' and '<param> = <number>' set a parameter, warning outside its bounds", () => {
    const a = top("h 15", ctx);
    expect(a.action).toEqual({ type: "setParameter", name: "h", expr: "15" });
    expect(a.message).toBe("Set h to 15.");
    expect(top("h = 15", ctx).action).toEqual({ type: "setParameter", name: "h", expr: "15" });
    expect(top("h 99", ctx).detail).toMatch(/outside its bounds/);
    expect(top("wall_t 4", ctx).action).toEqual({ type: "setParameter", name: "wall_t", expr: "4" });
  });

  it("'<feature> <number>' edits the only param of that feature, snapped to its spec", () => {
    const a = top("fillet 3", ctx);
    expect(a.action.type).toBe("editOperation");
    const act = a.action as Extract<IntentAction, { type: "editOperation" }>;
    expect(act.opId).toBe(rows[1].opId);
    expect(act.params.radius).toBe("3");
    expect(act.params.edges).toEqual(rows[1].op.params.edges); // the other params ride along
    // quantized to the fillet's 0.1 step and clamped to its range
    expect((top("fillet 3.14", ctx).action as Extract<IntentAction, { type: "editOperation" }>).params.radius).toBe("3.1");
    expect((top("fillet 500", ctx).action as Extract<IntentAction, { type: "editOperation" }>).params.radius).toBe("50");
  });

  it("'<number> <param> <number>' and '<feature> <label> <number>' address a feature by number or name", () => {
    const byNum = top("2 radius 3", ctx).action as Extract<IntentAction, { type: "editOperation" }>;
    expect(byNum.opId).toBe(rows[1].opId); expect(byNum.params.radius).toBe("3");
    const byName = top("extrude 1 distance 12", ctx).action as Extract<IntentAction, { type: "editOperation" }>;
    expect(byName.opId).toBe(rows[0].opId); expect(byName.params.distance).toBe("12");
    expect(byName.params.sketch).toBe(rows[0].op.params.sketch);
    const bare = top("extrude 12", ctx).action as Extract<IntentAction, { type: "editOperation" }>;
    expect(bare.opId).toBe(rows[0].opId);
  });

  it("'wall 5' finds the shell by its param label alone", () => {
    const a = top("wall 5", ctx);
    expect(a.action).toMatchObject({ type: "editOperation", opId: rows[2].opId });
    expect((a.action as Extract<IntentAction, { type: "editOperation" }>).params.thickness).toBe("5");
    expect(a.label).toMatch(/^3 · Shell.* · Wall → 5\.0 mm$/);
    expect(a.detail).toMatch(/^Now 2\.0 mm/);
  });

  it("a parameter and a feature param with the same name both appear, the parameter first", () => {
    const list = resolve("h 10", ctxOf(rows, { params: [{ name: "h", value: 1 }] }));
    expect(list[0].action.type).toBe("setParameter");
  });

  it("views and fit/frame", () => {
    expect(top("front", ctx).action).toEqual({ type: "view", view: "front" });
    expect(top("iso", ctx).action).toEqual({ type: "view", view: "iso" });
    expect(top("fit", ctx).action).toEqual({ type: "frame" });
    expect(top("frame", ctx).action).toEqual({ type: "frame" });
    // "fro" still prefers the view; the hotkey "View: Front" is not listed twice
    const list = resolve("fro", ctx);
    expect(list[0].action).toEqual({ type: "view", view: "front" });
    expect(list.some((s) => s.action.type === "hotkey" && s.action.id === "view.front")).toBe(false);
  });

  it("builds the resolver's context from the session, the rows, the active hotkey contexts and the intents", () => {
    const session = { doc: { parameters: [{ name: "h", value: 12, min: 2, max: 40, step: 1 }] }, timeline: [1, 2, 3, 4, 5, 6, 7] };
    const c = buildCtx(session, rows, [{ active: true, actions: [{ id: "a.b", label: "A B" }] }, { active: false, actions: [{ id: "x.y", label: "X" }] }], [parseIntent("mass <= 120", "i1")!]);
    expect(c.rows).toBe(rows);
    expect(c.params).toEqual([{ name: "h", value: 12, min: 2, max: 40, step: 1 }]);
    expect(c.views).toBe(VIEWS);
    expect(c.actions).toEqual([{ id: "a.b", label: "A B" }]);
    expect(c.intents).toEqual(["mass <= 120"]);
    expect(c.timelineLength).toBe(7);
  });

  it("'back to <feature>' and 'roll <n>' move the rollback marker to just after that feature", () => {
    expect(top("back to fillet", ctx).action).toEqual({ type: "rollback", index: rows[1].index + 1 });
    expect(top("roll 1", ctx).action).toEqual({ type: "rollback", index: rows[0].index + 1 });
    // "end" is the end of the whole timeline (a sketch drawn after the last feature builds too), as the history strip's button does
    expect(top("roll end", ctx).action).toEqual({ type: "rollback", index: 99 });
    expect(top("roll end", ctx).action).toEqual(top("roll all", ctx).action);
  });

  it("suppress / unsuppress by name, and unsuppress alone lists what is suppressed", () => {
    expect(top("suppress shell", ctx).action).toEqual({ type: "suppress", opId: rows[2].opId, suppressed: true });
    expect(resolve("unsuppress", ctx)).toEqual([]);
    const sup = ctxOf(rows.map((r, i) => (i === 1 ? { ...r, suppressed: true } : r)));
    expect(top("unsuppress", sup).action).toEqual({ type: "suppress", opId: rows[1].opId, suppressed: false });
    expect(resolve("suppress fillet", sup)).toEqual([]); // already suppressed
  });

  it("undo / redo", () => {
    expect(top("undo", ctx).action).toEqual({ type: "undo" });
    expect(top("redo", ctx).action).toEqual({ type: "redo" });
  });

  it("'measure <feature>' and a bare feature name open its card", () => {
    expect(top("measure shell", ctx).action).toEqual({ type: "openFeature", featureId: rows[2].featureId });
    expect(top("measure 2", ctx).action).toEqual({ type: "openFeature", featureId: rows[1].featureId });
    expect(top("fillet", ctx).action).toEqual({ type: "openFeature", featureId: rows[1].featureId });
  });

  it("panel names toggle panels", () => {
    expect(top("ledger", ctx).action).toEqual({ type: "togglePanel", panel: "ledger" });
    expect(top("lens", ctx).action).toEqual({ type: "togglePanel", panel: "lens" });
    expect(top("workb", ctx).action).toEqual({ type: "togglePanel", panel: "workbench" });
  });

  it("a comparator makes a design intent, and says when it already exists", () => {
    const a = top("mass <= 120", ctx);
    expect(a.action).toEqual({ type: "addIntent", label: "mass", lhs: "mass", op: "<=", rhs: "120" });
    expect(a.detail).toMatch(/Already/);
    const b = top("h*2 > wall_t", ctx);
    expect(b.action).toEqual({ type: "addIntent", label: "h*2", lhs: "h*2", op: ">", rhs: "wall_t" });
    expect(b.detail).not.toMatch(/Already/);
    expect(resolve("h <= ", ctx)).toEqual([]);
  });

  it("hotkey action labels run the action, fuzzily", () => {
    expect(top("toggle constr", ctx).action).toEqual({ type: "hotkey", id: "sketch.construction" });
    expect(actions("intent line", ctx)).not.toContainEqual({ type: "hotkey", id: "intent.open" });
  });

  it("ranks, caps and gives stable ids", () => {
    const list = resolve("e", ctx);
    expect(list.length).toBeLessThanOrEqual(8);
    for (let i = 1; i < list.length; i++) expect(list[i - 1].score).toBeGreaterThanOrEqual(list[i].score);
    expect(list.map((s) => s.id)).toEqual(list.map((_, i) => `intent-${i}`));
  });

  it("works with no features at all", () => {
    const empty = ctxOf([], { params: [] });
    expect(resolve("wall 5", empty)).toEqual([]);
    expect(top("top", empty).action).toEqual({ type: "view", view: "top" });
    expect(resolve("back to 1", empty)).toEqual([]);
  });

  it("names a rolled-back feature's state", () => {
    const rb = ctxOf(rows.map((r, i) => (i === 2 ? { ...r, rolledBack: true } : r)));
    expect(top("wall 5", rb).detail).toMatch(/rolled back/);
  });
});

describe("execute maps each action to one command-path call", () => {
  const fake = () => {
    const calls: unknown[][] = [];
    const rec = (name: string) => (...a: unknown[]) => { calls.push([name, ...a]); };
    const x: Executor = {
      setParameterExpr: rec("setParameterExpr"), editOperation: rec("editOperation"), moveRollback: rec("moveRollback"), suppressOperation: rec("suppressOperation"),
      undo: rec("undo"), redo: rec("redo"), fire: rec("fire"), runAction: vi.fn((id: string) => id !== "nope"), setOpenFeature: rec("setOpenFeature"), togglePanel: rec("togglePanel"),
      addIntent: vi.fn((text: string, label: string) => { calls.push(["addIntent", text, label]); return text !== "bad < 1"; }),
    };
    return { x, calls };
  };
  it("routes every action", async () => {
    const { x, calls } = fake();
    await execute({ type: "setParameter", name: "h", expr: "5" }, x);
    await execute({ type: "editOperation", opId: "op1", params: { radius: "2" } }, x);
    await execute({ type: "view", view: "front" }, x);
    await execute({ type: "frame" }, x);
    await execute({ type: "rollback", index: 3 }, x);
    await execute({ type: "suppress", opId: "op2", suppressed: true }, x);
    await execute({ type: "undo" }, x);
    await execute({ type: "redo" }, x);
    await execute({ type: "openFeature", featureId: "f1" }, x);
    await execute({ type: "togglePanel", panel: "ledger" }, x);
    await execute({ type: "addIntent", label: "mass", lhs: "mass", op: "<=", rhs: "120" }, x);
    await execute({ type: "hotkey", id: "sketch.construction" }, x);
    expect(calls).toEqual([
      ["setParameterExpr", "h", "5"], ["editOperation", "op1", { radius: "2" }], ["fire", "chisel:view", "front"], ["fire", "chisel:frame"],
      ["moveRollback", 3], ["suppressOperation", "op2", true], ["undo"], ["redo"], ["setOpenFeature", "f1"], ["togglePanel", "ledger"],
      ["addIntent", "mass <= 120", "mass"],
    ]);
    expect(x.runAction).toHaveBeenCalledWith("sketch.construction");
  });
  it("reports a hotkey action that is not available, and an intent the Ledger rejects", async () => {
    const { x } = fake();
    await expect(execute({ type: "hotkey", id: "nope" }, x)).rejects.toThrow(/not available/);
    await expect(execute({ type: "addIntent", label: "bad", lhs: "bad", op: "<", rhs: "1" }, x)).rejects.toThrow(/not a comparison/);
  });
});
