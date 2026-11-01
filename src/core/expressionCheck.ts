// What's wrong with an expression a person typed, before it reaches the model:
// one that doesn't parse, or names a parameter that doesn't exist, is refused
// with a sentence saying so (rather than stored and quietly evaluated as 0).

import { compileExpr } from "../math/expr";

/** null when `expr` parses and uses only `names`; else a sentence for the person who typed it. */
export function expressionProblem(expr: string, names: Iterable<string>): string | null {
  const text = expr.trim();
  if (!text) return "Type a number or an expression";
  let deps: string[];
  try {
    deps = compileExpr(text).deps;
  } catch (e) {
    return `Couldn't read "${text}": ${(e as Error).message}`;
  }
  const known = new Set(names);
  const unknown = deps.filter((d) => !known.has(d));
  if (!unknown.length) return null;
  return unknown.length === 1
    ? `No parameter called ${unknown[0]}: add it in Parameters first, or type ${unknown[0]} = 80 to make it here`
    : `No parameters called ${unknown.join(", ")}: add them in Parameters first`;
}

/** "name = expr" (making a parameter while typing a value): the parts, or null. */
export function parameterAssignment(expr: string): { name: string; expression: string } | null {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(expr);
  return m ? { name: m[1], expression: m[2] } : null;
}
