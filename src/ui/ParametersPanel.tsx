import { useEffect, useState } from "react";
import { useStore } from "../model/store";
import { isValidParamName } from "../core/parameters";
import type { Parameter } from "../core/document";
import { askChoice, askText } from "./kit/askDialog";
import { parameterUses } from "../core/parameterRename";
import { listWords } from "../sketch/types";

/** Delete a parameter, asking first when something uses it: list the users, and offer to keep its value in them
 *  (so nothing collapses) or to delete it anyway. Unused, it goes at once (undo brings it back). */
export async function confirmDeleteParameter(name: string): Promise<void> {
  const st = useStore.getState();
  const p = st.session.doc.parameters.find((x) => x.name === name);
  if (!p) return;
  const uses = parameterUses(st.session.doc, name);
  if (!uses.length) { await st.deleteParameter(name); return; }
  const shown = uses.slice(0, 6).map((u) => u.what);
  const more = uses.length > shown.length ? [`${uses.length - shown.length} more`] : [];
  const value = fmt(p.value);
  const choice = await askChoice({
    title: `Delete ${name}?`,
    text: `${name} (${value}) is used by ${listWords([...shown, ...more])}. Keep ${value} where it is used, or delete it and leave those without a value?`,
    confirmLabel: `Delete, keep ${value}`,
    alternateLabel: "Delete anyway",
  });
  if (choice === "confirm") await useStore.getState().deleteParameter(name, { inline: true });
  else if (choice === "alternate") await useStore.getState().deleteParameter(name);
}

/** Whether a parameter gets a slider: it has both extents (and isn't a switch or a list). */
const hasSlider = (p: Parameter) => !p.boolean && !p.values?.length && p.min != null && p.max != null;

/** The control shown in a parameter's row: a checkbox for a yes/no switch, a dropdown when it has named
 *  choices or a list of acceptable values, else the expression field. A parameter with both extents also
 *  gets a slider on its own full-width line under the row (`ParamSlider`). */
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
        {p.values.map((v) => <option key={v} value={String(v)}>{p.options?.[v] ?? fmt(v)}</option>)}
      </select>
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

/** A bounded parameter's slider, the full width of the panel, with its extents at the ends. */
function ParamSlider({ p }: { p: Parameter }) {
  const setParameterExpr = useStore((s) => s.setParameterExpr);
  const min = p.min!, max = p.max!, span = max - min;
  const step = span >= 20 ? 1 : span >= 2 ? 0.1 : 0.01;
  return (
    <div className="param-slider">
      <span className="param-slider-end">{fmt(min)}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, p.value))}
        aria-label={p.name}
        onChange={(e) => setParameterExpr(p.name, e.target.value)}
      />
      <span className="param-slider-end">{fmt(max)}</span>
    </div>
  );
}

/** Inline editor for a parameter's extents: unbounded, a min/max range, a
 *  comma-separated list of acceptable values (never both), a checkbox, or named
 *  choices. */
