// In-browser turntable / mechanism video recorder. Instead of rebuilding geometry
// per frame (an OCC recompute each time a parameter nudges), it builds the bodies
// ONCE, then drives a continual WebGL context: every frame it re-resolves the
// component world transforms (cheap — joints only) and MOVES each component by a
// matrix, then captures the canvas with WebCodecs and muxes an mp4. So a 10s/60fps
// turntable with a working vise costs one build + N cheap transform+render passes.
import * as THREE from "three";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { resolveComponentWorld } from "../core/recompute";
import { resolveParameters } from "../core/parameters";
import { hiddenIds, bodyVisible } from "../core/visibility";
import { materialForComponent, type CadDocument } from "../core/document";
import { woodFrameFromBounds } from "./material";
import { fitDistance, orbitDirection } from "./orbitCamera";
import type { SceneManager, SolidView } from "./SceneManager";

interface SolidEvalLike {
  featureId: string; sketchId: string;
  mesh?: { positions: Float32Array; normals: Float32Array; indices: Uint32Array; edges: Float32Array };
  bounds?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  threadDecals?: SolidView["threadDecals"];
}

export interface TurntableOpts {
  width?: number; height?: number; fps?: number; seconds?: number;
  /** Orbit centre; default the bodies' bounding-box centre. */
  center?: [number, number, number];
  /** Camera distance from the centre; default frames the bodies' bounding sphere. */
  radius?: number;
  elevationDeg?: number;
  startAzDeg?: number; revolutions?: number;
  /** Vertical field of view while recording (default the live camera's). */
  fovDeg?: number;
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
  const hidden = hiddenIds(doc);
  for (const sol of Object.values(solidsMap)) {
    if (!sol.mesh || !bodyVisible(doc, sol, hidden)) continue; // a hidden body stays out of the video
    // Sketch-less bodies (primitives, …) have no sketch to name a component; they
    // live in the root component, so they'd otherwise drop out of the recording.
    const componentId = (sol.sketchId ? doc.sketches[sol.sketchId]?.componentId : undefined) ?? doc.rootComponentId;
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

export interface TurntableResult {
  bytes: Uint8Array;
  /** The WebCodecs codec string actually used (H.264 unless the platform can't encode it). */
  codec: string;
  width: number; height: number; fps: number; frames: number;
}

// Preferred first: H.264 plays everywhere (QuickTime included); VP9 is the fallback.
const CODECS: { codec: string; mux: "avc" | "vp9" }[] = [
  { codec: "avc1.640033", mux: "avc" }, // High profile, level 5.1 (1080p60 headroom)
  { codec: "avc1.4d0033", mux: "avc" }, // Main profile
  { codec: "vp09.00.10.08", mux: "vp9" },
];

async function pickCodec(width: number, height: number, fps: number, bitrate: number): Promise<{ mux: "avc" | "vp9"; config: VideoEncoderConfig }> {
  if (typeof VideoEncoder === "undefined") throw new Error("video export needs WebCodecs (VideoEncoder), which this browser lacks");
  for (const c of CODECS) {
    const config: VideoEncoderConfig = { codec: c.codec, width, height, bitrate, framerate: fps, ...(c.mux === "avc" ? { avc: { format: "avc" as const } } : {}) };
    try { if ((await VideoEncoder.isConfigSupported(config)).supported) return { mux: c.mux, config }; } catch { /* try the next codec */ }
  }
  throw new Error(`this browser can't encode ${width}×${height} H.264 or VP9 video`);
}

/** Bounding box of every meshed body (build pose), or null when nothing is built. */
function bodyBounds(solidsMap: Record<string, SolidEvalLike>): THREE.Box3 | null {
  const box = new THREE.Box3(), v = new THREE.Vector3();
  for (const sol of Object.values(solidsMap)) {
    const p = sol.mesh?.positions;
    if (!p) continue;
    for (let i = 0; i < p.length; i += 3) box.expandByPoint(v.set(p[i], p[i + 1], p[i + 2]));
  }
  return box.isEmpty() ? null : box;
}

export async function recordTurntable(scene: SceneManager, doc: CadDocument, solidsMap: Record<string, SolidEvalLike>, opts: TurntableOpts = {}): Promise<TurntableResult> {
  // H.264 needs even dimensions.
  const W = Math.round((opts.width ?? 960) / 2) * 2, H = Math.round((opts.height ?? 600) / 2) * 2;
  const fps = opts.fps ?? 60, secs = opts.seconds ?? 10;
  const N = Math.max(2, Math.round(fps * secs));
  const box = bodyBounds(solidsMap);
  if (!box) throw new Error("nothing to record — build a solid first");
  const center = opts.center ? new THREE.Vector3(...opts.center) : box.getCenter(new THREE.Vector3());
  const elevation = opts.elevationDeg ?? 20, az0 = opts.startAzDeg ?? 19, rev = opts.revolutions ?? 1;
  const { mux, config } = await pickCodec(W, H, fps, opts.bitrate ?? 10e6);

  const bodies = buildBodies(doc, solidsMap);
  const base = resolveParameters(doc.parameters).scope;
  const buildWorld = resolveComponentWorld(doc, base);

  const restoreView = scene.captureSession();
  scene.configureRecording(W, H);
  const cam = scene.camera as THREE.PerspectiveCamera;
  if (opts.fovDeg) { cam.fov = opts.fovDeg; cam.updateProjectionMatrix(); }
  const R = opts.radius ?? fitDistance(box.getBoundingSphere(new THREE.Sphere()).radius, cam.fov, W / H);
  scene.beginAnimation(bodies, buildWorld);

  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: mux, width: W, height: H, frameRate: fps }, fastStart: "in-memory" });
  let encodeError: unknown = null;
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encodeError = e; } });
  encoder.configure(config);

  try {
    const scope: Record<string, number> = { ...base };
    for (let f = 0; f < N; f++) {
      // f / N (not N - 1): the last frame stops one step short of the first, so a
      // full revolution loops without a repeated frame.
      const u = f / N, t = u * secs;
      let worlds = buildWorld;
      if (opts.param && opts.openClose) {
        scope[opts.param] = paramAt(t, opts.openClose);
        worlds = resolveComponentWorld(doc, scope);
      }
      scene.setAnimationPose(worlds);
      const [dx, dy, dz] = orbitDirection(az0 + 360 * rev * u, elevation);
      cam.position.set(center.x + R * dx, center.y + R * dy, center.z + R * dz);
      cam.up.set(0, 0, 1); cam.lookAt(center); cam.updateMatrixWorld();
      scene.renderFrame();

      const frame = new VideoFrame(scene.recordCanvas, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: f % fps === 0 });
      frame.close();
      if (encodeError) throw encodeError;

      if (f % 8 === 0) { opts.onProgress?.(u); await new Promise((r) => setTimeout(r, 0)); }
      // keep the encoder queue bounded so memory stays flat on long clips
      while (encoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 4));
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
    return { bytes: new Uint8Array((muxer.target as ArrayBufferTarget).buffer), codec: String(config.codec), width: W, height: H, fps, frames: N };
  } finally {
    if (encoder.state !== "closed") encoder.close();
    scene.endAnimation();
    restoreView();
  }
}
