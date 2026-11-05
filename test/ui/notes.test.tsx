// The Notes tab: write a note, read it back (author, rendered markdown), edit it,
// draw on it (pen, eraser, undo; only new strokes sent), capture the view behind
// the drawing, pin it to the selection — each save one undoable step — and the
// numbered pin over the view that opens it.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { realSession } from "../helpers";
import { useStore } from "../../src/model/store";
import { useUi } from "../../src/model/concepts/uiState";
import { NotesPanel, NotesOverlay, useNotesUi } from "../../src/ui/concepts/notes";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const VIEW = { position: { x: 100, y: -100, z: 80 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } };

const fake = vi.hoisted(() => ({ scene: null as unknown, restored: [] as unknown[], renders: [] as unknown[] }));
vi.mock("../../src/viewport/sceneRef", () => ({
  getActiveScene: () => fake.scene,
  setActiveScene: () => {},
  onActiveScene: () => () => {},
}));
// jsdom has no image decoding: keep the capture as the PNG it is
vi.mock("../../src/viewport/notePaint", async (orig) => ({ ...(await orig<object>()), compactImage: async (s: string) => s }));

const fakeScene = () => ({
  renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) } },
  cameraPose: () => ({ position: { x: 0, y: 0, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }),
  worldToScreen: (p: { x: number; y: number; z: number }) => ({ x: 400 + 10 * p.x, y: 300 - 10 * p.y }),
  onCameraChange: () => () => {},
  renderView: (o: unknown) => { fake.renders.push(o); return { base64: PNG_B64, width: 768, height: 768, view: "current" }; },
  cameraView: () => VIEW,
  restoreView: (v: unknown) => { fake.restored.push(v); },
});

/** Give the pad a size and draw a stroke across it (client px over a 200 px pad). */
function drawOn(pad: HTMLElement, from: [number, number], to: [number, number]) {
  pad.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.pointerDown(pad, { clientX: from[0], clientY: from[1], pointerId: 1 });
  for (let k = 1; k <= 5; k++) fireEvent.pointerMove(pad, { clientX: from[0] + ((to[0] - from[0]) * k) / 5, clientY: from[1] + ((to[1] - from[1]) * k) / 5, pointerId: 1 });
  fireEvent.pointerUp(pad, { clientX: to[0], clientY: to[1], pointerId: 1 });
}

let s: ReturnType<typeof realSession>;
beforeEach(() => {
  s = realSession();
  fake.scene = fakeScene();
  fake.restored = []; fake.renders = [];
  useStore.setState({ session: s, rev: useStore.getState().rev + 1, faceSelection: null, mode: "model", activeSketchId: null });
  useNotesUi.setState({ open: null, editing: null });
  useUi.setState({ openFeature: null });
});
const bump = () => act(() => useStore.setState({ rev: useStore.getState().rev + 1 }));
const types = () => s.doc.operations.map((o) => o.type);

