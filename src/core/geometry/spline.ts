// Interpolating splines (through-points) and the involute gear outline.
//
// A sketch spline is stored as ordered through-points; its shape is the C1
// cubic that passes through them with Catmull-Rom-style tangents. The kernel
// builds exactly the same cubic Bezier pieces (controls at a third of each
// chord), so what is drawn, what is profiled and what is exported agree.

export interface Pt { x: number; y: number }

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const unit = (v: Pt): Pt => { const m = Math.hypot(v.x, v.y) || 1; return { x: v.x / m, y: v.y / m }; };

/** Unit tangent at every through-point (central differences; one-sided at the ends). */
export function splineTangents(pts: Pt[]): Pt[] {
  const n = pts.length;
  if (n < 2) return pts.map(() => ({ x: 1, y: 0 }));
  return pts.map((_, i) => {
    if (i === 0) return unit(sub(pts[1], pts[0]));
    if (i === n - 1) return unit(sub(pts[n - 1], pts[n - 2]));
    return unit(sub(pts[i + 1], pts[i - 1]));
  });
}

/** The cubic Bezier control points of segment i (P_i → P_{i+1}); controls sit a third of the chord along each tangent. */
export function splineSegmentControls(pts: Pt[], tangents: Pt[], i: number): { c1: Pt; c2: Pt } {
  const a = pts[i], b = pts[i + 1];
  const chord = Math.hypot(b.x - a.x, b.y - a.y) / 3;
  return {
    c1: { x: a.x + tangents[i].x * chord, y: a.y + tangents[i].y * chord },
    c2: { x: b.x - tangents[i + 1].x * chord, y: b.y - tangents[i + 1].y * chord },
  };
}

/** Sample the spline as a polyline: `perSeg` points per segment (first point included, every end point included). */
export function sampleSpline(pts: Pt[], perSeg = 8): Pt[] {
  if (pts.length < 2) return pts.slice();
  const t = splineTangents(pts);
  const out: Pt[] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const { c1, c2 } = splineSegmentControls(pts, t, i);
    for (let k = 1; k <= perSeg; k++) {
      const s = k / perSeg, u = 1 - s;
      out.push({
        x: u * u * u * a.x + 3 * u * u * s * c1.x + 3 * u * s * s * c2.x + s * s * s * b.x,
        y: u * u * u * a.y + 3 * u * u * s * c1.y + 3 * u * s * s * c2.y + s * s * s * b.y,
      });
    }
  }
  return out;
}
