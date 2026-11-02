// The voiceover: `node video/vo.mjs [--acts 0,1,2,3] [--voices af_heart,bm_george] [--say] [--force] [--host mike@hexgame]`
// Synthesises every narrated line (video/script/lines.mjs, plus the montage's) in every voice, one clip per line per
// voice: video/vo/<voice>/<act>-<beat>.wav, 48 kHz 16-bit mono, silence trimmed, levelled to -20 dBFS speech.
// Only lines whose text (or voice settings) changed since the last run are synthesised again.
//
// Engines:
//   kokoro (default)  Kokoro-82M on the GPU box over ssh (~/vibecad-tts there; see video/NOTES.md, "Voiceover").
//                     The lines go over as JSON; video/tts/synth.py runs them on the GPU, trims and levels each, and
//                     the WAVs come back by rsync, then afconvert makes them 48 kHz.
//   say (--say, or VIDEO_TTS=say)  macOS `say` with the Daniel voice: the fallback when the GPU box is unreachable.
// --calibrate prints, per Kokoro voice, its pace over the clips it has and the speed that would make it 170 words a minute.
// --check prints each clip's length, levels and phonemes (the pronunciation, without listening).

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spoken } from "./script/lines.mjs";
import { SYNTH_VERSION, lineHash, readManifest, selectVoices, spokenText, voiceDir, VO_ROOT } from "./lib/voices.mjs";
import { levels, readWav, trimAndLevel, writeWav } from "./lib/wav.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);
const acts = arg("--acts", "0,1,2,3").split(",").map(Number);
const HOST = arg("--host", process.env.VIDEO_TTS_HOST ?? "mike@hexgame");
const REMOTE = "vibecad-tts"; // under the remote home
const SR = 48000;
const TARGET_WPM = 170;
const SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

const voices = selectVoices({ voices: arg("--voices"), engine: has("--say") ? "say" : undefined });
const lines = spoken(acts);
const words = (t) => t.trim().split(/\s+/).length;
const afinfoMs = (file) => Math.round(Number(execFileSync("afinfo", [file], { encoding: "utf8" }).match(/estimated duration: ([\d.]+)/)[1]) * 1000);
/** Any WAV/AIFF → 48 kHz 16-bit mono WAV (afconvert resamples with its best quality). */
const to48k = (src, dst) => execFileSync("afconvert", ["-f", "WAVE", "-d", `LEI16@${SR}`, "-c", "1", "--src-complexity", "bats", "-r", "127", src, dst]);

function ssh(cmd, opts = {}) { return execFileSync("ssh", [...SSH, HOST, cmd], { encoding: "utf8", ...opts }); }

/** Run synth.py on the GPU box over these jobs; resolves to one result per job (by key), files left in `remoteOut`. */
function runRemote(jobs, remoteOut, onResult) {
  return new Promise((resolve, reject) => {
    const p = spawn("ssh", [...SSH, HOST, `cd ~/${REMOTE} && mkdir -p ${remoteOut} && HF_HOME=~/${REMOTE}/hf venv/bin/python -W ignore synth.py ${remoteOut}`], { stdio: ["pipe", "pipe", "pipe"] });
    const results = new Map();
    let buf = "", err = "";
    p.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("{")) continue;
        const r = JSON.parse(line);
        if (r.key) { results.set(r.key, r); onResult?.(r, results.size); } else console.log(r.note ? `\n  on ${HOST}: ${r.note}` : `  on ${HOST}: ${r.device}, torch ${r.torch}, ${r.jobs} clips`);
      }
    });
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => (code === 0 ? resolve(results) : reject(new Error(`synth.py exited ${code}:\n${err.split("\n").filter((l) => !/warn/i.test(l)).slice(-15).join("\n")}`))));
    p.stdin.end(JSON.stringify(jobs));
  });
}

function reachable() {
  try { ssh(`test -x ~/${REMOTE}/venv/bin/python && echo ok`, { stdio: ["ignore", "pipe", "pipe"] }); return true; } catch { return false; }
}

const incoming = join(VO_ROOT, ".incoming");

