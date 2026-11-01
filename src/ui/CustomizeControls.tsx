// The customize viewer's controls (CustomizeApp.tsx): a bounded parameter's
// slider / dropdown / checkbox, the motion-study badge, the live flexure readout
// and the Save button. Kept apart from the viewer itself (which mounts the 3D
// viewport) so they can be tested without WebGL.

import { useEffect, useId, useRef, useState } from "react";
import { snapToStep } from "../core/parameters";
import { flexureEquilibria, flexureState, flexureSweep, hasFlexures, isAngularDrive, type EquilibriumStudy } from "../sim/flexure";
import { drivesOf } from "../model/concepts/mechanism";
import { printFormat, useStore } from "../model/store";
import { motionVerdict } from "../model/motionStudy";
import { buildPercent, buildStepText } from "./BuildProgress";
import type { CadDocument, Parameter } from "../core/document";
import { EXAMPLES, customizeLink, exampleTitle } from "../model/examples";

export const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));

/** A slider's step: an explicit increment wins; otherwise a sensible precision from the span. */
export function sliderStep(min: number, max: number, step?: number): number {
  if (step && step > 0) return step;
  const span = max - min;
  return span >= 20 ? 1 : span >= 2 ? 0.1 : 0.01;
}

/** A typed value as the slider would take it: a number, kept within [min, max] and on the step
 *  (counted from min, as the slider counts); null when it isn't a number. */
export function typedValue(text: string, min: number, max: number, step?: number): number | null {
  const v = Number(text.trim().replace(",", "."));
  if (!text.trim() || !Number.isFinite(v)) return null;
  const snapped = step && step > 0 ? snapToStep(v, step, min) : v;
  const clamped = Math.min(max, Math.max(min, snapped));
  return Math.round(clamped * 1e9) / 1e9; // no float dust from the snapping
}

/** A value with its unit, for reading out ("1700 mm", "30°"). */
export const withUnit = (v: string, unit?: string) => (!unit ? v : /^[°%′″]/.test(unit) ? `${v}${unit}` : `${v} ${unit}`);

export interface ControlProps {
  name: string; value: number; expr: string;
  /** What a person calls it (falls back to the name), its unit and a line about it. */
  label?: string; unit?: string; description?: string;
  min?: number; max?: number; step?: number; values?: number[]; boolean?: boolean; options?: string[];
  onEdit: (name: string, value: string, flush: boolean) => void;
}

/** One bounded parameter: its label (or name), a line about it, and a slider with
 *  a value field beside it (type an exact value; it is kept in range and on the
 *  step), or a dropdown / checkbox. Shows its own local value instantly while
 *  dragging (so the slider never lags the model), reporting changes up via `onEdit`. */
export function Control({ name, value, expr, label: shown, unit, description, min, max, step: paramStep, values, boolean, options, onEdit }: ControlProps) {
  const [local, setLocal] = useState(value);
  const [draft, setDraft] = useState<string | null>(null); // the value field while it's being typed in
  const dragging = useRef(false);
  const id = useId();
  useEffect(() => { if (!dragging.current) setLocal(value); }, [value]); // follow external changes when idle

  const label = shown || name;
  const descId = description ? `${id}-desc` : undefined;
  const head = (
    <div className="cz-row-head">
      <label className="cz-row-name" htmlFor={`${id}-input`} title={shown ? `${name} = ${expr}` : expr}>{label}</label>
    </div>
  );
  const desc = description && <p className="cz-row-desc" id={descId}>{description}</p>;

  if (boolean) {
    return (
      <div className="cz-row cz-row-check">
        <input id={`${id}-input`} className="cz-check" type="checkbox" checked={value !== 0} aria-describedby={descId} onChange={(e) => onEdit(name, e.target.checked ? "1" : "0", true)} />
        {head}
        {desc}
      </div>
    );
  }
  if (values && values.length) {
    const known = values.some((v) => Math.abs(v - value) < 1e-9);
    return (
      <div className="cz-row">
        {head}
        <select id={`${id}-input`} className="cz-select" aria-describedby={descId} value={known ? String(value) : ""} onChange={(e) => onEdit(name, e.target.value, true)}>
          {!known && <option value="">{withUnit(fmt(value), unit)}…</option>}
          {values.map((v) => <option key={v} value={String(v)}>{options?.[v] ?? withUnit(fmt(v), unit)}</option>)}
        </select>
        {desc}
      </div>
    );
  }
  const lo = min!, hi = max!;
  const step = sliderStep(lo, hi, paramStep);
  const commitTyped = () => {
    if (draft == null) return;
    const v = typedValue(draft, lo, hi, paramStep);
    setDraft(null);
    if (v == null || v === local) return;
    setLocal(v);
    onEdit(name, String(v), true);
  };
  return (
    <div className="cz-row">
      <div className="cz-row-head">
        <label className="cz-row-name" htmlFor={`${id}-input`} title={shown ? `${name} = ${expr}` : expr}>{label}</label>
        <span className="cz-row-num">
          <input
            className="cz-num" type="text" inputMode="decimal" enterKeyHint="done" autoComplete="off" spellCheck={false}
            aria-label={`${label}, exact value${unit ? ` in ${unit}` : ""}`}
            value={draft ?? fmt(local)}
            onFocus={(e) => { setDraft(fmt(local)); e.target.select(); }}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitTyped}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitTyped(); }
              else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDraft(null); }
            }}
          />
          {unit && <span className="cz-unit" aria-hidden="true">{unit}</span>}
        </span>
      </div>
      <input
        id={`${id}-input`}
        className="cz-range" type="range" min={lo} max={hi} step={step}
        value={Math.min(hi, Math.max(lo, local))}
        aria-valuetext={withUnit(fmt(local), unit)}
        aria-describedby={descId}
        onPointerDown={() => { dragging.current = true; }}
        onPointerUp={() => { dragging.current = false; onEdit(name, String(local), true); }}
        onChange={(e) => { const v = Number(e.target.value); setLocal(v); onEdit(name, String(v), false); }}
      />
      <div className="cz-row-ends" aria-hidden="true"><span>{withUnit(fmt(lo), unit)}</span><span>{withUnit(fmt(hi), unit)}</span></div>
      {desc}
    </div>
  );
}

