// The one-line row's overflow rule (src/ui/kit/overflow.ts): what goes into the ⋯ menu.
import { describe, it, expect } from "vitest";
import { fitItems, sameKeys } from "../src/ui/kit/overflow";

const items = [
  { key: "a", width: 100, priority: 3 },
  { key: "b", width: 100, priority: 1 },
  { key: "sp", width: 0, spacer: true },
  { key: "c", width: 100, priority: 2 },
  { key: "k", width: 40, pin: true },
];

describe("fitItems", () => {
  it("keeps everything when the row fits", () => {
    expect(fitItems(items, 400, 8, 40).size).toBe(0);
  });
  it("moves the lowest priority first, never a pinned item or a spacer, until the rest and the menu button fit", () => {
    // 340 + 3 gaps (spacers take no gap) = 364 > 320: drop b (priority 1); 256 and the menu button (40 + 8) fit 320
    expect([...fitItems(items, 320, 8, 40)]).toEqual(["b"]);
    expect([...fitItems(items, 200, 8, 40)].sort()).toEqual(["b", "c"]);
    expect([...fitItems(items, 10, 8, 40)].sort()).toEqual(["a", "b", "c"]);
  });
  it("among equal priorities, the later item goes first", () => {
    const same = [{ key: "x", width: 50 }, { key: "y", width: 50 }, { key: "z", width: 50 }];
    expect([...fitItems(same, 120, 0, 20)]).toEqual(["z"]);
  });
  it("compares hidden sets by their keys", () => {
    expect(sameKeys(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
    expect(sameKeys(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
  });
});