async function synthKokoro(todo) {
  if (!todo.length) return;
  if (!reachable()) {
    console.error(`✗ ${HOST} is not reachable (or ~/${REMOTE} is not set up there). Use the macOS fallback: node video/vo.mjs --say (or VIDEO_TTS=say).`);
    process.exit(1);
  }
  execFileSync("rsync", ["-a", "-e", `ssh ${SSH.join(" ")}`, new URL("./tts/synth.py", import.meta.url).pathname, `${HOST}:${REMOTE}/synth.py`]);
  // in batches, each brought back and saved before the next, so an interrupted run keeps what it made
  const BATCH = 120, t0 = Date.now(), devices = {};
  let made = 0;
  for (let b = 0; b < todo.length; b += BATCH) {
    const part = todo.slice(b, b + BATCH), batch = `out/${Date.now()}`;
    const jobs = part.map(({ voice, line }) => ({ key: `${voice.id}--${line.key}`, voice: voice.voice, text: spokenText(line.text, voice), speed: voice.speed }));
    const results = await runRemote(jobs, batch, (r) => { devices[r.device] = (devices[r.device] ?? 0) + 1; process.stdout.write(`\r  ${++made}/${todo.length} clips synthesised (${((Date.now() - t0) / 1000).toFixed(0)} s)   `); });
    rmSync(incoming, { recursive: true, force: true });
    mkdirSync(incoming, { recursive: true });
    execFileSync("rsync", ["-a", "-e", `ssh ${SSH.join(" ")}`, `${HOST}:${REMOTE}/${batch}/`, `${incoming}/`]);
    ssh(`rm -rf ~/${REMOTE}/${batch}`);
    for (const { voice, line } of part) {
      const key = `${voice.id}--${line.key}`, r = results.get(key);
      if (!r) { console.error(`\n  ✗ no clip for ${key}`); continue; }
      const file = join(voiceDir(voice), `${line.key}.wav`);
      to48k(join(incoming, `${key}.wav`), file);
      record(voice, line, file, { phonemes: r.phonemes, trimmedLeadMs: r.trimmedLeadMs, trimmedTrailMs: r.trimmedTrailMs, gainDb: r.gainDb, device: r.device });
    }
    rmSync(incoming, { recursive: true, force: true });
    save();
  }
  process.stdout.write(`\n  made on: ${Object.entries(devices).map(([d, n]) => `${d} ${n}`).join(", ")}\n`);
}

function synthSay(todo) {
  mkdirSync(incoming, { recursive: true });
  let done = 0;
  for (const { voice, line } of todo) {
    const aiff = join(incoming, `${voice.id}--${line.key}.aiff`), raw = join(incoming, `${voice.id}--${line.key}.wav`);
    execFileSync("say", ["-v", voice.voice, "-r", String(voice.rate), "-o", aiff, spokenText(line.text, voice)]);
    to48k(aiff, raw);
    const { samples } = readWav(raw);
    const file = join(voiceDir(voice), `${line.key}.wav`);
    writeWav(file, trimAndLevel(samples, SR), SR);
    record(voice, line, file, {});
    process.stdout.write(`\r  ${++done}/${todo.length} clips (say)   `);
  }
  if (todo.length) process.stdout.write("\n");
  rmSync(incoming, { recursive: true, force: true });
  save();
}

/** Each voice's pace over every line it has (from the manifests), and the speed that would bring it to TARGET_WPM
 *  (Kokoro's durations scale as 1/speed). Paste the speeds into video/lib/voices.mjs and re-run. */
function calibrate() {
  for (const v of voices.filter((x) => x.engine === "kokoro")) {
    const m = readManifest(v), have = lines.filter((l) => m[l.key]);
    if (!have.length) { console.log(`${v.id}: no clips yet (run node video/vo.mjs first)`); continue; }
    const wpm = (have.reduce((s, l) => s + words(l.text), 0) / have.reduce((s, l) => s + m[l.key].ms, 0)) * 60000;
    console.log(`${v.id.padEnd(12)} ${wpm.toFixed(0)} wpm at speed ${v.speed.toFixed(2)} → speed ${((v.speed * TARGET_WPM) / wpm).toFixed(2)}`);
  }
}

