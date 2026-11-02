// Does the picture match the words? `node video/checks/sync.mjs --run NAME [--video demo|tutorial] [--tol 1.0]`
// (after video/edit.mjs). Times every spoken word of the default voice — faster-whisper with word timestamps on the
// GPU box (video/tts/words.py), the script's line as its prompt, cached beside each clip — and lines them up with what
// the picture does at the same moment: every click, key, action-ring pick, intent line, title card and callout the
// recorder logged (video/lib/director.mjs), placed in the cut by the edit (vo-timeline.json `events`). Each event that
// names something ("Box", "Command K", "Export") is matched to where the narration says it, in its beat or the next;
// one that happens more than --tol seconds away from its word is flagged. Writes sync.md (the flags, worst first, and
// every beat's line with its words timed), sync.json, and sync-NN.png contact sheets at each flagged word. Exits 1 when
// anything is flagged.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { VIDEOS } from "../script/lines.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const run = arg("--run"), TOL = Number(arg("--tol", "1.0"));
if (!run) { console.error("usage: node video/checks/sync.mjs --run NAME [--video demo|tutorial] [--tol 1.0]"); process.exit(1); }
if (!arg("--video")) {
  let bad = false;
  for (const v of Object.keys(VIDEOS)) { try { execFileSync(process.execPath, [new URL(import.meta.url).pathname, ...process.argv.slice(2), "--video", v], { stdio: "inherit" }); } catch { bad = true; } }
  process.exit(bad ? 1 : 0);
}
const videoId = arg("--video"), ROOT = new URL("../..", import.meta.url).pathname, out = join(ROOT, "video", "out", run, videoId);
const HOST = arg("--host", process.env.VIDEO_TTS_HOST ?? "mike@hexgame"), SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
const tl = JSON.parse(readFileSync(join(out, "vo-timeline.json"), "utf8"));
const voice = tl.voices[0]?.id;
if (!voice) { console.error("no voiceover in this cut"); process.exit(1); }

// ---- every word of the default voice, timed (cached per clip: the words go stale only when the clip changes) ----
const cues = tl.cues.filter((c) => c.clips[voice]);
const cacheOf = (c) => join(ROOT, c.clips[voice].file.replace(/\.wav$/, ".words.json"));
const stamp = (c) => { const st = statSync(join(ROOT, c.clips[voice].file)); return `${st.size}:${Math.round(st.mtimeMs)}`; };
const todo = cues.filter((c) => { const f = cacheOf(c); return !existsSync(f) || JSON.parse(readFileSync(f, "utf8")).stamp !== stamp(c); });
if (todo.length) {
  console.log(`timing the words of ${todo.length} clips on ${HOST}…`);
  const dir = `vibecad-tts/sync/${run}-${videoId}`, rsh = `ssh ${SSH.join(" ")}`;
  execFileSync("ssh", [...SSH, HOST, `mkdir -p ~/${dir}`]);
  execFileSync("rsync", ["-a", "-e", rsh, join(ROOT, "video", "tts", "words.py"), ...todo.map((c) => join(ROOT, c.clips[voice].file)), `${HOST}:${dir}/`]);
  const jobs = todo.map((c) => ({ key: `act${c.act}-${c.id}`, file: basename(c.clips[voice].file), text: c.text }));
  const jobsFile = join(out, "sync-jobs.json");
  writeFileSync(jobsFile, JSON.stringify(jobs));
  execFileSync("rsync", ["-a", "-e", rsh, jobsFile, `${HOST}:${dir}/jobs.json`]);
  execFileSync("ssh", [...SSH, HOST, `cd ~/${dir} && ~/vibecad-tts/venv/bin/python words.py jobs.json words.json`], { stdio: ["ignore", "inherit", "inherit"] });
  const got = JSON.parse(execFileSync("ssh", [...SSH, HOST, `cat ~/${dir}/words.json && rm -rf ~/${dir}`], { encoding: "utf8", maxBuffer: 64e6 }));
  for (const c of todo) writeFileSync(cacheOf(c), JSON.stringify({ stamp: stamp(c), words: got[`act${c.act}-${c.id}`] ?? [] }));
}
const norm = (w) => w.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");
const words = []; // { t (cut seconds), w, n (normalised), cue }
for (const c of cues) {
  const at = (c.clips[voice].startMs ?? c.startMs) / 1000;
  for (const x of JSON.parse(readFileSync(cacheOf(c), "utf8")).words) words.push({ t: +(at + x.s).toFixed(3), end: +(at + x.e).toFixed(3), w: x.w, n: norm(x.w), cue: c.id, act: c.act });
}

