// The long-press picker opens only for a press held still: an orbit drag never
// opens it, even when the timer fires late (a busy main thread after a load).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Interactions, LONG_PRESS_MS, heldStill } from "../../src/viewport/interactions";
import { useStore } from "../../src/model/store";

describe("heldStill", () => {
  it("is the pointer's travel from where it went down, within a few pixels", () => {
    expect(heldStill({ x: 10, y: 10 }, { x: 12, y: 13 })).toBe(true);
    expect(heldStill({ x: 10, y: 10 }, { x: 60, y: 10 })).toBe(false);
    expect(heldStill(null, { x: 0, y: 0 })).toBe(false);
    expect(heldStill({ x: 0, y: 0 }, null)).toBe(true);
  });
});

describe("the long-press picker", () => {
  let dom: HTMLDivElement;
  let it_: Interactions;
  const openPickMenu = vi.fn();
  const scene = { controls: { enabled: true }, handles: { active: false }, pickAll: vi.fn(() => ({ faces: [{ bodyId: "b" }], planes: [] })) };
  const keep = { openPickMenu: useStore.getState().openPickMenu };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16));
    dom = document.createElement("div");
    document.body.appendChild(dom);
    useStore.setState({ mode: "model", contextMenu: null, openPickMenu });
    openPickMenu.mockClear();
    it_ = new Interactions(scene as never, dom);
  });
  afterEach(() => {
    it_.dispose();
    dom.remove();
    useStore.setState(keep);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const down = (x: number, y: number) => dom.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: x, clientY: y, bubbles: true }));
  const move = (x: number, y: number) => dom.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
  const up = (x: number, y: number) => window.dispatchEvent(new PointerEvent("pointerup", { button: 0, clientX: x, clientY: y }));

  it("opens for a press held still", () => {
    down(100, 100);
    move(101, 102);
    vi.advanceTimersByTime(LONG_PRESS_MS + 50);
    expect(openPickMenu).toHaveBeenCalledTimes(1);
  });

  it("never opens after an orbit drag", () => {
    down(100, 100);
    for (let x = 105; x <= 300; x += 15) move(x, 100);
    vi.advanceTimersByTime(LONG_PRESS_MS + 50);
    up(300, 100);
    expect(openPickMenu).not.toHaveBeenCalled();
  });

  it("checks the travel when the timer fires late: moves and the release queued behind it count", () => {
    down(100, 100);
    // the timer is due, but the moves of the drag are only handled in the frame it waits for
    vi.advanceTimersByTime(LONG_PRESS_MS);
    move(250, 140);
    vi.advanceTimersByTime(20);
    expect(openPickMenu).not.toHaveBeenCalled();
  });
});
