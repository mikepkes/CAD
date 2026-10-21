// Compiles a Sketch into solver residual blocks, runs the solver, and writes
// the results back. Pure functions over the plain-object Sketch model.

import { ResidualBlock, solve } from "../solver/solver";
import { compileExpr, Scope } from "../math/expr";
import {
  Constraint,
  DimensionConstraint,
  isDimension,
  Sketch,
  SketchArc,
  SketchCircle,
  SketchEntity,
  SketchLine,
  SketchPoint,
} from "./types";

interface VarLayout {
  x: Float64Array;
  locked: boolean[];
  pointVar: Record<string, [number, number]>; // id -> [xi, yi]
  radiusVar: Record<string, number>; // circle/arc id -> ri
}

function buildLayout(sketch: Sketch): VarLayout {
  const pointVar: Record<string, [number, number]> = {};
  const radiusVar: Record<string, number> = {};
  const values: number[] = [];
  const locked: boolean[] = [];

  for (const e of Object.values(sketch.entities)) {
    if (e.kind === "point") {
      const xi = values.length;
      values.push(e.x);
      locked.push(!!e.fixed);
      const yi = values.length;
      values.push(e.y);
      locked.push(!!e.fixed);
      pointVar[e.id] = [xi, yi];
    }
  }
  for (const e of Object.values(sketch.entities)) {
    if (e.kind === "circle" || e.kind === "arc") {
      const ri = values.length;
      values.push(e.r);
      locked.push(false);
      radiusVar[e.id] = ri;
    }
  }
  return { x: Float64Array.from(values), locked, pointVar, radiusVar };
}

const ENT = (s: Sketch, id: string) => s.entities[id];
const asLine = (e: SketchEntity | undefined) =>
  e && e.kind === "line" ? (e as SketchLine) : undefined;
const asCircle = (e: SketchEntity | undefined) =>
  e && e.kind === "circle" ? (e as SketchCircle) : undefined;
const asArc = (e: SketchEntity | undefined) =>
  e && e.kind === "arc" ? (e as SketchArc) : undefined;

// A curve with a radius (circle or arc)
const radiusEntityId = (e: SketchEntity | undefined): string | undefined => {
  if (!e) return undefined;
  if (e.kind === "circle" || e.kind === "arc") return e.id;
  return undefined;
};
const centerOf = (e: SketchEntity | undefined): string | undefined => {
  if (!e) return undefined;
  if (e.kind === "circle") return (e as SketchCircle).center;
  if (e.kind === "arc") return (e as SketchArc).center;
  return undefined;
};

export interface SolveDrag {
  pointId: string;
  x: number;
  y: number;
  weight?: number;
}

export interface SketchSolveResult {
  entities: Record<string, SketchEntity>;
  dimensions: Record<string, number>; // constraint id -> evaluated value
  status: Sketch["status"];
}

/**
 * Solve a sketch against the given parameter scope. Returns new entity
 * positions and status without mutating the input.
 */
