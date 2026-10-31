import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { realSession } from "../helpers";
import type { CadSession } from "../../src/core/command/session";
import { useStore } from "../../src/model/store";
import { useUi } from "../../src/model/concepts/uiState";
import { hotkeys } from "../../src/model/hotkeys";
import { installHotkeys } from "../../src/model/hotkeyActions";
import { DEFAULT_RING } from "../../src/model/ring";
import { CONTEXTS } from "../../src/model/contexts";
import { featureRows, type FeatureRow } from "../../src/model/concepts/featureCatalog";
import { installContextActions } from "../../src/ui/concepts/contextActions";
import { useLens, DEFAULT_LENS } from "../../src/ui/concepts/lens/lens";
import { IntentLine } from "../../src/ui/concepts/intent";

let s: CadSession;
let rows: FeatureRow[];
let extrudeId: string;
let compId: string;

beforeAll(async () => {
  s = realSession();
  await s.dispatch("parameter.add", { name: "h", expression: "12" });
  const sk = await s.dispatch("sketch.create", { plane: "XY" });
  const sid = sk.createdIds[0];
  await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 0, y: 0 }, opposite: { x: 40, y: 20 } });
  extrudeId = (await s.dispatch("feature.extrude", { sketch: sid, distance: "h*2", name: "Base" })).createdIds[0];
  await s.dispatch("feature.fillet", { radius: "1.5", name: "Edges" });
  compId = (await s.dispatch("component.create", { name: "Outer ring" })).createdIds[0];
  const sk2 = await s.dispatch("sketch.create", { plane: "XY", component: compId });
  await s.dispatch("sketch.addRectangle", { sketch: sk2.createdIds[0], corner: { x: -100, y: 0 }, opposite: { x: -60, y: 20 } });
  await s.dispatch("feature.extrude", { sketch: sk2.createdIds[0], distance: "24" });
  installHotkeys();
  installContextActions();
});

const actions = () => ({
  editOperation: vi.fn(() => Promise.resolve()),
  moveRollback: vi.fn(() => Promise.resolve()),
  suppressOperation: vi.fn(() => Promise.resolve()),
  deleteOperation: vi.fn(() => Promise.resolve()),
  activateComponent: vi.fn(),
  startSketchOnFace: vi.fn(() => Promise.resolve()),
  startFaceExtrude: vi.fn(() => Promise.resolve()),
  openExtrude: vi.fn(),
  createComponent: vi.fn(() => Promise.resolve(null)),
});
let a: ReturnType<typeof actions>;

