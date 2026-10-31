// The intent line's grammar: what someone typed → ranked suggestions, each
// carrying a serialisable action. Pure (no React, no store): the component
// maps actions to store calls through execute.ts, so this is tested in Node.
//
// Grammar (case-insensitive, fuzzy on names):
//   <param> <number> | <param> = <number>         set a document parameter
//   <feature> <param label> <number>              edit one feature param
//   <feature> <number>                            … when the feature has one param
//   <param label> <number>                        … on every feature with that label ("wall 5")
//   front|top|right|iso|back|left|bottom          view;  fit|frame → frame
//   back to <feature> | roll <n> | roll end       move the rollback marker
//   suppress <feature> | unsuppress [<feature>]   suppress / unsuppress
//   undo | redo
//   measure <feature> | <feature>                 open the feature's card
//   ledger|space|lens|workbench                   toggle a concept panel
//   <lhs> <=|>=|==|<|> <rhs>                      add a design intent
//   <hotkey action label>                         run that action

import type { FeatureRow } from "../../../model/concepts/featureCatalog";
import { paramsWith, unitLabel } from "../../../model/concepts/featureCatalog";
import { intentText, parseIntent, type Comparator, type Intent } from "../../../model/concepts/intents";
import type { ConceptPanel } from "../../../model/concepts/uiState";
import { quantize, formatValue } from "../../kit/numberMath";

export const VIEWS = ["iso", "front", "top", "right", "back", "left", "bottom"] as const;
export type ViewName = (typeof VIEWS)[number];
export const PANELS: ConceptPanel[] = ["workbench", "ledger", "space", "lens"];

export interface ParamInfo { name: string; value: number; min?: number; max?: number; step?: number }

export interface IntentCtx {
  rows: FeatureRow[];
  params: ParamInfo[];
  views: readonly string[];
  /** From hotkeys.describe(), flattened. */
  actions: { id: string; label: string }[];
  /** Existing design intents as text ("mass <= 120"), so a duplicate is said so. */
  intents: string[];
  /** Length of the whole timeline: where "roll end" goes (after every op, not only the last feature). */
  timelineLength: number;
}

export interface HotkeyContext { active: boolean; actions: { id: string; label: string }[] }

/** What the resolver can see, built from the open document, the active hotkey contexts and the shared intents. */
export function buildCtx(
  session: { doc: { parameters: { name: string; value: number; min?: number; max?: number; step?: number }[] }; timeline: unknown[] },
  rows: FeatureRow[],
  contexts: HotkeyContext[],
  intents: Intent[],
): IntentCtx {
  return {
    rows,
    params: session.doc.parameters.map((p) => ({ name: p.name, value: p.value, min: p.min, max: p.max, step: p.step })),
    views: VIEWS,
    actions: contexts.flatMap((c) => (c.active ? c.actions.map((a) => ({ id: a.id, label: a.label })) : [])),
    intents: intents.map(intentText),
    timelineLength: session.timeline.length,
  };
}

export type IntentAction =
  | { type: "setParameter"; name: string; expr: string }
  | { type: "editOperation"; opId: string; params: Record<string, unknown> }
  | { type: "view"; view: string }
  | { type: "frame" }
  | { type: "rollback"; index: number }
  | { type: "suppress"; opId: string; suppressed: boolean }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "openFeature"; featureId: string }
  | { type: "togglePanel"; panel: ConceptPanel }
  | { type: "addIntent"; label: string; lhs: string; op: Comparator; rhs: string }
  | { type: "hotkey"; id: string };

export type SuggestionKind = "param" | "feature" | "view" | "history" | "panel" | "intent" | "action";

export interface Suggestion {
  /** Stable within one resolve (for aria-activedescendant). */
  id: string;
  label: string;
  detail: string;
  kind: SuggestionKind;
  action: IntentAction;
  /** The status-bar line once it has run. */
  message: string;
  /** 0..1, higher first. */
  score: number;
}

