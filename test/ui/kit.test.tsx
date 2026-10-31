import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, renderHook, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { LiveNumber } from "../../src/ui/kit/LiveNumber";
import { Button, Pills, Card, Readout, Chip, Legend, Track, Pin, Input, Select } from "../../src/ui/kit/primitives";
import { ViewportOverlay } from "../../src/ui/kit/ViewportOverlay";
import { useScene, useViewTick, useViewportRect, useProjected, toLocal } from "../../src/ui/kit/useProjected";
import { useCardSize } from "../../src/ui/kit/useCardSize";
import { useStore } from "../../src/model/store";

// A fake scene for the projection hooks: world (x, y) → viewport (400 + 10x, 300 − 10y) in an 800 × 600 view at (10, 20).
const fake = vi.hoisted(() => ({ scene: null as unknown, listeners: [] as ((s: unknown) => void)[], cameraListeners: [] as (() => void)[] }));
vi.mock("../../src/viewport/sceneRef", () => ({
  getActiveScene: () => fake.scene,
  setActiveScene: (s: unknown) => { fake.scene = s; fake.listeners.forEach((l) => l(s)); },
  onActiveScene: (l: (s: unknown) => void) => { fake.listeners.push(l); return () => { fake.listeners = fake.listeners.filter((x) => x !== l); }; },
}));
const fakeScene = () => ({
  renderer: { domElement: { getBoundingClientRect: () => ({ left: 10, top: 20, width: 800, height: 600 }) } },
  cameraPose: () => ({ position: { x: 0, y: 0, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }),
  worldToScreen: (p: { x: number; y: number; z: number }) => ({ x: 400 + 10 * p.x + 10, y: 300 - 10 * p.y + 20 }),
  onCameraChange: (l: () => void) => { fake.cameraListeners.push(l); return () => { fake.cameraListeners = fake.cameraListeners.filter((x) => x !== l); }; },
});

describe("LiveNumber", () => {
  const spec = { min: 0, max: 100, step: 0.5 };

  it("shows the value with its unit and an accessible name", () => {
    render(<LiveNumber value={3} spec={spec} unit="mm" name="wall thickness" onChange={() => {}} />);
    const b = screen.getByRole("button", { name: /wall thickness, 3\.0 mm/ });
    expect(b.textContent).toBe("3.0 mm");
  });

  it("steps with the arrow keys and commits each step", async () => {
    const onChange = vi.fn(), onCommit = vi.fn();
    render(<LiveNumber value={3} spec={spec} name="n" onChange={onChange} onCommit={onCommit} />);
    const b = screen.getByRole("button");
    b.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith(3.5);
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(onChange).toHaveBeenLastCalledWith(0); // 3 - 5 clamps at the min
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("scrubs sideways: one step per 5 px, and commits on release", () => {
    const onChange = vi.fn(), onCommit = vi.fn();
    render(<LiveNumber value={10} spec={spec} name="n" onChange={onChange} onCommit={onCommit} />);
    const b = screen.getByRole("button");
    fireEvent.pointerDown(b, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(b, { clientX: 125 });
    expect(onChange).toHaveBeenLastCalledWith(12.5);
    fireEvent.pointerUp(b);
    expect(onCommit).toHaveBeenCalledTimes(1);
    // the committed value is the last one scrubbed, even though the prop (10) has not caught up yet
    expect(onCommit).toHaveBeenCalledWith(12.5);
  });

  it("keeps the spec it started a drag with, even when the caller's step depends on the live value", () => {
    // step 0.1 under 10, else 1: without freezing, crossing 10 would re-scale the whole drag and jump by ~10×
    const rhsStep = (v: number) => (Math.abs(v) < 10 ? 0.1 : 1);
    const onChange = vi.fn();
    function Limit() {
      const [v, setV] = React.useState(9);
      return <LiveNumber value={v} spec={{ step: rhsStep(v) }} name="limit" onChange={(x) => { onChange(x); setV(x); }} />;
    }
    render(<Limit />);
    const b = screen.getByRole("button");
    fireEvent.pointerDown(b, { button: 0, clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(b, { clientX: 50 }); // 10 steps of 0.1 → 10
    expect(onChange).toHaveBeenLastCalledWith(10);
    fireEvent.pointerMove(b, { clientX: 55 }); // one more step: still 0.1, so 10.1 — not 20
    expect(onChange).toHaveBeenLastCalledWith(10.1);
  });

  it("types a value on Enter and ignores nonsense", async () => {
    const onChange = vi.fn();
    render(<LiveNumber value={10} spec={spec} name="n" onChange={onChange} />);
    screen.getByRole("button").focus();
    await userEvent.keyboard("{Enter}");
    const input = screen.getByRole("textbox", { name: "n" });
    await userEvent.clear(input);
    await userEvent.type(input, "42.3{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(42.5);
    expect(screen.getByRole("button").textContent).toBe("10.0");
  });

  it("reports hover so the part can light up", () => {
    const onHover = vi.fn();
    render(<LiveNumber value={1} spec={spec} name="n" onChange={() => {}} onHover={onHover} />);
    fireEvent.mouseEnter(screen.getByRole("button"));
    fireEvent.mouseLeave(screen.getByRole("button"));
    expect(onHover.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });
});

describe("primitives", () => {
  it("Button exposes pressed state and the accessible label", () => {
    render(<Button on ariaLabel="Zoom in" onClick={() => {}}>+</Button>);
    expect(screen.getByRole("button", { name: "Zoom in" }).getAttribute("aria-pressed")).toBe("true");
  });
  it("Pills are a group with one pressed option that changes on click", async () => {
    const onChange = vi.fn();
    render(<Pills value="b" ariaLabel="Mode" options={[{ key: "a", label: "A" }, { key: "b", label: "B" }]} onChange={onChange} />);
    const group = screen.getByRole("group", { name: "Mode" });
    expect(group.querySelectorAll("[aria-pressed='true']").length).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: "A" }));
    expect(onChange).toHaveBeenCalledWith("a");
  });
  it("Card is a dialog placed where asked, with a close button", async () => {
    const onClose = vi.fn();
    render(<Card at={{ x: 20, y: 30 }} num={2} title="Upright wall" onClose={onClose}>body</Card>);
    const d = screen.getByRole("dialog", { name: "Upright wall" });
    expect(d.style.left).toBe("20px");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
  it("Readout and Chip render their text", () => {
    render(<><Readout label="Mass" value="99.6 g" state="bad" /><Chip num={3} label="Holes" state="ghost" /></>);
    expect(screen.getByText("99.6 g")).toBeTruthy();
    expect(screen.getByRole("button", { name: "3Holes" }).className).toContain("ghost");
  });
  it("Chip reports hover, lights up when hot and takes an extra class", () => {
    const onHover = vi.fn();
    render(<Chip label="Wall" hot className="extra" onHover={onHover} />);
    const c = screen.getByRole("button", { name: "Wall" });
    expect(c.className).toContain("k-hot");
    expect(c.className).toContain("extra");
    fireEvent.mouseEnter(c); fireEvent.mouseLeave(c);
    expect(onHover.mock.calls.map((x) => x[0])).toEqual([true, false]);
  });
  it("Button can be a form's submit button", () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(<form onSubmit={onSubmit}><Button type="submit">Add</Button></form>);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button").getAttribute("type")).toBe("submit");
  });
  it("Card has inline and agent variants that sit in a panel's flow, and head actions", () => {
    const onRemove = vi.fn();
    render(<>
      <Card variant="inline" num="A" title="w 30" headActions={<Button ariaLabel="Remove A" onClick={onRemove}>×</Button>} role="listitem" ariaLabel="Pin A">body</Card>
      <Card variant="agent" role="group" ariaLabel="Suggestion">fix</Card>
    </>);
    const a = screen.getByRole("listitem", { name: "Pin A" });
    expect(a.className).toBe("k-card inline");
    expect(a.style.left).toBe("");
    expect(a.textContent).toContain("Aw 30");
    fireEvent.click(screen.getByRole("button", { name: "Remove A" }));
    expect(onRemove).toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Suggestion" }).className).toBe("k-card agent");
  });
  it("Legend renders swatch rows and a ramp with its end labels", () => {
    render(<Legend title="Draft" rows={[{ color: "var(--k-an-draft-ok)", label: "Drafts out" }]} ramp={{ css: "var(--k-an-zebra)", min: "break", mid: "kink", max: "smooth" }} />);
    expect(screen.getByText("Draft")).toBeTruthy();
    const row = screen.getByText("Drafts out");
    expect((row.querySelector(".k-swatch") as HTMLElement).style.background).toBe("var(--k-an-draft-ok)");
    expect((document.querySelector(".k-ramp") as HTMLElement).style.background).toBe("var(--k-an-zebra)");
    expect(["break", "kink", "smooth"].every((t) => screen.getByText(t))).toBe(true);
  });
  it("Track is dashed where the history is rolled back", () => {
    const { container } = render(<><Track /><Track ghost /></>);
    const tracks = container.querySelectorAll(".k-track");
    expect(tracks.length).toBe(2);
    expect(tracks[0].className).toBe("k-track");
    expect(tracks[1].className).toBe("k-track ghost");
  });
  it("Pin is a positioned button with its state, hover sync and cluster shape", async () => {
    const onHover = vi.fn(), onClick = vi.fn();
    render(<><Pin at={{ x: 40, y: 50 }} state="ghost" hot ariaLabel="Feature 2: Edges" ariaPressed={false} onHover={onHover} onClick={onClick}>2</Pin><Pin at={{ x: 0, y: 0 }} cluster ariaLabel="Features 3 · 4" ariaExpanded>3 · 4</Pin></>);
    const pin = screen.getByRole("button", { name: "Feature 2: Edges" });
    expect(pin.style.left).toBe("40px"); expect(pin.style.top).toBe("50px");
    expect(pin.className).toBe("k-pin ghost k-hot");
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    fireEvent.mouseEnter(pin); fireEvent.mouseLeave(pin);
    expect(onHover.mock.calls.map((x) => x[0])).toEqual([true, false]);
    await userEvent.click(pin);
    expect(onClick).toHaveBeenCalled();
    const cluster = screen.getByRole("button", { name: "Features 3 · 4" });
    expect(cluster.className).toBe("k-pin cluster");
    expect(cluster.getAttribute("aria-expanded")).toBe("true");
  });
  it("Input and Select are the kit's text controls", async () => {
    const onText = vi.fn(), onPick = vi.fn();
    render(<><Input ariaLabel="Intent" value="" placeholder="mass <= 120" invalid mono onChange={onText} /><Select ariaLabel="Metric" value="mass" options={[{ key: "mass", label: "Mass" }, { key: "volume", label: "Volume" }]} onChange={onPick} /></>);
    const input = screen.getByRole("textbox", { name: "Intent" });
    expect(input.className).toBe("k-input k-mono");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(input, { target: { value: "h" } });
    expect(onText).toHaveBeenCalledWith("h");
    const select = screen.getByRole("combobox", { name: "Metric" }) as HTMLSelectElement;
    expect(select.className).toBe("k-select");
    await userEvent.selectOptions(select, "volume");
    expect(onPick).toHaveBeenCalledWith("volume");
  });
  it("ViewportOverlay is the pointer-transparent layer over the view", () => {
    const { container } = render(<ViewportOverlay><span>pin</span></ViewportOverlay>);
    const layer = container.firstElementChild!;
    expect(layer.className).toBe("k-overlay");
    expect(layer.textContent).toBe("pin");
  });
});

describe("projection hooks", () => {
  beforeEach(() => { fake.scene = null; fake.listeners = []; fake.cameraListeners = []; });

  it("report no scene, a zero rect and invisible points until the viewport exists", () => {
    const scene = renderHook(() => useScene());
    expect(scene.result.current).toBeNull();
    const rect = renderHook(() => useViewportRect());
    expect(rect.result.current).toEqual({ left: 0, top: 0, w: 0, h: 0 });
    const proj = renderHook(() => useProjected([{ x: 1, y: 2, z: 3 }]));
    expect(proj.result.current).toEqual([{ x: 0, y: 0, visible: false }]);
  });

  it("project world points to viewport-local pixels, flag the ones outside or behind, and re-run on a camera move", () => {
    fake.scene = fakeScene();
    const { result } = renderHook(() => useProjected([{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, { x: 0, y: 0, z: 2000 }]));
    expect(result.current[0]).toEqual({ x: 400, y: 300, visible: true });
    expect(result.current[1]).toMatchObject({ x: 1400, visible: false }); // off the right edge
    expect(result.current[2]).toMatchObject({ visible: false }); // behind the camera
    const rect = renderHook(() => useViewportRect());
    expect(rect.result.current).toEqual({ left: 10, top: 20, w: 800, h: 600 });
    expect(toLocal({ x: 110, y: 120 }, rect.result.current)).toEqual({ x: 100, y: 100 });
    const tick = renderHook(() => useViewTick());
    const before = tick.result.current;
    act(() => fake.cameraListeners.forEach((l) => l()));
    expect(tick.result.current).toBe(before + 1);
    act(() => useStore.setState({ rev: useStore.getState().rev + 1 }));
    expect(tick.result.current).toBe(before + 2);
  });

  it("follow the scene when it appears later", () => {
    const { result } = renderHook(() => useScene());
    expect(result.current).toBeNull();
    const s = fakeScene();
    act(() => fake.listeners.forEach((l) => l(s)));
    expect(result.current).toBe(s as never);
  });

  it("useCardSize keeps the fallback until the element has a layout size", () => {
    const el = document.createElement("div");
    const ref = { current: el };
    const { result, rerender } = renderHook(() => useCardSize(ref, { w: 320, h: 160 }));
    expect(result.current).toEqual({ w: 320, h: 160 }); // jsdom: offsetWidth 0
    Object.defineProperty(el, "offsetWidth", { value: 300, configurable: true });
    Object.defineProperty(el, "offsetHeight", { value: 120, configurable: true });
    rerender();
    expect(result.current).toEqual({ w: 300, h: 120 });
  });
});
