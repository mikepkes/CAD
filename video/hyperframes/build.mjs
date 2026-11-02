// A trial of the edit pass as a HyperFrames composition: `node video/hyperframes/build.mjs --run NAME`.
// Builds the same cut as `video/edit.mjs --acts 1` (the intro montage, then Act 1) from the same takes, but as HTML:
// each act's take becomes a 60 fps source video, every shot a <video> clip into it (data-media-start, and
// data-playback-rate for a sped-up pick), the subtitles timed <div>s, and the default voice an <audio> clip. HyperFrames
// renders it; ffmpeg then adds the other voices as tracks and the chapters, as edit.mjs does.
//
// Run it where the takes and node_modules (hyperframes, gsap, @fontsource/inter) are, e.g. the GPU box:
//   node video/hyperframes/build.mjs --run pass5 [--workers 8] [--no-render] [--gpu]
// Output in video/out/NAME-hf/: project/ (the composition and its media), vibecad-tutorial-act1.mp4, render.log.
// The subtitles' timing comes from video/out/NAME/plan.json (made by edit.mjs), so run the edit pass first.

import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, symlinkSync, copyFileSync, readdirSync } from "node:fs";
import { join, basename, resolve } from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const run = arg("--run");
if (!run) { console.error("usage: node video/hyperframes/build.mjs --run NAME"); process.exit(1); }
const FPS = 60, W = 2560, H = 1440;
const ROOT = resolve(arg("--root", new URL("../..", import.meta.url).pathname));
const require = createRequire(join(resolve(arg("--deps", process.cwd())), "package.json"));
const takes = join(ROOT, "video", "takes", run);
const out = join(ROOT, "video", "out", `${run}-hf`), project = join(out, "project"), media = join(project, "media");
mkdirSync(media, { recursive: true });
const plan = JSON.parse(readFileSync(join(ROOT, "video", "out", run, "plan.json"), "utf8"));
const log = [];
const note = (s) => { console.log(s); log.push(s); };
const time = (label, f) => { const t0 = Date.now(); const r = f(); note(`${label}: ${((Date.now() - t0) / 1000).toFixed(1)} s`); return r; };

// ---- each act's take as a constant 60 fps source video: frame k shows the latest captured frame at or before k/60 s,
// as edit.mjs samples it (so a clip's data-media-start is the take's own clock) ----
function source(act) {
  const file = join(media, `act${act}.mp4`);
  if (existsSync(file)) return file;
  const dir = join(takes, `act${act}`);
  const timing = JSON.parse(readFileSync(join(dir, "timing.json"), "utf8"));
  const list = JSON.parse(readFileSync(join(dir, "frames.json"), "utf8")).filter((f) => f.t >= 0);
  const seq = join(out, `seq-act${act}`);
  rmSync(seq, { recursive: true, force: true });
  mkdirSync(seq);
  let fi = 0, k = 0;
  for (let t = 0; t < timing.duration; t += 1 / FPS, k++) {
    while (fi + 1 < list.length && list[fi + 1].t <= t) fi++;
    symlinkSync(join(dir, "frames", list[fi].file), join(seq, `${String(k).padStart(6, "0")}.jpg`));
  }
  // 4:4:4 at a low CRF, a keyframe a second: a mezzanine, re-encoded once more by the render
  time(`act ${act}: ${k} frames → act${act}.mp4`, () => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String(FPS), "-i", join(seq, "%06d.jpg"),
    "-c:v", "libx264", "-preset", "medium", "-crf", "12", "-pix_fmt", "yuv444p", "-g", String(FPS), "-movflags", "+faststart", file]));
  rmSync(seq, { recursive: true });
  return file;
}

