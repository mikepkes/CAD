import { describe, it, expect } from "vitest";
import { realSession } from "./helpers";

// Replay invariants: ids are stable across edits (so downstream references hold),
// suppression skips an op, and deleting an op that others depend on surfaces an
// error on the dependents rather than corrupting the model.
describe("rebuild / replay invariants", () => {
  it("keeps created ids stable when an upstream op is edited", async () => {
    const s = realSession();
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("parameter.add", { name: "w", expression: "40" });
    const ln = await s.dispatch("sketch.addLine", { sketch: sid, start: { x: 0, y: 0 }, end: { x: 30, y: 0 } });
    const lineId = ln.createdIds[0];

    const paramOp = s.timeline.find((o) => o.type === "parameter.add")!;
    await s.editOperation(paramOp.opId, { name: "w", expression: "99" });

    // the line entity still exists under the same id after the upstream edit
    expect(s.doc.sketches[sid].entities[lineId]).toBeTruthy();
    expect(s.doc.sketches[sid].entities[lineId].kind).toBe("line");
  });

  it("suppressing a dimension removes its effect; unsuppressing restores it", async () => {
    const s = realSession();
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    const ln = await s.dispatch("sketch.addLine", { sketch: sid, start: { x: 0, y: 0 }, end: { x: 30, y: 0 } });
    const [, a, b] = ln.createdIds;
    const dim = await s.dispatch("sketch.addDimension", { sketch: sid, type: "distanceX", a, b, expression: "40" });
    const span = () => { const sk = s.doc.sketches[sid]; return Math.abs((sk.entities[b] as any).x - (sk.entities[a] as any).x); };
    expect(span()).toBeCloseTo(40, 3);

    const dimOp = s.timeline.find((o) => o.createdIds.includes(dim.createdIds[0]))!;
    await s.setSuppressed(dimOp.opId, true);
    expect(span()).toBeCloseTo(30, 3); // dimension inactive → seed geometry
    await s.setSuppressed(dimOp.opId, false);
    expect(span()).toBeCloseTo(40, 3);
  });

  it("deleting an upstream op flags dependents with an error instead of throwing", async () => {
    const s = realSession();
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 0, y: 0 }, opposite: { x: 20, y: 20 } });
    const sketchOp = s.timeline.find((o) => o.type === "sketch.create")!;

    await s.deleteOperation(sketchOp.opId);
    const rectOp = s.timeline.find((o) => o.type === "sketch.addRectangle")!;
    expect(rectOp.error).toBeTruthy(); // dangling sketch reference → recorded error
    expect(s.doc.sketches[sid]).toBeUndefined();
  });
});
