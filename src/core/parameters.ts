// User parameters (named dimensions) with dependency resolution.

import { compileExpr, Scope } from "../math/expr";

export interface Parameter {
  id: string;
  name: string;
  expr: string;
  value: number;
  unit?: string;
  comment?: string;
  error?: string;
  min?: number;
  max?: number;
  /** Increment the value snaps to (a slider only lands on multiples); `step: 1`
   *  makes it integer-only. Measured from `min` when set, else from 0. */
  step?: number;
  values?: number[];
  /** A yes/no switch: values [0, 1], shown as a checkbox (1 = checked). */
  boolean?: boolean;
  /** Named choices (an enum): values [0 … n−1], shown as a dropdown of these names. */
  options?: string[];
  warning?: string;
  /** Set while the active configuration overrides `expr`: the timeline's own expression. */
  baseExpr?: string;
  /** Name of the configuration whose cell supplies `expr`. */
  configuredBy?: string;
}

/** Snap a value to the nearest multiple of `step`, anchored at `base`. */
export function snapToStep(value: number, step?: number, base = 0): number {
  if (!step || !(step > 0) || !Number.isFinite(value)) return value;
  return base + Math.round((value - base) / step) * step;
}

/**
 * Evaluate parameters in dependency order into a flat scope. Parameters that
 * fail (unknown name, cycle, bad syntax) get an `error` and contribute their
 * last known value.
 */
export function resolveParameters(params: Parameter[]): {
  scope: Scope;
  resolved: Parameter[];
} {
  const scope: Scope = {};
  const resolved: Parameter[] = params.map((p) => ({ ...p, error: undefined }));
  const resolvedByName = new Map<string, Parameter>();
  for (const p of resolved) resolvedByName.set(p.name, p);

  const state = new Map<string, "pending" | "done">();

  const visit = (name: string, stack: string[]): number => {
    const p = resolvedByName.get(name);
    if (!p) return NaN; // unknown name; caller reports
    if (state.get(name) === "done") return scope[name];
    if (state.get(name) === "pending") {
      p.error = `Cyclic reference: ${[...stack, name].join(" → ")}`;
      scope[name] = p.value;
      state.set(name, "done");
      return p.value;
    }
    state.set(name, "pending");
    try {
      const c = compileExpr(p.expr);
      const local: Scope = {};
      for (const dep of c.deps) {
        if (resolvedByName.has(dep)) {
          local[dep] = visit(dep, [...stack, name]);
        }
      }
      const v = c.eval(local);
      if (!Number.isFinite(v)) throw new Error("non-finite result");
      p.value = v;
      scope[name] = v;
    } catch (err) {
      p.error = (err as Error).message;
      scope[name] = p.value;
    }
    state.set(name, "done");
    return scope[name];
  };

  for (const p of resolved) visit(p.name, []);

  // Validate extents / enum against the resolved value (advisory — never breaks
  // the model; the UI constrains direct edits, this catches expression drift).
  for (const p of resolved) {
    p.warning = undefined;
    if (p.error || !Number.isFinite(p.value)) continue;
    if (p.values && p.values.length) {
      const ok = p.values.some((v) => Math.abs(v - p.value) <= 1e-9);
      if (!ok) p.warning = `${fmt(p.value)} is not one of ${p.values.map(fmt).join(", ")}`;
    } else {
      if (p.min != null && p.value < p.min - 1e-9) p.warning = `${fmt(p.value)} is below min ${fmt(p.min)}`;
      else if (p.max != null && p.value > p.max + 1e-9) p.warning = `${fmt(p.value)} is above max ${fmt(p.max)}`;
      else if (p.step && p.step > 0) {
        const snapped = snapToStep(p.value, p.step, p.min ?? 0);
        if (Math.abs(snapped - p.value) > 1e-9) p.warning = `${fmt(p.value)} is not a multiple of ${fmt(p.step)}`;
      }
    }
  }
  return { scope, resolved };
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
export const isValidParamName = (name: string): boolean => NAME_RE.test(name);
