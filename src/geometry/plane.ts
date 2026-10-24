// Origin work planes. A plane maps 2D sketch coordinates (u, v) to 3D world
// space: world = origin + u*U + v*V, with N the outward normal. We use a
// Z-up world (CAD convention).

import { Vec3, v3 } from "../math/vec";

export interface WorkPlane {
  id: string;
  name: string;
  origin: Vec3;
  u: Vec3; // in-plane "x"
  v: Vec3; // in-plane "y"
  normal: Vec3;
  color: string;
}

export const PLANES: WorkPlane[] = [
  {
    id: "XY",
    name: "Top (XY)",
    origin: v3(0, 0, 0),
    u: v3(1, 0, 0),
    v: v3(0, 1, 0),
    normal: v3(0, 0, 1),
    color: "#4f8cff",
  },
  {
    id: "XZ",
    name: "Front (XZ)",
    origin: v3(0, 0, 0),
    u: v3(1, 0, 0),
    v: v3(0, 0, 1),
    normal: v3(0, -1, 0),
    color: "#48c78e",
  },
  {
    id: "YZ",
    name: "Right (YZ)",
    origin: v3(0, 0, 0),
    u: v3(0, 1, 0),
    v: v3(0, 0, 1),
    normal: v3(1, 0, 0),
    color: "#ff6b6b",
  },
];

export const planeById = (id: string): WorkPlane =>
  PLANES.find((p) => p.id === id) ?? PLANES[0];

const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const normalize = (a: Vec3): Vec3 => { const m = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / m, y: a.y / m, z: a.z / m }; };

/** Build a work plane from an origin and a normal (u/v chosen stably). */
export function makePlaneFromNormal(origin: Vec3, normal: Vec3, name = "Face", color = "#c9a227"): WorkPlane {
  const n = normalize(normal);
  const ref: Vec3 = Math.abs(n.z) < 0.9 ? v3(0, 0, 1) : v3(1, 0, 0);
  const u = normalize(cross(ref, n));
  const v = normalize(cross(n, u));
  return { id: "custom", name, origin, u, v, normal: n, color };
}

/** Offset a plane along its normal. */
export function offsetPlane(wp: WorkPlane, d: number): WorkPlane {
  return { ...wp, origin: { x: wp.origin.x + wp.normal.x * d, y: wp.origin.y + wp.normal.y * d, z: wp.origin.z + wp.normal.z * d } };
}

/** Resolve the work plane a sketch lives on (stored custom plane, else origin plane). */
export function resolveSketchPlane(sk: { planeId: string; plane?: WorkPlane }): WorkPlane {
  return sk.plane ?? planeById(sk.planeId);
}

/** Convert a 2D sketch point on `plane` to 3D world coordinates. */
export function to3d(plane: WorkPlane, u: number, v: number): Vec3 {
  return {
    x: plane.origin.x + plane.u.x * u + plane.v.x * v,
    y: plane.origin.y + plane.u.y * u + plane.v.y * v,
    z: plane.origin.z + plane.u.z * u + plane.v.z * v,
  };
}

/** Project a 3D world point onto `plane`, returning sketch (u, v). */
export function to2d(plane: WorkPlane, p: Vec3): { u: number; v: number } {
  const dx = p.x - plane.origin.x;
  const dy = p.y - plane.origin.y;
  const dz = p.z - plane.origin.z;
  return {
    u: dx * plane.u.x + dy * plane.u.y + dz * plane.u.z,
    v: dx * plane.v.x + dy * plane.v.y + dz * plane.v.z,
  };
}
