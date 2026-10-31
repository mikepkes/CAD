import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { realSession } from "../helpers";
import type { CadSession } from "../../src/core/command/session";

// A fake scene so pins project in jsdom: world (x, y) → viewport (400 + 10x, 300 − 10y) in an 800 × 600 view.
const fake = vi.hoisted(() => ({ scene: null as unknown }));
vi.mock("../../src/viewport/sceneRef", () => ({
  getActiveScene: () => fake.scene,
  setActiveScene: (s: unknown) => { fake.scene = s; },
  onActiveScene: () => () => {},
}));
const fakeScene = (map = (p: { x: number; y: number }) => ({ x: 400 + 10 * p.x, y: 300 - 10 * p.y })) => ({
  renderer: { domElement: { getBoundingClientRect: () => ({ left: 10, top: 20, width: 800, height: 600 }) } },
  cameraPose: () => ({ position: { x: 0, y: 0, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }),
  worldToScreen: (p: { x: number; y: number; z: number }) => { const q = map(p); return { x: q.x + 10, y: q.y + 20 }; },
  onCameraChange: () => () => {},
});

import { useStore } from "../../src/model/store";
import { useUi } from "../../src/model/concepts/uiState";
import { featureRows, type FeatureRow } from "../../src/model/concepts/featureCatalog";
import { WorkbenchOverlay, HistoryStrip, Pins, FeatureCard, FaceVerbs } from "../../src/ui/concepts/workbench";

let s: CadSession;
let rows: FeatureRow[];
let extrudeId: string;
let ringId: string;
const bounds = (x: number) => ({ min: { x, y: 0, z: 0 }, max: { x: x + 40, y: 20, z: 24 } });
const solids = () => ({
  [extrudeId]: { featureId: extrudeId, name: "Body", sketchId: "", distance: 24, bounds: bounds(0), volume: 19200, area: 5000, centroid: { x: 20, y: 10, z: 12 } },
  [ringId]: { featureId: ringId, name: "Ring", sketchId: "", distance: 24, bounds: bounds(-45), volume: 100 },
});

beforeAll(async () => {
  s = realSession();
  await s.dispatch("parameter.add", { name: "h", expression: "12" });
  const sk = await s.dispatch("sketch.create", { plane: "XY" });
  const sid = sk.createdIds[0];
  await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 0, y: 0 }, opposite: { x: 40, y: 20 } });
  extrudeId = (await s.dispatch("feature.extrude", { sketch: sid, distance: "h*2", name: "Base" })).createdIds[0];
  await s.dispatch("feature.fillet", { radius: "1.5", name: "Edges" });
  // a second component with its own body
  const comp = await s.dispatch("component.create", { name: "Outer ring" });
  const sk2 = await s.dispatch("sketch.create", { plane: "XY", component: comp.createdIds[0] });
  await s.dispatch("sketch.addRectangle", { sketch: sk2.createdIds[0], corner: { x: -100, y: 0 }, opposite: { x: -60, y: 20 } });
  ringId = (await s.dispatch("feature.extrude", { sketch: sk2.createdIds[0], distance: "24" })).createdIds[0];
});

const actions = () => ({
  editOperation: vi.fn(() => Promise.resolve()),
  moveRollback: vi.fn(() => Promise.resolve()),
  suppressOperation: vi.fn(() => Promise.resolve()),
  deleteOperation: vi.fn(() => Promise.resolve()),
  selectFace: vi.fn(),
  activateComponent: vi.fn(),
});
let a: ReturnType<typeof actions>;

beforeEach(async () => {
  fake.scene = null;
  await s.moveRollback(s.timeline.length);
  for (const op of s.timeline) if (op.suppressed) await s.setSuppressed(op.opId, false);
  a = actions();
  useStore.setState({ session: s, rev: 1, solids: solids() as never, mode: "model", faceSelection: null, activeComponentId: s.doc.rootComponentId, ...a } as never);
  useUi.setState({ openFeature: null, hotFeature: null, hotParam: null });
  rows = featureRows(s.doc, s.timeline, s.rollbackIndex, solids() as never);
});

