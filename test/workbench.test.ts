import { describe, it, expect, beforeAll, vi } from "vitest";
import { realSession } from "./helpers";
import { featureRows, type FeatureRow } from "../src/model/concepts/featureCatalog";
import {
  quadrantDir, placePins, pinAnchors, pinState, leaderState, clusterLabel, componentLabel, otherComponentGroups, centreOf, unionBounds,
  featureIdOfFace, rowForFace, faceAreaFromMesh, measurements, formatArea, formatVolume, formatBounds,
  cardParams, paramsWith, pushed, pushParamOf, cardHeight, stripState, rollbackIndexForStep,
  visiblePins, clusterKey, hasMember, chooserSize, shouldDelete, deletePrompt,
  selectionContext, shouldDropSelection,
  crumbPath, isDescendant, showCrumb, rowsInScope, moreLabel, isAssemblyStep, stepLabel, assemblySteps, stripEntries,
  countText, stripRange, rangeValue, snapRollback, type StripEntry,
} from "../src/ui/concepts/workbench/workbench";
import type { OperationRecord } from "../src/core/command/types";
import type { SolidMesh } from "../src/core/occ/kernel";

const bounds = { w: 800, h: 600 };

describe("pin placement", () => {
  it("pushes a pin away from the viewport centre by quadrant", () => {
    expect(quadrantDir({ x: 100, y: 100 }, bounds)).toBe("nw");
    expect(quadrantDir({ x: 700, y: 100 }, bounds)).toBe("ne");
    expect(quadrantDir({ x: 100, y: 500 }, bounds)).toBe("sw");
    expect(quadrantDir({ x: 700, y: 500 }, bounds)).toBe("se");
  });
  it("skips hidden anchors and keeps pins inside the viewport", () => {
    const row = { featureId: "a" } as FeatureRow;
    const pins = placePins([
      { row, proj: { x: 700, y: 100, visible: true } },
      { row: { featureId: "b" } as FeatureRow, proj: { x: 0, y: 0, visible: false } },
      { row: { featureId: "c" } as FeatureRow, proj: { x: 798, y: 2, visible: true } },
    ], bounds);
    expect(pins.map((p) => p.row.featureId)).toEqual(["a", "c"]);
    expect(pins[0].pos.x).toBeGreaterThan(700); expect(pins[0].pos.y).toBeLessThan(100);
    expect(pins[1].pos.x).toBeLessThanOrEqual(800 - 14 - 4); expect(pins[1].pos.y).toBeGreaterThanOrEqual(18);
  });
  it("ranks pin states: open, then error, suppressed, rolled back", () => {
    const base = { featureId: "f", suppressed: false, rolledBack: false } as FeatureRow;
    expect(pinState(base, "f")).toBe("open");
    expect(pinState({ ...base, error: "x", suppressed: true }, null)).toBe("err");
    expect(pinState({ ...base, suppressed: true, rolledBack: true }, null)).toBe("off");
    expect(pinState({ ...base, rolledBack: true }, null)).toBe("ghost");
    expect(pinState(base, null)).toBe("");
    expect(leaderState({ ...base, suppressed: true }, null)).toBe("");
    expect(leaderState({ ...base, rolledBack: true }, null)).toBe("ghost");
  });
  it("labels clusters and component badges", () => {
    expect(clusterLabel([5, 3, 4])).toBe("3 · 4 · 5");
    expect(clusterLabel([3, 4, 5, 6])).toBe("3–6");
    expect(clusterLabel([1, 3, 4, 6])).toBe("1 · 3 · 4 · 6");
    expect(clusterLabel([])).toBe("");
    expect(componentLabel("Outer ring", 7)).toBe("Outer ring · 7");
  });
  it("gives a modifier without a body of its own the anchor of the body before it", () => {
    const body = { featureId: "e1", num: 1, componentId: "root", op: { params: {} }, solid: { bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 20, z: 24 } } } } as unknown as FeatureRow;
    const fillet = { featureId: "f2", num: 2, componentId: "root", op: { params: {} } } as unknown as FeatureRow;
    const other = { featureId: "g3", num: 3, componentId: "c1", op: { params: {} } } as unknown as FeatureRow;
    const [a, b, c] = pinAnchors([body, fillet, other]);
    expect(a?.z).toBe(24);
    expect(b?.z).toBe(24); expect(b?.x).not.toBe(a?.x);
    expect(c).toBeNull();
  });
  it("groups other components with the centre of their bounds", () => {
    const b = (x: number) => ({ min: { x, y: 0, z: 0 }, max: { x: x + 10, y: 10, z: 10 } });
    const rows = [
      { featureId: "a", componentId: "root", solid: { bounds: b(0) } },
      { featureId: "b", componentId: "c1", solid: { bounds: b(100) } },
      { featureId: "c", componentId: "c1", solid: { bounds: b(120) } },
      { featureId: "d", componentId: "c2", op: { params: {} } },
    ] as unknown as FeatureRow[];
    const groups = otherComponentGroups(rows, "root");
    expect(groups.map((g) => g.componentId)).toEqual(["c1", "c2"]);
    expect(groups[0].rows.length).toBe(2);
    expect(groups[0].centre).toEqual({ x: 115, y: 5, z: 5 });
    expect(groups[1].centre).toBeNull();
    expect(unionBounds([])).toBeNull();
    expect(centreOf([{ op: { params: { at: [{ x: 2, y: 4, z: 6 }] } } } as unknown as FeatureRow])).toEqual({ x: 2, y: 4, z: 6 });
  });
});

