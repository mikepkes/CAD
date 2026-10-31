import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { realSession } from "../helpers";
import { useStore } from "../../src/model/store";
import { resolveParameters } from "../../src/core/parameters";
import type { GeometryBackend } from "../../src/core/geometry/backend";
import type { CadSession } from "../../src/core/command/session";
import { parseIntent } from "../../src/model/concepts/intents";
import { useIntents } from "../../src/model/concepts/intentsStore";
import { DesignSpacePanel, clearGridCache } from "../../src/ui/concepts/space";
import { DesignSpaceMap } from "../../src/ui/concepts/space/Map";
import { Pinned } from "../../src/ui/concepts/space/Pinned";
import { useSpace } from "../../src/ui/concepts/space/spaceState";
import { layout, gridToSvg, cellKey, judgeCell, axisValue, type GridSpec, type CellVerdict } from "../../src/ui/concepts/space/space";
import { metricsOf } from "../../src/model/concepts/intents";

/** The sampling backend: one w × h × 10 box, so every cell's volume is w·h·10. */
function boxBackend(): GeometryBackend {
  return {
    init: async () => {}, ready: () => true, dispose: () => {},
    evaluate: async (doc) => {
      const { scope } = resolveParameters(doc.parameters);
      return { solids: { b: { featureId: "b", name: "b", sketchId: "", distance: 0, mesh: {} as never, volume: scope.w * scope.h * 10, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: scope.w, y: scope.h, z: 10 } } } }, facePlanes: {} };
    },
    edges: async () => [], exportBytes: async () => null, collide: async () => ({ overlaps: [], maxOverlap: 0 }) as never, topology: async () => [], distance: async () => 0, analyze: async () => [],
  };
}

async function twoBounded(): Promise<CadSession> {
  const s = realSession();
  await s.dispatch("parameter.add", { name: "w", expression: "30", min: 10, max: 50, step: 5 });
  await s.dispatch("parameter.add", { name: "h", expression: "15", min: 5, max: 25 });
  await s.dispatch("parameter.add", { name: "free", expression: "2" });
  return s;
}

function mount(s: CadSession, opts: { solids?: Record<string, unknown>; backend?: GeometryBackend } = {}) {
  const setParameterExpr = vi.fn(async () => {});
  useStore.setState({ session: s, rev: useStore.getState().rev + 1, solids: (opts.solids ?? {}) as never, setParameterExpr });
  const backend = opts.backend ?? boxBackend();
  const createBackend = vi.fn(async () => backend);
  const r = render(<DesignSpacePanel createBackend={createBackend} />);
  return { ...r, setParameterExpr, createBackend };
}

const currentSolids = { b: { featureId: "b", name: "b", sketchId: "", distance: 0, mesh: {}, volume: 4500, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 15, z: 10 } } } };

