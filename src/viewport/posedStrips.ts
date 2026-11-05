// Living hinges in a posed (transform-driven) view: the parts move by rigid
// transform, so a drawn hinge strip would move as a block with its lid. This
// re-bends every flexure strip for the pose and hands the scene its new mesh.
import type { CadDocument } from "../core/document";
import { resolveParameters } from "../core/parameters";
import { IDENTITY, type Rigid } from "../math/transform";
import { flexureStripMeshes, polylineStripMesh } from "../sim/hingeStrip";
import { drawnBeamShapes } from "../sim/flexure";

/** Where a flexure joint's drawn strip is kept among the solids (features.ts). */
export const stripRowId = (jointId: string): string => `${jointId}:strip`;
/** Where a drawn beam is kept among the solids (features.ts). */
export const beamRowId = (jointId: string): string => `${jointId}:beam`;

/** Re-bend each drawn hinge strip, and re-solve each drawn beam, for the parts' world poses
 *  (`scope`: the parameters the pose was placed with; default the document's). */
export function poseHingeStrips(scene: { setAnimationMesh(id: string, m: { positions: Float32Array; normals: Float32Array; indices: Uint32Array; edges: Float32Array }): void }, doc: CadDocument, worlds: Map<string, Rigid>, scope?: Record<string, number>): void {
  for (const s of flexureStripMeshes(doc, worlds, IDENTITY)) scene.setAnimationMesh(stripRowId(s.joint.id), s.mesh);
  if (!Object.values(doc.joints).some((j) => j.kind === "beam" && j.beam?.draw)) return;
  for (const b of drawnBeamShapes(doc, scope ?? resolveParameters(doc.parameters).scope, worlds)) {
    scene.setAnimationMesh(beamRowId(b.joint.id), polylineStripMesh(b.points, b.across, b.joint.beam!.width, b.joint.beam!.thickness));
  }
}
