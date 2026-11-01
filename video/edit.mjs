// The edit pass: `node video/edit.mjs --run NAME [--acts 1,2,3]`.
// Turns recorded takes (video/takes/NAME/actN) into video/out/NAME/:
//   vibecad-tutorial.mp4  1440p60 H.264, sped-up spans with their speed chyron, cut spans removed,
//                        subtitles burned in (from the script text, never speech recognition)
//   subtitles.srt        the same subtitles as a sidecar file (for YouTube)
//   cue-sheet.md         the ADR sheet: every line with its timecode and length, for recording the voiceover to picture
//   plan.json            what the compositor draws, frame by frame
//   vo/<voice>.wav       the voiceover mix for each voice (every clip at its beat's start in the cut), and
//   vo-timeline.json     where each clip sits (video/checks/vo.mjs checks it)
// Compositing and encoding run in Chromium (WebCodecs + mp4-muxer, as the app's turntable export does), with the
// default voice's mix as the MP4's audio. The full render then gets every voice as its own audio track (mp4-muxer
// writes one): the mixes are AAC-encoded here with afconvert and muxed with ffmpeg on the GPU box (`--host`), the
// first voice the default track. The preview keeps just the default voice. --no-vo leaves the MP4 silent, as before.

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync, existsSync, createReadStream, statSync, renameSync, rmSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";
import { fastened } from "./lib/director.mjs";
import { MONTAGE } from "./script/lines.mjs";
import { loadClips, VO_TAIL_MS } from "./lib/voices.mjs";
import { readWav, writeWav } from "./lib/wav.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const run = arg("--run");
if (!run) { console.error("usage: node video/edit.mjs --run NAME"); process.exit(1); }
const acts = arg("--acts", "1,2,3").split(",").map(Number);
// --preview: a small 720p copy for review on a phone (under the 30 MB file limit), beside the full render
const preview = process.argv.includes("--preview");
const vo = process.argv.includes("--no-vo") ? null : loadClips();
const HOST = arg("--host", process.env.VIDEO_TTS_HOST ?? "mike@hexgame");
const SR = 48000;
const FPS = 60;
const ROOT = new URL("..", import.meta.url).pathname;
const takes = join(ROOT, "video", "takes", run);
const out = join(ROOT, "video", "out", run);
mkdirSync(out, { recursive: true });

// ---- the edit decision list ----
const frames = []; // per output frame: [take index, frame index]
const takeFiles = [];
const chyrons = []; // { from, to, text } in output frames
const captions = []; // { from, to, text }
const cues = [];
let outFrame = 0;

/** Spoken addresses as written, for the captions: "mikepkes dot github dot io slash CAD" → "mikepkes.github.io/CAD".
 *  (The narration keeps the spoken form for the voice.) Runs after chunking, so the dots don't split sentences. */
function written(text) {
  return text.replace(/\b[\w-]+(?: dot [\w-]+)* dot (?:com|org|net|io|dev|app|ai|co)\b(?: slash [\w-]+)*/g, (m) => m.replace(/ dot /g, ".").replace(/ slash /g, "/"));
}

/** Split a line into subtitle chunks of at most ~84 characters, at sentence then clause boundaries. */
function chunks(text) {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const out = [];
  for (const s of sentences) {
    if (s.length <= 84) { out.push(s); continue; }
    let cur = "";
    for (const part of s.split(/(?<=[,;:])\s+/)) {
      if ((cur + " " + part).trim().length > 84 && cur) { out.push(cur.trim()); cur = part; } else cur = (cur + " " + part).trim();
    }
    if (cur) {
      // still too long: break at words
      while (cur.length > 84) { const cut = cur.lastIndexOf(" ", 84); out.push(cur.slice(0, cut)); cur = cur.slice(cut + 1); }
      out.push(cur);
    }
  }
  return out;
}

