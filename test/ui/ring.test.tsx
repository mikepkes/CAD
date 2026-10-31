import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { hotkeys, prettyKey } from "../../src/model/hotkeys";
import { useRing, RING_ACTION_ID } from "../../src/model/ring";
import { useStore } from "../../src/model/store";
import { RingOverlay } from "../../src/ui/concepts/ring";
import { Interactions } from "../../src/viewport/interactions";

// The global ring: N view.top, NE view.iso, E view.right, SE view.frame, S view.front, SW intent.open, W edit.undo, NW edit.redo.
const spies = { top: vi.fn(), iso: vi.fn(), right: vi.fn(), undo: vi.fn(), cancel: vi.fn() };
let off: () => void = () => {};
let detach: () => void = () => {};

const menu = () => screen.queryByRole("menu");
const item = (name: string | RegExp) => screen.getByRole("menuitem", { name });
const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.body, { key: k, ...init });
const keyUp = (k: string) => fireEvent.keyUp(document.body, { key: k });
const point = (x: number, y: number) => fireEvent.pointerMove(window, { clientX: x, clientY: y });
const open = () => act(() => { hotkeys.runAction(RING_ACTION_ID); });

beforeEach(() => {
  Object.values(spies).forEach((s) => s.mockClear());
  useRing.setState({ open: false, overrides: {}, pointer: { x: 500, y: 400 } });
  hotkeys.setContexts(["global"]);
  off = hotkeys.registerAll([
    { id: RING_ACTION_ID, label: "Action ring (hold, point, release)", context: "global", defaultPrimary: "space", run: () => useRing.getState().openRing() },
    { id: "view.top", label: "View: Top", context: "global", run: spies.top },
    { id: "view.iso", label: "View: Iso", context: "global", run: spies.iso, when: () => false },
    { id: "view.right", label: "View: Right", context: "global", run: spies.right },
    { id: "edit.undo", label: "Undo", context: "global", defaultPrimary: "mod+z", run: spies.undo },
    { id: "edit.cancel", label: "Cancel / deselect", context: "global", defaultPrimary: "escape", run: spies.cancel },
  ]);
  detach = hotkeys.attach(window);
});
afterEach(() => { off(); detach(); hotkeys.setContexts(["global"]); useRing.setState({ open: false, overrides: {} }); });

