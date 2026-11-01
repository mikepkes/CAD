// Destructive actions are guarded (M5) and a document has a name and a file
// name (M21): what uses a parameter, deleting one while keeping its value in its
// users (one undo step), and the document's name surviving save and open.

import { describe, it, expect } from "vitest";
import { realSession } from "./helpers";
import { parameterUses, inlineInOperation } from "../src/core/parameterRename";
import { serializeDocument, deserializeDocument } from "../src/core/persistence";

async function plate() {
  const s = realSession();
  await s.dispatch("parameter.add", { name: "w", expression: "40" });
  await s.dispatch("parameter.add", { name: "depth", expression: "w/4" });
  const sk = await s.dispatch("sketch.create", { plane: "XY" });
  const sid = sk.createdIds[0];
  const r = await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 0, y: 0 }, opposite: { x: 40, y: 20 } });
  await s.dispatch("sketch.addDimension", { sketch: sid, type: "distance", a: r.createdIds[0], b: r.createdIds[1], expression: "w" });
  await s.dispatch("feature.extrude", { sketch: sid, distance: "-w/8", name: "Plate" });
  return { s, sid };
}

describe("what uses a parameter", () => {
  it("lists every user in words, not the ops that define it", async () => {
    const { s } = await plate();
    const uses = parameterUses(s.doc, "w").map((u) => u.what);
    expect(uses).toEqual(["parameter depth", "Sketch 1: a dimension (w)", "Plate"]);
    expect(parameterUses(s.doc, "depth")).toEqual([]);
  });

  it("inlines a value as a literal, bracketing a negative one", () => {
    const op = { opId: "op1", type: "feature.extrude", params: { sketch: "s", distance: "w*2", name: "w" }, createdIds: [], label: "Extrude", at: 0 };
    expect(inlineInOperation(op, "w", 12.5)).toEqual({ sketch: "s", distance: "12.5*2", name: "w" });
    expect(inlineInOperation(op, "w", -3)).toEqual({ sketch: "s", distance: "(-3)*2", name: "w" });
    expect(inlineInOperation(op, "other", 1)).toBe(op.params);
  });
});

describe("deleting a parameter in use", () => {
  it("keeping its value: users hold the number, nothing collapses, and one undo brings it all back", async () => {
    const { s, sid } = await plate();
    await s.deleteParameter("w", { inline: true });
    expect(s.doc.parameters.map((p) => p.name)).toEqual(["depth"]);
    expect(s.doc.parameters[0].expr).toBe("40/4");
    const dim = Object.values(s.doc.sketches[sid].constraints).find((c) => "expr" in c) as { expr: string; value: number };
    expect(dim.expr).toBe("40");
    expect(dim.value).toBeCloseTo(40);
    const plateOp = s.timeline.find((o) => o.type === "feature.extrude")!;
    expect(plateOp.params.distance).toBe("-40/8");
    expect(s.undoLabel()).toBe("Delete w, keeping its value");
    s.undo();
    expect(s.doc.parameters.map((p) => p.name)).toEqual(["w", "depth"]);
    expect(s.timeline.find((o) => o.type === "feature.extrude")!.params.distance).toBe("-w/8");
  });

  it("deleting anyway removes only the parameter", async () => {
    const { s } = await plate();
    await s.deleteParameter("w");
    expect(s.doc.parameters.map((p) => p.name)).toEqual(["depth"]);
    expect(s.timeline.find((o) => o.type === "feature.extrude")!.params.distance).toBe("-w/8");
  });
});

describe("the document's name", () => {
  it("is undoable, and travels in the file", async () => {
    const s = realSession();
    expect(s.doc.name).toBeUndefined();
    await s.renameDocument("  Phone   stand ");
    expect(s.doc.name).toBe("Phone stand");
    const back = deserializeDocument(serializeDocument(s.doc));
    expect(back.name).toBe("Phone stand");
    s.undo();
    expect(s.doc.name).toBeUndefined();
    expect(JSON.parse(serializeDocument(s.doc)).name).toBeUndefined();
  });
});
