// Rigid transforms (rotation + translation) in 3D, for component placement and
// joints. A transform is an origin plus an orthonormal basis — the images of the
// x/y/z axes — so applying it is the same mapping a WorkPlane uses for (u,v,w).

import { Vec3, v3 } from "./vec";

export interface Rigid {
  origin: Vec3;
  x: Vec3; // image of (1,0,0)
  y: Vec3; // image of (0,1,0)
  z: Vec3; // image of (0,0,1)
}

export const IDENTITY: Rigid = { origin: v3(0, 0, 0), x: v3(1, 0, 0), y: v3(0, 1, 0), z: v3(0, 0, 1) };

export const translation = (t: Vec3): Rigid => ({ ...IDENTITY, origin: { ...t } });

/** Map a point through the transform (rotate then translate). */
export function applyPoint(T: Rigid, p: Vec3): Vec3 {
  return {
    x: T.origin.x + p.x * T.x.x + p.y * T.y.x + p.z * T.z.x,
    y: T.origin.y + p.x * T.x.y + p.y * T.y.y + p.z * T.z.y,
    z: T.origin.z + p.x * T.x.z + p.y * T.y.z + p.z * T.z.z,
  };
}

/** Map a direction (rotation only, no translation). */
export function applyVec(T: Rigid, v: Vec3): Vec3 {
  return {
    x: v.x * T.x.x + v.y * T.y.x + v.z * T.z.x,
    y: v.x * T.x.y + v.y * T.y.y + v.z * T.z.y,
    z: v.x * T.x.z + v.y * T.y.z + v.z * T.z.z,
  };
}

/** Compose two transforms: compose(A, B) applies B, then A. */
export function compose(A: Rigid, B: Rigid): Rigid {
  return { origin: applyPoint(A, B.origin), x: applyVec(A, B.x), y: applyVec(A, B.y), z: applyVec(A, B.z) };
}

/** Inverse of a rigid transform: transpose the (orthonormal) basis, negate the
 *  mapped origin. compose(T, invert(T)) === identity. */
export function invert(T: Rigid): Rigid {
  // Transposed basis: rows of the original become the images of the axes.
  const xT = { x: T.x.x, y: T.y.x, z: T.z.x };
  const yT = { x: T.x.y, y: T.y.y, z: T.z.y };
  const zT = { x: T.x.z, y: T.y.z, z: T.z.z };
  const Rt: Rigid = { origin: v3(0, 0, 0), x: xT, y: yT, z: zT };
  const o = applyVec(Rt, T.origin);
  return { origin: { x: -o.x, y: -o.y, z: -o.z }, x: xT, y: yT, z: zT };
}

const normalize = (a: Vec3): Vec3 => { const m = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / m, y: a.y / m, z: a.z / m }; };

/** A rotation about `axis` (through the origin) by `angle` radians (Rodrigues). */
export function rotation(axis: Vec3, angle: number): Rigid {
  const n = normalize(axis);
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  const { x, y, z } = n;
  // Columns of the rotation matrix = images of the basis vectors.
  return {
    origin: v3(0, 0, 0),
    x: { x: t * x * x + c, y: t * x * y + s * z, z: t * x * z - s * y },
    y: { x: t * x * y - s * z, y: t * y * y + c, z: t * y * z + s * x },
    z: { x: t * x * z + s * y, y: t * y * z - s * x, z: t * z * z + c },
  };
}

/** The rotation part of a transform as a unit axis + angle (radians, 0..π). */
export function axisAngle(T: Rigid): { axis: Vec3; angle: number } {
  // The antisymmetric part R - Rᵀ is 2·sinθ·[n]× and the trace is 1 + 2·cosθ;
  // atan2 of the two stays accurate at both 0 and π (acos of the trace doesn't).
  const w = { x: T.y.z - T.z.y, y: T.z.x - T.x.z, z: T.x.y - T.y.x };
  const s2 = Math.hypot(w.x, w.y, w.z), c2 = T.x.x + T.y.y + T.z.z - 1;
  const angle = Math.atan2(s2, c2), c = Math.max(-1, Math.min(1, c2 / 2));
  if (s2 < 1e-15) { if (c > 0) return { axis: v3(0, 0, 1), angle: 0 }; } // identity
  else if (c > -0.999) return { axis: normalize(w), angle }; // w reliable unless near π
  // Near a half turn w vanishes; use R = cosθ·I + (1 - cosθ)·nnᵀ instead: |n|
  // off the diagonal, relative signs off the symmetric off-diagonals (taken
  // against the largest component), and the overall sign from w where it exists.
  const k = 1 - c;
  const n = { x: Math.sqrt(Math.max(0, (T.x.x - c) / k)), y: Math.sqrt(Math.max(0, (T.y.y - c) / k)), z: Math.sqrt(Math.max(0, (T.z.z - c) / k)) };
  const sgn = (v: number) => (v >= 0 ? 1 : -1);
  if (n.x >= n.y && n.x >= n.z) { n.y *= sgn(T.x.y + T.y.x); n.z *= sgn(T.x.z + T.z.x); }
  else if (n.y >= n.z) { n.x *= sgn(T.x.y + T.y.x); n.z *= sgn(T.y.z + T.z.y); }
  else { n.x *= sgn(T.x.z + T.z.x); n.y *= sgn(T.y.z + T.z.y); }
  const axis = normalize(n);
  return { axis: axis.x * w.x + axis.y * w.y + axis.z * w.z < 0 ? { x: -axis.x, y: -axis.y, z: -axis.z } : axis, angle };
}

/** A rotation about `axis` through the point `center`. */
export function rotationAbout(axis: Vec3, angle: number, center: Vec3): Rigid {
  const R = rotation(axis, angle);
  // Translate center→origin, rotate, translate back: origin = center - R·center.
  const rc = applyVec(R, center);
  return { ...R, origin: { x: center.x - rc.x, y: center.y - rc.y, z: center.z - rc.z } };
}
