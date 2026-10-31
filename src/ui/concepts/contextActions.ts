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
import { pushEdit, rowForFace, shouldDelete, namedParam, paramNameProblem, suggestParamName, type CardParam, type PushEdit } from "./workbench/workbench";
import { useLens, MODES, type LensMode } from "./lens/lens";
import { cycleFeature, cycleRows, faceEdgeSelector, historyRange, newSolidCentre, nextLensSize, otherShape, parentComponent, stepRollback } from "./contextActions.logic";
import { ask, askText } from "../kit/askDialog";

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
/** The document's parameter names (a number that is one of them is a dial: Push/Pull moves the parameter). */
const paramNames = () => st().session.doc.parameters.map((p) => p.name);
/** The Push/Pull step for the selected face: face-aware on a box or cylinder, the parameter itself when the number is named. */
const facePush = (dir: -1 | 1) => pushEdit(faceRow(), dir, face()?.normal, paramNames());

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

/** Delete a feature after asking in the app (the feature card's Delete): closes its card first. Resolves to whether it was deleted. */
export async function deleteFeature(row: Pick<FeatureRow, "name" | "opId">): Promise<boolean> {
  if (!(await shouldDelete(row, (text) => ask({ title: "Delete feature", text, confirmLabel: "Delete", danger: true })))) return false;
  ui().setOpenFeature(null);
  void st().deleteOperation(row.opId);
  return true;
}

/** Send one Push/Pull edit: the op, or the named parameter it reads. */
export function applyPush(e: PushEdit): Promise<void> {
  return e.kind === "param" ? st().setParameterExpr(e.name, e.expr) : st().editOperation(e.opId, e.params);
}
export const pushKey = (e: PushEdit) => JSON.stringify(e);

/** Push/Pull steps from the keyboard: one edit in flight, each computed from the rows when it is sent, so a held
 *  key steps once per rebuild rather than queueing stale values. */
const pushQueue = createEditQueue<-1 | 1>((dir) => {
  const e = facePush(dir);
  return e ? applyPush(e) : undefined;
}, (dir) => String(dir));

/** Name a feature's number (the card's and the face verbs' "Name this number"): asks for a name, adds a parameter
 *  holding the number's current expression, and points the feature at it, so the number becomes a dial. */
export async function nameThisNumber(row: FeatureRow, p: CardParam): Promise<boolean> {
  const taken = paramNames();
  if (namedParam(p.expr, taken)) return false; // already a dial
  const name = await askText({
    title: "Name this number",
    text: `${row.name}: ${p.label} = ${p.expr}${p.unit ? ` ${p.unit}` : ""}. A named number is a parameter: change it once and everything using it follows.`,
    label: "Name", initial: suggestParamName(p.label, taken), confirmLabel: "Name it",
  });
  if (!name) return false;
  const problem = paramNameProblem(name, paramNames());
  if (problem) { st().setMessage(problem); return false; }
  const r = await st().dispatch("parameter.add", { name, expression: p.expr });
  if (!r.ok) return false;
  const op = st().session.timeline.find((o) => o.opId === row.opId);
  await st().editOperation(row.opId, { ...(op?.params ?? row.op.params), [p.key]: name });
  return true;
}

/** Add a box or cylinder (the toolbar's and the ring's Box / Cylinder): on the floor, beside anything already built,
 *  and open its card so its sizes are right there. */
export async function addPrimitive(shape: "box" | "cylinder"): Promise<void> {
  await st().ensureKernel();
  const built = Object.values(st().solids).flatMap((b) => (b.mesh && b.bounds ? [b.bounds] : []));
  const params = shape === "box"
    ? { shape, x: "40", y: "40", z: "20", at: newSolidCentre(built, 20, 20), name: "Box" }
    : { shape, radius: "10", height: "30", at: newSolidCentre(built, 10, 30), name: "Cylinder" };
  const r = await st().dispatch("feature.primitive", params);
  if (r.ok && r.createdIds[0]) {
    if (!ui().panels.workbench) ui().togglePanel("workbench", true);
    ui().setOpenFeature(r.createdIds[0]);
  }
}

/** Round (fillet) or bevel (chamfer) every edge around the selected flat face, then open the new feature's card so
 *  its size can be scrubbed or named. Faces square to an axis only (the edge selector names planes by axis). */
export async function edgeFace(kind: "fillet" | "chamfer"): Promise<void> {
  const f = face();
  const sel = f ? faceEdgeSelector(f.point, f.normal) : null;
  if (!f || !sel) return;
  const params = kind === "fillet"
    ? { radius: "2", edges: sel, body: f.bodyId, requireEffect: true }
    : { distance: "1", edges: sel, body: f.bodyId, requireEffect: true };
  const r = await st().dispatch(`feature.${kind}`, params);
  if (r.ok && r.createdIds[0]) {
    st().selectFace(null);
    if (!ui().panels.workbench) ui().togglePanel("workbench", true);
    ui().setOpenFeature(r.createdIds[0]);
  }
}
const canEdgeFace = () => { const f = face(); return !!f && !!faceEdgeSelector(f.point, f.normal) && !st().kernelLoading; };

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

  // ---- model: direct modelling ----
  { id: "model.box", label: "Add a box", context: "model", defaultPrimary: "b", when: () => st().mode === "model" && !st().kernelLoading, run: () => void addPrimitive("box") },
  { id: "model.cylinder", label: "Add a cylinder", context: "model", when: () => st().mode === "model" && !st().kernelLoading, run: () => void addPrimitive("cylinder") },

  // ---- face (a face selected in model mode) ----
  { id: "face.fillet", label: "Round this face's edges", context: "face", when: canEdgeFace, run: () => void edgeFace("fillet") },
  { id: "face.chamfer", label: "Chamfer this face's edges", context: "face", when: canEdgeFace, run: () => void edgeFace("chamfer") },
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
    when: () => !!facePush(1),
    run: () => pushQueue.live(1),
  },
  {
    id: "face.pull", label: "Pull face in", context: "face", defaultPrimary: "-",
    when: () => !!facePush(-1),
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
    run: () => { const row = openRow(); if (row) void deleteFeature(row); },
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
