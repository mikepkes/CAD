// Render a motion study to a video file with WebCodecs. We replay the same
// sweep the study checks — each driven joint through a full 360° turn, the
// others held at zero — posing the assembly rigidly (no kernel rebuild, see
// motionPose.ts), render each pose offscreen from the user's fixed framing,
// encode the frame with a VideoEncoder and mux the stream into WebM. The camera
// is held still so the mechanism spins in place.

import { CadDocument } from "../core/document";
import { SolidEval } from "../core/features";
import { makeMotionPoser } from "../model/motionPose";
import { framesToWebM, WebMFrame } from "../core/export/webm";
import { getActiveScene } from "./sceneRef";
import type { SolidView } from "./SceneManager";

export interface RecordOptions {
  fps?: number;
  secondsPerSweep?: number;        // seconds for one joint's 360° turn
  width?: number;
  height?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface MotionVideo {
  blob: Blob;
  extension: "webm";
}

/** True only where the browser can actually encode video for us. */
export function canRecordMotion(): boolean {
  return typeof window !== "undefined" && "VideoEncoder" in window && "VideoFrame" in window;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2); // encoders want even dims

export async function recordMotionStudy(doc: CadDocument, solids: SolidEval[], opts: RecordOptions = {}): Promise<MotionVideo> {
  if (!canRecordMotion()) throw new Error("This browser can't record video (no WebCodecs).");
  const scene = getActiveScene();
  if (!scene) throw new Error("No viewport to record.");

  const poser = makeMotionPoser(doc, solids);
  if (!poser.drivers.length) throw new Error("This model has no motion to record.");

  const fps = opts.fps ?? 30;
  const perSweep = Math.max(2, Math.round(fps * (opts.secondsPerSweep ?? 3)));
  const width = even(opts.width ?? 960);
  const height = even(opts.height ?? 720);
  const frameDurUs = Math.round(1e6 / fps);

  // The sweep timeline: each driver 0→360°, the others pinned at 0.
  const timeline: Record<string, number>[] = [];
  for (const d of poser.drivers) {
    for (let k = 0; k < perSweep; k++) {
      const o: Record<string, number> = {};
      for (const other of poser.drivers) o[other] = 0;
      o[d] = (360 * k) / perSweep;
      timeline.push(o);
    }
  }

  // Fixed framing: fit a sphere over a coarse sample of poses so nothing leaves
  // the frame as the parts swing, using the user's current view direction.
  const framing = { ...computeBounds(poser, timeline), ...scene.viewFraming() };

  const config = await pickCodec(width, height, fps);
  const chunks: WebMFrame[] = [];
  let encodeError: Error | null = null;
  const EncoderCtor = (window as unknown as { VideoEncoder: VideoEncoderCtor }).VideoEncoder;
  const FrameCtor = (window as unknown as { VideoFrame: VideoFrameCtor }).VideoFrame;
  const encoder = new EncoderCtor({
    output: (chunk: EncodedChunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ timestampUs: chunk.timestamp, data, key: chunk.type === "key" });
    },
    error: (e: Error) => { encodeError = e; },
  });
  encoder.configure(config);

  const keyEvery = Math.max(1, Math.round(fps)); // ~one keyframe per second
  const scratch = document.createElement("canvas");
  try {
    for (let i = 0; i < timeline.length; i++) {
      if (opts.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
      if (encodeError) throw encodeError;
      const posed = poser.pose(timeline[i]) as unknown as SolidView[];
      const canvas = scene.renderSolidsImage(posed, framing, width, height, scratch);
      const frame = new FrameCtor(canvas, { timestamp: i * frameDurUs, duration: frameDurUs });
      encoder.encode(frame, { keyFrame: i % keyEvery === 0 });
      frame.close();
      opts.onProgress?.(((i + 1) / timeline.length) * 0.92);
      // Let the encoder's output callback drain and the UI paint.
      if (i % 3 === 0) await new Promise((r) => setTimeout(r));
    }
    await encoder.flush();
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
  if (encodeError) throw encodeError;

  chunks.sort((a, b) => a.timestampUs - b.timestampUs);
  const bytes = framesToWebM({ width, height, codec: config.codecId, frames: chunks, fps });
  opts.onProgress?.(1);
  return { blob: new Blob([bytes as BlobPart], { type: "video/webm" }), extension: "webm" };
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

/** Pick the best supported codec (VP9, else VP8) and a reasonable bitrate. */
async function pickCodec(width: number, height: number, fps: number): Promise<EncoderConfig & { codecId: "V_VP9" | "V_VP8" }> {
  const bitrate = Math.min(12e6, Math.max(1e6, Math.round(width * height * fps * 0.08)));
  const Enc = (window as unknown as { VideoEncoder: VideoEncoderCtor }).VideoEncoder;
  const candidates: { codec: string; codecId: "V_VP9" | "V_VP8" }[] = [
    { codec: "vp09.00.10.08", codecId: "V_VP9" },
    { codec: "vp8", codecId: "V_VP8" },
  ];
  for (const c of candidates) {
    const cfg = { codec: c.codec, width, height, bitrate, framerate: fps, latencyMode: "quality" as const };
    try {
      const sup = await Enc.isConfigSupported(cfg);
      if (sup?.supported) return { ...cfg, codecId: c.codecId };
    } catch { /* try next */ }
  }
  throw new Error("No supported video codec (VP9/VP8) in this browser.");
}

// ---- minimal WebCodecs typings (not in every TS dom lib) --------------------
interface EncoderConfig { codec: string; width: number; height: number; bitrate: number; framerate: number; latencyMode?: "quality" | "realtime"; }
interface EncodedChunk { byteLength: number; timestamp: number; type: "key" | "delta"; copyTo(d: Uint8Array): void; }
interface VideoEncoderCtor { new (init: { output: (c: EncodedChunk) => void; error: (e: Error) => void }): VideoEncoderLike; isConfigSupported(c: EncoderConfig): Promise<{ supported?: boolean }>; }
interface VideoEncoderLike { state: string; configure(c: EncoderConfig): void; encode(f: unknown, o?: { keyFrame?: boolean }): void; flush(): Promise<void>; close(): void; }
interface VideoFrameCtor { new (source: CanvasImageSource, init: { timestamp: number; duration?: number }): { close(): void }; }
