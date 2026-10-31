// The hotkey actions of the focus contexts (face, feature card, lens,
// component) and the model's history steps: registered with the HotkeyManager
// like every other action, so a key, the action ring, the intent line and a
// 3D-mouse button all reach them through `hotkeys.runAction`. Each ends in the
// same store / useUi / useLens call the matching button makes, and shares that
// button's code (pushEdit, lookAtFace, deleteFeature). Each has a `when` that
// says whether it can run now, so `hotkeys.can()` (the ring's greyed slots) is
// honest. Decisions live in contextActions.logic.ts.

import { hotkeys, type HotkeyAction } from "../../model/hotkeys";
import { useStore, type FaceSelection } from "../../model/store";
import { useUi } from "../../model/concepts/uiState";
import { featureRows, type FeatureRow } from "../../model/concepts/featureCatalog";
import { createEditQueue } from "../kit/editQueue";
import { pushEdit, rowForFace, shouldDelete } from "./workbench/workbench";
import { useLens, MODES, type LensMode } from "./lens/lens";
import { cycleFeature, cycleRows, historyRange, nextLensSize, otherShape, parentComponent, stepRollback } from "./contextActions.logic";

const st = () => useStore.getState();
const ui = () => useUi.getState();

// ---- what the actions read ----

let memo: { key: unknown[]; rows: FeatureRow[] } | null = null;

/** The catalog's rows for the current store state (what useFeatureRows gives a component), cached until it changes:
 *  the ring asks `can` of every slot on each render. */
function rows(): FeatureRow[] {
  const s = st();
  const key = [s.session, s.rev, s.solids, s.session.doc, s.session.timeline.length, s.session.rollbackIndex];
  if (!memo || memo.key.some((k, i) => k !== key[i])) {
    memo = { key, rows: featureRows(s.session.doc, s.session.timeline, s.session.rollbackIndex, s.solids) };
  }
  return memo.rows;
}

const active = () => st().activeComponentId || st().session.doc.rootComponentId;

/** The face the verbs show, in model mode. */
function face(): FaceSelection | null {
  const s = st();
  return s.mode === "model" && s.faceSelection ? s.faceSelection : null;
}
const faceRow = (): FeatureRow | undefined => { const f = face(); return f ? rowForFace(rows(), f.faceName, f.bodyId) : undefined; };

/** The open feature card's row (the card shows only with the workbench panel on, in model mode). */
function openRow(): FeatureRow | undefined {
  const u = ui();
  if (!u.openFeature || !u.panels.workbench || st().mode !== "model") return undefined;
  return rows().find((r) => r.featureId === u.openFeature);
}

const cycleIds = () => cycleRows(rows(), st().session.doc, active()).map((r) => r.featureId);

const range = () => { const s = st(); return historyRange(rows(), s.session.doc, active(), s.session.timeline, s.session.rollbackIndex); };
const historyStep = (dir: -1 | 1) => (st().mode === "model" ? stepRollback(range(), st().session.rollbackIndex, dir) : null);

const lensOn = () => ui().panels.lens && st().mode === "model";

// ---- the shared verbs (the buttons call these too) ----

/** Orient the view to a face (the face verbs' "Look at"). */
export function lookAtFace(sel: Pick<FaceSelection, "point" | "normal">): void {
  window.dispatchEvent(new CustomEvent("chisel:lookAt", { detail: { point: sel.point, normal: sel.normal } }));
}

/** Delete a feature after asking (the feature card's Delete): closes its card first. Returns whether it was deleted. */
export function deleteFeature(row: Pick<FeatureRow, "name" | "opId">): boolean {
  if (!shouldDelete(row, typeof confirm === "function" ? confirm : undefined)) return false;
  ui().setOpenFeature(null);
  void st().deleteOperation(row.opId);
  return true;
}

/** Push/Pull steps from the keyboard: one edit in flight, each computed from the rows when it is sent, so a held
 *  key steps once per rebuild rather than queueing stale values. */
const pushQueue = createEditQueue<-1 | 1>((dir) => {
  const e = pushEdit(faceRow(), dir);
  return e ? st().editOperation(e.opId, e.params) : undefined;
}, (dir) => String(dir));

// ---- the actions ----

const lensMode = (mode: LensMode, key: string): HotkeyAction => ({
  id: `lens.${mode}`,
  label: `Lens: ${MODES.find((m) => m.key === mode)?.label ?? mode}`,
  context: "lens",
  defaultPrimary: key,
  when: lensOn,
  run: () => useLens.getState().setMode(mode),
});

