import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LensFrame } from "../../src/ui/concepts/lens/LensFrame";
import { LensHud } from "../../src/ui/concepts/lens/LensHud";
import { LensOverlay } from "../../src/ui/concepts/lens";
import { useLens, DEFAULT_LENS } from "../../src/ui/concepts/lens/lens";
import { useStore } from "../../src/model/store";
import { useUi } from "../../src/model/concepts/uiState";

const RECT = { left: 100, top: 50, w: 800, h: 600 };
const A = { stripes: 12, draftDeg: 1.5, pull: { x: 0, y: 0, z: 1 }, quantity: "mean" as const };

describe("LensFrame", () => {
  const frame = { shape: "lens" as const, x: 400, y: 300, r: 100, wipeX: 400 };

  it("draws the ring and a handle on its rim", () => {
    render(<LensFrame frame={frame} rect={RECT} onMove={() => {}} />);
    const ring = screen.getByTestId("lens-ring");
    expect(ring.getAttribute("cx")).toBe("400");
    expect(ring.getAttribute("r")).toBe("100");
    const h = screen.getByRole("button", { name: "Move the lens" });
    expect(Number(h.getAttribute("cx"))).toBeCloseTo(470.71, 1);
  });

  it("drags the ring by the pointer's travel (in client coordinates) and clamps", () => {
    const onMove = vi.fn();
    render(<LensFrame frame={frame} rect={RECT} onMove={onMove} />);
    const ring = screen.getByTestId("lens-ring");
    fireEvent.pointerDown(ring, { button: 0, clientX: 500, clientY: 350, pointerId: 1 });
    fireEvent.pointerMove(ring, { clientX: 530, clientY: 340 });
    expect(onMove).toHaveBeenLastCalledWith({ x: 430, y: 290, wipeX: 430 });
    fireEvent.pointerMove(ring, { clientX: 2000, clientY: 340 });
    expect(onMove).toHaveBeenLastCalledWith({ x: 700, y: 290, wipeX: 800 });
    fireEvent.pointerUp(ring);
    fireEvent.pointerMove(ring, { clientX: 600, clientY: 340 });
    expect(onMove).toHaveBeenCalledTimes(2);
  });

  it("nudges with the arrow keys from the handle", async () => {
    const onMove = vi.fn();
    render(<LensFrame frame={frame} rect={RECT} onMove={onMove} />);
    const h = screen.getByRole("button", { name: "Move the lens" });
    h.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onMove).toHaveBeenLastCalledWith({ x: 410, y: 300, wipeX: 410 });
    await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
    expect(onMove).toHaveBeenLastCalledWith({ x: 400, y: 250, wipeX: 400 });
  });

  it("draws a wipe line whose handle moves only in x", () => {
    const onMove = vi.fn();
    render(<LensFrame frame={{ ...frame, shape: "wipe", wipeX: 300 }} rect={RECT} onMove={onMove} />);
    const line = screen.getByTestId("lens-wipe");
    expect(line.getAttribute("x1")).toBe("300");
    const h = screen.getByRole("button", { name: "Move the wipe" });
    fireEvent.pointerDown(h, { button: 0, clientX: 400, clientY: 350, pointerId: 1 });
    fireEvent.pointerMove(h, { clientX: 450, clientY: 500 });
    expect(onMove).toHaveBeenLastCalledWith(expect.objectContaining({ wipeX: 350 }));
  });
});

