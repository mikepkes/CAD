// Customize mode: a slider-only product-tuning view. Loads a model from the
// URL (?model=<url> or ?example=<name>) and shows just the 3D preview with the
// bounded parameters as sliders/dropdowns overlaid, so an end user can dial the
// product to their dimensions. Dragging a control updates the preview smoothly
// (local value + throttled, coalesced rebuilds); the motion study runs only
// after the user goes idle and is cancelled the moment they touch a control
// again, so it never churns through the values a drag passed through.

import { useCallback, useEffect, useRef, useState } from "react";
import { flexureEquilibria, flexureState, flexureSweep, hasFlexures, isAngularDrive, type EquilibriumStudy } from "../sim/flexure";
import { compileExpr } from "../math/expr";
import type { Parameter } from "../core/document";
import { Viewport } from "./Viewport";
import { useStore } from "../model/store";
import { deserializeDocument } from "../core/persistence";

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));
// The 3D rebuild is the slow part, so the slider's own value updates live while
// the model is rebuilt only when you briefly pause or release (debounce, not
// per-frame), and the (secondary) motion study runs only well after you stop.
const IDLE_MS = 2000;   // run the motion study after this long with no interaction
const COMMIT_MS = 200;  // debounce: rebuild the model this long after the last move

function modelUrl(): string | null {
  const q = new URLSearchParams(location.search);
  const model = q.get("model");
  if (model) return model;
  const example = q.get("example");
  if (example) return `${import.meta.env.BASE_URL}examples/${encodeURIComponent(example)}.json`;
  return null;
}

/** One bounded parameter. Shows its own local value instantly while dragging
 *  (so the slider never lags the model), reporting changes up via `onEdit`. */
function Control({ name, value, expr, min, max, step: paramStep, values, boolean, options, onEdit }: {
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
function MotionBadge() {
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
/** The parameters that drive a compliant mechanism: bounded parameters that a
 *  placing joint's motion follows (a planar joint can have one per axis). */
function drivesOf(doc: ReturnType<typeof useStore.getState>["session"]["doc"]) {
  const out: Parameter[] = [];
  for (const j of Object.values(doc.joints)) {
    if (j.solve || j.closes || j.kind === "beam" || j.kind === "rigid") continue;
    for (const e of j.kind === "planar" ? Object.values(j.planar ?? {}) : [j.valueExpr]) {
      let deps: string[] = [];
      try { deps = compileExpr(String(e)).deps; } catch { continue; }
      for (const p of doc.parameters) if (deps.includes(p.name) && p.min != null && p.max != null && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

function FlexureReadout() {
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

export function CustomizeApp() {
  const loadDocument = useStore((s) => s.loadDocument);
  const ensureKernel = useStore((s) => s.ensureKernel);
  const runMotionStudy = useStore((s) => s.runMotionStudy);
  const cancelMotionStudy = useStore((s) => s.cancelMotionStudy);
  const shareModel = useStore((s) => s.shareModel);
  const params = useStore((s) => s.session.doc.parameters);
  useStore((s) => s.rev); // re-render as the model resolves
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(true);

  const idle = useRef<ReturnType<typeof setTimeout>>();
  const commit = useRef<{ timer?: ReturnType<typeof setTimeout>; pending: [string, string] | null }>({ pending: null });

  // Run the study only after the user has been idle; any edit restarts the wait.
  const armStudy = useCallback(() => {
    cancelMotionStudy();
    clearTimeout(idle.current);
    idle.current = setTimeout(() => void runMotionStudy(), IDLE_MS);
  }, [cancelMotionStudy, runMotionStudy]);

  // Commit a control's value to the model. Debounced: a continuous drag doesn't
  // rebuild until you pause briefly (or release, `flush`), so a ~2s rebuild is
  // never spent on a value you've already dragged past. The slider's own number
  // tracks every move regardless (Control keeps a local value).
  const onEdit = useCallback((name: string, value: string, flush: boolean) => {
    armStudy();
    const c = commit.current;
    c.pending = [name, value];
    const fire = () => { if (!c.pending) return; const [n, v] = c.pending; c.pending = null; void useStore.getState().setParameterExpr(n, v); };
    clearTimeout(c.timer);
    if (flush) fire();
    else c.timer = setTimeout(fire, COMMIT_MS);
  }, [armStudy]);

  useEffect(() => {
    void (async () => {
      try {
        useStore.setState({ showPlanes: false, showGrid: false }); // clean product view
        await ensureKernel();
        const url = modelUrl();
        if (!url) throw new Error("No model given. Add ?model=<url> or ?example=gyroscope to the link.");
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Could not load model (${resp.status}).`);
        await loadDocument(deserializeDocument(await resp.text()));
        setState("ready");
        armStudy(); // validate the starting configuration once
      } catch (e) {
        setError((e as Error).message);
        setState("error");
      }
    })();
    return () => { clearTimeout(idle.current); clearTimeout(commit.current.timer); };
  }, [ensureKernel, loadDocument, armStudy]);

  const bounded = params.filter((p) => (p.min != null && p.max != null) || (p.values && p.values.length));

  return (
    <div className="customize">
      <Viewport />
      <MotionBadge />
      {state === "ready" && bounded.length > 0 && (
        <div className={`cz-panel ${open ? "" : "collapsed"}`}>
          <button className="cz-handle" onClick={() => setOpen((v) => !v)} title={open ? "Hide controls" : "Show controls"}>
            <span>Customize</span><span className="cz-chevron">{open ? "▾" : "▴"}</span>
          </button>
          {open && (
            <div className="cz-controls">
              {bounded.map((p) => <Control key={p.id} name={p.name} value={p.value} expr={p.expr} min={p.min} max={p.max} step={p.step} values={p.values} boolean={p.boolean} options={p.options} onEdit={onEdit} />)}
              <FlexureReadout />
              <button
                className="cz-share"
                title="Save the model for printing: an STL (all parts in one file), or a 3MF with a part per material when it has more than one; or share it to Files / AirDrop / another app on a phone"
                onClick={() => void shareModel(new URLSearchParams(location.search).get("example") || "model")}
              >
                ⬇ Save / share for printing
              </button>
            </div>
          )}
        </div>
      )}
      {state === "loading" && <div className="cz-overlay">Loading…</div>}
      {state === "error" && <div className="cz-overlay error">{error}</div>}
    </div>
  );
}
