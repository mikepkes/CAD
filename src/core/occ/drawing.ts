// The OCC side of a shop drawing's annotations (see core/drawings.ts): a body's
// edges and vertices by their topological names, sampled in world space so a
// dimension can measure them and the drawing can pick them; and a body cut by a
// section plane — the half that is looked at, and the faces the cut made.
//
// Vertices have no names of their own in core/naming.ts, so they are named the
// way edges are: by the faces that meet there, sorted, "A|B|C" (repeats get
// "#k" in edge order).

import type { Shape3D } from "replicad";
import type { Vec3 } from "../../math/vec";
import { dedupe, edgeNamesOf } from "../naming";
import { edgeGeoms, edgeLines, keepHalfSpace } from "./kernel";

/** A B-rep edge in world space: its name, its kind and points along it (a line's two ends; a curve sampled). */
export interface NamedEdge {
  name: string;
  type: "line" | "circle" | "arc" | "other";
  pts: Vec3[];
  /** A circle or an arc: its centre, radius and axis. */
  circle?: { center: Vec3; radius: number; normal: Vec3 };
}

/** A B-rep vertex, named by the faces that meet at it. */
export interface NamedVertex { name: string; at: Vec3 }

type OcEdge = { geomType: string; length: number; startPoint: Vec3; endPoint: Vec3; pointAt(t: number): Vec3; delete(): void };
type OcFace = { geomType: string; center: Vec3; normalAt(p?: unknown): Vec3; edges: OcEdge[]; delete(): void };
const edgesOf = (s: Shape3D): OcEdge[] => (s as unknown as { edges: OcEdge[] }).edges;
const facesOf = (s: Shape3D): OcFace[] => (s as unknown as { faces: OcFace[] }).faces;
const freeAll = (xs: { delete(): void }[]) => { for (const x of xs) { try { x.delete(); } catch { /* already freed */ } } };
const v3 = (p: Vec3): Vec3 => ({ x: p.x, y: p.y, z: p.z });
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const len2 = (a: Vec3) => a.x * a.x + a.y * a.y + a.z * a.z;

/** The circle through three points (centre, radius, unit axis), or undefined when they are in a line. */
export function circleThrough(a: Vec3, b: Vec3, c: Vec3): { center: Vec3; radius: number; normal: Vec3 } | undefined {
  const ab = sub(b, a), ac = sub(c, a), n = cross(ab, ac), nn = len2(n);
  if (nn < 1e-18 * Math.max(1, len2(ab) * len2(ac))) return undefined;
  const t1 = cross(ac, n), t2 = cross(n, ab), k1 = len2(ab) / (2 * nn), k2 = len2(ac) / (2 * nn);
  const off = { x: t1.x * k1 + t2.x * k2, y: t1.y * k1 + t2.y * k2, z: t1.z * k1 + t2.z * k2 };
  const m = Math.sqrt(nn);
  return { center: { x: a.x + off.x, y: a.y + off.y, z: a.z + off.z }, radius: Math.sqrt(len2(off)), normal: { x: n.x / m, y: n.y / m, z: n.z / m } };
}

/** One edge sampled: a line as its two ends, a circle every 7.5°, anything else by length (a long helix finely). */
function sampleEdge(e: OcEdge): Omit<NamedEdge, "name"> & { closed: boolean } {
  const type = String(e.geomType).toUpperCase();
  const sp = v3(e.startPoint), ep = v3(e.endPoint);
  const closed = Math.sqrt(len2(sub(sp, ep))) < 1e-6;
  if (type === "LINE") return { type: "line", pts: [sp, ep], closed: false };
  let L = 0;
  try { L = e.length; } catch { /* sampled coarsely */ }
  if (type === "CIRCLE") {
    const circle = closed ? circleThrough(e.pointAt(0), e.pointAt(1 / 3), e.pointAt(2 / 3)) : circleThrough(sp, e.pointAt(0.5), ep);
    const span = circle ? L / circle.radius : 2 * Math.PI;
    const n = Math.max(4, Math.ceil(span / (Math.PI / 24)));
    const pts: Vec3[] = [];
    for (let i = 0; i <= n; i++) pts.push(v3(e.pointAt(i / n)));
    return { type: closed ? "circle" : "arc", pts, closed, ...(circle ? { circle } : {}) };
  }
  const n = Math.max(8, Math.min(400, Math.ceil(L / 2)));
  const pts: Vec3[] = [];
  for (let i = 0; i <= n; i++) pts.push(v3(e.pointAt(i / n)));
  return { type: "other", pts, closed };
}

