// Render a turntable of the current model: the object is held still while the
// camera orbits it a full 360° at a fixed elevation. Reuses the offscreen posed
// renderer (the meshes are static here, only the framing's view direction turns)
// and the shared WebCodecs encoder.

import { SolidEval } from "../core/features";
import { getActiveScene } from "./sceneRef";
import { canEncodeVideo, encodeToWebM, evenDim } from "./encodeVideo";
import type { SolidView } from "./SceneManager";

export interface TurntableOptions {
  fps?: number;
  seconds?: number;       // duration of one full revolution
  elevation?: number;     // camera elevation above the horizon, degrees
  width?: number;
  height?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export function canRecordTurntable(): boolean {
  return canEncodeVideo();
}

export async function recordTurntable(solids: SolidEval[], opts: TurntableOptions = {}): Promise<{ blob: Blob; extension: "webm" }> {
  const scene = getActiveScene();
  if (!scene) throw new Error("No viewport to record.");
  const views = solids.filter((s) => s.mesh).map((s) => ({
    positions: s.mesh!.positions, normals: s.mesh!.normals, indices: s.mesh!.indices, edges: s.mesh!.edges,
  })) as SolidView[];
  if (!views.length) throw new Error("Nothing to turntable — no bodies.");

  const fps = opts.fps ?? 30;
  const frames = Math.max(2, Math.round(fps * (opts.seconds ?? 4)));
  const width = evenDim(opts.width ?? 960);
  const height = evenDim(opts.height ?? 720);
  const el = ((opts.elevation ?? 22) * Math.PI) / 180;
  const cosEl = Math.cos(el), sinEl = Math.sin(el);

  const { center, radius } = boundsOf(views);
  const scratch = document.createElement("canvas");

  const blob = await encodeToWebM({
    width, height, fps, frameCount: frames,
    onProgress: opts.onProgress, signal: opts.signal,
    draw: (i) => {
      const az = (2 * Math.PI * i) / frames;
      const dir = { x: Math.cos(az) * cosEl, y: Math.sin(az) * cosEl, z: sinEl };
      return scene.renderSolidsImage(views, { center, radius, dir, up: { x: 0, y: 0, z: 1 } }, width, height, scratch);
    },
  });
  return { blob, extension: "webm" };
}

function boundsOf(views: SolidView[]) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const v of views) {
    const p = v.positions;
    for (let j = 0; j < p.length; j += 3) {
      for (let a = 0; a < 3; a++) { const x = p[j + a]; if (x < lo[a]) lo[a] = x; if (x > hi[a]) hi[a] = x; }
    }
  }
  if (!Number.isFinite(lo[0])) return { center: { x: 0, y: 0, z: 0 }, radius: 50 };
  const center = { x: (lo[0] + hi[0]) / 2, y: (lo[1] + hi[1]) / 2, z: (lo[2] + hi[2]) / 2 };
  const radius = 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 50;
  return { center, radius };
}