// ---- the edit: the montage's picks into Act 3, then Act 1 whole (it has no sped-up or cut spans) ----
const clips = []; // { src, start, dur, from, rate }
const act1Take = plan.takes.findIndex((t) => t.dir.endsWith("/act1/frames"));
const montageFrames = plan.frames.findIndex((f) => f[0] === act1Take);
let at = 0;
if (montageFrames > 0) {
  const picks = JSON.parse(readFileSync(join(takes, "act3", "timing.json"), "utf8")).picks;
  const lenOf = (p) => (p.len ? Math.round(p.len * FPS) : Math.round(FPS / 3));
  const before = picks.slice(0, -1).reduce((a, p) => a + lenOf(p), 0);
  source(3);
  for (const [i, p] of picks.entries()) {
    // the last shot holds until the longest voice has said the montage's line: the edit's montage length says how long
    const len = i === picks.length - 1 ? montageFrames - before : lenOf(p);
    clips.push({ src: "media/act3.mp4", start: at, dur: len, from: p.t, rate: p.speed ?? 1, label: p.label });
    at += len;
  }
}
const act1 = JSON.parse(readFileSync(join(takes, "act1", "timing.json"), "utf8"));
if (act1.fast.length) throw new Error("act 1 has sped-up or cut spans now: this trial doesn't map them yet");
source(1);
const act1Frames = plan.frames.filter((f) => f[0] === act1Take).length;
clips.push({ src: "media/act1.mp4", start: at, dur: act1Frames, from: 0, rate: 1, label: "act 1" });
const total = at + act1Frames;
note(`cut: ${clips.length} clips, ${total} frames (${(total / FPS).toFixed(2)} s)`);

