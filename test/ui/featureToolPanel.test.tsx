// M6 in the UI: Revolve, Shell, Pattern and edge-pick Fillet/Chamfer are panels
// reached from the toolbar, the ring and ⌘K (hotkey actions); clicks on the
// model add faces or edges; the panel commits one feature and opens its card.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import { realSession } from "../helpers";
import type { CadSession } from "../../src/core/command/session";

vi.mock("../../src/viewport/sceneRef", () => ({ getActiveScene: () => null, setActiveScene: () => {}, onActiveScene: () => () => {} }));

import { useStore } from "../../src/model/store";
import { useUi } from "../../src/model/concepts/uiState";
import { FeatureToolPanel } from "../../src/ui/FeatureToolPanel";
import { Toolbar } from "../../src/ui/Toolbar";
import { hotkeys } from "../../src/model/hotkeys";
import { installHotkeys } from "../../src/model/hotkeyActions";
import { DEFAULT_RING } from "../../src/model/ring";

let s: CadSession;
let sid: string;
let line: string;
let boxId: string;
beforeEach(async () => {
  s = realSession();
  const sk = await s.dispatch("sketch.create", { plane: "XZ" });
  sid = sk.createdIds[0];
  await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 10, y: 0 }, opposite: { x: 20, y: 10 } });
  line = (await s.dispatch("sketch.addLine", { sketch: sid, start: { x: 0, y: 0 }, end: { x: 0, y: 30 }, construction: true })).createdIds[0];
  boxId = (await s.dispatch("feature.primitive", { shape: "box", x: "40", y: "30", z: "20", at: { x: 60, y: 0, z: 10 }, name: "Block" })).createdIds[0];
  const solids = { [boxId]: { featureId: boxId, name: "Block", sketchId: "", distance: 0, mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(), edges: new Float32Array(), triangleCount: 0 }, bounds: { min: { x: 40, y: -15, z: 0 }, max: { x: 80, y: 15, z: 20 } } } };
  useStore.setState({ session: s, rev: 1, solids: solids as never, mode: "model", featureTool: null, faceSelection: null, kernelLoading: false, toast: null, rebuildSolids: vi.fn(async () => {}), ensureKernel: vi.fn(async () => {}) } as never);
  useUi.setState({ openFeature: null });
});

