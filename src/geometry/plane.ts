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
