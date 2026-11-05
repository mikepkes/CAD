// Notes are document state built by note.* timeline operations: they undo,
// replay, save and load like intents; strokes come in as points or SVG path
// data and go back out as path data in the 1000×1000 space.
import { describe, it, expect } from "vitest";
import { realSession } from "./helpers";
import { eraseStrokes, noteDetail, noteSummary, noteSvg, parseSvgPath, simplifyPoints, strokePath, strokesFromInput, withAgentAuthor } from "../src/core/notes";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("SVG path data", () => {
  it("reads lines, relative moves and closes, one point list per subpath", () => {
    const subs = parseSvgPath("M10 10 L20 10 l0 10 Z m100 0 h5 v5");
    expect(subs).toHaveLength(2);
    expect(subs[0]).toEqual([{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 10 }]);
    expect(subs[1]).toEqual([{ x: 110, y: 10 }, { x: 115, y: 10 }, { x: 115, y: 15 }]);
  });

  it("flattens curves and arcs, ending exactly on their end points", () => {
    const [c] = parseSvgPath("M0 0 C 0 100 100 100 100 0");
    expect(c.length).toBeGreaterThan(8);
    expect(c[c.length - 1]).toEqual({ x: 100, y: 0 });
    const [a] = parseSvgPath("M0 50 A 50 50 0 0 1 100 50");
    expect(a[a.length - 1]).toEqual({ x: 100, y: 50 });
    // the half circle passes over the top (y = 0 at the middle)
    expect(Math.min(...a.map((p) => p.y))).toBeCloseTo(0, 1);
  });

  it("names what it can't read", () => {
    expect(() => parseSvgPath("M 1 2 X 3")).toThrow(/unknown command "X"/);
    expect(() => parseSvgPath("10 10")).toThrow(/start with M/);
    expect(() => parseSvgPath("M0 0 Z 4 4")).toThrow(/after Z/);
  });
});

describe("strokes", () => {
  it("store points in 0..1, simplified, and write back as 1000-space path data", () => {
    const [s] = strokesFromInput({ path: "M100 100 L200 100 L300 100 L300 400", color: "#d33", width: 6 });
    expect(s.points).toEqual([{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.3, y: 0.4 }]); // the collinear middle point goes
    expect(strokePath(s)).toBe("M100 100L300 100 300 400");
    expect(strokesFromInput({ points: [[0.5, 0.5]] })[0]).toMatchObject({ color: "#1f2328", width: 4, points: [{ x: 0.5, y: 0.5 }] });
  });

  it("tells an agent which space points are in", () => {
    expect(() => strokesFromInput({ points: [{ x: 100, y: 200 }] })).toThrow(/0\.\.1.*give `path`/);
    expect(() => strokesFromInput({})).toThrow(/give `points`/);
    expect(() => strokesFromInput({ path: "M0 0 L1 1", color: "url(x)" })).toThrow(/hex colour/);
  });

  it("the eraser takes whole strokes it touches", () => {
    const a = strokesFromInput({ points: [[0.1, 0.1], [0.9, 0.1]] })[0];
    const b = strokesFromInput({ points: [[0.1, 0.9], [0.9, 0.9]] })[0];
    expect(eraseStrokes([a, b], { x: 0.5, y: 0.11 }, 0.02)).toEqual([b]);
  });

  it("simplify keeps the end points of a straight run", () => {
    expect(simplifyPoints([{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 0 }], 0.001)).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  });

  it("an SVG of the drawing has the background under the strokes", () => {
    const svg = noteSvg({ strokes: strokesFromInput({ path: "M0 0 L1000 1000" }), background: PNG }, 500);
    expect(svg).toMatch(/^<svg[^>]*width="500"[^>]*viewBox="0 0 1000 1000"/);
    expect(svg.indexOf("<image")).toBeLessThan(svg.indexOf("<path"));
  });
});

