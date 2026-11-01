import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useStore } from "../../src/model/store";
import { useUi, SIDE_DEFAULT, SIDE_MAX, SIDE_MIN, MIN_VIEW } from "../../src/model/concepts/uiState";
import { SideResizer } from "../../src/ui/SideResizer";
import { ParametersPanel } from "../../src/ui/ParametersPanel";
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
