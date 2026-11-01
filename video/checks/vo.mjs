// Checks the voiceover of a cut: `node video/checks/vo.mjs --run NAME` (after video/edit.mjs --run NAME).
//   1. every narrated line of the acts in the cut has a current clip in every voice (video/vo/<voice>/);
//   2. every clip fits its beat in the cut (no longer than the beat's slot);
//   3. no two clips of a voice overlap;
//   4. with the multi-voice MP4 (tracks.json, from ffprobe): one audio track per voice, each as long as the video.
// Exits 1 on any failure.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spoken } from "../script/lines.mjs";
import { loadClips, selectVoices } from "../lib/voices.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const run = arg("--run");
if (!run) { console.error("usage: node video/checks/vo.mjs --run NAME"); process.exit(1); }
const out = new URL(`../out/${run}/`, import.meta.url).pathname;
const tl = JSON.parse(readFileSync(join(out, "vo-timeline.json"), "utf8"));
const voices = selectVoices({ voices: tl.voices.map((v) => v.id).join(",") });
const fails = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) fails.push(msg); };

// 1. clips for every line in the cut's acts (the montage only if the cut has it)
const acts = [...new Set(tl.cues.map((c) => c.act))];
const inCut = new Set(tl.cues.map((c) => `act${c.act}-${c.id}`));
const vo = loadClips(voices);
for (const line of spoken(acts)) {
  if (line.id === "montage" && !inCut.has(line.key)) continue;
  const have = new Set(vo.clips(line.key, line.text).map((c) => c.voice.id));
  for (const v of voices) ok(have.has(v.id), `${v.id}: no current clip for ${line.key}`);
  ok(inCut.has(line.key), `${line.key} is narrated but has no beat in the cut`);
}
// 2. each clip fits its beat; 3. no overlaps, per voice
for (const v of voices) {
  const cs = tl.cues.filter((c) => c.clips[v.id]).sort((a, b) => a.startMs - b.startMs);
  for (const [i, c] of cs.entries()) {
    const ms = c.clips[v.id].ms;
    ok(ms <= c.slotMs, `${v.id}: ${c.id} is ${ms} ms, longer than its ${c.slotMs} ms beat`);
    const next = cs[i + 1];
    if (next) ok(c.startMs + ms <= next.startMs, `${v.id}: ${c.id} (${c.startMs}+${ms} ms) runs into ${next.id} at ${next.startMs} ms`);
    ok(c.startMs + ms <= tl.durationMs, `${v.id}: ${c.id} runs past the end of the cut`);
  }
}
// 4. the MP4's tracks
const tracks = join(out, "tracks.json");
if (existsSync(tracks)) {
  const info = JSON.parse(readFileSync(tracks, "utf8"));
  const audio = info.streams.filter((s) => s.codec_type === "audio");
  ok(audio.length === voices.length, `the MP4 has ${audio.length} audio tracks, expected ${voices.length}`);
  audio.forEach((s, i) => {
    const name = s.tags?.title ?? s.tags?.handler_name; // an MP4 track's name is its handler name (players list it)
    ok(name === voices[i]?.title, `audio track ${i} is named ${JSON.stringify(name)}, expected ${JSON.stringify(voices[i]?.title)}`);
    ok(s.tags?.language === "eng", `audio track ${i}: language ${s.tags?.language}, expected eng`);
    ok(Math.abs(Number(s.duration) * 1000 - tl.durationMs) < 100, `audio track ${i} lasts ${s.duration} s, the cut ${tl.durationMs / 1000} s`);
  });
  ok(audio[0]?.disposition?.default === 1 && audio.slice(1).every((s) => !s.disposition?.default), "the first audio track should be the only default");
}

const slack = Math.min(...tl.cues.flatMap((c) => Object.values(c.clips).map((k) => c.slotMs - k.ms)));
console.log(`${run}: ${tl.cues.length} lines × ${voices.length} voices, ${checks} checks; tightest fit ${slack} ms of slack${existsSync(tracks) ? "; MP4 tracks checked" : ""}`);
for (const f of fails) console.log(`  ✗ ${f}`);
console.log(fails.length ? `FAIL (${fails.length})` : "PASS");
process.exit(fails.length ? 1 : 0);
