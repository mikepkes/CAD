// Sketching by clicks (M8, M9, M20), through the real pointer handler with a
// stand-in scene (screen pixels are sketch units): a rectangle keeps what its
// corners snapped to, a closed line loop ends the chain, a long press offers
// what lies under the cursor, and the constraint bar keeps one height.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { realSession } from "../helpers";
import { useStore } from "../../src/model/store";
import { Interactions, LONG_PRESS_MS } from "../../src/viewport/interactions";
import { ConstraintBar } from "../../src/ui/ConstraintBar";
import { entityLabel } from "../../src/model/pickMenu";
import type { CadSession } from "../../src/core/command/session";

// jsdom has no PointerEvent: a MouseEvent with a pointer id is enough here
if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === "undefined") {
  class PE extends MouseEvent { pointerId: number; pointerType: string; constructor(t: string, init: PointerEventInit = {}) { super(t, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? "mouse"; } }
  (globalThis as { PointerEvent?: unknown }).PointerEvent = PE;
}

let s: CadSession;
let sid: string;
let dom: HTMLDivElement;
let ix: Interactions;
let sketchHits: { id: string; kind: string }[] = [];
const scene = {
  pointerToUV: (x: number, y: number) => ({ u: x, v: y }),
  pixelToWorld: (px: number) => px * 0.1,
  handles: { active: false },
  controls: { enabled: true },
  update: () => {},
  pick: () => ({ type: "empty" }),
  pickAllSketch: () => sketchHits,
  setHoverHighlight: () => {},
};

beforeEach(async () => {
  s = realSession();
  sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
  useStore.setState({ session: s, rev: 1, mode: "sketch", activeSketchId: sid, tool: "rectangle", toolVariant: "corner", constraintTool: null, selection: [], gridSnap: false, constructionMode: false, pickMenu: null, rebuildSolids: vi.fn(async () => {}) } as never);
  dom = document.createElement("div");
  document.body.appendChild(dom);
  ix = new Interactions(scene as never, dom);
});
afterEach(() => { ix.dispose(); dom.remove(); });

const click = async (x: number, y: number) => {
  await act(async () => {
    dom.dispatchEvent(new PointerEvent("pointerdown", { clientX: x, clientY: y, button: 0, bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: x, clientY: y, button: 0, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
};
const sk = () => s.doc.sketches[sid];
const lines = () => Object.values(sk().entities).filter((e) => e.kind === "line").length;

describe("a rectangle keeps what it snapped to (M9)", () => {
  it("a corner on the origin is coincident with it, in one undo step", async () => {
    await click(0, 0);
    await click(30, 20);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const coincident = Object.values(sk().constraints).filter((c) => c.type === "coincident");
    expect(coincident.length).toBe(1);
    expect((coincident[0] as { b: string }).b).toBe(sk().originPointId);
    expect(sk().status.dof).toBe(2); // width and height only
    expect(s.undoLabel()).toBe("Add rectangle");
    s.undo();
    expect(lines()).toBe(0);
  });

  it("a corner on a line's midpoint gets a midpoint constraint", async () => {
    await s.dispatch("sketch.addLine", { sketch: sid, start: { x: 0, y: 50 }, end: { x: 40, y: 50 } });
    await click(20, 50);
    await click(50, 80);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(Object.values(sk().constraints).some((c) => c.type === "midpoint")).toBe(true);
  });
});

describe("the line tool (M20)", () => {
  it("ends the chain when the loop closes", async () => {
    useStore.setState({ tool: "line" });
    for (const [x, y] of [[10, 10], [40, 10], [40, 30], [10, 30], [10, 10]]) await click(x, y);
    expect(lines()).toBe(4);
    expect(useStore.getState().lastMessage).toBe("Closed the outline.");
    await click(60, 60); // starts a new chain, draws nothing yet
    expect(lines()).toBe(4);
    await click(80, 60);
    expect(lines()).toBe(5);
  });
});

describe("long press in a sketch (M9)", () => {
  it("opens the picker with the entities under the cursor; choosing selects", async () => {
    useStore.setState({ tool: "select" });
    const r = await s.dispatch("sketch.addLine", { sketch: sid, start: { x: 0, y: 0 }, end: { x: 40, y: 0 } });
    sketchHits = [{ id: r.createdIds[2], kind: "point" }, { id: r.createdIds[0], kind: "line" }];
    vi.useFakeTimers();
    dom.dispatchEvent(new PointerEvent("pointerdown", { clientX: 40, clientY: 0, button: 0, bubbles: true }));
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
    vi.useRealTimers();
    const menu = useStore.getState().pickMenu!;
    expect(menu.items.map((i) => i.label)).toEqual(["Point", "Line, horizontal, 40 mm"]);
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 40, clientY: 0, button: 0, bubbles: true }));
    act(() => useStore.getState().choosePick(menu.items[1]));
    expect(useStore.getState().selection).toEqual([r.createdIds[0]]);
    expect(entityLabel(sk(), sk().originPointId)).toBe("Origin");
  });
});

describe("the constraint bar (M8, M24)", () => {
  it("keeps one row; selection actions float; chips that don't fit the selection are disabled", async () => {
    const r = await s.dispatch("sketch.addLine", { sketch: sid, start: { x: 0, y: 0 }, end: { x: 30, y: 10 } });
    useStore.setState({ tool: "select", selection: [] });
    const { container } = render(<ConstraintBar />);
    const bar = container.querySelector(".constraint-bar")!;
    expect(screen.getByRole("button", { name: /Horizontal/ })).toHaveProperty("disabled", false);
    act(() => useStore.setState({ selection: [r.createdIds[0]] }));
    // the actions for the selection are not in the bar's row
    const actions = screen.getByRole("toolbar", { name: "For the selection" });
    expect(bar.contains(actions)).toBe(false);
    expect(container.querySelector(".cb-float")!.contains(actions)).toBe(true);
    expect(screen.getByRole("button", { name: /Horizontal/ })).toHaveProperty("disabled", false); // a line can be horizontal
    expect(screen.getByRole("button", { name: /Concentric/ })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: /Horizontal/ }));
  });
});
