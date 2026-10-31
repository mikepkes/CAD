import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

const fake = vi.hoisted(() => ({ highlight: vi.fn() }));
vi.mock("../../src/viewport/sceneRef", () => ({ getActiveScene: () => ({ setPickHighlight: fake.highlight }), setActiveScene: () => {}, onActiveScene: () => () => {} }));

import { useStore } from "../../src/model/store";
import { PickMenu } from "../../src/ui/PickMenu";

const mesh = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]), normals: new Float32Array(9), edges: new Float32Array(0), triangleCount: 1, faceRanges: [0, 3], faceNames: ["b1:-X"] };
const items = [
  { kind: "face" as const, bodyId: "b1", faceName: "b1:+X", point: { x: 1, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, label: "Base · +X", detail: "nearest" },
  { kind: "face" as const, bodyId: "b1", faceName: "b1:-X", point: { x: -1, y: 0, z: 0 }, normal: { x: -1, y: 0, z: 0 }, label: "Base · -X", detail: "behind, 1" },
];
afterEach(() => { act(() => useStore.setState({ pickMenu: null })); fake.highlight.mockClear(); });

describe("selection picker menu", () => {
  it("lights the hovered face and acts on the chosen one", () => {
    const choosePick = vi.fn();
    useStore.setState({ pickMenu: { screen: { x: 100, y: 100 }, items }, solids: { b1: { featureId: "b1", name: "Base", sketchId: "", distance: 0, mesh } } as never, choosePick } as never);
    render(<PickMenu />);
    const far = screen.getByRole("menuitem", { name: /Base · -X/ });
    fireEvent.pointerEnter(far);
    expect(fake.highlight).toHaveBeenLastCalledWith(expect.any(Float32Array));
    expect(Array.from(fake.highlight.mock.lastCall![0] as Float32Array)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    fireEvent.click(far);
    expect(choosePick).toHaveBeenCalledWith(items[1]);
  });
  it("closes on Escape and clears the highlight", () => {
    useStore.setState({ pickMenu: { screen: { x: 100, y: 100 }, items } } as never);
    const { unmount } = render(<PickMenu />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useStore.getState().pickMenu).toBeNull();
    unmount();
    expect(fake.highlight).toHaveBeenLastCalledWith(null);
  });
});
