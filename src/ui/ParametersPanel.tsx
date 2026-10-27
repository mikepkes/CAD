import { useState } from "react";
import { useStore } from "../model/store";
import { isValidParamName } from "../model/parameters";
import type { Parameter } from "../core/document";

/** The control shown for a parameter's value: a checkbox for a yes/no switch, a dropdown when it has a list of
 *  acceptable values, a slider when it has both extents, else the raw
 *  expression field. (This is the control the future customize mode reuses.) */
function ParamControl({ p }: { p: Parameter }) {
  const setParameterExpr = useStore((s) => s.setParameterExpr);
  if (p.boolean) {
    return <input type="checkbox" className="param-check" checked={p.value !== 0} onChange={(e) => setParameterExpr(p.name, e.target.checked ? "1" : "0")} />;
  }
  if (p.values && p.values.length) {
    return (
      <select
        className="param-expr"
        value={p.values.some((v) => Math.abs(v - p.value) < 1e-9) ? String(p.value) : ""}
        onChange={(e) => setParameterExpr(p.name, e.target.value)}
      >
        {!p.values.some((v) => Math.abs(v - p.value) < 1e-9) && <option value="">{fmt(p.value)}…</option>}
        {p.values.map((v) => <option key={v} value={String(v)}>{fmt(v)}</option>)}
      </select>
    );
  }
  if (p.min != null && p.max != null) {
    const span = p.max - p.min;
    const step = span >= 20 ? 1 : span >= 2 ? 0.1 : 0.01;
    return (
      <div className="param-slider">
        <input
          type="range"
          min={p.min}
          max={p.max}
          step={step}
          value={Math.min(p.max, Math.max(p.min, p.value))}
          onChange={(e) => setParameterExpr(p.name, e.target.value)}
        />
        <span className="param-slider-val">{fmt(p.value)}</span>
      </div>
    );
  }
  return (
    <input
      className="param-expr"
      defaultValue={p.expr}
      key={`e${p.id}${p.expr}`}
      onBlur={(e) => { if (e.target.value !== p.expr) setParameterExpr(p.name, e.target.value); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}

/** Inline editor for a parameter's extents: unbounded, a min/max range, a
 *  comma-separated list of acceptable values (never both), or a checkbox. */
function BoundsEditor({ p, onClose }: { p: Parameter; onClose: () => void }) {
  const setParameterBounds = useStore((s) => s.setParameterBounds);
  const initial: "none" | "range" | "list" | "boolean" = p.boolean ? "boolean" : p.values?.length ? "list" : (p.min != null || p.max != null) ? "range" : "none";
  const [mode, setMode] = useState(initial);
  const [min, setMin] = useState(p.min != null ? String(p.min) : "");
  const [max, setMax] = useState(p.max != null ? String(p.max) : "");
  const [list, setList] = useState(p.values?.join(", ") ?? "");

  const apply = () => {
    if (mode === "none") setParameterBounds(p.name, { clear: true });
    else if (mode === "boolean") setParameterBounds(p.name, { boolean: true });
    else if (mode === "range") {
      const mn = min.trim() === "" ? undefined : Number(min);
      const mx = max.trim() === "" ? undefined : Number(max);
      if ((mn != null && !Number.isFinite(mn)) || (mx != null && !Number.isFinite(mx))) return;
      if (mn == null && mx == null) setParameterBounds(p.name, { clear: true });
      else setParameterBounds(p.name, { min: mn, max: mx });
    } else {
      const vals = list.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
      if (!vals.length) { setParameterBounds(p.name, { clear: true }); }
      else setParameterBounds(p.name, { values: vals });
    }
    onClose();
  };

  return (
    <div className="param-bounds">
      <div className="param-bounds-modes">
        {(["none", "range", "list", "boolean"] as const).map((m) => (
          <button key={m} className={`chip ${mode === m ? "active" : ""}`} onClick={() => setMode(m)}>
            {m === "none" ? "Unbounded" : m === "range" ? "Range" : m === "list" ? "Values" : "Checkbox"}
          </button>
        ))}
      </div>
      {mode === "range" && (
        <div className="param-bounds-fields">
          <input type="number" placeholder="min" value={min} onChange={(e) => setMin(e.target.value)} />
          <input type="number" placeholder="max" value={max} onChange={(e) => setMax(e.target.value)} />
        </div>
      )}
      {mode === "boolean" && <div className="param-bounds-note">A yes/no switch: 1 when checked, 0 when not. Use it in expressions, e.g. a count of <code>1 + {p.name}</code>.</div>}
      {mode === "list" && (
        <div className="param-bounds-fields">
          <input type="text" placeholder="e.g. 3, 4, 5, 6, 8" value={list} onChange={(e) => setList(e.target.value)} />
        </div>
      )}
      <div className="param-bounds-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={apply}>Apply</button>
      </div>
    </div>
  );
}

export function ParametersPanel() {
  const session = useStore((s) => s.session);
  useStore((s) => s.rev);
  const addParameter = useStore((s) => s.addParameter);
  const renameParameter = useStore((s) => s.renameParameter);
  const deleteParameter = useStore((s) => s.deleteParameter);
  const [editing, setEditing] = useState<string | null>(null);

  const parameters = session.doc.parameters;

  return (
    <div className="panel parameters">
      <div className="panel-head">
        <span>Parameters</span>
        <button className="icon-btn" title="Add parameter" onClick={() => addParameter("d")}>＋</button>
      </div>
      <div className="param-table">
        <div className="param-row header">
          <span>Name</span>
          <span>Value</span>
          <span>Current</span>
          <span />
        </div>
        {parameters.length === 0 && <div className="param-empty">No parameters yet.</div>}
        {parameters.map((p) => (
          <div key={p.id}>
            <div className={`param-row ${p.error ? "error" : p.warning ? "warn" : ""}`}>
              <input
                className="param-name"
                defaultValue={p.name}
                key={`n${p.id}${p.name}`}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== p.name && isValidParamName(v)) renameParameter(p.name, v);
                  else e.target.value = p.name;
                }}
              />
              <ParamControl p={p} />
              <span className="param-value" title={p.error || p.warning || ""}>
                {p.error ? "⚠" : p.warning ? `⚠ ${fmt(p.value)}` : fmt(p.value)}
              </span>
              <span className="param-row-btns">
                <button
                  className={`icon-btn ${editing === p.id ? "active" : ""}`}
                  title="Set extents / acceptable values"
                  onClick={() => setEditing(editing === p.id ? null : p.id)}
                >⋯</button>
                <button className="icon-btn danger" title="Delete" onClick={() => deleteParameter(p.name)}>✕</button>
              </span>
            </div>
            {editing === p.id && <BoundsEditor p={p} onClose={() => setEditing(null)} />}
          </div>
        ))}
      </div>
      <div className="param-foot">
        Use names in dimensions, e.g. <code>width</code>, <code>width/2</code>, <code>rad(30)</code>. Set a
        range or value list with <code>⋯</code> for a slider or dropdown.
      </div>
    </div>
  );
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));