export function solveSketch(
  sketch: Sketch,
  scope: Scope = {},
  drag?: SolveDrag
): SketchSolveResult {
  const layout = buildLayout(sketch);
  const { pointVar, radiusVar } = layout;

  const px = (s: Float64Array, id: string) => s[pointVar[id][0]];
  const py = (s: Float64Array, id: string) => s[pointVar[id][1]];
  const pvars = (id: string) => pointVar[id];

  const blocks: ResidualBlock[] = [];
  const dimValues: Record<string, number> = {};
  let dimError: string | undefined;

  // Evaluate a dimension's expression; fall back to its stored value on error.
  const evalDim = (d: DimensionConstraint): number => {
    try {
      const v = compileExpr(d.expr).eval(scope);
      if (!Number.isFinite(v)) throw new Error("non-finite");
      dimValues[d.id] = v;
      return v;
    } catch (err) {
      dimError = `Bad expression "${d.expr}"`;
      dimValues[d.id] = d.value;
      return d.value;
    }
  };

  for (const c of Object.values(sketch.constraints) as Constraint[]) {
    const block = constraintBlock(c);
    if (block) blocks.push(...block);
  }

  function constraintBlock(c: Constraint): ResidualBlock[] | null {
    if (isDimension(c)) return dimensionBlock(c);
    switch (c.type) {
      case "fix":
        // Handled via locking below; also lock here defensively.
        return null;
      case "coincident": {
        const [ax, ay] = pvars(c.a);
        const [bx, by] = pvars(c.b);
        return [
          {
            vars: [ax, ay, bx, by],
            dim: 2,
            eval: (s) => [px(s, c.a) - px(s, c.b), py(s, c.a) - py(s, c.b)],
          },
        ];
      }
      case "horizontal": {
        const [, ay] = pvars(c.a);
        const [, by] = pvars(c.b);
        return [{ vars: [ay, by], dim: 1, eval: (s) => [py(s, c.a) - py(s, c.b)] }];
      }
      case "vertical": {
        const [ax] = pvars(c.a);
        const [bx] = pvars(c.b);
        return [{ vars: [ax, bx], dim: 1, eval: (s) => [px(s, c.a) - px(s, c.b)] }];
      }
      case "parallel": {
        const l1 = asLine(ENT(sketch, c.l1));
        const l2 = asLine(ENT(sketch, c.l2));
        if (!l1 || !l2) return null;
        const vars = lineVars(l1).concat(lineVars(l2));
        return [
          {
            vars,
            dim: 1,
            eval: (s) => {
              const d1 = dir(s, l1);
              const d2 = dir(s, l2);
              return [cross(d1, d2) / (mag(d1) * mag(d2) + 1e-9)];
            },
          },
        ];
      }
      case "perpendicular": {
        const l1 = asLine(ENT(sketch, c.l1));
        const l2 = asLine(ENT(sketch, c.l2));
        if (!l1 || !l2) return null;
        const vars = lineVars(l1).concat(lineVars(l2));
        return [
          {
            vars,
            dim: 1,
            eval: (s) => {
              const d1 = dir(s, l1);
              const d2 = dir(s, l2);
              return [dot(d1, d2) / (mag(d1) * mag(d2) + 1e-9)];
            },
          },
        ];
      }
      case "equal": {
        const e1 = ENT(sketch, c.e1);
        const e2 = ENT(sketch, c.e2);
        const s1 = sizeFn(e1);
        const s2 = sizeFn(e2);
        if (!s1 || !s2) return null;
        return [
          {
            vars: [...s1.vars, ...s2.vars],
            dim: 1,
            eval: (s) => [s1.size(s) - s2.size(s)],
          },
        ];
      }
      case "pointOnLine": {
        const l = asLine(ENT(sketch, c.line));
        if (!l) return null;
        const [pxi, pyi] = pvars(c.point);
        return [
          {
            vars: [pxi, pyi, ...lineVars(l)],
            dim: 1,
            eval: (s) => {
              const a = pt(s, l.p1);
              const d = dir(s, l);
              const p = { x: px(s, c.point), y: py(s, c.point) };
              return [cross(d, { x: p.x - a.x, y: p.y - a.y }) / (mag(d) + 1e-9)];
            },
          },
        ];
      }
      case "pointOnCircle": {
        const cid = radiusEntityId(ENT(sketch, c.circle));
        const centerId = centerOf(ENT(sketch, c.circle));
        if (!cid || !centerId) return null;
        const ri = radiusVar[cid];
        const [pxi, pyi] = pvars(c.point);
        return [
          {
            vars: [pxi, pyi, ...pvars(centerId), ri],
            dim: 1,
            eval: (s) => {
              const d = Math.hypot(px(s, c.point) - px(s, centerId), py(s, c.point) - py(s, centerId));
              return [d - s[ri]];
            },
          },
        ];
      }
      case "concentric": {
        const a = centerOf(ENT(sketch, c.c1));
        const b = centerOf(ENT(sketch, c.c2));
        if (!a || !b) return null;
        return [
          {
            vars: [...pvars(a), ...pvars(b)],
            dim: 2,
            eval: (s) => [px(s, a) - px(s, b), py(s, a) - py(s, b)],
          },
        ];
      }
      case "symmetric": {
        const l = asLine(ENT(sketch, c.line));
        if (!l) return null;
        return [
          {
            vars: [...pvars(c.a), ...pvars(c.b), ...lineVars(l)],
            dim: 2,
            eval: (s) => {
              const a = pt(s, c.a);
              const b = pt(s, c.b);
              const la = pt(s, l.p1);
              const d = dir(s, l);
              const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
              // midpoint lies on the line
              const onLine = cross(d, { x: mid.x - la.x, y: mid.y - la.y }) / (mag(d) + 1e-9);
              // a-b is perpendicular to the line direction
              const ab = { x: a.x - b.x, y: a.y - b.y };
              const perp = dot(d, ab) / (mag(d) + 1e-9);
              return [onLine, perp];
            },
          },
        ];
      }
      case "tangent":
        return tangentBlock(c.a, c.b);
    }
    return null;
  }

  function tangentBlock(aId: string, bId: string): ResidualBlock[] | null {
    const ea = ENT(sketch, aId);
    const eb = ENT(sketch, bId);
    const la = asLine(ea) || asLine(eb);
    const circA = asCircle(ea) || asArc(ea);
    const circB = asCircle(eb) || asArc(eb);
    // line-circle tangent
    if (la) {
      const curve = asCircle(ea) || asArc(ea) || asCircle(eb) || asArc(eb);
      if (!curve) return null;
      const ri = radiusVar[curve.id];
      const centerId = centerOf(curve)!;
      return [
        {
          vars: [...lineVars(la), ...pvars(centerId), ri],
          dim: 1,
          eval: (s) => {
            const a = pt(s, la.p1);
            const d = dir(s, la);
            const ctr = pt(s, centerId);
            const perp = cross(d, { x: ctr.x - a.x, y: ctr.y - a.y }) / (mag(d) + 1e-9);
            return [Math.abs(perp) - s[ri]];
          },
        },
      ];
    }
    // circle-circle tangent
    if (circA && circB) {
      const ca = centerOf(circA)!;
      const cb = centerOf(circB)!;
      const ra = radiusVar[circA.id];
      const rb = radiusVar[circB.id];
      // choose internal vs external tangency from current geometry each solve
      return [
        {
          vars: [...pvars(ca), ...pvars(cb), ra, rb],
          dim: 1,
          eval: (s) => {
            const dist = Math.hypot(px(s, ca) - px(s, cb), py(s, ca) - py(s, cb));
            const ext = Math.abs(dist - (s[ra] + s[rb]));
            const int = Math.abs(dist - Math.abs(s[ra] - s[rb]));
            return [ext < int ? dist - (s[ra] + s[rb]) : dist - Math.abs(s[ra] - s[rb])];
          },
        },
      ];
    }
    return null;
  }

  function dimensionBlock(d: DimensionConstraint): ResidualBlock[] | null {
    const val = evalDim(d);
    switch (d.type) {
      case "distance": {
        if (!d.a || !d.b) return null;
        return [
          {
            vars: [...pvars(d.a), ...pvars(d.b)],
            dim: 1,
            eval: (s) => [Math.hypot(px(s, d.a!) - px(s, d.b!), py(s, d.a!) - py(s, d.b!)) - val],
          },
        ];
      }
      case "distanceX": {
        if (!d.a || !d.b) return null;
        const [ax] = pvars(d.a);
        const [bx] = pvars(d.b);
        return [{ vars: [ax, bx], dim: 1, eval: (s) => [px(s, d.b!) - px(s, d.a!) - val] }];
      }
      case "distanceY": {
        if (!d.a || !d.b) return null;
        const [, ay] = pvars(d.a);
        const [, by] = pvars(d.b);
        return [{ vars: [ay, by], dim: 1, eval: (s) => [py(s, d.b!) - py(s, d.a!) - val] }];
      }
      case "pointLineDistance": {
        const l = asLine(ENT(sketch, d.line!));
        if (!l || !d.point) return null;
        return [
          {
            vars: [...pvars(d.point), ...lineVars(l)],
            dim: 1,
            eval: (s) => {
              const a = pt(s, l.p1);
              const dir0 = dir(s, l);
              const p = pt(s, d.point!);
              const perp = cross(dir0, { x: p.x - a.x, y: p.y - a.y }) / (mag(dir0) + 1e-9);
              return [perp - val];
            },
          },
        ];
      }
      case "radius": {
        const id = radiusEntityId(ENT(sketch, d.circle!));
        if (!id) return null;
        const ri = radiusVar[id];
        return [{ vars: [ri], dim: 1, eval: (s) => [s[ri] - val] }];
      }
      case "diameter": {
        const id = radiusEntityId(ENT(sketch, d.circle!));
        if (!id) return null;
        const ri = radiusVar[id];
        return [{ vars: [ri], dim: 1, eval: (s) => [2 * s[ri] - val] }];
      }
      case "angle": {
        const l1 = asLine(ENT(sketch, d.l1!));
        const l2 = asLine(ENT(sketch, d.l2!));
        if (!l1 || !l2) return null;
        return [
          {
            vars: [...lineVars(l1), ...lineVars(l2)],
            dim: 1,
            eval: (s) => {
              const a = dir(s, l1);
              const b = dir(s, l2);
              const ang = Math.atan2(cross(a, b), dot(a, b));
              let r = ang - val;
              while (r > Math.PI) r -= 2 * Math.PI;
              while (r < -Math.PI) r += 2 * Math.PI;
              return [r];
            },
          },
        ];
      }
    }
    return null;
  }

  // ---- geometric helpers operating on a solver state array ----
  function pt(s: Float64Array, id: string) {
    return { x: px(s, id), y: py(s, id) };
  }
  function dir(s: Float64Array, l: SketchLine) {
    return { x: px(s, l.p2) - px(s, l.p1), y: py(s, l.p2) - py(s, l.p1) };
  }
  function lineVars(l: SketchLine): number[] {
    return [...pvars(l.p1), ...pvars(l.p2)];
  }
  function sizeFn(e: SketchEntity | undefined): { vars: number[]; size: (s: Float64Array) => number } | null {
    if (!e) return null;
    if (e.kind === "line") {
      const l = e as SketchLine;
      return { vars: lineVars(l), size: (s) => mag(dir(s, l)) };
    }
    if (e.kind === "circle" || e.kind === "arc") {
      const ri = radiusVar[e.id];
      return { vars: [ri], size: (s) => s[ri] };
    }
    return null;
  }

  // Lock points that carry `fix` constraints (in addition to .fixed flag).
  for (const c of Object.values(sketch.constraints)) {
    if (!isDimension(c) && c.type === "fix") {
      const [xi, yi] = pointVar[c.point];
      layout.locked[xi] = true;
      layout.locked[yi] = true;
    }
  }

  // Drag: steer a point toward the cursor with a soft anchor + warm start.
  if (drag) {
    const [xi, yi] = pointVar[drag.pointId];
    layout.x[xi] = drag.x;
    layout.x[yi] = drag.y;
    blocks.push({
      vars: [xi, yi],
      dim: 2,
      weight: drag.weight ?? 1,
      eval: (s) => [s[xi] - drag.x, s[yi] - drag.y],
    });
  }

  const result = solve(layout.x, blocks, { lockedVars: layout.locked });

  // Write back entity positions.
  const entities: Record<string, SketchEntity> = {};
  for (const e of Object.values(sketch.entities)) {
    if (e.kind === "point") {
      const [xi, yi] = pointVar[e.id];
      entities[e.id] = { ...e, x: layout.x[xi], y: layout.x[yi] } as SketchPoint;
    } else if (e.kind === "circle" || e.kind === "arc") {
      const ri = radiusVar[e.id];
      entities[e.id] = { ...e, r: Math.abs(layout.x[ri]) } as SketchEntity;
    } else {
      entities[e.id] = { ...e };
    }
  }

  const conflicting = !result.converged && result.maxResidual > 1e-4;
  const status: Sketch["status"] = {
    dof: result.dof,
    fullyConstrained: result.dof === 0 && result.converged,
    converged: result.converged,
    conflicting,
    message: dimError
      ? dimError
      : conflicting
        ? "Constraints are over-defined / conflicting"
        : result.dof === 0 && result.converged
          ? "Fully constrained"
          : `${result.dof} DOF`,
  };

  return { entities, dimensions: dimValues, status };
}

function cross(a: { x: number; y: number }, b: { x: number; y: number }) {
  return a.x * b.y - a.y * b.x;
}
function dot(a: { x: number; y: number }, b: { x: number; y: number }) {
  return a.x * b.x + a.y * b.y;
}
function mag(a: { x: number; y: number }) {
  return Math.hypot(a.x, a.y);
}