// ---- what the picture does, and the word that names it ----
const STOP = new Set("the a an and or of to in on at for by with this that it its is be as up down out here there into from your you all one two".split(" "));
/** The words an event names, as the narration would say them (keys spelled the way the lines say them). */
function named(e) {
  if (e.kind === "key") {
    const KEY = { "Meta+k": "command k", "Meta+z": "command z", "Meta+Enter": "finish", s: "sketch", r: "rectangle", e: "extrude" };
    return KEY[e.label] ? KEY[e.label].split(" ") : [];
  }
  if (!["click", "ring", "intent", "card", "callout", "type"].includes(e.kind)) return [];
  if (e.label === "(off)" || e.label === "here" || e.label === "the model" || /[.#[\]>]/.test(e.label)) return []; // a selector or nothing in particular
  const text = e.label.split(" · ")[0]; // a callout: its title, not its subtitle
  return text.split(/[\s/=,()▾:]+/).map(norm).filter((w) => w.length >= 3 && !STOP.has(w));
}
const same = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) || a.replace(/(ing|ed|es|s)$/, "") === b.replace(/(ing|ed|es|s)$/, "");
const order = cues.map((c) => c.id);
const events = (tl.events ?? []).map((e) => ({ ...e, names: named(e) }));
const matched = [], unmatched = [];
for (const e of events.filter((x) => x.names.length)) {
  // its beat's words, and the next beat's (a beat's actions can run on while the next line starts)
  const k = order.indexOf(e.beat), near = new Set([order[k], order[k + 1], order[k - 1]].filter(Boolean));
  let best = null;
  for (const w of words) {
    if (!near.has(w.cue) || !e.names.some((n) => same(n, w.n))) continue;
    if (!best || Math.abs(w.t - e.t) < Math.abs(best.t - e.t)) best = w;
  }
  if (best) matched.push({ ...e, word: best.w, wordT: best.t, delta: +(e.t - best.t).toFixed(2) });
  else unmatched.push(e);
}
const flags = matched.filter((m) => Math.abs(m.delta) > TOL).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

// ---- the report ----
const mmss = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const lines = [`# Sync check: ${VIDEOS[videoId].title} (${run})`, "",
  `Words timed in the default voice (${voice}) with faster-whisper; events from the recorder, placed in the cut. A flag is an event more than ${TOL} s from the word that names it: **+** the picture comes after the word, **−** before it.`, ""];
if (!events.length) lines.push("**No events in this cut.** It was recorded before the recorder logged them: re-record it to check the picture against the words. The words are timed below.", "");
else {
  lines.push(`${events.length} events, ${matched.length} matched to a word, ${flags.length} flagged, ${unmatched.length} naming something the narration never says nearby.`, "");
  if (flags.length) {
    lines.push("| Word at | Beat | Said | Shown | Event at | Off by |", "|---|---|---|---|---|---|");
    for (const f of flags) lines.push(`| ${mmss(f.wordT)} | ${f.beat} | "${f.word}" | ${f.kind}: ${f.label.replace(/\|/g, "/")} | ${mmss(f.t)} | ${f.delta > 0 ? "+" : "−"}${Math.abs(f.delta).toFixed(1)} s |`);
    lines.push("");
  }
  if (unmatched.length) lines.push("Not named in the narration nearby: " + unmatched.map((e) => `${e.kind} "${e.label}" (${mmss(e.t)})`).join("; ") + ".", "");
}
lines.push("## The words, beat by beat", "");
for (const c of cues) {
  const ws = words.filter((w) => w.cue === c.id), evs = events.filter((e) => e.beat === c.id && !["beat", "view"].includes(e.kind));
  lines.push(`**${c.id}** (${mmss(c.startMs / 1000)}–${mmss((c.startMs + c.slotMs) / 1000)}): ${ws.map((w) => `${w.w} \`${mmss(w.t)}\``).join(" ")}`);
  if (evs.length) lines.push("", `> shown: ${evs.map((e) => `${e.kind} "${e.label}" \`${mmss(e.t)}\``).join(" · ")}`);
  lines.push("");
}
writeFileSync(join(out, "sync.md"), lines.join("\n"));
writeFileSync(join(out, "sync.json"), JSON.stringify({ voice, tol: TOL, words, events, matched, flags, unmatched }, null, 1));
console.log(`${VIDEOS[videoId].title}: ${words.length} words timed, ${events.length} events, ${matched.length} matched, ${flags.length} flagged → ${join(out, "sync.md")}`);
for (const f of flags.slice(0, 12)) console.log(`  ${mmss(f.wordT)} "${f.word}" vs ${f.kind} "${f.label}" at ${mmss(f.t)}: ${f.delta > 0 ? "+" : ""}${f.delta} s`);
// contact sheets at each flagged word (the picture when the word is said)
if (flags.length) execFileSync(process.execPath, [join(ROOT, "video", "sheet.mjs"), "--run", run, "--video", videoId, "--prefix", "sync", "--at", flags.slice(0, 24).map((f) => f.wordT.toFixed(2)).join(",")], { stdio: "ignore" });
process.exit(flags.length ? 1 : 0);
