// The Design Space's arithmetic: grid ↔ parameter values, the order cells are
// sampled in, pass/fail frontiers between cells, the lightest passing cell,
// pins and the map's SVG layout. No React, no store: tested in Node
// (test/space.test.ts); Map.tsx / Pinned.tsx / index.tsx only template it.

import type { CadDocument, Parameter } from "../../../core/document";
import type { OperationRecord } from "../../../core/command/types";
import { snapToStep } from "../../../core/parameters";
import { checkIntents, intentScope, type Intent, type IntentResult, type Metrics } from "../../../model/concepts/intents";
import { arrowDir, decimals, formatMagnitude } from "../../kit/numberMath";

// ---- axes and grid -------------------------------------------------------

/** One mapped parameter: its name and the extent the map spans. */
export interface Axis {
  name: string;
  min: number;
  max: number;
  /** Parameter.step when set: every value the map produces lands on it. */
  step?: number;
  unit?: string;
}

export interface GridSpec { x: Axis; y: Axis; n: number }

export const GRID_SIZES = [5, 9, 13] as const;
export type GridSize = (typeof GRID_SIZES)[number];
export const DEFAULT_N: GridSize = 9;

/** Parameters the map can span: a numeric min < max and not a switch, enum or value list. */
export function boundedParams(params: Parameter[]): Parameter[] {
  return params.filter((p) => typeof p.min === "number" && typeof p.max === "number" && Number.isFinite(p.min) && Number.isFinite(p.max) && p.min < p.max && !p.values && !p.boolean && !p.options);
}

/** The two axes to show: the chosen names when both are still bounded and distinct, else the first two bounded parameters. */
export function pickAxes(bounded: Parameter[], xName: string | null, yName: string | null): [Parameter, Parameter] | null {
  if (bounded.length < 2) return null;
  const x = bounded.find((p) => p.name === xName) ?? bounded[0];
  const y = bounded.find((p) => p.name === yName && p.name !== x.name) ?? bounded.find((p) => p.name !== x.name)!;
  return [x, y];
}

export function axisOf(p: Parameter): Axis {
  return { name: p.name, min: p.min as number, max: p.max as number, step: p.step && p.step > 0 ? p.step : undefined, unit: (p as { unit?: string }).unit };
}

/** Snap to the axis step (anchored at min, as the parameter panel does) and clamp to [min, max]. */
export function quantizeTo(a: Axis, v: number): number {
  let q = a.step ? snapToStep(v, a.step, a.min) : v;
  q = Math.max(a.min, Math.min(a.max, q));
  const digits = a.step ? decimals(a.step) : 4;
  return Number(q.toFixed(digits));
}

/** The parameter value at grid index i (0 … n-1), min at 0 and max at n-1. */
export function axisValue(a: Axis, i: number, n: number): number {
  const t = n <= 1 ? 0 : i / (n - 1);
  return quantizeTo(a, a.min + (a.max - a.min) * t);
}

/** Continuous grid coordinate of a value (0 at min, n-1 at max), unclamped. */
export function axisCoord(a: Axis, v: number, n: number): number {
  if (a.max === a.min) return 0;
  return ((v - a.min) / (a.max - a.min)) * (n - 1);
}

/** Nearest grid index of a value, clamped into the grid. */
export function axisIndex(a: Axis, v: number, n: number): number {
  return Math.max(0, Math.min(n - 1, Math.round(axisCoord(a, v, n))));
}

/** Value from a continuous grid coordinate (what a pointer position maps to), quantized. */
export function axisFromCoord(a: Axis, c: number, n: number): number {
  const t = n <= 1 ? 0 : c / (n - 1);
  return quantizeTo(a, a.min + (a.max - a.min) * t);
}

/** One arrow-key step: the parameter's own step when it has one, else one grid cell. */
export function keyStepOf(a: Axis, n: number): number {
  return a.step ?? (a.max - a.min) / Math.max(1, n - 1);
}

