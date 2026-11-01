// Renaming a parameter renames every use of it, in one undoable step; lookalikes and prose stay.
import { describe, it, expect } from "vitest";
import { realSession } from "./helpers";
import { renameInExpression } from "../src/core/parameterRename";

describe("renameInExpression", () => {
  it("renames whole identifiers only", () => {
    expect(renameInExpression("width*2+widths", "width", "w")).toBe("w*2+widths");
    expect(renameInExpression("max(width, 3) - width/2", "width", "w")).toBe("max(w, 3) - w/2");
    expect(renameInExpression("deg(atan(1))", "deg", "x")).toBe("deg(atan(1))");   // a function, not a parameter
    expect(renameInExpression("Base", "width", "w")).toBe("Base");
    expect(renameInExpression("not an expression!", "width", "w")).toBe("not an expression!");
  });
});

describe("session.renameParameter", () => {
  it("renames the parameter and every reference to it, and undoes in one step", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "width", expression: "40", min: 10, max: 90 });
    await s.dispatch("parameter.add", { name: "widths", expression: "3" });
    await s.dispatch("parameter.add", { name: "half", expression: "width/2" });
    const sk = (await s.dispatch("sketch.create", { plane: "XY", name: "width" })).createdIds[0];   // a sketch NAMED width: prose, untouched
    const rect = (await s.dispatch("sketch.addRectangle", { sketch: sk, corner: { x: 0, y: 0 }, opposite: { x: 40, y: 20 } })).createdIds;
    await s.dispatch("sketch.addDimension", { sketch: sk, type: "distanceX", a: rect[0], b: rect[1], expression: "width" });
    await s.dispatch("feature.extrude", { sketch: sk, distance: "width*widths/10" });
    await s.dispatch("parameter.set", { name: "width", expression: "50" });
    await s.dispatch("intent.add", { lhs: "width", op: "<=", rhs: "80" });
    await s.dispatch("configuration.create", { name: "Big", values: { width: "70", widths: "4" } });

    const r = await s.renameParameter("width", "w");
    expect(r.ok, r.error).toBe(true);
    const names = s.doc.parameters.map((p) => p.name);
    expect(names).toContain("w"); expect(names).not.toContain("width"); expect(names).toContain("widths");
    expect(s.doc.parameters.find((p) => p.name === "w")!.value).toBe(50);          // the parameter.set followed it
    expect(s.doc.parameters.find((p) => p.name === "half")!.value).toBe(25);       // half = w/2 still resolves
    const ops = s.doc.operations;
    expect(ops.find((o) => o.type === "sketch.addDimension")!.params.expression).toBe("w");
    expect(ops.find((o) => o.type === "feature.extrude")!.params.distance).toBe("w*widths/10");
    expect(ops.find((o) => o.type === "intent.add")!.params.lhs).toBe("w");
    expect(ops.find((o) => o.type === "configuration.create")!.params.values).toEqual({ w: "70", widths: "4" });
    expect(s.doc.sketches[sk].name).toBe("width");
    expect(ops.every((o) => !o.error), ops.filter((o) => o.error).map((o) => `${o.type}: ${o.error}`).join("; ")).toBe(true);

    s.undo();
    expect(s.doc.parameters.map((p) => p.name)).toContain("width");
    expect(s.doc.operations.find((o) => o.type === "feature.extrude")!.params.distance).toBe("width*widths/10");
  });

  it("refuses a taken or invalid name", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "a", expression: "1" });
    await s.dispatch("parameter.add", { name: "b", expression: "2" });
    expect((await s.renameParameter("a", "b")).ok).toBe(false);
    expect((await s.renameParameter("a", "2x")).ok).toBe(false);
    expect((await s.renameParameter("zz", "c")).ok).toBe(false);
  });
});
