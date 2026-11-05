import { describe, it, expect } from "vitest";
import { realSession, sessionFromDoc } from "./helpers";
import { serializeDocument, deserializeDocument } from "../src/core/persistence";
import type { CadSession } from "../src/core/command/session";
import type { SketchPoint } from "../src/sketch/types";

// A saved document is only the recipe (operations). Loading it must reproduce
// identical geometry — the core invariant that makes the timeline the source of
// truth. This round-trips through serialize → deserialize → recompute.
function pointMap(s: CadSession): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  for (const sk of Object.values(s.doc.sketches)) {
    for (const e of Object.values(sk.entities)) {
      if (e.kind === "point") { const p = e as SketchPoint; out[e.id] = { x: p.x, y: p.y }; }
    }
  }
  return out;
}

describe("persistence round-trip", () => {
  it("serialize → deserialize → recompute reproduces the same geometry", async () => {
    const s = realSession();
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("parameter.add", { name: "w", expression: "50" });
    await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 0, y: 0 }, opposite: { x: 30, y: 20 } });
    const ln = s.doc.sketches[sid];
    const firstLine = Object.values(ln.entities).find((e) => e.kind === "line")!;
    await s.dispatch("sketch.addDimension", { sketch: sid, type: "distanceX", a: (firstLine as { p1: string }).p1, b: (firstLine as { p2: string }).p2, expression: "w" });
    await s.dispatch("feature.extrude", { sketch: sid, distance: "15" });

    const before = pointMap(s);

    const json = serializeDocument(s.doc);
    const loaded = sessionFromDoc(deserializeDocument(json));
    await loaded.recompute();
    const after = pointMap(loaded);

    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const id of Object.keys(before)) {
      expect(after[id].x).toBeCloseTo(before[id].x, 4);
      expect(after[id].y).toBeCloseTo(before[id].y, 4);
    }
    // the feature survives the round-trip
    expect(Object.keys(loaded.doc.features).length).toBe(Object.keys(s.doc.features).length);
  });

  it("only operations are serialized; derived state is omitted", () => {
    const json = JSON.parse(
      serializeDocument(deserializeDocument(JSON.stringify({ format: "vibecad", version: 1, operations: [], nextId: 1 })))
    );
    expect(json).not.toHaveProperty("sketches");
    expect(json).not.toHaveProperty("features");
    expect(json).toHaveProperty("operations");
  });
});

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("notes in a saved file", () => {
  it("round-trip through save and load (the background comes back from the operations)", async () => {
    const s = realSession();
    await s.dispatch("note.add", { title: "Sketch", strokes: [{ path: "M10 10 L990 990" }], drawing: { background: PNG } });
    const json = serializeDocument(s.doc);
    const saved = JSON.parse(json);
    expect(saved.notes[0].title).toBe("Sketch");
    expect(saved.notes[0].drawing.background).toBeUndefined(); // not stored twice
    const loaded = deserializeDocument(json);
    expect(loaded.notes![0].title).toBe("Sketch");
    const session = sessionFromDoc(loaded);
    await session.recompute();
    expect(session.doc.notes).toEqual(s.doc.notes);
  });

  it("a file from before notes loads with none", async () => {
    const old = JSON.stringify({ format: "vibecad", version: 1, id: "d", units: "mm", nextId: 1, rollbackIndex: 0, operations: [] });
    const doc = deserializeDocument(old);
    expect(doc.notes).toEqual([]);
  });
});