describe("faces and measurements", () => {
  it("maps a face name to its feature, else the body", () => {
    expect(featureIdOfFace("extrude3:end", "body9")).toBe("extrude3");
    expect(featureIdOfFace("fillet6:blend(box1:+X,box1:+Z)", "b")).toBe("fillet6");
    expect(featureIdOfFace(undefined, "body9")).toBe("body9");
    expect(featureIdOfFace(":weird", "body9")).toBe("body9");
    const rows = [{ featureId: "extrude3" }, { featureId: "fillet6", solid: { featureId: "extrude3" } }] as FeatureRow[];
    expect(rowForFace(rows, "fillet6:blend(a,b)", "extrude3")?.featureId).toBe("fillet6");
    expect(rowForFace(rows, undefined, "extrude3")?.featureId).toBe("extrude3");
    expect(rowForFace(rows, "gone1:end", "extrude3")?.featureId).toBe("extrude3");
    expect(rowForFace(rows, "gone1:end", "nope")).toBeUndefined();
  });
  it("sums a named face's triangles from the display mesh", () => {
    // a 10 × 20 rectangle split into two triangles, named "e1:end"; a second face of one triangle
    const mesh: SolidMesh = {
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 20, 0, 0, 20, 0, 0, 0, 5]),
      normals: new Float32Array(15), edges: new Float32Array(0), triangleCount: 3,
      indices: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 1, 4]),
      faceRanges: [0, 6, 6, 3], faceNames: ["e1:end", "e1:side"],
    };
    expect(faceAreaFromMesh(mesh, "e1:end")).toBeCloseTo(200);
    expect(faceAreaFromMesh(mesh, "e1:side")).toBeCloseTo(25);
    expect(faceAreaFromMesh(mesh, "nope")).toBeNull();
    expect(faceAreaFromMesh(undefined, "e1:end")).toBeNull();
    expect(faceAreaFromMesh({ ...mesh, faceNames: undefined }, "e1:end")).toBeNull();
    const m = measurements({ mesh, volume: 1500, area: 20000, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 20, z: 5 } } } as never, "e1:end");
    expect(m.map((x) => x.label)).toEqual(["Face area ≈", "Volume", "Surface", "Bounds"]);
    expect(m[0].title).toMatch(/mesh/);
    expect(m.map((x) => x.value)).toEqual(["200 mm²", "1.50 cm³", "200 cm²", "10.0 × 20.0 × 5.0 mm"]);
    expect(measurements(undefined, "x")).toEqual([]);
  });
  it("formats areas, volumes and bounds in sensible units, at the kit's magnitude precision", () => {
    expect(formatArea(12.34)).toBe("12.3 mm²");
    expect(formatArea(123456)).toBe("1,235 cm²");
    expect(formatVolume(999)).toBe("999 mm³");
    expect(formatVolume(1234567)).toBe("1,235 cm³");
    expect(formatVolume(19200)).toBe("19.2 cm³");
    expect(formatBounds({ min: { x: -1, y: 0, z: 0 }, max: { x: 1, y: 2.25, z: 3 } })).toBe("2.0 × 2.3 × 3.0 mm");
  });
});