describe("DesignSpacePanel", () => {
  let s: CadSession;
  beforeAll(async () => { s = await twoBounded(); });
  beforeEach(() => {
    localStorage.clear();
    clearGridCache();
    s.doc.intents = []; // intents are document state; `mount` bumps the store, which re-reads them
    useIntents.setState({ docId: s.doc.id, intents: [], results: [], scope: {} });
    useSpace.setState({ xName: null, yName: null, n: 5, metric: "mass", pins: [], compare: null });
  });

  it("shows an empty state when fewer than two parameters have bounds", async () => {
    const one = realSession();
    await one.dispatch("parameter.add", { name: "only", expression: "3", min: 1, max: 5 });
    const { createBackend } = mount(one);
    expect(screen.getByTestId("space-empty").textContent).toMatch(/Set a min and max on at least two parameters.*Only "only" has bounds/);
    expect(createBackend).not.toHaveBeenCalled();
  });

  it("offers the bounded parameters on the axes and metrics to shade by, defaulting to the first two", () => {
    mount(s);
    const x = screen.getByRole("combobox", { name: "X parameter" }) as HTMLSelectElement;
    const y = screen.getByRole("combobox", { name: "Y parameter" }) as HTMLSelectElement;
    expect(Array.from(x.options).map((o) => o.value)).toEqual(["w", "h"]); // "free" has no bounds
    expect(x.value).toBe("w"); expect(y.value).toBe("h");
    expect(Array.from((screen.getByRole("combobox", { name: "Metric" }) as HTMLSelectElement).options).map((o) => o.text)).toEqual(["Mass (est.)", "Volume", "Width", "Depth", "Height"]);
    expect(screen.getByRole("group", { name: "Grid size" })).toBeTruthy();
    expect(screen.getByRole("img", { name: /Design space map\. w 30, h 15/ })).toBeTruthy();
  });

  it("swaps the axes rather than letting both selects pick the same parameter", async () => {
    mount(s);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "X parameter" }), "h");
    expect((screen.getByRole("combobox", { name: "X parameter" }) as HTMLSelectElement).value).toBe("h");
    expect((screen.getByRole("combobox", { name: "Y parameter" }) as HTMLSelectElement).value).toBe("w");
    expect(useSpace.getState()).toMatchObject({ xName: "h", yName: "w" });
  });

  it("samples the grid on its own backend, shows progress, shades passes and hatches fails, with a frontier per intent", async () => {
    s.doc.intents = [parseIntent("volume <= 6000", "i1", "Volume cap")!, parseIntent("w >= 20", "i2", "Wide enough")!];
    const { createBackend } = mount(s, { solids: currentSolids });
    await waitFor(() => expect(screen.getByText("25 cells")).toBeTruthy());
    expect(createBackend).toHaveBeenCalledTimes(1);
    const cells = screen.getByTestId("space-cells").querySelectorAll("[data-cell]");
    expect(cells.length).toBe(25);
    const pass = screen.getByTestId("space-cells").querySelectorAll("[data-pass='1']");
    // w ∈ {20,30,40,50} × h with w·h·10 ≤ 6000 → (20,5..25)=5, (30,5..20)=4, (40,5..15)=3, (50,5..10)=2
    expect(pass.length).toBe(14);
    expect(screen.getByTestId("space-cells").querySelector("[data-cell='0,0'] title")!.textContent).toMatch(/w 10, h 5: Mass \(est\.\) 1\.35 g; fails Wide enough/);
    expect(document.querySelectorAll("[data-frontier='i2'] line").length).toBe(4);
    expect(document.querySelectorAll("[data-frontier='__all'] line").length).toBeGreaterThan(0);
    expect(screen.getByText("Volume cap")).toBeTruthy();
    expect(screen.getByText("Wide enough")).toBeTruthy();
    // the current design: 30 × 15 → 4500 mm³ passes both; the readout says it is an estimate
    expect(screen.getByText("2 / 2 ok")).toBeTruthy();
    expect(screen.getByText("12.2 g").closest(".k-readout")!.getAttribute("title")).toMatch(/Estimate.*aluminium 2\.7/);
    expect(screen.getByRole("img", { name: /passes every intent/ })).toBeTruthy();
    // the lightest passing cell is w 20, h 5
    expect(screen.getByTestId("space-lightest")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Jump to lightest" }).getAttribute("title")).toMatch(/^w 20, h 5/);
  });

  it("re-uses the cached grid for the same recipe and does not resample when a parameter is dragged", async () => {
    const { createBackend, unmount } = mount(s, { solids: currentSolids });
    await waitFor(() => expect(screen.getByText("25 cells")).toBeTruthy());
    unmount();
    const again = mount(s, { solids: currentSolids });
    expect(screen.getByText("25 cells")).toBeTruthy();
    expect(again.createBackend).not.toHaveBeenCalled();
    expect(createBackend).toHaveBeenCalledTimes(1);
  });

  it("drags the design point: both parameters are set live through the store, one edit in flight, flushed on release", async () => {
    const { setParameterExpr } = mount(s, { solids: currentSolids });
    await waitFor(() => expect(screen.getByText("25 cells")).toBeTruthy());
    const map = screen.getByRole("img", { name: /Design space map/ });
    const L = layout(5);
    const target = gridToSvg(L, 4, 0); // w 50, h 5 (jsdom has no layout: client px are viewBox units)
    fireEvent.pointerDown(map, { button: 0, clientX: target.x, clientY: target.y, pointerId: 1 });
    // the first move starts at once
    await waitFor(() => expect(setParameterExpr).toHaveBeenCalledWith("w", "50"));
    await waitFor(() => expect(setParameterExpr).toHaveBeenCalledWith("h", "5"));
    const mid = gridToSvg(L, 2, 2), top = gridToSvg(L, 0, 4);
    fireEvent.pointerMove(map, { clientX: mid.x, clientY: mid.y });
    fireEvent.pointerMove(map, { clientX: top.x, clientY: top.y });
    fireEvent.pointerUp(map);
    await waitFor(() => expect(setParameterExpr).toHaveBeenCalledWith("w", "10"));
    expect(setParameterExpr).toHaveBeenCalledWith("h", "25");
    // the intermediate request (30, 15) was superseded by the newest, so only two positions were sent
    const sent = setParameterExpr.mock.calls.map((c) => (c as unknown as [string, string]).join("="));
    expect(sent).toEqual(["w=50", "h=5", "w=10", "h=25"]);
  });

  it("steps with the arrow keys when the map is focused: the parameter's step, shift = one cell", async () => {
    const { setParameterExpr } = mount(s, { solids: currentSolids });
    const map = screen.getByRole("img", { name: /Design space map/ });
    map.focus();
    fireEvent.keyDown(map, { key: "ArrowRight" });
    await waitFor(() => expect(setParameterExpr).toHaveBeenCalledWith("w", "35")); // w step 5
    fireEvent.keyDown(map, { key: "ArrowUp", shiftKey: true });
    await waitFor(() => expect(setParameterExpr).toHaveBeenCalledWith("h", "20")); // one cell of 5 on a 5-grid over 5..25
    expect(setParameterExpr).not.toHaveBeenCalledWith("h", "15");
  });

  it("jumps to the lightest passing cell", async () => {
    s.doc.intents = [parseIntent("w >= 20", "i2", "Wide enough")!];
    const { setParameterExpr } = mount(s, { solids: currentSolids });
    await waitFor(() => expect((screen.getByRole("button", { name: "Jump to lightest" }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByRole("button", { name: "Jump to lightest" }));
    await waitFor(() => expect(setParameterExpr).toHaveBeenCalledWith("w", "20"));
    expect(setParameterExpr).toHaveBeenCalledWith("h", "5");
  });

  it("pins the current design (A, B, C), goes back to a pin, compares deltas and removes it", async () => {
    const { setParameterExpr } = mount(s, { solids: currentSolids });
    await userEvent.click(screen.getByRole("button", { name: "Pin" }));
    const list = screen.getByRole("list", { name: "Pinned designs" });
    const a = within(list).getByRole("listitem", { name: "Pin A" });
    expect(a.textContent).toContain("w 30 · h 15");
    expect(within(a).getByText("12.2 g")).toBeTruthy();
    expect(document.querySelector("[data-pin='A']")).toBeTruthy(); // marked on the map
    await userEvent.click(screen.getByRole("button", { name: "Pin" })); // the same point again: no second pin
    expect(within(list).getAllByRole("listitem").length).toBe(1);

    // the design moves on (store solids change) → compare shows the change from the pin
    act(() => { useStore.setState({ solids: { b: { ...currentSolids.b, volume: 6000, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 15, z: 10 } } } } as never, rev: useStore.getState().rev + 1 }); });
    await userEvent.click(within(a).getByRole("button", { name: "Compare" }));
    expect(within(a).getByText("+4.05 g")).toBeTruthy();
    expect(within(a).getByText("+1,500 mm³")).toBeTruthy();
    expect(within(a).getByText("+10.0 mm")).toBeTruthy();
    expect(within(a).getAllByText("±0 mm").length).toBe(2); // depth and height unchanged

    // Go to a pin we are already at sends nothing; a pin elsewhere sets both parameters
    await userEvent.click(within(a).getByRole("button", { name: "Go to" }));
    expect(setParameterExpr).not.toHaveBeenCalled();
    act(() => { useSpace.getState().pin({ x: 20, y: 5, xName: "w", yName: "h", metrics: null, verdict: "unknown" }); });
    const b = within(list).getByRole("listitem", { name: "Pin B" });
    expect(within(b).getByText("—")).toBeTruthy(); // no metrics when pinned
    await userEvent.click(within(b).getByRole("button", { name: "Go to" }));
    await waitFor(() => expect(setParameterExpr).toHaveBeenCalledWith("w", "20"));
    expect(setParameterExpr).toHaveBeenCalledWith("h", "5");

    await userEvent.click(within(a).getByRole("button", { name: "Remove pin A" }));
    expect(within(list).queryByRole("listitem", { name: "Pin A" })).toBeNull();
    expect(within(list).getAllByRole("listitem").length).toBe(1);
    expect(document.querySelector("[data-pin='A']")).toBeNull();
    await userEvent.click(within(b).getByRole("button", { name: "Remove pin B" }));
    expect(screen.queryByRole("list", { name: "Pinned designs" })).toBeNull();
  });

  it("'Go to' a pin made under other axes writes the pin's own parameters, not the ones the map shows", async () => {
    const { setParameterExpr } = mount(s, { solids: currentSolids });
    act(() => { useSpace.getState().pin({ x: 20, y: 40, xName: "h", yName: "w", metrics: null, verdict: "unknown" }); });
    const a = within(screen.getByRole("list", { name: "Pinned designs" })).getByRole("listitem", { name: "Pin A" });
    await userEvent.click(within(a).getByRole("button", { name: "Go to" }));
    await waitFor(() => expect(setParameterExpr).toHaveBeenCalledWith("h", "20"));
    expect(setParameterExpr).toHaveBeenCalledWith("w", "40");
    expect(setParameterExpr).not.toHaveBeenCalledWith("w", "20");
    expect((screen.getByRole("combobox", { name: "X parameter" }) as HTMLSelectElement).value).toBe("h");
  });

  it("retries the sampler backend after a failed start instead of failing every later run", async () => {
    let fail = true;
    const backend = boxBackend();
    const createBackend = vi.fn(async () => { if (fail) throw new Error("no wasm"); return backend; });
    useStore.setState({ session: s, rev: useStore.getState().rev + 1, solids: currentSolids as never, setParameterExpr: vi.fn(async () => {}) });
    render(<DesignSpacePanel createBackend={createBackend} />);
    await waitFor(() => expect(screen.getByText(/sampling failed: no wasm/)).toBeTruthy());
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Resample" }));
    await waitFor(() => expect(screen.getByText("25 cells")).toBeTruthy());
    expect(createBackend).toHaveBeenCalledTimes(2);
  });

  it("cancels sampling and can resample", async () => {
    let release: () => void = () => {};
    const slow: GeometryBackend = { ...boxBackend(), evaluate: () => new Promise((r) => { release = () => r({ solids: {}, facePlanes: {} }); }) };
    useSpace.setState({ n: 9 }); // a fresh key, not in the cache
    mount(s, { backend: slow });
    await waitFor(() => expect(screen.getByText(/sampling 0 \/ 81/)).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    release();
    expect(screen.getByRole("button", { name: "Resample" })).toBeTruthy();
    expect(screen.queryByText(/sampling/)).toBeNull();
  });
});

describe("DesignSpaceMap and Pinned (props only)", () => {
  const spec: GridSpec = { x: { name: "w", min: 10, max: 50, step: 5 }, y: { name: "h", min: 5, max: 25 }, n: 5 };
  const doc = { parameters: [{ id: "w", name: "w", expr: "30", value: 30 }, { id: "h", name: "h", expr: "15", value: 15 }] } as never;
  const cells: (CellVerdict | undefined)[] = new Array(25);
  for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) {
    const x = axisValue(spec.x, i, 5), y = axisValue(spec.y, j, 5);
    cells[cellKey(i, j, 5)] = judgeCell({ i, j, x, y, metrics: metricsOf({ b: { featureId: "b", name: "b", mesh: {} as never, volume: x * y * 10, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x, y, z: 10 } } } as never }, 1) }, doc, spec, [], 2.7);
  }

  it("renders without the scene, labels the axes, and reports moves and commits", () => {
    const onMove = vi.fn(), onCommit = vi.fn();
    render(<DesignSpaceMap spec={spec} cells={cells} metric="volume" intents={[]} current={{ x: 30, y: 15 }} verdict="unknown" lightest={null} pins={[]} onMove={onMove} onCommit={onCommit} />);
    const map = screen.getByRole("img");
    expect(map.textContent).toContain("w");
    expect(map.textContent).toContain("h");
    expect(screen.getByTestId("space-current").getAttribute("data-x")).toBe("30");
    fireEvent.keyDown(map, { key: "ArrowLeft" });
    expect(onMove).toHaveBeenCalledWith(25, 15);
    expect(onCommit).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(map, { key: "Enter" });
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/brighter = lower volume/)).toBeTruthy();
  });

  it("Pinned lists cards with Go to / Compare / remove", async () => {
    const onGo = vi.fn(), onCompare = vi.fn(), onRemove = vi.fn();
    const m = metricsOf({ b: { featureId: "b", name: "b", mesh: {} as never, volume: 1000, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } } } as never }, 2.7);
    render(<Pinned pins={[{ letter: "B", x: 20, y: 5, xName: "w", yName: "h", metrics: m, verdict: "pass" }]} metric="mass" current={m} compare={null} onGo={onGo} onCompare={onCompare} onRemove={onRemove} />);
    const card = screen.getByRole("listitem", { name: "Pin B" });
    expect(within(card).getByText("2.70 g").closest(".k-readout")!.className).toContain("ok");
    await userEvent.click(within(card).getByRole("button", { name: "Go to" }));
    expect(onGo).toHaveBeenCalledWith(expect.objectContaining({ letter: "B", x: 20, y: 5 }));
    await userEvent.click(within(card).getByRole("button", { name: "Compare" }));
    expect(onCompare).toHaveBeenCalledWith("B");
    await userEvent.click(within(card).getByRole("button", { name: "Remove pin B" }));
    expect(onRemove).toHaveBeenCalledWith("B");
  });
});
