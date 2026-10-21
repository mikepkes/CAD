// Evaluate solid features (currently extrude) from the document. Resolves each
// feature's parametric distance, extracts the sketch profile, and asks the OCC
// kernel for a display mesh or an STL/STEP export. Kept separate from the
// (fast, pure) sketch recompute because it drives the heavier B-rep kernel.

import { compileExpr, Scope } from "../math/expr";
import { CadDocument, ExtrudeFeature } from "./document";
import { planeById, WorkPlane } from "../geometry/plane";
import { extractProfiles } from "./geometry/profile";
import { extrudeToMesh, extrudeToBlob, isKernelReady, SolidMesh } from "./occ/kernel";

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
    if (Number.isFinite(v)) {
      f.distanceValue = v;
      return v;
    }
  } catch {
    /* keep last value */
  }
  return f.distanceValue;
}

/** Offset a plane along its normal (for symmetric extrude). */
function offsetPlane(wp: WorkPlane, d: number): WorkPlane {
  return {
    ...wp,
    origin: { x: wp.origin.x + wp.normal.x * d, y: wp.origin.y + wp.normal.y * d, z: wp.origin.z + wp.normal.z * d },
  };
}

export function evaluateFeatures(doc: CadDocument, scope: Scope): Record<string, SolidEval> {
  const out: Record<string, SolidEval> = {};
  for (const f of Object.values(doc.features)) {
    if (f.kind !== "extrude") continue;
    const distance = resolveDistance(f, scope);
    const base: SolidEval = { featureId: f.id, name: f.name, sketchId: f.sketchId, distance };
    const sketch = doc.sketches[f.sketchId];
    if (!sketch) { out[f.id] = { ...base, error: "sketch not found" }; continue; }
    if (!isKernelReady()) { out[f.id] = { ...base, error: "kernel not ready" }; continue; }
    const profile = extractProfiles(sketch);
    if (!profile) { out[f.id] = { ...base, error: "no closed profile in sketch" }; continue; }
    const d = Math.abs(distance) < 1e-9 ? 1e-6 : distance;
    const wp = f.symmetric ? offsetPlane(planeById(sketch.planeId), -d / 2) : planeById(sketch.planeId);
    try {
      const mesh = extrudeToMesh(wp, profile, d);
      out[f.id] = { ...base, mesh };
    } catch (e) {
      out[f.id] = { ...base, error: (e as Error).message };
    }
  }
  return out;
}

export function exportFeatureBlob(
  doc: CadDocument,
  scope: Scope,
  featureId: string,
  format: "stl" | "step"
): Blob | null {
  const f = doc.features[featureId];
  if (!f || f.kind !== "extrude" || !isKernelReady()) return null;
  const sketch = doc.sketches[f.sketchId];
  if (!sketch) return null;
  const profile = extractProfiles(sketch);
  if (!profile) return null;
  const distance = resolveDistance(f, scope);
  const d = Math.abs(distance) < 1e-9 ? 1e-6 : distance;
  const wp = f.symmetric ? offsetPlane(planeById(sketch.planeId), -d / 2) : planeById(sketch.planeId);
  return extrudeToBlob(wp, profile, d, format);
}