export const MAX_SUGGESTIONS = 8;

// ---- matching ----

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const squash = (s: string) => norm(s).replace(/ /g, "");

/** How well `query` names `candidate`: 1 exact, ~0.8–1 prefix, ~0.6 word-prefix, ~0.3–0.5 subsequence, 0 none. */
export function fuzzy(query: string, candidate: string): number {
  const q = squash(query), c = squash(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  const ratio = q.length / c.length;
  if (c.startsWith(q)) return 0.8 + 0.2 * ratio;
  if (norm(candidate).split(" ").some((w) => w.startsWith(q))) return 0.6 + 0.15 * ratio;
  // subsequence: every query char appears in order
  let i = 0;
  for (const ch of c) if (ch === q[i]) i++;
  if (i === q.length) return 0.3 + 0.2 * ratio;
  return 0;
}

/** "12", "12mm", "-1.5", "30deg", "30°", "2,5" → the number; null when it isn't one. */
export function parseNumber(text: string): number | null {
  const core = text.trim().replace(/,/g, ".").replace(/\s*(mm|deg|°|g|cm3|cm³)$/i, "").trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(core)) return null;
  const n = Number(core);
  return Number.isFinite(n) ? n : null;
}

/** Split into lowercase words; "=" becomes its own token; a trailing unit joins its number. */
export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().replace(/=/g, " = ").split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const t of raw) {
    const prev = out[out.length - 1];
    if (/^(mm|deg|°)$/.test(t) && prev != null && parseNumber(prev) != null) out[out.length - 1] = prev + t;
    else out.push(t);
  }
  return out;
}

const unitSuffix = (unit: string) => { const u = unitLabel(unit); return u === "°" ? u : u ? ` ${u}` : ""; };

/** Match a feature by its number ("2"), its name ("Upright wall") or its kind ("extrude"). */
function matchRow(query: string, rows: FeatureRow[]): { row: FeatureRow; score: number }[] {
  const n = parseNumber(query);
  const out: { row: FeatureRow; score: number }[] = [];
  for (const row of rows) {
    if (n != null) { if (row.num === n) out.push({ row, score: 1 }); continue; }
    const s = Math.max(fuzzy(query, row.name), fuzzy(query, row.spec.label) * 0.95, fuzzy(query, `${row.spec.label} ${row.num}`));
    if (s > 0) out.push({ row, score: s });
  }
  return out;
}

const rowState = (row: FeatureRow) => (row.suppressed ? " (suppressed)" : row.rolledBack ? " (rolled back)" : "");

// ---- the resolver ----

