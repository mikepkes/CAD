// Minimal WebM (Matroska / EBML) muxer for a single video track, fed by the
// encoded chunks a WebCodecs VideoEncoder produces. Zero-dependency — we
// hand-write the EBML so the export stays static and offline, same stance as the
// STL / 3MF writers. A motion study is short, so we buffer every frame and write
// exact element lengths (no unknown-size streaming elements), which the widest
// set of players and editors accept.

export interface WebMFrame {
  timestampUs: number; // presentation time, microseconds
  data: Uint8Array;    // the codec's encoded frame
  key: boolean;        // keyframe?
}

export interface WebMOptions {
  width: number;
  height: number;
  codec: "V_VP9" | "V_VP8" | "V_MPEG4/ISO/AVC";
  frames: WebMFrame[]; // in presentation order
  /** Frame rate, used only to derive the file's Duration. */
  fps: number;
}

// ---- EBML element IDs (written as their canonical multi-byte constants) ------
const ID = {
  EBML: 0x1a45dfa3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2, EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  Info: 0x1549a966, TimestampScale: 0x2ad7b1, MuxingApp: 0x4d80, WritingApp: 0x5741, Duration: 0x4489,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackUID: 0x73c5,
  TrackType: 0x83, FlagLacing: 0x9c, CodecID: 0x86, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba,
  Cluster: 0x1f43b675, Timestamp: 0xe7, SimpleBlock: 0xa3,
} as const;

const SCALE_NS = 1_000_000; // 1 ms per tick → cluster/block timecodes are in ms

export function framesToWebM(opts: WebMOptions): Uint8Array {
  const { width, height, codec, frames, fps } = opts;
  const enc = new TextEncoder();

  const header = el(ID.EBML, cat(
    uintEl(ID.EBMLVersion, 1), uintEl(ID.EBMLReadVersion, 1),
    uintEl(ID.EBMLMaxIDLength, 4), uintEl(ID.EBMLMaxSizeLength, 8),
    el(ID.DocType, enc.encode("webm")), uintEl(ID.DocTypeVersion, 2), uintEl(ID.DocTypeReadVersion, 2),
  ));

  const durationMs = frames.length ? (frames.length * 1000) / fps : 0;
  const info = el(ID.Info, cat(
    uintEl(ID.TimestampScale, SCALE_NS),
    el(ID.MuxingApp, enc.encode("Chisel CAD")),
    el(ID.WritingApp, enc.encode("Chisel CAD")),
    floatEl(ID.Duration, durationMs),
  ));

  const tracks = el(ID.Tracks, el(ID.TrackEntry, cat(
    uintEl(ID.TrackNumber, 1), uintEl(ID.TrackUID, 1), uintEl(ID.TrackType, 1), uintEl(ID.FlagLacing, 0),
    el(ID.CodecID, enc.encode(codec)),
    el(ID.Video, cat(uintEl(ID.PixelWidth, width), uintEl(ID.PixelHeight, height))),
  )));

  // Group frames into clusters; start a new cluster at each keyframe so block
  // timecodes (int16, in ms, relative to the cluster) never overflow.
  const clusters: Uint8Array[] = [];
  let i = 0;
  while (i < frames.length) {
    const base = Math.round(frames[i].timestampUs / 1000);
    const blocks: Uint8Array[] = [];
    do {
      const f = frames[i];
      const rel = Math.round(f.timestampUs / 1000) - base;
      blocks.push(el(ID.SimpleBlock, cat(vint(1), int16(rel), u8(f.key ? 0x80 : 0x00), f.data)));
      i++;
    } while (i < frames.length && !frames[i].key); // next keyframe opens the next cluster
    clusters.push(el(ID.Cluster, cat(uintEl(ID.Timestamp, base), ...blocks)));
  }

  const segment = el(ID.Segment, cat(info, tracks, ...clusters));
  return cat(header, segment);
}

// ---- EBML primitives ---------------------------------------------------------

/** An element: its ID bytes, a size VINT, then the payload. */
function el(idHex: number, payload: Uint8Array): Uint8Array {
  return cat(idBytes(idHex), vint(payload.length), payload);
}

/** An unsigned-integer element with a minimal big-endian payload. */
function uintEl(idHex: number, value: number): Uint8Array {
  return el(idHex, uintBytes(value));
}

/** An IEEE-754 double (8-byte) element. */
function floatEl(idHex: number, value: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, value, false);
  return el(idHex, b);
}

/** A known element ID, as its canonical 1–4 byte big-endian constant. */
function idBytes(hex: number): Uint8Array {
  const len = hex > 0xffffff ? 4 : hex > 0xffff ? 3 : hex > 0xff ? 2 : 1;
  return beBytes(hex, len);
}

/** A size value as an EBML VINT (variable width, with the width-marker bit). */
function vint(value: number): Uint8Array {
  let width = 1;
  while (value >= 2 ** (7 * width) - 1 && width < 8) width++; // all-ones is reserved ("unknown")
  const bytes = beBytes(value, width);
  bytes[0] |= 0x80 >> (width - 1); // length-descriptor marker just above the value bits
  return bytes;
}

/** Minimal-length (1–6 byte) big-endian unsigned integer. */
function uintBytes(value: number): Uint8Array {
  let len = 1;
  while (value >= 2 ** (8 * len) && len < 6) len++;
  return beBytes(value, len);
}

function beBytes(value: number, len: number): Uint8Array {
  const b = new Uint8Array(len);
  let v = value;
  for (let i = len - 1; i >= 0; i--) { b[i] = v & 0xff; v = Math.floor(v / 256); }
  return b;
}

function int16(value: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setInt16(0, value, false);
  return b;
}

const u8 = (n: number) => new Uint8Array([n & 0xff]);

function cat(...parts: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
