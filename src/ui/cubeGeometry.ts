// The view cube's geometry (M10): a unit cube turned as the camera is, drawn in
// 2D. Each face, edge and corner is a place to click: it turns the view to look
// from that side (its outward direction; an edge's is its two faces' together,
// a corner's its three). Pure, tested in Node; ViewCube.tsx draws it.

export type V3 = { x: number; y: number; z: number };
export interface Basis { right: V3; up: V3; back: V3 }

const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const add = (...vs: V3[]): V3 => vs.reduce((s, v) => ({ x: s.x + v.x, y: s.y + v.y, z: s.z + v.z }), { x: 0, y: 0, z: 0 });

export const FACES: { name: string; n: V3 }[] = [
  { name: "Top", n: { x: 0, y: 0, z: 1 } }, { name: "Bottom", n: { x: 0, y: 0, z: -1 } },
  { name: "Front", n: { x: 0, y: -1, z: 0 } }, { name: "Back", n: { x: 0, y: 1, z: 0 } },
  { name: "Right", n: { x: 1, y: 0, z: 0 } }, { name: "Left", n: { x: -1, y: 0, z: 0 } },
];

/** The four corners of a face of the unit cube (±1), in order around it. */
function faceCorners(n: V3): V3[] {
  const a: (keyof V3)[] = ["x", "y", "z"];
  const k = a.find((c) => n[c] !== 0)!;
  const [u, v] = a.filter((c) => c !== k);
  const at = (su: number, sv: number): V3 => ({ x: 0, y: 0, z: 0, [k]: n[k], [u]: su, [v]: sv }) as V3;
  return [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
}

export interface CubePart { key: string; label: string; dir: V3; points: { x: number; y: number }[]; depth: number }

/** The cube as the camera sees it, `half` px from its centre to a face: the faces that face the camera (with their
 *  outline), the edges and corners between them, nearest drawn last. */
export function cubeView(b: Basis, half: number): { faces: CubePart[]; edges: CubePart[]; corners: CubePart[] } {
  const proj = (p: V3) => ({ x: dot(p, b.right) * half * 0.62, y: -dot(p, b.up) * half * 0.62 });
  const visible = FACES.filter((f) => dot(f.n, b.back) > 0.02);
  const faces: CubePart[] = visible.map((f) => ({ key: f.name, label: f.name, dir: f.n, points: faceCorners(f.n).map(proj), depth: dot(f.n, b.back) }))
    .sort((p, q) => p.depth - q.depth);
  const edges: CubePart[] = [];
  const corners: CubePart[] = [];
  // edges: pairs of perpendicular faces with at least one visible
  for (let i = 0; i < FACES.length; i++) for (let j = i + 1; j < FACES.length; j++) {
    const A = FACES[i], B = FACES[j];
    if (dot(A.n, B.n) !== 0) continue;
    if (!visible.includes(A) && !visible.includes(B)) continue;
    const mid = add(A.n, B.n);
    const free = (["x", "y", "z"] as (keyof V3)[]).find((c) => mid[c] === 0)!;
    const e1 = { ...mid, [free]: -0.72 } as V3, e2 = { ...mid, [free]: 0.72 } as V3;
    edges.push({ key: `${A.name}-${B.name}`, label: `${A.name} ${B.name.toLowerCase()} edge`, dir: mid, points: [proj(e1), proj(e2)], depth: dot(mid, b.back) });
  }
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const c = { x: sx, y: sy, z: sz };
    if (!FACES.some((f) => visible.includes(f) && dot(f.n, c) > 0)) continue;
    const name = `${sz > 0 ? "Top" : "Bottom"} ${sy < 0 ? "front" : "back"} ${sx > 0 ? "right" : "left"} corner`;
    corners.push({ key: `c${sx}${sy}${sz}`, label: name, dir: c, points: [proj(c)], depth: dot(c, b.back) });
  }
  edges.sort((p, q) => p.depth - q.depth);
  corners.sort((p, q) => p.depth - q.depth);
  return { faces, edges: edges.filter((e) => e.depth > -0.2), corners: corners.filter((c) => c.depth > -0.2) };
}