export function resolve(text: string, ctx: IntentCtx): Suggestion[] {
  const out: Suggestion[] = [];
  const add = (s: Omit<Suggestion, "id">) => { if (s.score > 0) out.push({ ...s, id: `intent-${out.length}` }); };
  const trimmed = text.trim();
  const tokens = tokenize(trimmed);
  if (!tokens.length) return [];

  // A design intent: any real comparator (a lone "=" is assignment, handled below).
  if (/(<=|>=|==|<|>)/.test(trimmed)) {
    const intent = parseIntent(trimmed, "new");
    const side = /^[^<>=]+$/; // each side must be an expression, not a dangling comparator
    if (intent && side.test(intent.lhs) && side.test(intent.rhs)) {
      const dup = ctx.intents.some((t) => norm(t) === norm(`${intent.lhs} ${intent.op} ${intent.rhs}`));
      add({ kind: "intent", score: 0.95, action: { type: "addIntent", label: intent.label, lhs: intent.lhs, op: intent.op, rhs: intent.rhs },
        label: `Keep ${intent.lhs} ${intent.op} ${intent.rhs}`, detail: dup ? "Already an intent in the Ledger" : "Add a design intent to the Ledger",
        message: `Intent added: ${intent.lhs} ${intent.op} ${intent.rhs}` });
    }
    return rank(out);
  }

  const last = tokens[tokens.length - 1];
  const number = tokens.length >= 2 ? parseNumber(last) : null;
  const head = tokens.slice(0, -1).filter((t) => t !== "=");
  const first = tokens[0];
  const rest = tokens.slice(1).join(" ");

  // ---- history: back to <feature> | roll <n> | roll end ----
  if ((first === "back" && tokens[1] === "to") || first === "roll" || first === "rollback") {
    const target = first === "back" ? tokens.slice(2).join(" ") : rest;
    const lastRow = ctx.rows[ctx.rows.length - 1];
    if (!target || target === "end" || target === "all") {
      if (lastRow) add({ kind: "history", score: target ? 1 : 0.7, action: { type: "rollback", index: ctx.timelineLength }, label: "Roll to the end", detail: "Build every feature", message: "Rolled to the end of the history." });
    } else {
      for (const m of matchRow(target, ctx.rows)) {
        add({ kind: "history", score: m.score, action: { type: "rollback", index: m.row.index + 1 }, label: `Back to ${m.row.num} · ${m.row.name}`,
          detail: `Features after it stay as ghosts${rowState(m.row)}`, message: `Rolled back to ${m.row.name}.` });
      }
    }
  }

  // ---- suppress / unsuppress ----
  if (first === "suppress" || first === "unsuppress") {
    const on = first === "suppress";
    const matches = rest ? matchRow(rest, ctx.rows) : ctx.rows.filter((r) => r.suppressed !== on).map((row) => ({ row, score: 0.7 }));
    for (const m of matches) {
      if (m.row.suppressed === on) continue;
      add({ kind: "history", score: m.score, action: { type: "suppress", opId: m.row.opId, suppressed: on }, label: `${on ? "Suppress" : "Unsuppress"} ${m.row.num} · ${m.row.name}`,
        detail: on ? "Skip it when building" : "Build it again", message: `${on ? "Suppressed" : "Unsuppressed"} ${m.row.name}.` });
    }
  }

  // ---- measure <feature> / <feature> alone → open its card ----
  if (first === "measure" || first === "open" || first === "show") {
    if (rest) for (const m of matchRow(rest, ctx.rows)) {
      add({ kind: "feature", score: m.score, action: { type: "openFeature", featureId: m.row.featureId }, label: `${first === "measure" ? "Measure" : "Open"} ${m.row.num} · ${m.row.name}`,
        detail: `Open its card on the part${rowState(m.row)}`, message: `Opened ${m.row.name}.` });
    }
  } else if (number == null) {
    for (const m of matchRow(trimmed, ctx.rows)) {
      add({ kind: "feature", score: m.score * 0.85, action: { type: "openFeature", featureId: m.row.featureId }, label: `Open ${m.row.num} · ${m.row.name}`,
        detail: `${m.row.spec.label}${rowState(m.row)}`, message: `Opened ${m.row.name}.` });
    }
  }

  // ---- numbers: parameters and feature params ----
  if (number != null && head.length) {
    const headText = head.join(" ");
    for (const p of ctx.params) {
      const s = fuzzy(headText, p.name);
      if (!s) continue;
      const range = p.min != null && p.max != null ? ` (${p.min}–${p.max})` : "";
      const outside = (p.min != null && number < p.min) || (p.max != null && number > p.max);
      add({ kind: "param", score: s, action: { type: "setParameter", name: p.name, expr: String(number) }, label: `${p.name} = ${number}`,
        detail: `Parameter, now ${p.value}${range}${outside ? " — outside its bounds" : ""}`, message: `Set ${p.name} to ${number}.` });
    }
    for (const row of ctx.rows) {
      const edits = new Map<string, number>(); // param key → best score
      // explicit feature then label: "extrude 1 distance 12", "2 radius 3", "fillet 3"
      for (let k = 1; k <= head.length; k++) {
        const fm = matchRow(head.slice(0, k).join(" "), [row])[0];
        if (!fm) continue;
        const labelText = head.slice(k).join(" ");
        if (!labelText) {
          if (row.spec.params.length === 1) edits.set(row.spec.params[0].key, Math.max(edits.get(row.spec.params[0].key) ?? 0, fm.score));
          continue;
        }
        for (const p of row.spec.params) {
          const ps = Math.max(fuzzy(labelText, p.label), fuzzy(labelText, p.key));
          if (ps) edits.set(p.key, Math.max(edits.get(p.key) ?? 0, fm.score * ps));
        }
      }
      // label alone, feature omitted: "wall 5", "radius 3" (an exact label still beats a prefix of a parameter name)
      for (const p of row.spec.params) {
        const ps = Math.max(fuzzy(headText, p.label), fuzzy(headText, p.key)) * 0.97;
        if (ps) edits.set(p.key, Math.max(edits.get(p.key) ?? 0, ps));
      }
      for (const [key, score] of edits) {
        const spec = row.spec.params.find((p) => p.key === key)!;
        const value = quantize(number, spec);
        const shown = formatValue(value, spec) + unitSuffix(spec.unit);
        const now = Number.isFinite(row.values[key]) ? formatValue(row.values[key], spec) + unitSuffix(spec.unit) : row.exprs[key] ?? "—";
        add({ kind: "feature", score, action: { type: "editOperation", opId: row.opId, params: paramsWith(row, key, value) },
          label: `${row.num} · ${row.name} · ${spec.label} → ${shown}`, detail: `Now ${now}${value !== number ? `, ${number} snapped to ${shown}` : ""}${rowState(row)}`,
          message: `${row.num} · ${row.name}: ${spec.label.toLowerCase()} ${shown}.` });
      }
    }
  }

  // ---- views ----
  for (const v of ctx.views) {
    const s = fuzzy(trimmed, v);
    if (s) add({ kind: "view", score: s, action: { type: "view", view: v }, label: `View ${v}`, detail: "Turn the camera", message: `View: ${v}.` });
  }
  for (const w of ["fit", "frame"]) {
    const s = fuzzy(trimmed, w);
    if (s) add({ kind: "view", score: s, action: { type: "frame" }, label: "Fit the view", detail: "Frame the selection or the whole part", message: "Framed." });
  }

  // ---- undo / redo ----
  for (const w of ["undo", "redo"] as const) {
    const s = fuzzy(trimmed, w);
    if (s) add({ kind: "history", score: s, action: { type: w }, label: w === "undo" ? "Undo" : "Redo", detail: w === "undo" ? "Take back the last change" : "Put the last change back", message: w === "undo" ? "Undone." : "Redone." });
  }

  // ---- panels ----
  for (const p of PANELS) {
    const s = fuzzy(trimmed, p);
    if (s) add({ kind: "panel", score: s * 0.98, action: { type: "togglePanel", panel: p }, label: `Toggle ${p[0].toUpperCase()}${p.slice(1)}`, detail: "Show or hide the panel", message: `Toggled ${p}.` });
  }

  // ---- hotkey actions, except those the grammar already covers ----
  for (const a of ctx.actions) {
    if (/^(view\.|edit\.undo|edit\.redo|intent\.)/.test(a.id)) continue;
    const s = fuzzy(trimmed, a.label) * 0.9;
    if (s) add({ kind: "action", score: s, action: { type: "hotkey", id: a.id }, label: a.label, detail: `Run ${a.id}`, message: `${a.label}.` });
  }

  return rank(out);
}

function rank(list: Suggestion[]): Suggestion[] {
  return list
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, MAX_SUGGESTIONS)
    .map((s, i) => ({ ...s, id: `intent-${i}` }));
}

/** Move the listbox selection by `delta`, wrapping (an `if` about numbers, so it lives here). */
export function moveSelection(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((current + delta) % count) + count) % count;
}
