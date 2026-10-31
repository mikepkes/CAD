// Registers the app's hotkey actions with the HotkeyManager and keeps the
// active context stack in sync with the app (contexts.ts says which contexts
// stack when). Each action declares the context it lives in; e.g. "sketch"
// stacks on top of "global" while a sketch is open, so "f" resolves to Look At
// there and Frame otherwise. The focus contexts' actions (face, feature card,
// lens, component) and the history steps read the concept modules, so they
// are registered by src/ui/concepts/contextActions.ts, mounted beside this.

import { hotkeys, HotkeyAction } from "./hotkeys";
import { useStore, Tool } from "./store";
import { useUi } from "./concepts/uiState";
import { contextStack, ContextInput } from "./contexts";
import { useRing, RING_ACTION_ID } from "./ring";

const st = () => useStore.getState();
const fire = (name: string) => window.dispatchEvent(new CustomEvent(name));

const toolAction = (tool: Tool, label: string, key: string): HotkeyAction => ({
  id: `tool.${tool}`,
  label,
  context: "sketch",
  defaultPrimary: key,
  run: () => st().setTool(tool),
});

/** There is a sketch to extrude (the toolbar's Extrude button: the root's last sketch, the kernel loaded). */
const canExtrude = () => {
  const s = st(), root = s.session.doc.components[s.session.doc.rootComponentId];
  return !!root?.sketches.length && !s.kernelLoading;
};
/** Something is built (what export and projection need). */
const hasSolid = () => Object.keys(st().session.doc.features).length > 0;

const ACTIONS: HotkeyAction[] = [
  // ---- global ----
  { id: "view.frame", label: "Frame selection / fit", context: "global", defaultPrimary: "f", run: () => fire("chisel:frame") },
  ...(["iso", "front", "top", "right", "back", "left", "bottom"] as const).map((v) => ({
    id: `view.${v}`, label: `View: ${v[0].toUpperCase()}${v.slice(1)}`, context: "global", run: () => window.dispatchEvent(new CustomEvent("chisel:view", { detail: v })),
  })),
  // concept panels (toggle; unbound by default, bindable in the Hotkeys panel)
  { id: "view.workbench", label: "Toggle feature pins (Workbench)", context: "global", run: () => useUi.getState().togglePanel("workbench") },
  { id: "view.lens", label: "Toggle the lens", context: "global", defaultPrimary: "shift+l", run: () => useUi.getState().togglePanel("lens") },
  { id: "view.ledger", label: "Toggle the Ledger tab", context: "global", run: () => useUi.getState().togglePanel("ledger") },
  { id: "view.space", label: "Toggle the Design Space tab", context: "global", run: () => useUi.getState().togglePanel("space") },
  { id: RING_ACTION_ID, label: "Action ring (hold, point, release)", context: "global", defaultPrimary: "space", run: () => useRing.getState().openRing() },
  { id: "edit.undo", label: "Undo", context: "global", defaultPrimary: "mod+z", run: () => st().undo() },
  { id: "edit.redo", label: "Redo", context: "global", defaultPrimary: "mod+shift+z", defaultSecondary: "mod+y", run: () => st().redo() },
  {
    id: "edit.cancel",
    label: "Cancel / deselect",
    context: "global",
    defaultPrimary: "escape",
    run: () => {
      const s = st();
      if (s.contextMenu) { s.closeContextMenu(); return; }
      if (s.extrudeActive) { s.closeExtrude(); return; }
      if (s.sketchPlacing) { s.setSketchPlacing(false); return; }
      if (s.constraintTool) { s.setConstraintTool(null); return; }
      if (s.faceSelection) { s.selectFace(null); return; }
      const ui = useUi.getState();
      if (ui.openFeature) { ui.setOpenFeature(null); return; }
      fire("chisel:cancel");
    },
  },

  // ---- model (stacks on top of global; the history steps are in src/ui/concepts/contextActions.ts) ----
  { id: "model.sketch", label: "New sketch (pick a plane)", context: "model", defaultPrimary: "s", when: () => !st().sketchPlacing, run: () => st().setSketchPlacing(true) },
  { id: "model.extrude", label: "Extrude", context: "model", defaultPrimary: "e", when: canExtrude, run: () => st().openExtrude() },
  { id: "model.component", label: "New component", context: "model", run: () => void st().createComponent() },
  { id: "model.exportStep", label: "Export STEP", context: "model", when: hasSolid, run: () => void st().exportSolid("step") },
  { id: "model.exportStl", label: "Export STL", context: "model", when: hasSolid, run: () => void st().exportSolid("stl") },

  // ---- sketch (stacks on top of global) ----
  toolAction("select", "Select tool", "s"),
  toolAction("line", "Line tool", "l"),
  toolAction("rectangle", "Rectangle tool", "r"),
  toolAction("circle", "Circle tool", "c"),
  toolAction("arc", "Arc tool", "a"),
  toolAction("polygon", "Polygon tool", "g"),
  toolAction("slot", "Slot tool", "o"),
  toolAction("ellipse", "Ellipse tool", "i"),
  toolAction("point", "Point tool", "p"),
  toolAction("dimension", "Dimension tool", "d"),
  toolAction("trim", "Trim tool", "t"),
  toolAction("extend", "Extend tool", "e"),
  { id: "sketch.finish", label: "Finish sketch", context: "sketch", defaultPrimary: "mod+enter", run: () => st().finishSketch() },
  { id: "sketch.project", label: "Project bodies", context: "sketch", when: hasSolid, run: () => void st().projectBodies(false) },
  { id: "sketch.construction", label: "Toggle construction", context: "sketch", defaultPrimary: "x", run: () => st().toggleConstruction() },
  { id: "sketch.lookAt", label: "Look at sketch plane", context: "sketch", defaultPrimary: "f", run: () => fire("chisel:lookAt") },
  {
    id: "sketch.delete",
    label: "Delete selection",
    context: "sketch",
    defaultPrimary: "delete",
    defaultSecondary: "backspace",
    when: () => st().selection.length > 0,
    run: () => st().deleteSelected(),
  },
];

/** What contextStack needs, read from the store and useUi. */
export function contextInput(): ContextInput {
  const s = st(), ui = useUi.getState();
  return {
    mode: s.mode,
    face: !!s.faceSelection,
    feature: !!ui.openFeature && ui.panels.workbench,
    lens: ui.panels.lens,
    component: s.activeComponentId !== s.session.doc.rootComponentId,
  };
}

let installed = false;

/** Register all actions, attach the key listener, and track the context stack. */
export function installHotkeys(): () => void {
  if (installed) return () => {};
  installed = true;
  const offActions = hotkeys.registerAll(ACTIONS);
  const offKeys = hotkeys.attach(window);

  // The context stack follows the store (mode, face, component) and useUi (open feature, lens).
  let last = "";
  const sync = () => {
    const stack = contextStack(contextInput());
    const key = stack.join(">");
    if (key !== last) { last = key; hotkeys.setContexts(stack); }
  };
  sync();
  const offStore = (() => {
    const a = useStore.subscribe(sync), b = useUi.subscribe(sync);
    return () => { a(); b(); };
  })();

  return () => { offActions(); offKeys(); offStore(); installed = false; };
}
