// Customize-mode slider edits commit after a pause; a second control's edit never drops the first's.
import { describe, it, expect, vi, afterEach } from "vitest";
import { editCommitter } from "../../src/ui/editCommitter";

describe("editCommitter", () => {
  afterEach(() => vi.useRealTimers());

  it("commits the last value of a drag once it pauses, or at once on release", () => {
    vi.useFakeTimers();
    const got: string[] = [];
    const c = editCommitter((n, v) => got.push(`${n}=${v}`), 200);
    c.edit("L", "1800", false); c.edit("L", "1900", false); c.edit("L", "2000", false);
    expect(got).toEqual([]);
    vi.advanceTimersByTime(250);
    expect(got).toEqual(["L=2000"]);
    c.edit("H", "900", true);
    expect(got).toEqual(["L=2000", "H=900"]);
  });

  it("moving a second slider before the first committed keeps both", () => {
    vi.useFakeTimers();
    const got: string[] = [];
    const c = editCommitter((n, v) => got.push(`${n}=${v}`), 200);
    c.edit("L", "2400", false);
    c.edit("H", "950", false);   // within the pause: L must not be lost
    c.edit("LS", "130", false);
    vi.advanceTimersByTime(250);
    expect(got).toEqual(["L=2400", "H=950", "LS=130"]);
  });

  it("cancel drops a waiting value", () => {
    vi.useFakeTimers();
    const got: string[] = [];
    const c = editCommitter((n, v) => got.push(`${n}=${v}`), 200);
    c.edit("L", "2400", false); c.cancel();
    vi.advanceTimersByTime(500);
    expect(got).toEqual([]);
  });
});