describe("note commands", () => {
  it("add, update, draw, clear and delete — each one undoable step", async () => {
    const s = realSession();
    const r = await s.dispatch("note.add", { body: "Check the **wall**\n- 2 mm min", anchor: { point: { x: 1, y: 2, z: 3 } } });
    expect(r.ok).toBe(true);
    const id = r.createdIds[0];
    const n = s.doc.notes![0];
    expect(n).toMatchObject({ id, title: "Check the wall", author: "human", anchor: { point: { x: 1, y: 2, z: 3 } } });
    expect(n.createdAt).toBeGreaterThan(0);
    expect(n.drawing).toBeUndefined();

    await s.dispatch("note.stroke.add", { id, strokes: [{ path: "M100 100 L900 900" }, { points: [[0.5, 0.1], [0.5, 0.9]], color: "#2563eb" }], author: "agent" });
    expect(s.doc.notes![0].drawing!.strokes).toHaveLength(2);
    expect(s.doc.notes![0].updatedBy).toBe("agent");

    await s.dispatch("note.update", { id, title: "Wall", background: PNG, anchor: null });
    expect(s.doc.notes![0]).toMatchObject({ title: "Wall", drawing: { background: PNG } });
    expect(s.doc.notes![0].anchor).toBeUndefined();
    expect(s.doc.notes![0].drawing!.strokes).toHaveLength(2);

    await s.dispatch("note.stroke.clear", { id });
    expect(s.doc.notes![0].drawing).toEqual({ strokes: [], background: PNG });
    s.undo();
    expect(s.doc.notes![0].drawing!.strokes).toHaveLength(2);

    await s.dispatch("note.delete", { id });
    expect(s.doc.notes).toEqual([]);
    s.undo();
    expect(s.doc.notes![0].id).toBe(id);
  });

  it("keeps a note pinned to something that isn't there, and says so", async () => {
    const s = realSession();
    const r = await s.dispatch("note.add", { title: "Later", anchor: { feature: "extrude99" } });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/feature "extrude99".*doesn't have/);
    expect(s.doc.notes![0].anchor).toEqual({ feature: "extrude99" });
  });

  it("refuses a bad background or stroke without adding a note", async () => {
    const s = realSession();
    expect((await s.dispatch("note.add", { title: "x", drawing: { background: "http://example.com/a.png" } })).ok).toBe(false);
    expect((await s.dispatch("note.add", { title: "x", strokes: [{ points: [[400, 400]] }] })).ok).toBe(false);
    expect(s.doc.notes).toEqual([]);
  });

  it("replays to the same notes (timestamps stamped on the op) and rolls back with the timeline", async () => {
    const s = realSession();
    await s.dispatch("note.add", { title: "A" });
    await s.dispatch("parameter.add", { name: "width", expression: "40" });
    await s.dispatch("note.add", { title: "B", body: "width is fine" });
    const before = structuredClone(s.doc.notes);
    await s.recompute();
    expect(s.doc.notes).toEqual(before);
    await s.moveRollback(1);
    expect(s.doc.notes!.map((n) => n.title)).toEqual(["A"]);
  });

  it("renaming a parameter leaves a note's words alone", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "width", expression: "40" });
    await s.dispatch("note.add", { title: "width", body: "width" });
    const r = await s.renameParameter("width", "w");
    expect(r.ok).toBe(true);
    expect(s.doc.notes![0]).toMatchObject({ title: "width", body: "width" });
  });

  it("agent surfaces sign their notes unless the agent gives a name", () => {
    expect(withAgentAuthor("note.add", { title: "x" })).toEqual({ title: "x", author: "agent" });
    expect(withAgentAuthor("note.add", { author: "Claude" }).author).toBe("Claude");
    expect(withAgentAuthor("note.delete", { id: "n" })).toEqual({ id: "n" });
    expect(withAgentAuthor("feature.extrude", { sketch: "s" })).toEqual({ sketch: "s" });
  });

  it("summaries and details are what the tools return", async () => {
    const s = realSession();
    await s.dispatch("note.add", { title: "T", body: "first line\nsecond", strokes: [{ path: "M0 0 L500 500" }], drawing: { background: PNG }, anchor: { sketch: "sk1", view: { position: { x: 1, y: 1, z: 1 }, target: { x: 0, y: 0, z: 0 } } } });
    const n = s.doc.notes![0];
    expect(noteSummary(n)).toMatchObject({ title: "T", excerpt: "first line", strokes: 1, hasBackground: true, anchor: { sketch: "sk1", view: true } });
    const d = noteDetail(n) as { drawing: { strokes: { path: string }[]; background: string } };
    expect(d.drawing.strokes[0].path).toBe("M0 0L500 500");
    expect(d.drawing.background).toMatch(/image/);
    expect(n.anchor!.view!.up).toEqual({ x: 0, y: 0, z: 1 });
  });
});