// ---- the intro montage: a third of a second from each moment Act 3 marked (`d.pick`), before Act 1's cold open ----
const PICK = Math.round(FPS / 3);
let montageExtra = 0, beatsExtra = 0; // seconds the voices beyond the default add to the cut
if (acts[0] === 1 && existsSync(join(takes, "act3", "timing.json"))) {
  const timing = JSON.parse(readFileSync(join(takes, "act3", "timing.json"), "utf8"));
  const list = JSON.parse(readFileSync(join(takes, "act3", "frames.json"), "utf8")).filter((f) => f.t >= 0);
  const picks = timing.picks ?? [];
  if (picks.length && list.length) {
    const ti = takeFiles.push({ dir: `video/takes/${run}/act3/frames`, files: list.map((f) => f.file) }) - 1;
    const from = outFrame;
    // with a voiceover, the last shot plays on until the longest voice has said the line (the cuts before it stay quick)
    const clips = vo?.clips("act1-montage", MONTAGE) ?? [];
    const need = clips.length ? Math.ceil(((Math.max(...clips.map((c) => c.ms)) + VO_TAIL_MS) / 1000) * FPS) : 0;
    const needDefault = clips.length ? Math.ceil((((clips.find((c) => c.voice === vo.voices[0]) ?? clips[0]).ms + VO_TAIL_MS) / 1000) * FPS) : 0;
    const lastLen = Math.max(PICK, need - (picks.length - 1) * PICK);
    montageExtra = (lastLen - Math.max(PICK, needDefault - (picks.length - 1) * PICK)) / FPS;
    for (const [pi, p] of picks.entries()) {
      let fi = 0;
      for (let k = 0; k < (pi === picks.length - 1 ? lastLen : PICK); k++) {
        const t = p.t + k / FPS;
        while (fi + 1 < list.length && list[fi + 1].t <= t) fi++;
        frames.push([ti, fi]); outFrame++;
      }
    }
    cues.push({ act: 1, id: "montage", from, to: outFrame, text: MONTAGE });
    captions.push({ from, to: outFrame, text: MONTAGE });
    console.log(`montage: ${picks.length} picks (${picks.map((p) => p.label).join(", ")}), ${((outFrame - from) / FPS).toFixed(1)} s`);
  }
}

for (const n of acts) {
  const dir = join(takes, `act${n}`);
  if (!existsSync(join(dir, "timing.json"))) { console.warn(`no take for act ${n}`); continue; }
  const timing = JSON.parse(readFileSync(join(dir, "timing.json"), "utf8"));
  const list = JSON.parse(readFileSync(join(dir, "frames.json"), "utf8")).filter((f) => f.t >= 0);
  if (!list.length) { console.warn(`act ${n}: no frames (a dry run?)`); continue; }
  const ti = takeFiles.push({ dir: `video/takes/${run}/act${n}/frames`, files: list.map((f) => f.file) }) - 1;
  // speed at source time t: cut spans drop out, fast spans run at their factor
  const spans = timing.fast.map((f) => ({ ...f, factor: f.cut ? Infinity : fastened((f.end - f.start) * 1000).factor })).filter((f) => f.factor > 1).sort((a, b) => a.start - b.start);
  const spanAt = (t) => spans.find((s) => t >= s.start && t < s.end);
  // walk source time in output-frame steps
  const srcToOut = []; // [source t, output frame] samples for mapping beat times
  let t = 0, fi = 0;
  const end = timing.duration;
  while (t < end) {
    const s = spanAt(t);
    if (s && s.factor === Infinity) { t = s.end; continue; }
    while (fi + 1 < list.length && list[fi + 1].t <= t) fi++;
    frames.push([ti, fi]);
    srcToOut.push([t, outFrame]);
    if (s) {
      const text = `⏩ ${s.factor}× speed${s.label ? ` · ${s.label}` : ""}`;
      const last = chyrons.at(-1);
      if (last && last.text === text && last.to === outFrame) last.to = outFrame + 1; else chyrons.push({ from: outFrame, to: outFrame + 1, text });
    }
    outFrame++;
    t += (s ? s.factor : 1) / FPS;
  }
  const toOut = (src) => { let best = srcToOut[0]?.[1] ?? 0; for (const [st, of] of srcToOut) { if (st <= src) best = of; else break; } return best; };
  for (const b of timing.beats) {
    // how much longer the beat is for the slowest voice than it would be for the default voice alone
    if (b.wantMs != null) beatsExtra += (Math.max(b.actionsMs, b.wantMs) - Math.max(b.actionsMs, b.defaultWantMs)) / 1000;
    if (!b.narration.trim()) continue; // a silent beat (the title): no line to read or caption
    const from = toOut(b.start), to = Math.max(from + FPS, toOut(b.end));
    cues.push({ act: n, id: b.id, from, to, text: b.narration });
    const parts = chunks(b.narration).map(written);
    const words = parts.map((p) => p.split(/\s+/).length), total = words.reduce((a, c) => a + c, 0);
    const span = Math.max(FPS, to - from - Math.round(FPS * 0.3));
    let at = from;
    parts.forEach((p, i) => { const len = Math.round((span * words[i]) / total); captions.push({ from: at, to: at + len, text: p }); at += len; });
  }
  console.log(`act ${n}: ${list.length} frames in, ${srcToOut.length} out (${(srcToOut.length / FPS).toFixed(1)} s), ${spans.length} spans`);
  if (vo && timing.vo && timing.vo.voices.join() !== vo.voices.map((v) => v.id).join()) console.warn(`  act ${n} was timed for voices ${timing.vo.voices.join(", ")}; mixing ${vo.voices.map((v) => v.id).join(", ")}`);
}