/** A body's edges (named as core/naming.ts names them, from its face names) and vertices (named by the faces
 *  that meet there), in world space. Seam edges — a closed face meeting itself — are left out, as are the
 *  vertices only seams and closed curves pass through. Does NOT free the shape. */
export function namedTopology(shape: Shape3D, faceNames: string[]): { edges: NamedEdge[]; vertices: NamedVertex[] } {
  const geoms = edgeGeoms(shape);
  const names = edgeNamesOf(geoms, faceNames);
  const raw = edgesOf(shape);
  const edges: NamedEdge[] = [];
  const corners = new Map<string, { at: Vec3; faces: Set<number> }>();
  try {
    raw.forEach((e, i) => {
      const g = geoms[i];
      if (!g || g.faces.length < 2) return; // a seam (or a free edge)
      const s = sampleEdge(e);
      edges.push({ name: names[i], type: s.type, pts: s.pts, ...(s.circle ? { circle: s.circle } : {}) });
      if (s.closed) return;
      for (const p of [s.pts[0], s.pts[s.pts.length - 1]]) {
        const key = `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)},${Math.round(p.z * 1e4)}`;
        let c = corners.get(key);
        if (!c) { c = { at: p, faces: new Set() }; corners.set(key, c); }
        for (const f of g.faces) c.faces.add(f);
      }
    });
  } finally { freeAll(raw); }
  const list = [...corners.values()];
  const vnames = dedupe(list.map((c) => [...new Set([...c.faces].map((f) => faceNames[f] ?? `f${f}`))].sort().join("|")));
  return { edges, vertices: list.map((c, i) => ({ name: vnames[i], at: c.at })) };
}

/** A body cut by a section plane: the half on the side `normal` points to (the side looked at) as edge
 *  segments (flat xyz pairs, as a display mesh's `edges`), and the boundaries of the faces the cut made,
 *  sampled. Undefined when nothing of the body is on that side. Does NOT free the shape. */
export function sectionOfShape(shape: Shape3D, origin: Vec3, normal: Vec3): { edges: Float32Array; caps: Vec3[][] } | undefined {
  let kept: Shape3D;
  try { kept = keepHalfSpace(shape, origin, normal); } catch { return undefined; }
  try {
    const edges = edgeLines(kept);
    const m = Math.sqrt(len2(normal)) || 1, n = { x: normal.x / m, y: normal.y / m, z: normal.z / m };
    const caps: Vec3[][] = [];
    const faces = facesOf(kept);
    try {
      for (const f of faces) {
        if (String(f.geomType).toUpperCase() !== "PLANE") continue;
        let fn: Vec3;
        try { fn = f.normalAt(); } catch { continue; }
        const fm = Math.sqrt(len2(fn)) || 1;
        if (Math.abs((fn.x * n.x + fn.y * n.y + fn.z * n.z) / fm) < 0.9999) continue;
        const c = f.center, off = (c.x - origin.x) * n.x + (c.y - origin.y) * n.y + (c.z - origin.z) * n.z;
        if (Math.abs(off) > 1e-4 * Math.max(1, Math.sqrt(len2(c)))) continue; // parallel to the cut, not on it
        const fe = f.edges;
        try { for (const e of fe) caps.push(sampleEdge(e).pts); } finally { freeAll(fe); }
      }
    } finally { freeAll(faces); }
    return { edges, caps };
  } finally { kept.delete(); }
}
