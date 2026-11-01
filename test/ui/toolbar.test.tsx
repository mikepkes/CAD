// The toolbar: one fixed-height row whose extra controls go into ⋯, labelled
// fields, the datum planes in one dropdown, no analysis select (the Lens owns
// analysis), and the motion study reachable from the editor.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useStore } from "../../src/model/store";
import { Toolbar } from "../../src/ui/Toolbar";
import { ViewChips } from "../../src/ui/ConceptShell";
import { realSession } from "../helpers";

const initial = useStore.getState();
async function docWithDatums(n: number) {
  const s = realSession();
  for (let i = 0; i < n; i++) await s.dispatch("plane.create", { base: "XY", offset: String(10 * (i + 1)), name: `Level ${i + 1}` });
  return s;
}

describe("<Toolbar/>", () => {
  beforeEach(() => useStore.setState({ mode: "model", solids: {}, sketchPlacing: false, motionStatus: "idle" }));
  afterEach(() => useStore.setState({ startSketch: initial.startSketch, createDatumPlane: initial.createDatumPlane, runMotionStudy: initial.runMotionStudy, cancelMotionStudy: initial.cancelMotionStudy }));

  it("labels its fields: the sketch offset and the mirror plane say what they are", async () => {
    useStore.setState({ session: realSession(), rev: useStore.getState().rev + 1, solids: { b: { featureId: "b", mesh: {} } as never } });
    render(<Toolbar />);
    const bar = screen.getByRole("toolbar", { name: "Toolbar" });
    const offset = within(bar).getByLabelText("Sketch offset from the plane (mm)");
    expect(offset.closest("label")!.textContent).toMatch(/Offset/);
    const mirror = within(bar).getByLabelText("Mirror plane");
    expect(mirror.closest("label")!.textContent).toMatch(/Mirror about/);
    // the Lens owns the analysis views: no Shading select here
    expect(screen.queryByTitle("Surface analysis")).toBeNull();
  });

  it("keeps the datum planes in one dropdown: sketch on one, or add an offset plane", async () => {
    const s = await docWithDatums(3);
    const startSketch = vi.fn(async () => {});
    const createDatumPlane = vi.fn(async () => "p");
    useStore.setState({ session: s, rev: useStore.getState().rev + 1, startSketch, createDatumPlane });
    render(<Toolbar />);
    expect(screen.queryByRole("button", { name: /Level 2/ })).toBeNull(); // not a row of pills
    await userEvent.click(screen.getByRole("button", { name: /Datum.*3/ }));
    const pop = screen.getByRole("dialog", { name: /Datum planes/ });
    await userEvent.click(within(pop).getByRole("button", { name: /Level 2/ }));
    expect(startSketch).toHaveBeenCalledWith(Object.values(s.doc.planes)[1].id);
    await userEvent.click(screen.getByRole("button", { name: /Datum/ }));
    const pop2 = screen.getByRole("dialog", { name: /Datum planes/ });
    await userEvent.clear(within(pop2).getByLabelText("Offset of the new plane (mm)"));
    await userEvent.type(within(pop2).getByLabelText("Offset of the new plane (mm)"), "25");
    await userEvent.click(within(pop2).getByRole("button", { name: /Add plane/ }));
    expect(createDatumPlane).toHaveBeenCalledWith("XY", "25");
  });

  it("offers the motion study when the model has driven joints, and runs it", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "turn", expression: "0", min: 0, max: 360 });
    s.doc.joints = { j1: { id: "j1", name: "Hinge", kind: "revolute", valueExpr: "turn" } } as never;
    const runMotionStudy = vi.fn(async () => {});
    useStore.setState({ session: s, rev: useStore.getState().rev + 1, runMotionStudy });
    render(<Toolbar />);
    await userEvent.click(screen.getByRole("button", { name: "Motion" }));
    expect(runMotionStudy).toHaveBeenCalled();
  });

  it("has no Motion button on a model without driven joints", () => {
    useStore.setState({ session: realSession(), rev: useStore.getState().rev + 1 });
    render(<Toolbar />);
    expect(screen.queryByRole("button", { name: "Motion" })).toBeNull();
  });

  it("is one row: on a narrow window the extra controls go into the ⋯ menu and run from there", async () => {
    const proto = HTMLElement.prototype;
    const keep = { ow: Object.getOwnPropertyDescriptor(proto, "offsetWidth"), cw: Object.getOwnPropertyDescriptor(proto, "clientWidth") };
    Object.defineProperty(proto, "offsetWidth", { configurable: true, get() { return 90; } });
    Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return (this as HTMLElement).classList.contains("toolbar") ? 300 : 0; } });
    try {
      const setHotkeysOpen = vi.fn();
      useStore.setState({ session: realSession(), rev: useStore.getState().rev + 1, setHotkeysOpen });
      render(<Toolbar />);
      const bar = screen.getByRole("toolbar", { name: "Toolbar" });
      // the brand and Create Sketch stay; everything else is one click away
      expect(within(bar).getByRole("button", { name: /Create Sketch/ })).toBeTruthy();
      expect(within(bar).queryByRole("button", { name: /Extrude/ })).toBeNull();
      await userEvent.click(within(bar).getByRole("button", { name: "More tools" }));
      const menu = screen.getByRole("menu", { name: "More tools" });
      expect(within(menu).getByRole("button", { name: /Extrude/ })).toBeTruthy();
      await userEvent.click(within(menu).getByRole("button", { name: "Keyboard shortcuts" }));
      expect(setHotkeysOpen).toHaveBeenCalledWith(true);
    } finally {
      if (keep.ow) Object.defineProperty(proto, "offsetWidth", keep.ow);
      if (keep.cw) Object.defineProperty(proto, "clientWidth", keep.cw);
    }
  });
});

describe("a narrow window", () => {
  it("starts with both side panels collapsed (below 820 px)", async () => {
    const keep = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    try {
      vi.resetModules();
      const { useUi: fresh } = await import("../../src/model/concepts/uiState");
      expect(fresh.getState().sideOpen).toEqual({ left: false, right: false });
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: keep });
      vi.resetModules();
    }
  });
});

describe("motion study chip", () => {
  afterEach(() => useStore.setState({ motionStatus: "idle", motionProgress: 0, motionResult: null, cancelMotionStudy: initial.cancelMotionStudy }));
  it("shows the study's progress with Stop, then its verdict until the model changes", async () => {
    const cancelMotionStudy = vi.fn();
    useStore.setState({ session: realSession(), cancelMotionStudy });
    render(<ViewChips />);
    expect(screen.queryByTestId("motion-chip")).toBeNull();
    act(() => useStore.setState({ motionStatus: "running", motionProgress: 0.4 }));
    expect(screen.getByTestId("motion-chip").textContent).toMatch(/Motion study 40%/);
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(cancelMotionStudy).toHaveBeenCalled();
    act(() => useStore.setState({ motionStatus: "fail", motionResult: { status: "fail", reason: "Crank hits Frame at 120°", worstOverlap: 1 } as never }));
    expect(screen.getByTestId("motion-chip").textContent).toMatch(/Crank hits Frame/);
    act(() => useStore.setState({ session: realSession(), rev: useStore.getState().rev + 1 }));
    expect(screen.queryByTestId("motion-chip")).toBeNull();
  });
});
