// A two-plate mould check on the display meshes. The mould opens along `pull`:
// the cavity lifts off along +pull and forms every face that looks that way,
// the core drops away along −pull and forms every face that looks the other
// way. A face neither half can reach — one looking up with material above it
// (a hook's lip over its post), or looking down with material below — is an
// undercut, and needs a side action or a redesign. A wall steeper than the
// draft angle is reachable but will drag; it is flagged separately.
//
// Reach is tested by a ray from each triangle's centre along the half's pull
// direction against every body's mesh (the part as moulded is one piece, so
// another body counts as material too). The rays are all parallel, so the
// triangles are bucketed by their projection onto the plane across the pull
// and each ray tests only the bucket it falls in.
import type { Vec3 } from "../math/vec";

/** A display mesh. With `faceRanges` (the B-rep face each run of triangles came from: [start, count] pairs into
 *  `indices`), a triangle on a face whose facets all lean alike — a plane, a cone — is classified by the face's
 *  mean lean, not its own facet: the facets of a 1° cone jitter either side of the draft threshold, the face does
 *  not. A face whose lean varies (a round) keeps its facets. The facet always decides what a triangle blocks. */
export interface MouldMesh { positions: Float32Array; indices: Uint32Array; faceRanges?: number[] }

/** Per-triangle verdicts, as the shader reads them off a vertex attribute. */
export const MOULD = { ok: 0, steep: 1, undercut: 2 } as const;

/** The check's result: a verdict per vertex (the shader's attribute) and, per triangle, which half forms it:
 *  +1 the cavity (it looks along the pull), −1 the core (against it), 0 a wall or an undercut. */
export interface MouldCheck { flags: Float32Array[]; sides: Int8Array[] }

const GRID = 96;
const EPS = 1e-4;
// A blocker is a face with real extent across the pull. A display mesh triangulates a shallow cone or a
// drafted wall with facets whose normals jitter a few degrees either side of the true one, so a facet
// that looks slightly down must not count as material over its neighbour that looks slightly up.
const BLOCK_MIN = Math.sin((5 * Math.PI) / 180);

/** Per mesh, one flag per vertex (MOULD.*): the verdict of the triangle that wrote it last. Meshes over
 *  `maxTriangles` in all are given up on (every flag `ok`), so a huge model doesn't stall the view. */
export function mouldFlags(meshes: MouldMesh[], pull: Vec3, draftDeg: number, maxTriangles = 400_000): Float32Array[] {
  return mouldCheck(meshes, pull, draftDeg, maxTriangles).flags;
}

