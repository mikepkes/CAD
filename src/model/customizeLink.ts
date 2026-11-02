// A customize link carries the values its controls were set to, so a configured
// model can be sent on: ?mode=customize&example=motor&size=4&length=70. Only
// values moved off the model's own defaults go in the link; opening it sets
// them before the first build. A value is data, never an expression: a number,
// snapped onto the control (an option's index, a checkbox's 0/1, inside a
// slider's range).

import type { CadDocument } from "../core/document";
import type { OperationRecord } from "../core/command/types";

/** The link's own keys, which a parameter of the same name can't use. */
export const RESERVED = new Set(["mode", "customize", "model", "example", "demo"]);

type Meta = { min?: number; max?: number; values?: number[]; options?: string[]; boolean?: boolean; hidden?: boolean };

/** Each linkable parameter: its declaring operation, and the operation that last set its expression. */
function linkable(doc: CadDocument): Map<string, { meta: Meta; last: OperationRecord }> {
  const out = new Map<string, { meta: Meta; last: OperationRecord }>();
  const live = doc.operations.slice(0, doc.rollbackIndex).filter((o) => !o.suppressed);
  for (const op of live) {
    const name = op.params.name;
    if (typeof name !== "string" || typeof op.params.expression !== "string") continue;
    if (op.type === "parameter.add") {
      const meta = op.params as Meta;
      const control = (meta.min != null && meta.max != null) || !!meta.values?.length || !!meta.options?.length || !!meta.boolean;
      if (control && !meta.hidden && !RESERVED.has(name)) out.set(name, { meta, last: op });
    } else if (op.type === "parameter.set" && out.has(name)) out.get(name)!.last = op;
  }
  return out;
}

/** The model's own value for each linkable parameter (its expression as the file has it). */
export function linkDefaults(doc: CadDocument): Record<string, string> {
  return Object.fromEntries([...linkable(doc)].map(([name, { last }]) => [name, last.params.expression as string]));
}

/** A link's value for a control, snapped onto it; null when it isn't one. */
export function snapValue(meta: Meta, raw: string): number | null {
  if (!/^\s*-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(raw)) return null;
  let v = Number(raw);
  if (!Number.isFinite(v)) return null;
  if (meta.boolean) return v ? 1 : 0;
  if (meta.options?.length) { v = Math.round(v); return v >= 0 && v < meta.options.length ? v : null; }
  if (meta.values?.length) return meta.values.find((x) => Math.abs(x - v) <= 1e-9) ?? null;
  if (meta.min != null) v = Math.max(meta.min, v);
  if (meta.max != null) v = Math.min(meta.max, v);
  return v;
}

/** Set the document's controls to a link's values, before it is built (the operations replay with them).
 *  Returns the names it set. */
export function applyLinkValues(doc: CadDocument, search: URLSearchParams): string[] {
  const set: string[] = [];
  for (const [name, { meta, last }] of linkable(doc)) {
    const raw = search.get(name);
    if (raw == null) continue;
    const v = snapValue(meta, raw);
    if (v == null) continue;
    last.params = { ...last.params, expression: String(v) };
    set.push(name);
  }
  return set;
}

/** The query string for the controls as they stand: the link's other keys kept, each control
 *  moved off its default written (as its value), the rest left out. */
export function linkSearch(search: string, current: { name: string; expr: string; value: number }[], defaults: Record<string, string>): string {
  const q = new URLSearchParams(search);
  for (const { name, expr, value } of current) {
    if (!(name in defaults)) continue;
    if (expr.trim() !== defaults[name].trim() && Number.isFinite(value)) q.set(name, String(+value.toFixed(6)));
    else q.delete(name);
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}
