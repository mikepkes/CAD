// Camera placement shared by the still renderer and the turntable recorder: a
// direction on the view sphere (Z up) and the distance at which a bounding sphere
// fills the frame. Pure math, so it's unit-testable without WebGL.

/** Unit vector from the target toward the camera. Azimuth is measured in the XY
 *  plane from +X toward +Y (−90° looks at the front face, from −Y); elevation is
 *  up from the XY plane, clamped short of the poles where "Z up" degenerates. */
export function orbitDirection(azimuthDeg: number, elevationDeg: number): [number, number, number] {
  const el = (Math.max(-89, Math.min(89, elevationDeg)) * Math.PI) / 180;
  const az = (azimuthDeg * Math.PI) / 180;
  return [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
}

/** Camera distance at which a sphere of `radius` fits a perspective frame with
 *  vertical field of view `fovDeg` and `aspect` (width / height), times `margin`.
 *  The narrower of the vertical and horizontal half-angles decides. */
export function fitDistance(radius: number, fovDeg: number, aspect = 1, margin = 1.15): number {
  const halfV = (fovDeg * Math.PI) / 360;
  const half = Math.min(halfV, Math.atan(Math.tan(halfV) * aspect));
  return (radius / Math.sin(half)) * margin;
}

/** The tangent of the half-angle a framed model may fill in a `width` × `height`
 *  view with vertical field of view `fovDeg`: the vertical one, narrowed to the
 *  horizontal one on a portrait screen, and to the part of the view that UI over
 *  it (`inset`, px from the right and the bottom) leaves uncovered. */
export function fitTangent(fovDeg: number, width: number, height: number, inset: { right?: number; bottom?: number } = {}): number {
  const w = Math.max(1, width), h = Math.max(1, height);
  const tv = Math.tan((fovDeg * Math.PI) / 360);
  const fv = Math.max(0.2, (h - (inset.bottom ?? 0)) / h), fh = Math.max(0.2, (w - (inset.right ?? 0)) / w);
  return Math.min(tv * fv, tv * (w / h) * fh);
}
