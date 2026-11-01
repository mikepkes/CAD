// The edit pass: `node video/edit.mjs --run NAME [--acts 1,2,3]`.
// Turns recorded takes (video/takes/NAME/actN) into video/out/NAME/:
//   vibecad-tutorial.mp4  1440p60 H.264, sped-up spans with their speed chyron, cut spans removed,
//                        subtitles burned in (from the script text, never speech recognition)
//   subtitles.srt        the same subtitles as a sidecar file (for YouTube)
//   cue-sheet.md         the ADR sheet: every line with its timecode and length, for recording the voiceover to picture
//   plan.json            what the compositor draws, frame by frame
// Compositing and encoding run in Chromium (WebCodecs + mp4-muxer, as the app's turntable export does).

import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync, existsSync, createReadStream, statSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";
import { fastened } from "./lib/director.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const run = arg("--run");
if (!run) { console.error("usage: node video/edit.mjs --run NAME"); process.exit(1); }
const acts = arg("--acts", "1,2,3").split(",").map(Number);
// --preview: a small 720p copy for review on a phone (under the 30 MB file limit), beside the full render
const preview = process.argv.includes("--preview");
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
const MONTAGE = "Gears, mechanisms, sections, forces, shop drawings.";
const PICK = Math.round(FPS / 3);
if (acts[0] === 1 && existsSync(join(takes, "act3", "timing.json"))) {
  const timing = JSON.parse(readFileSync(join(takes, "act3", "timing.json"), "utf8"));
  const list = JSON.parse(readFileSync(join(takes, "act3", "frames.json"), "utf8")).filter((f) => f.t >= 0);
  const picks = timing.picks ?? [];
  if (picks.length && list.length) {
    const ti = takeFiles.push({ dir: `video/takes/${run}/act3/frames`, files: list.map((f) => f.file) }) - 1;
    const from = outFrame;
    for (const p of picks) {
      let fi = 0;
      for (let k = 0; k < PICK; k++) {
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
    const from = toOut(b.start), to = Math.max(from + FPS, toOut(b.end));
    cues.push({ act: n, id: b.id, from, to, text: b.narration });
    const parts = chunks(b.narration);
    const words = parts.map((p) => p.split(/\s+/).length), total = words.reduce((a, c) => a + c, 0);
    const span = Math.max(FPS, to - from - Math.round(FPS * 0.3));
    let at = from;
    parts.forEach((p, i) => { const len = Math.round((span * words[i]) / total); captions.push({ from: at, to: at + len, text: p }); at += len; });
  }
  console.log(`act ${n}: ${list.length} frames in, ${srcToOut.length} out (${(srcToOut.length / FPS).toFixed(1)} s), ${spans.length} spans`);
}

const tc = (f, sep = ",") => { const ms = Math.round((f / FPS) * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(ms % 1000).padStart(3, "0")}`; };
writeFileSync(join(out, "subtitles.srt"), captions.map((c, i) => `${i + 1}\n${tc(c.from)} --> ${tc(c.to)}\n${c.text}\n`).join("\n"));
writeFileSync(join(out, "cue-sheet.md"), `# Voiceover cue sheet (${run})\n\nRecord each line to picture (ADR). Times are in the cut; the picture holds about half a second of settled tail after each line.\n\n| # | Act | Beat | In | Length | Line |\n|---|---|---|---|---|---|\n${cues.map((c, i) => `| ${i + 1} | ${c.act} | ${c.id} | ${tc(c.from, ".").slice(3, 9)} | ${((c.to - c.from) / FPS).toFixed(1)} s | ${c.text} |`).join("\n")}\n\nTotal: ${tc(outFrame, ".").slice(3, 9)}\n`);
writeFileSync(join(out, "plan.json"), JSON.stringify({ fps: FPS, width: 2560, height: 1440, takes: takeFiles, frames, chyrons, captions }));
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
console.log(`→ ${mp4}\n→ ${join(out, "subtitles.srt")}\n→ ${join(out, "cue-sheet.md")}`);