/** The step a key press takes from v along the axis, in direction d (±1); shift moves one cell. */
export function stepValue(a: Axis, v: number, d: number, n: number, shift = false): number {
  const s = shift ? (a.max - a.min) / Math.max(1, n - 1) : keyStepOf(a, n);
  return quantizeTo(a, v + d * s);
}

/** The design point after an arrow key on the map (null for any other key): x on ←/→, y on ↑/↓. */
export function keyMove(spec: GridSpec, current: { x: number; y: number }, key: string, shift = false): { x: number; y: number } | null {
  const a = arrowDir(key);
  if (!a) return null;
  return {
    x: a.dx ? stepValue(spec.x, current.x, a.dx, spec.n, shift) : current.x,
    y: a.dy ? stepValue(spec.y, current.y, a.dy, spec.n, shift) : current.y,
  };
}

/** The axes after one select changes: picking the other axis's parameter swaps them, so both are never the same. */
export function swapAxes(spec: Pick<GridSpec, "x" | "y">, which: "x" | "y", name: string): { x: string; y: string } {
  if (which === "x") return { x: name, y: spec.y.name === name ? spec.x.name : spec.y.name };
  return { x: spec.x.name === name ? spec.y.name : spec.x.name, y: name };
}

// ---- sampling order ------------------------------------------------------

/** Coarse-to-fine order: centre, the four corners, then the half-grid, quarter-grid and
 *  finally every remaining cell, each level nearest the centre first. */
export function cellOrder(n: number): [number, number][] {
  const c = (n - 1) / 2;
  const levels: number[] = [];
  for (let s = n - 1; s >= 1; s = Math.floor(s / 2)) { if (!levels.includes(s)) levels.push(s); if (s === 1) break; }
  if (!levels.includes(1)) levels.push(1);
  const onLevel = (i: number, s: number) => Number.isInteger(c) ? (i - c) % s === 0 || i % s === 0 : i % s === 0;
  const rank = (i: number, j: number) => {
    if (i === c && j === c) return -1;
    for (let k = 0; k < levels.length; k++) if (onLevel(i, levels[k]) && onLevel(j, levels[k])) return k;
    return levels.length;
  };
  const cells: [number, number][] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) cells.push([i, j]);
  const dist = ([i, j]: [number, number]) => Math.hypot(i - c, j - c);
  return cells.sort((p, q) => {
    const rp = rank(p[0], p[1]), rq = rank(q[0], q[1]);
    if (rp !== rq) return rp - rq;
    // corners before the rest of the coarsest level
    const cp = isCorner(p, n) ? 0 : 1, cq = isCorner(q, n) ? 0 : 1;
    if (rp === 0 && cp !== cq) return cp - cq;
    const d = dist(p) - dist(q);
    return d !== 0 ? d : p[1] - q[1] || p[0] - q[0];
  });
}

const isCorner = ([i, j]: [number, number], n: number) => (i === 0 || i === n - 1) && (j === 0 || j === n - 1);

export const cellKey = (i: number, j: number, n: number) => j * n + i;

// ---- cells ----------------------------------------------------------------

/** What sampling one cell produced: the metrics of the variant, or why it failed to build. */
export interface CellSample {
  i: number;
  j: number;
  x: number;
  y: number;
  metrics: Metrics | null;
  error?: string;
}

/** A sampled cell judged against the intents. */
export interface CellVerdict extends CellSample {
  results: IntentResult[];
  /** Every intent holds and the variant built. */
  pass: boolean;
}

/** Re-express mass at another density (metrics are cached per cell; density may change). */
export function withDensity(m: Metrics, density: number): Metrics {
  return { ...m, density, mass: (m.volume / 1000) * density };
}

/** Judge a sample: the variant's parameters plus its metrics are the intent scope. */
export function judgeCell(sample: CellSample, doc: CadDocument, spec: GridSpec, intents: Intent[], density: number): CellVerdict {
  if (!sample.metrics) return { ...sample, results: [], pass: false };
  const metrics = withDensity(sample.metrics, density);
  const variant = variantParams(doc, spec, sample.x, sample.y);
  const results = checkIntents(intents, intentScope({ ...doc, parameters: variant }, metrics));
  return { ...sample, metrics, results, pass: results.every((r) => r.ok) };
}

