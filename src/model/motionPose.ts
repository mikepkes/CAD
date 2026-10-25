// Pose an assembly for a motion study without rebuilding geometry. A revolute /
// slider joint moves its component rigidly, and in this architecture the joint
// motion is already realised as a rigid component-world transform (see
// recompute.ts). So instead of re-running the OCC kernel at every sampled angle
// (~seconds per frame), we build each body's mesh once at the home pose and, for
// each frame, apply the rigid delta  poseWorld ∘ homeWorld⁻¹  to its baked
// vertices — a handful of float ops per vertex, fast enough for 30–60 fps video.

import { CadDocument } from "../core/document";
import { SolidEval } from "../core/features";
import { SolidMesh } from "../core/occ/kernel";
import { resolveParameters } from "./parameters";
import { resolveComponentWorld } from "../core/recompute";
import { driveParams } from "./motionStudy";
import { Rigid, IDENTITY, invert, compose, applyPoint, applyVec } from "../math/transform";

export interface PosedMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  edges: Float32Array;
}

export interface MotionPoser {
  /** The driven joint parameters (e.g. `spin2`, `spin3`) this model animates. */
  readonly drivers: string[];
  /** Pose every body for the given driven-parameter values (degrees). */
  pose(overrides: Record<string, number>): PosedMesh[];
}

/** Build a poser over the current solids. Captures the home component frames
 *  once; `pose()` is then cheap and can be called per video frame. */
export function makeMotionPoser(doc: CadDocument, solids: SolidEval[]): MotionPoser {
  const bodies = solids
    .filter((s) => s.mesh)
    .map((s) => ({ mesh: s.mesh!, componentId: doc.sketches[s.sketchId]?.componentId }));

  const homeScope = resolveParameters(doc.parameters).scope;
  const homeWorld = resolveComponentWorld(doc, homeScope);
  const homeInv = new Map<string, Rigid>();
  for (const [id, W] of homeWorld) homeInv.set(id, invert(W));

  return {
    drivers: driveParams(doc),
    pose(overrides) {
      const scope: Record<string, number> = { ...homeScope, ...overrides };
      const world = resolveComponentWorld(doc, scope);
      return bodies.map((b) => {
        const c = b.componentId;
        const W = c ? world.get(c) : undefined;
        const Hi = c ? homeInv.get(c) : undefined;
        const delta = W && Hi ? compose(W, Hi) : IDENTITY;
        return transformMesh(b.mesh, delta);
      });
    },
  };
}

/** Apply a rigid transform to a baked mesh (points for positions/edges, pure
 *  rotation for normals). Returns fresh arrays, leaving the source untouched. */
function transformMesh(m: SolidMesh, d: Rigid): PosedMesh {
  return {
    positions: mapPoints(m.positions, d),
    normals: mapVecs(m.normals, d),
    indices: m.indices,
    edges: mapPoints(m.edges, d),
  };
}

function mapPoints(src: Float32Array, d: Rigid): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const p = applyPoint(d, { x: src[i], y: src[i + 1], z: src[i + 2] });
    out[i] = p.x; out[i + 1] = p.y; out[i + 2] = p.z;
  }
  return out;
}

function mapVecs(src: Float32Array, d: Rigid): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const v = applyVec(d, { x: src[i], y: src[i + 1], z: src[i + 2] });
    out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z;
  }
  return out;
}
