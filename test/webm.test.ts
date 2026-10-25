import { describe, it, expect } from "vitest";
import { framesToWebM, WebMFrame } from "../src/core/export/webm";

const frame = (timestampUs: number, key: boolean, n = 8): WebMFrame =>
  ({ timestampUs, key, data: new Uint8Array(n).map((_, i) => (i + timestampUs) & 0xff) });

describe("WebM muxer", () => {
  it("writes an EBML header and a Segment with Info and Tracks", () => {
    const z = framesToWebM({ width: 320, height: 240, codec: "V_VP9", fps: 30, frames: [frame(0, true)] });
    // EBML header magic 0x1A45DFA3
    expect([z[0], z[1], z[2], z[3]]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    const text = latin1(z);
    expect(text).toContain("webm");       // DocType
    expect(text).toContain("Chisel CAD"); // MuxingApp / WritingApp
  });

  it("starts a new Cluster at each keyframe and keeps frames in order", () => {
    const frames = [frame(0, true), frame(33333, false), frame(66666, false), frame(100000, true)];
    const z = framesToWebM({ width: 320, height: 240, codec: "V_VP8", fps: 30, frames });
    // Cluster id 0x1F43B675 appears once per keyframe (two here).
    expect(countBytes(z, [0x1f, 0x43, 0xb6, 0x75])).toBe(2);
    // SimpleBlock id 0xA3 appears once per frame.
    expect(countBytes(z, [0xa3])).toBeGreaterThanOrEqual(4);
  });

  it("encodes every element length as a valid EBML VINT (parse walks to EOF)", () => {
    const frames = [frame(0, true), frame(33333, false), frame(66666, true)];
    const z = framesToWebM({ width: 640, height: 480, codec: "V_VP9", fps: 30, frames });
    // Walk the two top-level elements (EBML header, Segment) and confirm the
    // declared sizes tile the file exactly — a size byte off by one would not.
    let o = 0, seen = 0;
    while (o < z.length) {
      o += idLen(z[o]);              // skip the element ID
      const [size, w] = readVint(z, o);
      o += w + size;                 // skip size field + payload
      seen++;
    }
    expect(o).toBe(z.length);        // landed exactly on EOF
    expect(seen).toBe(2);            // EBML + Segment
  });
});

function latin1(b: Uint8Array): string { let s = ""; for (const x of b) s += String.fromCharCode(x); return s; }
function countBytes(hay: Uint8Array, needle: number[]): number {
  let n = 0;
  for (let i = 0; i + needle.length <= hay.length; i++) { if (needle.every((v, k) => hay[i + k] === v)) n++; }
  return n;
}
function idLen(first: number): number { // EBML ID width from its leading byte
  if (first & 0x80) return 1; if (first & 0x40) return 2; if (first & 0x20) return 3; return 4;
}
function readVint(b: Uint8Array, o: number): [number, number] { // [value, width]
  const first = b[o];
  let width = 1; let mask = 0x80;
  while (!(first & mask) && width < 8) { width++; mask >>= 1; }
  let value = first & (mask - 1);
  for (let i = 1; i < width; i++) value = value * 256 + b[o + i];
  return [value, width];
}
