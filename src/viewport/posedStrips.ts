// Living hinges in a posed (transform-driven) view: the parts move by rigid
// transform, so a drawn hinge strip would move as a block with its lid. This
// re-bends every flexure strip for the pose and hands the scene its new mesh.
import type { CadDocument } from "../core/document";
import { IDENTITY, type Rigid } from "../math/transform";
import { flexureStripMeshes } from "../sim/hingeStrip";

/** Where a flexure joint's drawn strip is kept among the solids (features.ts). */
export const stripRowId = (jointId: string): string => `${jointId}:strip`;

/** Re-bend each drawn hinge strip for the parts' world poses. */
export function poseHingeStrips(scene: { setAnimationMesh(id: string, m: { positions: Float32Array; normals: Float32Array; indices: Uint32Array; edges: Float32Array }): void }, doc: CadDocument, worlds: Map<string, Rigid>): void {
  for (const s of flexureStripMeshes(doc, worlds, IDENTITY)) scene.setAnimationMesh(stripRowId(s.joint.id), s.mesh);
}