// ---- the subtitles, laid out as compositor.js draws them: Inter 600 44 px, wrapped greedily at 62 % of the width ----
const fonts = join(project, "fonts");
mkdirSync(fonts, { recursive: true });
for (const w of [600, 700]) copyFileSync(require.resolve(`@fontsource/inter/files/inter-latin-${w}-normal.woff2`), join(fonts, `inter-${w}.woff2`));
const inter = require("fontkit").openSync(join(fonts, "inter-600.woff2"));
const widthOf = (s) => (inter.layout(s).advanceWidth * 44) / inter.unitsPerEm;
function wrap(text, max) {
  const lines = [];
  let cur = "";
  for (const w of text.split(" ")) { const t = cur ? `${cur} ${w}` : w; if (widthOf(t) > max && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur);
  return lines;
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const captions = plan.captions.filter((c) => c.from < total).map((c) => ({ ...c, to: Math.min(c.to, total) }));
const s = (f) => (f / FPS).toFixed(4);

const gsapFile = "gsap.min.js";
copyFileSync(require.resolve("gsap/dist/gsap.min.js"), join(project, gsapFile));
// the default voice's mix, cut to the length of this cut
const voice = basename(plan.audio.file);
time(`audio: ${voice}`, () => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", join(ROOT, "video", "out", run, "vo", voice), "-t", s(total), join(media, voice)]));

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @font-face { font-family: Inter; font-weight: 600; src: url(fonts/inter-600.woff2) format("woff2"); }
  @font-face { font-family: Inter; font-weight: 700; src: url(fonts/inter-700.woff2) format("woff2"); }
  html, body { margin: 0; background: #000; }
  #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
  video.clip { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .cap { position: absolute; left: 50%; bottom: 55px; transform: translateX(-50%); z-index: 2; width: max-content;
    padding: 16px 22px 15px; border-radius: 14px; background: rgba(10, 11, 14, 0.78); color: #f5f6f8;
    font: 600 44px/58px Inter, sans-serif; text-align: center; white-space: nowrap; }
</style>
</head>
<body>
<div id="root" data-composition-id="root" data-start="0" data-duration="${s(total)}" data-width="${W}" data-height="${H}" data-fps="${FPS}">
${clips.map((c, i) => `  <video id="shot-${i}" class="clip" src="${c.src}" muted playsinline data-start="${s(c.start)}" data-duration="${s(c.dur)}" data-media-start="${c.from.toFixed(4)}"${c.rate !== 1 ? ` data-playback-rate="${c.rate}"` : ""} data-track-index="0"></video><!-- ${esc(c.label)} -->`).join("\n")}
${captions.map((c, i) => `  <div id="cap-${i}" class="cap clip" data-start="${s(c.from)}" data-duration="${s(c.to - c.from)}" data-track-index="1">${wrap(c.text, W * 0.62).map(esc).join("<br>")}</div>`).join("\n")}
  <audio id="voice" src="media/${voice}" data-start="0" data-duration="${s(total)}" data-track-index="2"></audio>
</div>
<script src="${gsapFile}"></script>
<script>
  // a subtitle fades in when it follows a gap (one straight after another just swaps)
  const tl = gsap.timeline({ paused: true });
  const caps = ${JSON.stringify(captions.map((c) => [c.from / FPS, c.to / FPS]))};
  caps.forEach(([a], i) => { if (i === 0 || a - caps[i - 1][1] > 0.05) tl.fromTo("#cap-" + i, { opacity: 0 }, { opacity: 1, duration: 0.15, ease: "power1.out" }, a); });
  tl.set({}, {}, ${s(total)});
  window.__timelines = window.__timelines || {};
  window.__timelines["root"] = tl;
</script>
</body>
</html>
`;
writeFileSync(join(project, "index.html"), html);
note(`composition: ${clips.length} video clips, ${captions.length} subtitles, 1 voice → ${join(project, "index.html")}`);

if (process.argv.includes("--no-render")) process.exit(0);

// ---- render ----
const raw = join(out, "render.mp4");
const hf = ["hyperframes", "render", project, "-o", raw, "--fps", String(FPS), "--quality", "delivery", "--video-frame-format", "png", "--workers", arg("--workers", "auto"), ...(process.argv.includes("--gpu") ? ["--gpu"] : [])];
note(`$ npx ${hf.join(" ")}`);
time("render", () => { const r = spawnSync("npx", hf, { stdio: "inherit" }); if (r.status) throw new Error(`hyperframes render exited ${r.status}`); });

// ---- every voice as its own audio track, and the chapters, as edit.mjs does after its render ----
const vo = JSON.parse(readFileSync(join(ROOT, "video", "out", run, "tracks.json"), "utf8")).streams.filter((x) => x.codec_type === "audio").map((x) => x.tags.handler_name);
const wavs = readdirSync(join(ROOT, "video", "out", run, "vo")).filter((f) => f.endsWith(".wav"));
// tracks.json lists the voices in their track order; match each title back to its mix by id (af_heart → "Heart")
const order = vo.map((title) => wavs.find((f) => title.toLowerCase().includes(` ${f.replace(/\.wav$/, "").split("_")[1]} `)) ?? null);
if (order.some((f) => !f)) throw new Error(`couldn't match every voice track to a mix: ${vo.filter((_, i) => !order[i]).join(", ")}`);
const durMs = Math.round((total / FPS) * 1000);
const chapters = readFileSync(join(ROOT, "video", "out", run, "chapters.ffmeta"), "utf8").split("[CHAPTER]").slice(1)
  .map((c) => Object.fromEntries(c.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])))
  .filter((c) => Number(c.START) < durMs).map((c) => ({ ...c, END: String(Math.min(Number(c.END), durMs)) }));
writeFileSync(join(out, "chapters.ffmeta"), `;FFMETADATA1\n${chapters.map((c) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${c.START}\nEND=${c.END}\ntitle=${c.title}\n`).join("")}`);
const final = join(out, "vibecad-tutorial-act1.mp4");
const ff = ["-hide_banner", "-loglevel", "error", "-y", "-i", raw, ...order.flatMap((f) => ["-t", s(total), "-i", join(ROOT, "video", "out", run, "vo", f)]), "-i", join(out, "chapters.ffmeta"),
  "-map", "0:v:0", ...order.flatMap((_, i) => ["-map", `${i + 1}:a:0`]), "-map_chapters", String(order.length + 1),
  "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-ac", "1",
  "-metadata:s:v:0", "handler_name=VibeCAD tutorial", ...vo.flatMap((t, i) => [`-metadata:s:a:${i}`, `title=${t}`, `-metadata:s:a:${i}`, `handler_name=${t}`, `-metadata:s:a:${i}`, "language=eng", `-disposition:a:${i}`, i === 0 ? "default" : "0"]),
  "-movflags", "+faststart", final];
time(`mux: ${order.length} voices, ${chapters.length} chapters`, () => execFileSync("ffmpeg", ff));
note(`→ ${final}`);
writeFileSync(join(out, "render.log"), log.join("\n") + "\n");
