// Minimal 2D / 3D vector helpers used across the geometry & sketch layers.

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v2 = (x = 0, y = 0): Vec2 => ({ x, y });
export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const add2 = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub2 = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale2 = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot2 = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross2 = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len2 = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist2 = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export const norm2 = (a: Vec2): Vec2 => {
  const l = len2(a);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};

/** Perpendicular (rotate +90°). */
export const perp2 = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });

export const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

/** Signed angle of a vector, in radians. */
export const angle2 = (a: Vec2): number => Math.atan2(a.y, a.x);

export const clamp = (x: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, x));

export const TWO_PI = Math.PI * 2;

/** Normalize an angle into [0, 2π). */
export const normAngle = (a: number): number => {
  let r = a % TWO_PI;
  if (r < 0) r += TWO_PI;
  return r;
};
