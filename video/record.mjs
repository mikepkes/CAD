// Record takes: `node video/record.mjs [--video demo|tutorial] [--acts 0,1,2,3] [--run NAME] [--dry]`.
// The demo is Acts 0 and 3, the tutorial Acts 1 and 2 (VIDEOS in script/lines.mjs); without either flag, every act.
// Needs the dev server (`npm run dev`, or `npm run tauri:dev`) on :5173, or another with --url / VIDEO_URL
// (e.g. VIDEO_URL="http://localhost:5187/?demo"). Beats are timed to the voiceover clips in video/vo (video/vo.mjs)
// when they exist, for the voices VIDEO_VOICES / VIDEO_TTS select; otherwise to each line's read time.
// --dry runs the script without capturing frames (fast iteration).
// Each act is its own take in video/takes/<run>/act<N>/, with a still per beat in beats/.

import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Director } from "./lib/director.mjs";
import { VIDEOS } from "./script/lines.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const acts = arg("--acts") ? arg("--acts").split(",").map(Number) : arg("--video") ? VIDEOS[arg("--video")].acts : [0, 1, 2, 3];
const run = arg("--run", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
const dry = process.argv.includes("--dry");
const url = arg("--url", process.env.VIDEO_URL ?? "http://localhost:5173/?demo");
const root = join(new URL(".", import.meta.url).pathname, "takes", run);

// Warm up first: the dev server pre-bundles dependencies on first use and reloads the page when it does, which
// must not happen inside a take (pass 2 lost its first second to one). Load the app and every example once.
if (!dry) {
  const warm = await Director.open({ url, takeDir: join(root, "warmup"), record: false, headless: true });
  for (const name of ["gyroscope", "clockwork", "walker", "skadis", "handlebar", "origami", "bistable", "roubo"]) {
    await warm.run(async (n) => { const r = await fetch(`/examples/${n}.json`); if (r.ok) await window.__vibecadDemo.openText(await r.text(), `${n}.vibecad.json`); }, name).catch(() => {});
  }
  await warm.close();
  console.log("warmed up");
}

for (const n of acts) {
  const mod = await import(`./script/act${n}.mjs`);
  const takeDir = join(root, `act${n}`);
  mkdirSync(join(takeDir, "beats"), { recursive: true });
  console.log(`act ${n} → ${takeDir}${dry ? " (dry)" : ""}`);
  const d = await Director.open({ url, takeDir, record: !dry, act: n });
  const origBeat = d.beat.bind(d);
  d.beat = async (id, ...rest) => { await origBeat(id, ...rest); await d.page.screenshot({ path: join(takeDir, "beats", `${String(d.timing.beats.length).padStart(2, "0")}-${id}.png`) }).catch(() => {}); };
  try {
    if (mod.preroll) await mod.preroll(d);
    await d.startRecording();
    await mod[`act${n}`](d);
  } catch (e) {
    d.note(`act ${n} stopped: ${e.message}`);
    console.error(`act ${n} stopped:`, e);
  } finally {
    await d.stopRecording();
    await d.close();
  }
  const notes = d.timing.notes;
  console.log(`act ${n}: ${d.timing.beats.length} beats, ${d.timing.duration?.toFixed(1)} s, ${d.frames.length} frames${notes.length ? `, ${notes.length} problems:` : ""}`);
  for (const nt of notes) console.log(`   - ${nt.text}`);
}
if (!existsSync(root)) mkdirSync(root, { recursive: true });
console.log(`takes in ${root}`);