// ---- the voiceover: each line's clip, in every voice, starts at its beat's start in the cut ----
const totalSamples = Math.round((outFrame / FPS) * SR);
const timeline = { fps: FPS, durationMs: Math.round((outFrame / FPS) * 1000), tailMs: VO_TAIL_MS, voices: vo?.voices.map((v) => ({ id: v.id, title: v.title })) ?? [], cues: [] };
for (const c of cues) {
  const clips = vo?.clips(`act${c.act}-${c.id}`, c.text) ?? [];
  c.clips = clips;
  timeline.cues.push({ act: c.act, id: c.id, from: c.from, to: c.to, startMs: Math.round((c.from / FPS) * 1000), slotMs: Math.round(((c.to - c.from) / FPS) * 1000), text: c.text, clips: Object.fromEntries(clips.map((k) => [k.voice.id, { ms: k.ms, file: k.file.slice(ROOT.length) }])) });
}
const voiced = cues.some((c) => c.clips.length);
const mixes = []; // { voice, wav } per voice with any clip
if (voiced) {
  mkdirSync(join(out, "vo"), { recursive: true });
  for (const v of vo.voices) {
    const mix = new Float32Array(totalSamples);
    let n = 0;
    for (const c of cues) {
      const clip = c.clips.find((k) => k.voice === v);
      if (!clip) { if (c.clips.length) console.warn(`  ${v.id}: no clip for ${c.id}`); continue; }
      const { samples, sampleRate } = readWav(clip.file);
      if (sampleRate !== SR) throw new Error(`${clip.file}: ${sampleRate} Hz, expected ${SR} (re-run video/vo.mjs)`);
      const at = Math.round((c.from / FPS) * SR);
      for (let i = 0; i < samples.length && at + i < totalSamples; i++) mix[at + i] += samples[i];
      n++;
    }
    if (!n) continue;
    const wav = join(out, "vo", `${v.id}.wav`);
    writeWav(wav, mix, SR);
    mixes.push({ voice: v, wav });
  }
  writeFileSync(join(out, "vo-timeline.json"), JSON.stringify(timeline, null, 1));
  const def = mixes[0].voice;
  console.log(`voiceover: ${mixes.length} voices, default ${def.id}; clip timeline (${def.id} / longest voice):`);
  for (const c of cues) {
    const d = c.clips.find((k) => k.voice === def), l = c.clips.reduce((a, b) => (!a || b.ms > a.ms ? b : a), null);
    const s = (c.from / FPS).toFixed(2), e = (c.to / FPS).toFixed(2);
    console.log(`  ${s.padStart(7)}–${e.padEnd(7)} s  ${`act${c.act}-${c.id}`.padEnd(26)} ${d ? `${def.id} ${(d.ms / 1000).toFixed(2)} s → ends ${((c.from / FPS) + d.ms / 1000).toFixed(2)}` : "(no clip)"}${l ? `; longest ${l.voice.id} ${(l.ms / 1000).toFixed(2)} s` : ""}`);
  }
  console.log(`  the other voices make the cut ${(beatsExtra + montageExtra).toFixed(1)} s longer than ${def.id} alone would (beats ${beatsExtra.toFixed(1)} s, montage ${montageExtra.toFixed(1)} s)`);
} else if (vo) console.log("voiceover: no clips (run node video/vo.mjs); the MP4 is silent");

