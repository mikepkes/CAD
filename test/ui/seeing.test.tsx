// Seeing what you work on (M10): the face under the cursor is tinted, the picked
// face (and a panel's faces or edges) is lit, and the view cube turns with the
// camera and looks from the face, edge or corner you click.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

const fake = vi.hoisted(() => ({ scene: null as unknown, listeners: [] as ((s: unknown) => void)[] }));
vi.mock("../../src/viewport/sceneRef", () => ({
  getActiveScene: () => fake.scene,
  setActiveScene: (s: unknown) => { fake.scene = s; fake.listeners.forEach((l) => l(s)); },
  onActiveScene: (l: (s: unknown) => void) => { fake.listeners.push(l); return () => {}; },
}));

import { useStore } from "../../src/model/store";
import { cubeView } from "../../src/ui/cubeGeometry";
import { ViewCube } from "../../src/ui/ViewCube";
import { selectionParts, SelectionHighlight } from "../../src/ui/SelectionHighlight";
import { Interactions } from "../../src/viewport/interactions";

// one named face: a single triangle
const mesh = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), edges: new Float32Array([0, 0, 0, 1, 0, 0]), triangleCount: 1, faceRanges: [0, 3], faceNames: ["b1:+Z"] };
const solids = { b1: { featureId: "b1", name: "B", sketchId: "", distance: 0, mesh } };

beforeEach(() => { useStore.setState({ mode: "model", solids: solids as never, faceSelection: null, featureTool: null, extrudeActive: false } as never); });

describe("the view cube", () => {
  const iso = { right: { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 }, up: { x: -0.4, y: 0.4, z: 0.82 }, back: { x: 0.58, y: -0.58, z: 0.58 } };

  it("shows the faces that face the camera, with edges and corners between them", () => {
    const v = cubeView(iso, 46);
    expect(v.faces.map((f) => f.label).sort()).toEqual(["Front", "Right", "Top"]);
    expect(v.corners.some((c) => c.label === "Top front right corner")).toBe(true);
    const top = cubeView({ right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, back: { x: 0, y: 0, z: 1 } }, 46);
    expect(top.faces.map((f) => f.label)).toEqual(["Top"]);
  });

  it("turns with the camera and looks from what you click", () => {
    let basis = iso;
    const listeners: (() => void)[] = [];
    act(() => { fake.scene = { cameraBasis: () => basis, onCameraChange: (l: () => void) => { listeners.push(l); return () => {}; } }; });
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("vibecad:view", on);
    render(<ViewCube />);
    fireEvent.click(screen.getByRole("button", { name: "View from the top" }));
    fireEvent.click(screen.getByRole("button", { name: "View from the top front right corner" }));
    expect(seen).toEqual([{ dir: { x: 0, y: 0, z: 1 } }, { dir: { x: 1, y: -1, z: 1 } }]);
    // the camera turns to look straight down: only the top shows
    act(() => { basis = { right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, back: { x: 0, y: 0, z: 1 } }; listeners.forEach((l) => l()); });
    expect(screen.queryByRole("button", { name: "View from the front" })).toBeNull();
    window.removeEventListener("vibecad:view", on);
    // and it isn't there while sketching
    act(() => useStore.setState({ mode: "sketch" }));
    expect(screen.queryByRole("group", { name: /View cube/ })).toBeNull();
  });
});

describe("the selection is lit", () => {
  it("the picked face, or a panel's faces and edges", () => {
    useStore.setState({ faceSelection: { bodyId: "b1", faceName: "b1:+Z", point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, screen: { x: 0, y: 0 } } });
    expect(Array.from(selectionParts(useStore.getState())[0].faces!)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const set = vi.fn();
    act(() => { fake.scene = { setSelectionHighlight: set }; });
    render(<SelectionHighlight />);
    expect(set).toHaveBeenLastCalledWith([expect.objectContaining({ bodyId: "b1" })]);
    act(() => useStore.setState({ faceSelection: null }));
    expect(set).toHaveBeenLastCalledWith([]);
  });
});

describe("hover", () => {
  let dom: HTMLDivElement;
  let ix: Interactions;
  const tint = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => { f(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const scene = { handles: { active: false }, controls: { enabled: true }, update: () => {}, setHoverHighlight: tint, pick: () => ({ type: "face", id: "b1", tri: 0, world: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } }) };
    dom = document.createElement("div");
    ix = new Interactions(scene as never, dom);
    ix.setBase({ mode: "model" } as never);
  });
  afterEach(() => { ix.dispose(); vi.unstubAllGlobals(); });

  it("tints the face under the cursor", () => {
    dom.dispatchEvent(new MouseEvent("pointermove", { clientX: 5, clientY: 5, buttons: 0, bubbles: true }));
    expect(tint).toHaveBeenLastCalledWith("b1", new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  });
});