const face = { bodyId: "", faceName: "", point: { x: 20, y: 10, z: 24 }, normal: { x: 0, y: 0, z: 1 }, screen: { x: 300, y: 200 } };
const key = (k: string, mods: { shiftKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => fireEvent.keyDown(window, { key: k, ...mods });

beforeEach(async () => {
  await s.moveRollback(s.timeline.length);
  a = actions();
  useStore.setState({
    session: s, rev: 1, solids: {}, mode: "model", faceSelection: null, activeComponentId: s.doc.rootComponentId,
    contextMenu: null, extrudeActive: false, sketchPlacing: false, constraintTool: null, kernelLoading: false, ...a,
  } as never);
  useUi.setState({ openFeature: null, hotFeature: null, hotParam: null, panels: { ...useUi.getState().panels, workbench: true, lens: false } });
  useLens.setState(DEFAULT_LENS);
  rows = featureRows(s.doc, s.timeline, s.rollbackIndex, {});
  face.bodyId = extrudeId;
  face.faceName = `${extrudeId}:end`;
});

describe("registry", () => {
  it("registers every action the default ring holds, with no key bound twice in one context", () => {
    render(<IntentLine />); // intent.open belongs to the mounted intent line
    const missing = CONTEXTS.flatMap((c) => DEFAULT_RING[c].filter((id): id is string => !!id && !hotkeys.info(id)));
    expect(missing).toEqual([]);
    expect(hotkeys.conflicts()).toEqual([]);
    expect(hotkeys.info("face.push")).toEqual({ label: "Push face out", context: "face" });
    expect(hotkeys.primary("view.lens")).toBe("shift+l");
  });
});

describe("face", () => {
  it("is on the stack with a face selected, and its keys win over the model's", () => {
    expect(hotkeys.can("face.push")).toBe(false);
    useStore.setState({ faceSelection: face });
    expect(hotkeys.getContexts()).toEqual(["global", "model", "face"]);
    expect(hotkeys.can("face.push")).toBe(true);
    key("s");
    expect(a.startSketchOnFace).toHaveBeenCalledWith(face.point, face.normal);
    expect(useStore.getState().sketchPlacing).toBe(false);
    key("e");
    expect(a.startFaceExtrude).toHaveBeenCalledWith(face.point, face.normal);
    expect(a.openExtrude).not.toHaveBeenCalled();
  });

  it("pushes and pulls the face's feature by its step through editOperation", async () => {
    useStore.setState({ faceSelection: face });
    key("=");
    expect(a.editOperation).toHaveBeenCalledTimes(1);
    expect(a.editOperation.mock.calls[0]).toEqual([rows[0].opId, expect.objectContaining({ distance: "24.5", sketch: rows[0].op.params.sketch })]);
    await Promise.resolve();
    key("-");
    await vi.waitFor(() => expect(a.editOperation).toHaveBeenCalledTimes(2));
    expect((a.editOperation.mock.calls[1] as unknown[])[1]).toMatchObject({ distance: "23.5" });
  });

  it("looks at the face and opens its feature", () => {
    const lookAt = vi.fn();
    window.addEventListener("chisel:lookAt", lookAt);
    useStore.setState({ faceSelection: face });
    key("f");
    expect((lookAt.mock.calls[0][0] as CustomEvent).detail).toEqual({ point: face.point, normal: face.normal });
    window.removeEventListener("chisel:lookAt", lookAt);
    key("Enter");
    expect(useUi.getState().openFeature).toBe(extrudeId);
  });

  it("is gone in sketch mode", () => {
    useStore.setState({ faceSelection: face, mode: "sketch" });
    expect(hotkeys.can("face.lookAt")).toBe(false);
    expect(hotkeys.runAction("face.lookAt")).toBe(false);
  });
});

describe("escape", () => {
  it("closes the face verbs, then the feature card, most specific first", () => {
    const cancel = vi.fn();
    window.addEventListener("chisel:cancel", cancel);
    useStore.setState({ faceSelection: face });
    useUi.setState({ openFeature: extrudeId });
    key("Escape");
    expect(useStore.getState().faceSelection).toBeNull();
    expect(useUi.getState().openFeature).toBe(extrudeId);
    key("Escape");
    expect(useUi.getState().openFeature).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
    key("Escape");
    expect(cancel).toHaveBeenCalledTimes(1);
    window.removeEventListener("chisel:cancel", cancel);
  });
});

describe("feature card", () => {
  it("cycles through the rows in scope, wrapping", () => {
    expect(hotkeys.can("feature.next")).toBe(false);
    useUi.setState({ openFeature: rows[0].featureId });
    expect(hotkeys.getContexts()).toEqual(["global", "model", "feature"]);
    key(".");
    expect(useUi.getState().openFeature).toBe(rows[1].featureId);
    key(",");
    key(",");
    expect(useUi.getState().openFeature).toBe(rows[rows.length - 1].featureId);
    // inside a component the cycle stays in its scope
    useStore.setState({ activeComponentId: compId });
    key(".");
    expect(useUi.getState().openFeature).toBe(rows[2].featureId);
  });

  it("rolls back to, suppresses and deletes the open feature (asking first)", () => {
    useUi.setState({ openFeature: rows[1].featureId });
    key("r");
    expect(a.moveRollback).toHaveBeenCalledWith(rows[1].index);
    key("h");
    expect(a.suppressOperation).toHaveBeenCalledWith(rows[1].opId, true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    key("Delete");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(a.deleteOperation).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    key("Backspace");
    expect(a.deleteOperation).toHaveBeenCalledWith(rows[1].opId);
    expect(useUi.getState().openFeature).toBeNull();
    confirm.mockRestore();
  });

  it("needs the workbench panel (the card shows only with it)", () => {
    useUi.setState({ openFeature: rows[0].featureId, panels: { ...useUi.getState().panels, workbench: false } });
    expect(hotkeys.can("feature.rollTo")).toBe(false);
  });
});

describe("lens", () => {
  it("switches modes, shape and size while the lens is on", () => {
    expect(hotkeys.can("lens.zebra")).toBe(false);
    key("L", { shiftKey: true });
    expect(useUi.getState().panels.lens).toBe(true);
    expect(hotkeys.getContexts()).toContain("lens");
    key("3");
    expect(useLens.getState().mode).toBe("curvature");
    key("5");
    expect(useLens.getState().mode).toBe("overhang");
    key("w");
    expect(useLens.getState().shape).toBe("wipe");
    expect(hotkeys.runAction("lens.size")).toBe(true);
    expect(useLens.getState().size).toBe("L");
  });
});

describe("component", () => {
  it("goes up to the parent and back to the root", () => {
    expect(hotkeys.can("component.up")).toBe(false);
    useStore.setState({ activeComponentId: compId });
    expect(hotkeys.getContexts()).toEqual(["global", "model", "component"]);
    key("ArrowUp", { altKey: true });
    expect(a.activateComponent).toHaveBeenCalledWith(s.doc.rootComponentId);
    expect(hotkeys.runAction("component.root")).toBe(true);
    expect(a.activateComponent).toHaveBeenCalledTimes(2);
  });
});

describe("model", () => {
  it("starts a sketch, extrudes, and steps the history over the strip's stops", async () => {
    key("s");
    expect(useStore.getState().sketchPlacing).toBe(true);
    expect(hotkeys.can("model.sketch")).toBe(false);
    key("e");
    expect(a.openExtrude).toHaveBeenCalledTimes(1);
    // at the end: nothing forward; back lands just after the last entry before it (the component step at the root)
    expect(hotkeys.can("history.forward")).toBe(false);
    expect(hotkeys.can("history.end")).toBe(false);
    key("[");
    const back = s.timeline.findIndex((op) => op.type === "component.create") + 1;
    expect(a.moveRollback).toHaveBeenLastCalledWith(back);
    await s.moveRollback(back);
    useStore.setState({ rev: 2 });
    key("]");
    expect(a.moveRollback).toHaveBeenLastCalledWith(s.timeline.length);
    key("}", { shiftKey: true });
    expect(a.moveRollback).toHaveBeenCalledTimes(3);
    expect(a.moveRollback).toHaveBeenLastCalledWith(s.timeline.length);
  });

  it("finishes a sketch with mod+enter", () => {
    useStore.setState({ mode: "sketch", activeSketchId: "x" } as never);
    expect(hotkeys.getContexts()).toEqual(["global", "sketch"]);
    key("Enter", { metaKey: true });
    expect(useStore.getState().mode).toBe("model");
  });
});
