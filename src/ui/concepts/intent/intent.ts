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
//   pins|lens|ledger|space|materials|mechanism    toggle a concept panel (and their aliases)
//   <lhs> <=|>=|==|<|> <rhs>                      add a design intent
//   <hotkey action label or alias>                run that action (section, agent, settings, help…)
//   (nothing typed)                               the recent commands, then common ones

import type { FeatureRow } from "../../../model/concepts/featureCatalog";
import { paramsWith, unitLabel } from "../../../model/concepts/featureCatalog";
import { intentText, parseIntent, type Comparator, type Intent } from "../../../model/concepts/intents";
import { PANEL_NAMES, type ConceptPanel } from "../../../model/concepts/uiState";
import { quantize, formatValue } from "../../kit/numberMath";

export const VIEWS = ["iso", "front", "top", "right", "back", "left", "bottom"] as const;
export type ViewName = (typeof VIEWS)[number];
export const PANELS: ConceptPanel[] = ["workbench", "ledger", "space", "lens", "materials", "mechanism", "notes"];

/** The words people use for each panel: its switch's name first, then what else it is called or shows. */
export const PANEL_ALIASES: Record<ConceptPanel, string[]> = {
  workbench: ["pins", "workbench", "feature pins", "history strip"],
  lens: ["lens", "analysis", "zebra", "draft", "curvature", "x-ray", "overhang", "strain"],
  ledger: ["ledger", "intents", "sentences"],
  space: ["space", "design space", "map", "trade-off"],
  materials: ["materials", "material", "finish", "colour", "color"],
  mechanism: ["mechanism", "flexure", "force", "travel"],
  notes: ["notes", "note", "comments", "markup"],
  intent: [],
};

