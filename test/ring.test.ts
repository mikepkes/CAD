import { describe, it, expect, beforeEach } from "vitest";
import { contextStack, ringSources, CONTEXTS, CONTEXT_BASE } from "../src/model/contexts";
import { DEFAULT_RING, SLOT_COUNT, resolveRing, ownRow, inheritedSlot, isCustomized, slotAt, slotOffset, clampCentre, releaseOutcome, useRing } from "../src/model/ring";
import { HotkeyManager } from "../src/model/hotkeys";

const base = { mode: "model" as const, face: false, feature: false, lens: false, component: false };

describe("context stack", () => {
  it("stacks the mode, then the focus contexts most specific last", () => {
    expect(contextStack(base)).toEqual(["global", "model"]);
    expect(contextStack({ ...base, face: true, feature: true, lens: true, component: true })).toEqual(["global", "model", "component", "lens", "feature", "face"]);
    expect(contextStack({ ...base, face: true })).toEqual(["global", "model", "face"]);
  });
  it("has no focus contexts while sketching", () => {
    expect(contextStack({ ...base, mode: "sketch", face: true, lens: true })).toEqual(["global", "sketch"]);
  });
  it("lets a ring borrow from the contexts it sits on", () => {
    expect(ringSources("face")).toEqual(["global", "model", "face"]);
    expect(ringSources("global")).toEqual(["global"]);
    for (const c of CONTEXTS) for (const b of CONTEXT_BASE[c]) expect(CONTEXTS.indexOf(b)).toBeLessThan(CONTEXTS.indexOf(c));
  });
});

describe("ring resolution", () => {
  it("fills every global slot and sizes every row", () => {
    for (const c of CONTEXTS) expect(DEFAULT_RING[c].length).toBe(SLOT_COUNT);
    expect(DEFAULT_RING.global.every(Boolean)).toBe(true);
  });
  it("takes each slot from the top-most context that sets it", () => {
    const r = resolveRing(["global", "model", "face"], {});
    expect(r[0]).toEqual({ index: 0, actionId: "face.sketch", from: "face" });
    expect(r[7]).toEqual({ index: 7, actionId: "model.component", from: "model" });
    expect(r[6]).toEqual({ index: 6, actionId: "face.pull", from: "face" });
    expect(r[5]).toEqual({ index: 5, actionId: "view.lens", from: "model" });
    expect(resolveRing(["global"], {})[6].actionId).toBe("edit.undo");
  });
  it("layers overrides: an id replaces, null inherits", () => {
    const o = { face: { 0: "view.top", 2: null } };
    expect(ownRow("face", o)[0]).toBe("view.top");
    const r = resolveRing(["global", "model", "face"], o);
    expect(r[0].actionId).toBe("view.top");
    expect(r[2]).toEqual({ index: 2, actionId: "view.right", from: "global" });
    expect(inheritedSlot(["global", "model"], 0, o).actionId).toBe("model.sketch");
    expect(isCustomized("face", o)).toBe(true);
    expect(isCustomized("model", o)).toBe(false);
  });
});

describe("ring geometry", () => {
  it("maps a pointer offset to a compass slot, clockwise from up", () => {
    expect(slotAt(0, -100)).toBe(0);
    expect(slotAt(100, 0)).toBe(2);
    expect(slotAt(0, 100)).toBe(4);
    expect(slotAt(-100, 0)).toBe(6);
    expect(slotAt(-70, -70)).toBe(7);
    expect(slotAt(70, -72)).toBe(1);
    expect(slotAt(5, 5)).toBeNull();
  });
  it("places slots on the circle and keeps the ring on screen", () => {
    expect(slotOffset(0, 80)).toEqual({ x: 0, y: -80 });
    expect(slotOffset(2, 80)).toEqual({ x: 80, y: 0 });
    expect(clampCentre({ x: 10, y: 590 }, 80, 40, { w: 800, h: 600 })).toEqual({ x: 120, y: 480 });
    expect(clampCentre({ x: 10, y: 10 }, 80, 40, { w: 100, h: 100 })).toEqual({ x: 50, y: 50 });
  });
  it("runs on release when pointing, stays open on a tap, closes on a long empty hold", () => {
    expect(releaseOutcome(900, 3)).toBe("run");
    expect(releaseOutcome(100, null)).toBe("stay");
    expect(releaseOutcome(900, null)).toBe("close");
  });
});

describe("ring store", () => {
  beforeEach(() => useRing.getState().resetAll());
  it("opens at the pointer once and closes", () => {
    const r = useRing.getState();
    r.setPointer({ x: 12, y: 34 });
    r.openRing();
    r.openRing({ x: 99, y: 99 }); // already open: ignored
    expect(useRing.getState()).toMatchObject({ open: true, at: { x: 12, y: 34 } });
    r.close();
    expect(useRing.getState().open).toBe(false);
  });
  it("sets, inherits and restores slots", () => {
    const r = useRing.getState();
    r.setSlot("model", 2, "view.iso");
    r.setSlot("model", 0, null);
    expect(useRing.getState().overrides.model).toEqual({ 0: null, 2: "view.iso" });
    r.setSlot("model", 0, undefined); // back to the default
    r.setSlot("model", 2, DEFAULT_RING.model[2]); // same as the default: no override kept
    expect(useRing.getState().overrides.model).toBeUndefined();
    r.setSlot("face", 1, "view.top");
    r.resetContext("face");
    expect(useRing.getState().overrides).toEqual({});
  });
});

describe("hotkeys.can / info", () => {
  it("is true only for registered actions in an active context whose guard passes", () => {
    const m = new HotkeyManager();
    let ok = true;
    m.register({ id: "a", label: "A", context: "global", run: () => {} });
    m.register({ id: "b", label: "B", context: "face", run: () => {}, when: () => ok });
    expect(m.can("a")).toBe(true);
    expect(m.can("b")).toBe(false);
    m.setContexts(["global", "face"]);
    expect(m.can("b")).toBe(true);
    ok = false;
    expect(m.can("b")).toBe(false);
    expect(m.can("nope")).toBe(false);
    expect(m.info("b")).toEqual({ label: "B", context: "face" });
    expect(m.info("nope")).toBeNull();
  });
});
