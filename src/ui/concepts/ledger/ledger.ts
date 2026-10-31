// The Ledger's logic, apart from React: how a feature's sentence segments are
// prepared for rendering, the mass estimate beside each paragraph, the intents'
// glyphs and readouts, and the two searches for a parameter change that would
// make a failing intent pass: an instant one over the intent's own parameters
// (suggestFixes) and a sampled one for intents that read a model metric
// (findMetricFixes: candidate values of each bounded parameter are built on the
// Design Space's sampler backend and the smallest change that makes every
// intent pass is proposed). Everything here is tested in Node
// (test/ledger.test.ts); the .tsx files only template it. The intent list
// itself is the shared store in src/model/concepts/intentsStore.ts; the edit
// throttle is the kit's editQueue.

import { create } from "zustand";
import type { Parameter } from "../../../core/document";
import type { FeatureRow, Segment } from "../../../model/concepts/featureCatalog";
import { unitLabel } from "../../../model/concepts/featureCatalog";
import { Intent, IntentResult, METRIC_NAMES, DEFAULT_DENSITY, checkIntent, checkIntents, densityOf, type Metrics } from "../../../model/concepts/intents";
import { useIntents, nextIntentId, type IntentsState } from "../../../model/concepts/intentsStore";
import { formatMagnitude } from "../../kit/numberMath";
import { compileExpr } from "../../../math/expr";
import { boundedParams, quantizeTo } from "../space/space";

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
  /** What the sampled variant measured ("mass 143 g"), when the fix was built rather than computed. */
  note?: string;
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

/** The suggestion as a sentence: "Set wall to 4.5 (+1.5)", or with its sampled metric, "Set wall to 5 (mass 143 g)". */
export function suggestionText(s: Pick<Suggestion, "param" | "to" | "delta"> & { note?: string }): string {
  return `Set ${s.param} to ${formatNow(s.to)} (${s.note ?? formatDelta(s.delta)})`;
}

// ---- sampled fixes for metric intents ----

/** The metric names an intent's two sides read. */
export function metricDeps(intent: Intent): string[] {
  const metrics = new Set<string>(METRIC_NAMES);
  return intentDeps(intent).filter((d) => metrics.has(d));
}

/** The failing (evaluable) intents that read a model metric: what only a rebuild can fix. */
export function metricFailures(results: IntentResult[]): IntentResult[] {
  return results.filter((r) => !r.ok && !r.error && metricDeps(r.intent).length > 0);
}

/** Parameters the sampled search may move: numeric bounds, not a switch, enum or value list (the Design Space's rule). */
export function searchableParams(params: Parameter[]): Parameter[] {
  return boundedParams(params);
}

/**
 * Whether a sampled search is worth running: a metric intent fails, something
 * is built (otherwise every metric is 0 and no parameter changes that), and at
 * least one parameter has bounds to move within.
 */
export function needsMetricSearch(results: IntentResult[], bodies: number, params: Parameter[]): boolean {
  return bodies > 0 && metricFailures(results).length > 0 && searchableParams(params).length > 0;
}

export interface CandidateSides {
  /** Values above the current one, nearest first, ending at max. */
  up: number[];
  /** Values below the current one, nearest first, ending at min. */
  down: number[];
}

/**
 * Up to `count` candidate values on each side of a bounded parameter's current
 * value, evenly spaced to the bound (on the parameter's step when it has one),
 * nearest first, within [min, max] and never the current value itself.
 */
export function candidateValues(p: Pick<Parameter, "value" | "min" | "max" | "step">, count = 6): CandidateSides {
  const min = p.min as number, max = p.max as number, from = p.value;
  const axis = { name: "", min, max, step: p.step };
  const side = (bound: number): number[] => {
    const out: number[] = [];
    for (let k = 1; k <= count; k++) {
      const v = quantizeTo(axis, from + ((bound - from) * k) / count);
      if (v === from || v < min || v > max || out.includes(v)) continue;
      out.push(v);
    }
    return out.sort((a, b) => Math.abs(a - from) - Math.abs(b - from));
  };
  return { up: from < max ? side(max) : [], down: from > min ? side(min) : [] };
}

/** Builds the document with `overrides` applied and measures it; null when nothing could be built. The sampler backend in the app, a stub in tests. */
export type EvaluateVariant = (overrides: Record<string, number>) => Promise<Metrics | null>;

export interface MetricSearchOpts {
  /** Candidates per side of each parameter (default 6). */
  count?: number;
  cancelled?: () => boolean;
}

/** Every evaluable intent passes with the parameter at `value` and the variant's metrics. */
export function allPass(intents: Intent[], scope: Record<string, number>, param: string, value: number, metrics: Metrics): boolean {
  return checkIntents(intents, { ...scope, [param]: value, ...metrics }).every((r) => r.ok || r.error);
}

