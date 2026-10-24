// Evaluate solid features (extrude) from the document. Resolves each feature's
// parametric distance, extracts the sketch region(s), and asks the OCC kernel
// for a display mesh. Features combine into bodies via boolean operations
// (new / join / cut), Fusion-style: a joined extrude fuses into the running
// body, a cut subtracts from it. Kept separate from the (fast, pure) sketch
// recompute because it drives the heavier B-rep kernel.

import { compileExpr, Scope } from "../math/expr";
import { CadDocument, ExtrudeFeature } from "./document";
import { offsetPlane, resolveSketchPlane } from "../geometry/plane";
import { extractRegions, regionAt, Region } from "./geometry/profile";
import {
  Edge3D, buildRegionsSolid, fuseShapes, cutShapes, meshShape, edgesOfShape, blobOfShape,
  isKernelReady, SolidMesh,
} from "./occ/kernel";
import type { Shape3D } from "replicad";

export interface SolidEval {
  featureId: string;
  name: string;
  sketchId: string;
  distance: number;
  mesh?: SolidMesh;
  error?: string;
}

function resolveDistance(f: ExtrudeFeature, scope: Scope): number {
  try {
    const v = compileExpr(f.distanceExpr).eval(scope);
    if (Number.isFinite(v)) { f.distanceValue = v; return v; }
  } catch {
    /* keep last value */
  }
  return f.distanceValue;
}

/** Regions this feature extrudes: the one under regionPoint, or all of them. */
function featureRegions(doc: CadDocument, f: ExtrudeFeature): Region[] {
  const sketch = doc.sketches[f.sketchId];
  if (!sketch) return [];
  if (f.regionPoint) {
    const hit = regionAt(sketch, f.regionPoint);
    return hit ? [hit] : [];
  }
  return extractRegions(sketch);
}

/** Build this feature's solid in isolation (regions extruded + fused). */
function buildFeatureSolid(doc: CadDocument, scope: Scope, f: ExtrudeFeature): Shape3D {
  const sketch = doc.sketches[f.sketchId];
  if (!sketch) throw new Error("sketch not found");
  const regions = featureRegions(doc, f);
  if (regions.length === 0) throw new Error("no closed region in sketch");
  const distance = resolveDistance(f, scope);
  const d = Math.abs(distance) < 1e-9 ? 1e-6 : distance;
  const wp = f.symmetric ? offsetPlane(resolveSketchPlane(sketch), -d / 2) : resolveSketchPlane(sketch);
  return buildRegionsSolid(wp, regions, d);
}

interface Body { id: string; name: string; sketchId: string; distance: number; shape: Shape3D }

export function evaluateFeatures(doc: CadDocument, scope: Scope): Record<string, SolidEval> {
  const out: Record<string, SolidEval> = {};
  const features = Object.values(doc.features).filter((f): f is ExtrudeFeature => f.kind === "extrude");
  if (!isKernelReady()) {
    for (const f of features) out[f.id] = { featureId: f.id, name: f.name, sketchId: f.sketchId, distance: resolveDistance(f, scope), error: "kernel not ready" };
    return out;
  }
  const bodies: Body[] = [];
  for (const f of features) {
    const distance = resolveDistance(f, scope);
    let shape: Shape3D;
    try {
      shape = buildFeatureSolid(doc, scope, f);
    } catch (e) {
      out[f.id] = { featureId: f.id, name: f.name, sketchId: f.sketchId, distance, error: (e as Error).message };
      continue;
    }
    const op = f.operation ?? "new";
    if (op === "new" || bodies.length === 0) {
      bodies.push({ id: f.id, name: f.name, sketchId: f.sketchId, distance, shape });
    } else {
      const target = bodies[bodies.length - 1];
      try {
        const combined = op === "cut" ? cutShapes(target.shape, shape) : fuseShapes(target.shape, shape);
        target.shape.delete();
        shape.delete();
        target.shape = combined;
      } catch (e) {
        shape.delete();
        out[f.id] = { featureId: f.id, name: f.name, sketchId: f.sketchId, distance, error: (e as Error).message };
      }
    }
  }
  for (const body of bodies) {
    try {
      out[body.id] = { featureId: body.id, name: body.name, sketchId: body.sketchId, distance: body.distance, mesh: meshShape(body.shape) };
    } catch (e) {
      out[body.id] = { featureId: body.id, name: body.name, sketchId: body.sketchId, distance: body.distance, error: (e as Error).message };
    } finally {
      body.shape.delete();
    }
  }
  return out;
}

/** B-rep edges of a feature's own solid, in world space (for projection into a sketch). */
export function featureEdges(doc: CadDocument, scope: Scope, featureId: string): Edge3D[] {
  const f = doc.features[featureId];
  if (!f || f.kind !== "extrude" || !isKernelReady()) return [];
  try {
    const solid = buildFeatureSolid(doc, scope, f);
    try { return edgesOfShape(solid); } finally { solid.delete(); }
  } catch {
    return [];
  }
}

export function exportFeatureBlob(doc: CadDocument, scope: Scope, featureId: string, format: "stl" | "step"): Blob | null {
  const f = doc.features[featureId];
  if (!f || f.kind !== "extrude" || !isKernelReady()) return null;
  try {
    const solid = buildFeatureSolid(doc, scope, f);
    try { return blobOfShape(solid, format); } finally { solid.delete(); }
  } catch {
    return null;
  }
}