function BoundsEditor({ p, onClose }: { p: Parameter; onClose: () => void }) {
  const setParameterBounds = useStore((s) => s.setParameterBounds);
  const initial: "none" | "range" | "list" | "boolean" | "options" = p.boolean ? "boolean" : p.options?.length ? "options" : p.values?.length ? "list" : (p.min != null || p.max != null) ? "range" : "none";
  const [mode, setMode] = useState(initial);
  const [min, setMin] = useState(p.min != null ? String(p.min) : "");
  const [max, setMax] = useState(p.max != null ? String(p.max) : "");
  const [list, setList] = useState(p.values?.join(", ") ?? "");
  const [names, setNames] = useState(p.options?.join(", ") ?? "");

  const apply = () => {
    if (mode === "none") setParameterBounds(p.name, { clear: true });
    else if (mode === "boolean") setParameterBounds(p.name, { boolean: true });
    else if (mode === "options") {
      const opts = names.split(",").map((s) => s.trim()).filter(Boolean);
      if (opts.length < 2 || new Set(opts).size !== opts.length) return; // needs two or more distinct names
      setParameterBounds(p.name, { options: opts });
    }
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
        {(["none", "range", "list", "boolean", "options"] as const).map((m) => (
          <button key={m} className={`chip ${mode === m ? "active" : ""}`} onClick={() => setMode(m)}>
            {m === "none" ? "Unbounded" : m === "range" ? "Range" : m === "list" ? "Values" : m === "boolean" ? "Checkbox" : "Choices"}
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
      {mode === "options" && (
        <>
          <div className="param-bounds-fields">
            <input type="text" placeholder="e.g. PLA, PETG, TPU" value={names} onChange={(e) => setNames(e.target.value)} />
          </div>
          <div className="param-bounds-note">A dropdown of names; the value is the chosen one's index (0, 1, 2…). Use it with <code>pick</code>, e.g. <code>pick({p.name}, 0.8, 1.1, 1.4)</code>.</div>
        </>
      )}
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
  const [editing, setEditing] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  // a new parameter's name is ready to type over once its row is there (M17)
  const [focusName, setFocusName] = useState<string | null>(null);
  useEffect(() => {
    if (!focusName) return;
    const el = document.querySelector<HTMLInputElement>(`.param-name[data-name="${focusName}"]`);
    if (el) { el.focus(); el.select(); setFocusName(null); }
  });

  const hiddenCount = session.doc.parameters.filter((p) => p.hidden).length;
  const parameters = showHidden ? session.doc.parameters : session.doc.parameters.filter((p) => !p.hidden);

  return (
    <div className="panel parameters">
      <div className="panel-head">
        <span>Parameters</span>
        <button className="icon-btn" title="Add parameter" aria-label="Add parameter" onClick={() => void addParameter("d").then((n) => setFocusName(n))}>＋</button>
      </div>
      <div className="param-table">
        <div className="param-row header">
          <span>Name</span>
          <span>Value</span>
          <span>Current</span>
          <span />
        </div>
        {parameters.length === 0 && !hiddenCount && <div className="param-empty">No parameters yet.</div>}
        {hiddenCount > 0 && (
          <button className="param-hidden-toggle" onClick={() => setShowHidden((v) => !v)} title="Intermediate values the model computes (e.g. a linkage's joint positions)">
            {showHidden ? `Hide ${hiddenCount} intermediate values` : `+ ${hiddenCount} intermediate values`}
          </button>
        )}
        {parameters.map((p) => (
          <div key={p.id}>
            <div className={`param-row ${p.error ? "error" : p.warning ? "warn" : ""}`}>
              <input
                className="param-name"
                aria-label={`Name of ${p.name}`}
                data-name={p.name}
                defaultValue={p.name}
                key={`n${p.id}${p.name}`}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== p.name && isValidParamName(v)) renameParameter(p.name, v);
                  else e.target.value = p.name;
                }}
                // Enter commits the name, Escape puts the old one back (M17)
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  else if (e.key === "Escape") { (e.target as HTMLInputElement).value = p.name; (e.target as HTMLInputElement).blur(); }
                }}
              />
              <ParamControl p={p} />
              <span className={`param-value ${p.configuredBy ? "configured" : ""}`} title={p.error || p.warning || (p.configuredBy ? `From configuration ${p.configuredBy} (default: ${p.baseExpr})` : "")}>
                {p.error ? "⚠" : p.warning ? `⚠ ${fmt(p.value)}` : fmt(p.value)}
              </span>
              <span className="param-row-btns">
                <button
                  className={`icon-btn ${editing === p.id ? "active" : ""}`}
                  title="Set extents / acceptable values"
                  onClick={() => setEditing(editing === p.id ? null : p.id)}
                >⋯</button>
                <button className="icon-btn danger" title="Delete" aria-label={`Delete ${p.name}`} onClick={() => void confirmDeleteParameter(p.name)}>✕</button>
              </span>
            </div>
            {hasSlider(p) && <ParamSlider p={p} />}
            {editing === p.id && <BoundsEditor p={p} onClose={() => setEditing(null)} />}
          </div>
        ))}
      </div>
      <div className="param-foot">
        Use names in dimensions, e.g. <code>width</code>, <code>width/2</code>, <code>rad(30)</code>. Set a
        range or value list with <code>⋯</code> for a slider or dropdown.
      </div>
      <ConfigurationsTable />
    </div>
  );
}

