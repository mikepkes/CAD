// M4 in the UI: Push/Pull shows only on an extrude's caps; a formula is shown
// read-only with "edit formula…" (never overwritten by a number); the card has a
// Reverse toggle; the face card offers Sketch and Extrude (M10).

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, fireEvent, act, within, waitFor } from "@testing-library/react";
import { realSession } from "../helpers";
import type { CadSession } from "../../src/core/command/session";

vi.mock("../../src/viewport/sceneRef", () => ({ getActiveScene: () => null, setActiveScene: () => {}, onActiveScene: () => () => {} }));

import { useStore } from "../../src/model/store";
import { useUi } from "../../src/model/concepts/uiState";
import { FaceVerbs, FeatureCard } from "../../src/ui/concepts/workbench";
import { Dialog } from "../../src/ui/kit/Dialog";

let s: CadSession;
let id: string;
let opId: string;
beforeAll(async () => {
  s = realSession();
  await s.dispatch("parameter.add", { name: "t", expression: "6" });
  const sk = await s.dispatch("sketch.create", { plane: "XY" });
  await s.dispatch("sketch.addRectangle", { sketch: sk.createdIds[0], corner: { x: 0, y: 0 }, opposite: { x: 40, y: 20 } });
  const ex = await s.dispatch("feature.extrude", { sketch: sk.createdIds[0], distance: "t*2", name: "Plate" });
  id = ex.createdIds[0];
  opId = ex.opId!;
});

let a: { editOperation: ReturnType<typeof vi.fn>; startSketchOnFace: ReturnType<typeof vi.fn>; startFaceExtrude: ReturnType<typeof vi.fn>; selectFace: ReturnType<typeof vi.fn> };
beforeEach(() => {
  a = { editOperation: vi.fn(() => Promise.resolve()), startSketchOnFace: vi.fn(() => Promise.resolve()), startFaceExtrude: vi.fn(() => Promise.resolve()), selectFace: vi.fn() };
  useStore.setState({ session: s, rev: 1, solids: {}, mode: "model", kernelLoading: false, activeComponentId: s.doc.rootComponentId, ...a } as never);
  useUi.setState({ openFeature: null });
});
const select = (faceName: string, normal = { x: 0, y: 0, z: 1 }) =>
  useStore.setState({ faceSelection: { bodyId: id, faceName, point: { x: 20, y: 10, z: 12 }, normal, screen: { x: 300, y: 200 } } });

describe("the face card", () => {
  it("shows a formula read-only on a cap, and edits it as text", async () => {
    select(`${id}:end`);
    render(<><FaceVerbs /><Dialog /></>);
    const bar = screen.getByRole("toolbar", { name: "Face of Plate" });
    expect(within(bar).getByText("t*2 = 12.0 mm")).toBeTruthy();
    expect(within(bar).queryByRole("button", { name: "Push Distance out" })).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "edit formula…" }));
    const field = await screen.findByRole("textbox", { name: "Distance" });
    expect((field as HTMLInputElement).value).toBe("t*2");
    fireEvent.change(field, { target: { value: "t*3" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Set" })); });
    await waitFor(() => expect(a.editOperation).toHaveBeenCalled());
    expect(a.editOperation.mock.calls[0][0]).toBe(opId);
    expect(a.editOperation.mock.calls[0][1]).toMatchObject({ distance: "t*3" });
  });

  it("offers no Push/Pull on a side face, and says which cap it is on", () => {
    select(`${id}:side:ln1`, { x: 1, y: 0, z: 0 });
    const { unmount } = render(<FaceVerbs />);
    expect(screen.queryByRole("group", { name: "Push/Pull" })).toBeNull();
    unmount();
    select(`${id}:start`, { x: 0, y: 0, z: -1 });
    render(<FaceVerbs />);
    expect(screen.getByRole("toolbar", { name: "Face of Plate" }).textContent).toMatch(/Plate · start face/);
  });

  it("has Sketch and Extrude for the face (M10)", () => {
    select(`${id}:end`);
    render(<FaceVerbs />);
    fireEvent.click(screen.getByRole("button", { name: "Sketch" }));
    expect(a.startSketchOnFace).toHaveBeenCalledWith({ x: 20, y: 10, z: 12 }, { x: 0, y: 0, z: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Extrude" }));
    expect(a.startFaceExtrude).toHaveBeenCalledWith({ x: 20, y: 10, z: 12 }, { x: 0, y: 0, z: 1 });
  });
});

describe("the feature card", () => {
  it("keeps a formula read-only and offers Reverse", () => {
    useUi.setState({ openFeature: id });
    render(<FeatureCard />);
    const card = screen.getByRole("dialog", { name: "Plate" });
    expect(within(card).queryByRole("button", { name: /Plate distance,/ })).toBeNull();
    expect(within(card).getByRole("button", { name: "Edit formula (Distance)" })).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Reverse" }));
    expect(a.editOperation.mock.calls[0][1]).toMatchObject({ direction: "reverse", distance: "t*2" });
  });
});
