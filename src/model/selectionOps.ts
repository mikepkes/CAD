// Given the current selection, decide which geometric constraints and
// dimensions can be applied, mirroring Fusion's context-sensitive toolbar.

import { Sketch, SketchArc, SketchCircle, SketchLine, SketchPoint } from "../sketch/types";
import { AppState } from "./store";

export interface Op {
  id: string;
  label: string;
  glyph: string;
  hint: string;
  apply: (store: AppState) => void;
}

interface Sel {
  points: SketchPoint[];
  lines: SketchLine[];
  circles: SketchCircle[];
  arcs: SketchArc[];
  radii: (SketchCircle | SketchArc)[];
}

function classify(sk: Sketch, selection: string[]): Sel {
  const sel: Sel = { points: [], lines: [], circles: [], arcs: [], radii: [] };
  for (const id of selection) {
    const e = sk.entities[id];
    if (!e) continue;
    if (e.kind === "point") sel.points.push(e);
    else if (e.kind === "line") sel.lines.push(e);
    else if (e.kind === "circle") {
      sel.circles.push(e);
      sel.radii.push(e);
    } else if (e.kind === "arc") {
      sel.arcs.push(e);
      sel.radii.push(e);
    }
  }
  return sel;
}

const fmt = (n: number) => {
  const r = Math.round(n * 1000) / 1000;
  return String(r);
};

