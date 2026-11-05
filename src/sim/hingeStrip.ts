// A living hinge drawn bent. A flexure joint moves its part about a pivot (the
// small-length flexural pivot of src/sim/flexure.ts); this draws the strip that
// does the bending, from where it leaves the base part to where it arrives on
// the moved part, curved the way a thin strip under a pure moment curves: a
// single arc. The arc is a cubic Bézier whose handles follow each part's
// rotation (the strip leaves the base along its as-modelled chord and arrives
// on the moved part along that chord turned with the part), with the handle
// length of a circular arc through the bend angle. Straight at rest, a
// semicircle at 180° when the ends are a hinge-loop's diameter apart.
import { Vec3 } from "../math/vec";
import { Rigid, applyPoint, applyVec } from "../math/transform";
import type { CadDocument, Joint } from "../core/document";
import type { SolidMesh } from "../core/occ/kernel";

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const unit = (a: Vec3): Vec3 => { const l = len(a); return l > 1e-12 ? mul(a, 1 / l) : { x: 1, y: 0, z: 0 }; };

export interface StripEnds {
  /** Where the strip leaves the base part and arrives on the moved part (world). */
  from: Vec3;
  to: Vec3;
  /** The strip's direction leaving `from` and arriving at `to` (world, unit). */
  d0: Vec3;
  d1: Vec3;
  /** The strip's unstretched length. */
  length: number;
}

/** The bent strip's centreline: `n` + 1 points with unit tangents. */
export function bentStripPath(e: StripEnds, n = 24): { points: Vec3[]; tangents: Vec3[]; bendAngle: number } {
  const d0 = unit(e.d0), d1 = unit(e.d1);
  const phi = Math.acos(Math.max(-1, Math.min(1, dot(d0, d1))));
  // A cubic through an arc of angle φ and radius r has handles (4/3)·tan(φ/4)·r; straight, L/3.
  const k = phi < 1e-6 ? e.length / 3 : (4 / 3) * Math.tan(phi / 4) * (e.length / phi);
  const p0 = e.from, p3 = e.to, p1 = add(p0, mul(d0, k)), p2 = sub(p3, mul(d1, k));
  const points: Vec3[] = [], tangents: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n, u = 1 - s;
    points.push(add(add(mul(p0, u * u * u), mul(p1, 3 * u * u * s)), add(mul(p2, 3 * u * s * s), mul(p3, s * s * s))));
    const t = add(add(mul(sub(p1, p0), 3 * u * u), mul(sub(p2, p1), 6 * u * s)), mul(sub(p3, p2), 3 * s * s));
    tangents.push(len(t) > 1e-9 ? unit(t) : (i === 0 ? d0 : i === n ? d1 : tangents[i - 1]));
  }
  return { points, tangents, bendAngle: phi };
}

/** A rectangular-section strip swept along the bent centreline: `width` along
 *  `across` (the hinge axis), `thickness` in the bending plane. Flat-shaded
 *  faces, four long edges and both end outlines. */
export function bentStripMesh(e: StripEnds, across: Vec3, width: number, thickness: number, n = 24): SolidMesh {
  const { points, tangents } = bentStripPath(e, n);
  return stripMeshAlong(points, tangents, across, width, thickness);
}

/** A strip through a polyline (a solved beam's nodes): the tangent at a corner
 *  is the mean of its two segments', so the section is mitred there. */
export function polylineStripMesh(points: Vec3[], across: Vec3, width: number, thickness: number): SolidMesh {
  const n = points.length - 1;
  const seg = (i: number) => unit(sub(points[Math.min(n, i + 1)], points[Math.max(0, i)]));
  const tangents = points.map((_, i) => (i === 0 ? seg(0) : i === n ? seg(n - 1) : unit(add(seg(i - 1), seg(i)))));
  return stripMeshAlong(points, tangents, across, width, thickness);
}

