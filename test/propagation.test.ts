import { describe, it, expect, beforeAll } from "vitest";
import { realSession } from "./helpers";
import type { CadSession } from "../src/core/command/session";
import type { SketchPoint } from "../src/sketch/types";

// The heart of a parametric modeler: editing something upstream re-runs the
// whole active timeline so downstream geometry propagates. These tests pin that
// behaviour (and rollback / insert-at-marker) against regression.

async function lineSketch(s: CadSession) {
  const sk = await s.dispatch("sketch.create", { plane: "XY" });
  const sid = sk.createdIds[0];
  await s.dispatch("parameter.add", { name: "width", expression: "40" });
  const ln = await s.dispatch("sketch.addLine", { sketch: sid, start: { x: 0, y: 0 }, end: { x: 30, y: 0 } });
  const [, a, b] = ln.createdIds; // [lineId, startId, endId]
  const dim = await s.dispatch("sketch.addDimension", { sketch: sid, type: "distanceX", a, b, expression: "width" });
  return { sid, a, b, dimId: dim.createdIds[0] };
}

function xspan(s: CadSession, sid: string, a: string, b: string): number {
  const sk = s.doc.sketches[sid];
  const pa = sk.entities[a] as SketchPoint, pb = sk.entities[b] as SketchPoint;
  return Math.abs(pb.x - pa.x);
}

describe("timeline propagation", () => {
  let session: CadSession;
  beforeAll(async () => {
    // Warm the solver once (loads wasm) so the first test's timing is honest.
    session = realSession();
    await session.dispatch("sketch.create", { plane: "XY" });
  });

  it("solves a dimensioned sketch to the parameter's value", async () => {
    const s = realSession();
    const { sid, a, b } = await lineSketch(s);
    expect(xspan(s, sid, a, b)).toBeCloseTo(40, 3);
  });

  it("propagates an upstream parameter edit to downstream sketch geometry", async () => {
    const s = realSession();
    const { sid, a, b } = await lineSketch(s);
    const paramOp = s.timeline.find((o) => o.type === "parameter.add" && o.params.name === "width")!;
    await s.editOperation(paramOp.opId, { name: "width", expression: "80" });
    expect(xspan(s, sid, a, b)).toBeCloseTo(80, 3);
  });

  it("propagates an upstream dimension expression edit", async () => {
    const s = realSession();
    const { sid, a, b, dimId } = await lineSketch(s);
    const dimOp = s.timeline.find((o) => o.type === "sketch.addDimension" && o.createdIds.includes(dimId))!;
    await s.editOperation(dimOp.opId, { ...dimOp.params, expression: "25" });
    expect(xspan(s, sid, a, b)).toBeCloseTo(25, 3);
  });

  it("rolling the marker back deactivates downstream ops and forward reactivates", async () => {
    const s = realSession();
    const { sid, a, b } = await lineSketch(s);
    const n = s.timeline.length;
    // roll back to before the dimension (last op); the x-span is no longer forced to 40
    await s.moveRollback(n - 1);
    expect(s.rollbackIndex).toBe(n - 1);
    expect(xspan(s, sid, a, b)).toBeCloseTo(30, 3); // seed geometry, unconstrained
    // roll forward: dimension re-applies
    await s.moveRollback(n);
    expect(xspan(s, sid, a, b)).toBeCloseTo(40, 3);
  });

  it("inserts a new op at the rollback marker, not at the end", async () => {
    const s = realSession();
    const { sid } = await lineSketch(s);
    const n = s.timeline.length;
    await s.moveRollback(1); // just after sketch.create
    const before = s.timeline.map((o) => o.type);
    await s.dispatch("sketch.addCircle", { sketch: sid, center: { x: 0, y: 0 }, radius: 5 });
    const after = s.timeline.map((o) => o.type);
    expect(after.length).toBe(n + 1);
    expect(after[1]).toBe("sketch.addCircle"); // spliced at index 1, not appended
    expect(after.slice(2)).toEqual(before.slice(1)); // the rest shifted down intact
  });
});