/** "about 40 s left", "about 2 min left". */
export function etaText(seconds: number | null): string {
  if (seconds == null) return "estimating time";
  if (seconds < 60) return `about ${Math.max(1, Math.round(seconds / 5) * 5 || 1)} s left`;
  return `about ${Math.round(seconds / 60)} min left`;
}

/** The motion study's verdict for the current values, as it goes: an estimate of
 *  the time left, the coarse pass's result while the rest runs, and the last
 *  verdict ("before your change") until the new one is in. Worded by the kind of
 *  motion checked. Screen readers hear the verdicts, not every percent. */
export function MotionBadge() {
  const status = useStore((s) => s.motionStatus);
  const progress = useStore((s) => s.motionProgress);
  const result = useStore((s) => s.motionResult);
  const previous = useStore((s) => s.motionPrevious);
  const coarse = useStore((s) => s.motionCoarse);
  const eta = useStore((s) => s.motionEta);
  const has = useStore((s) => s.hasMotionStudy);
  const doc = useStore((s) => s.session.doc);
  if (!has) return null;
  const pct = Math.round(progress * 100);
  const cls = status === "pass" ? "pass" : status === "fail" ? "fail" : status === "running" ? "running" : "idle";
  const label =
    status === "running" ? (coarse ? `Clear at ${coarse.checked} of ${coarse.total} positions · checking the rest` : "Checking the motion") :
    status === "pass" || status === "fail" ? motionVerdict(doc, result!) :
    previous ? "Will check again when you stop" : "Not checked yet";
  const icon = status === "pass" ? "✓" : status === "fail" ? "✕" : status === "running" ? "◍" : "○";
  // what a screen reader is told: the verdicts, and that a check started (not each percent)
  const spoken = status === "running" ? "Checking the motion" : status === "pass" || status === "fail" ? `Motion check: ${motionVerdict(doc, result!)}` : "";
  return (
    <div className={`cz-badge ${cls}`} title="Motion study: can the mechanism move through its full range without parts colliding?">
      <span className="cz-badge-icon" aria-hidden="true">{icon}</span>
      <span className="cz-badge-body">
        <span className="cz-badge-text">{label}</span>
        {status === "running" && <span className="cz-badge-eta">{pct}% · {etaText(eta)}</span>}
        {(status === "running" || status === "idle") && previous && (
          <span className={`cz-badge-prev ${previous.status}`}>Before your change: {previous.status === "pass" ? "✓" : "✕"} {motionVerdict(doc, previous)}</span>
        )}
      </span>
      {status === "running" && <span className="cz-badge-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>}
      <span className="sr-only" role="status" aria-live="polite">{spoken}</span>
    </div>
  );
}

/** Live hinge readout for a compliant mechanism: how hard each flexure is
 *  working (strain against its material's limit), what it takes to hold this
 *  pose, and the energy stored. Pure math on the solved pose — no rebuild — so it
 *  follows the slider. */
export function FlexureReadout() {
  const doc = useStore((s) => s.session.doc);
  const rev = useStore((s) => s.rev);
  const drives = hasFlexures(doc) ? drivesOf(doc) : [];
  const param = drives[0];
  // Where it rests along its drive (a bistable switch has two): a sweep of the
  // whole range, so it waits until the controls have been still for a moment.
  const [rest, setRest] = useState<{ key: string; study: EquilibriumStudy } | null>(null);
  const key = param ? JSON.stringify(doc.parameters.filter((q) => q.name !== param.name).map((q) => [q.name, q.expr])) : "";
  useEffect(() => {
    if (!param || rest?.key === key) return;
    const t = setTimeout(() => setRest({ key, study: flexureEquilibria(doc, param.name, param.min!, param.max!, 32) }), 700);
    return () => clearTimeout(t);
  }, [key, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!hasFlexures(doc)) return null;
  // the effort at each drive; the first drive's sweep runs last, leaving it posed as it stands
  const efforts = drives.slice(1).map((d) => ({ d, effort: flexureSweep(doc, d.name, [d.value])[0].effort }));
  const st = param ? flexureSweep(doc, param.name, [param.value])[0] : { ...flexureState(doc), effort: NaN };
  if (param) efforts.unshift({ d: param, effort: st.effort });
  const over = st.utilisation > 1;
  const angular = param ? isAngularDrive(doc, param.name) : false;
  const unit = angular ? "°" : " mm"; // a non-angle drive is a length
  const study = rest?.key === key ? rest.study : undefined;
  const stable = study?.states.filter((q) => q.stable) ?? [];
  const called = (n: string) => doc.parameters.find((q) => q.name === n)?.label || n; // a drive by its label
  return (
    <div className="cz-flex" title="Each flexure is a thin strip that bends instead of a pin. Its bar shows the peak strain against the material's limit.">
      <div className="cz-flex-head">
        <h2 className="cz-flex-title">Flexures</h2>
        <span className={over || st.error ? "cz-flex-bad" : "cz-flex-ok"}>{st.error ? "can't reach this pose" : over ? "over the strain limit" : "within the strain limit"}</span>
      </div>
      {st.flexures.map((f) => {
        const u = f.allowable ? f.strain / f.allowable : 0;
        return (
          <div className="cz-flex-row" key={f.joint}>
            <span className="cz-flex-name" title={f.name}>{f.name}</span>
            <span className="cz-flex-bar"><span className={u > 1 ? "over" : ""} style={{ width: `${Math.min(100, u * 100)}%` }} /></span>
            <span className="cz-flex-val">{(f.strain * 100).toFixed(1)}%</span>
          </div>
        );
      })}
      <div className="cz-flex-foot">
        {st.flexures[0]?.allowable != null && <span>limit {(st.flexures[0].allowable * 100).toFixed(0)}%</span>}
        {efforts.length > 1
          ? efforts.map(({ d, effort }) => <span key={d.name}>{isAngularDrive(doc, d.name) ? `${called(d.name)} torque ${Math.abs(effort).toFixed(0)} N·mm` : `${called(d.name)} force ${Math.abs(effort).toFixed(1)} N`}</span>)
          : Number.isFinite(st.effort) && <span>{angular ? `input torque ${Math.abs(st.effort).toFixed(0)} N·mm` : `input force ${Math.abs(st.effort).toFixed(1)} N`}</span>}
        <span>stored {st.energy.toFixed(1)} mJ</span>
      </div>
      {param && study && stable.length > 0 && (
        <div className="cz-flex-rest" title="Where it stays put when you let go: the effort is zero there and pushes back either way.">
          {study.multistable
            ? <><span className="cz-flex-ok">bistable</span> rests at {called(param.name)} = {stable.map((q) => `${fmt(Math.round(q.value * 10) / 10)}${unit}`).join(" and ")}</>
            : <>springs back to {called(param.name)} = {fmt(Math.round(stable[0].value * 10) / 10)}{unit}</>}
          {study.snap && <> · snaps over at {angular ? `${Math.abs(study.snap.effort).toFixed(0)} N·mm` : `${Math.abs(study.snap.effort).toFixed(1)} N`}</>}
        </div>
      )}
    </div>
  );
}


/** Save / share for printing: names the format it will write, and while it works
 *  says what it's doing (waiting for the model to catch up with the last edit, then
 *  making the file) and can't be pressed again. */
export function SaveButton(p: { onSave: () => void }) {
  const saving = useStore((s) => s.saving);
  const format = useStore((s) => printFormat(s.session.doc, s.solids)).toUpperCase();
  const label = saving?.stage === "updating" ? "Updating model…"
    : saving?.stage === "preparing" ? `Preparing ${saving.format.toUpperCase()}…`
    : `⬇ Save / share · ${format}`;
  return (
    <button
      className="cz-share"
      disabled={!!saving}
      aria-busy={!!saving}
      title={`Save the model for printing as ${format === "3MF" ? "a 3MF with a part per material" : "an STL (all parts in one file)"}; or share it to Files / AirDrop / another app on a phone`}
      onClick={p.onSave}
    >
      {label}
    </button>
  );
}

/** The viewer's loading screen: what it's waiting for, and once the model is
 *  building, which step it's on and how far it has got. */
export function LoadingOverlay(p: { phase: "loading" | "building"; name?: string }) {
  const build = useStore((s) => s.build);
  const kernelLoading = useStore((s) => s.kernelLoading);
  const what = p.name ? `“${p.name}”` : "the model";
  const head = p.phase === "building" ? `Building ${what}…` : kernelLoading ? "Loading the 3D engine…" : `Loading ${what}…`;
  const pct = build ? buildPercent(build.fraction) : 0;
  return (
    <div className="cz-overlay">
      <div className="cz-loading">
        <div className="cz-loading-head" role="status" aria-live="polite">{head}</div>
        {p.phase === "building" && build && (
          <>
            <div className="cz-loading-step">{buildStepText(build.step)} · {pct}%</div>
            <div className="cz-loading-bar" role="progressbar" aria-label="Building the model" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={`${buildStepText(build.step)}, ${pct}%`}>
              <span style={{ width: `${pct}%` }} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The design's title: its own (document.describe), its drawing's, its root
 *  component's name, else the example's; "Model" when there's nothing to go on. */
export function modelTitle(doc: CadDocument | null, example?: string): string {
  const root = doc?.components[doc.rootComponentId]?.name;
  return doc?.about?.title || doc?.drawing?.title || (root && root !== "Root Component" ? root : "") || (example ? exampleTitle(example) : "") || "Model";
}

/** The parameters the viewer offers: bounded ones (a range, a list, a switch) that aren't hidden. */
export function viewerControls(params: Parameter[]): Parameter[] {
  return params.filter((p) => !p.hidden && ((p.min != null && p.max != null) || (p.values && p.values.length)));
}

/** Why the viewer couldn't show a model. */
export type LoadFailure =
  | { kind: "none" }
  | { kind: "missing" | "offline"; example?: string; url: string }
  | { kind: "unreadable"; example?: string; url: string; detail: string };

/** The viewer's page when there's no model to show: what went wrong, in a
 *  sentence, and the examples it does have. */
export function LoadProblem({ failure }: { failure: LoadFailure }) {
  const what = failure.kind === "none" ? "" : failure.example ? `“${failure.example}”` : failure.url;
  const head = failure.kind === "none" ? "No model to show"
    : failure.kind === "missing" ? `Couldn't find the model ${what}`
    : failure.kind === "offline" ? `Couldn't load the model ${what}`
    : `Couldn't read the model ${what}`;
  const why = failure.kind === "none" ? "The link doesn't name a model. Add ?example=<name> or ?model=<url> to it, or pick one below."
    : failure.kind === "missing" ? (failure.example ? "There's no example by that name. Check the link, or pick one below." : "Nothing was found at that address. Check the link, or pick an example below.")
    : failure.kind === "offline" ? "The connection failed. Check that you're online and try again."
    : `It isn't a VibeCAD model this version can open (${"detail" in failure ? failure.detail : ""}).`;
  return (
    <div className="cz-overlay cz-problem">
      <div className="cz-problem-card" role="alert">
        <h1 className="cz-problem-head">{head}</h1>
        <p className="cz-problem-why">{why}</p>
        <h2 className="k-label">Examples</h2>
        <ul className="cz-problem-list">
          {EXAMPLES.map((e) => (
            <li key={e.name}><a href={customizeLink(e.name)}>{e.title}</a> <span className="k-dim">· {e.blurb}</span></li>
          ))}
        </ul>
        <p className="cz-problem-why"><a href="./">Open the editor</a></p>
      </div>
    </div>
  );
}
