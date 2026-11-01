// M14–M19: one name and number per feature (strip, card, Timeline); a chip
// opens its card and ⌥-click rolls back; rename where names show; the
// Parameters panel commits names on Enter and focuses a new one; naming a
// number is one undo step; the browser selects on click and edits on
// double-click; an empty finished sketch goes; pick-behind labels say which way
// a face looks.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import { realSession } from "../helpers";
import type { CadSession } from "../../src/core/command/session";

vi.mock("../../src/viewport/sceneRef", () => ({ getActiveScene: () => null, setActiveScene: () => {}, onActiveScene: () => () => {} }));

import { useStore } from "../../src/model/store";
import { useUi } from "../../src/model/concepts/uiState";
import { HistoryStrip, FeatureCard } from "../../src/ui/concepts/workbench";
import { TimelinePanel } from "../../src/ui/TimelinePanel";
import { BrowserPanel } from "../../src/ui/BrowserPanel";
import { ParametersPanel } from "../../src/ui/ParametersPanel";
import { Dialog } from "../../src/ui/kit/Dialog";
import { faceLabel, orientationWord } from "../../src/model/pickMenu";
import { featureRows } from "../../src/model/concepts/featureCatalog";
import { nameThisNumber } from "../../src/ui/concepts/contextActions";
import { cardParams } from "../../src/ui/concepts/workbench/workbench";

let s: CadSession;
let sid: string;
let boxId: string;
beforeEach(async () => {
  s = realSession();
  sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
  await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 0, y: 0 }, opposite: { x: 20, y: 10 } });
  await s.dispatch("feature.extrude", { sketch: sid, distance: "5" });
  boxId = (await s.dispatch("feature.primitive", { shape: "box", x: "10", y: "10", z: "10", at: { x: 50, y: 0, z: 5 } })).createdIds[0];
  useStore.setState({ session: s, rev: 1, solids: {}, mode: "model", activeSketchId: null, activeComponentId: s.doc.rootComponentId, rebuildSolids: vi.fn(async () => {}), ensureKernel: vi.fn(async () => {}) } as never);
  useUi.setState({ openFeature: null, panels: { ...useUi.getState().panels, workbench: true } });
});

describe("one name and one number per feature (M14)", () => {
  it("the strip, the Timeline and the card agree, and a rolled-back chip keeps its name", async () => {
    render(<><HistoryStrip /><TimelinePanel /></>);
    expect(screen.getAllByRole("button", { name: /Extrude|Box/ }).map((c) => c.textContent)).toEqual(["1Extrude", "2Box"]);
    const timeline = document.querySelector(".timeline-list")!;
    expect(timeline.textContent).toMatch(/1.*Extrude/);
    expect(timeline.textContent).toMatch(/2.*Box/);
    expect(timeline.textContent).not.toMatch(/Primitive solid/);
    await act(async () => { await s.moveRollback(0); useStore.setState((st) => ({ rev: st.rev + 1 })); });
    expect(screen.getAllByRole("button", { name: /Extrude|Box/ }).map((c) => c.textContent)).toEqual(["1Extrude", "2Box"]);
  });
});

describe("chips and renaming (M15, M16)", () => {
  it("a click opens the card, ⌥-click rolls back, a double-click renames", async () => {
    const roll = vi.fn(async () => {});
    useStore.setState({ moveRollback: roll } as never);
    render(<><HistoryStrip /><FeatureCard /><Dialog /></>);
    const chip = screen.getByRole("button", { name: /^2\s*Box|Box/ });
    fireEvent.click(chip);
    expect(useUi.getState().openFeature).toBe(boxId);
    expect(roll).not.toHaveBeenCalled();
    fireEvent.click(chip, { altKey: true });
    expect(roll).toHaveBeenCalled();
    fireEvent.doubleClick(chip);
    const field = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(field, { target: { value: "Weight" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Rename" })); });
    await waitFor(() => expect(s.timeline.find((o) => o.createdIds[0] === boxId)!.params.name).toBe("Weight"));
    expect(screen.getByRole("dialog", { name: "Weight" })).toBeTruthy(); // the card follows
    expect(s.undoLabel()).toBe("Edit Weight");
  });
});

describe("the Parameters panel (M17)", () => {
  it("＋ focuses the new name; Enter commits a rename", async () => {
    render(<ParametersPanel />);
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => { f(0); return 1; });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add parameter" })); });
    const input = screen.getByRole("textbox", { name: "Name of d" }) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "depth" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    await waitFor(() => expect(s.doc.parameters.map((p) => p.name)).toEqual(["depth"]));
    vi.unstubAllGlobals();
  });

  it("naming a feature's number is one undo step", async () => {
    render(<Dialog />);
    const row = featureRows(s.doc, s.timeline, s.rollbackIndex, {})[0];
    const p = cardParams(row)[0];
    const done = nameThisNumber(row, p);
    const field = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(field, { target: { value: "thick" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Name it" })); await done; });
    expect(s.timeline.find((o) => o.opId === row.opId)!.params.distance).toBe("thick");
    s.undo();
    expect(s.doc.parameters).toEqual([]);
    expect(s.timeline.find((o) => o.opId === row.opId)!.params.distance).toBe("5");
  });
});

describe("the browser (M18)", () => {
  it("a click selects a sketch, a double-click edits it, F2 renames", async () => {
    const edit = vi.fn();
    useStore.setState({ editSketch: edit } as never);
    render(<><BrowserPanel /><Dialog /></>);
    const row = screen.getByRole("treeitem", { name: /Sketch 1/ });
    fireEvent.click(row);
    expect(edit).not.toHaveBeenCalled();
    expect(row.getAttribute("aria-selected")).toBe("true");
    fireEvent.doubleClick(row);
    expect(edit).toHaveBeenCalledWith(sid);
    fireEvent.keyDown(row, { key: "F2" });
    const field = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(field, { target: { value: "Plate outline" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Rename" })); });
    await waitFor(() => expect(s.doc.sketches[sid].name).toBe("Plate outline"));
  });

  it("an empty sketch is removed when it is finished, in one undo step", async () => {
    const empty = (await s.dispatch("sketch.create", { plane: "XZ" })).createdIds[0];
    useStore.setState({ mode: "sketch", activeSketchId: empty });
    act(() => useStore.getState().finishSketch());
    await waitFor(() => expect(s.doc.sketches[empty]).toBeUndefined());
    expect(useStore.getState().lastMessage).toBe("Removed the empty Sketch 2.");
    s.undo();
    expect(s.doc.sketches[empty]).toBeTruthy();
  });
});

describe("pick-behind labels (M19)", () => {
  it("say which way a face looks and what part it is", () => {
    expect(orientationWord({ x: 0, y: 0, z: 1 })).toBe("top");
    expect(faceLabel("end", { x: 1, y: 0, z: 0 })).toBe("+X end");
    expect(faceLabel("end", { x: 0, y: 0, z: 1 })).toBe("top (end)");
    expect(faceLabel("side:ln5", { x: 0, y: 0, z: 1 })).toBe("top");
    expect(faceLabel("side:ln5", { x: 0, y: -1, z: 0 })).toBe("-Y side");
    expect(faceLabel("side:ci3", { x: 0.6, y: 0.8, z: 0 })).toBe("curved side");
    expect(faceLabel("blend(ext3:end|ext3:side:ln2)", { x: 0.7, y: 0, z: 0.7 })).toBe("rounded edge");
  });
});
