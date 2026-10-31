// Design intents are part of the document: intent.add / intent.update /
// intent.delete are timeline operations, so they rebuild, undo and roll back
// like parameter.add, travel with the file, and the agent's summary reports
// each one pass/fail.
import { describe, it, expect } from "vitest";
import { realSession, sessionFromDoc } from "./helpers";
import { createDocument } from "../src/core/document";
import { serializeDocument, deserializeDocument } from "../src/core/persistence";
import { describeDocument } from "../src/model/agent";
import { evaluateIntents, intentsUseMetrics } from "../src/model/concepts/intents";

const solid = (id: string, volume: number) =>
  ({ featureId: id, name: id, mesh: {} as never, volume, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 20, z: 5 } } }) as never;

describe("intent commands", () => {
  it("a new document has no intents", () => {
    expect(createDocument().intents).toEqual([]);
  });

  it("add, update and delete apply to the document and report ids and messages", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "wall", expression: "3" });
    const a = await s.dispatch("intent.add", { label: "Light", lhs: "mass", op: "<=", rhs: "120", unit: "g" });
    expect(a.ok).toBe(true);
    expect(a.createdIds).toHaveLength(1);
    expect(a.message).toBe("Added intent: mass <= 120");
    const id = a.createdIds[0];
    expect(s.doc.intents).toEqual([{ id, label: "Light", lhs: "mass", op: "<=", rhs: "120", unit: "g" }]);

    // The label defaults to the left side; sides are trimmed; no unit key when none is given.
    const b = await s.dispatch("intent.add", { lhs: " wall ", op: ">=", rhs: "2 " });
    expect(s.doc.intents[1]).toEqual({ id: b.createdIds[0], label: "wall", lhs: "wall", op: ">=", rhs: "2" });

    const u = await s.dispatch("intent.update", { id, rhs: "150", label: "", unit: "" });
    expect(u.ok).toBe(true);
    expect(u.message).toBe("Intent mass: mass <= 150");
    expect(s.doc.intents[0]).toEqual({ id, label: "mass", lhs: "mass", op: "<=", rhs: "150" }); // empty label → lhs, empty unit → cleared

    const d = await s.dispatch("intent.delete", { id });
    expect(d.ok).toBe(true);
    expect(s.doc.intents.map((i) => i.lhs)).toEqual(["wall"]);
    expect(s.doc.operations.filter((o) => o.type.startsWith("intent.")).length).toBe(4);
  });

  it("rejects an empty or unparseable side, a bad comparator and an unknown id", async () => {
    const s = realSession();
    expect((await s.dispatch("intent.add", { lhs: "", op: "<=", rhs: "1" })).error).toMatch(/lhs is empty/);
    expect((await s.dispatch("intent.add", { lhs: "mass", op: "<=", rhs: "1 +" })).error).toMatch(/rhs "1 \+"/);
    expect((await s.dispatch("intent.add", { lhs: "mass", op: "=", rhs: "1" })).ok).toBe(false);
    expect((await s.dispatch("intent.update", { id: "nope", rhs: "1" })).error).toBe('No intent "nope"');
    expect((await s.dispatch("intent.delete", { id: "nope" })).error).toBe('No intent "nope"');
    expect(s.doc.intents).toEqual([]);
    expect(s.doc.operations).toEqual([]); // a failing first run is not committed
  });

  it("undo, redo and the rollback bar treat them like any timeline step; a rebuild keeps them", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "h", expression: "12" });
    const id = (await s.dispatch("intent.add", { lhs: "h", op: ">=", rhs: "10" })).createdIds[0];
    await s.dispatch("intent.update", { id, rhs: "20" });
    expect(s.doc.intents[0].rhs).toBe("20");

    expect(s.undo()).toBe(true);
    expect(s.doc.intents[0].rhs).toBe("10");
    expect(s.undo()).toBe(true);
    expect(s.doc.intents).toEqual([]);
    expect(s.redo()).toBe(true);
    expect(s.redo()).toBe(true);
    expect(s.doc.intents[0].rhs).toBe("20");

    // Rolling back before the intent.add leaves no intents; moving the bar forward replays them, with the same id.
    await s.moveRollback(1);
    expect(s.doc.intents).toEqual([]);
    await s.moveRollback(3);
    expect(s.doc.intents).toEqual([{ id, label: "h", lhs: "h", op: ">=", rhs: "20" }]);

    // Any later edit replays the whole recipe: the intents come back from their operations.
    await s.dispatch("parameter.add", { name: "w", expression: "5" });
    expect(s.doc.intents).toEqual([{ id, label: "h", lhs: "h", op: ">=", rhs: "20" }]);
    expect(evaluateIntents(s.doc).results[0]).toMatchObject({ ok: false, lhs: 12, rhs: 20 });
  });

  it("survives serialize → deserialize → recompute, and old files without intents load with none", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "wall", expression: "3" });
    const id = (await s.dispatch("intent.add", { label: "Wall", lhs: "wall", op: ">=", rhs: "2", unit: "mm" })).createdIds[0];
    const json = serializeDocument(s.doc);
    expect(JSON.parse(json).intents).toEqual([{ id, label: "Wall", lhs: "wall", op: ">=", rhs: "2", unit: "mm" }]);

    const loaded = sessionFromDoc(deserializeDocument(json));
    expect(loaded.doc.intents).toEqual(s.doc.intents); // readable before replay
    await loaded.recompute();
    expect(loaded.doc.intents).toEqual(s.doc.intents); // and rebuilt from the recipe

    const old = deserializeDocument(JSON.stringify({ format: "chisel-cad", version: 1, operations: [], nextId: 1 }));
    expect(old.intents).toEqual([]);
    expect(JSON.parse(serializeDocument(old))).not.toHaveProperty("intents"); // none → no key
    const junk = deserializeDocument(JSON.stringify({ format: "chisel-cad", version: 1, operations: [], nextId: 1, intents: [null, 3, { id: "i1", label: "a", lhs: "a", op: "<", rhs: "1" }] }));
    expect(junk.intents.map((i) => i.id)).toEqual(["i1"]);
  });

  it("the agent's document summary lists each intent pass/fail against the parameters and bodies", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "wall", expression: "3" });
    await s.dispatch("intent.add", { label: "Wall", lhs: "wall", op: ">=", rhs: "2" });
    await s.dispatch("intent.add", { label: "Light", lhs: "mass", op: "<=", rhs: "100", unit: "g" });
    await s.dispatch("intent.add", { lhs: "nope", op: "<", rhs: "1" });
    expect(intentsUseMetrics(s.doc.intents)).toBe(true);

    const d = describeDocument(s.doc, "model", null, { a: solid("a", 40000) }) as { intents: Record<string, unknown>[] };
    expect(d.intents.map((i) => i.status)).toEqual(["pass", "fail", "unchecked"]);
    expect(d.intents[0]).toMatchObject({ label: "Wall", check: "wall >= 2", lhs: 3, rhs: 2 });
    expect(d.intents[1]).toMatchObject({ label: "Light", check: "mass <= 100", unit: "g", lhs: 108, rhs: 100 }); // 40 cm³ × 2.7 g/cm³
    expect(d.intents[2]).toMatchObject({ lhs: null, rhs: null, error: expect.stringMatching(/nope/) });

    // Without built solids a metric intent is unchecked, not failed; a document without intents has no section.
    const bare = describeDocument(s.doc, "model", null) as { intents: Record<string, unknown>[] };
    expect(bare.intents[1]).toMatchObject({ status: "unchecked" });
    expect(describeDocument(realSession().doc, "model", null)).not.toHaveProperty("intents");
  });
});
