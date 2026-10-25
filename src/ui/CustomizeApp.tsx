// Customize mode: a slider-only product-tuning view. Loads a model from the
// URL (?model=<url> or ?example=<name>) and shows just the 3D preview with the
// bounded parameters as sliders/dropdowns overlaid, so an end user can dial the
// product to their dimensions. Every change updates the preview immediately;
// after a short dwell a motion study runs in the background and reports whether
// the chosen values still work (pass) or jam / break the mechanism (fail).

import { useEffect, useRef, useState } from "react";
import { Viewport } from "./Viewport";
import { useStore } from "../model/store";
import { deserializeDocument } from "../core/persistence";

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));

function modelUrl(): string | null {
  const q = new URLSearchParams(location.search);
  const model = q.get("model");
  if (model) return model;
  const example = q.get("example");
  if (example) return `${import.meta.env.BASE_URL}examples/${encodeURIComponent(example)}.json`;
  return null;
}

/** One bounded parameter as a slider (min&max) or a dropdown (value list). */
function Control({ name, value, expr, min, max, values }: { name: string; value: number; expr: string; min?: number; max?: number; values?: number[] }) {
  const setParameterExpr = useStore((s) => s.setParameterExpr);
  const label = <span className="cz-row-name" title={expr}>{name}</span>;
  if (values && values.length) {
    return (
      <label className="cz-row">
        {label}
        <select className="cz-select" value={values.some((v) => Math.abs(v - value) < 1e-9) ? String(value) : ""} onChange={(e) => setParameterExpr(name, e.target.value)}>
          {!values.some((v) => Math.abs(v - value) < 1e-9) && <option value="">{fmt(value)}…</option>}
          {values.map((v) => <option key={v} value={String(v)}>{fmt(v)}</option>)}
        </select>
      </label>
    );
  }
  const span = (max! - min!);
  const step = span >= 20 ? 1 : span >= 2 ? 0.1 : 0.01;
  return (
    <label className="cz-row">
      {label}
      <input className="cz-range" type="range" min={min} max={max} step={step} value={Math.min(max!, Math.max(min!, value))} onChange={(e) => setParameterExpr(name, e.target.value)} />
      <span className="cz-row-val">{fmt(value)}</span>
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

export function CustomizeApp() {
  const loadDocument = useStore((s) => s.loadDocument);
  const ensureKernel = useStore((s) => s.ensureKernel);
  const runMotionStudy = useStore((s) => s.runMotionStudy);
  const cancelMotionStudy = useStore((s) => s.cancelMotionStudy);
  const rev = useStore((s) => s.rev);
  const params = useStore((s) => s.session.doc.parameters);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(true);
  const dwell = useRef<ReturnType<typeof setTimeout>>();

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
      } catch (e) {
        setError((e as Error).message);
        setState("error");
      }
    })();
  }, [ensureKernel, loadDocument]);

  // After a stable dwell on a configuration, run the motion study. Any change
  // resets it (back to "not checked") so the preview stays responsive.
  useEffect(() => {
    if (state !== "ready") return;
    cancelMotionStudy();
    clearTimeout(dwell.current);
    dwell.current = setTimeout(() => void runMotionStudy(), 700);
    return () => clearTimeout(dwell.current);
  }, [rev, state, cancelMotionStudy, runMotionStudy]);

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
              {bounded.map((p) => <Control key={p.id} name={p.name} value={p.value} expr={p.expr} min={p.min} max={p.max} values={p.values} />)}
            </div>
          )}
        </div>
      )}
      {state === "loading" && <div className="cz-overlay">Loading…</div>}
      {state === "error" && <div className="cz-overlay error">{error}</div>}
    </div>
  );
}