/** A readout of the metrics the failing intents read ("mass 143 g · height 38.0 mm"). */
export function metricNote(metrics: Metrics, names: string[]): string {
  const units: Record<string, string> = { mass: "g", volume: "mm³", width: "mm", depth: "mm", height: "mm", density: "g/cm³", bodies: "" };
  return names
    .filter((n) => n in units && Number.isFinite(metrics[n as keyof Metrics]))
    .map((n) => `${n} ${formatMagnitude(metrics[n as keyof Metrics], units[n], n === "volume" || n === "bodies" ? { digits: 0 } : {})}`)
    .join(" · ");
}

/**
 * For every bounded parameter, the smallest move (nearest candidate first on
 * either side) after which a built variant makes every intent pass; the
 * suggestions sorted by how far they move relative to the parameter's range,
 * so the first is the smallest change. Each side's bound is tried first: when
 * even the bound does not help, the side is skipped (a monotonic metric is
 * assumed), so a parameter with no effect costs two builds. Returns null when
 * cancelled. Nothing here touches the live document: `evaluate` builds a clone.
 */
export async function findMetricFixes(intents: Intent[], results: IntentResult[], scope: Record<string, number>, params: Parameter[], evaluate: EvaluateVariant, opts: MetricSearchOpts = {}): Promise<Suggestion[] | null> {
  const failing = metricFailures(results);
  if (failing.length === 0) return [];
  const label = failing.map((r) => r.intent.label).join(", ");
  const names = [...new Set(failing.flatMap((r) => metricDeps(r.intent)))];
  const out: (Suggestion & { rel: number })[] = [];
  for (const p of searchableParams(params)) {
    const from = scope[p.name] ?? p.value;
    if (!Number.isFinite(from)) continue;
    const sides = candidateValues({ ...p, value: from }, opts.count);
    let best: { to: number; metrics: Metrics } | null = null;
    for (const side of [sides.up, sides.down]) {
      if (side.length === 0) continue;
      const bound = side[side.length - 1];
      if (best && Math.abs(side[0] - from) >= Math.abs(best.to - from)) continue; // nothing on this side is nearer than what we have
      const probe = await evaluate({ [p.name]: bound });
      if (opts.cancelled?.()) return null;
      if (!probe || !allPass(intents, scope, p.name, bound, probe)) continue;
      let found = { to: bound, metrics: probe };
      for (const cand of side.slice(0, -1)) {
        if (best && Math.abs(cand - from) >= Math.abs(best.to - from)) break;
        const m = await evaluate({ [p.name]: cand });
        if (opts.cancelled?.()) return null;
        if (m && allPass(intents, scope, p.name, cand, m)) { found = { to: cand, metrics: m }; break; }
      }
      if (!best || Math.abs(found.to - from) < Math.abs(best.to - from)) best = found;
    }
    if (!best) continue;
    const to = tidy(best.to);
    out.push({
      id: `fix:${p.name}:${from}:${to}`, intentId: failing[0].intent.id, label, param: p.name, from, to, delta: tidy(to - from), confirm: false,
      note: metricNote(best.metrics, names), rel: Math.abs(to - from) / ((p.max as number) - (p.min as number)),
    });
  }
  out.sort((a, b) => a.rel - b.rel);
  return out.map(({ rel: _r, ...s }) => { void _r; return s; });
}

/**
 * Variant evaluations remembered per document revision, so a search re-run
 * (an intent was added or its limit scrubbed) rebuilds nothing already built.
 * A different revision empties it: the geometry has changed.
 */
export class VariantCache {
  private key = "";
  private map = new Map<string, Promise<Metrics | null>>();
  /** The evaluation of `overrides` on the document at `docKey`, computed once per revision. */
  get(docKey: string, overrides: Record<string, number>, evaluate: EvaluateVariant): Promise<Metrics | null> {
    if (docKey !== this.key) { this.key = docKey; this.map.clear(); }
    const k = Object.keys(overrides).sort().map((n) => `${n}=${overrides[n]}`).join(",");
    let p = this.map.get(k);
    if (!p) { p = evaluate(overrides); this.map.set(k, p); }
    return p;
  }
  get size(): number { return this.map.size; }
  clear(): void { this.map.clear(); this.key = ""; }
}

/** Where the sampled search stands, for the Suggestions section. */
export type FixSearchStatus = "idle" | "searching" | "done" | "error";

/** The line shown while the search runs, when it found nothing, or when it could not run ("" otherwise). */
export function fixSearchText(status: FixSearchStatus, found: number, error: string | null): string {
  switch (status) {
    case "searching": return "Looking for a fix…";
    case "done": return found === 0 ? "No change to a bounded parameter fixes this within its range." : "";
    case "error": return `Could not look for a fix: ${error ?? "unknown error"}`;
    default: return "";
  }
}

/**
 * The suggestions to show together: the instant ones, minus those that only a
 * rebuild could confirm whenever the sampled search is running or has found
 * something (its results are built, so they replace the guesses), plus the
 * sampled ones.
 */
export function mergeSuggestions(instant: Suggestion[], sampled: Suggestion[], status: FixSearchStatus): Suggestion[] {
  const hideGuesses = status === "searching" || sampled.length > 0;
  return [...instant.filter((s) => !(hideGuesses && s.confirm)), ...sampled];
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
