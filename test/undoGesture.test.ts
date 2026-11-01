// A drag or a preview writes a value on every move; the session folds those
// steps into one (squashSince) or forgets them (dropSince).
import { describe, it, expect } from "vitest";
import { realSession } from "./helpers";

describe("undo gestures", () => {
  it("squashSince folds the steps since a mark into one undoable step", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "w", expression: "10" });
    const op = s.timeline[0];
    const mark = s.undoDepth;
    for (const v of ["11", "12", "13"]) await s.editOperation(op.opId, { ...op.params, expression: v });
    expect(s.undoDepth).toBe(mark + 3);
    s.squashSince(mark, "Move w");
    expect(s.undoDepth).toBe(mark + 1);
    expect(s.doc.parameters[0].value).toBe(13);
    s.undo();
    expect(s.doc.parameters[0].value).toBe(10);
    s.redo();
    expect(s.doc.parameters[0].value).toBe(13);
  });

  it("dropSince forgets them and keeps the document; nothing since the mark is a no-op", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "w", expression: "10" });
    const op = s.timeline[0];
    const mark = s.undoDepth;
    s.squashSince(mark);
    expect(s.undoDepth).toBe(mark);
    await s.editOperation(op.opId, { ...op.params, expression: "12" });
    await s.editOperation(op.opId, { ...op.params, expression: "10" });
    s.dropSince(mark);
    expect(s.undoDepth).toBe(mark);
    expect(s.doc.parameters[0].value).toBe(10);
  });
});
