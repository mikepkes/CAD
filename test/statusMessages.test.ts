// What the app says about what just happened: undo/redo name the step, an edit
// reports itself (not the message its op gave when first added), a refused
// over-constraint names the constraints, and the history strip doesn't claim
// "built" while a rebuild is still running (M12, M13, P16, V18, V19).

import { describe, it, expect } from "vitest";
import { realSession } from "./helpers";
import { stripState } from "../src/ui/concepts/workbench/workbench";
import { describeConstraint, listWords } from "../src/sketch/types";
import { sketchStatus } from "../src/ui/sketchStatus";

describe("undo labels", () => {
  it("name what undo and redo would do, and edits report themselves", async () => {
    const s = realSession();
    expect(s.undoLabel()).toBeNull();
    const add = await s.dispatch("parameter.add", { name: "width", expression: "40" });
    expect(add.message).toBe("Added parameter width");
    expect(s.undoLabel()).toBe("Add parameter");
    const op = s.timeline[0];
    const edit = await s.editOperation(op.opId, { ...op.params, expression: "50" });
    // P16: a value change is not "Added parameter width"
    expect(edit.message).toBe("Set width = 50");
    expect(s.undoLabel()).toBe("Set width = 50");
    s.undo();
    expect(s.redoLabel()).toBe("Set width = 50");
    expect(s.undoLabel()).toBe("Add parameter");
  });

  it("labels suppress, delete and rename steps by the thing they touch", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "h", expression: "10" });
    const sk = await s.dispatch("sketch.create", { plane: "XY" });
    await s.dispatch("sketch.addRectangle", { sketch: sk.createdIds[0], corner: { x: 0, y: 0 }, opposite: { x: 10, y: 10 } });
    const ex = await s.dispatch("feature.extrude", { sketch: sk.createdIds[0], distance: "h", name: "Plate" });
    expect(ex.message).toBe("Extrude Sketch 1"); // the sketch's name, not its id
    await s.setSuppressed(ex.opId!, true);
    expect(s.undoLabel()).toBe("Suppress Plate");
    await s.renameParameter("h", "height");
    expect(s.undoLabel()).toBe("Rename h to height");
    await s.deleteOperation(ex.opId!);
    expect(s.undoLabel()).toBe("Delete Plate");
  });

  it("squash folds a gesture's steps into one undo step", async () => {
    const s = realSession();
    const sk = await s.dispatch("sketch.create", { plane: "XY" });
    const cp = s.checkpoint();
    const r = await s.dispatch("sketch.addRectangle", { sketch: sk.createdIds[0], corner: { x: 5, y: 5 }, opposite: { x: 20, y: 10 } });
    await s.dispatch("sketch.addConstraint", { sketch: sk.createdIds[0], type: "coincident", a: r.createdIds[0], b: s.doc.sketches[sk.createdIds[0]].originPointId });
    s.squash(cp, "Rectangle");
    expect(s.undoLabel()).toBe("Rectangle");
    s.undo();
    expect(Object.keys(s.doc.sketches[sk.createdIds[0]].entities).length).toBe(1); // just the origin
    expect(s.undoLabel()).toBe("Create sketch");
  });
});

describe("over-constraint message (M12)", () => {
  it("names the sketch and the constraints it clashes with, not their ids", async () => {
    const s = realSession();
    const sk = await s.dispatch("sketch.create", { plane: "XY" });
    const sid = sk.createdIds[0];
    const r = await s.dispatch("sketch.addLine", { sketch: sid, start: { x: 0, y: 0 }, end: { x: 30, y: 0 } });
    const [line, a, b] = r.createdIds;
    await s.dispatch("sketch.addConstraint", { sketch: sid, type: "horizontal", a, b });
    await s.dispatch("sketch.addDimension", { sketch: sid, type: "distance", a, b, expression: "30" });
    const bad = await s.dispatch("sketch.addDimension", { sketch: sid, type: "distanceX", a, b, expression: "40" });
    void line;
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/^That would over-constrain Sketch 1: it conflicts with /);
    expect(bad.error).toMatch(/Length 30 mm/);
    expect(bad.error).not.toMatch(/\bc\d+\b|\bd\d+\b/);
    expect(bad.conflicting?.length).toBeGreaterThan(0); // ids stay for agents
  });

  it("describes constraints in words", () => {
    expect(describeConstraint({ id: "d1", type: "radius", expr: "5", value: 5 })).toBe("Radius 5 mm");
    expect(describeConstraint({ id: "d1", type: "distance", expr: "w*2", value: 80 })).toBe("Length w*2 (80 mm)");
    expect(describeConstraint({ id: "d1", type: "angle", expr: "30", value: Math.PI / 6 })).toBe("Angle 30°");
    expect(describeConstraint({ id: "c1", type: "horizontal", a: "p", b: "q" })).toBe("Horizontal");
    expect(listWords(["A", "B", "C"])).toBe("A, B and C");
  });
});

describe("the strip while a rebuild runs (V19)", () => {
  const rows = [1, 2, 3, 4].map((n) => ({ num: n, name: `F${n}`, index: n - 1, opId: `op${n}`, suppressed: false, rolledBack: false }));
  it("says Building… n/N, then All N built", () => {
    expect(stripState(rows, 4, 4, 0.5).text).toBe("Building… 2/4");
    expect(stripState(rows, 4, 4, 0).text).toBe("Building… 0/4");
    expect(stripState(rows, 4, 4, null).text).toBe("All 4 features built");
  });
});

describe("an empty sketch (M24, V18)", () => {
  it("is not 'Fully constrained'", () => {
    const empty = { originPointId: "p0", entities: { p0: { id: "p0", kind: "point", x: 0, y: 0 } }, status: { fullyConstrained: true, conflicting: false, dof: 0 } } as never;
    expect(sketchStatus(empty).text).toBe("Nothing to constrain yet");
    expect(sketchStatus(empty).cls).toBe("empty");
    const drawn = { originPointId: "p0", entities: { p0: { id: "p0" }, p1: { id: "p1" } }, status: { fullyConstrained: false, conflicting: false, dof: 2 } } as never;
    expect(sketchStatus(drawn).text).toBe("2 DOF");
  });
});
