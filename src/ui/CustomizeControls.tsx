// The customize viewer's controls (CustomizeApp.tsx): a bounded parameter's
// slider / dropdown / checkbox, the motion-study badge, the live flexure readout
// and the Save button. Kept apart from the viewer itself (which mounts the 3D
// viewport) so they can be tested without WebGL.

import { useEffect, useRef, useState } from "react";
import { flexureEquilibria, flexureState, flexureSweep, hasFlexures, isAngularDrive, type EquilibriumStudy } from "../sim/flexure";
import { drivesOf } from "../model/concepts/mechanism";
import { printFormat, useStore } from "../model/store";
import { buildPercent, buildStepText } from "./BuildProgress";

export const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));

/** One bounded parameter. Shows its own local value instantly while dragging
 *  (so the slider never lags the model), reporting changes up via `onEdit`. */
export function Control({ name, value, expr, min, max, step: paramStep, values, boolean, options, onEdit }: {
  name: string; value: number; expr: string; min?: number; max?: number; step?: number; values?: number[]; boolean?: boolean; options?: string[];
  onEdit: (name: string, value: string, flush: boolean) => void;
}) {
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);
  useEffect(() => { if (!dragging.current) setLocal(value); }, [value]); // follow external changes when idle

  const label = <span className="cz-row-name" title={expr}>{name}</span>;
  if (boolean) {
    return (
      <label className="cz-row">
        {label}
        <input className="cz-check" type="checkbox" checked={value !== 0} onChange={(e) => onEdit(name, e.target.checked ? "1" : "0", true)} />
      </label>
    );
  }
  if (values && values.length) {
    return (
      <label className="cz-row">
        {label}
        <select className="cz-select" value={values.some((v) => Math.abs(v - value) < 1e-9) ? String(value) : ""} onChange={(e) => onEdit(name, e.target.value, true)}>
          {!values.some((v) => Math.abs(v - value) < 1e-9) && <option value="">{fmt(value)}…</option>}
          {values.map((v) => <option key={v} value={String(v)}>{options?.[v] ?? fmt(v)}</option>)}
        </select>
      </label>
    );
  }
  const span = max! - min!;
  // An explicit increment wins; otherwise pick a sensible precision from the span.
  const step = paramStep && paramStep > 0 ? paramStep : span >= 20 ? 1 : span >= 2 ? 0.1 : 0.01;
  return (
    <label className="cz-row">
      {label}
      <input
        className="cz-range" type="range" min={min} max={max} step={step}
        value={Math.min(max!, Math.max(min!, local))}
        onPointerDown={() => { dragging.current = true; }}
        onPointerUp={() => { dragging.current = false; onEdit(name, String(local), true); }}
        onChange={(e) => { const v = Number(e.target.value); setLocal(v); onEdit(name, String(v), false); }}
      />
      <span className="cz-row-val">{fmt(local)}</span>
    </label>
  );
}

/** Pass / fail / progress for the current configuration's motion study. */
export function MotionBadge() {
  const status = useStore((s) => s.motionStatus);
  const progress = useStore((s) => s.motionProgress);
  const result = useStore((s) => s.motionResult);
  const has = useStore((s) => s.hasMotionStudy);
  if (!has) return null;
  const pct = Math.round(progress * 100);
  const cls = status === "pass" ? "pass" : status === "fail" ? "fail" : status === "running" ? "running" : "idle";
  const label =
    status === "running" ? `Checking motion… ${pct}%` :
    status === "pass" ? "Rotates freely — passes" :
    status === "fail" ? (result?.reason ?? "Does not clear — fails") :
    "Not checked";
  const icon = status === "pass" ? "✓" : status === "fail" ? "✕" : status === "running" ? "◍" : "○";
  return (
    <div className={`cz-badge ${cls}`} title="Motion study: can the mechanism move through its full range without parts colliding?">
      <span className="cz-badge-icon">{icon}</span>
      <span className="cz-badge-text">{label}</span>
      {status === "running" && <span className="cz-badge-bar"><span style={{ width: `${pct}%` }} /></span>}
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
  return (
    <div className="cz-flex" title="Each flexure is a thin strip that bends instead of a pin. Its bar shows the peak strain against the material's limit.">
      <div className="cz-flex-head">
        <span>Flexures</span>
        <span className={over || st.error ? "cz-flex-bad" : "cz-flex-ok"}>{st.error ? "can't reach this pose" : over ? "over the strain limit" : "within the strain limit"}</span>
      </div>
      {st.flexures.map((f) => {
        const u = f.allowable ? f.strain / f.allowable : 0;
        return (
          <div className="cz-flex-row" key={f.joint}>
            <span className="cz-flex-name">{f.name}</span>
            <span className="cz-flex-bar"><span className={u > 1 ? "over" : ""} style={{ width: `${Math.min(100, u * 100)}%` }} /></span>
            <span className="cz-flex-val">{(f.strain * 100).toFixed(1)}%</span>
          </div>
        );
      })}
      <div className="cz-flex-foot">
        {st.flexures[0]?.allowable != null && <span>limit {(st.flexures[0].allowable * 100).toFixed(0)}%</span>}
        {efforts.length > 1
          ? efforts.map(({ d, effort }) => <span key={d.name}>{isAngularDrive(doc, d.name) ? `${d.name} torque ${Math.abs(effort).toFixed(0)} N·mm` : `${d.name} force ${Math.abs(effort).toFixed(1)} N`}</span>)
          : Number.isFinite(st.effort) && <span>{angular ? `input torque ${Math.abs(st.effort).toFixed(0)} N·mm` : `input force ${Math.abs(st.effort).toFixed(1)} N`}</span>}
        <span>stored {st.energy.toFixed(1)} mJ</span>
      </div>
      {param && study && stable.length > 0 && (
        <div className="cz-flex-rest" title="Where it stays put when you let go: the effort is zero there and pushes back either way.">
          {study.multistable
            ? <><span className="cz-flex-ok">bistable</span> rests at {param.name} = {stable.map((q) => `${fmt(Math.round(q.value * 10) / 10)}${unit}`).join(" and ")}</>
            : <>springs back to {param.name} = {fmt(Math.round(stable[0].value * 10) / 10)}{unit}</>}
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
