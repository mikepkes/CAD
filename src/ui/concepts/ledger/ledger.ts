// The Ledger's logic, apart from React: how a feature's sentence segments are
// prepared for rendering, the mass estimate beside each paragraph, the intents'
// glyphs and readouts, and the search for a parameter change that would make a
// failing intent pass. Everything here is tested in Node (test/ledger.test.ts);
// the .tsx files only template it. The intent list itself is the shared store
// in src/model/concepts/intentsStore.ts; the edit throttle is the kit's editQueue.

import { create } from "zustand";
import type { FeatureRow, Segment } from "../../../model/concepts/featureCatalog";
import { unitLabel } from "../../../model/concepts/featureCatalog";
import { Intent, IntentResult, METRIC_NAMES, DEFAULT_DENSITY, checkIntent, densityOf } from "../../../model/concepts/intents";
import { useIntents, nextIntentId, type IntentsState } from "../../../model/concepts/intentsStore";
import { formatMagnitude } from "../../kit/numberMath";
import { compileExpr } from "../../../math/expr";

export { unitLabel, densityOf, DEFAULT_DENSITY, useIntents, nextIntentId };
export type { IntentsState };

// ---- sentence segments ----

/** Merge runs of adjacent plain-text segments and drop empty ones, so the
 *  paragraph renders one span per phrase rather than one per template piece. */
export function mergeSegments(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    if ("text" in s && !("ref" in s)) {
      if (!s.text) continue;
      const last = out[out.length - 1];
      if (last && "text" in last && !("ref" in last)) { out[out.length - 1] = { text: last.text + s.text }; continue; }
    }
    out.push(s);
  }
  return out;
}

export type ParamToken = { kind: "live"; spec: FeatureRow["spec"]["params"][number]; value: number } | { kind: "text"; text: string };

/** How a {param} segment renders: a live number when the spec knows it and its
 *  value evaluates, else the raw expression as text. */
export function paramToken(row: Pick<FeatureRow, "spec" | "values" | "exprs">, key: string): ParamToken {
  const spec = row.spec.params.find((p) => p.key === key);
  const value = row.values[key];
  if (spec && Number.isFinite(value)) return { kind: "live", spec, value };
  return { kind: "text", text: row.exprs[key] ?? "?" };
}

/** CSS state classes for a feature paragraph: dashed/dimmed when rolled back,
 *  struck when suppressed, marked on error, lit when it is the hot feature. */
export function rowClasses(row: Pick<FeatureRow, "rolledBack" | "suppressed" | "error">, hot: boolean): string {
  const c = ["ledger-row"];
  if (row.rolledBack) c.push("ghost");
  if (row.suppressed) c.push("off");
  if (row.error) c.push("err");
  if (hot) c.push("k-hot");
  return c.join(" ");
}

// ---- mass estimate ----

/** Grams for a volume in mm³ at `density` g/cm³; null when the volume is unknown. */
export function massGrams(volume: number | undefined, density: number): number | null {
  if (volume == null || !Number.isFinite(volume)) return null;
  return (volume / 1000) * density;
}

/** A mass delta as the paragraph shows it: signed, at the kit's magnitude precision. */
export function formatMass(g: number): string {
  return `${g < 0 ? "−" : "+"}${formatMagnitude(Math.abs(g), "g")}`;
}

// ---- intents display ----