/** The document's parameters with the two axes set to (x, y). */
export function variantParams(doc: CadDocument, spec: GridSpec, x: number, y: number): Parameter[] {
  return doc.parameters.map((p) => (p.name === spec.x.name ? { ...p, expr: String(x), value: x } : p.name === spec.y.name ? { ...p, expr: String(y), value: y } : p));
}

/** Intents the map can draw: both sides evaluate against parameters and metrics (no unknown names). */
export function mappableIntents(intents: Intent[], scope: Record<string, number>): Intent[] {
  return checkIntents(intents, scope).filter((r) => !r.error || r.error === "not a number").map((r) => r.intent);
}

// ---- metrics --------------------------------------------------------------

export type MetricKey = "mass" | "volume" | "width" | "depth" | "height";
export const METRICS: { key: MetricKey; label: string; unit: string; estimate?: boolean }[] = [
  { key: "mass", label: "Mass (est.)", unit: "g", estimate: true },
  { key: "volume", label: "Volume", unit: "mm³" },
  { key: "width", label: "Width", unit: "mm" },
  { key: "depth", label: "Depth", unit: "mm" },
  { key: "height", label: "Height", unit: "mm" },
];

export function metricInfo(key: MetricKey) { return METRICS.find((m) => m.key === key) ?? METRICS[0]; }

/** A metric with its unit at the kit's magnitude precision (a volume in mm³ is always whole). */
export function formatMetric(v: number | undefined, key: MetricKey): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return formatMagnitude(v, metricInfo(key).unit, key === "volume" ? { digits: 0 } : {});
}

export function metricRange(cells: (CellVerdict | undefined)[], key: MetricKey): { min: number; max: number } | null {
  let min = Infinity, max = -Infinity;
  for (const c of cells) {
    const v = c?.metrics?.[key];
    if (v == null || !Number.isFinite(v)) continue;
    min = Math.min(min, v); max = Math.max(max, v);
  }
  return min <= max ? { min, max } : null;
}

/** 0 … 1 brightness for a metric value: the lowest value is brightest (1). */
export function shadeOf(v: number, range: { min: number; max: number } | null): number {
  if (!range || range.max <= range.min) return 1;
  return 1 - (v - range.min) / (range.max - range.min);
}

/** The fill opacity of a passing cell: 0.15 for the heaviest, 0.9 for the lightest. */
export function cellOpacity(v: number, range: { min: number; max: number } | null): number {
  return 0.15 + 0.75 * shadeOf(v, range);
}

/** The tooltip of a sampled cell: both values, the metric, and why it passes or fails. */
export function cellTitle(spec: GridSpec, c: CellVerdict, key: MetricKey): string {
  const info = metricInfo(key);
  const outcome = c.metrics
    ? c.pass ? "passes" : "fails " + c.results.filter((r) => !r.ok).map((r) => r.intent.label).join(", ")
    : "did not build" + (c.error ? ` (${c.error})` : "");
  return `${spec.x.name} ${formatAxisValue(spec.x, c.x)}, ${spec.y.name} ${formatAxisValue(spec.y, c.y)}: ${info.label} ${formatMetric(c.metrics?.[key], key)}; ${outcome}`;
}

/** The diamond drawn on the lightest passing cell, as an SVG path about its centre. */
export function lightestMark(centre: { x: number; y: number }, cell: { w: number; h: number }): string {
  const r = Math.min(cell.w, cell.h) * 0.32;
  return `M${centre.x} ${centre.y - r} L${centre.x + r} ${centre.y} L${centre.x} ${centre.y + r} L${centre.x - r} ${centre.y} Z`;
}

