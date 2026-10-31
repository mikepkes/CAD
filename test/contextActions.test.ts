import { describe, it, expect, beforeAll } from "vitest";
import { realSession } from "./helpers";
import { featureRows, type FeatureRow } from "../src/model/concepts/featureCatalog";
import { pushEdit, stripRange } from "../src/ui/concepts/workbench/workbench";
import {
  historyRange, stepRollback, cycleRows, cycleFeature, parentComponent, nextLensSize, otherShape,
} from "../src/ui/concepts/contextActions.logic";

// root ─ Arm ─ Hand, one extrude each, in a real session (the component.create ops are the root's assembly steps)
let s: ReturnType<typeof realSession>;
let rows: FeatureRow[];
let armId: string, handId: string, rootId: string;
beforeAll(async () => {
  s = realSession();
  rootId = s.doc.rootComponentId;
  const sk = await s.dispatch("sketch.create", { plane: "XY" });
  await s.dispatch("sketch.addRectangle", { sketch: sk.createdIds[0], corner: { x: 0, y: 0 }, opposite: { x: 40, y: 20 } });
  await s.dispatch("feature.extrude", { sketch: sk.createdIds[0], distance: "10", name: "Base" });
  armId = (await s.dispatch("component.create", { name: "Arm" })).createdIds[0];
  const sk2 = await s.dispatch("sketch.create", { plane: "XY", component: armId });
  await s.dispatch("sketch.addRectangle", { sketch: sk2.createdIds[0], corner: { x: 100, y: 0 }, opposite: { x: 140, y: 20 } });
  await s.dispatch("feature.extrude", { sketch: sk2.createdIds[0], distance: "10", name: "Arm body" });
  handId = (await s.dispatch("component.create", { name: "Hand", parent: armId })).createdIds[0];
  const sk3 = await s.dispatch("sketch.create", { plane: "XY", component: handId });
  await s.dispatch("sketch.addRectangle", { sketch: sk3.createdIds[0], corner: { x: 200, y: 0 }, opposite: { x: 240, y: 20 } });
  await s.dispatch("feature.extrude", { sketch: sk3.createdIds[0], distance: "10", name: "Finger" });
  rows = featureRows(s.doc, s.timeline, s.rollbackIndex, {});
});

describe("history steps", () => {
  it("steps over the strip's stops, one at a time, and stops at either end", () => {
    const r = historyRange(rows, s.doc, rootId, s.timeline, s.rollbackIndex);
    expect(r).toEqual(stripRange([...rows, ...s.timeline.flatMap((op, index) => (op.type === "component.create" ? [{ index }] : []))] as never));
    const end = s.timeline.length;
    expect(r.max).toBe(end);
    const back = stepRollback(r, end, -1)!;
    expect(back).toBe(r.stops[r.stops.length - 2]);
    expect(stepRollback(r, back, 1)).toBe(end);
    expect(stepRollback(r, end, 1)).toBeNull();
    expect(stepRollback(r, r.min, -1)).toBeNull();
    // walking back from the end visits every stop in order
    const seen: number[] = [];
    for (let at: number | null = end; at != null; at = stepRollback(r, at, -1)) seen.push(at);
    expect(seen).toEqual([...r.stops].reverse());
  });

  it("reads a marker between stops (or outside the scope) the way the strip shows it", () => {
    const arm = historyRange(rows, s.doc, armId, s.timeline, s.rollbackIndex);
    expect(arm.stops).toEqual([rows[1].index, rows[1].index + 1, rows[2].index + 1]);
    // between Arm body and Finger: the strip shows it at Arm body's stop
    expect(stepRollback(arm, rows[1].index + 2, -1)).toBe(rows[1].index);
    expect(stepRollback(arm, rows[1].index + 2, 1)).toBe(rows[2].index + 1);
    // before the scope: the strip clamps to its first stop, so there is nothing further back
    expect(stepRollback(arm, 0, -1)).toBeNull();
    expect(stepRollback(arm, 0, 1)).toBe(rows[1].index + 1);
    // the end of the timeline clamps to the scope's last stop
    expect(stepRollback(arm, s.timeline.length, -1)).toBe(rows[1].index + 1);
    expect(stepRollback(stripRange([]), 3, -1)).toBeNull();
  });
});

describe("feature cycling", () => {
  it("cycles the active component's scope in timeline order, wrapping", () => {
    expect(cycleRows(rows, s.doc, rootId).map((r) => r.name)).toEqual(["Base", "Arm body", "Finger"]);
    expect(cycleRows(rows, s.doc, armId).map((r) => r.name)).toEqual(["Arm body", "Finger"]);
    const ids = ["a", "b", "c"];
    expect(cycleFeature(ids, "a", 1)).toBe("b");
    expect(cycleFeature(ids, "c", 1)).toBe("a");
    expect(cycleFeature(ids, "a", -1)).toBe("c");
    expect(cycleFeature(ids, null, 1)).toBe("a");
    expect(cycleFeature(ids, "elsewhere", -1)).toBe("c");
    expect(cycleFeature([], "a", 1)).toBeNull();
  });
});

describe("components", () => {
  it("goes up the crumb path, and nowhere from the root", () => {
    expect(parentComponent(s.doc, handId)).toBe(armId);
    expect(parentComponent(s.doc, armId)).toBe(rootId);
    expect(parentComponent(s.doc, rootId)).toBeNull();
    expect(parentComponent(s.doc, "nope")).toBeNull();
  });
});

describe("push/pull", () => {
  it("steps the row's push param by its step, within bounds, and sends the op's other params unchanged", () => {
    const e = pushEdit(rows[0], 1)!;
    expect(e.opId).toBe(rows[0].opId);
    expect(e.params.distance).toBe("10.5");
    expect(e.params.sketch).toBe(rows[0].op.params.sketch);
    expect(pushEdit(rows[0], -1)!.params.distance).toBe("9.5");
    expect(pushEdit(undefined, 1)).toBeNull();
    expect(pushEdit({ ...rows[0], exprs: {}, values: {} }, 1)).toBeNull();
    // an expression that does not evaluate has nothing to push
    expect(pushEdit({ ...rows[0], values: { ...rows[0].values, distance: NaN } }, 1)).toBeNull();
  });
});

describe("lens", () => {
  it("cycles sizes and flips the shape", () => {
    expect(nextLensSize("S")).toBe("M");
    expect(nextLensSize("M")).toBe("L");
    expect(nextLensSize("L")).toBe("S");
    expect(otherShape("lens")).toBe("wipe");
    expect(otherShape("wipe")).toBe("lens");
  });
});
