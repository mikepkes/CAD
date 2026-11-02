// Motion ghosts: while a motion study runs, the viewport draws the parts it turns sweeping round, see-through (an
// onion skin: the leading pose strongest, a short wake fading behind it), so the motion can be watched while the
// live model stays as built. The sweep is drawn at display rate rather than pose by pose as the check reaches them
// (a check rebuilds the model, most of a second a pose, coarse poses first): each drive in turn goes once round its
// full circle at a steady pace, set so the tour ends about when the check does (by the check's own progress, else
// by the last run's time), while the check runs behind it and its verdict ends the study. Poses are placed the way
// a pose sweep places them (resolveComponentWorld), never rebuilt, so drawing them costs the check nothing.

import type { CadDocument } from "../core/document";
import { resolveParameters } from "../core/parameters";
import { resolveComponentWorld } from "../core/recompute";
import type { Rigid } from "../math/transform";

/** Poses drawn: the leading one and its wake. */
export const SWEEP_TRAIL = 4;
/** Degrees between one pose of the wake and the next. */
export const SWEEP_WAKE_DEG = 12;
/** A first guess at a pose's check (ms), until the study has checked one (or has a last run to go by). */
export const GUESS_POSE_MS = 700;
/** The least time (ms) the sweep gives itself to finish its tour, when the check is due to end any moment. */
const MIN_LEFT_MS = 400;
/** How far (in poses) the sweep may run ahead of the check's progress. */
const AHEAD_POSES = 1.5;

/** The overrides that pose the tour `at` (0..1) of the way round: every drive in turn through 360°, the others at 0. */
export function sweepPose(drives: string[], at: number): Record<string, string> {
  const n = drives.length, x = Math.min(Math.max(at, 0), 1) * n;
  const k = Math.min(Math.floor(x), n - 1);
  const out: Record<string, string> = {};
  drives.forEach((d, i) => { out[d] = i === k ? String(+((x - k) * 360).toFixed(3)) : "0"; });
  return out;
}

/** The tour at `at` and its wake, newest first: `trail` poses `wakeDeg` apart going back along the drive turning
 *  now (none from before its turn began). */
export function sweepTrail(drives: string[], at: number, trail = SWEEP_TRAIL, wakeDeg = SWEEP_WAKE_DEG): Record<string, string>[] {
  const n = drives.length;
  if (!n) return [];
  const x = Math.min(Math.max(at, 0), 1) * n, k = Math.min(Math.floor(x), n - 1);
  const out: Record<string, string>[] = [];
  for (let i = 0; i < trail; i++) {
    const xi = x - (i * wakeDeg) / 360;
    if (xi < k) break;
    out.push(sweepPose(drives, xi / n));
  }
  return out;
}

/** The pace of the drawn sweep: how far round its tour (0..1) it is at each frame. It moves steadily, at the rate
 *  that ends the tour when the check is expected to end: by the check's progress so far (the time to its latest
 *  pose over the share checked), before that by `guessMs` (the last run's time, or a guess per pose), stretched if
 *  the first pose is slower than that; and it keeps within a pose or two of the check. */
export class SweepPace {
  private at = 0;
  private last: number;
  private seen = 0;
  private seenAt: number;
  constructor(private readonly start: number, private readonly poses: number, private readonly guessMs = poses * GUESS_POSE_MS) {
    this.last = start; this.seenAt = start;
  }
  /** Where the tour is at `now` (ms, the clock `start` was read on), the check `progress` (0..1) of the way through. */
  advance(now: number, progress: number): number {
    if (progress > this.seen) { this.seen = progress; this.seenAt = now; }
    const elapsed = now - this.start;
    const total = this.seen > 0 ? (this.seenAt - this.start) / this.seen : Math.max(this.guessMs, elapsed * this.poses);
    const left = Math.max(total - elapsed, MIN_LEFT_MS);
    const dt = Math.max(0, now - this.last);
    this.last = now;
    // never more than a pose and a half ahead of the check: a check that stalls holds the sweep rather than letting it
    // finish a tour the check hasn't come near
    const ahead = this.seen + AHEAD_POSES / Math.max(1, this.poses);
    this.at = Math.min(1, ahead, Math.max(this.at, this.at + (dt * (1 - this.at)) / left));
    return this.at;
  }
}

/** One ghosted pose: the world placement of each component the pose moves (others are left out), and how strongly
 *  to draw it (1 for the leading pose, less for the wake). */
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

/** The build pose (where the drawn bodies are) and each pose (`poses`: parameter overrides, newest first) as the
 *  components it moves, strength by its place in a trail of `trail` (default: as many as there are poses). A pose
 *  that moves nothing is dropped. */
export function motionGhostPoses(doc: CadDocument, poses: Record<string, string>[], trail = poses.length): { build: Map<string, Rigid>; poses: MotionGhostPose[] } {
  const out: MotionGhostPose[] = [];
  poses.forEach((o, i) => {
    let world: Map<string, Rigid>;
    try {
      const scope = resolveParameters(doc.parameters.map((p) => (o[p.name] != null ? { ...p, expr: o[p.name] } : p))).scope;
      world = resolveComponentWorld(doc, scope);
    } catch { return; } // a pose that doesn't place: nothing to draw for it
    out.push({ world, strength: trailStrength(i, Math.max(trail, poses.length)) });
  });
  // placed last, so the joints are left with the build pose's own state (placing writes each joint's error)
  const build = resolveComponentWorld(doc, resolveParameters(doc.parameters).scope);
  return { build, poses: out.map((p) => ({ ...p, world: movedComponents(build, p.world) })).filter((p) => p.world.size > 0) };
}
