import { describe, it, expect } from "vitest";
import { shortLabel, slotViews, ringKeys, releasesRingKey, digitSlot, arrowDir, moveHighlight, RING_R, RING_PAD, HotkeySource } from "../src/ui/concepts/ring/ringView";
import { resolveRing, clampCentre, RING_ACTION_ID } from "../src/model/ring";
import { prettyKey } from "../src/model/hotkeys";

const hk = (actions: Record<string, { label: string; primary?: string; secondary?: string; can?: boolean }>): HotkeySource => ({
  info: (id) => (actions[id] ? { label: actions[id].label, context: "global" } : null),
  primary: (id) => actions[id]?.primary ?? null,
  secondary: (id) => actions[id]?.secondary ?? null,
  can: (id) => !!actions[id] && actions[id].can !== false,
});

describe("ring labels", () => {
  it("shortens hotkey labels to fit a slot", () => {
    expect(shortLabel("View: Top")).toBe("Top");
    expect(shortLabel("Toggle the lens")).toBe("Lens");
    expect(shortLabel("Toggle construction")).toBe("Construction");
    expect(shortLabel("Line tool")).toBe("Line");
    expect(shortLabel("Frame selection / fit")).toBe("Frame selection");
    expect(shortLabel("Action ring (hold, point, release)")).toBe("Action ring");
    expect(shortLabel("Toggle feature pins (Workbench)")).toBe("Feature pins");
    expect(shortLabel("Undo")).toBe("Undo");
    expect(shortLabel("Suppress the open feature and everything after")).toBe("Suppress the op…");
    expect(shortLabel("Suppress the open feature and everything after").length).toBe(16);
  });

  it("presents the resolved ring: labels, key hints, disabled and empty slots", () => {
    const src = hk({
      "view.top": { label: "View: Top" },
      "view.iso": { label: "View: Iso", can: false },
      "edit.undo": { label: "Undo", primary: "mod+z" },
    });
    const v = slotViews(resolveRing(["global"], { global: { 3: null } }), src);
    expect(v[0]).toMatchObject({ name: "N", actionId: "view.top", label: "Top", title: "View: Top", key: "", enabled: true, from: "global" });
    expect(v[1]).toMatchObject({ name: "NE", enabled: false });
    expect(v[2]).toMatchObject({ actionId: "view.right", label: "view.right", title: "view.right", enabled: false });
    expect(v[3]).toMatchObject({ name: "SE", actionId: null, enabled: false, from: null });
    expect(v[6]).toMatchObject({ name: "W", label: "Undo", key: prettyKey("mod+z"), enabled: true });
  });
});

describe("ring keys", () => {
  it("reads the ring key's bindings and matches its release by the key alone", () => {
    const keys = ringKeys(hk({ [RING_ACTION_ID]: { label: "ring", primary: "space", secondary: "mod+j" } }));
    expect(keys).toEqual(["space", "mod+j"]);
    expect(ringKeys(hk({}))).toEqual([]);
    expect(releasesRingKey("space", keys)).toBe(true);
    expect(releasesRingKey("j", keys)).toBe(true); // ⌘ let go first
    expect(releasesRingKey("shift+space", keys)).toBe(true);
    expect(releasesRingKey("k", keys)).toBe(false);
  });

  it("maps digits 1–8 to N…NW and nothing else", () => {
    expect(digitSlot("1")).toBe(0);
    expect(digitSlot("8")).toBe(7);
    expect(digitSlot("0")).toBeNull();
    expect(digitSlot("9")).toBeNull();
    expect(digitSlot("shift+1")).toBeNull();
    expect(arrowDir("up")).toBe("up");
    expect(arrowDir("enter")).toBeNull();
  });

  it("moves the highlight one slot toward the arrow's side, jumping from nothing or the far side", () => {
    expect(moveHighlight(null, "right")).toBe(2);
    expect(moveHighlight(0, "right")).toBe(1);
    expect(moveHighlight(1, "right")).toBe(2);
    expect(moveHighlight(2, "right")).toBe(2);
    expect(moveHighlight(0, "left")).toBe(7);
    expect(moveHighlight(7, "left")).toBe(6);
    expect(moveHighlight(1, "down")).toBe(2);
    expect(moveHighlight(0, "down")).toBe(4);
    expect(moveHighlight(5, "up")).toBe(6);
  });

  it("keeps the whole ring on screen near an edge", () => {
    expect(clampCentre({ x: 5, y: 5 }, RING_R, RING_PAD, { w: 1000, h: 800 })).toEqual({ x: RING_R + RING_PAD, y: RING_R + RING_PAD });
  });
});
