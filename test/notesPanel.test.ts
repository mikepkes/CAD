// The Notes concept's pure decisions: markdown blocks, times and badges, pin
// placement, what "pin to selection" pins, and which commands a save sends.
import { describe, it, expect } from "vitest";
import { realSession } from "./helpers";
import type { Note } from "../src/core/document";
import { strokesFromInput } from "../src/core/notes";
import { anchorText, anchorWorld, authorBadge, draftOf, finishStroke, inlineSpans, markdownBlocks, newestFirst, noteNumbers, padPoint, pinFromSelection, saveCommands, timeAgo } from "../src/ui/concepts/notes/notes";

const note = (over: Partial<Note> = {}): Note => ({ id: "note1", title: "T", body: "", author: "human", createdAt: 1, updatedAt: 1, ...over });

describe("markdown", () => {
  it("reads paragraphs with their line breaks, lists and headings", () => {
    expect(markdownBlocks("# Head\nfirst\nsecond\n\n- a\n- **b**\n1. one")).toEqual([
      { kind: "h", spans: [{ text: "Head" }] },
      { kind: "p", lines: [[{ text: "first" }], [{ text: "second" }]] },
      { kind: "ul", items: [[{ text: "a" }], [{ text: "b", bold: true }]] },
      { kind: "ol", items: [[{ text: "one" }]] },
    ]);
  });
  it("marks bold, italic and code inside a line", () => {
    expect(inlineSpans("a **b** *c* `d` e")).toEqual([{ text: "a " }, { text: "b", bold: true }, { text: " " }, { text: "c", italic: true }, { text: " " }, { text: "d", code: true }, { text: " e" }]);
    expect(inlineSpans("2 * 3 * 4")).toEqual([{ text: "2 * 3 * 4" }]); // a lone star is arithmetic, not emphasis
  });
});

describe("who and when", () => {
  it("says how long ago, in words", () => {
    const now = Date.UTC(2026, 10, 5, 12);
    expect(timeAgo(now - 10_000, now)).toBe("just now");
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(timeAgo(now - 3 * 3600_000, now)).toBe("3 h ago");
    expect(timeAgo(now - 30 * 3600_000, now)).toBe("yesterday");
  });
  it("badges you, the agent, and a named author", () => {
    expect(authorBadge("human")).toEqual({ label: "You", kind: "human" });
    expect(authorBadge("agent")).toEqual({ label: "Agent", kind: "agent" });
    expect(authorBadge("Claude")).toEqual({ label: "Claude", kind: "agent" });
    expect(authorBadge("Mike")).toEqual({ label: "Mike", kind: "named" });
  });
  it("numbers notes in the order they were written; lists the newest change first", () => {
    const a = note({ id: "a", createdAt: 1, updatedAt: 9 }), b = note({ id: "b", createdAt: 2, updatedAt: 3 });
    expect([...noteNumbers([b, a])]).toEqual([["a", 1], ["b", 2]]);
    expect(newestFirst([b, a]).map((n) => n.id)).toEqual(["a", "b"]);
  });
});

describe("pins", () => {
  it("place at the point, else the sketch's middle; say what they're on", async () => {
    const s = realSession();
    const sk = (await s.dispatch("sketch.create", { plane: "XZ" })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sk, corner: { x: 0, y: 0 }, opposite: { x: 20, y: 10 } });
    const at = anchorWorld({ sketch: sk }, s.doc, [])!;
    // the middle of the rectangle's corners and the origin point, on the XZ plane
    expect(at.y).toBeCloseTo(0, 6);
    expect(at.x).toBeGreaterThan(0);
    expect(anchorWorld({ feature: "x", point: { x: 1, y: 2, z: 3 } }, s.doc, [])).toEqual({ x: 1, y: 2, z: 3 });
    expect(anchorWorld({ feature: "nothing" }, s.doc, [])).toBeNull();
    expect(anchorText({ sketch: sk }, s.doc, [])).toEqual({ text: s.doc.sketches[sk].name, missing: false });
    expect(anchorText({ feature: "gone" }, s.doc, [])).toEqual({ text: "gone", missing: true });
    expect(anchorText({ view: { position: { x: 0, y: 0, z: 1 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } } }, s.doc, [])).toBeNull();
  });
  it("pin to selection takes the face, else the sketch being edited, else the open feature card", () => {
    const face = { bodyId: "box1", point: { x: 1, y: 2, z: 3 } };
    expect(pinFromSelection({ faceSelection: face, mode: "model", activeSketchId: null, openFeature: "f" })).toEqual({ feature: "box1", point: { x: 1, y: 2, z: 3 } });
    expect(pinFromSelection({ faceSelection: null, mode: "sketch", activeSketchId: "sk1", openFeature: "f" })).toEqual({ sketch: "sk1" });
    expect(pinFromSelection({ faceSelection: null, mode: "model", activeSketchId: "sk1", openFeature: "f" })).toEqual({ feature: "f" });
    expect(pinFromSelection({ faceSelection: null, mode: "model", activeSketchId: null, openFeature: null })).toBeNull();
  });
});

describe("saving", () => {
  const line = strokesFromInput({ points: [[0.1, 0.1], [0.9, 0.9]] })[0];
  const dot = strokesFromInput({ points: [[0.5, 0.5]], color: "#e5484d" })[0];

  it("a new note is one note.add carrying its drawing as path data", () => {
    expect(saveCommands(null, { title: " ", body: "hi", strokes: [line] })).toEqual([
      { type: "note.add", params: { body: "hi", author: "human", drawing: { strokes: [{ color: "#1f2328", width: 4, path: "M100 100L900 900" }] } } },
    ]);
  });
  it("an edit sends only what changed; strokes drawn on top go as note.stroke.add", () => {
    const n = note({ drawing: { strokes: [line] } });
    expect(saveCommands(n, draftOf(n))).toEqual([]);
    expect(saveCommands(n, { ...draftOf(n), strokes: [line, dot] })).toEqual([
      { type: "note.stroke.add", params: { id: "note1", author: "human", strokes: [{ color: "#e5484d", width: 4, path: "M500 500L500 500" }] } },
    ]);
    const erased = saveCommands(n, { ...draftOf(n), strokes: [dot], title: "New" });
    expect(erased).toHaveLength(1);
    expect(erased[0]).toMatchObject({ type: "note.update", params: { id: "note1", title: "New", strokes: [{ color: "#e5484d" }] } });
  });
  it("unpinning and removing the image send nulls", () => {
    const n = note({ anchor: { feature: "f" }, drawing: { strokes: [], background: "data:image/png;base64,AAAA" } });
    expect(saveCommands(n, { ...draftOf(n), anchor: undefined, background: undefined })).toEqual([
      { type: "note.update", params: { id: "note1", anchor: null, background: null, author: "human" } },
    ]);
  });
});

describe("the pad", () => {
  it("maps the pointer into 0..1 and keeps a stroke's shape with few points", () => {
    expect(padPoint(50, 150, { left: 0, top: 100, width: 100, height: 100 })).toEqual({ x: 0.5, y: 0.5 });
    expect(padPoint(500, -5, { left: 0, top: 0, width: 100, height: 100 })).toEqual({ x: 1, y: 0 });
    expect(padPoint(0, 0, { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: i / 49, y: 0.5 + 1e-5 * Math.sin(i) }));
    expect(finishStroke(pts, "#000", 4)!.points).toEqual([{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }]);
  });
});
