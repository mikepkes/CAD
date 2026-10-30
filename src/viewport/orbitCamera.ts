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