if (has("--calibrate")) { calibrate(); process.exit(0); }

// ---- what needs synthesising ----
const todo = [];
const manifests = new Map(voices.map((v) => [v.id, readManifest(v)]));
for (const voice of voices) {
  mkdirSync(voiceDir(voice), { recursive: true });
  const m = manifests.get(voice.id);
  for (const line of lines) {
    const c = m[line.key];
    if (has("--force") || !c || c.hash !== lineHash(line.text, voice) || !existsSync(join(voiceDir(voice), `${line.key}.wav`))) todo.push({ voice, line });
  }
}
console.log(`${lines.length} lines × ${voices.length} voices: ${todo.length} to synthesise, ${lines.length * voices.length - todo.length} cached`);

/** A clip is in place: measure it (afinfo for the length) and enter it in its voice's manifest. */
function record(voice, line, file, info) {
  const { samples } = readWav(file);
  manifests.get(voice.id)[line.key] = { text: line.text, spoken: spokenText(line.text, voice), hash: lineHash(line.text, voice), synth: SYNTH_VERSION, ms: afinfoMs(file), ...levels(samples, SR), ...info };
}
function save() { for (const voice of voices) writeFileSync(join(voiceDir(voice), "manifest.json"), JSON.stringify(manifests.get(voice.id), null, 1)); }

await synthKokoro(todo.filter((t) => t.voice.engine === "kokoro"));
synthSay(todo.filter((t) => t.voice.engine === "say"));

// ---- prune clips of lines that no longer exist (in the acts processed) ----
const live = new Set(lines.map((l) => l.key));
for (const voice of voices) {
  const m = manifests.get(voice.id);
  for (const key of Object.keys(m)) {
    const act = Number(key.match(/^act(\d+)-/)?.[1]);
    if (acts.includes(act) && !live.has(key)) { delete m[key]; rmSync(join(voiceDir(voice), `${key}.wav`), { force: true }); console.log(`  pruned ${voice.id}/${key}`); }
  }
  for (const f of readdirSync(voiceDir(voice))) if (f.endsWith(".wav") && !m[f.slice(0, -4)]) rmSync(join(voiceDir(voice), f));
}
save();

// ---- report: per voice, total length and pace; per line, the longest voice ----
const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad("voice", 12)} ${pad("lines", 6)} ${pad("total", 8)} ${pad("wpm", 5)} peak dBFS (max)  speech dBFS  lead/trail ms (max)`);
for (const voice of voices) {
  const m = manifests.get(voice.id), cs = lines.map((l) => m[l.key]).filter(Boolean);
  const ms = cs.reduce((s, c) => s + c.ms, 0), n = lines.filter((l) => m[l.key]).reduce((s, l) => s + words(l.text), 0);
  console.log(`${pad(voice.id, 12)} ${pad(cs.length, 6)} ${pad((ms / 1000).toFixed(1) + " s", 8)} ${pad(((n / ms) * 60000).toFixed(0), 5)} ${pad(Math.max(...cs.map((c) => c.peakDb)), 16)} ${pad((cs.reduce((s, c) => s + c.rmsDb, 0) / cs.length).toFixed(1), 12)} ${Math.max(...cs.map((c) => c.leadMs))}/${Math.max(...cs.map((c) => c.trailMs))}`);
}
if (has("--check")) {
  for (const line of lines) {
    const all = voices.map((v) => [v, manifests.get(v.id)[line.key]]).filter(([, c]) => c);
    const [lv, lc] = all.reduce((a, b) => (b[1].ms > a[1].ms ? b : a));
    console.log(`\n${line.key}: longest ${lv.id} ${(lc.ms / 1000).toFixed(2)} s, shortest ${(Math.min(...all.map(([, c]) => c.ms)) / 1000).toFixed(2)} s`);
    console.log(`  ${voices[0].id}: ${manifests.get(voices[0].id)[line.key]?.phonemes ?? "(no phonemes from say)"}`);
  }
}
console.log(`\nclips in ${VO_ROOT}`);
