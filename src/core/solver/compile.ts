// Compile a Sketch (design intent: geometry topology + constraints with
// parametric expressions) into a neutral SolverModel (pure numbers). This is
// the only place the parameter/expression system meets the solver, and the
// only place that knows both our sketch model and the neutral solver model.

import { compileExpr, Scope } from "../../math/expr";
import {
  Constraint,
  DimensionConstraint,
  isDimension,
  Sketch,
  SketchArc,
  SketchCircle,
  SketchLine,
  SketchPoint,
} from "../../sketch/types";
import { SolverConstraint, SolverModel } from "./model";

export interface CompileResult {
  model: SolverModel;
  warnings: string[];
  /** Map of dimension constraint id -> evaluated numeric value (for readback). */
  dimensionValues: Record<string, number>;
}

export function compileSketch(sketch: Sketch, scope: Scope = {}): CompileResult {
  const warnings: string[] = [];
  const dimensionValues: Record<string, number> = {};

  const fixedPoints = new Set<string>();
  for (const c of Object.values(sketch.constraints)) {
    if (!isDimension(c) && c.type === "fix") fixedPoints.add(c.point);
  }

  const points: SolverModel["points"] = [];
  const lines: SolverModel["lines"] = [];
  const circles: SolverModel["circles"] = [];
  const arcs: SolverModel["arcs"] = [];

  for (const e of Object.values(sketch.entities)) {
    switch (e.kind) {
      case "point": {
        const p = e as SketchPoint;
        points.push({ id: p.id, x: p.x, y: p.y, fixed: !!p.fixed || fixedPoints.has(p.id) });
        break;
      }
      case "line": {
        const l = e as SketchLine;
        lines.push({ id: l.id, p1: l.p1, p2: l.p2 });
        break;
      }
      case "circle": {
        const c = e as SketchCircle;
        circles.push({ id: c.id, center: c.center, r: c.r });
        break;
      }
      case "arc": {
        const a = e as SketchArc;
        arcs.push({ id: a.id, center: a.center, start: a.p1, end: a.p2, r: a.r });
        break;
      }
    }
  }

  const evalExpr = (d: DimensionConstraint): number => {
    try {
      const v = compileExpr(d.expr).eval(scope);
      if (!Number.isFinite(v)) throw new Error("non-finite");
      dimensionValues[d.id] = v;
      return v;
    } catch {
      warnings.push(`Dimension ${d.id}: bad expression "${d.expr}"`);
      dimensionValues[d.id] = d.value;
      return d.value;
    }
  };

  const centerOf = (id: string): string | undefined => {
    const e = sketch.entities[id];
    if (e?.kind === "circle") return (e as SketchCircle).center;
    if (e?.kind === "arc") return (e as SketchArc).center;
    return undefined;
  };
  const isRadiusEntity = (id: string) => {
    const e = sketch.entities[id];
    return e?.kind === "circle" || e?.kind === "arc";
  };

  const constraints: SolverConstraint[] = [];
  const push = (c: SolverConstraint | null) => c && constraints.push(c);

  for (const c of Object.values(sketch.constraints) as Constraint[]) {
    if (isDimension(c)) {
      // Driven (reference) dimensions measure geometry; they add no solver
      // constraint and their value is read back after the solve.
      if (c.driven) continue;
      const v = evalExpr(c);
      switch (c.type) {
        case "distance":
          if (c.a && c.b) push({ id: c.id, kind: "distance", a: c.a, b: c.b, value: v });
          break;
        case "distanceX":
          if (c.a && c.b) push({ id: c.id, kind: "distanceX", a: c.a, b: c.b, value: v });
          break;
        case "distanceY":
          if (c.a && c.b) push({ id: c.id, kind: "distanceY", a: c.a, b: c.b, value: v });
          break;
        case "radius":
          if (c.circle) push({ id: c.id, kind: "radius", circle: c.circle, value: v });
          break;
        case "diameter":
          if (c.circle) push({ id: c.id, kind: "diameter", circle: c.circle, value: v });
          break;
        case "angle":
          if (c.l1 && c.l2) push({ id: c.id, kind: "angle", l1: c.l1, l2: c.l2, value: v });
          break;
        case "pointLineDistance":
          if (c.point && c.line) push({ id: c.id, kind: "pointLineDistance", point: c.point, line: c.line, value: v });
          break;
      }
      continue;
    }

    switch (c.type) {
      case "coincident":
        push({ id: c.id, kind: "coincident", a: c.a, b: c.b });
        break;
      case "horizontal":
        push({ id: c.id, kind: "horizontal", a: c.a, b: c.b });
        break;
      case "vertical":
        push({ id: c.id, kind: "vertical", a: c.a, b: c.b });
        break;
      case "parallel":
        push({ id: c.id, kind: "parallel", l1: c.l1, l2: c.l2 });
        break;
      case "perpendicular":
        push({ id: c.id, kind: "perpendicular", l1: c.l1, l2: c.l2 });
        break;
      case "collinear": {
        // Collinear = parallel + one endpoint of l2 lies on l1's infinite line.
        const l2 = sketch.entities[c.l2];
        if (sketch.entities[c.l1]?.kind === "line" && l2?.kind === "line") {
          push({ id: c.id, kind: "parallel", l1: c.l1, l2: c.l2 });
          push({ id: c.id + "~on", kind: "pointOnLine", point: (l2 as SketchLine).p1, line: c.l1 });
        }
        break;
      }
      case "equal": {
        if (isRadiusEntity(c.e1) && isRadiusEntity(c.e2)) {
          push({ id: c.id, kind: "equalRadius", c1: c.e1, c2: c.e2 });
        } else {
          push({ id: c.id, kind: "equalLength", l1: c.e1, l2: c.e2 });
        }
        break;
      }
      case "pointOnLine":
        push({ id: c.id, kind: "pointOnLine", point: c.point, line: c.line });
        break;
      case "midpoint": {
        const l = sketch.entities[c.line];
        if (l && l.kind === "line") push({ id: c.id, kind: "midpoint", a: (l as SketchLine).p1, b: (l as SketchLine).p2, point: c.point });
        break;
      }
      case "pointOnCircle":
        push({ id: c.id, kind: "pointOnCircle", point: c.point, circle: c.circle });
        break;
      case "concentric": {
        const a = centerOf(c.c1);
        const b = centerOf(c.c2);
        if (a && b) push({ id: c.id, kind: "coincident", a, b });
        break;
      }
      case "symmetric":
        push({ id: c.id, kind: "symmetric", a: c.a, b: c.b, line: c.line });
        break;
      case "tangent":
        warnings.push(`tangent not yet mapped to the solver (${c.id})`);
        break;
      case "fix":
        // handled via fixed points above
        break;
    }
  }

  return { model: { points, lines, circles, arcs, constraints }, warnings, dimensionValues };
}