/** Parse a pasted table (CSV or tab-separated): a header row "name, param, param…"
 *  then one row per configuration. Empty cells are left out. */
export function parseConfigTable(text: string): { name: string; values: Record<string, string> }[] {
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(/\t|,/).map((c) => c.trim()));
  if (rows.length < 2) return [];
  const [head, ...body] = rows;
  return body.filter((r) => r[0]).map((r) => ({
    name: r[0],
    values: Object.fromEntries(head.slice(1).map((h, i) => [h, r[i + 1] ?? ""]).filter(([h, v]) => h && v)),
  }));
}

/** The values a new configuration captures: the parameters a person tunes (bounded, a switch or a choice; not
 *  hidden), else every plain-number one — not every expression, so a new column per parameter doesn't push
 *  the grid off screen. Numbers as the store writes them. */
export function configurationCapture(params: { name: string; expr: string; value: number; min?: number; max?: number; values?: number[]; boolean?: boolean; options?: string[]; hidden?: boolean }[]): Record<string, string> {
  const shown = params.filter((p) => !p.hidden);
  const tuned = shown.filter((p) => (p.min != null && p.max != null) || p.values || p.boolean || p.options);
  const plain = shown.filter((p) => /^\s*-?(\d+\.?\d*|\.\d+)\s*$/.test(p.expr));
  const pick = tuned.length ? tuned : plain;
  return Object.fromEntries(pick.map((p) => [p.name, Number.isInteger(p.value) ? String(p.value) : String(Math.round(p.value * 1e6) / 1e6)]));
}

/**
 * The configuration table: one row per design variant plus "Default" (the
 * timeline's own values), one column per parameter any row overrides. The
 * radio switches the active configuration; cells are expressions (empty = use
 * the default); pasting CSV adds or updates rows by name.
 */