describe("<NotesPanel/>", () => {
  it("writes a new note as one undoable step, by you", async () => {
    render(<NotesPanel />);
    expect(screen.getByText(/No notes yet/)).toBeTruthy();
    fireEvent.click(screen.getByText("New note"));
    fireEvent.change(screen.getByLabelText("Note title"), { target: { value: "Wall" } });
    fireEvent.change(screen.getByLabelText("Note text"), { target: { value: "Too **thin** here" } });
    const depth = s.undoDepth;
    fireEvent.click(screen.getByText("Add note"));
    await waitFor(() => expect(s.doc.notes).toHaveLength(1));
    expect(s.doc.notes![0]).toMatchObject({ title: "Wall", body: "Too **thin** here", author: "human" });
    expect(s.undoDepth).toBe(depth + 1);
    // it opens, its markdown rendered
    const body = await screen.findByText("thin");
    expect(body.tagName).toBe("STRONG");
    expect(screen.getByText("You")).toBeTruthy();
  });

  it("lists an agent's note with its badge, and edits it: only what changed is sent", async () => {
    await s.dispatch("note.add", { title: "Rib", body: "- one\n- two", author: "agent" });
    bump();
    render(<NotesPanel />);
    const row = screen.getByRole("button", { name: /Rib/ });
    expect(within(row).getByText("Agent")).toBeTruthy();
    fireEvent.click(row);
    expect(screen.getAllByRole("listitem").some((li) => li.textContent === "two")).toBe(true);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByLabelText("Note text"), { target: { value: "- one\n- two\n- three" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(s.doc.notes![0].body).toMatch(/three/));
    const op = s.doc.operations[s.doc.operations.length - 1];
    expect(op.type).toBe("note.update");
    expect(op.params).toEqual({ id: s.doc.notes![0].id, body: "- one\n- two\n- three", author: "human", at: expect.any(Number) });
    expect(s.doc.notes![0]).toMatchObject({ author: "agent", updatedBy: "human" });
  });

  it("draws, erases and undoes on the pad; saving more strokes sends only the new ones", async () => {
    render(<NotesPanel />);
    fireEvent.click(screen.getByText("New note"));
    fireEvent.click(screen.getByText("Add a drawing"));
    const pad = screen.getByTestId("notes-pad");
    drawOn(pad, [20, 20], [180, 20]);
    expect(screen.getByText("1 stroke")).toBeTruthy();
    fireEvent.click(screen.getByText("Erase"));
    drawOn(pad, [100, 10], [100, 30]);
    expect(screen.getByText("0 strokes")).toBeTruthy();
    fireEvent.click(screen.getByText("Undo"));
    expect(screen.getByText("1 stroke")).toBeTruthy();
    fireEvent.click(screen.getByText("Erase")); // back to the pen
    fireEvent.click(screen.getByLabelText("Red"));
    drawOn(pad, [20, 100], [180, 180]);
    fireEvent.click(screen.getByText("Add note"));
    await waitFor(() => expect(s.doc.notes).toHaveLength(1));
    const strokes = s.doc.notes![0].drawing!.strokes;
    expect(strokes.map((x) => x.color)).toEqual(["#1f2328", "#e5484d"]);
    expect(strokes[0].points[0]).toEqual({ x: 0.1, y: 0.1 });
    expect(strokes[0].points.length).toBe(2); // a straight line keeps its ends only

    fireEvent.click(screen.getByText("Edit"));
    drawOn(screen.getByTestId("notes-pad"), [50, 150], [150, 150]);
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(s.doc.notes![0].drawing!.strokes).toHaveLength(3));
    expect(types().slice(-1)).toEqual(["note.stroke.add"]);
    expect((s.doc.operations.at(-1)!.params.strokes as unknown[]).length).toBe(1);
  });

  it("captures the view behind the drawing and remembers the camera", async () => {
    render(<NotesPanel />);
    fireEvent.click(screen.getByText("New note"));
    fireEvent.click(screen.getByText("Add a drawing"));
    fireEvent.click(screen.getByText("Capture view"));
    await screen.findByAltText("Captured view under the drawing");
    expect(fake.renders).toEqual([{ fromCamera: true, width: 768, height: 768 }]);
    expect(screen.getByText(/View saved/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Note title"), { target: { value: "Here" } });
    fireEvent.click(screen.getByText("Add note"));
    await waitFor(() => expect(s.doc.notes).toHaveLength(1));
    expect(s.doc.notes![0].drawing!.background).toBe(`data:image/png;base64,${PNG_B64}`);
    expect(s.doc.notes![0].anchor).toEqual({ view: VIEW });
    fireEvent.click(await screen.findByText("Go to view"));
    expect(fake.restored).toEqual([VIEW]);
  });

  it("pins to the selected face, and shows where it is pinned", async () => {
    const box = (await s.dispatch("feature.primitive", { shape: "box", x: 10, y: 10, z: 10 })).createdIds[0];
    useStore.setState({ rev: useStore.getState().rev + 1, faceSelection: { bodyId: box, point: { x: 5, y: 0, z: 5 }, normal: { x: 1, y: 0, z: 0 }, screen: { x: 0, y: 0 } } as never });
    render(<NotesPanel />);
    fireEvent.click(screen.getByText("New note"));
    fireEvent.change(screen.getByLabelText("Note title"), { target: { value: "Face" } });
    fireEvent.click(screen.getByText("Pin to selection"));
    expect(screen.getByText(/Pinned to Box/)).toBeTruthy();
    fireEvent.click(screen.getByText("Add note"));
    await waitFor(() => expect(s.doc.notes).toHaveLength(1));
    expect(s.doc.notes![0].anchor).toEqual({ feature: box, point: { x: 5, y: 0, z: 5 } });
  });

  it("asks before deleting, and the delete undoes", async () => {
    await s.dispatch("note.add", { title: "Gone" });
    bump();
    render(<NotesPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Gone/ }));
    fireEvent.click(screen.getByText("Delete"));
    const { useDialog } = await import("../../src/ui/kit/askDialog");
    await waitFor(() => expect(useDialog.getState().current).toBeTruthy());
    act(() => { const c = useDialog.getState().current; if (c?.kind === "confirm") c.settle(true); });
    await waitFor(() => expect(s.doc.notes).toEqual([]));
    s.undo();
    expect(s.doc.notes).toHaveLength(1);
  });
});

describe("<NotesOverlay/>", () => {
  it("puts a numbered pin at each pinned note while Notes is on; a click opens it in the tab", async () => {
    await s.dispatch("note.add", { title: "First" });
    await s.dispatch("note.add", { title: "Second", anchor: { point: { x: 2, y: 3, z: 0 } } });
    bump();
    act(() => useUi.getState().togglePanel("notes", false));
    const { rerender } = render(<NotesOverlay />);
    expect(screen.queryByRole("button", { name: /Note 2/ })).toBeNull();
    act(() => useUi.getState().togglePanel("notes", true));
    rerender(<NotesOverlay />);
    const pin = screen.getByRole("button", { name: "Note 2: Second" });
    expect(pin.style.left).toBe("420px");
    expect(pin.style.top).toBe("270px");
    expect(screen.queryByRole("button", { name: /Note 1/ })).toBeNull(); // not pinned, no marker
    fireEvent.click(pin);
    expect(useNotesUi.getState().open).toBe(s.doc.notes![1].id);
    expect(useUi.getState().rightTab).toBe("notes");
  });
});