function stripMeshAlong(points: Vec3[], tangents: Vec3[], across: Vec3, width: number, thickness: number): SolidMesh {
  const n = points.length - 1;
  const W = unit(across);
  const rings = points.map((p, i) => {
    const N = unit(cross(W, tangents[i]));
    const w = mul(W, width / 2), t = mul(N, thickness / 2);
    return [add(add(p, w), t), add(sub(p, w), t), sub(sub(p, w), t), sub(add(p, w), t)];
  });
  const pos: number[] = [], nor: number[] = [], idx: number[] = [], edges: number[] = [];
  const push = (p: Vec3, nrm: Vec3) => { pos.push(p.x, p.y, p.z); nor.push(nrm.x, nrm.y, nrm.z); return pos.length / 3 - 1; };
  const tri = (a: Vec3, b: Vec3, c: Vec3, outward: Vec3) => {
    const nrm = unit(cross(sub(b, a), sub(c, a)));
    const flip = dot(nrm, outward) < 0;
    const [x, y, z] = flip ? [a, c, b] : [a, b, c];
    const fn = flip ? mul(nrm, -1) : nrm;
    idx.push(push(x, fn), push(y, fn), push(z, fn));
  };
  // the four long faces, each quad as two triangles facing out of the strip
  for (let i = 0; i < n; i++) {
    const r0 = rings[i], r1 = rings[i + 1];
    const c0 = points[i], c1 = points[i + 1];
    for (let j = 0; j < 4; j++) {
      const a = r0[j], b = r0[(j + 1) % 4], c = r1[(j + 1) % 4], d = r1[j];
      const mid = mul(add(add(a, b), add(c, d)), 0.25), centre = mul(add(c0, c1), 0.5);
      const outward = sub(mid, centre);
      tri(a, b, c, outward);
      tri(a, c, d, outward);
    }
  }
  // the end caps
  const cap = (r: Vec3[], outward: Vec3) => { tri(r[0], r[1], r[2], outward); tri(r[0], r[2], r[3], outward); };
  cap(rings[0], mul(tangents[0], -1));
  cap(rings[n], tangents[n]);
  // edges: the long corners and the end outlines
  const seg = (a: Vec3, b: Vec3) => edges.push(a.x, a.y, a.z, b.x, b.y, b.z);
  for (let i = 0; i < n; i++) for (let j = 0; j < 4; j++) seg(rings[i][j], rings[i + 1][j]);
  for (const r of [rings[0], rings[n]]) for (let j = 0; j < 4; j++) seg(r[j], r[(j + 1) % 4]);
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint32Array(idx), edges: new Float32Array(edges), triangleCount: idx.length / 3 };
}

/** A flexure joint's strip ends in the world, from its attachment points and
 *  the parts' placements: the strip leaves the base along the as-modelled chord
 *  and arrives on the moved part along that chord turned with it. */
export function flexureStripEnds(j: Joint, world: Map<string, Rigid>, identity: Rigid): StripEnds | undefined {
  const strip = j.flexure?.strip;
  if (!strip) return undefined;
  const Wb = world.get(j.base) ?? identity, Wm = world.get(j.moved) ?? identity;
  const chord = sub(strip.to, strip.from);
  const length = len(chord);
  if (!(length > 1e-9)) return undefined;
  const d = unit(chord);
  return { from: applyPoint(Wb, strip.from), to: applyPoint(Wm, strip.to), d0: applyVec(Wb, d), d1: applyVec(Wm, d), length };
}

/** The drawn strips of every flexure joint with attachment points. */
export function flexureStripMeshes(doc: CadDocument, world: Map<string, Rigid>, identity: Rigid): { joint: Joint; mesh: SolidMesh; bounds: { min: Vec3; max: Vec3 } }[] {
  const out: { joint: Joint; mesh: SolidMesh; bounds: { min: Vec3; max: Vec3 } }[] = [];
  for (const j of Object.values(doc.joints)) {
    if (j.kind !== "flexure" || !j.flexure?.strip || j.error) continue;
    const ends = flexureStripEnds(j, world, identity);
    if (!ends) continue;
    const across = applyVec(world.get(j.base) ?? identity, unit(j.axis));
    const mesh = bentStripMesh(ends, across, j.flexure.width, j.flexure.thickness);
    const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (let i = 0; i < mesh.positions.length; i += 3) {
      min.x = Math.min(min.x, mesh.positions[i]); max.x = Math.max(max.x, mesh.positions[i]);
      min.y = Math.min(min.y, mesh.positions[i + 1]); max.y = Math.max(max.y, mesh.positions[i + 1]);
      min.z = Math.min(min.z, mesh.positions[i + 2]); max.z = Math.max(max.z, mesh.positions[i + 2]);
    }
    out.push({ joint: j, mesh, bounds: { min, max } });
  }
  return out;
}
