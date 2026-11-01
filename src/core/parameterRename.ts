// Renaming a parameter everywhere it's used. Expressions anywhere in the recipe
// (dimensions, feature sizes, joint values, plane offsets, other parameters,
// intents, configuration cells) are rewritten identifier by identifier, so
// "width" in "width*2+widths" becomes "w*2+widths"; commands that name a
// parameter (parameter.set/setBounds/delete, a material choice's `by`, a
// configuration's value keys) are renamed outright. Prose (names, labels) is
// never touched.

import type { OperationRecord } from "./command/types";
import { compileExpr } from "../math/expr";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The identifier `name` as a whole word, not a function name, not after a "." (a number or a member). */
const identifier = (name: string) => new RegExp(`(?<![A-Za-z0-9_.])${escape(name)}(?![A-Za-z0-9_])(?!\\s*\\()`, "g");

/** `src` with every use of the identifier `from` renamed to `to`; unchanged unless it's an expression that uses `from`. */
export function renameInExpression(src: string, from: string, to: string): string {
  try {
    if (!compileExpr(src).deps.includes(from)) return src;
  } catch {
    return src; // not an expression (a name, an id, prose)
  }
  return src.replace(identifier(from), to);
}

/** Keys whose string values are prose or ids, never expressions. */
export const NOT_EXPRESSIONS = new Set(["name", "label", "title", "description", "unit", "kind", "type", "finish", "species", "color", "texture", "textureAxis", "printAxis", "op", "operation", "extent", "direction", "profile", "plane", "base", "datum", "sketch", "component", "parent", "moved", "material", "body", "slotBase", "gear", "id"]);
/** Commands whose `name` (or other key) names a parameter. */
const NAMES_A_PARAMETER: Record<string, string[]> = {
  "parameter.add": ["name"], "parameter.set": ["name"], "parameter.setBounds": ["name"], "parameter.delete": ["name"],
  "material.assign": ["by"],
};

function renameValue(v: unknown, key: string | null, from: string, to: string): unknown {
  if (typeof v === "string") return key !== null && NOT_EXPRESSIONS.has(key) ? v : renameInExpression(v, from, to);
  if (Array.isArray(v)) return v.map((x) => renameValue(x, null, from, to));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = renameValue(x, k, from, to);
    return out;
  }
  return v;
}

/** An operation's params with the parameter `from` renamed to `to` (the same object if nothing changed). */
export function renameInOperation(op: OperationRecord, from: string, to: string): Record<string, unknown> {
  const p = op.params as Record<string, unknown>;
  let out = renameValue(p, null, from, to) as Record<string, unknown>;
  for (const k of NAMES_A_PARAMETER[op.type] ?? []) if (out[k] === from) out = { ...out, [k]: to };
  // a configuration's cells are keyed by parameter name
  if (op.type.startsWith("configuration.") && out.values && typeof out.values === "object" && from in (out.values as object)) {
    const values = { ...(out.values as Record<string, unknown>) };
    values[to] = values[from];
    delete values[from];
    out = { ...out, values };
  }
  return JSON.stringify(out) === JSON.stringify(p) ? p : out;
}
