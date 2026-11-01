// Minimal 16-bit PCM WAV reading and writing for the voiceover (afconvert's WAVs carry extra chunks, e.g. FLLR).

import { readFileSync, writeFileSync } from "node:fs";

/** → { sampleRate, channels, samples: Float32Array } (mono: channels are averaged). */
export function readWav(file) {
  const b = readFileSync(file);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${file}: not a WAV file`);
  let fmt = null, data = null;
  for (let p = 12; p + 8 <= b.length; ) {
    const id = b.toString("ascii", p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === "fmt ") fmt = { format: b.readUInt16LE(p + 8), channels: b.readUInt16LE(p + 10), sampleRate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === "data") data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${file}: no fmt or data chunk`);
  if (fmt.bits !== 16 || (fmt.format !== 1 && fmt.format !== 0xfffe)) throw new Error(`${file}: want 16-bit PCM, got format ${fmt.format}, ${fmt.bits} bits`);
  const n = Math.floor(data.length / 2 / fmt.channels), samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) s += data.readInt16LE((i * fmt.channels + c) * 2);
    samples[i] = s / fmt.channels / 32768;
  }
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples };
}

/** Write mono 16-bit PCM. */
export function writeWav(file, samples, sampleRate) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(36 + samples.length * 2, 4); b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii"); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii"); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  writeFileSync(file, b);
}

const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));

/** Peak and speech level (dBFS), and leading/trailing silence (ms, below -45 dB of the peak). */
export function levels(samples, sampleRate) {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const win = Math.round(sampleRate / 200), gate = peak * 10 ** (-45 / 20);
  const rms = [];
  for (let i = 0; i + win <= samples.length; i += win) { let e = 0; for (let k = i; k < i + win; k++) e += samples[k] * samples[k]; rms.push(Math.sqrt(e / win)); }
  const first = rms.findIndex((r) => r > gate), last = rms.length - 1 - [...rms].reverse().findIndex((r) => r > gate);
  const top = Math.max(...rms, 1e-9), voiced = rms.filter((r) => r > top * 10 ** (-30 / 20));
  const speech = Math.sqrt(voiced.reduce((s, r) => s + r * r, 0) / Math.max(1, voiced.length));
  return {
    peakDb: +db(peak).toFixed(1),
    rmsDb: +db(speech).toFixed(1),
    leadMs: first < 0 ? 0 : Math.round((first * win * 1000) / sampleRate),
    trailMs: first < 0 ? 0 : Math.round(((rms.length - 1 - last) * win * 1000) / sampleRate),
  };
}

/** Trim leading/trailing silence to `padMs` and level the speech to `rmsDb` (peaks no higher than -1 dBFS): what
 *  synth.py does to Kokoro's clips, for the `say` fallback's. */
export function trimAndLevel(samples, sampleRate, { padMs = 60, rmsDb = -20 } = {}) {
  const l = levels(samples, sampleRate), pad = Math.round((padMs * sampleRate) / 1000);
  const s = Math.max(0, Math.round((l.leadMs * sampleRate) / 1000) - pad), e = Math.min(samples.length, samples.length - Math.round((l.trailMs * sampleRate) / 1000) + pad);
  const out = samples.slice(s, e);
  const gain = Math.min(10 ** ((rmsDb - l.rmsDb) / 20), 10 ** ((-1 - l.peakDb) / 20));
  for (let i = 0; i < out.length; i++) out[i] *= gain;
  return out;
}