describe("Pins", () => {
  it("renders nothing without a scene, and nothing in sketch mode", () => {
    const { container, rerender } = render(<Pins />);
    expect(container.querySelectorAll(".k-pin").length).toBe(0);
    fake.scene = fakeScene();
    useStore.setState({ mode: "sketch" });
    rerender(<Pins />);
    expect(container.querySelectorAll(".k-pin").length).toBe(0);
  });

  it("shows one numbered pin per feature of the active component, with a leader, and a badge per other component", async () => {
    fake.scene = fakeScene();
    const { container } = render(<Pins />);
    const p1 = screen.getByRole("button", { name: "Feature 1: Base" });
    const p2 = screen.getByRole("button", { name: "Feature 2: Edges" });
    expect(p1.textContent).toBe("1"); expect(p2.textContent).toBe("2");
    expect(container.querySelectorAll("svg.k-leader line").length).toBe(2);
    expect(container.querySelectorAll("svg.k-leader").length).toBe(1);
    const badge = screen.getByRole("button", { name: /Activate Outer ring/ });
    expect(badge.textContent).toBe("Outer ring · 1");
    expect(badge.className).toContain("cluster");
    await userEvent.click(badge);
    expect(a.activateComponent).toHaveBeenCalledWith(rows[2].componentId);
    // the ring's feature has no pin of its own while root is active
    expect(screen.queryByRole("button", { name: /Feature 3/ })).toBeNull();
  });

  it("opens a feature on click, reports hover, and shows states", async () => {
    fake.scene = fakeScene();
    const { container } = render(<Pins />);
    const p1 = screen.getByRole("button", { name: "Feature 1: Base" });
    fireEvent.mouseEnter(p1);
    expect(useUi.getState().hotFeature).toBe(extrudeId);
    fireEvent.mouseLeave(p1);
    expect(useUi.getState().hotFeature).toBeNull();
    await userEvent.click(p1);
    expect(useUi.getState().openFeature).toBe(extrudeId);
    expect(p1.className).toContain("open");
    expect(container.querySelector("svg.k-leader line.open")).toBeTruthy();
    await userEvent.click(p1);
    expect(useUi.getState().openFeature).toBeNull();
    // hot from elsewhere highlights the pin
    act(() => useUi.setState({ hotFeature: rows[1].featureId }));
    expect(screen.getByRole("button", { name: "Feature 2: Edges" }).className).toContain("k-hot");
  });

  it("marks rolled-back pins as ghosts and suppressed pins as off", async () => {
    fake.scene = fakeScene();
    await s.moveRollback(rows[1].index);
    useStore.setState({ rev: 2 });
    render(<Pins />);
    expect(screen.getByRole("button", { name: "Feature 2: Edges" }).className).toContain("ghost");
    await s.moveRollback(s.timeline.length);
    await s.setSuppressed(rows[1].opId, true);
    act(() => useStore.setState({ rev: 3 }));
    expect(screen.getByRole("button", { name: "Feature 2: Edges" }).className).toContain("off");
    await s.setSuppressed(rows[1].opId, false);
  });

  it("merges overlapping pins into a cluster with a chooser", async () => {
    fake.scene = fakeScene(() => ({ x: 400, y: 300 }));
    render(<Pins />);
    const cluster = screen.getByRole("button", { name: "Features 1 · 2" });
    expect(cluster.className).toContain("cluster");
    await userEvent.click(cluster);
    const menu = screen.getByRole("menu", { name: "Choose a feature" });
    await userEvent.click(within(menu).getByRole("button", { name: /Edges/ }));
    expect(useUi.getState().openFeature).toBe(rows[1].featureId);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});


describe("FeatureCard", () => {
  it("renders nothing when no feature is open", () => {
    render(<FeatureCard />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the open row's numbers and edits through editOperation on commit", async () => {
    useUi.setState({ openFeature: extrudeId });
    render(<FeatureCard />);
    const card = screen.getByRole("dialog", { name: "Base" });
    expect(within(card).getByText("1")).toBeTruthy();
    const n = within(card).getByRole("button", { name: /Base distance, 24\.0 mm/ });
    n.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(a.editOperation).toHaveBeenCalledTimes(1);
    expect(a.editOperation.mock.calls[0][0]).toBe(rows[0].opId);
    expect((a.editOperation.mock.calls[0][1] as Record<string, unknown>).distance).toBe("24.5");
    expect((a.editOperation.mock.calls[0][1] as Record<string, unknown>).sketch).toBe(rows[0].op.params.sketch);
  });

  it("throttles live scrubbing to one edit in flight and sends the latest afterwards", async () => {
    const resolvers: (() => void)[] = [];
    a.editOperation.mockImplementation(() => new Promise<void>((r) => resolvers.push(r)));
    useUi.setState({ openFeature: extrudeId });
    render(<FeatureCard />);
    const n = screen.getByRole("button", { name: /Base distance/ });
    fireEvent.pointerDown(n, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(n, { clientX: 105 });
    fireEvent.pointerMove(n, { clientX: 110 });
    fireEvent.pointerMove(n, { clientX: 115 });
    expect(a.editOperation).toHaveBeenCalledTimes(1);
    expect((a.editOperation.mock.calls[0][1] as Record<string, unknown>).distance).toBe("24.5");
    resolvers[0]();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(a.editOperation).toHaveBeenCalledTimes(2);
    expect((a.editOperation.mock.calls[1][1] as Record<string, unknown>).distance).toBe("25.5");
  });

  it("has the history verbs in its foot and closes", async () => {
    useUi.setState({ openFeature: rows[1].featureId });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<FeatureCard />);
    await userEvent.click(screen.getByRole("button", { name: "Roll back to here" }));
    expect(a.moveRollback).toHaveBeenCalledWith(rows[1].index);
    await userEvent.click(screen.getByRole("button", { name: "Suppress" }));
    expect(a.suppressOperation).toHaveBeenCalledWith(rows[1].opId, true);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(a.deleteOperation).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(a.deleteOperation).toHaveBeenCalledWith(rows[1].opId);
    expect(useUi.getState().openFeature).toBeNull();
    confirm.mockRestore();
    act(() => useUi.setState({ openFeature: rows[1].featureId }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useUi.getState().openFeature).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a failed expression as text instead of a live number", async () => {
    const s2 = realSession();
    const sk = await s2.dispatch("sketch.create", { plane: "XY" });
    await s2.dispatch("sketch.addRectangle", { sketch: sk.createdIds[0], corner: { x: 0, y: 0 }, opposite: { x: 4, y: 2 } });
    const id = (await s2.dispatch("feature.extrude", { sketch: sk.createdIds[0], distance: "nope*2" })).createdIds[0];
    useStore.setState({ session: s2, rev: 9, solids: {} });
    useUi.setState({ openFeature: id });
    render(<FeatureCard />);
    expect(screen.getByText("nope*2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /distance,/ })).toBeNull();
  });
});

describe("FaceVerbs", () => {
  const select = (faceName?: string, bodyId = extrudeId) =>
    useStore.setState({ faceSelection: { bodyId, faceName, point: { x: 20, y: 10, z: 24 }, normal: { x: 0, y: 0, z: 1 }, screen: { x: 300, y: 200 } } });

  it("renders nothing without a face selection", () => {
    render(<FaceVerbs />);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("offers Push/Pull for a face whose feature has a push param, editing by the step", async () => {
    select(`${extrudeId}:end`);
    render(<FaceVerbs />);
    const bar = screen.getByRole("toolbar", { name: "Face of Base" });
    fireEvent.click(within(bar).getByRole("button", { name: "Push Distance out" }));
    expect((a.editOperation.mock.calls[0][1] as Record<string, unknown>).distance).toBe("24.5");
    fireEvent.click(within(bar).getByRole("button", { name: "Pull Distance in" }));
    // the second edit waits for the first (one in flight), so it is not sent yet
    expect(a.editOperation).toHaveBeenCalledTimes(1);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(a.editOperation).toHaveBeenCalledTimes(2);
    expect((a.editOperation.mock.calls[1][1] as Record<string, unknown>).distance).toBe("23.5");
  });

  it("has no Push/Pull on a body whose row has no push param, dispatches Look at, and measures", async () => {
    const lookAt = vi.fn();
    window.addEventListener("chisel:lookAt", lookAt);
    select(undefined, ringId);
    useStore.setState({ activeComponentId: rows[2].componentId });
    render(<FaceVerbs />);
    const bar = screen.getByRole("toolbar");
    expect(within(bar).queryByRole("group", { name: "Push/Pull" })).toBeTruthy(); // an extrude: has one
    act(() => useStore.setState({ faceSelection: { bodyId: "unknown-body", point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, screen: { x: 0, y: 0 } } }));
    expect(screen.queryByRole("group", { name: "Push/Pull" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Look at" }));
    expect(lookAt).toHaveBeenCalledTimes(1);
    window.removeEventListener("chisel:lookAt", lookAt);
    act(() => select(`${extrudeId}:end`));
    await userEvent.click(screen.getByRole("button", { name: "Measure" }));
    expect(screen.getByText("Volume")).toBeTruthy();
    expect(screen.getByText("19.2 cm³")).toBeTruthy();
    expect(screen.getByText("40.0 × 20.0 × 24.0 mm")).toBeTruthy();
    expect(screen.queryByText(/Face area/)).toBeNull(); // no mesh in the test solids
  });

  it("closes with × and with Escape through selectFace(null)", async () => {
    select(`${extrudeId}:end`);
    render(<FaceVerbs />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(a.selectFace).toHaveBeenCalledWith(null);
    fireEvent.keyDown(screen.getByRole("toolbar"), { key: "Escape" });
    expect(a.selectFace).toHaveBeenCalledTimes(2);
  });
});

describe("HistoryStrip", () => {
  it("shows a chip per feature in order, the built text, and the range", async () => {
    render(<HistoryStrip />);
    const chips = screen.getAllByRole("button", { name: /Base|Edges|Extrude/ });
    expect(chips.map((c) => c.textContent)).toEqual(["1Base", "2Edges", `3${rows[2].name}`]);
    expect(chips[2].className).toContain("at");
    expect(screen.getByText("All 3 features built")).toBeTruthy();
    const range = screen.getByRole("slider", { name: "Rollback position" }) as HTMLInputElement;
    expect(range.value).toBe("3"); expect(range.max).toBe("3");
    expect(screen.queryByRole("button", { name: "Roll to end" })).toBeNull();
    fireEvent.change(range, { target: { value: "1" } });
    expect(a.moveRollback).toHaveBeenCalledWith(rows[0].index + 1);
    await userEvent.click(chips[1]);
    expect(a.moveRollback).toHaveBeenCalledWith(rows[1].index + 1);
    fireEvent.mouseEnter(chips[0]);
    expect(useUi.getState().hotFeature).toBe(extrudeId);
    fireEvent.mouseLeave(chips[0]);
    expect(useUi.getState().hotFeature).toBeNull();
  });

  it("keeps rolled-back features as ghosts with a dashed track and offers Roll to end", async () => {
    await s.moveRollback(rows[1].index);
    useStore.setState({ rev: 5 });
    const { container } = render(<HistoryStrip />);
    expect(screen.getByRole("button", { name: /Edges/ }).className).toContain("ghost");
    expect(screen.getByRole("button", { name: /Base/ }).className).toContain("at");
    expect(container.querySelectorAll(".k-track.ghost").length).toBe(2);
    expect(screen.getByText("At 1 · Base — new features insert here")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Roll to end" }));
    expect(a.moveRollback).toHaveBeenCalledWith(s.timeline.length);
    await s.moveRollback(s.timeline.length);
  });

  it("works with no features", () => {
    useStore.setState({ session: realSession(), rev: 7, solids: {} });
    render(<HistoryStrip />);
    expect(screen.getByText("No features yet")).toBeTruthy();
    expect(screen.queryByRole("slider")).toBeNull();
  });
});

describe("WorkbenchOverlay", () => {
  it("mounts all three pieces and renders nothing with an empty document and no scene", () => {
    useStore.setState({ session: realSession(), rev: 8, solids: {} });
    const { container } = render(<WorkbenchOverlay />);
    expect(container.querySelectorAll(".k-pin, .k-card").length).toBe(0);
  });

  it("drops the face selection when the mode, the active component or the rollback changes, not on an edit", async () => {
    const sel = { bodyId: extrudeId, faceName: `${extrudeId}:end`, point: { x: 20, y: 10, z: 24 }, normal: { x: 0, y: 0, z: 1 }, screen: { x: 300, y: 200 } };
    const { unmount } = render(<WorkbenchOverlay />);
    act(() => useStore.setState({ faceSelection: sel }));
    expect(screen.getByRole("toolbar", { name: "Face of Base" })).toBeTruthy();
    expect(a.selectFace).not.toHaveBeenCalled();
    act(() => useStore.setState({ rev: 2 })); // a parameter edit: same timeline, same marker
    expect(a.selectFace).not.toHaveBeenCalled();
    act(() => useStore.setState({ mode: "sketch" }));
    expect(a.selectFace).toHaveBeenCalledTimes(1);
    expect(a.selectFace).toHaveBeenLastCalledWith(null);
    act(() => useStore.setState({ mode: "model" }));
    expect(a.selectFace).toHaveBeenCalledTimes(2);
    act(() => useStore.setState({ activeComponentId: rows[2].componentId }));
    expect(a.selectFace).toHaveBeenCalledTimes(3);
    await s.moveRollback(rows[1].index);
    act(() => useStore.setState({ rev: 3 }));
    expect(a.selectFace).toHaveBeenCalledTimes(4);
    await s.moveRollback(s.timeline.length);
    act(() => useStore.setState({ rev: 4 }));
    expect(a.selectFace).toHaveBeenCalledTimes(5);
    // nothing selected: a context change asks for nothing
    act(() => useStore.setState({ faceSelection: null, mode: "sketch" }));
    expect(a.selectFace).toHaveBeenCalledTimes(5);
    unmount();
    act(() => useStore.setState({ faceSelection: sel, mode: "model" }));
    expect(a.selectFace).toHaveBeenCalledTimes(5); // unsubscribed with the overlay
  });
});