/** The check itself: the flags, and each triangle's half. */
export function mouldCheck(meshes: MouldMesh[], pull: Vec3, draftDeg: number, maxTriangles = 400_000): MouldCheck {
  const pl = Math.hypot(pull.x, pull.y, pull.z) || 1;
  const p = { x: pull.x / pl, y: pull.y / pl, z: pull.z / pl };
  // a frame across the pull: u, v span the projection plane
  const a = Math.abs(p.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const u = norm(cross(a, p)), v = cross(p, u);
  const total = meshes.reduce((s, m) => s + m.indices.length / 3, 0);
  const out = meshes.map((m) => new Float32Array(m.positions.length / 3));
  const sides = meshes.map((m) => new Int8Array(m.indices.length / 3));
  if (total === 0) return { flags: out, sides };
  const sinDraft = Math.sin((draftDeg * Math.PI) / 180);

  // every triangle projected: (u, v) of its corners, its height along the pull at each corner, its normal's pull component
  type Tri = { au: number; av: number; bu: number; bv: number; cu: number; cv: number; ah: number; bh: number; ch: number; d: number; facet: number; mesh: number; tri: number };
  const tris: Tri[] = [];
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  meshes.forEach((m, mi) => {
    const P = m.positions, I = m.indices;
    // each triangle's B-rep face, and the face's mean lean when its facets agree
    const faceOf = new Int32Array(I.length / 3).fill(-1);
    const R = m.faceRanges ?? [];
    for (let fi = 0; 2 * fi + 1 < R.length; fi++) for (let k = R[2 * fi]; k < R[2 * fi] + R[2 * fi + 1]; k += 3) if (k / 3 < faceOf.length) faceOf[k / 3] = fi;
    const faceD = new Float64Array(R.length / 2), faceDD = new Float64Array(R.length / 2), faceN = new Int32Array(R.length / 2);
    const facetD = new Float64Array(I.length / 3);
    for (let t = 0; t < I.length; t += 3) {
      const [A, B, C] = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3];
      const nx = (P[B + 1] - P[A + 1]) * (P[C + 2] - P[A + 2]) - (P[B + 2] - P[A + 2]) * (P[C + 1] - P[A + 1]);
      const ny = (P[B + 2] - P[A + 2]) * (P[C] - P[A]) - (P[B] - P[A]) * (P[C + 2] - P[A + 2]);
      const nz = (P[B] - P[A]) * (P[C + 1] - P[A + 1]) - (P[B + 1] - P[A + 1]) * (P[C] - P[A]);
      const nl = Math.hypot(nx, ny, nz);
      const d = nl < 1e-12 ? 0 : (nx * p.x + ny * p.y + nz * p.z) / nl;
      facetD[t / 3] = d;
      const fi = faceOf[t / 3];
      if (fi >= 0 && nl >= 1e-12) { faceD[fi] += d; faceDD[fi] += d * d; faceN[fi]++; }
    }
    const SPREAD = Math.sin((1.5 * Math.PI) / 180); // facets within this of their face's mean lean: the face is one surface
    const agree = new Uint8Array(faceN.length);
    for (let fi = 0; fi < faceN.length; fi++) {
      if (faceN[fi] < 2) continue;
      const mean = faceD[fi] / faceN[fi], sd = Math.sqrt(Math.max(0, faceDD[fi] / faceN[fi] - mean * mean));
      agree[fi] = sd < SPREAD ? 1 : 0;
      faceD[fi] = mean;
    }
    for (let t = 0; t < I.length; t += 3) {
      const [A, B, C] = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3];
      const ax = P[A], ay = P[A + 1], az = P[A + 2], bx = P[B], by = P[B + 1], bz = P[B + 2], cx = P[C], cy = P[C + 1], cz = P[C + 2];
      const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay), ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az), nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-12) continue;
      const fi = faceOf[t / 3];
      const d = fi >= 0 && agree[fi] ? faceD[fi] : facetD[t / 3];
      const tr: Tri = {
        au: ax * u.x + ay * u.y + az * u.z, av: ax * v.x + ay * v.y + az * v.z, ah: ax * p.x + ay * p.y + az * p.z,
        bu: bx * u.x + by * u.y + bz * u.z, bv: bx * v.x + by * v.y + bz * v.z, bh: bx * p.x + by * p.y + bz * p.z,
        cu: cx * u.x + cy * u.y + cz * u.z, cv: cx * v.x + cy * v.y + cz * v.z, ch: cx * p.x + cy * p.y + cz * p.z,
        d, facet: (nx * p.x + ny * p.y + nz * p.z) / nl, mesh: mi, tri: t,
      };
      tris.push(tr);
      minU = Math.min(minU, tr.au, tr.bu, tr.cu); maxU = Math.max(maxU, tr.au, tr.bu, tr.cu);
      minV = Math.min(minV, tr.av, tr.bv, tr.cv); maxV = Math.max(maxV, tr.av, tr.bv, tr.cv);
    }
  });
  if (total > maxTriangles) return { flags: out, sides };

  // bucket the triangles that can block a ray (the ones with some extent across the pull)
  const su = (maxU - minU) || 1, sv = (maxV - minV) || 1;
  const cellU = (x: number) => Math.min(GRID - 1, Math.max(0, Math.floor(((x - minU) / su) * GRID)));
  const cellV = (y: number) => Math.min(GRID - 1, Math.max(0, Math.floor(((y - minV) / sv) * GRID)));
  const buckets: Tri[][] = Array.from({ length: GRID * GRID }, () => []);
  for (const tr of tris) {
    if (Math.abs(tr.facet) < BLOCK_MIN) continue; // a wall (or a wall's facet jitter): it blocks nothing
    const u0 = cellU(Math.min(tr.au, tr.bu, tr.cu)), u1 = cellU(Math.max(tr.au, tr.bu, tr.cu));
    const v0 = cellV(Math.min(tr.av, tr.bv, tr.cv)), v1 = cellV(Math.max(tr.av, tr.bv, tr.cv));
    for (let i = u0; i <= u1; i++) for (let j = v0; j <= v1; j++) buckets[i * GRID + j].push(tr);
  }

  /** Is there material from (qu, qv) at height h onward along +pull (dir 1) or −pull (dir −1)? */
  const blocked = (qu: number, qv: number, h: number, dir: 1 | -1, self: Tri): boolean => {
    for (const tr of buckets[cellU(qu) * GRID + cellV(qv)]) {
      if (tr === self) continue;
      // the ray's point in the triangle's projection (barycentric)
      const d00 = tr.bu - tr.au, d01 = tr.bv - tr.av, d10 = tr.cu - tr.au, d11 = tr.cv - tr.av;
      const det = d00 * d11 - d01 * d10;
      if (Math.abs(det) < 1e-12) continue;
      const w0 = qu - tr.au, w1 = qv - tr.av;
      const l1 = (w0 * d11 - w1 * d10) / det, l2 = (d00 * w1 - d01 * w0) / det;
      if (l1 < -1e-6 || l2 < -1e-6 || l1 + l2 > 1 + 1e-6) continue;
      const th = tr.ah + l1 * (tr.bh - tr.ah) + l2 * (tr.ch - tr.ah);
      // material lies on the far side of a face that looks back at the ray
      if ((th - h) * dir > EPS && tr.facet * dir < 0) return true;
    }
    return false;
  };

  for (const tr of tris) {
    const qu = (tr.au + tr.bu + tr.cu) / 3, qv = (tr.av + tr.bv + tr.cv) / 3, h = (tr.ah + tr.bh + tr.ch) / 3;
    let flag: number, side = 0;
    if (tr.d >= sinDraft) { flag = blocked(qu, qv, h, 1, tr) ? MOULD.undercut : MOULD.ok; side = flag === MOULD.ok ? 1 : 0; }           // the cavity's face
    else if (tr.d <= -sinDraft) { flag = blocked(qu, qv, h, -1, tr) ? MOULD.undercut : MOULD.ok; side = flag === MOULD.ok ? -1 : 0; }   // the core's face
    else flag = blocked(qu, qv, h, 1, tr) && blocked(qu, qv, h, -1, tr) ? MOULD.undercut : MOULD.steep; // a wall: steep, or boxed in
    const I = meshes[tr.mesh].indices, f = out[tr.mesh];
    f[I[tr.tri]] = flag; f[I[tr.tri + 1]] = flag; f[I[tr.tri + 2]] = flag;
    sides[tr.mesh][tr.tri / 3] = side;
  }
  return { flags: out, sides };
}