/** The passing cell with the lowest metric, ties broken toward the grid centre. */
export function lightestPassing(cells: (CellVerdict | undefined)[], key: MetricKey, n: number): CellVerdict | null {
  const c = (n - 1) / 2;
  let best: CellVerdict | null = null;
  for (const cell of cells) {
    if (!cell?.pass || !cell.metrics) continue;
    const v = cell.metrics[key];
    if (!Number.isFinite(v)) continue;
    if (!best) { best = cell; continue; }
    const bv = best.metrics![key];
    if (v < bv - 1e-9 || (Math.abs(v - bv) <= 1e-9 && Math.hypot(cell.i - c, cell.j - c) < Math.hypot(best.i - c, best.j - c))) best = cell;
  }
  return best;
}

// ---- frontiers --------------------------------------------------------------

/** A line in continuous grid coordinates (cell centres at integers). */
export interface Segment { x1: number; y1: number; x2: number; y2: number }

/**
 * Marching squares over the cell centres: `inside(cell)` is true, false, or null
 * (unsampled; a square touching one is skipped). Each 2×2 block of cells with
 * mixed verdicts yields the segment(s) separating them, at the midpoints.
 */
export function frontier(cells: (CellVerdict | undefined)[], n: number, inside: (c: CellVerdict) => boolean): Segment[] {
  const at = (i: number, j: number): boolean | null => { const c = cells[cellKey(i, j, n)]; return c ? inside(c) : null; };
  const out: Segment[] = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      if (a == null || b == null || c == null || d == null) continue;
      const code = (a ? 1 : 0) | (b ? 2 : 0) | (c ? 4 : 0) | (d ? 8 : 0);
      if (code === 0 || code === 15) continue;
      // edge midpoints: top (a-b), right (b-c), bottom (d-c), left (a-d)
      const T = { x: i + 0.5, y: j }, R = { x: i + 1, y: j + 0.5 }, B = { x: i + 0.5, y: j + 1 }, L = { x: i, y: j + 0.5 };
      const seg = (p: { x: number; y: number }, q: { x: number; y: number }) => out.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y });
      switch (code) {
        case 1: case 14: seg(L, T); break;
        case 2: case 13: seg(T, R); break;
        case 3: case 12: seg(L, R); break;
        case 4: case 11: seg(R, B); break;
        case 6: case 9: seg(T, B); break;
        case 7: case 8: seg(L, B); break;
        case 5: seg(L, T); seg(R, B); break;
        case 10: seg(T, R); seg(L, B); break;
      }
    }
  }
  return out;
}

/** The pass/fail frontier of each intent (where its own verdict flips), plus the overall one. */
export function frontiers(cells: (CellVerdict | undefined)[], n: number, intents: Intent[]): { id: string; label: string; segments: Segment[] }[] {
  const per = intents.map((it, k) => ({ id: it.id, label: it.label, segments: frontier(cells, n, (c) => c.results[k]?.ok === true) }));
  return [...per, { id: "__all", label: "All intents", segments: frontier(cells, n, (c) => c.pass) }];
}

/** Stroke tokens cycled for the per-intent frontiers (kit tokens only). */
export const FRONTIER_COLORS = ["var(--k-select)", "var(--k-accent)", "var(--k-agent)", "var(--text)", "var(--k-accent-dim)"];
export const frontierColor = (k: number) => FRONTIER_COLORS[k % FRONTIER_COLORS.length];
/** The k-th of `count` frontiers is one intent's; the one after them is the overall pass/fail line. */
export const frontierStroke = (k: number, intentCount: number) => (k < intentCount ? frontierColor(k) : "var(--k-bad)");

/** The map's legend: what a pass / fail cell means, then one row per frontier. */
export function mapLegend(metric: MetricKey, fronts: { label: string }[], intentCount: number): { color: string; label: string }[] {
  return [
    { color: "var(--k-ok)", label: `passes (brighter = lower ${metricInfo(metric).label.toLowerCase()})` },
    { color: "var(--k-bad)", label: "fails / did not build" },
    ...fronts.map((f, k) => ({ color: frontierStroke(k, intentCount), label: f.label })),
  ];
}

// ---- SVG layout ----------------------------------------------------------------

export const VIEW_W = 560, VIEW_H = 420;
export interface Layout { left: number; top: number; w: number; h: number; n: number }
const MARGIN = { left: 64, right: 16, top: 16, bottom: 48 };

