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
  return { scope, resolved };
}

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
export const isValidParamName = (name: string): boolean => NAME_RE.test(name);
