// Curve–curve intersection for sketch editing (trim / extend).
//
// Pure geometry on a neutral curve representation so it can be unit-tested
// without the sketch model. Lines are segments; arcs carry an angular span.

export type Vec = { x: number; y: number };

export interface ICurve {
  kind: "line" | "circle" | "arc";
  a?: Vec; b?: Vec;              // line endpoints
  c?: Vec; r?: number;          // circle/arc center + radius
  a0?: number; a1?: number;     // arc start/end angle (radians)
  ccw?: boolean;                // arc sweep direction a0 → a1
}

const EPS = 1e-7;
const TAU = Math.PI * 2;

const sub = (p: Vec, q: Vec): Vec => ({ x: p.x - q.x, y: p.y - q.y });
const cross = (p: Vec, q: Vec): number => p.x * q.y - p.y * q.x;
const norm = (a: number): number => ((a % TAU) + TAU) % TAU;

/** Is angle `t` within the arc [a0 → a1] sweeping `ccw`? */
export function angleInArc(t: number, a0: number, a1: number, ccw: boolean): boolean {
  let sweep = ccw ? norm(a1 - a0) : norm(a0 - a1);
  if (sweep < EPS) sweep = TAU; // treat a zero span as the full circle
  const delta = ccw ? norm(t - a0) : norm(a0 - t);
  return delta <= sweep + 1e-6;
}

function onArc(p: Vec, cv: ICurve): boolean {
  if (cv.kind !== "arc") return true;
  const t = Math.atan2(p.y - cv.c!.y, p.x - cv.c!.x);
  return angleInArc(t, cv.a0!, cv.a1!, cv.ccw!);
}

function lineLine(a: Vec, b: Vec, c: Vec, d: Vec): Vec[] {
  const r = sub(b, a), s = sub(d, c);
  const denom = cross(r, s);
  if (Math.abs(denom) < EPS) return [];
  const t = cross(sub(c, a), s) / denom;
  const u = cross(sub(c, a), r) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return [];
  return [{ x: a.x + t * r.x, y: a.y + t * r.y }];
}

function lineCircle(a: Vec, b: Vec, c: Vec, r: number): Vec[] {
  const d = sub(b, a), f = sub(a, c);
  const A = d.x * d.x + d.y * d.y;
  if (A < EPS) return [];
  const B = 2 * (f.x * d.x + f.y * d.y);
  const C = f.x * f.x + f.y * f.y - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  const out: Vec[] = [];
  for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
    if (t >= -EPS && t <= 1 + EPS) out.push({ x: a.x + t * d.x, y: a.y + t * d.y });
  }
  return out;
}

function circleCircle(c0: Vec, r0: number, c1: Vec, r1: number): Vec[] {
  const dx = c1.x - c0.x, dy = c1.y - c0.y;
  const d = Math.hypot(dx, dy);
  if (d < EPS || d > r0 + r1 + EPS || d < Math.abs(r0 - r1) - EPS) return [];
  const a = (r0 * r0 - r1 * r1 + d * d) / (2 * d);
  const h2 = r0 * r0 - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;
  const xm = c0.x + (a * dx) / d, ym = c0.y + (a * dy) / d;
  if (h < EPS) return [{ x: xm, y: ym }];
  const ox = (-dy * h) / d, oy = (dx * h) / d;
  return [{ x: xm + ox, y: ym + oy }, { x: xm - ox, y: ym - oy }];
}

/** All intersection points of two curves (arcs filtered to their spans). */
export function intersect(p: ICurve, q: ICurve): Vec[] {
  let pts: Vec[];
  if (p.kind === "line" && q.kind === "line") pts = lineLine(p.a!, p.b!, q.a!, q.b!);
  else if (p.kind === "line") pts = lineCircle(p.a!, p.b!, q.c!, q.r!);
  else if (q.kind === "line") pts = lineCircle(q.a!, q.b!, p.c!, p.r!);
  else pts = circleCircle(p.c!, p.r!, q.c!, q.r!);
  return pts.filter((pt) => onArc(pt, p) && onArc(pt, q));
}

/**
 * Parameter of a point along a curve, used to order intersections:
 *  - line:   t in [0,1] from a→b
 *  - circle: angle fraction in [0,1) from angle 0, ccw
 *  - arc:    fraction in [0,1] of the sweep from a0
 */
export function paramOf(cv: ICurve, p: Vec): number {
  if (cv.kind === "line") {
    const d = sub(cv.b!, cv.a!);
    const len2 = d.x * d.x + d.y * d.y || 1;
    return ((p.x - cv.a!.x) * d.x + (p.y - cv.a!.y) * d.y) / len2;
  }
  const t = Math.atan2(p.y - cv.c!.y, p.x - cv.c!.x);
  if (cv.kind === "circle") return norm(t) / TAU;
  let sweep = cv.ccw ? norm(cv.a1! - cv.a0!) : norm(cv.a0! - cv.a1!);
  if (sweep < EPS) sweep = TAU;
  const delta = cv.ccw ? norm(t - cv.a0!) : norm(cv.a0! - t);
  return delta / sweep;
}

/** Point on a curve at parameter `u` (inverse of paramOf). */
export function pointAt(cv: ICurve, u: number): Vec {
  if (cv.kind === "line") return { x: cv.a!.x + (cv.b!.x - cv.a!.x) * u, y: cv.a!.y + (cv.b!.y - cv.a!.y) * u };
  let ang: number;
  if (cv.kind === "circle") ang = u * TAU;
  else {
    let sweep = cv.ccw ? norm(cv.a1! - cv.a0!) : norm(cv.a0! - cv.a1!);
    if (sweep < EPS) sweep = TAU;
    ang = cv.ccw ? cv.a0! + u * sweep : cv.a0! - u * sweep;
  }
  return { x: cv.c!.x + cv.r! * Math.cos(ang), y: cv.c!.y + cv.r! * Math.sin(ang) };
}