export function layout(n: number): Layout {
  return { left: MARGIN.left, top: MARGIN.top, w: VIEW_W - MARGIN.left - MARGIN.right, h: VIEW_H - MARGIN.top - MARGIN.bottom, n };
}

/** Width/height of one cell in viewBox units. */
export const cellSize = (L: Layout) => ({ w: L.w / L.n, h: L.h / L.n });

/** Grid coordinate (cell centre at integer, x right, y up) → viewBox point. */
export function gridToSvg(L: Layout, gx: number, gy: number): { x: number; y: number } {
  const { w, h } = cellSize(L);
  return { x: L.left + (gx + 0.5) * w, y: L.top + L.h - (gy + 0.5) * h };
}

/** ViewBox point → continuous grid coordinate (unclamped). */
export function svgToGrid(L: Layout, px: number, py: number): { gx: number; gy: number } {
  const { w, h } = cellSize(L);
  return { gx: (px - L.left) / w - 0.5, gy: (L.top + L.h - py) / h - 0.5 };
}

/** Client pointer → viewBox point, from the SVG element's client rect. */
export function clientToSvg(rect: { left: number; top: number; width: number; height: number }, cx: number, cy: number): { x: number; y: number } {
  const sx = rect.width > 0 ? VIEW_W / rect.width : 1, sy = rect.height > 0 ? VIEW_H / rect.height : 1;
  return { x: (cx - rect.left) * sx, y: (cy - rect.top) * sy };
}

/** A pointer position → the two parameter values (quantized, clamped). */
export function pointToValues(spec: GridSpec, L: Layout, px: number, py: number): { x: number; y: number } {
  const g = svgToGrid(L, px, py);
  return { x: axisFromCoord(spec.x, g.gx, spec.n), y: axisFromCoord(spec.y, g.gy, spec.n) };
}

/** Axis tick values: at most `count`, on grid indices, labelled at the step's precision. */
export function ticks(a: Axis, n: number, count = 5): { value: number; coord: number; label: string }[] {
  const every = Math.max(1, Math.round((n - 1) / (count - 1)));
  const out: { value: number; coord: number; label: string }[] = [];
  for (let i = 0; i < n; i += every) out.push({ value: axisValue(a, i, n), coord: i, label: formatAxisValue(a, axisValue(a, i, n)) });
  if (out[out.length - 1].coord !== n - 1) out.push({ value: a.max, coord: n - 1, label: formatAxisValue(a, a.max) });
  return out;
}