/** Other words for hotkey actions, so the palette knows the app's own names (toolbar buttons, dialog titles). */
export const ACTION_ALIASES: Record<string, string[]> = {
  "view.section": ["section", "cut", "cross section", "clip"],
  "app.agent": ["agent", "claude", "ask", "chat"],
  "app.settings": ["settings", "preferences", "api key", "theme"],
  "help.shortcuts": ["shortcuts", "help", "keys", "hotkeys", "keyboard"],
  "view.configurations": ["configurations", "configuration", "config", "variants"],
  "motion.study": ["motion", "motion study", "collisions"],
  "mechanism.sweep": ["sweep"],
};

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
  session: { doc: { parameters: { name: string; value: number; min?: number; max?: number; step?: number; hidden?: boolean }[] }; timeline: unknown[] },
  rows: FeatureRow[],
  contexts: HotkeyContext[],
  intents: Intent[],
): IntentCtx {
  return {
    rows,
    params: session.doc.parameters.filter((p) => !p.hidden).map((p) => ({ name: p.name, value: p.value, min: p.min, max: p.max, step: p.step })),
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

/** How well `query` names `candidate`, matching only at word starts (so "stl" never finds "Shuttle"): 1 exact,
 *  ~0.8–1 prefix, ~0.6 a word's prefix, ~0.55 words read together from a word start ("spacema" in "Design space map"), ~0.5 each
 *  query word starting a word in order ("des sp"), 0 none. */
export function fuzzy(query: string, candidate: string): number {
  const q = squash(query), c = squash(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  const ratio = q.length / c.length;
  if (c.startsWith(q)) return 0.8 + 0.2 * ratio;
  const words = norm(candidate).split(" ");
  if (words.some((w) => w.startsWith(q))) return 0.6 + 0.15 * ratio;
  for (let i = 1; i < words.length; i++) if (words.slice(i).join("").startsWith(q)) return 0.55 + 0.15 * ratio;
  const qw = norm(query).split(" ");
  if (qw.length > 1) {
    let k = 0;
    for (const w of words) if (k < qw.length && w.startsWith(qw[k])) k++;
    if (k === qw.length) return 0.5 + 0.15 * ratio;
  }
  return 0;
}

/** The best match of `query` among a name and its aliases, and which alias it was (null: the name itself). */
function bestOf(query: string, name: string, aliases: string[]): { score: number; alias: string | null } {
  let best = { score: fuzzy(query, name), alias: null as string | null };
  for (const a of aliases) {
    const sc = fuzzy(query, a) * 0.97;
    if (sc > best.score) best = { score: sc, alias: a };
  }
  return best;
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

  // ---- panels, by their switch's name or another word for them ----
  for (const p of PANELS) {
    const m = bestOf(trimmed, PANEL_NAMES[p], PANEL_ALIASES[p]);
    if (m.score) add(panelSuggestion(p, m.score * 0.98, m.alias));
  }

  // ---- hotkey actions (by label or alias), except those the grammar already covers ----
  for (const a of ctx.actions) {
    if (/^(view\.(frame|iso|front|top|right|back|left|bottom|workbench|lens|ledger|space|materials|mechanism)$|edit\.undo|edit\.redo|intent\.)/.test(a.id)) continue;
    const m = bestOf(trimmed, a.label, ACTION_ALIASES[a.id] ?? []);
    if (m.score) add({ kind: "action", score: m.score * 0.9, action: { type: "hotkey", id: a.id }, label: a.label, detail: m.alias ? `alias: ${m.alias}` : COMMON_DETAIL[a.id] ?? "Run it", message: `${a.label}.` });
  }

  return rank(out);
}

function panelSuggestion(p: ConceptPanel, score: number, alias: string | null = null): Omit<Suggestion, "id"> {
  const name = PANEL_NAMES[p];
  return { kind: "panel", score, action: { type: "togglePanel", panel: p }, label: `Toggle ${name}`, detail: alias && alias !== name.toLowerCase() ? `Show or hide the panel · alias: ${alias}` : "Show or hide the panel", message: `Toggled ${name}.` };
}

// ---- the empty line: recent and common commands ----

/** A command run from the palette, remembered for the empty line. */
export type RecentCommand = Pick<Suggestion, "label" | "detail" | "kind" | "action" | "message">;
export const MAX_RECENT = 4;

/** Put a command at the front of the recent list (once; the oldest falls off). */
export function remember(recent: RecentCommand[], s: RecentCommand): RecentCommand[] {
  const keep = { label: s.label, detail: s.detail, kind: s.kind, action: s.action, message: s.message };
  return [keep, ...recent.filter((r) => r.label !== s.label)].slice(0, MAX_RECENT);
}

/** The ids of the common commands offered when nothing is typed (each only while it can run). */
export const COMMON_ACTIONS = ["view.section", "app.agent", "help.shortcuts", "motion.study"];
const COMMON_DETAIL: Record<string, string> = {
  "view.section": "Clip the model on a plane to see inside",
  "app.agent": "Ask Claude to build or change the model",
  "help.shortcuts": "Every key, and what the action ring holds",
  "motion.study": "Check the joints move through their range without collisions",
};

/** What an empty palette offers: the recent commands, then the common ones (panels, fit, section, agent, help). */
export function emptySuggestions(ctx: IntentCtx, recent: RecentCommand[], can: (id: string) => boolean = () => true): (Suggestion & { group: "recent" | "common" })[] {
  const out: (Omit<Suggestion, "id"> & { group: "recent" | "common" })[] = [];
  for (const r of recent) out.push({ ...r, score: 1, group: "recent" });
  const common: Omit<Suggestion, "id">[] = [
    panelSuggestion("workbench", 1),
    { kind: "view", score: 1, action: { type: "frame" }, label: "Fit the view", detail: "Frame the selection or the whole part", message: "Framed." },
    ...COMMON_ACTIONS.flatMap((id) => {
      const a = ctx.actions.find((x) => x.id === id);
      return a && can(id) ? [{ kind: "action" as const, score: 1, action: { type: "hotkey" as const, id }, label: a.label, detail: COMMON_DETAIL[id] ?? "Run it", message: `${a.label}.` }] : [];
    }),
    panelSuggestion("ledger", 1),
  ];
  const seen = new Set(out.map((r) => r.label));
  for (const c of common) if (!seen.has(c.label)) out.push({ ...c, group: "common" });
  return out.slice(0, MAX_SUGGESTIONS).map((s, i) => ({ ...s, id: `intent-${i}` }));
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
