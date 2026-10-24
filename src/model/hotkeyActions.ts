// Registers the app's hotkey actions with the HotkeyManager and keeps the
// active context stack in sync with the app mode. Each action declares the
// context it lives in; the "sketch" context stacks on top of "global" while a
// sketch is open, so e.g. "f" resolves to Look At there and Frame otherwise.

import { hotkeys, HotkeyAction } from "../core/hotkeys";
import { useStore, Tool } from "./store";

const st = () => useStore.getState();
const fire = (name: string) => window.dispatchEvent(new CustomEvent(name));

const toolAction = (tool: Tool, label: string, key: string): HotkeyAction => ({
  id: `tool.${tool}`,
  label,
  context: "sketch",
  defaultPrimary: key,
  run: () => st().setTool(tool),
});

const ACTIONS: HotkeyAction[] = [
  // ---- global ----
  { id: "view.frame", label: "Frame selection / fit", context: "global", defaultPrimary: "f", run: () => fire("chisel:frame") },
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
      fire("chisel:cancel");
    },
  },

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

let installed = false;

/** Register all actions, attach the key listener, and track the context stack. */
export function installHotkeys(): () => void {
  if (installed) return () => {};
  installed = true;
  const offActions = hotkeys.registerAll(ACTIONS);
  const offKeys = hotkeys.attach(window);

  const syncContexts = (mode: string) => hotkeys.setContexts(mode === "sketch" ? ["global", "sketch"] : ["global"]);
  syncContexts(st().mode);
  let lastMode = st().mode;
  const offStore = useStore.subscribe((s) => {
    if (s.mode !== lastMode) { lastMode = s.mode; syncContexts(s.mode); }
  });

  return () => { offActions(); offKeys(); offStore(); installed = false; };
}