export function formatAxisValue(a: Axis, v: number): string {
  const digits = a.step ? decimals(a.step) : Math.abs(a.max - a.min) >= 50 ? 0 : Math.abs(a.max - a.min) >= 5 ? 1 : 2;
  return v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

// ---- the current point ---------------------------------------------------------

/** What the map's accessible label says. */
export function describePoint(spec: GridSpec, x: number, y: number, verdict: "pass" | "fail" | "unknown", metric?: string): string {
  const v = verdict === "pass" ? "passes every intent" : verdict === "fail" ? "fails an intent" : "not yet checked";
  return `Design space map. ${spec.x.name} ${formatAxisValue(spec.x, x)}, ${spec.y.name} ${formatAxisValue(spec.y, y)}${metric ? `, ${metric}` : ""}; ${v}. Drag to move the design; arrow keys step.`;
}

export type Verdict = "pass" | "fail" | "unknown";

export function verdictOf(results: IntentResult[], hasMetrics: boolean): Verdict {
  if (!hasMetrics) return "unknown";
  return results.every((r) => r.ok) ? "pass" : "fail";
}

/** The current design's results for the intents the map draws (the shared store checks every intent; the map only some). */
export function resultsFor(results: IntentResult[], intents: Intent[]): IntentResult[] {
  return intents.map((it) => results.find((r) => r.intent.id === it.id) ?? { intent: it, ok: false, lhs: NaN, rhs: NaN, error: "not checked" });
}

export function okCount(results: IntentResult[]): number {
  return results.filter((r) => r.ok).length;
}

/** How a Readout colours a verdict. */
export function readoutState(verdict: Verdict): "ok" | "bad" | undefined {
  return verdict === "pass" ? "ok" : verdict === "fail" ? "bad" : undefined;
}

/** "3 / 4 ok", or "none" without intents. */
export function intentsText(results: IntentResult[]): string {
  return results.length ? `${okCount(results)} / ${results.length} ok` : "none";
}

export type SampleStatus = "idle" | "starting" | "sampling" | "done" | "error";

/** The progress line under the map. */
export function statusText(status: SampleStatus, progress: { done: number; total: number }, error: string | null): string {
  switch (status) {
    case "starting": return "starting kernel…";
    case "sampling": return `sampling ${progress.done} / ${progress.total}`;
    case "done": return `${progress.total} cells`;
    case "error": return `sampling failed: ${error}`;
    default: return progress.total ? `${progress.done} / ${progress.total} cells` : "";
  }
}

// ---- pins ----------------------------------------------------------------

export const PIN_LETTERS = ["A", "B", "C"] as const;
export type PinLetter = (typeof PIN_LETTERS)[number];
export const MAX_PINS = PIN_LETTERS.length;

export interface Pin {
  letter: PinLetter;
  x: number;
  y: number;
  xName: string;
  yName: string;
  metrics: Metrics | null;
  verdict: Verdict;
}

/** What "Go to" a pin sends: its own axes and values (not whatever axes the map shows now). */
export interface Move { xName: string; yName: string; x: number; y: number }
export const pinMove = (p: Pin): Move => ({ xName: p.xName, yName: p.yName, x: p.x, y: p.y });

/** Add a pin under the first free letter; unchanged when all three are taken or the point is already pinned. */
export function addPin(pins: Pin[], pin: Omit<Pin, "letter">): Pin[] {
  if (pins.some((p) => p.xName === pin.xName && p.yName === pin.yName && p.x === pin.x && p.y === pin.y)) return pins;
  const letter = PIN_LETTERS.find((l) => !pins.some((p) => p.letter === l));
  if (!letter) return pins;
  return [...pins, { ...pin, letter }].sort((a, b) => a.letter.localeCompare(b.letter));
}

export function removePin(pins: Pin[], letter: PinLetter): Pin[] { return pins.filter((p) => p.letter !== letter); }

/** Signed change of each metric from `from` to `to` (for the side-by-side compare). */
export function metricDeltas(from: Metrics | null, to: Metrics | null): Partial<Record<MetricKey, number>> {
  if (!from || !to) return {};
  const out: Partial<Record<MetricKey, number>> = {};
  for (const m of METRICS) out[m.key] = to[m.key] - from[m.key];
  return out;
}

export function formatDelta(d: number | undefined, key: MetricKey): string {
  if (d == null || !Number.isFinite(d)) return "—";
  const s = formatMetric(Math.abs(d), key);
  return d > 1e-9 ? `+${s}` : d < -1e-9 ? `−${s}` : `±0 ${metricInfo(key).unit}`;
}

// ---- cache key -------------------------------------------------------------------

/**
 * What a sampled grid depends on: the recipe (every op's type, params and
 * suppression) with the two axis parameters' own expressions blanked, since the
 * grid overrides them — so dragging the design point never invalidates the grid.
 */
export function docSignature(timeline: OperationRecord[], rollbackIndex: number, activeConfiguration: string | undefined, axes: [string, string]): string {
  const ops = timeline.slice(0, rollbackIndex).map((op) => {
    if (op.type === "parameter.add" && axes.includes(String(op.params.name))) {
      const { expression: _e, ...rest } = op.params as Record<string, unknown>;
      void _e;
      return [op.type, rest, !!op.suppressed];
    }
    return [op.type, op.params, !!op.suppressed];
  });
  return JSON.stringify([ops, activeConfiguration ?? null]);
}

export const gridKey = (spec: GridSpec, signature: string) => `${spec.x.name}|${spec.y.name}|${spec.n}|${signature}`;