describe("LensHud", () => {
  const props = { at: { x: 10, y: 20 }, mode: "xray" as const, shape: "lens" as const, size: "M" as const, orient: "standing" as const, analysis: A, bodiesInside: 2, hasCurvature: false,
    onMode: vi.fn(), onShape: vi.fn(), onSize: vi.fn(), onOrient: vi.fn(), onClose: vi.fn() };

  it("shows the mode pills (no Stress), the x-ray body count and the legend", async () => {
    render(<LensHud {...props} />);
    const dialog = screen.getByRole("dialog", { name: "Lens" });
    expect(dialog.style.left).toBe("10px");
    const modes = screen.getByRole("group", { name: "Lens mode" });
    expect(Array.from(modes.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Zebra", "Draft", "Curvature", "X-ray", "Overhang"]);
    expect(screen.queryByText(/stress/i)).toBeNull();
    expect(screen.getByText("Bodies under the lens").nextSibling?.textContent).toBe("2");
    expect(screen.getByText("Every edge, hidden ones too")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Overhang" }));
    expect(props.onMode).toHaveBeenCalledWith("overhang");
    await userEvent.click(screen.getByRole("button", { name: "L" }));
    expect(props.onSize).toHaveBeenCalledWith("L");
    await userEvent.click(screen.getByRole("button", { name: "Wipe" }));
    expect(props.onShape).toHaveBeenCalledWith("wipe");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(props.onClose).toHaveBeenCalled();
  });

  it("shows orientation pills only for overhang, and draft parameters for draft", async () => {
    const { rerender } = render(<LensHud {...props} mode="draft" />);
    expect(screen.queryByRole("group", { name: "Print orientation" })).toBeNull();
    expect(screen.getByText("1.5°")).toBeTruthy();
    rerender(<LensHud {...props} mode="overhang" />);
    await userEvent.click(screen.getByRole("button", { name: "On back" }));
    expect(props.onOrient).toHaveBeenCalledWith("back");
    expect(screen.getByText("Overhang over 45°: needs support")).toBeTruthy();
  });

  it("says when curvature data is missing", () => {
    render(<LensHud {...props} mode="curvature" />);
    expect(screen.getByText("none yet")).toBeTruthy();
  });
});

describe("LensOverlay", () => {
  beforeEach(() => {
    useLens.setState({ ...DEFAULT_LENS });
    useUi.setState({ panels: { ...useUi.getState().panels, lens: false } });
    useStore.setState({ mode: "model", solids: {} });
  });
  const show = () => act(() => useUi.getState().togglePanel("lens", true));

  it("renders nothing while the lens panel is off, and the frame plus HUD once it is on", () => {
    const { container } = render(<LensOverlay rect={RECT} />);
    expect(container.querySelector(".lens-frame")).toBeNull();
    show();
    expect(screen.getByTestId("lens-ring").getAttribute("cx")).toBe("400"); // centred on first show
    expect(screen.getByRole("dialog", { name: "Lens" })).toBeTruthy();
  });

  it("moves the lens through the store when dragged, and closes through the shared panel switch", async () => {
    show();
    render(<LensOverlay rect={RECT} />);
    const ring = screen.getByTestId("lens-ring");
    fireEvent.pointerDown(ring, { button: 0, clientX: 500, clientY: 350, pointerId: 1 });
    fireEvent.pointerMove(ring, { clientX: 520, clientY: 360 });
    expect(useLens.getState()).toMatchObject({ x: 420, y: 310 });
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useUi.getState().panels.lens).toBe(false);
    expect(screen.queryByTestId("lens-ring")).toBeNull();
  });

  it("hides in sketch mode and without a viewport", () => {
    show();
    useStore.setState({ mode: "sketch" });
    const { container, rerender } = render(<LensOverlay rect={RECT} />);
    expect(container.querySelector(".lens-frame")).toBeNull();
    useStore.setState({ mode: "model" });
    rerender(<LensOverlay />); // no live scene → zero rect → nothing to draw, no crash
    expect(container.querySelector(".lens-frame")).toBeNull();
  });

  it("switches mode from the HUD and reads the orientation back", async () => {
    show();
    render(<LensOverlay rect={RECT} />);
    await userEvent.click(screen.getByRole("button", { name: "Overhang" }));
    expect(useLens.getState().mode).toBe("overhang");
    await userEvent.click(screen.getByRole("button", { name: "Upside down" }));
    expect(useLens.getState().orient).toBe("upsideDown");
    expect(screen.getByText("Orientation").nextSibling?.textContent).toBe("Upside down");
  });
});