const tc = (f, sep = ",") => { const ms = Math.round((f / FPS) * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(ms % 1000).padStart(3, "0")}`; };
writeFileSync(join(out, "subtitles.srt"), captions.map((c, i) => `${i + 1}\n${tc(c.from)} --> ${tc(c.to)}\n${c.text}\n`).join("\n"));
const voCol = (c) => (c.clips.length ? `${(Math.max(...c.clips.map((k) => k.ms)) / 1000).toFixed(1)} s` : "–");
writeFileSync(join(out, "cue-sheet.md"), `# Voiceover cue sheet (${run})\n\nRecord each line to picture (ADR), or use the synthesised voiceover (video/vo.mjs), whose clips start at "In". Times are in the cut; the picture holds about half a second of settled tail after each line. "VO" is the longest synthesised clip of the line.\n\n| # | Act | Beat | In | Length | VO | Line |\n|---|---|---|---|---|---|---|\n${cues.map((c, i) => `| ${i + 1} | ${c.act} | ${c.id} | ${tc(c.from, ".").slice(3, 9)} | ${((c.to - c.from) / FPS).toFixed(1)} s | ${voCol(c)} | ${c.text} |`).join("\n")}\n\nTotal: ${tc(outFrame, ".").slice(3, 9)}\n`);
const audio = mixes.length ? { file: `/video/out/${run}/vo/${mixes[0].voice.id}.wav`, title: mixes[0].voice.title, bitrate: preview ? 64000 : 128000 } : null;
writeFileSync(join(out, "plan.json"), JSON.stringify({ fps: FPS, width: 2560, height: 1440, takes: takeFiles, frames, chyrons, captions, audio }));
console.log(`plan: ${outFrame} frames (${tc(outFrame, ".")}), ${captions.length} captions, ${chyrons.length} chyrons`);

// ---- render ----
const mp4 = join(out, preview ? "vibecad-tutorial-preview.mp4" : "vibecad-tutorial.mp4");
const fd = openSync(mp4, "w");
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".jpg": "image/jpeg" };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "POST" && url.pathname === "/write") {
    const pos = Number(url.searchParams.get("pos"));
    const bufs = [];
    req.on("data", (c) => bufs.push(c));
    req.on("end", () => { const b = Buffer.concat(bufs); writeSync(fd, b, 0, b.length, pos); res.end("ok"); });
    return;
  }
  if (req.method === "POST" && url.pathname === "/progress") { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { process.stdout.write(`\r  ${s}   `); res.end(); }); return; }
  const file = join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
  res.setHeader("content-type", types[extname(file)] ?? "application/octet-stream");
  createReadStream(file).pipe(res);
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch({ headless: false, args: ["--window-size=400,300"] });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
page.on("console", (m) => console.log(`  [compositor] ${m.text()}`));
page.on("pageerror", (e) => console.error(`  [compositor error] ${e.message}`));
await page.goto(`http://localhost:${port}/video/compositor/index.html?plan=/video/out/${run}/plan.json${preview ? "&w=1280&h=720&bitrate=550000" : ""}`);
const result = await page.evaluate(() => window.render());
console.log(`\nrendered ${result.frames} frames, ${(result.bytes / 1e6).toFixed(1)} MB, ${result.codec}`);
await browser.close();
server.close();
closeSync(fd);

