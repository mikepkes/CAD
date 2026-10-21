// Given the current selection, decide which geometric constraints and
// dimensions can be applied, mirroring Fusion's context-sensitive toolbar.
// Each op produces a command dispatch {type, params}; the UI dispatches it
// (with rejectOnConflict), so over-constraints are caught and reported.

import { Sketch, SketchArc, SketchCircle, SketchLine, SketchPoint } from "../sketch/types";

export interface Op {
  id: string;
  label: string;
  glyph: string;
  hint: string;
  command: { type: string; params: Record<string, unknown> };
}

interface Sel {
  points: SketchPoint[];
  lines: SketchLine[];
  radii: (SketchCircle | SketchArc)[];
}

function classify(sk: Sketch, selection: string[]): Sel {
  const sel: Sel = { points: [], lines: [], radii: [] };
  for (const id of selection) {
    const e = sk.entities[id];
    if (!e) continue;
    if (e.kind === "point") sel.points.push(e);
    else if (e.kind === "line") sel.lines.push(e);
    else if (e.kind === "circle" || e.kind === "arc") sel.radii.push(e);
  }
  return sel;
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

export function availableOps(sk: Sketch, selection: string[]): { geometric: Op[]; dimensions: Op[] } {
  const s = classify(sk, selection);
  const geometric: Op[] = [];
  const dimensions: Op[] = [];
  const sid = sk.id;
  const pt = (id: string) => sk.entities[id] as SketchPoint;
  const dirOf = (l: SketchLine) => ({ x: pt(l.p2).x - pt(l.p1).x, y: pt(l.p2).y - pt(l.p1).y });

  const geo = (id: string, label: string, glyph: string, hint: string, params: Record<string, unknown>) =>
    geometric.push({ id, label, glyph, hint, command: { type: "sketch.addConstraint", params: { sketch: sid, ...params } } });
  const dim = (id: string, label: string, glyph: string, hint: string, params: Record<string, unknown>) =>
    dimensions.push({ id, label, glyph, hint, command: { type: "sketch.addDimension", params: { sketch: sid, ...params } } });

  // ---- geometric ----
  if (s.points.length === 2 && s.lines.length === 0) {
    const [a, b] = s.points;
    geo("coincident", "Coincident", "⟺", "Make two points coincident", { type: "coincident", a: a.id, b: b.id });
    geo("horizontal", "Horizontal", "—", "Horizontal between points", { type: "horizontal", a: a.id, b: b.id });
    geo("vertical", "Vertical", "|", "Vertical between points", { type: "vertical", a: a.id, b: b.id });
  }
  if (s.lines.length === 1 && s.points.length === 0) {
    const l = s.lines[0];
    geo("horizontal", "Horizontal", "—", "Make line horizontal", { type: "horizontal", a: l.p1, b: l.p2 });
    geo("vertical", "Vertical", "|", "Make line vertical", { type: "vertical", a: l.p1, b: l.p2 });
  }
  if (s.lines.length === 2) {
    const [l1, l2] = s.lines;
    geo("parallel", "Parallel", "∥", "Make lines parallel", { type: "parallel", l1: l1.id, l2: l2.id });
    geo("perpendicular", "Perpendicular", "⊥", "Make lines perpendicular", { type: "perpendicular", l1: l1.id, l2: l2.id });
    geo("equal", "Equal", "=", "Make lengths equal", { type: "equal", e1: l1.id, e2: l2.id });
  }
  if (s.radii.length === 2 && s.lines.length === 0 && s.points.length === 0) {
    const [c1, c2] = s.radii;
    geo("equal", "Equal", "=", "Make radii equal", { type: "equal", e1: c1.id, e2: c2.id });
    geo("concentric", "Concentric", "◎", "Share center", { type: "concentric", c1: c1.id, c2: c2.id });
    geo("tangent", "Tangent", "◯", "Make tangent", { type: "tangent", a: c1.id, b: c2.id });
  }
  if (s.lines.length === 1 && s.radii.length === 1) {
    geo("tangent", "Tangent", "◯", "Line tangent to circle", { type: "tangent", a: s.lines[0].id, b: s.radii[0].id });
  }
  if (s.points.length === 1 && s.lines.length === 1) {
    geo("pointOnLine", "On Line", "•—", "Point lies on line", { type: "pointOnLine", point: s.points[0].id, line: s.lines[0].id });
  }
  if (s.points.length === 1 && s.radii.length === 1) {
    geo("pointOnCircle", "On Circle", "•◯", "Point lies on circle", { type: "pointOnCircle", point: s.points[0].id, circle: s.radii[0].id });
  }
  if (s.points.length === 2 && s.lines.length === 1) {
    geo("symmetric", "Symmetric", "⧓", "Symmetric about line", { type: "symmetric", a: s.points[0].id, b: s.points[1].id, line: s.lines[0].id });
  }
  if (s.points.length >= 1 && s.lines.length === 0 && s.radii.length === 0) {
    geo("fix", "Fix", "⚓", "Lock point in place", { type: "fix", point: s.points[0].id });
  }

  // ---- dimensions ----
  if (s.points.length === 2 && s.lines.length === 0) {
    const [a, b] = s.points;
    dim("distance", "Distance", "↔", "Distance between points", { type: "distance", a: a.id, b: b.id, expression: fmt(Math.hypot(a.x - b.x, a.y - b.y)) });
    dim("distanceX", "Horiz. Dist", "↔x", "Horizontal distance", { type: "distanceX", a: a.id, b: b.id, expression: fmt(b.x - a.x) });
    dim("distanceY", "Vert. Dist", "↕y", "Vertical distance", { type: "distanceY", a: a.id, b: b.id, expression: fmt(b.y - a.y) });
  }
  if (s.lines.length === 1 && s.points.length === 0) {
    const l = s.lines[0];
    const a = pt(l.p1), b = pt(l.p2);
    dim("length", "Length", "↔", "Line length", { type: "distance", a: l.p1, b: l.p2, expression: fmt(Math.hypot(a.x - b.x, a.y - b.y)) });
  }
  if (s.radii.length === 1 && s.lines.length === 0 && s.points.length === 0) {
    const c = s.radii[0];
    dim("radius", "Radius", "R", "Set radius", { type: "radius", circle: c.id, expression: fmt(c.r) });
    dim("diameter", "Diameter", "⌀", "Set diameter", { type: "diameter", circle: c.id, expression: fmt(c.r * 2) });
  }
  if (s.lines.length === 2) {
    const [l1, l2] = s.lines;
    const d1 = dirOf(l1), d2 = dirOf(l2);
    const ang = Math.atan2(d1.x * d2.y - d1.y * d2.x, d1.x * d2.x + d1.y * d2.y);
    dim("angle", "Angle", "∠", "Angle between lines", { type: "angle", l1: l1.id, l2: l2.id, expression: fmt(ang) });
  }

  return { geometric, dimensions };
}
