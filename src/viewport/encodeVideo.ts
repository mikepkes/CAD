// Shared WebCodecs encode loop: turn a sequence of drawn frames into a WebM
// Blob. Both the motion-study recorder and the turntable recorder hand it a
// `draw(i)` that paints frame i onto a canvas; this module owns codec selection,
// the VideoEncoder lifecycle, keyframe cadence and muxing (see export/webm.ts).

import { framesToWebM, WebMFrame } from "../core/export/webm";

export interface EncodeOptions {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  /** Paint frame i (0-based) and return the canvas to encode. */
  draw: (i: number) => CanvasImageSource;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** True only where the browser can actually encode video for us. */
export function canEncodeVideo(): boolean {
  return typeof window !== "undefined" && "VideoEncoder" in window && "VideoFrame" in window;
}

export const evenDim = (n: number) => Math.max(2, Math.round(n / 2) * 2); // encoders want even dims

export async function encodeToWebM(opts: EncodeOptions): Promise<Blob> {
  if (!canEncodeVideo()) throw new Error("This browser can't record video (no WebCodecs).");
  const { width, height, fps, frameCount } = opts;
  const frameDurUs = Math.round(1e6 / fps);

  const picked = await pickCodec(width, height, fps);
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
  encoder.configure(picked.config);

  const keyEvery = Math.max(1, Math.round(fps)); // ~one keyframe per second
  try {
    for (let i = 0; i < frameCount; i++) {
      if (opts.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
      if (encodeError) throw encodeError;
      const canvas = opts.draw(i);
      const frame = new FrameCtor(canvas, { timestamp: i * frameDurUs, duration: frameDurUs });
      encoder.encode(frame, { keyFrame: i % keyEvery === 0 });
      frame.close();
      opts.onProgress?.(((i + 1) / frameCount) * 0.92);
      if (i % 3 === 0) await new Promise((r) => setTimeout(r)); // let output drain / UI paint
    }
    await encoder.flush();
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
  if (encodeError) throw encodeError;

  chunks.sort((a, b) => a.timestampUs - b.timestampUs);
  const bytes = framesToWebM({ width, height, codec: picked.codecId, frames: chunks, fps });
  opts.onProgress?.(1);
  return new Blob([bytes as BlobPart], { type: "video/webm" });
}

/** Pick the best supported codec (VP9, else VP8) and a reasonable bitrate. */
async function pickCodec(width: number, height: number, fps: number): Promise<{ config: EncoderConfig; codecId: "V_VP9" | "V_VP8" }> {
  const bitrate = Math.min(12e6, Math.max(1e6, Math.round(width * height * fps * 0.08)));
  const Enc = (window as unknown as { VideoEncoder: VideoEncoderCtor }).VideoEncoder;
  const candidates: { codec: string; codecId: "V_VP9" | "V_VP8" }[] = [
    { codec: "vp09.00.10.08", codecId: "V_VP9" },
    { codec: "vp8", codecId: "V_VP8" },
  ];
  for (const c of candidates) {
    const config = { codec: c.codec, width, height, bitrate, framerate: fps, latencyMode: "quality" as const };
    try {
      const sup = await Enc.isConfigSupported(config);
      if (sup?.supported) return { config, codecId: c.codecId };
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
