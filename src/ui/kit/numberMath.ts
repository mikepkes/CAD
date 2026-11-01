// The arithmetic behind a live number (a value you drag sideways or step with
// the arrow keys), kept apart from React so it is tested in Node and shared by
// every control that edits a number: prose tokens, card sliders, verbs.

export interface NumberSpec {
  min?: number;
  max?: number;
  /** The drag / arrow-key increment; also the display precision. */
  step: number;
}

/** Clamp to the bounds and snap to the step (fixing float noise, 0.30000000000000004 → 0.3). */
export function quantize(v: number, spec: NumberSpec): number {
  const step = spec.step > 0 ? spec.step : 1;
  let q = Math.round(v / step) * step;
  if (spec.min != null) q = Math.max(spec.min, q);
  if (spec.max != null) q = Math.min(spec.max, q);
  const digits = decimals(step);
  return Number(q.toFixed(digits));
}

/** Decimal places a step needs (0.5 → 1, 0.25 → 2, 1 → 0). */
export function decimals(step: number): number {
  if (!(step > 0)) return 0;
  const s = String(step);
  const e = s.indexOf("e-");
  if (e >= 0) return Number(s.slice(e + 2));
  const dot = s.indexOf(".");
  return dot >= 0 ? s.length - dot - 1 : 0;
}

/** The value after dragging `dx` pixels from `start`: one step per `pxPerStep` pixels; shift makes it 10 steps. */
export function scrubValue(start: number, dx: number, spec: NumberSpec, opts: { pxPerStep?: number; fine?: boolean; coarse?: boolean } = {}): number {
  const px = opts.pxPerStep ?? 5;
  const mult = opts.coarse ? 10 : opts.fine ? 0.1 : 1;
  const steps = Math.round(dx / px);
  return quantize(start + steps * spec.step * mult, { ...spec, step: opts.fine ? spec.step / 10 : spec.step });
}

/** The direction an arrow key names (null for any other key): right/up positive, left/down negative, screen y not flipped. */
export function arrowDir(key: string): { dx: number; dy: number } | null {
  switch (key) {
    case "ArrowRight": return { dx: 1, dy: 0 };
    case "ArrowLeft": return { dx: -1, dy: 0 };
    case "ArrowUp": return { dx: 0, dy: 1 };
    case "ArrowDown": return { dx: 0, dy: -1 };
    default: return null;
  }
}

/** The value after an arrow key (null when the key is not one): up/right step up, down/left step down, shift ×10. */
export function keyStep(v: number, key: string, shift: boolean, spec: NumberSpec): number | null {
  const a = arrowDir(key);
  if (!a) return null;
  return quantize(v + (a.dx + a.dy) * spec.step * (shift ? 10 : 1), spec);
}

/** A number as the prose shows it: the step's precision, thousands separated, with its unit. */
export function formatValue(v: number, spec: NumberSpec, unit = ""): string {
  const digits = decimals(spec.step);
  const text = Number.isFinite(v) ? v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "—";
  return unit ? `${text} ${unit}` : text;
}

/** Parse what someone typed into a live number: a plain number only (expressions go through the document), kept as
 *  typed — not rounded to the drag step, not clamped (`typedProblem` says when it is out of bounds). */
export function parseTyped(text: string, spec: NumberSpec): number | null {
  void spec;
  const core = text.replace(/,/g, "").replace(/\s*(mm|cm|m|in|deg|°|%)$/i, "").trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(core)) return null;
  const n = Number(core);
  return Number.isFinite(n) ? Number(n.toFixed(9)) : null;
}

const fmtLimit = (v: number) => String(Number(v.toFixed(6))).replace("-", "−");

/** The number's limits in words ("Between 0.5 and 500 mm", "At least 1"), null when it has none. */
export function limitsText(spec: NumberSpec, unit = ""): string | null {
  const u = unit ? (unit === "°" ? "°" : ` ${unit}`) : "";
  if (spec.min != null && spec.max != null) return `Between ${fmtLimit(spec.min)} and ${fmtLimit(spec.max)}${u}`;
  if (spec.min != null) return `At least ${fmtLimit(spec.min)}${u}`;
  if (spec.max != null) return `At most ${fmtLimit(spec.max)}${u}`;
  return null;
}

/** Why a typed value can't be used (outside the limits), or null when it can: said, never clamped silently. */
export function typedProblem(v: number, spec: NumberSpec, unit = ""): string | null {
  if ((spec.min != null && v < spec.min) || (spec.max != null && v > spec.max)) return `${limitsText(spec, unit)}: ${fmtLimit(v)} is out of range`;
  return null;
}

/** Decimal places that suit a magnitude: hundreds and up 0, tens 1, below 2. */
export function magnitudeDigits(v: number): number {
  const a = Math.abs(v);
  return a >= 100 ? 0 : a >= 10 ? 1 : 2;
}

/**
 * A measured value as every readout prints it: precision by magnitude (12,345 ·
 * 51.8 · 0.12), thousands separated, with its unit. `digits` fixes the precision
 * instead (a volume in mm³ is always whole); `trim` drops trailing zeros (3 not 3.00).
 */
export function formatMagnitude(v: number, unit = "", opts: { digits?: number; trim?: boolean } = {}): string {
  if (!Number.isFinite(v)) return "—";
  const digits = opts.digits ?? magnitudeDigits(v);
  const text = v.toLocaleString("en-US", { minimumFractionDigits: opts.trim ? 0 : digits, maximumFractionDigits: digits });
  return unit ? `${text} ${unit}` : text;
}
