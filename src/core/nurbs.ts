// An exact NURBS boundary representation as plain data: the format an imported
// Rhino Brep is stored in (feature.import format "nurbs"), so the document
// stays self-contained and the kernel can rebuild the solid in the geometry
// worker without rhino3dm. Knot vectors are OCC-style "flat" vectors
// (count + degree + 1 knots); poles are Euclidean, with separate weights.

export interface NurbsCurveData {
  degree: number;
  /** Flat knot vector: poles + degree + 1 values. */
  knots: number[];
  /** Euclidean control points, flat xyz. */
  poles: number[];
  /** One weight per pole (omitted when non-rational). */
  weights?: number[];
}

export interface NurbsSurfaceData {
  degreeU: number;
  degreeV: number;
  countU: number;
  countV: number;
  knotsU: number[];
  knotsV: number[];
  /** Euclidean control points, flat xyz, u-major: pole (i, j) at 3·(i·countV + j). */
  poles: number[];
  weights?: number[];
}

export interface NurbsFaceData {
  surface: NurbsSurfaceData;
  /** The face's normal points opposite the surface's. */
  reversed: boolean;
  /** Boundary loops (the outer first): each a run of edges in order, an edge reversed where the loop runs against it. */
  loops: { outer: boolean; trims: { curve: number; reversed: boolean }[] }[];
}

export interface NurbsBrepData {
  /** Model tolerance in mm (sewing gap). */
  tolerance: number;
  /** The source says it's a closed solid. */
  solid: boolean;
  /** Edge curves, referenced by index from the face loops. */
  curves: NurbsCurveData[];
  faces: NurbsFaceData[];
}

/**
 * A Rhino-style knot vector (count + order − 2 values: no "superfluous" end
 * knots) as an OCC flat vector, by repeating each end knot once more.
 */
export function flatKnots(rhinoKnots: number[]): number[] {
  if (!rhinoKnots.length) return [];
  return [rhinoKnots[0], ...rhinoKnots, rhinoKnots[rhinoKnots.length - 1]];
}

/** A flat knot vector as distinct knots and their multiplicities. */
export function knotMults(flat: number[], tol = 1e-12): { knots: number[]; mults: number[] } {
  const knots: number[] = [], mults: number[] = [];
  for (const k of flat) {
    if (knots.length && Math.abs(k - knots[knots.length - 1]) <= tol * Math.max(1, Math.abs(k))) mults[mults.length - 1]++;
    else { knots.push(k); mults.push(1); }
  }
  return { knots, mults };
}

/** Homogeneous control points (x·w, y·w, z·w, w), as rhino3dm reports them, to Euclidean poles + weights, scaled to mm. */
export function dehomogenize(points: number[][], mm: number): { poles: number[]; weights?: number[] } {
  const poles: number[] = [], weights: number[] = [];
  let rational = false;
  for (const [x, y, z, w = 1] of points) {
    const ww = w || 1;
    poles.push((x / ww) * mm, (y / ww) * mm, (z / ww) * mm);
    weights.push(ww);
    if (Math.abs(ww - 1) > 1e-12) rational = true;
  }
  return rational ? { poles, weights } : { poles };
}
