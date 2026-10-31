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

/** The value after an arrow key (null when the key is not one): up/right step up, down/left step down, shift ×10. */
export function keyStep(v: number, key: string, shift: boolean, spec: NumberSpec): number | null {
  const d = key === "ArrowRight" || key === "ArrowUp" ? 1 : key === "ArrowLeft" || key === "ArrowDown" ? -1 : 0;
  if (!d) return null;
  return quantize(v + d * spec.step * (shift ? 10 : 1), spec);
}

/** A number as the prose shows it: the step's precision, thousands separated, with its unit. */
export function formatValue(v: number, spec: NumberSpec, unit = ""): string {
  const digits = decimals(spec.step);
  const text = Number.isFinite(v) ? v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "—";
  return unit ? `${text} ${unit}` : text;
}

/** Parse what someone typed into a live number (a plain number only; expressions go through the document). */
export function parseTyped(text: string, spec: NumberSpec): number | null {
  const core = text.replace(/,/g, "").replace(/[a-z°%\s]+$/i, "").trim();
  if (!/\d/.test(core)) return null;
  const n = Number(core);
  return Number.isFinite(n) ? quantize(n, spec) : null;
}