/** The parting line: every mesh edge where a cavity-formed triangle meets a core-formed one, as line segments
 *  (flat xyz pairs). Where the two halves meet across a wall there is no such edge: the wall shows as steep,
 *  and the line stops at it. Edges are matched by position, so a seam's doubled vertices still pair up. */
export function partingSegments(meshes: MouldMesh[], sides: Int8Array[]): Float32Array {
  const out: number[] = [];
  meshes.forEach((m, mi) => {
    const P = m.positions, I = m.indices, S = sides[mi];
    if (!S) return;
    const key = (i: number) => `${Math.round(P[3 * i] * 1e4)},${Math.round(P[3 * i + 1] * 1e4)},${Math.round(P[3 * i + 2] * 1e4)}`;
    // each edge, by its two corners' positions: the halves of the triangles on it
    const edges = new Map<string, { a: number; b: number; cavity: boolean; core: boolean }>();
    for (let t = 0; t < I.length; t += 3) {
      const side = S[t / 3];
      if (!side) continue;
      for (let k = 0; k < 3; k++) {
        const a = I[t + k], b = I[t + ((k + 1) % 3)];
        const ka = key(a), kb = key(b);
        const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        let e = edges.get(ek);
        if (!e) { e = { a, b, cavity: false, core: false }; edges.set(ek, e); }
        if (side > 0) e.cavity = true; else e.core = true;
      }
    }
    for (const e of edges.values()) if (e.cavity && e.core) out.push(P[3 * e.a], P[3 * e.a + 1], P[3 * e.a + 2], P[3 * e.b], P[3 * e.b + 1], P[3 * e.b + 2]);
  });
  return Float32Array.from(out);
}

/** A summary for a readout: how much of the surface each verdict covers (triangle counts). */
export function mouldSummary(meshes: MouldMesh[], flags: Float32Array[]): { ok: number; steep: number; undercut: number } {
  const s = { ok: 0, steep: 0, undercut: 0 };
  meshes.forEach((m, i) => {
    for (let t = 0; t < m.indices.length; t += 3) {
      const f = flags[i][m.indices[t]];
      if (f === MOULD.undercut) s.undercut++; else if (f === MOULD.steep) s.steep++; else s.ok++;
    }
  });
  return s;
}

const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };
