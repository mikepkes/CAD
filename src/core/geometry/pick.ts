// Pick a body face from display meshes — no kernel needed, so any host that
// holds evaluated solids (the browser store, the headless MCP server) can turn
// "the face under this world point" into a sketch plane + parametric face ref.

import { Vec3 } from "../../math/vec";
import type { SolidMesh } from "../occ/kernel";

export interface FacePick {
  /** Closest point on the picked face (the pick snapped onto the surface). */
  point: Vec3;
  /** Outward unit normal of the picked face. */
  normal: Vec3;
  /** Distance from the query point to the face. */
  distance: number;
  /** Sketch origin convention: foot of the perpendicular from the world origin to the face plane. */
  origin: Vec3;
  featureId: string;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const norm = (a: Vec3): Vec3 => { const m = Math.hypot(a.x, a.y, a.z) || 1; return scale(a, 1 / m); };

/** Closest point on triangle (a,b,c) to p (Ericson, Real-Time Collision Detection). */
function closestOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return add(b, scale(sub(c, b), w)); }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return add(a, add(scale(ab, v), scale(ac, w)));
}

/**
 * The face nearest to `p` across every mesh. Planar faces are what sketches
 * bind to, so the pick returns the triangle's geometric normal (flat-shaded
 * meshes make this exact for planar faces).
 */
export function pickFace(meshes: { featureId: string; mesh: SolidMesh }[], p: Vec3): FacePick | null {
  let best: FacePick | null = null;
  for (const { featureId, mesh } of meshes) {
    const pos = mesh.positions, idx = mesh.indices;
    const at = (i: number): Vec3 => ({ x: pos[i * 3], y: pos[i * 3 + 1], z: pos[i * 3 + 2] });
    for (let t = 0; t < idx.length; t += 3) {
      const a = at(idx[t]), b = at(idx[t + 1]), c = at(idx[t + 2]);
      const q = closestOnTriangle(p, a, b, c);
      const d = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
      if (best && d >= best.distance) continue;
      const n = norm(cross(sub(b, a), sub(c, a)));
      if (!Number.isFinite(n.x)) continue;
      const off = dot(q, n);
      best = { point: q, normal: n, distance: d, origin: scale(n, off), featureId };
    }
  }
  return best;
}
