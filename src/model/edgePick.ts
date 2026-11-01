// Edges of a display mesh by topological name, for picking edges in the
// viewport (fillet / chamfer edge-pick mode) and for "Round edges" on a face.
// A B-rep edge is named by the two faces it separates ("A|B", naming.ts), so a
// display edge segment is named by the faces whose triangles meet at both of
// its ends. Names survive upstream edits; coordinates don't (M25).
// Pure: no three.js, no store.

import type { SolidMesh } from "../core/occ/kernel";

type P3 = { x: number; y: number; z: number };

const key = (x: number, y: number, z: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;

const cache = new WeakMap<SolidMesh, (string | null)[]>();

/** The name of the B-rep edge each display segment lies on ("A|B", face names sorted), or null when the mesh carries
 *  no face names or the segment's faces can't be told. Cached per mesh. */
export function segmentEdgeNames(mesh: SolidMesh): (string | null)[] {
  const hit = cache.get(mesh);
  if (hit) return hit;
  const out: (string | null)[] = [];
  const names = mesh.faceNames, ranges = mesh.faceRanges;
  const nSeg = Math.floor(mesh.edges.length / 6);
  if (!names || !ranges) { for (let i = 0; i < nSeg; i++) out.push(null); cache.set(mesh, out); return out; }
  // each vertex position → the faces whose triangles use it
  const facesAt = new Map<string, Set<number>>();
  const P = mesh.positions, I = mesh.indices;
  for (let k = 0; k < names.length; k++) {
    const start = ranges[2 * k], count = ranges[2 * k + 1];
    for (let i = start; i < start + count && i < I.length; i++) {
      const v = I[i] * 3;
      const kk = key(P[v], P[v + 1], P[v + 2]);
      let s = facesAt.get(kk);
      if (!s) facesAt.set(kk, (s = new Set()));
      s.add(k);
    }
  }
  const E = mesh.edges;
  for (let i = 0; i < nSeg; i++) {
    const a = facesAt.get(key(E[6 * i], E[6 * i + 1], E[6 * i + 2]));
    const b = facesAt.get(key(E[6 * i + 3], E[6 * i + 4], E[6 * i + 5]));
    const both = a && b ? [...a].filter((f) => b.has(f)) : [];
    if (both.length === 2) out.push([names[both[0]], names[both[1]]].sort().join("|"));
    else if (both.length === 1) out.push(`${names[both[0]]}|${names[both[0]]}`); // a seam
    else out.push(null);
  }
  cache.set(mesh, out);
  return out;
}

/** The world segments (flat xyz pairs) of every display segment on the named edges, for the highlight. */
export function edgeSegments(mesh: SolidMesh, edgeNames: string[]): Float32Array {
  const want = new Set(edgeNames);
  const names = segmentEdgeNames(mesh);
  const out: number[] = [];
  names.forEach((n, i) => { if (n && want.has(n)) for (let j = 0; j < 6; j++) out.push(mesh.edges[6 * i + j]); });
  return new Float32Array(out);
}

/** Every edge around a named face: the names of the edges between it and each neighbour ("Round edges"). */
export function edgesAroundFace(mesh: SolidMesh, faceName: string): string[] {
  const out = new Set<string>();
  for (const n of segmentEdgeNames(mesh)) {
    if (!n) continue;
    const [a, b] = n.split("|");
    if ((a === faceName) !== (b === faceName)) out.add(n);
  }
  return [...out];
}

/** The edges running straight back from a flat face (parallel to its normal, entirely behind it) — a plate's top →
 *  its corner edges ("Round corners"), by name. */
export function edgesBehindFace(mesh: SolidMesh, point: P3, normal: P3): string[] {
  const out = new Set<string>();
  const names = segmentEdgeNames(mesh), E = mesh.edges, eps = 1e-4;
  names.forEach((n, i) => {
    if (!n) return;
    const a = { x: E[6 * i], y: E[6 * i + 1], z: E[6 * i + 2] }, b = { x: E[6 * i + 3], y: E[6 * i + 4], z: E[6 * i + 5] };
    const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, len = Math.hypot(d.x, d.y, d.z);
    if (len < 1e-9) return;
    if (Math.abs((d.x * normal.x + d.y * normal.y + d.z * normal.z) / len) < 0.999) return;
    const behind = (p: P3) => (p.x - point.x) * normal.x + (p.y - point.y) * normal.y + (p.z - point.z) * normal.z <= eps;
    if (behind(a) && behind(b)) out.add(n);
  });
  // an edge counts only when every one of its segments qualified (a curved edge that only partly runs back doesn't)
  return [...out];
}

/** The display segment nearest a screen point, within `maxPx`: its body and edge name. `project` maps world → screen. */
export function nearestEdge(
  bodies: { bodyId: string; mesh: SolidMesh }[],
  at: { x: number; y: number },
  project: (p: P3) => { x: number; y: number },
  maxPx = 8,
): { bodyId: string; name: string; point: P3 } | null {
  let best: { bodyId: string; name: string; point: P3; d: number } | null = null;
  for (const { bodyId, mesh } of bodies) {
    const names = segmentEdgeNames(mesh), E = mesh.edges;
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (!name) continue;
      const A = { x: E[6 * i], y: E[6 * i + 1], z: E[6 * i + 2] }, B = { x: E[6 * i + 3], y: E[6 * i + 4], z: E[6 * i + 5] };
      const a = project(A), b = project(B);
      const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
      const t = L > 0 ? Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / L)) : 0;
      const d = Math.hypot(a.x + t * dx - at.x, a.y + t * dy - at.y);
      if (d <= maxPx && (!best || d < best.d)) best = { bodyId, name, d, point: { x: A.x + t * (B.x - A.x), y: A.y + t * (B.y - A.y), z: A.z + t * (B.z - A.z) } };
    }
  }
  return best ? { bodyId: best.bodyId, name: best.name, point: best.point } : null;
}
