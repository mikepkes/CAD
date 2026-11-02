// Motion ghosts: while a motion study runs, the viewport draws the parts it moves at the poses it is checking,
// see-through (an onion skin: the pose being checked strongest, the ones before it fading), so the sweep can be
// watched while the live model stays as built. Poses come from the study (its parameter overrides) and are placed
// the way a pose sweep places them (resolveComponentWorld), never rebuilt, so drawing them costs the study nothing.

import type { CadDocument } from "../core/document";
import { resolveParameters } from "../core/parameters";
import { resolveComponentWorld } from "../core/recompute";
import type { Rigid } from "../math/transform";

/** One ghosted pose: the world placement of each component the pose moves (others are left out), and how strongly
 *  to draw it (1 for the pose being checked, less for older ones). */
export interface MotionGhostPose {
  world: Map<string, Rigid>;
  strength: number;
}

/** How strongly the `i`th newest of `n` poses is drawn: the newest 1, fading evenly to a faint last one. */
export function trailStrength(i: number, n: number): number {
  return n <= 1 ? 1 : 1 - (0.75 * i) / (n - 1);
}

const near = (a: Rigid, b: Rigid, tol: number) =>
  (["origin", "x", "y", "z"] as const).every((k) => Math.abs(a[k].x - b[k].x) <= tol && Math.abs(a[k].y - b[k].y) <= tol && Math.abs(a[k].z - b[k].z) <= tol);

/** The components a pose puts somewhere other than where they were built. */
export function movedComponents(build: Map<string, Rigid>, posed: Map<string, Rigid>, tol = 1e-6): Map<string, Rigid> {
  const out = new Map<string, Rigid>();
  for (const [cid, W] of posed) {
    const B = build.get(cid);
    if (!B || !near(B, W, tol)) out.set(cid, W);
  }
  return out;
}

/** The build pose (where the drawn bodies are) and each study pose (`poses`, newest first) as the components it
 *  moves. A pose that moves nothing is dropped. */
export function motionGhostPoses(doc: CadDocument, poses: Record<string, string>[]): { build: Map<string, Rigid>; poses: MotionGhostPose[] } {
  const out: MotionGhostPose[] = [];
  poses.forEach((o, i) => {
    let world: Map<string, Rigid>;
    try {
      const scope = resolveParameters(doc.parameters.map((p) => (o[p.name] != null ? { ...p, expr: o[p.name] } : p))).scope;
      world = resolveComponentWorld(doc, scope);
    } catch { return; } // a pose that doesn't place: nothing to draw for it
    out.push({ world, strength: trailStrength(i, poses.length) });
  });
  // placed last, so the joints are left with the build pose's own state (placing writes each joint's error)
  const build = resolveComponentWorld(doc, resolveParameters(doc.parameters).scope);
  return { build, poses: out.map((p) => ({ ...p, world: movedComponents(build, p.world) })).filter((p) => p.world.size > 0) };
}