describe("with a real session", () => {
  let s: ReturnType<typeof realSession>;
  let rows: FeatureRow[];
  beforeAll(async () => {
    s = realSession();
    await s.dispatch("parameter.add", { name: "h", expression: "12" });
    const sk = await s.dispatch("sketch.create", { plane: "XY" });
    const sid = sk.createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 0, y: 0 }, opposite: { x: 40, y: 20 } });
    await s.dispatch("feature.extrude", { sketch: sid, distance: "h*2" });
    await s.dispatch("feature.fillet", { radius: "1.5" });
    const sk2 = await s.dispatch("sketch.create", { plane: "XZ" });
    await s.dispatch("sketch.addRectangle", { sketch: sk2.createdIds[0], corner: { x: 0, y: 0 }, opposite: { x: 4, y: 2 } });
    await s.dispatch("feature.extrude", { sketch: sk2.createdIds[0], distance: "nope+1" });
    rows = featureRows(s.doc, s.timeline, s.rollbackIndex, {});
    expect(rows.length).toBe(3);
  });

  it("lists a card's params with values, and flags a failed expression", () => {
    const p = cardParams(rows[0]);
    expect(p.map((x) => [x.key, x.value, x.expr, x.unit, x.numeric])).toEqual([["distance", 24, "h*2", "mm", true]]);
    expect(p[0].spec).toEqual({ min: 0.5, max: 500, step: 0.5 });
    const bad = cardParams(rows[2]);
    expect(bad[0].numeric).toBe(false); expect(bad[0].expr).toBe("nope+1");
    expect(cardHeight(1)).toBeGreaterThan(cardHeight(0));
  });
  it("picks the active component's anchored rows for pins, keys clusters by their members and sizes the chooser", () => {
    const anchors = pinAnchors(rows);
    const mine = visiblePins(rows, anchors, rows[0].componentId);
    expect(mine.length).toBe(anchors.filter(Boolean).length);
    expect(visiblePins(rows, anchors, "elsewhere")).toEqual([]);
    expect(visiblePins(rows, rows.map(() => null), rows[0].componentId)).toEqual([]);
    const members = [{ row: rows[0] }, { row: rows[1] }];
    expect(clusterKey(members)).toBe(`${rows[0].featureId},${rows[1].featureId}`);
    expect(hasMember(members, rows[1].featureId)).toBe(true);
    expect(hasMember(members, rows[2].featureId)).toBe(false);
    expect(hasMember(members, null)).toBe(false);
    expect(chooserSize(3).h).toBeGreaterThan(chooserSize(1).h);
  });
  it("deletes only when the asker agrees (and without an asker)", async () => {
    expect(deletePrompt(rows[0])).toContain(rows[0].name);
    expect(await shouldDelete(rows[0], () => false)).toBe(false);
    expect(await shouldDelete(rows[0], async () => true)).toBe(true);
    expect(await shouldDelete(rows[0], undefined)).toBe(true);
  });
  it("builds editOperation params with one value changed as text", () => {
    const params = paramsWith(rows[0], "distance", 25.5);
    expect(params.distance).toBe("25.5");
    expect(params.sketch).toBe(rows[0].op.params.sketch);
    expect(rows[0].op.params.distance).toBe("h*2");
  });
  it("pushes a value by the param's step within bounds", () => {
    const push = pushParamOf(rows[0])!;
    expect(push.key).toBe("distance");
    expect(pushed(push.value, 1, push.spec)).toBe(24.5);
    expect(pushed(0.5, -1, push.spec)).toBe(0.5);
    expect(pushParamOf(undefined)).toBeNull();
    // the catalog's choice falls back to the first param the op carries; none carried, no push
    expect(pushParamOf({ ...rows[0], spec: { ...rows[0].spec, pushParam: undefined } })?.key).toBe("distance");
    expect(pushParamOf({ ...rows[0], exprs: {}, values: {} })).toBeNull();
    expect(pushParamOf({ ...rows[0], spec: { ...rows[0].spec, params: [], pushParam: undefined } })).toBeNull();
  });
  it("drops a face selection when its context changes, and keeps it through a parameter edit", () => {
    const ctx = selectionContext({ session: s, activeComponentId: s.doc.rootComponentId, mode: "model" });
    expect(ctx).toEqual({ timelineLength: s.timeline.length, rollbackIndex: s.rollbackIndex, activeComponentId: s.doc.rootComponentId, mode: "model" });
    expect(shouldDropSelection(ctx, { ...ctx })).toBe(false);
    expect(shouldDropSelection(ctx, { ...ctx, timelineLength: ctx.timelineLength + 1 })).toBe(true);
    expect(shouldDropSelection(ctx, { ...ctx, timelineLength: ctx.timelineLength - 1 })).toBe(true);
    expect(shouldDropSelection(ctx, { ...ctx, rollbackIndex: ctx.rollbackIndex - 1 })).toBe(true);
    expect(shouldDropSelection(ctx, { ...ctx, activeComponentId: "other" })).toBe(true);
    expect(shouldDropSelection(ctx, { ...ctx, mode: "sketch" })).toBe(true);
  });
  it("derives the strip: the row before the marker is 'at', later rows are ghosts", async () => {
    let st = stripState(rows, s.rollbackIndex, s.timeline.length);
    expect(st.chips.map((c) => c.state)).toEqual([undefined, undefined, "at"]);
    expect(st.built).toBe(3); expect(st.rolledBack).toBe(false);
    expect(st.text).toBe("All 3 features built");
    expect(st.chips[2].err).toBe(false);

    await s.moveRollback(rows[1].index + 1);
    const r2 = featureRows(s.doc, s.timeline, s.rollbackIndex, {});
    st = stripState(r2, s.rollbackIndex, s.timeline.length);
    expect(st.chips.map((c) => c.state)).toEqual([undefined, "at", "ghost"]);
    expect(st.built).toBe(2); expect(st.rolledBack).toBe(true);
    expect(st.text).toBe(`At 2 · ${r2[1].name} — new features insert here`);

    await s.moveRollback(rows[0].index);
    const r3 = featureRows(s.doc, s.timeline, s.rollbackIndex, {});
    st = stripState(r3, s.rollbackIndex, s.timeline.length);
    expect(st.atRow).toBeNull();
    expect(st.text).toMatch(/^At the start/);
    await s.moveRollback(s.timeline.length);
    expect(stripState([], 0, 0).text).toBe("No features yet");
  });
  it("maps a range step to a timeline index", () => {
    expect(rollbackIndexForStep(rows, 0, s.timeline.length)).toBe(rows[0].index);
    expect(rollbackIndexForStep(rows, 2, s.timeline.length)).toBe(rows[1].index + 1);
    expect(rollbackIndexForStep(rows, 3, s.timeline.length)).toBe(s.timeline.length);
    expect(rollbackIndexForStep([], 0, 4)).toBe(4);
  });
});

