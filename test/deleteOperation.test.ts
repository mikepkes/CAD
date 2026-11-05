// Deleting a timeline operation by its own id, or by the id of what it created (a feature, a joint).
import { describe, it, expect } from "vitest";
import { realSession } from "./helpers";

describe("deleteOperation", () => {
  it("takes the created feature's id as well as the operation's", async () => {
    const s = realSession();
    const sk = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sk, corner: { x: 0, y: 0 }, opposite: { x: 10, y: 10 } });
    const ext = (await s.dispatch("feature.extrude", { sketch: sk, distance: "5" })).createdIds[0];
    expect(Object.keys(s.doc.features)).toEqual([ext]);
    const r = await s.deleteOperation(ext);
    expect(r.ok).toBe(true);
    expect(Object.keys(s.doc.features)).toEqual([]);
  });

  it("removes a joint named by its id", async () => {
    const s = realSession();
    const cmp = (await s.dispatch("component.create", { name: "b" })).createdIds[0];
    const j = (await s.dispatch("joint.create", { kind: "revolute", moved: cmp, baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, value: "0" })).createdIds[0];
    expect(Object.keys(s.doc.joints)).toEqual([j]);
    expect((await s.deleteOperation(j)).ok).toBe(true);
    expect(Object.keys(s.doc.joints)).toEqual([]);
  });

  it("says so when nothing has that id", async () => {
    const s = realSession();
    const r = await s.deleteOperation("nope");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No operation/);
  });
});
