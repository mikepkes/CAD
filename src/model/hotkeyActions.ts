// Registers the app's hotkey actions with the HotkeyManager and keeps the
// active context stack in sync with the app (contexts.ts says which contexts
// stack when). Each action declares the context it lives in; e.g. "sketch"
// stacks on top of "global" while a sketch is open, so "f" resolves to Look At
// there and Frame otherwise. The focus contexts' actions (face, feature card,
// lens, component) and the history steps read the concept modules, so they
// are registered by src/ui/concepts/contextActions.ts, mounted beside this.

import { hotkeys, HotkeyAction } from "./hotkeys";
import { useStore, Tool } from "./store";
import { useUi, PANEL_NAMES } from "./concepts/uiState";
import { contextStack, ContextInput } from "./contexts";
import { useRing, RING_ACTION_ID } from "./ring";
import { hasFlexures } from "../sim/flexure";
import { drivesOf } from "./concepts/mechanism";
import { useMechanism } from "./concepts/mechanismStore";
import { driveParams } from "./motionStudy";

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

/** Open the left panel and bring the configurations table into view, lit for a moment. */
function showConfigurations() {
  useUi.getState().setSideOpen("left", true);
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(".config-table");
    if (!el) return;
    el.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1200);
  });
}

const ACTIONS: HotkeyAction[] = [
  // ---- global ----
  { id: "view.frame", label: "Frame selection / fit", context: "global", defaultPrimary: "f", run: () => fire("vibecad:frame") },
  { id: "help.shortcuts", label: "Keyboard shortcuts", context: "global", defaultPrimary: "shift+?", defaultSecondary: "?", run: () => st().setHotkeysOpen(!st().hotkeysOpen) },
  ...(["iso", "front", "top", "right", "back", "left", "bottom"] as const).map((v) => ({
    id: `view.${v}`, label: `View: ${v[0].toUpperCase()}${v.slice(1)}`, context: "global", run: () => window.dispatchEvent(new CustomEvent("vibecad:view", { detail: v })),
  })),
  // concept panels, named as on their switches (toggle; a lit one whose tab is hidden comes forward first;
  // unbound by default, bindable in the Hotkeys panel)
  { id: "view.workbench", label: `Toggle ${PANEL_NAMES.workbench} (feature pins and the history strip)`, context: "global", run: () => useUi.getState().togglePanel("workbench") },
  { id: "view.lens", label: `Toggle ${PANEL_NAMES.lens}`, context: "global", defaultPrimary: "shift+l", run: () => useUi.getState().togglePanel("lens") },
  { id: "view.ledger", label: `Toggle ${PANEL_NAMES.ledger}`, context: "global", run: () => useUi.getState().togglePanel("ledger") },
  { id: "view.space", label: `Toggle ${PANEL_NAMES.space}`, context: "global", run: () => useUi.getState().togglePanel("space") },
  { id: "view.materials", label: `Toggle ${PANEL_NAMES.materials}`, context: "global", run: () => useUi.getState().togglePanel("materials") },
  { id: "view.mechanism", label: `Toggle ${PANEL_NAMES.mechanism}`, context: "global", run: () => useUi.getState().togglePanel("mechanism") },
  { id: "view.notes", label: `Toggle ${PANEL_NAMES.notes}`, context: "global", run: () => useUi.getState().togglePanel("notes") },
  {
    id: "mechanism.sweep", label: "Sweep the mechanism's drive", context: "model",
    when: () => hasFlexures(st().session.doc) && drivesOf(st().session.doc).length > 0,
    run: () => { const m = useMechanism.getState(); if (m.sweeping) m.stopSweep(); else void m.sweep(); },
  },
  // the app's own commands, so the ring, a key and ⌘K reach them too
  { id: "view.section", label: "Section: cut the model on a plane", context: "global", when: () => Object.keys(st().solids).length > 0,
    run: () => { const s = st(); s.setSection(s.section ? null : { plane: "XY", offset: 0, flip: false }); } },
  { id: "app.agent", label: "Agent: describe it to Claude", context: "global", run: () => st().toggleAgent() },
  { id: "app.settings", label: "Settings", context: "global", run: () => st().setSettingsOpen(true) },
  { id: "view.configurations", label: "Configurations: the design variants table", context: "global", run: () => showConfigurations() },
  {
    id: "motion.study", label: "Motion study (do the joints move through their range without collisions?)", context: "model",
    when: () => driveParams(st().session.doc).length > 0,
    run: () => { if (st().motionStatus === "running") st().cancelMotionStudy(); else void st().runMotionStudy(); },
  },
  { id: RING_ACTION_ID, label: "Action ring (hold, point, release)", context: "global", defaultPrimary: "space", run: () => useRing.getState().openRing() },
  { id: "edit.undo", label: "Undo", context: "global", defaultPrimary: "mod+z", run: () => st().undo() },
  { id: "file.save", label: "Save to a file", context: "global", defaultPrimary: "mod+s", run: () => st().saveToFile() },
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
      if (s.featureTool) { s.closeFeatureTool(); return; }
      if (s.sketchPlacing) { s.setSketchPlacing(false); return; }
      if (s.constraintTool) { s.setConstraintTool(null); return; }
      if (s.faceSelection) { s.selectFace(null); return; }
      const ui = useUi.getState();
      if (ui.openFeature) { ui.setOpenFeature(null); return; }
      fire("vibecad:cancel");
    },
  },

  // ---- model (stacks on top of global; the history steps are in src/ui/concepts/contextActions.ts) ----
  { id: "model.sketch", label: "New sketch (pick a plane)", context: "model", defaultPrimary: "s", when: () => !st().sketchPlacing, run: () => st().setSketchPlacing(true) },
  { id: "model.extrude", label: "Extrude", context: "model", defaultPrimary: "e", when: canExtrude, run: () => st().openExtrude() },
  { id: "model.component", label: "New component", context: "model", run: () => void st().createComponent() },
  { id: "model.revolve", label: "Revolve", context: "model", when: () => !st().kernelLoading, run: () => st().openFeatureTool("revolve") },
  { id: "model.fillet", label: "Fillet edges", context: "model", when: () => hasSolid() && !st().kernelLoading, run: () => st().openFeatureTool("edges", "fillet") },
  { id: "model.chamfer", label: "Chamfer edges", context: "model", when: () => hasSolid() && !st().kernelLoading, run: () => st().openFeatureTool("edges", "chamfer") },
  { id: "model.shell", label: "Shell", context: "model", when: () => hasSolid() && !st().kernelLoading, run: () => st().openFeatureTool("shell") },
  { id: "model.pattern", label: "Pattern", context: "model", when: () => hasSolid() && !st().kernelLoading, run: () => st().openFeatureTool("pattern") },
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
  { id: "sketch.lookAt", label: "Look at sketch plane", context: "sketch", defaultPrimary: "f", run: () => fire("vibecad:lookAt") },
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
