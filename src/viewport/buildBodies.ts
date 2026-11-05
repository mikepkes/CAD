// The store's built solids as the bodies a transform-driven view draws (the turntable recorder, the demo's pose
// sweeps, the motion study's ghosts): each with its material, wood frame and owning component.
import type { PaperOverlay } from "../core/sheetSequence";
import { hiddenIds, bodyVisible } from "../core/visibility";
import { materialForComponent, referenceOf, type CadDocument } from "../core/document";
import { materialSpec, woodFrameFromBounds } from "./material";
import type { SolidView } from "./SceneManager";

export interface SolidEvalLike {
  featureId: string; sketchId: string;
  mesh?: { positions: Float32Array; normals: Float32Array; indices: Uint32Array; edges: Float32Array; uvs?: Float32Array; paper?: PaperOverlay };
  bounds?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  threadDecals?: SolidView["threadDecals"];
  componentId?: string;
  /** A drawn element (a hinge strip, a beam from its solve): its mesh is already in the world and is re-made per
   *  pose, so a posed view must not carry it with a component. */
  drawn?: string;
}

/** The animation group a drawn element sits in: one no component's pose moves. */
export const DRAWN_GROUP = "drawn";

/** Resolve the store's raw solids into renderable bodies (material + wood frame +
 *  owning component), the same way the live viewport does. */
export function buildBodies(doc: CadDocument, solidsMap: Record<string, SolidEvalLike>): { solid: SolidView; componentId: string }[] {
  const out: { solid: SolidView; componentId: string }[] = [];
  const hidden = hiddenIds(doc);
  for (const sol of Object.values(solidsMap)) {
    if (!sol.mesh || !bodyVisible(doc, sol, hidden)) continue; // a hidden body stays out of the video
    // Sketch-less bodies (primitives, …) have no sketch to name a component; they
    // live in the root component, so they'd otherwise drop out of the recording.
    const owner = sol.componentId ?? (sol.sketchId ? doc.sketches[sol.sketchId]?.componentId : undefined) ?? doc.rootComponentId;
    // a drawn element is re-made in world space for every pose (poseHingeStrips): it must not also be moved
    const componentId = sol.drawn ? DRAWN_GROUP : owner;
    const mat = materialForComponent(doc, owner);
    const material = mat ? materialSpec(mat) : undefined;
    const woodFrame = material?.kind === "wood" && sol.bounds ? woodFrameFromBounds(sol.bounds, sol.featureId) : undefined;
    out.push({ solid: { id: sol.featureId, positions: sol.mesh.positions, normals: sol.mesh.normals, indices: sol.mesh.indices, edges: sol.mesh.edges, ...(sol.mesh.uvs ? { uvs: sol.mesh.uvs } : {}), ...(sol.mesh.paper ? { paper: sol.mesh.paper } : {}), threadDecals: sol.threadDecals, material, woodFrame, ...(referenceOf(doc, owner) === "ghost" ? { reference: true } : {}) }, componentId });
  }
  return out;
}