describe("reaching the tools", () => {
  it("each is a hotkey action (so ⌘K finds it) and Revolve and Fillet sit on the model ring", () => {
    const off = installHotkeys();
    for (const id of ["model.revolve", "model.shell", "model.pattern", "model.fillet", "model.chamfer"]) expect(hotkeys.info(id)).toBeTruthy();
    expect(DEFAULT_RING.model).toContain("model.revolve");
    expect(DEFAULT_RING.model).toContain("model.fillet");
    off();
  });

  it("the toolbar has Revolve and a Modify menu", () => {
    render(<><Toolbar /><FeatureToolPanel /></>);
    fireEvent.click(screen.getByRole("button", { name: /Modify/ }));
    const menu = screen.getByRole("menu", { name: "Modify" });
    expect(within(menu).getAllByRole("menuitem").map((b) => b.querySelector("b")!.textContent)).toEqual(["Fillet edges", "Chamfer edges", "Shell", "Pattern"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Shell/ }));
    expect(screen.getByRole("dialog", { name: "Shell" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revolve" }));
    expect(screen.getByRole("dialog", { name: "Revolve" })).toBeTruthy();
  });
});

describe("Revolve", () => {
  it("defaults to the sketch's construction line, lists world axes in its plane, and commits a revolve", async () => {
    act(() => useStore.getState().openFeatureTool("revolve"));
    render(<FeatureToolPanel />);
    const panel = screen.getByRole("dialog", { name: "Revolve" });
    expect((within(panel).getByRole("combobox", { name: "Profile" }) as HTMLSelectElement).selectedOptions[0].textContent).toBe("Sketch 1 · XZ");
    const axis = within(panel).getByRole("combobox", { name: "Axis" }) as HTMLSelectElement;
    expect(axis.value).toBe(`line:${line}`);
    expect([...axis.options].find((o) => o.value === "world:Y")!.disabled).toBe(true);
    fireEvent.change(within(panel).getByRole("textbox", { name: "Angle (degrees)" }), { target: { value: "270" } });
    await act(async () => { fireEvent.click(within(panel).getByRole("button", { name: "Revolve" })); });
    await waitFor(() => expect(useStore.getState().featureTool).toBeNull());
    const rev = Object.values(s.doc.features).find((f) => f.kind === "revolve") as { id: string; axisLine?: string; angleExpr: string };
    expect(rev.axisLine).toBe(line);
    expect(rev.angleExpr).toBe("270");
    expect(useUi.getState().openFeature).toBe(rev.id);
  });
});

describe("Shell", () => {
  it("takes the clicked faces (a second click drops one) and opens them", async () => {
    act(() => useStore.getState().openFeatureTool("shell"));
    render(<FeatureToolPanel />);
    const panel = screen.getByRole("dialog", { name: "Shell" });
    expect(within(panel).getByRole("button", { name: "Shell" })).toHaveProperty("disabled", true);
    const p = { x: 60, y: 0, z: 20 }, n = { x: 0, y: 0, z: 1 };
    act(() => { useStore.getState().toolPickFace(p, n, boxId, `${boxId}:+Z`); useStore.getState().toolPickFace(p, n, boxId, `${boxId}:-Y`); });
    expect(panel.textContent).toMatch(/2 faces/);
    act(() => useStore.getState().toolPickFace(p, n, boxId, `${boxId}:-Y`));
    expect(panel.textContent).toMatch(/Open1 face(?!s)/);
    await act(async () => { fireEvent.click(within(panel).getByRole("button", { name: "Shell" })); });
    const shell = Object.values(s.doc.features).find((f) => f.kind === "shell") as { openFaces: { names?: string[] }; body?: string };
    expect(shell.openFaces).toEqual({ names: [`${boxId}:+Z`] });
    expect(shell.body).toBe(boxId);
  });
});

describe("edge-pick Fillet", () => {
  it("collects picked edges by name and commits a fillet of exactly those", async () => {
    act(() => useStore.getState().openFeatureTool("edges", "fillet"));
    render(<FeatureToolPanel />);
    const panel = screen.getByRole("dialog", { name: "Fillet edges" });
    act(() => { useStore.getState().toolPickEdge(boxId, "a|b"); useStore.getState().toolPickEdge(boxId, "b|c"); });
    expect(panel.textContent).toMatch(/2 on Block/);
    fireEvent.change(within(panel).getByRole("textbox", { name: "Radius" }), { target: { value: "3" } });
    await act(async () => { fireEvent.click(within(panel).getByRole("button", { name: "Fillet" })); });
    const fil = Object.values(s.doc.features).find((f) => f.kind === "fillet") as { edges: { names?: string[] }; sizeExpr: string };
    expect(fil.edges).toEqual({ names: ["a|b", "b|c"] });
    expect(fil.sizeExpr).toBe("3");
  });

  it("refuses a size that names no parameter, and Escape closes the panel", async () => {
    const off = installHotkeys();
    act(() => useStore.getState().openFeatureTool("edges", "chamfer"));
    act(() => useStore.getState().toolPickEdge(boxId, "a|b"));
    act(() => useStore.getState().patchFeatureTool({ size: "nope" }));
    await act(async () => { await useStore.getState().commitFeatureTool(); });
    expect(useStore.getState().toast?.text).toMatch(/^Distance: No parameter called nope/);
    expect(useStore.getState().featureTool).not.toBeNull();
    act(() => { hotkeys.runAction("edit.cancel"); });
    expect(useStore.getState().featureTool).toBeNull();
    off();
  });
});

describe("Pattern", () => {
  it("starts with the body's width plus a gap, and commits a linear pattern", async () => {
    act(() => useStore.getState().openFeatureTool("pattern"));
    render(<FeatureToolPanel />);
    const panel = screen.getByRole("dialog", { name: "Pattern" });
    expect((within(panel).getByRole("textbox", { name: "Spacing" }) as HTMLInputElement).value).toBe("45");
    await act(async () => { fireEvent.click(within(panel).getByRole("button", { name: "Pattern" })); });
    const pat = Object.values(s.doc.features).find((f) => f.kind === "pattern") as { mode: string; count: number; step: { x: number } };
    expect(pat.mode).toBe("linear");
    expect(pat.count).toBe(3);
    expect(pat.step.x).toBe(45);
  });
});