export const CONTEXT_ACTIONS: HotkeyAction[] = [
  // ---- model: the history, stepped over the strip's stops ----
  {
    id: "history.back", label: "Roll back one step", context: "model", defaultPrimary: "[",
    when: () => historyStep(-1) != null,
    run: () => { const i = historyStep(-1); if (i != null) void st().moveRollback(i); },
  },
  {
    id: "history.forward", label: "Roll forward one step", context: "model", defaultPrimary: "]",
    when: () => historyStep(1) != null,
    run: () => { const i = historyStep(1); if (i != null) void st().moveRollback(i); },
  },
  {
    // "shift+}" is what a US layout reports for shift+]
    id: "history.end", label: "Roll to end", context: "model", defaultPrimary: "shift+]", defaultSecondary: "shift+}",
    when: () => st().mode === "model" && st().session.rollbackIndex < st().session.timeline.length,
    run: () => void st().moveRollback(st().session.timeline.length),
  },

  // ---- face (a face selected in model mode) ----
  {
    id: "face.sketch", label: "Sketch on this face", context: "face", defaultPrimary: "s",
    when: () => !!face(),
    run: () => { const f = face(); if (f) void st().startSketchOnFace(f.point, f.normal); },
  },
  {
    id: "face.extrude", label: "Extrude from this face", context: "face", defaultPrimary: "e",
    when: () => !!face() && !st().kernelLoading,
    run: () => { const f = face(); if (f) void st().startFaceExtrude(f.point, f.normal); },
  },
  {
    id: "face.push", label: "Push face out", context: "face", defaultPrimary: "=",
    when: () => !!pushEdit(faceRow(), 1),
    run: () => pushQueue.live(1),
  },
  {
    id: "face.pull", label: "Pull face in", context: "face", defaultPrimary: "-",
    when: () => !!pushEdit(faceRow(), -1),
    run: () => pushQueue.live(-1),
  },
  {
    id: "face.lookAt", label: "Look at face", context: "face", defaultPrimary: "f",
    when: () => !!face(),
    run: () => { const f = face(); if (f) lookAtFace(f); },
  },
  {
    id: "face.feature", label: "Open this face's feature", context: "face", defaultPrimary: "enter",
    when: () => !!faceRow(),
    run: () => {
      const row = faceRow();
      if (!row) return;
      if (!ui().panels.workbench) ui().togglePanel("workbench", true); // the card lives in the workbench overlay
      ui().setOpenFeature(row.featureId);
    },
  },

  // ---- feature (a feature card open) ----
  {
    id: "feature.next", label: "Next feature", context: "feature", defaultPrimary: ".",
    when: () => !!openRow() && cycleIds().length > 0,
    run: () => { const id = cycleFeature(cycleIds(), ui().openFeature, 1); if (id) ui().setOpenFeature(id); },
  },
  {
    id: "feature.prev", label: "Previous feature", context: "feature", defaultPrimary: ",",
    when: () => !!openRow() && cycleIds().length > 0,
    run: () => { const id = cycleFeature(cycleIds(), ui().openFeature, -1); if (id) ui().setOpenFeature(id); },
  },
  {
    id: "feature.rollTo", label: "Roll back to here", context: "feature", defaultPrimary: "r",
    when: () => !!openRow(),
    run: () => { const row = openRow(); if (row) void st().moveRollback(row.index); },
  },
  {
    id: "feature.suppress", label: "Suppress / unsuppress", context: "feature", defaultPrimary: "h",
    when: () => !!openRow(),
    run: () => { const row = openRow(); if (row) void st().suppressOperation(row.opId, !row.suppressed); },
  },
  {
    id: "feature.delete", label: "Delete feature", context: "feature", defaultPrimary: "delete", defaultSecondary: "backspace",
    when: () => !!openRow(),
    run: () => { const row = openRow(); if (row) deleteFeature(row); },
  },

  // ---- lens (the lens panel on) ----
  lensMode("zebra", "1"),
  lensMode("draft", "2"),
  lensMode("curvature", "3"),
  lensMode("xray", "4"),
  lensMode("overhang", "5"),
  {
    id: "lens.shape", label: "Lens / wipe", context: "lens", defaultPrimary: "w",
    when: lensOn,
    run: () => { const l = useLens.getState(); l.setShape(otherShape(l.shape)); },
  },
  {
    id: "lens.size", label: "Cycle lens size", context: "lens",
    when: lensOn,
    run: () => { const l = useLens.getState(); l.setSize(nextLensSize(l.size)); },
  },

  // ---- component (inside a non-root component) ----
  {
    id: "component.up", label: "Up to the parent component", context: "component", defaultPrimary: "alt+up",
    when: () => st().mode === "model" && parentComponent(st().session.doc, active()) != null,
    run: () => { const p = parentComponent(st().session.doc, active()); if (p) st().activateComponent(p); },
  },
  {
    id: "component.root", label: "Back to the root component", context: "component",
    when: () => st().mode === "model" && active() !== st().session.doc.rootComponentId,
    run: () => st().activateComponent(st().session.doc.rootComponentId),
  },
];

let installed = false;

/** Register the context actions (App mounts this next to installHotkeys). */
export function installContextActions(): () => void {
  if (installed) return () => {};
  installed = true;
  const off = hotkeys.registerAll(CONTEXT_ACTIONS);
  return () => { off(); installed = false; };
}