function ConfigurationsTable() {
  const session = useStore((s) => s.session);
  useStore((s) => s.rev);
  const setActive = useStore((s) => s.setActiveConfiguration);
  const create = useStore((s) => s.createConfiguration);
  const update = useStore((s) => s.updateConfiguration);
  const remove = useStore((s) => s.deleteConfiguration);
  const [extraCols, setExtraCols] = useState<string[]>([]);
  const [pasting, setPasting] = useState(false);
  const [paste, setPaste] = useState("");
  const doc = session.doc;
  const configs = doc.configurations ?? [];
  const params = doc.parameters;
  const cols = [...new Set([...configs.flatMap((c) => Object.keys(c.values)), ...extraCols])];
  const base = (name: string) => { const p = params.find((x) => x.name === name); return p ? p.baseExpr ?? p.expr : "—"; };
  const addable = params.map((p) => p.name).filter((n) => !cols.includes(n));

  const commitCell = (ref: string, name: string, value: string, was: string | undefined) => {
    const v = value.trim();
    if (v === (was ?? "")) return;
    void update(ref, { values: { [name]: v === "" ? null : v } });
  };
  const applyPaste = async () => {
    for (const row of parseConfigTable(paste)) {
      const existing = configs.find((c) => c.name === row.name);
      if (existing) await update(existing.id, { values: row.values });
      else await create(row.name, row.values);
    }
    setPaste(""); setPasting(false);
  };

  return (
    <div className="config-table">
      <div className="panel-head sub">
        <span>Configurations</span>
        <span className="param-row-btns">
          {configs.length > 0 && addable.length > 0 && (
            <select className="config-add" value="" aria-label="Add a parameter column" title="Add a parameter column" onChange={(e) => e.target.value && setExtraCols([...extraCols, e.target.value])}>
              <option value="">＋ Column</option>
              {addable.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
          <button className="config-text-btn" title="Paste a table (CSV / tab-separated): header “name, param…”, one row per configuration" aria-pressed={pasting} onClick={() => setPasting(!pasting)}>Paste table</button>
          <button className="icon-btn" aria-label="New configuration" title="Save the current values of the parameters you tune (bounded, switches, choices) as a new configuration" onClick={() => {
            void askText({ title: "New configuration", label: "Name", initial: `Config ${configs.length + 1}`, confirmLabel: "Create" }).then((name) => { if (name) void create(name, configurationCapture(params)); });
          }}>＋</button>
        </span>
      </div>
      {pasting && (
        <div className="config-paste">
          <textarea rows={4} placeholder={"name,width,height\nSmall,40,20\nLarge,80,40"} value={paste} onChange={(e) => setPaste(e.target.value)} />
          <div className="param-bounds-actions">
            <button className="btn ghost" onClick={() => setPasting(false)}>Cancel</button>
            <button className="btn primary" onClick={() => void applyPaste()}>Apply</button>
          </div>
        </div>
      )}
      {configs.length === 0 && !pasting ? (
        <div className="param-empty">No configurations. ＋ saves the values of the parameters you tune as one.</div>
      ) : (
        // each column keeps a readable width; the grid scrolls sideways rather than squeezing them
        <div className="config-grid" style={{ gridTemplateColumns: `18px minmax(84px, max-content) repeat(${cols.length}, minmax(64px, 96px)) minmax(64px, 96px) 22px` }}>
          <span /><span className="config-head">Name</span>
          {cols.map((c) => <span key={c} className="config-head" title={`${c} · default: ${base(c)}`}>{c}</span>)}
          <span className="config-head" title="Bodies (feature ids), sketches or components hidden while this configuration is active, comma-separated">hide</span>
          <span />

          <input type="radio" name="active-config" checked={!doc.activeConfiguration} onChange={() => void setActive(null)} title="Use the timeline's own values" />
          <span className="config-name default">Default</span>
          {cols.map((c) => <span key={c} className="config-cell default" title={base(c)}>{base(c)}</span>)}
          <span className="config-cell default">—</span>
          <span />

          {configs.map((cfg) => (
            <div key={cfg.id} className={`config-row ${cfg.warnings ? "warn" : ""}`} style={{ display: "contents" }}>
              <input type="radio" name="active-config" checked={doc.activeConfiguration === cfg.id} onChange={() => void setActive(cfg.id)} title={`Make ${cfg.name} active`} />
              <input
                className="config-name"
                defaultValue={cfg.name}
                key={`n${cfg.id}${cfg.name}`}
                title={cfg.warnings?.join("; ") || cfg.name}
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== cfg.name) void update(cfg.id, { name: v }); else e.target.value = cfg.name; }}
              />
              {cols.map((c) => (
                <input
                  key={`${c}${cfg.values[c] ?? ""}`}
                  className="config-cell"
                  defaultValue={cfg.values[c] ?? ""}
                  placeholder={base(c)}
                  onBlur={(e) => commitCell(cfg.id, c, e.target.value, cfg.values[c])}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                />
              ))}
              <input
                key={`hide${(cfg.hide ?? []).join(",")}`}
                className="config-cell"
                defaultValue={(cfg.hide ?? []).join(", ")}
                placeholder="none"
                title="Ids hidden while active (bodies by feature id, sketches, components)"
                onBlur={(e) => {
                  const ids = e.target.value.split(",").map((x) => x.trim()).filter(Boolean);
                  if (ids.join(",") !== (cfg.hide ?? []).join(",")) void update(cfg.id, { hide: ids });
                }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              />
              <button className="icon-btn danger" title={`Delete ${cfg.name}`} onClick={() => void remove(cfg.id)}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));
