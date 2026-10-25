// Render a motion study to a video file with WebCodecs. We replay the same
// sweep the study checks — each driven joint through a full 360° turn, the
// others held at zero — posing the assembly rigidly (no kernel rebuild, see
// motionPose.ts), render each pose offscreen from the user's fixed framing, and
// hand the frames to the shared encoder. The camera is held still so the
// mechanism spins in place.

import { CadDocument } from "../core/document";
import { SolidEval } from "../core/features";
import { makeMotionPoser } from "../model/motionPose";
import { getActiveScene } from "./sceneRef";
import { canEncodeVideo, encodeToWebM, evenDim } from "./encodeVideo";
import type { SolidView } from "./SceneManager";

export interface RecordOptions {
  fps?: number;
  secondsPerSweep?: number; // seconds for one joint's 360° turn
  width?: number;
  height?: number;
  /** Override the view direction (from the subject toward the camera) and up
   *  vector; defaults to the viewport's current framing. */
  dir?: { x: number; y: number; z: number };
  up?: { x: number; y: number; z: number };
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface MotionVideo { blob: Blob; extension: "webm"; }

/** True only where the browser can actually encode video for us. */
export function canRecordMotion(): boolean {
  return canEncodeVideo();
}

export async function recordMotionStudy(doc: CadDocument, solids: SolidEval[], opts: RecordOptions = {}): Promise<MotionVideo> {
  const scene = getActiveScene();
  if (!scene) throw new Error("No viewport to record.");

  const poser = makeMotionPoser(doc, solids);
  if (!poser.drivers.length) throw new Error("This model has no motion to record.");

  const fps = opts.fps ?? 30;
  const perSweep = Math.max(2, Math.round(fps * (opts.secondsPerSweep ?? 3)));
  const width = evenDim(opts.width ?? 960);
  const height = evenDim(opts.height ?? 720);

  // The sweep timeline. A driver whose parameter has min/max bounds (a hinge,
  // actuator, scissor lift…) sweeps its range and back (so it opens and closes);
  // an unbounded one does a full 360° turn (a wheel, the gyro rings). Other
  // drivers are held at their home value.
  const param = (name: string) => doc.parameters.find((p) => p.name === name);
  const home: Record<string, number> = {};
  for (const d of poser.drivers) home[d] = param(d)?.value ?? 0;

  const timeline: Record<string, number>[] = [];
  for (const d of poser.drivers) {
    const p = param(d);
    const push = (v: number) => { const o = { ...home }; o[d] = v; timeline.push(o); };
    if (p && p.min != null && p.max != null) {
      const lo = p.min, hi = p.max;
      for (let k = 0; k < perSweep; k++) push(lo + ((hi - lo) * k) / perSweep); // open
      for (let k = 0; k < perSweep; k++) push(hi - ((hi - lo) * k) / perSweep); // close
    } else {
      for (let k = 0; k < perSweep; k++) push((360 * k) / perSweep); // full turn
    }
  }

  // Fixed framing: fit a sphere over a coarse sample of poses so nothing leaves
  // the frame as the parts swing, using the user's current view direction.
  const view = opts.dir ? { dir: opts.dir, up: opts.up ?? { x: 0, y: 0, z: 1 } } : scene.viewFraming();
  const framing = { ...computeBounds(poser, timeline), ...view };
  const scratch = document.createElement("canvas");

  const blob = await encodeToWebM({
    width, height, fps, frameCount: timeline.length,
    onProgress: opts.onProgress, signal: opts.signal,
    draw: (i) => {
      const posed = poser.pose(timeline[i]) as unknown as SolidView[];
      return scene.renderSolidsImage(posed, framing, width, height, scratch);
    },
  });
  return { blob, extension: "webm" };
}

/** A sphere (center + radius) covering a coarse sample of the sweep's poses. */
function computeBounds(poser: ReturnType<typeof makeMotionPoser>, timeline: Record<string, number>[]) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const step = Math.max(1, Math.floor(timeline.length / 24));
  for (let i = 0; i < timeline.length; i += step) {
    for (const body of poser.pose(timeline[i])) {
      const p = body.positions;
      for (let j = 0; j < p.length; j += 3) {
        for (let a = 0; a < 3; a++) { const v = p[j + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
      }
    }
  }
  if (!Number.isFinite(lo[0])) return { center: { x: 0, y: 0, z: 0 }, radius: 50 };
  const center = { x: (lo[0] + hi[0]) / 2, y: (lo[1] + hi[1]) / 2, z: (lo[2] + hi[2]) / 2 };
  const radius = 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 50;
  return { center, radius };
}
