import { describe, it, expect } from "vitest";
import { migrateLegacyStorage } from "../src/model/legacyStorage";

function memoryStorage(init: Record<string, string>): Storage {
  const m = new Map(Object.entries(init));
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

describe("settings saved before the rename to VibeCAD", () => {
  it("move from chisel.* to vibecad.* keys, without overwriting newer ones or dropping the old", () => {
    const s = memoryStorage({ "chisel.anthropic.key": "k1", "chisel.ring.v1": "old", "vibecad.ring.v1": "new", "other": "x" });
    expect(migrateLegacyStorage(s)).toBe(1);
    expect(s.getItem("vibecad.anthropic.key")).toBe("k1");
    expect(s.getItem("vibecad.ring.v1")).toBe("new");
    expect(s.getItem("chisel.anthropic.key")).toBe("k1");
    expect(migrateLegacyStorage(s)).toBe(0);
  });
});