describe("<RingOverlay/>", () => {
  it("renders nothing until the ring action opens it, then the resolved slots", () => {
    render(<RingOverlay />);
    expect(menu()).toBeNull();
    open();
    expect(screen.getByRole("menu", { name: "Action ring: Everywhere" })).toBeTruthy();
    expect(screen.getAllByRole("menuitem")).toHaveLength(8);
    expect(item("View: Top").textContent).toBe("Top");
    expect(item(`Undo (${prettyKey("mod+z")})`).textContent).toContain("Undo");
    // a guard that fails, and an id nothing registered, both grey out
    expect(item("View: Iso").getAttribute("aria-disabled")).toBe("true");
    expect(item("view.frame").getAttribute("aria-disabled")).toBe("true");
    expect(item("View: Top").getAttribute("aria-disabled")).toBe("false");
    expect(screen.getByText("configure in ⌨")).toBeTruthy();
  });

  it("names the top context and follows the stack and the user's overrides", () => {
    render(<RingOverlay />);
    act(() => { hotkeys.setContexts(["global", "model"]); useRing.setState({ overrides: { global: { 2: null } } }); });
    open();
    expect(screen.getByRole("menu", { name: "Action ring: Model" })).toBeTruthy();
    // model's N is model.sketch (unregistered here, so disabled); E emptied by the override shows a dot
    expect(item("model.sketch").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getAllByRole("menuitem")).toHaveLength(7);
    expect(document.querySelectorAll(".ring-dot")).toHaveLength(1);
  });

  it("hold Space, point, release: runs the pointed slot and closes", () => {
    render(<RingOverlay />);
    point(500, 400);
    key(" ");
    expect(menu()).toBeTruthy();
    expect(useRing.getState().at).toEqual({ x: 500, y: 400 });
    point(500, 300); // straight up: N
    expect(item("View: Top").className).toContain("accent");
    keyUp(" ");
    expect(spies.top).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it("a held key's repeats neither toggle nor re-open it", () => {
    render(<RingOverlay />);
    key(" ");
    key(" ", { repeat: true });
    key(" ", { repeat: true });
    expect(menu()).toBeTruthy();
    key("Escape");
    expect(menu()).toBeNull();
    key(" ", { repeat: true });
    expect(menu()).toBeNull();
  });

  it("a tap leaves it open; a click runs a slot; a disabled slot does nothing", () => {
    render(<RingOverlay />);
    key(" ");
    keyUp(" "); // well under TAP_MS, pointing nowhere
    expect(menu()).toBeTruthy();
    fireEvent.click(item("View: Iso"));
    expect(spies.iso).not.toHaveBeenCalled();
    expect(menu()).toBeTruthy();
    fireEvent.click(item("View: Right"));
    expect(spies.right).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it("a long hold pointing nowhere closes without running", () => {
    render(<RingOverlay />);
    key(" ");
    act(() => { useRing.setState({ openedAt: performance.now() - 1000 }); });
    keyUp(" ");
    expect(menu()).toBeNull();
    expect(Object.values(spies).every((s) => s.mock.calls.length === 0)).toBe(true);
  });

  it("Escape closes without the global cancel; a press outside closes; Space again closes a sticky ring", () => {
    render(<RingOverlay />);
    open();
    key("Escape");
    expect(menu()).toBeNull();
    expect(spies.cancel).not.toHaveBeenCalled();
    key("Escape"); // closed: Escape is the global cancel again
    expect(spies.cancel).toHaveBeenCalledTimes(1);

    open();
    fireEvent.pointerDown(document.querySelector(".ring-scrim")!);
    expect(menu()).toBeNull();

    open();
    key(" ");
    expect(menu()).toBeNull();
  });

  it("digits 1–8 run slots N…NW", () => {
    render(<RingOverlay />);
    open();
    key("2"); // NE: disabled
    expect(spies.iso).not.toHaveBeenCalled();
    expect(menu()).toBeTruthy();
    key("7"); // W: undo
    expect(spies.undo).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    open();
    key("1");
    expect(spies.top).toHaveBeenCalledTimes(1);
  });

  it("arrows move the highlight around the ring and Enter runs it", () => {
    render(<RingOverlay />);
    open();
    key("ArrowUp");
    expect(item("View: Top").className).toContain("accent");
    key("ArrowRight");
    key("ArrowRight");
    expect(item("View: Right").className).toContain("accent");
    key("Enter");
    expect(spies.right).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });
});

describe("right-click on the viewport", () => {
  let dom: HTMLDivElement;
  let ix: Interactions;
  beforeEach(() => {
    dom = document.createElement("div");
    document.body.appendChild(dom);
    ix = new Interactions({} as never, dom);
    useStore.setState({ mode: "model", contextMenu: null });
  });
  afterEach(() => { ix.dispose(); dom.remove(); useStore.setState({ mode: "model" }); });

  const press = (x: number, y: number) => fireEvent.pointerDown(dom, { button: 2, buttons: 2, clientX: x, clientY: y });
  const menuEvent = (x: number, y: number, buttons = 0) => fireEvent.contextMenu(dom, { button: 2, buttons, clientX: x, clientY: y });

  it("opens the ring at the cursor in model mode on a click, not after a right-drag", () => {
    press(100, 100);
    expect(menuEvent(150, 100)).toBe(false); // the browser menu is suppressed either way
    expect(useRing.getState().open).toBe(false);
    press(200, 200);
    menuEvent(201, 202);
    expect(useRing.getState().open).toBe(true);
    expect(useRing.getState().at).toEqual({ x: 201, y: 202 });
  });

  it("decides on release where contextmenu fires on the press (macOS)", () => {
    press(100, 100);
    menuEvent(100, 100, 2);
    expect(useRing.getState().open).toBe(false);
    fireEvent.pointerUp(window, { button: 2, clientX: 160, clientY: 100 }); // dragged: a pan
    expect(useRing.getState().open).toBe(false);
    press(100, 100);
    menuEvent(100, 100, 2);
    fireEvent.pointerUp(window, { button: 2, clientX: 101, clientY: 100 });
    expect(useRing.getState().open).toBe(true);
  });

  it("leaves sketch mode's context menu alone", () => {
    useStore.setState({ mode: "sketch" });
    press(100, 100);
    menuEvent(100, 100);
    expect(useRing.getState().open).toBe(false);
  });
});
