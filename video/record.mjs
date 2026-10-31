// Record takes: `node video/record.mjs [--acts 1,2,3] [--run NAME] [--dry]`.
// Needs the dev server (`npm run dev`, or `npm run tauri:dev`) on :5173.
// --dry runs the script without capturing frames (fast iteration).
// Each act is its own take in video/takes/<run>/act<N>/, with a still per beat in beats/.

import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Director } from "./lib/director.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const acts = arg("--acts", "1,2,3").split(",").map(Number);
const run = arg("--run", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
const dry = process.argv.includes("--dry");
const url = arg("--url", "http://localhost:5173/?demo");
const root = join(new URL(".", import.meta.url).pathname, "takes", run);

for (const n of acts) {
  const mod = await import(`./script/act${n}.mjs`);
  const takeDir = join(root, `act${n}`);
  mkdirSync(join(takeDir, "beats"), { recursive: true });
  console.log(`act ${n} → ${takeDir}${dry ? " (dry)" : ""}`);
  const d = await Director.open({ url, takeDir, record: !dry });
  const origBeat = d.beat.bind(d);
  d.beat = async (id, text, fn, opts) => { await origBeat(id, text, fn, opts); await d.page.screenshot({ path: join(takeDir, "beats", `${String(d.timing.beats.length).padStart(2, "0")}-${id}.png`) }).catch(() => {}); };
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