describe("component scope: the crumb and the scoped strip", () => {
  // root ─ Arm ─ Hand, one extrude each, in a real session (component.create ops are the assembly steps)
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
    expect(rows.map((r) => r.componentId)).toEqual([rootId, armId, handId]);
  });

  it("walks the parent chain for descendants", () => {
    expect(isDescendant(s.doc, handId, rootId)).toBe(true);
    expect(isDescendant(s.doc, handId, armId)).toBe(true);
    expect(isDescendant(s.doc, armId, handId)).toBe(false);
    expect(isDescendant(s.doc, armId, armId)).toBe(true);
    expect(isDescendant(s.doc, "nope", rootId)).toBe(false);
  });

  it("builds the crumb path root → active, and the root alone for unknown ids", () => {
    expect(crumbPath(s.doc, handId)).toEqual([{ id: rootId, name: "Root Component" }, { id: armId, name: "Arm" }, { id: handId, name: "Hand" }]);
    expect(crumbPath(s.doc, armId).map((c) => c.name)).toEqual(["Root Component", "Arm"]);
    expect(crumbPath(s.doc, rootId).map((c) => c.id)).toEqual([rootId]);
    expect(crumbPath(s.doc, "nope").map((c) => c.id)).toEqual([rootId]);
    // a root without a name falls back to the document id
    const doc = { ...s.doc, components: { ...s.doc.components, [rootId]: { ...s.doc.components[rootId], name: "" } } };
    expect(crumbPath(doc, rootId)[0].name).toBe(s.doc.id);
    expect(showCrumb(s.doc)).toBe(true);
    expect(showCrumb(realSession().doc)).toBe(false);
  });

  it("scopes rows to the active component and its descendants, counting the rest", () => {
    expect(rowsInScope(rows, s.doc, rootId)).toEqual({ rows, hidden: 0 });
    const arm = rowsInScope(rows, s.doc, armId);
    expect(arm.rows.map((r) => r.name)).toEqual(["Arm body", "Finger"]); expect(arm.hidden).toBe(1);
    const hand = rowsInScope(rows, s.doc, handId);
    expect(hand.rows.map((r) => r.name)).toEqual(["Finger"]); expect(hand.hidden).toBe(2);
    expect(moreLabel(1)).toBe("1 more in other component");
    expect(moreLabel(2)).toBe("2 more in other components");
  });

  it("knows the assembly steps and labels them", () => {
    expect(isAssemblyStep({ type: "component.create" })).toBe(true);
    expect(isAssemblyStep({ type: "joint.create" })).toBe(true);
    expect(isAssemblyStep({ type: "joint.template" })).toBe(true);
    expect(isAssemblyStep({ type: "assembly.pattern" })).toBe(true);
    expect(isAssemblyStep({ type: "component.connector" })).toBe(true);
    expect(isAssemblyStep({ type: "feature.extrude" })).toBe(false);
    expect(isAssemblyStep({ type: "sketch.create" })).toBe(false);
    expect(isAssemblyStep({ type: "parameter.add" })).toBe(false);
    const steps = assemblySteps(s.timeline, s.rollbackIndex, s.doc);
    expect(steps.map((e) => e.name)).toEqual(["Arm", "Hand"]);
    expect(steps.map((e) => e.num)).toEqual([undefined, undefined]);
    expect(steps[0].index).toBe(s.timeline.findIndex((op) => op.type === "component.create"));
    expect(steps.every((e) => !e.rolledBack && !e.suppressed && e.step?.type === "component.create")).toBe(true);
    const joint = { type: "joint.create", label: "Joint", createdIds: [], opId: "j", params: {}, at: 0 } as OperationRecord;
    expect(stepLabel(joint, s.doc)).toBe("Joint");
    expect(stepLabel({ ...joint, label: "" }, s.doc)).toBe("joint.create");
    expect(stepLabel({ ...joint, type: "component.create", createdIds: ["gone"] }, s.doc)).toBe("Joint");
    // a component.create rolled back out of the document keeps the name it asked for
    expect(stepLabel({ ...joint, type: "component.create", createdIds: ["gone"], params: { name: "Wrist" } }, s.doc)).toBe("Wrist");
    const armOp = s.timeline.find((op) => op.type === "component.create")!;
    expect(stepLabel(armOp, { ...s.doc, components: { [rootId]: s.doc.components[rootId] } })).toBe("Arm");
  });

  it("merges rows and steps at the root in timeline order, rows alone below it", () => {
    const root = stripEntries(rows, s.doc, rootId, s.timeline, s.rollbackIndex);
    expect(root.map((e) => e.name)).toEqual(["Base", "Arm", "Arm body", "Hand", "Finger"]);
    expect(root.map((e) => e.index)).toEqual([...root.map((e) => e.index)].sort((a, b) => a - b));
    expect(stripEntries(rows, s.doc, armId, s.timeline, s.rollbackIndex).map((e) => e.name)).toEqual(["Arm body", "Finger"]);
    expect(stripEntries(rows, s.doc, handId, s.timeline, s.rollbackIndex).map((e) => e.name)).toEqual(["Finger"]);
    expect(countText(root)).toBe("3 features and 2 assembly steps");
    expect(countText(rows)).toBe("3 features");
    expect(countText([root[1]])).toBe("1 assembly step");
    const st = stripState(root, s.rollbackIndex, s.timeline.length);
    expect(st.text).toBe("All 3 features and 2 assembly steps built");
    expect(st.chips.map((c) => c.state)).toEqual([undefined, undefined, undefined, undefined, "at"]);
  });

  it("ranges the input over the visible entries' global indices and snaps a drag to a stop", async () => {
    const hand = stripEntries(rows, s.doc, handId, s.timeline, s.rollbackIndex);
    expect(stripRange(hand)).toEqual({ min: rows[2].index, max: rows[2].index + 1, stops: [rows[2].index, rows[2].index + 1] });
    const arm = stripEntries(rows, s.doc, armId, s.timeline, s.rollbackIndex);
    const ra = stripRange(arm);
    expect(ra.min).toBe(rows[1].index); expect(ra.max).toBe(rows[2].index + 1);
    expect(ra.stops).toEqual([rows[1].index, rows[1].index + 1, rows[2].index + 1]);
    // a value between two stops (a sketch op the strip does not show) snaps to the nearest, later on a tie
    expect(snapRollback(ra, rows[1].index + 2)).toBe(rows[1].index + 1);
    expect(snapRollback(ra, rows[2].index)).toBe(rows[2].index + 1);
    expect(snapRollback(ra, rows[1].index)).toBe(rows[1].index);
    // the marker at the end of the timeline clamps to the scope's max; before the scope, to its min
    expect(rangeValue(ra, s.timeline.length)).toBe(ra.max);
    expect(rangeValue(ra, 0)).toBe(ra.min);
    expect(rangeValue(ra, rows[1].index + 1)).toBe(rows[1].index + 1);
    expect(stripRange([])).toEqual({ min: 0, max: 0, stops: [] });
    expect(snapRollback(stripRange([]), 4)).toBe(4);
    // rolled back to before the Finger: the hand's strip has it as a ghost and reads 'at the start'
    await s.moveRollback(rows[2].index);
    const r2 = featureRows(s.doc, s.timeline, s.rollbackIndex, {});
    const st = stripState(stripEntries(r2, s.doc, handId, s.timeline, s.rollbackIndex), s.rollbackIndex, s.timeline.length);
    expect(st.chips.map((c) => c.state)).toEqual(["ghost"]);
    expect(st.text).toMatch(/^At the start/);
    const stRoot = stripState(stripEntries(r2, s.doc, rootId, s.timeline, s.rollbackIndex), s.rollbackIndex, s.timeline.length);
    expect(stRoot.atRow?.name).toBe("Hand");
    expect(stRoot.text).toBe("At Hand — new features insert here");
    await s.moveRollback(s.timeline.length);
    const unsorted: StripEntry[] = [{ name: "b", index: 7, opId: "b", suppressed: false, rolledBack: false }, { name: "a", index: 2, opId: "a", suppressed: false, rolledBack: false }];
    expect(stripRange(unsorted)).toEqual({ min: 2, max: 8, stops: [2, 3, 8] });
  });
});
