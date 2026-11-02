// The Folds panel: a paper (base sheet) model's folds, authored by hand. The sheet's steps as groups, each fold a
// row (its line, angle, valley/mountain, operation, `with`, flip), the cuts, a "Folding: step N of M" slider on the
// progress parameter, and the planner's errors beside the step they name. Every edit is one feature.sheet.edit
// dispatch (one undo step; a fold slider's range kept in step with it is squashed into the same step). "New paper"
// makes a sheet from a preset size. Lives in the Inspector (model mode: the open or last sheet; sketch mode: the
// sheet of the sketch being edited, whose selected lines become folds and cuts).

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../model/store";
import { useUi } from "../model/concepts/uiState";
import type { SheetFeature, SheetFoldDef } from "../core/document";
import { editCommitter } from "./editCommitter";
import {
  FOLD_OPS, FoldOp, PAPER_PRESETS, addFolds, foldOp, foldsToParams, insertStep, isStepped, isValley, moveFold, plainParam,
  removeFold, splitFoldErrors, stepCount, stepGroups, toggleValley, uniqueName, withAngle, withOp,
} from "./foldsModel";
import "./folds.css";

const st = () => useStore.getState();
const toast = (text: string) => useStore.setState((s) => ({ rev: s.rev + 1, toast: { kind: "error", text } }));

/** Keep a plain fold parameter's slider range 0…M as the steps change; when it stood at the end (every step done),
 *  it stays at the end, so a new step shows folded. */
async function syncFoldRange(name: string, before: number, after: number): Promise<void> {
  const s = st().session;
  const p = s.doc.parameters.find((x) => x.name === name);
  if (!p || after < 1) return;
  const max = Math.max(1, after);
  const value = p.value >= before - 1e-9 ? after : Math.min(p.value, after);
  if (p.max === max && p.min === 0 && Math.abs(value - p.value) < 1e-9) return;
  const op = s.timeline.find((o) => o.type === "parameter.add" && o.params.name === name);
  if (op) await st().editOperation(op.opId, { ...op.params, min: 0, max, step: op.params.step ?? 0.01, expression: String(value) });
  else {
    await st().dispatch("parameter.setBounds", { name, min: 0, max, step: 0.01 });
    await st().dispatch("parameter.set", { name, expression: String(value) });
  }
}

/** One user action on a sheet: feature.sheet.edit, plus the fold slider's range when the step count changes, as one undo step. */
async function editSheet(sheet: SheetFeature, change: { folds?: SheetFoldDef[]; cuts?: string[]; progress?: string; thickness?: string }, label: string): Promise<boolean> {
  const s = st().session;
  const cp = s.checkpoint();
  const params: Record<string, unknown> = { feature: sheet.id };
  if (change.folds) params.folds = foldsToParams(change.folds);
  if (change.cuts) params.cuts = change.cuts;
  if (change.progress !== undefined) params.progress = change.progress;
  if (change.thickness !== undefined) params.thickness = change.thickness;
  const r = await st().dispatch("feature.sheet.edit", params);
  if (!r.ok) return false;
  const progress = change.progress ?? sheet.progressExpr;
  const name = plainParam(progress, s.doc.parameters.map((p) => p.name));
  const before = stepCount(sheet.folds ?? []), after = stepCount(change.folds ?? sheet.folds ?? []);
  if (name && (change.folds || change.progress !== undefined) && after !== before) await syncFoldRange(name, before, after);
  st().session.squash(cp, label);
  useStore.setState((x) => ({ rev: x.rev + 1 }));
  return true;
}

/** The lines of `sketchId` selected in the sketch editor (none unless that sketch is open). */
function useSelectedLines(sketchId: string): string[] {
  const mode = useStore((s) => s.mode);
  const active = useStore((s) => s.activeSketchId);
  const selection = useStore((s) => s.selection);
  const sk = useStore((s) => s.session.doc.sketches[sketchId]);
  if (mode !== "sketch" || active !== sketchId || !sk) return [];
  return selection.filter((id) => sk.entities[id]?.kind === "line");
}

