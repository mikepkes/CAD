import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useStore } from "../../src/model/store";
import { useUi, SIDE_DEFAULT, SIDE_MAX, SIDE_MIN, MIN_VIEW } from "../../src/model/concepts/uiState";
import { SideResizer } from "../../src/ui/SideResizer";
import { ParametersPanel, configurationCapture } from "../../src/ui/ParametersPanel";
import { useDialog } from "../../src/ui/kit/askDialog";
import { vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { realSession } from "../helpers";

describe("resizable side panels", () => {
  const keepW = window.innerWidth;
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 2400 }); // wide enough that only SIDE_MAX limits a drag
    act(() => { useUi.getState().setSideWidth("left", SIDE_DEFAULT); useUi.getState().setSideWidth("right", SIDE_DEFAULT); });
  });
  afterEach(() => { Object.defineProperty(window, "innerWidth", { configurable: true, value: keepW }); });

  it("drag the left grip right to widen the left panel, clamped, and double-click to reset", () => {
    render(<SideResizer side="left" />);
    const grip = screen.getByRole("separator", { name: "Resize the left panel" });
    grip.setPointerCapture = () => {};
    fireEvent.pointerDown(grip, { clientX: SIDE_DEFAULT, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 400, pointerId: 1 });
    expect(useUi.getState().sideWidth.left).toBe(400);
    fireEvent.pointerUp(grip, { clientX: 2000, pointerId: 1 });
    expect(useUi.getState().sideWidth.left).toBe(SIDE_MAX);
    expect(JSON.parse(localStorage.getItem("vibecad.ui.sideWidth.v1")!).left).toBe(SIDE_MAX);
    fireEvent.doubleClick(grip);
    expect(useUi.getState().sideWidth.left).toBe(SIDE_DEFAULT);
  });

  it("stops where the view would drop under MIN_VIEW", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
    act(() => useUi.setState({ sideOpen: { left: true, right: true } }));
    render(<SideResizer side="left" />);
    const grip = screen.getByRole("separator", { name: "Resize the left panel" });
    grip.setPointerCapture = () => {};
    fireEvent.pointerDown(grip, { clientX: 320, pointerId: 1 });
    fireEvent.pointerUp(grip, { clientX: 2000, pointerId: 1 });
    expect(useUi.getState().sideWidth.left).toBe(1200 - MIN_VIEW - SIDE_DEFAULT);
  });

  it("the right grip widens the right panel as it moves left", () => {
    render(<SideResizer side="right" />);
    const grip = screen.getByRole("separator", { name: "Resize the right panel" });
    grip.setPointerCapture = () => {};
    fireEvent.pointerDown(grip, { clientX: 1000, pointerId: 1 });
    fireEvent.pointerUp(grip, { clientX: 900, pointerId: 1 });
    expect(useUi.getState().sideWidth.right).toBe(SIDE_DEFAULT + 100);
    fireEvent.pointerDown(grip, { clientX: 900, pointerId: 1 });
    fireEvent.pointerUp(grip, { clientX: 1900, pointerId: 1 });
    expect(useUi.getState().sideWidth.right).toBe(SIDE_MIN);
  });
});

describe("parameter sliders", () => {
  beforeEach(async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "phone", expression: "9" });
    await s.dispatch("parameter.setBounds", { name: "phone", min: 6, max: 16 });
    await s.dispatch("parameter.add", { name: "free", expression: "3" });
    useStore.setState({ session: s, rev: 1 } as never);
  });

  it("a bounded parameter gets a full-width slider on its own line, with its extents and its expression still editable", () => {
    const { container } = render(<ParametersPanel />);
    const slider = screen.getByRole("slider", { name: "phone" }) as HTMLInputElement;
    expect(slider.value).toBe("9");
    const line = slider.closest(".param-slider")!;
    expect(line.parentElement!.querySelector(".param-row")).toBeTruthy(); // under the row, not inside it
    expect(line.closest(".param-row")).toBeNull();
    expect([...line.querySelectorAll(".param-slider-end")].map((e) => e.textContent)).toEqual(["6", "16"]);
    expect(container.querySelectorAll("input.param-expr")).toHaveLength(2); // phone's expression field, and free's
    expect(screen.queryByRole("slider", { name: "free" })).toBeNull();
  });
});

describe("the configurations grid", () => {
  it("a new configuration captures the parameters a person tunes, not every expression", () => {
    const p = (name: string, expr: string, value: number, extra: object = {}) => ({ name, expr, value, ...extra });
    expect(configurationCapture([p("width", "40", 40, { min: 20, max: 80 }), p("half", "width/2", 20), p("wall", "2", 2), p("flag", "1", 1, { boolean: true }), p("j", "3", 3, { min: 0, max: 9, hidden: true })]))
      .toEqual({ width: "40", flag: "1" });
    // nothing tuned: the plain numbers, still not the expressions
    expect(configurationCapture([p("half", "width/2", 20), p("wall", "2.5", 2.5)])).toEqual({ wall: "2.5" });
  });

  it("names its controls in the header row (Paste table, + Column), so they never scroll away", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "width", expression: "40", min: 20, max: 80 });
    await s.dispatch("parameter.add", { name: "half", expression: "width/2" });
    const createConfiguration = vi.fn(async () => "cfg1");
    const keep = useStore.getState().createConfiguration;
    useStore.setState({ session: s, rev: 7, createConfiguration } as never);
    render(<ParametersPanel />);
    expect(screen.getByRole("button", { name: "Paste table" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "New configuration" }));
    act(() => { const c = useDialog.getState().current; if (c?.kind === "text") c.settle("Small"); });
    await vi.waitFor(() => expect(createConfiguration).toHaveBeenCalledWith("Small", { width: "40" }));
    useStore.setState({ createConfiguration: keep } as never);
  });
});
