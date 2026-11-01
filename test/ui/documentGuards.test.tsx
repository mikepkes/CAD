// M5 / M21 in the UI: deleting a parameter in use asks and can keep its value;
// Open asks before replacing a document; the document has a name field and a
// dirty dot; ⌘S saves under the document's name; undo says what it undid.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { realSession } from "../helpers";
import { useStore, documentFileName } from "../../src/model/store";
import { ParametersPanel } from "../../src/ui/ParametersPanel";
import { Toolbar, confirmOpen } from "../../src/ui/Toolbar";
import { Dialog } from "../../src/ui/kit/Dialog";
import { serializeDocument } from "../../src/core/persistence";
import { hotkeys } from "../../src/model/hotkeys";
import { installHotkeys } from "../../src/model/hotkeyActions";

async function plate() {
  const s = realSession();
  await s.dispatch("parameter.add", { name: "w", expression: "40" });
  const sk = await s.dispatch("sketch.create", { plane: "XY" });
  await s.dispatch("sketch.addRectangle", { sketch: sk.createdIds[0], corner: { x: 0, y: 0 }, opposite: { x: 40, y: 20 } });
  await s.dispatch("feature.extrude", { sketch: sk.createdIds[0], distance: "w/4", name: "Plate" });
  return s;
}

beforeEach(async () => {
  useStore.setState({ session: await plate(), rev: 1, dirty: false, solids: {}, mode: "model", rebuildSolids: vi.fn(async () => {}), ensureKernel: vi.fn(async () => {}) } as never);
});

describe("deleting a parameter in use", () => {
  it("lists what uses it and keeps its value when asked", async () => {
    render(<><ParametersPanel /><Dialog /></>);
    fireEvent.click(screen.getByRole("button", { name: "Delete w" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete w?" });
    expect(dialog.textContent).toMatch(/used by Plate/);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Delete, keep 40" })); });
    await waitFor(() => expect(useStore.getState().session.doc.parameters).toEqual([]));
    expect(useStore.getState().session.timeline.find((o) => o.type === "feature.extrude")!.params.distance).toBe("40/4");
    expect(useStore.getState().lastMessage).toBe("Deleted w; what used it keeps its value");
    // one undo step puts it back, and says so
    act(() => useStore.getState().undo());
    expect(useStore.getState().session.doc.parameters.map((p) => p.name)).toEqual(["w"]);
    expect(useStore.getState().lastMessage).toBe("Undid Delete w, keeping its value");
  });

  it("an unused parameter goes without a question", async () => {
    await useStore.getState().session.dispatch("parameter.add", { name: "spare", expression: "1" });
    render(<><ParametersPanel /><Dialog /></>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Delete spare" })); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useStore.getState().session.doc.parameters.map((p) => p.name)).toEqual(["w"]);
  });
});

describe("Open", () => {
  it("asks before replacing a document, and opening it names the document after the file", async () => {
    render(<Dialog />);
    const fresh = realSession();
    await fresh.dispatch("parameter.add", { name: "a", expression: "1" });
    const file = new File([serializeDocument(fresh.doc)], "Bracket.vibecad.json", { type: "application/json" });
    useStore.setState({ dirty: true });
    let done = false;
    void confirmOpen(file).then(() => { done = true; });
    const dialog = await screen.findByRole("dialog", { name: "Open Bracket.vibecad.json?" });
    expect(dialog.textContent).toMatch(/changes not saved/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(done).toBe(true));
    expect(useStore.getState().session.doc.parameters.map((p) => p.name)).toEqual(["w"]); // unchanged

    done = false;
    void confirmOpen(file).then(() => { done = true; });
    await screen.findByRole("dialog");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open" })); });
    await waitFor(() => expect(done).toBe(true));
    expect(useStore.getState().session.doc.parameters.map((p) => p.name)).toEqual(["a"]);
    expect(useStore.getState().session.doc.name).toBe("Bracket");
    expect(useStore.getState().dirty).toBe(false);
  });
});

describe("the document name, the dirty dot and ⌘S", () => {
  it("names the file after the document", () => {
    expect(documentFileName(undefined)).toBe("model.vibecad.json");
    expect(documentFileName("Phone stand v2")).toBe("phone-stand-v2.vibecad.json");
    expect(documentFileName("  ../x/y  ")).toBe("xy.vibecad.json");
  });

  it("shows a name field and a dirty dot; ⌘S saves under the name and clears the dot", async () => {
    const off = installHotkeys();
    const clicks: string[] = [];
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this.download); });
    render(<Toolbar />);
    const name = screen.getByRole("textbox", { name: "Document name" }) as HTMLInputElement;
    expect(name.placeholder).toBe("Untitled");
    expect(screen.queryByRole("img", { name: "Unsaved changes" })).toBeNull();
    fireEvent.change(name, { target: { value: "Phone stand" } });
    await act(async () => { fireEvent.blur(name); });
    expect(useStore.getState().session.doc.name).toBe("Phone stand");
    expect(screen.getByRole("img", { name: "Unsaved changes" })).toBeTruthy();
    act(() => { hotkeys.runAction("file.save"); });
    expect(clicks).toEqual(["phone-stand.vibecad.json"]);
    expect(useStore.getState().dirty).toBe(false);
    expect(screen.queryByRole("img", { name: "Unsaved changes" })).toBeNull();
    // the key itself is bound
    expect(hotkeys.describe().contexts.flatMap((c) => c.actions).find((a) => a.id === "file.save")?.primary).toBe("mod+s");
    click.mockRestore();
    off();
  });
});
