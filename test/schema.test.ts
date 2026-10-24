import { describe, it, expect } from "vitest";
import { echoSession } from "./helpers";
import {
  serializeDocument, deserializeDocument, runMigrations, CURRENT_VERSION, RawDocument,
} from "../src/core/persistence";

// Schema versioning + migration: files migrate up to the current version on load,
// legacy (unversioned) files normalize, and a file from a newer app is refused.

describe("schema migration", () => {
  it("round-trips a current-version document", async () => {
    const s = echoSession();
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 0, y: 0 }, opposite: { x: 10, y: 10 } });

    const json = serializeDocument(s.doc);
    expect(JSON.parse(json).version).toBe(CURRENT_VERSION);
    const doc = deserializeDocument(json);
    expect(doc.operations.length).toBe(s.doc.operations.length);
    expect(doc.rollbackIndex).toBe(s.doc.rollbackIndex);
  });

  it("normalizes a legacy (unversioned) file via the 0→1 migration", () => {
    // An old file: no version, no rollbackIndex, no timelineGroups.
    const legacy = JSON.stringify({
      format: "chisel-cad",
      id: "old",
      units: "mm",
      nextId: 5,
      operations: [
        { opId: "op1", type: "parameter.add", params: { name: "w", expression: "10" }, createdIds: [] },
      ],
    });
    const doc = deserializeDocument(legacy);
    expect(doc.operations.length).toBe(1);
    expect(doc.rollbackIndex).toBe(1); // defaulted to operations.length
    expect(doc.timelineGroups).toEqual([]);
  });

  it("refuses a file newer than this app supports", () => {
    const future = JSON.stringify({ format: "chisel-cad", version: CURRENT_VERSION + 5, operations: [] });
    expect(() => deserializeDocument(future)).toThrow(/newer than this app supports/i);
  });

  it("rejects a non-Chisel document", () => {
    expect(() => deserializeDocument(JSON.stringify({ format: "something-else", operations: [] }))).toThrow(/Not a Chisel CAD/i);
    expect(() => deserializeDocument(JSON.stringify({ format: "chisel-cad" }))).toThrow(/no operations/i);
  });

  it("runs the migration chain in order (composition)", () => {
    // Synthetic 3-step chain: each step stamps its version and appends a marker.
    const migrations: Record<number, (r: RawDocument) => RawDocument> = {
      0: (r) => ({ ...r, version: 1, trail: [...((r.trail as number[]) ?? []), 1] }),
      1: (r) => ({ ...r, version: 2, trail: [...(r.trail as number[]), 2] }),
      2: (r) => ({ ...r, version: 3, trail: [...(r.trail as number[]), 3] }),
    };
    const out = runMigrations({ format: "chisel-cad", operations: [] }, migrations, 3);
    expect(out.version).toBe(3);
    expect(out.trail).toEqual([1, 2, 3]);

    // Already current → untouched.
    const noop = runMigrations({ format: "chisel-cad", version: 3, operations: [] }, migrations, 3);
    expect(noop.version).toBe(3);
    expect(noop.trail).toBeUndefined();
  });

  it("throws when a migration step is missing", () => {
    expect(() => runMigrations({ version: 0 }, { /* no 0→1 */ }, 2)).toThrow(/No migration from document version 0/i);
  });
});