/** The sheet the panel edits: in a sketch, the sheet made from it; else the open feature if it's a sheet, the one picked, or the last. */
function useTargetSheet(picked: string | null): { sheet: SheetFeature | null; sheets: SheetFeature[] } {
  useStore((s) => s.rev);
  const doc = useStore((s) => s.session.doc);
  const mode = useStore((s) => s.mode);
  const active = useStore((s) => s.activeSketchId);
  const open = useUi((s) => s.openFeature);
  const sheets = Object.values(doc.features).filter((f): f is SheetFeature => f.kind === "sheet" && f.mode === "base");
  if (mode === "sketch") return { sheet: sheets.find((f) => f.sketchId === active) ?? null, sheets };
  const byId = (id: string | null) => sheets.find((f) => f.id === id) ?? null;
  return { sheet: byId(open) ?? byId(picked) ?? sheets[sheets.length - 1] ?? null, sheets };
}

/** The Inspector's Folds section. */
export function FoldsPanel() {
  const mode = useStore((s) => s.mode);
  const [picked, setPicked] = useState<string | null>(null);
  const { sheet, sheets } = useTargetSheet(picked);
  if (mode === "sketch" && !sheet) return null;
  return (
    <div className="inspector-section folds-panel" aria-label="Folds">
      <div className="section-title">
        Folds{sheet ? ` · ${sheet.name}` : ""}
        {mode === "model" && sheets.length > 1 && (
          <select className="folds-pick" aria-label="Sheet to edit" value={sheet?.id ?? ""} onChange={(e) => { setPicked(e.target.value); useUi.getState().setOpenFeature(null); }}>
            {sheets.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        )}
      </div>
      {sheet ? <SheetFolds sheet={sheet} /> : <div className="muted">Fold paper: make a sheet, then draw its fold lines in its sketch.</div>}
      {mode === "model" && <NewPaper onMade={setPicked} />}
    </div>
  );
}

function SheetFolds({ sheet }: { sheet: SheetFeature }) {
  const mode = useStore((s) => s.mode);
  const solid = useStore((s) => s.solids[sheet.id]);
  const selected = useSelectedLines(sheet.sketchId);
  const folds = sheet.folds ?? [];
  const cuts = sheet.cuts ?? [];
  const M = stepCount(folds);
  const stepped = isStepped(folds);
  const groups = stepGroups(folds);
  const errors = splitFoldErrors(solid?.error);
  const inSketch = mode === "sketch";
  const fresh = selected.filter((l) => !cuts.includes(l));
  const canAdd = fresh.length > 0;
  const hint = inSketch ? "select a construction line of the sheet's sketch" : "edit the sheet's sketch, then select a construction line of it";
  const n = (k: number) => `${k} line${k === 1 ? "" : "s"}`;

  const edit = (change: Parameters<typeof editSheet>[1], label: string) => void editSheet(sheet, change, label);
  const addTo = (step: number | undefined) => { if (canAdd) { edit({ folds: addFolds(folds, fresh, step) }, step != null && step > M ? "Add a step" : `Add ${fresh.length === 1 ? "a fold" : "folds"}`); st().clearSelection(); } };
  const addStepAt = (at: number) => { if (canAdd) { edit({ folds: addFolds(insertStep(folds, at), fresh, at) }, "Add a step"); st().clearSelection(); } };
  const setFold = (i: number, f: SheetFoldDef, label = "Edit a fold") => edit({ folds: folds.map((x, j) => (j === i ? f : x)) }, label);

  return (
    <>
      <div className="folds-head">
        {inSketch
          ? <span className="muted-inline">{selected.length ? `${n(selected.length)} selected` : hint}</span>
          : <button className="btn small" title="Open the sheet's sketch to draw and select fold lines" onClick={() => st().editSketch(sheet.sketchId)}>Edit fold lines</button>}
        <label className="folds-thick" title="Paper thickness (mm); layers stack this far apart">
          t <ThicknessInput value={sheet.thicknessExpr} onCommit={(t) => edit({ thickness: t }, "Set paper thickness")} />
        </label>
      </div>
      <Progress sheet={sheet} steps={M} />
      {errors.top.map((e, i) => <div key={i} className="folds-error" role="alert">{e}</div>)}
      {solid?.warning && <div className="muted">{solid.warning}</div>}
      {groups.map((g) => (
        <div key={g.step} className="folds-step">
          <div className="folds-step-head">
            <span>{g.step === 0 ? "Folded at once" : `Step ${g.step}`}</span>
            <span className="folds-step-actions">
              <button className="icon-btn" disabled={!canAdd} title={canAdd ? `Add the selected ${n(fresh.length)} to this step` : hint} onClick={() => addTo(g.step || undefined)}>+</button>
              {g.step > 0 && <button className="icon-btn" disabled={!canAdd} title={canAdd ? "Insert a step before this one, folding the selected lines" : hint} onClick={() => addStepAt(g.step)}>⤒</button>}
              {g.step > 0 && <button className="icon-btn" disabled={!canAdd} title={canAdd ? "Insert a step after this one, folding the selected lines" : hint} onClick={() => addStepAt(g.step + 1)}>⤓</button>}
            </span>
          </div>
          {(errors.byStep[g.step] ?? []).map((e, i) => <div key={i} className="folds-error" role="alert">{e}</div>)}
          {g.folds.map(({ fold, index }) => (
            <FoldRow key={`${index}:${fold.line}`} sheet={sheet} fold={fold} index={index} peers={g.folds.filter((x) => x.index !== index).map((x) => x.fold.line)}
              stepped={g.step > 0} last={g.step === M && g.folds.length === 1} first={g.step === 1 && g.folds.length === 1}
              onChange={(f, label) => setFold(index, f, label)}
              onMove={(d) => edit({ folds: moveFold(folds, index, d) }, d < 0 ? "Move a fold a step earlier" : "Move a fold a step later")}
              onRemove={() => edit({ folds: removeFold(folds, index) }, "Remove a fold")} />
          ))}
        </div>
      ))}
      <div className="folds-actions">
        {stepped && <button className="btn small" disabled={!canAdd} title={canAdd ? `Fold the selected ${n(fresh.length)} as step ${M + 1}` : hint} onClick={() => addTo(M + 1)}>+ New step</button>}
        <button className="btn small" disabled={!canAdd} title={canAdd ? `Cut the paper along the selected ${n(fresh.length)} (slits)` : hint}
          onClick={() => { edit({ cuts: [...cuts, ...fresh], folds: folds.filter((f) => !fresh.includes(f.line)) }, "Cut the paper"); st().clearSelection(); }}>✂ Mark as cut</button>
      </div>
      {!canAdd && <div className="muted folds-hint">{hint}{inSketch ? ", then add it as a fold or a cut" : ""}</div>}
      {cuts.length > 0 && (
        <div className="folds-cuts">
          <span className="muted-inline">Cuts</span>
          {cuts.map((c) => (
            <span key={c} className="geom-chip">
              <LineName sketchId={sheet.sketchId} line={c} />
              <button className="chip-x" aria-label={`Remove cut ${c}`} onClick={() => edit({ cuts: cuts.filter((x) => x !== c) }, "Remove a cut")}>✕</button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

/** A line id; in its sketch, clicking it selects the line. */
function LineName({ sketchId, line }: { sketchId: string; line: string }) {
  const mode = useStore((s) => s.mode);
  const active = useStore((s) => s.activeSketchId);
  const construction = useStore((s) => (s.session.doc.sketches[sketchId]?.entities[line] as { construction?: boolean } | undefined)?.construction);
  const here = mode === "sketch" && active === sketchId;
  return (
    <button className="folds-line k-mono" disabled={!here} title={here ? "Select this line in the sketch" : `Line ${line}${construction ? " (construction)" : ""}`}
      onClick={() => st().select([line])}>{line}</button>
  );
}

function FoldRow(p: {
  sheet: SheetFeature; fold: SheetFoldDef; index: number; peers: string[]; stepped: boolean; first: boolean; last: boolean;
  onChange: (f: SheetFoldDef, label?: string) => void; onMove: (d: -1 | 1) => void; onRemove: () => void;
}) {
  const { fold } = p;
  const op = foldOp(fold);
  const collapse = op === "collapse" || op === "through" || op === "bend";
  const valley = isValley(fold);
  return (
    <div className="folds-row">
      <LineName sketchId={p.sheet.sketchId} line={fold.line} />
      <AngleInput value={fold.angleExpr ?? ""} solved={collapse} onCommit={(t) => p.onChange(withAngle(fold, t), "Set a fold's angle")} />
      <button className={`btn small folds-vm ${valley ? "valley" : "mountain"}`} title={valley ? "Valley fold (toward the top): click for mountain" : "Mountain fold (away from the top): click for valley"}
        onClick={() => p.onChange(toggleValley(fold), valley ? "Make a mountain fold" : "Make a valley fold")}>{valley ? "V" : "M"}</button>
      {p.stepped && (
        <select aria-label={`Operation of fold ${fold.line}`} value={op} title={FOLD_OPS.find((o) => o.key === op)?.title}
          onChange={(e) => p.onChange(withOp(fold, e.target.value as FoldOp), "Change a fold's operation")}>
          {FOLD_OPS.map((o) => <option key={o.key} value={o.key} title={o.title}>{o.label}</option>)}
        </select>
      )}
      {op === "through" && (
        <select aria-label={`Fold ${fold.line} goes through`} value={fold.through ?? "both"} onChange={(e) => p.onChange(withOp(fold, "through", e.target.value as "up" | "down" | "both"))}>
          <option value="up">up</option><option value="down">down</option><option value="both">both</option>
        </select>
      )}
      {collapse && (
        <select aria-label={`Fold ${fold.line} turns with`} title="Turns with another fold of the step (the same crease on a layer stacked with it)" value={fold.with ?? ""}
          onChange={(e) => { const { with: _w, ...rest } = fold; p.onChange(e.target.value ? { ...rest, with: e.target.value } : rest, "Change what a fold turns with"); }}>
          <option value="">with —</option>
          {p.peers.map((l) => <option key={l} value={l}>with {l}</option>)}
        </select>
      )}
      {p.stepped && (
        <label className="folds-flip" title="Fold the held side of the line instead">
          <input type="checkbox" checked={!!fold.flip} onChange={(e) => { const { flip: _f, ...rest } = fold; p.onChange(e.target.checked ? { ...rest, flip: true } : rest, "Flip a fold"); }} />flip
        </label>
      )}
      <span className="folds-row-end">
        {p.stepped && <button className="icon-btn" aria-label={`Move fold ${fold.line} a step earlier`} title="A step earlier" disabled={p.first} onClick={() => p.onMove(-1)}>↑</button>}
        {p.stepped && <button className="icon-btn" aria-label={`Move fold ${fold.line} a step later`} title="A step later" disabled={p.last} onClick={() => p.onMove(1)}>↓</button>}
        <button className="icon-btn danger" aria-label={`Remove fold ${fold.line}`} title="Remove this fold" onClick={p.onRemove}>✕</button>
      </span>
    </div>
  );
}

/** A fold's angle in degrees (an expression is kept as typed); committed on Enter or leaving the field. */
function AngleInput({ value, solved, onCommit }: { value: string; solved: boolean; onCommit: (t: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => { if (text.trim() !== value.trim()) onCommit(text); };
  return (
    <input className="dim-expr folds-angle" aria-label="Angle (degrees)" inputMode="decimal" value={text} placeholder={solved ? "solve" : "°"}
      title={solved ? "Degrees (+ valley, − mountain); empty: solved so the paper stays joined" : "Degrees: + valley, − mountain; 180 folds flat"}
      onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setText(value); }} />
  );
}

function ThicknessInput({ value, onCommit }: { value: string; onCommit: (t: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input className="dim-expr folds-angle" aria-label="Paper thickness" value={text} onChange={(e) => setText(e.target.value)}
      onBlur={() => { if (text.trim() && text.trim() !== value) onCommit(text.trim()); else setText(value); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
}

/** "Folding: step N of M": a slider on the progress parameter (0 flat … M every step done). */
function Progress({ sheet, steps }: { sheet: SheetFeature; steps: number }) {
  const params = useStore((s) => s.session.doc.parameters);
  const name = plainParam(sheet.progressExpr, params.map((p) => p.name));
  const param = name ? params.find((p) => p.name === name) : undefined;
  const [drag, setDrag] = useState<number | null>(null);
  const committer = useMemo(() => editCommitter((n, v) => st().setParameterExpr(n, v), 150), []);
  const dragging = useRef(false);
  useEffect(() => () => committer.cancel(), [committer]);
  useEffect(() => { if (!dragging.current) setDrag(null); }, [param?.value]); // the committed value has landed
  if (steps === 0) return null;
  if (!sheet.progressExpr) {
    return (
      <div className="folds-progress">
        <span className="muted-inline">All {steps} steps folded</span>
        <button className="btn small" title="Add a `fold` parameter that runs the steps (0 flat … every step done)" onClick={() => void addFoldSlider(sheet, steps)}>Add a fold slider</button>
      </div>
    );
  }
  if (!param) return <div className="folds-progress muted-inline" title="The progress is an expression, not one parameter: change it in Parameters">Folding: progress = <span className="k-mono">{sheet.progressExpr}</span></div>;
  const v = drag ?? Math.min(steps, Math.max(0, param.value));
  const at = v <= 0 ? "flat" : `step ${Math.min(steps, Math.ceil(v - 1e-9))} of ${steps}${Number.isInteger(+v.toFixed(2)) ? "" : ` (${Math.round((v - Math.floor(v)) * 100)}%)`}`;
  const send = (x: number, flush: boolean) => { setDrag(x); committer.edit(param.name, String(+x.toFixed(2)), flush); };
  return (
    <div className="folds-progress">
      <span className="folds-progress-label">Folding: {at}</span>
      <input type="range" min={0} max={steps} step={0.01} value={v} aria-label={`Folding (${param.name}): step of ${steps}`}
        onPointerDown={() => { dragging.current = true; }}
        onChange={(e) => send(Number(e.target.value), !dragging.current)}
        onPointerUp={(e) => { dragging.current = false; send(Number((e.target as HTMLInputElement).value), true); }} />
    </div>
  );
}

/** A `fold` parameter (0 … the step count, at the end) made the sheet's progress, as one undo step. */
async function addFoldSlider(sheet: SheetFeature, steps: number): Promise<void> {
  const s = st().session;
  const cp = s.checkpoint();
  const name = uniqueName("fold", s.doc.parameters.map((p) => p.name));
  const r = await st().dispatch("parameter.add", { name, expression: String(steps), min: 0, max: Math.max(1, steps), step: 0.01, label: "Fold", description: "0 is the flat sheet; each step folds one more" });
  if (!r.ok) return;
  const e = await st().dispatch("feature.sheet.edit", { feature: sheet.id, progress: name });
  if (!e.ok) { s.rollback(cp); toast(e.error ?? "Couldn't add the fold slider"); return; }
  s.squash(cp, "Add a fold slider");
  useStore.setState((x) => ({ rev: x.rev + 1 }));
}

/** "New paper": a sheet of a preset (or custom) size on XY, 0.1 thick with sharp creases, run by a `fold` parameter, two-sided paper. */
function NewPaper({ onMade }: { onMade: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState("kami15");
  const [w, setW] = useState("100"), [h, setH] = useState("100");
  const [front, setFront] = useState("#f4f1ea"), [back, setBack] = useState("#b33a2e");
  const busy = useRef(false);
  if (!open) return <div className="folds-actions"><button className="btn small" onClick={() => setOpen(true)}>New paper…</button></div>;
  const pr = PAPER_PRESETS.find((x) => x.key === preset)!;
  const size = preset === "custom" ? { w: Number(w), h: Number(h) } : { w: pr.w, h: pr.h };
  const ok = size.w > 0 && size.h > 0 && Number.isFinite(size.w) && Number.isFinite(size.h);
  const make = async () => {
    if (!ok || busy.current) return;
    busy.current = true;
    try {
      const id = await createPaper(size.w, size.h, front, back, preset === "custom" ? "Paper" : `Paper (${pr.label})`);
      if (id) { onMade(id); setOpen(false); }
    } finally { busy.current = false; }
  };
  return (
    <div className="folds-new">
      <select aria-label="Paper size" value={preset} onChange={(e) => setPreset(e.target.value)}>
        {PAPER_PRESETS.map((x) => <option key={x.key} value={x.key}>{x.label}{x.key === "custom" ? "" : ` (${x.w} × ${x.h})`}</option>)}
      </select>
      {preset === "custom" && (
        <span className="folds-wh">
          <input className="dim-expr" aria-label="Width (mm)" inputMode="decimal" value={w} onChange={(e) => setW(e.target.value)} />×
          <input className="dim-expr" aria-label="Height (mm)" inputMode="decimal" value={h} onChange={(e) => setH(e.target.value)} />mm
        </span>
      )}
      <label title="The top's colour"><input type="color" aria-label="Front colour" value={front} onChange={(e) => setFront(e.target.value)} /></label>
      <label title="The underside's colour"><input type="color" aria-label="Back colour" value={back} onChange={(e) => setBack(e.target.value)} /></label>
      <button className="btn small primary" disabled={!ok} onClick={() => void make()}>Make</button>
      <button className="btn small ghost" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}

/** The commands a new paper is made of, as one undo step (all or nothing). Returns the sheet's id. */
async function createPaper(w: number, h: number, color: string, backColor: string, name: string): Promise<string | null> {
  const s = st().session;
  const cp = s.checkpoint();
  const run = async (type: string, params: Record<string, unknown>) => {
    const r = await st().dispatch(type, params);
    if (!r.ok) throw new Error(r.error ?? `${type} failed`);
    return r.createdIds;
  };
  try {
    const hadFeatures = Object.keys(s.doc.features).length > 0;
    const fold = uniqueName("fold", s.doc.parameters.map((p) => p.name));
    await run("parameter.add", { name: fold, expression: "0", min: 0, max: 1, step: 0.01, label: "Fold", description: "0 is the flat sheet; each step folds one more" });
    const [sk] = await run("sketch.create", { plane: "XY", name });
    const r2 = (x: number) => Math.round(x * 1000) / 1000;
    await run("sketch.addRectangle", { sketch: sk, corner: { x: r2(-w / 2), y: r2(-h / 2) }, opposite: { x: r2(w / 2), y: r2(h / 2) } });
    const [sheet] = await run("feature.sheet", { sketch: sk, name, thickness: 0.1, radius: 0 });
    await run("feature.sheet.edit", { feature: sheet, progress: fold });
    const doc = st().session.doc;
    const same = Object.values(doc.materials).find((m) => m.kind === "paper" && m.color === color && m.backColor === backColor);
    const mat = same?.id ?? (await run("material.create", { name: "Paper", kind: "paper", color, backColor }))[0];
    // the paper colours the document only where nothing else was coloured (the root's material is every body's default)
    const root = doc.components[doc.rootComponentId];
    if (!hadFeatures || !root?.materialId) await run("material.assign", { material: mat });
    st().session.squash(cp, "New paper");
    useStore.setState((x) => ({ rev: x.rev + 1 }));
    return sheet;
  } catch (e) {
    st().session.rollback(cp);
    toast(`New paper: ${e instanceof Error ? e.message : String(e)}`);
    void st().rebuildSolids();
    return null;
  }
}