/** A text that is just a number (an intent's rhs you can scrub), else null. */
export function plainNumber(text: string): number | null {
  const t = text.trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Scrub step for an intent's limit: 0.1 under 10, else 1. */
export function rhsStep(v: number): number {
  return Math.abs(v) < 10 ? 0.1 : 1;
}

/** A metric or parameter value as the "now X" readout prints it (magnitude precision, trailing zeros dropped). */
export function formatNow(v: number): string {
  return formatMagnitude(v, "", { trim: true });
}

/** The result shown for an intent the store has not checked yet (a list longer than its results). */
export function uncheckedResult(intent: Intent): IntentResult {
  return { intent, ok: false, lhs: NaN, rhs: NaN, error: "not checked" };
}

export type IntentGlyph = { glyph: string; label: string; state: "ok" | "bad" | "unknown" };

/** The ✓ / ✗ beside an intent and its accessible label. */
export function intentGlyph(r: IntentResult): IntentGlyph {
  if (r.error) return { glyph: "?", label: `cannot evaluate: ${r.error}`, state: "unknown" };
  return r.ok ? { glyph: "✓", label: "passes", state: "ok" } : { glyph: "✗", label: "fails", state: "bad" };
}

// ---- suggestions ----

export interface Suggestion {
  /** Stable while the suggestion is the same: intent, parameter, from and to. */
  id: string;
  intentId: string;
  /** The intent's label, for the card. */
  label: string;
  /** The parameter to move. */
  param: string;
  from: number;
  to: number;
  delta: number;
  /** The intent reads a model metric (mass, volume…), so the kernel must rebuild before the fix is certain. */
  confirm: boolean;
}

export interface SuggestOpts {
  /** How far to move a parameter, as a fraction of its value (default 0.5 = ±50%). */
  span?: number;
  /** How many steps to try on each side (default 10). */
  steps?: number;
}

/** `v` rounded to a few significant digits so a proposed value reads cleanly. */
export function tidy(v: number): number {
  return v === 0 ? 0 : Number(v.toPrecision(6));
}

/** The names an intent's two sides depend on (empty when either side does not parse). */
export function intentDeps(intent: Intent): string[] {
  try {
    return [...new Set([...compileExpr(intent.lhs).deps, ...compileExpr(intent.rhs).deps])];
  } catch { return []; }
}

/**
 * For every failing intent and every parameter it depends on, the smallest
 * move of that parameter (within ±span, in `steps` steps each way) after which
 * the intent passes with the parameter overridden in `scope`. Metrics in the
 * scope stay fixed, so an intent that reads one is flagged `confirm`: the
 * change is proposed, but only a rebuild can confirm it. An intent that reads
 * only metrics has no parameter to move and gets no suggestion.
 */
export function suggestFixes(results: IntentResult[], scope: Record<string, number>, parameterNames: string[], opts: SuggestOpts = {}): Suggestion[] {
  const span = opts.span ?? 0.5, steps = Math.max(1, Math.round(opts.steps ?? 10));
  const params = new Set(parameterNames), metrics = new Set<string>(METRIC_NAMES);
  const out: Suggestion[] = [];
  for (const r of results) {
    if (r.ok || r.error) continue;
    const deps = intentDeps(r.intent);
    const confirm = deps.some((d) => metrics.has(d));
    for (const p of deps.filter((d) => params.has(d))) {
      const from = scope[p];
      if (!Number.isFinite(from)) continue;
      const base = Math.abs(from) || 1;
      let to: number | null = null;
      search: for (let k = 1; k <= steps; k++) {
        for (const sign of [1, -1]) {
          const cand = tidy(from + sign * base * span * (k / steps));
          if (checkIntent(r.intent, { ...scope, [p]: cand }).ok) { to = cand; break search; }
        }
      }
      if (to == null) continue;
      out.push({ id: `${r.intent.id}:${p}:${from}:${to}`, intentId: r.intent.id, label: r.intent.label, param: p, from, to, delta: tidy(to - from), confirm });
    }
  }
  return out;
}

/** A signed change for a suggestion card ("+1.5", "−0.4"). */
export function formatDelta(d: number): string {
  return `${d < 0 ? "−" : "+"}${formatNow(Math.abs(d))}`;
}

/** The suggestion as a sentence: "Set wall to 4.5 (+1.5)". */
export function suggestionText(s: Pick<Suggestion, "param" | "to" | "delta">): string {
  return `Set ${s.param} to ${formatNow(s.to)} (${formatDelta(s.delta)})`;
}

export interface Accepted {
  /** The suggestion that was accepted. */
  suggestion: Suggestion;
  /** The parameter's expression before the change, for Undo. */
  prevExpr: string;
}

export interface SuggestionsState {
  /** Suggestion ids the user put aside; a suggestion with the same id is the same proposal on the same document state. */
  dismissed: Record<string, true>;
  /** Accepted suggestions, kept for the session so each can be undone. */
  accepted: Record<string, Accepted>;
  dismiss: (id: string) => void;
  accept: (s: Suggestion, prevExpr: string) => void;
  /** Forget an accepted suggestion (after its Undo was applied). */
  forget: (id: string) => void;
}

/** The Ledger's private suggestion state (what was put aside, what was accepted). */
export const useSuggestions = create<SuggestionsState>((set, get) => ({
  dismissed: {},
  accepted: {},
  dismiss: (id) => set({ dismissed: { ...get().dismissed, [id]: true } }),
  accept: (s, prevExpr) => set({ accepted: { ...get().accepted, [s.id]: { suggestion: s, prevExpr } } }),
  forget: (id) => {
    const accepted = { ...get().accepted };
    delete accepted[id];
    set({ accepted });
  },
}));

/** The suggestions still to show: not dismissed, not already accepted. */
export function visibleSuggestions(all: Suggestion[], state: Pick<SuggestionsState, "dismissed" | "accepted">): Suggestion[] {
  return all.filter((s) => !state.dismissed[s.id] && !state.accepted[s.id]);
}