export function availableOps(sk: Sketch, selection: string[]): { geometric: Op[]; dimensions: Op[] } {
  const s = classify(sk, selection);
  const geometric: Op[] = [];
  const dimensions: Op[] = [];
  const pt = (id: string) => sk.entities[id] as SketchPoint;
  const dirOf = (l: SketchLine) => ({ x: pt(l.p2).x - pt(l.p1).x, y: pt(l.p2).y - pt(l.p1).y });

  // --- geometric ---
  if (s.points.length === 2 && s.lines.length === 0) {
    const [a, b] = s.points;
    geometric.push({
      id: "coincident", label: "Coincident", glyph: "⟺", hint: "Make two points coincident",
      apply: (st) => st.addGeometric({ type: "coincident", a: a.id, b: b.id }),
    });
    geometric.push({
      id: "horizontal", label: "Horizontal", glyph: "—", hint: "Horizontal between points",
      apply: (st) => st.addGeometric({ type: "horizontal", a: a.id, b: b.id }),
    });
    geometric.push({
      id: "vertical", label: "Vertical", glyph: "|", hint: "Vertical between points",
      apply: (st) => st.addGeometric({ type: "vertical", a: a.id, b: b.id }),
    });
  }
  if (s.lines.length === 1 && s.points.length === 0) {
    const l = s.lines[0];
    geometric.push({
      id: "horizontal", label: "Horizontal", glyph: "—", hint: "Make line horizontal",
      apply: (st) => st.addGeometric({ type: "horizontal", a: l.p1, b: l.p2 }),
    });
    geometric.push({
      id: "vertical", label: "Vertical", glyph: "|", hint: "Make line vertical",
      apply: (st) => st.addGeometric({ type: "vertical", a: l.p1, b: l.p2 }),
    });
  }
  if (s.lines.length === 2) {
    const [l1, l2] = s.lines;
    geometric.push({
      id: "parallel", label: "Parallel", glyph: "∥", hint: "Make lines parallel",
      apply: (st) => st.addGeometric({ type: "parallel", l1: l1.id, l2: l2.id }),
    });
    geometric.push({
      id: "perpendicular", label: "Perpendicular", glyph: "⊥", hint: "Make lines perpendicular",
      apply: (st) => st.addGeometric({ type: "perpendicular", l1: l1.id, l2: l2.id }),
    });
    geometric.push({
      id: "equal", label: "Equal", glyph: "=", hint: "Make lengths equal",
      apply: (st) => st.addGeometric({ type: "equal", e1: l1.id, e2: l2.id }),
    });
  }
  if (s.radii.length === 2 && s.lines.length === 0 && s.points.length === 0) {
    const [c1, c2] = s.radii;
    geometric.push({
      id: "equal", label: "Equal", glyph: "=", hint: "Make radii equal",
      apply: (st) => st.addGeometric({ type: "equal", e1: c1.id, e2: c2.id }),
    });
    geometric.push({
      id: "concentric", label: "Concentric", glyph: "◎", hint: "Share center",
      apply: (st) => st.addGeometric({ type: "concentric", c1: c1.id, c2: c2.id }),
    });
    geometric.push({
      id: "tangent", label: "Tangent", glyph: "◯", hint: "Make tangent",
      apply: (st) => st.addGeometric({ type: "tangent", a: c1.id, b: c2.id }),
    });
  }
  if (s.lines.length === 1 && s.radii.length === 1) {
    geometric.push({
      id: "tangent", label: "Tangent", glyph: "◯", hint: "Line tangent to circle",
      apply: (st) => st.addGeometric({ type: "tangent", a: s.lines[0].id, b: s.radii[0].id }),
    });
  }
  if (s.points.length === 1 && s.lines.length === 1) {
    geometric.push({
      id: "pointOnLine", label: "On Line", glyph: "•—", hint: "Point lies on line",
      apply: (st) => st.addGeometric({ type: "pointOnLine", point: s.points[0].id, line: s.lines[0].id }),
    });
  }
  if (s.points.length === 1 && s.radii.length === 1) {
    geometric.push({
      id: "pointOnCircle", label: "On Circle", glyph: "•◯", hint: "Point lies on circle",
      apply: (st) => st.addGeometric({ type: "pointOnCircle", point: s.points[0].id, circle: s.radii[0].id }),
    });
  }
  if (s.points.length === 2 && s.lines.length === 1) {
    geometric.push({
      id: "symmetric", label: "Symmetric", glyph: "⧓", hint: "Symmetric about line",
      apply: (st) => st.addGeometric({ type: "symmetric", a: s.points[0].id, b: s.points[1].id, line: s.lines[0].id }),
    });
  }
  if (s.points.length >= 1 && s.lines.length === 0 && s.radii.length === 0) {
    geometric.push({
      id: "fix", label: "Fix", glyph: "⚓", hint: "Lock point(s) in place",
      apply: (st) => s.points.forEach((p) => st.addGeometric({ type: "fix", point: p.id })),
    });
  }

  // --- dimensions ---
  if (s.points.length === 2 && s.lines.length === 0) {
    const [a, b] = s.points;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    dimensions.push({
      id: "distance", label: "Distance", glyph: "↔", hint: "Distance between points",
      apply: (st) => st.addDimension({ type: "distance", a: a.id, b: b.id, expr: fmt(d) }, d),
    });
    dimensions.push({
      id: "distanceX", label: "Horizontal Dist", glyph: "↔x", hint: "Horizontal distance",
      apply: (st) => st.addDimension({ type: "distanceX", a: a.id, b: b.id, expr: fmt(b.x - a.x) }, b.x - a.x),
    });
    dimensions.push({
      id: "distanceY", label: "Vertical Dist", glyph: "↕y", hint: "Vertical distance",
      apply: (st) => st.addDimension({ type: "distanceY", a: a.id, b: b.id, expr: fmt(b.y - a.y) }, b.y - a.y),
    });
  }
  if (s.lines.length === 1 && s.points.length === 0) {
    const l = s.lines[0];
    const a = pt(l.p1);
    const b = pt(l.p2);
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    dimensions.push({
      id: "length", label: "Length", glyph: "↔", hint: "Line length",
      apply: (st) => st.addDimension({ type: "distance", a: l.p1, b: l.p2, expr: fmt(d) }, d),
    });
  }
  if (s.points.length === 1 && s.lines.length === 1) {
    const p = s.points[0];
    const l = s.lines[0];
    const a = pt(l.p1);
    const dir = dirOf(l);
    const mag = Math.hypot(dir.x, dir.y) || 1;
    const perp = (dir.x * (p.y - a.y) - dir.y * (p.x - a.x)) / mag;
    dimensions.push({
      id: "pld", label: "Pt→Line Dist", glyph: "⟂↔", hint: "Distance point to line",
      apply: (st) => st.addDimension({ type: "pointLineDistance", point: p.id, line: l.id, expr: fmt(perp) }, perp),
    });
  }
  if (s.radii.length === 1 && s.lines.length === 0 && s.points.length === 0) {
    const c = s.radii[0];
    dimensions.push({
      id: "radius", label: "Radius", glyph: "R", hint: "Set radius",
      apply: (st) => st.addDimension({ type: "radius", circle: c.id, expr: fmt(c.r) }, c.r),
    });
    dimensions.push({
      id: "diameter", label: "Diameter", glyph: "⌀", hint: "Set diameter",
      apply: (st) => st.addDimension({ type: "diameter", circle: c.id, expr: fmt(c.r * 2) }, c.r * 2),
    });
  }
  if (s.lines.length === 2) {
    const [l1, l2] = s.lines;
    const d1 = dirOf(l1);
    const d2 = dirOf(l2);
    const ang = Math.atan2(d1.x * d2.y - d1.y * d2.x, d1.x * d2.x + d1.y * d2.y);
    dimensions.push({
      id: "angle", label: "Angle", glyph: "∠", hint: "Angle between lines",
      apply: (st) => st.addDimension({ type: "angle", l1: l1.id, l2: l2.id, expr: fmt(ang) }, ang),
    });
  }

  return { geometric, dimensions };
}
