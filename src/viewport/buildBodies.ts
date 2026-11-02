// The store's built solids as the bodies a transform-driven view draws (the turntable recorder, the demo's pose
// sweeps, the motion study's ghosts): each with its material, wood frame and owning component.
import { hiddenIds, bodyVisible } from "../core/visibility";
import { materialForComponent, referenceOf, type CadDocument } from "../core/document";
import { materialSpec, woodFrameFromBounds } from "./material";
import type { SolidView } from "./SceneManager";

export interface SolidEvalLike {
  featureId: string; sketchId: string;
  mesh?: { positions: Float32Array; normals: Float32Array; indices: Uint32Array; edges: Float32Array; uvs?: Float32Array };
  bounds?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  threadDecals?: SolidView["threadDecals"];
}

/** Resolve the store's raw solids into renderable bodies (material + wood frame +
 *  owning component), the same way the live viewport does. */
export function buildBodies(doc: CadDocument, solidsMap: Record<string, SolidEvalLike>): { solid: SolidView; componentId: string }[] {
  const out: { solid: SolidView; componentId: string }[] = [];
  const hidden = hiddenIds(doc);
  for (const sol of Object.values(solidsMap)) {
    if (!sol.mesh || !bodyVisible(doc, sol, hidden)) continue; // a hidden body stays out of the video
    // Sketch-less bodies (primitives, …) have no sketch to name a component; they
    // live in the root component, so they'd otherwise drop out of the recording.
    const componentId = (sol.sketchId ? doc.sketches[sol.sketchId]?.componentId : undefined) ?? doc.rootComponentId;
    const mat = materialForComponent(doc, componentId);
    const material = mat ? materialSpec(mat) : undefined;
    const woodFrame = material?.kind === "wood" && sol.bounds ? woodFrameFromBounds(sol.bounds, sol.featureId) : undefined;
    out.push({ solid: { id: sol.featureId, positions: sol.mesh.positions, normals: sol.mesh.normals, indices: sol.mesh.indices, edges: sol.mesh.edges, ...(sol.mesh.uvs ? { uvs: sol.mesh.uvs } : {}), threadDecals: sol.threadDecals, material, woodFrame, ...(referenceOf(doc, componentId) === "ghost" ? { reference: true } : {}) }, componentId });
  }
  return out;
}