// ---- every voice as its own audio track (the full render; the preview keeps the default voice only) ----
if (!preview && mixes.length > 1 && !process.argv.includes("--one-voice")) {
  try { muxVoices(); } catch (e) { console.error(`✗ multi-voice mux failed, the MP4 keeps just ${mixes[0].voice.id}: ${e.message.split("\n").slice(0, 6).join("\n")}`); }
}
console.log(`→ ${mp4}\n→ ${join(out, "subtitles.srt")}\n→ ${join(out, "cue-sheet.md")}${voiced ? `\n→ ${join(out, "vo")}/ (the mix per voice)\n→ ${join(out, "vo-timeline.json")}` : ""}`);

/** AAC-encode each voice's mix (afconvert), then on the GPU box remux the video with all of them, in order, as
 *  separately titled tracks (ffmpeg -c copy: nothing is re-encoded), and bring the result back in place of the MP4. */
function muxVoices() {
  const SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"], rsh = `ssh ${SSH.join(" ")}`;
  const sh = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  for (const m of mixes) {
    m.m4a = m.wav.replace(/\.wav$/, ".m4a");
    execFileSync("afconvert", ["-f", "m4af", "-d", "aac", "-b", "128000", "-q", "127", m.wav, m.m4a]);
  }
  const dir = `vibecad-tts/mux/${run}`;
  execFileSync("ssh", [...SSH, HOST, `mkdir -p ~/${dir}`]);
  execFileSync("rsync", ["-a", "-e", rsh, mp4, ...mixes.map((m) => m.m4a), `${HOST}:${dir}/`]);
  const inputs = ["-i", "vibecad-tutorial.mp4", ...mixes.flatMap((m) => ["-i", `${m.voice.id}.m4a`])];
  const maps = ["-map", "0:v:0", ...mixes.flatMap((_, i) => ["-map", `${i + 1}:a:0`])];
  // the MP4 muxer keeps a track's name as its handler name (it drops `title`), which is what players list
  const meta = ["-metadata:s:v:0", "handler_name=VibeCAD tutorial", ...mixes.flatMap((m, i) => [
    `-metadata:s:a:${i}`, `title=${m.voice.title}`, `-metadata:s:a:${i}`, `handler_name=${m.voice.title}`, `-metadata:s:a:${i}`, "language=eng", `-disposition:a:${i}`, i === 0 ? "default" : "0"])];
  const ff = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...inputs, ...maps, "-c", "copy", ...meta, "-movflags", "+faststart", "tracks.mp4"];
  const probe = "ffprobe -v error -show_entries format=duration:stream=index,codec_type,codec_name,duration:stream_tags=title,handler_name,language:stream_disposition=default -of json tracks.mp4";
  const t0 = Date.now();
  execFileSync("ssh", [...SSH, HOST, `cd ~/${dir} && ${ff.map(sh).join(" ")}`], { stdio: ["ignore", "inherit", "inherit"] });
  const info = JSON.parse(execFileSync("ssh", [...SSH, HOST, `cd ~/${dir} && ${probe}`], { encoding: "utf8" }));
  const tmp = `${mp4}.tracks`;
  execFileSync("rsync", ["-a", "-e", rsh, `${HOST}:${dir}/tracks.mp4`, tmp]);
  execFileSync("ssh", [...SSH, HOST, `rm -rf ~/${dir}`]);
  renameSync(tmp, mp4);
  for (const m of mixes) rmSync(m.m4a, { force: true });
  const audio = info.streams.filter((s) => s.codec_type === "audio");
  console.log(`muxed ${audio.length} voice tracks on ${HOST} in ${((Date.now() - t0) / 1000).toFixed(0)} s (ffprobe):`);
  for (const s of info.streams) console.log(`  #${s.index} ${s.codec_type} ${s.codec_name} ${Number(s.duration).toFixed(2)} s${s.tags?.handler_name ? ` "${s.tags.handler_name}"` : ""}${s.tags?.language ? ` [${s.tags.language}]` : ""}${s.disposition?.default ? " (default)" : ""}`);
  writeFileSync(join(out, "tracks.json"), JSON.stringify(info, null, 1));
}
