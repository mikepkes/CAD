// In-browser turntable / mechanism video recorder. Instead of rebuilding geometry
// per frame (an OCC recompute each time a parameter nudges), it builds the bodies
// ONCE, then drives a continual WebGL context: every frame it re-resolves the
// component world transforms (cheap — joints only) and MOVES each component by a
// matrix, then captures the canvas with WebCodecs and muxes an mp4. So a 10s/60fps
// turntable with a working vise costs one build + N cheap transform+render passes.
import * as THREE from "three";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { resolveComponentWorld } from "../core/recompute";
import { resolveParameters } from "../model/parameters";
import { materialForComponent, type CadDocument } from "../core/document";
import { woodFrameFromBounds } from "./material";
import type { SceneManager, SolidView } from "./SceneManager";

interface SolidEvalLike {
  featureId: string; sketchId: string;
  mesh?: { positions: Float32Array; normals: Float32Array; indices: Uint32Array; edges: Float32Array };
  bounds?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  threadDecals?: SolidView["threadDecals"];
}

export interface TurntableOpts {
  width?: number; height?: number; fps?: number; seconds?: number;
  center?: [number, number, number]; radius?: number; elevationDeg?: number;
  startAzDeg?: number; revolutions?: number;
  bitrate?: number;
  /** Drive a parameter (e.g. "viseGap") open→close within a time window. */
  param?: string;
  openClose?: { start: number; end: number; from: number; to: number };
  onProgress?: (p: number) => void;
}

/** Resolve the store's raw solids into renderable bodies (material + wood frame +
 *  owning component), the same way the live viewport does. */
function buildBodies(doc: CadDocument, solidsMap: Record<string, SolidEvalLike>): { solid: SolidView; componentId: string }[] {
  const out: { solid: SolidView; componentId: string }[] = [];
  for (const sol of Object.values(solidsMap)) {
    if (!sol.mesh) continue;
    const componentId = sol.sketchId ? doc.sketches[sol.sketchId]?.componentId : undefined;
    if (!componentId) continue;
    const mat = materialForComponent(doc, componentId);
    const material = mat ? { kind: mat.kind, species: mat.species, finish: mat.finish, color: mat.color, roughness: mat.roughness, metalness: mat.metalness, ringScale: mat.ringScale, grainContrast: mat.grainContrast, poreStrength: mat.poreStrength } : undefined;
    const woodFrame = material?.kind === "wood" && sol.bounds ? woodFrameFromBounds(sol.bounds, sol.featureId) : undefined;
    out.push({ solid: { id: sol.featureId, positions: sol.mesh.positions, normals: sol.mesh.normals, indices: sol.mesh.indices, edges: sol.mesh.edges, threadDecals: sol.threadDecals, material, woodFrame }, componentId });
  }
  return out;
}

/** Triangle-wave open→close value over a window; `from` outside the window. */
function paramAt(t: number, oc: NonNullable<TurntableOpts["openClose"]>): number {
  if (t < oc.start || t > oc.end) return oc.from;
  const mid = (oc.start + oc.end) / 2;
  return t <= mid
    ? oc.from + (oc.to - oc.from) * (t - oc.start) / (mid - oc.start)
    : oc.to + (oc.from - oc.to) * (t - mid) / (oc.end - mid);
}

export async function recordTurntable(scene: SceneManager, doc: CadDocument, solidsMap: Record<string, SolidEvalLike>, opts: TurntableOpts = {}): Promise<Uint8Array> {
  const W = opts.width ?? 960, H = opts.height ?? 600, fps = opts.fps ?? 60, secs = opts.seconds ?? 10;
  const N = Math.max(2, Math.round(fps * secs));
  const center = new THREE.Vector3(...(opts.center ?? [0, -50, -15]));
  const R = opts.radius ?? 2050, E = (opts.elevationDeg ?? 20) * Math.PI / 180;
  const az0 = (opts.startAzDeg ?? 19) * Math.PI / 180, rev = opts.revolutions ?? 1;

  const bodies = buildBodies(doc, solidsMap);
  const base = resolveParameters(doc.parameters).scope;
  const buildWorld = resolveComponentWorld(doc, base);

  scene.configureRecording(W, H);
  scene.beginAnimation(bodies, buildWorld);
  const cam = scene.camera as THREE.PerspectiveCamera;

  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: "vp9", width: W, height: H, frameRate: fps }, fastStart: "in-memory" });
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { throw e; } });
  encoder.configure({ codec: "vp09.00.10.08", width: W, height: H, bitrate: opts.bitrate ?? 10e6, framerate: fps });

  try {
    const scope: Record<string, number> = { ...base };
    for (let f = 0; f < N; f++) {
      const u = f / (N - 1), t = u * secs;
      let worlds = buildWorld;
      if (opts.param && opts.openClose) {
        scope[opts.param] = paramAt(t, opts.openClose);
        worlds = resolveComponentWorld(doc, scope);
      }
      scene.setAnimationPose(worlds);
      const a = az0 + 2 * Math.PI * rev * u;
      cam.position.set(center.x + R * Math.cos(E) * Math.cos(a), center.y + R * Math.cos(E) * Math.sin(a), center.z + R * Math.sin(E));
      cam.up.set(0, 0, 1); cam.lookAt(center); cam.updateMatrixWorld();
      scene.renderFrame();

      const frame = new VideoFrame(scene.recordCanvas, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: f % fps === 0 });
      frame.close();

      if (f % 8 === 0) { opts.onProgress?.(u); await new Promise((r) => setTimeout(r, 0)); }
      // keep the encoder queue bounded so memory stays flat on long clips
      while (encoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 4));
    }
    await encoder.flush();
    muxer.finalize();
    return new Uint8Array((muxer.target as ArrayBufferTarget).buffer);
  } finally {
    encoder.close();
    scene.endAnimation();
  }
}
