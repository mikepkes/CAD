// A tiny, dependency-free expression evaluator for parametric dimensions.
// Supports: + - * / ^, unary minus, parentheses, numbers, named variables,
// and a set of math functions. No eval()/Function() — safe to run anywhere.

export type Scope = Record<string, number>;

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  sqrt: Math.sqrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  // degrees <-> radians helpers (angles in sketches are stored in radians)
  rad: (d: number) => (d * Math.PI) / 180,
  deg: (r: number) => (r * 180) / Math.PI,
};

const CONSTS: Record<string, number> = {
  pi: Math.PI,
  tau: Math.PI * 2,
  e: Math.E,
};

type Token =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "("; }
  | { t: ")"; }
  | { t: ","; };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < src.length && /[0-9.eE+\-]/.test(src[j])) {
        // Only consume +/- when part of an exponent.
        if ((src[j] === "+" || src[j] === "-") && !(src[j - 1] === "e" || src[j - 1] === "E")) break;
        j++;
      }
      const num = Number(src.slice(i, j));
      if (!Number.isFinite(num)) throw new Error(`Bad number near "${src.slice(i, j)}"`);
      tokens.push({ t: "num", v: num });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      tokens.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/^".includes(c)) {
      tokens.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "(") { tokens.push({ t: "(" }); i++; continue; }
    if (c === ")") { tokens.push({ t: ")" }); i++; continue; }
    if (c === ",") { tokens.push({ t: "," }); i++; continue; }
    throw new Error(`Unexpected character "${c}"`);
  }
  return tokens;
}

export type Node =
  | { k: "num"; v: number }
  | { k: "var"; name: string }
  | { k: "neg"; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "call"; name: string; args: Node[] };

// Recursive-descent parser with standard precedence.
function parse(tokens: Token[]): Node {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpr(): Node {
    return parseAddSub();
  }
  function parseAddSub(): Node {
    let a = parseMul();
    while (peek() && peek().t === "op" && ((peek() as any).v === "+" || (peek() as any).v === "-")) {
      const op = (next() as any).v;
      a = { k: "bin", op, a, b: parseMul() };
    }
    return a;
  }
  function parseMul(): Node {
    let a = parsePow();
    while (peek() && peek().t === "op" && ((peek() as any).v === "*" || (peek() as any).v === "/")) {
      const op = (next() as any).v;
      a = { k: "bin", op, a, b: parsePow() };
    }
    return a;
  }
  function parsePow(): Node {
    const a = parseUnary();
    if (peek() && peek().t === "op" && (peek() as any).v === "^") {
      next();
      // right-associative
      return { k: "bin", op: "^", a, b: parsePow() };
    }
    return a;
  }
  function parseUnary(): Node {
    if (peek() && peek().t === "op" && (peek() as any).v === "-") {
      next();
      return { k: "neg", a: parseUnary() };
    }
    if (peek() && peek().t === "op" && (peek() as any).v === "+") {
      next();
      return parseUnary();
    }
    return parseAtom();
  }
  function parseAtom(): Node {
    const tk = peek();
    if (!tk) throw new Error("Unexpected end of expression");
    if (tk.t === "num") {
      next();
      return { k: "num", v: tk.v };
    }
    if (tk.t === "(") {
      next();
      const e = parseExpr();
      if (!peek() || peek().t !== ")") throw new Error("Expected )");
      next();
      return e;
    }
    if (tk.t === "id") {
      next();
      if (peek() && peek().t === "(") {
        next();
        const args: Node[] = [];
        if (peek() && peek().t !== ")") {
          args.push(parseExpr());
          while (peek() && peek().t === ",") {
            next();
            args.push(parseExpr());
          }
        }
        if (!peek() || peek().t !== ")") throw new Error("Expected ) after arguments");
        next();
        return { k: "call", name: tk.v, args };
      }
      return { k: "var", name: tk.v };
    }
    throw new Error(`Unexpected token`);
  }

  // Use the correct add/sub entry point.
  const ast = parseAddSub();
  if (pos !== tokens.length) throw new Error("Unexpected trailing input");
  return ast;
}

function evalNode(n: Node, scope: Scope): number {
  switch (n.k) {
    case "num":
      return n.v;
    case "var": {
      if (n.name in scope) return scope[n.name];
      if (n.name in CONSTS) return CONSTS[n.name];
      throw new Error(`Unknown name "${n.name}"`);
    }
    case "neg":
      return -evalNode(n.a, scope);
    case "bin": {
      const a = evalNode(n.a, scope);
      const b = evalNode(n.b, scope);
      switch (n.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return a / b;
        case "^": return Math.pow(a, b);
      }
      throw new Error(`Bad operator ${n.op}`);
    }
    case "call": {
      const f = FUNCS[n.name];
      if (!f) throw new Error(`Unknown function "${n.name}"`);
      return f(...n.args.map((a) => evalNode(a, scope)));
    }
  }
}

function collectVars(n: Node, out: Set<string>) {
  switch (n.k) {
    case "var":
      if (!(n.name in CONSTS)) out.add(n.name);
      break;
    case "neg":
      collectVars(n.a, out);
      break;
    case "bin":
      collectVars(n.a, out);
      collectVars(n.b, out);
      break;
    case "call":
      n.args.forEach((a) => collectVars(a, out));
      break;
  }
}

export interface CompiledExpr {
  source: string;
  deps: string[];
  eval: (scope: Scope) => number;
}

/** Parse an expression once; returns an evaluator plus the names it depends on. */
export function compileExpr(source: string): CompiledExpr {
  const ast = parse(tokenize(source));
  const deps = new Set<string>();
  collectVars(ast, deps);
  return {
    source,
    deps: [...deps],
    eval: (scope: Scope) => evalNode(ast, scope),
  };
}

/** Convenience: evaluate directly, throwing on error. */
export function evaluate(source: string, scope: Scope = {}): number {
  return compileExpr(source).eval(scope);
}
