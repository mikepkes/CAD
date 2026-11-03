// Folding validation videos: short silent clips of paper models folding in the app, step by step, with a
// caption per step, for checking that a model folds the way it should. No narration (unlike record.mjs).
//
//   node video/folding.mjs [--scenes crane,masu,popup-box,popup-card,reverse-fold][--url http://127.0.0.1:5199] [--run NAME]
//                          [--gl egl|swiftshader] [--headed] [--no-encode] [--encode-only]
//
// Needs the dev server (`npx vite --port 5199 --host 127.0.0.1`). Each scene opens the example in customize mode
// with the demo layer (`?mode=customize&example=<name>&demo`), frames it, then drives its slider:
//   - "pose" scenes (a sheet folded in steps: the crane, the masu box) sweep the parameter with the demo layer's
//     poseSweep, which re-poses the sheet from its fold plan every frame (no rebuild), so the fold plays at the
//     screen's rate;
//   - "rebuild" scenes (a pop-up card, whose folds follow `open` through expressions, not a fold plan) set the
//     parameter through the store a few degrees at a time and wait for each rebuild, so the model updates only as
//     fast as it rebuilds (the take's timing.json records the rate reached).
// Frames come from a CDP screencast (as in lib/director.mjs: JPEGs with paint timestamps) into
// video/takes/folding/<run>/<scene>/; stills (full-resolution PNGs) at the steps a scene lists go to
// video/out/<scene>/stills/ (--out to change), and the MP4 (H.264, 1920×1080 at 60 fps, played at the capture's
// real timing from an ffconcat list of per-frame durations, kept under 19 MB) to video/out/<scene>/<scene>.mp4,
// with a summary.json beside it (size, frame counts, the captured frame rate, a rebuild scene's update rate).
//
// Headless Chromium draws WebGL in software (SwiftShader, ~8 fps here); `--gl egl` (the default) uses the GPU
// through ANGLE's EGL backend, which runs headless on a Linux box with an NVIDIA driver at a steady 60 fps.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEW = { width: 1440, height: 810, scale: 2560 / 1440 }; // 2560×1440 capture
const MAX_BYTES = 19 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `steps` captions for a parameter that counts fold steps (0 = flat): move k goes from k−1 to k. */
const stepMoves = (names, ms) => names.map((title, i) => ({ title, sub: `Step ${i + 1} of ${names.length}`, from: i, to: i + 1, ms }));

/** The scenes. `moves` run in order (a caption each, the parameter swept `from` → `to` over `ms`); `stills` are the
 *  move indices after which a still is taken (-1: before the first move); one is always taken at the end. */
export const SCENES = {
  crane: {
    example: "crane", title: "Paper crane", intro: "Folded from a square, step by step", param: "fold", mode: "pose",
    moves: stepMoves(["Square base", "Petal fold", "Turn over", "Petal fold behind", "Narrow the legs", "Turn over",
      "Narrow behind", "Inside reverse folds: neck and tail", "The head", "Wings down", "Stand up"], 3000),
    stills: [-1, 0, 1, 3, 4, 7, 8, 9],
  },
  masu: {
    example: "masu", title: "Masu box", intro: "Folded from a square, step by step", param: "fold", mode: "pose",
    moves: stepMoves(["Corners to the centre", "Edges to the centre", "Stand up the sides", "Raise the ends",
      "Press the corners in"], 3000),
    stills: [-1, 0, 1, 2, 3],
  },
  "popup-box": {
    example: "popup-box", title: "Pop-up box card", intro: "One open slider, 0° to 180°", param: "open", mode: "rebuild",
    stepDeg: 1, follow: false, margin: 1.1, dir: [1.1, -1.5, 1.1], panel: true,
    moves: [
      // closed is 1°, not 0°: at 0° the two halves coincide and z-fight
      { title: "Opening", from: 1, to: 45, ms: 3000 }, { title: "Opening", from: 45, to: 90, ms: 3000 },
      { title: "Opening", from: 90, to: 135, ms: 3000 }, { title: "Opening", from: 135, to: 180, ms: 3000 },
      { title: "Closing", from: 180, to: 90, ms: 6000 }, { title: "Closing", from: 90, to: 1, ms: 6000 },
      { title: "Half open", sub: "90°", from: 1, to: 90, ms: 6000 },
    ],
    stills: [-1, 0, 1, 2, 3, 4, 5],
  },
  "popup-card": {
    example: "popup-card", title: "Pop-up greeting card", intro: "One open slider, 0° to 180°", param: "open", mode: "rebuild",
    // a still camera on the inside of the card (it rebuilds at ~6/s, so the take runs ~90 s: a turntable would
    // carry the camera round behind the card)
    stepDeg: 1, follow: false, margin: 1.1, dir: [-1.4, -0.9, 1.0], panel: true, spin: 0,
    moves: [
      ...[[1, 45], [45, 90], [90, 135], [135, 180]].map(([from, to]) => ({ title: "Opening", sub: "A figure rises on its box, a step within a step, a box at the foot", from, to, ms: 3500 })),
      ...[[180, 90], [90, 1]].map(([from, to]) => ({ title: "Closing", sub: "It all folds flat inside", from, to, ms: 6000 })),
      { title: "Half open", sub: "90°", from: 1, to: 90, ms: 6000 },
    ],
    stills: [-1, 0, 1, 3, 4, 5],
  },
  // a close-up of the crane's step 8 (and 9): the camera frames what moves (`focus`: the box of the sheet's
  // vertices that travel more than `mm` from `from` to `to`, by the fold plan; here the point that becomes the neck,
  // nearer the camera, which the head then folds on) and stays close at the end
  "reverse-fold": {
    example: "crane", title: "Inside reverse fold", intro: "The crane's neck and tail, close up", param: "fold", mode: "pose",
    focus: { from: 7, to: 8, mm: 10, side: ["y", -1] }, margin: 0.65, dir: [-0.6, -1.5, 0.8], holdMs: 2000, close: true, spin: 0, endSpin: 8,
    moves: [
      { title: "Inside reverse fold", sub: "The point folds back on itself through every layer and tucks between the body's layers", from: 7, to: 8, ms: 8000, stillsAt: [0.35, 0.6] },
      { title: "The head", sub: "The same fold, smaller", from: 8, to: 9, ms: 5000, stillsAt: [0.5] },
    ],
    stills: [-1, 0, 1],
  },
};

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);
const names = (arg("--scenes") ?? Object.keys(SCENES).join(",")).split(",");
const base = arg("--url", process.env.VIDEO_URL ?? "http://127.0.0.1:5199").replace(/\/$/, "");
const run = arg("--run", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
const takesRoot = join(HERE, "takes", "folding", run);
const outRoot = arg("--out", join(HERE, "out"));
const GL = { egl: ["--use-gl=angle", "--use-angle=gl-egl", "--ignore-gpu-blocklist"], swiftshader: [] }[arg("--gl", "egl")];

const urlOf = (sc) => `${base}/?mode=customize&example=${encodeURIComponent(sc.example)}&demo`;

async function openPage(browser, sc) {
  const context = await browser.newContext({ viewport: { width: VIEW.width, height: VIEW.height }, deviceScaleFactor: VIEW.scale, colorScheme: "dark" });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => { problems.push(`page error: ${e.message}`); console.error("  [page error]", e.message); });
  page.on("console", (m) => { if (m.type() === "error") { problems.push(`console: ${m.text().slice(0, 300)}`); console.error("  [console]", m.text().slice(0, 300)); } });
  await page.goto(urlOf(sc));
  await page.waitForFunction(() => !!window.__vibecadDemo, null, { timeout: 60000 });
  await page.waitForFunction(() => Object.values(window.__vibecadDemo.store.getState().solids).some((s) => s.mesh), null, { timeout: 180000 });
  await demo(page, "settle", 400, 60000, true);
  return { context, page, problems };
}
const demo = (page, name, ...args) => page.evaluate(([n, a]) => window.__vibecadDemo[n](...a), [name, args]);
/** Set a parameter as the slider would (a rebuild) and wait for it. */
const setParam = (page, name, value) => page.evaluate(async ([n, v]) => {
  const d = window.__vibecadDemo;
  await d.store.getState().setParameterExpr(n, String(v));
  await d.settle(0, 60000, false);
}, [name, value]);
/** The box of a folded sheet's vertices that travel more than `mm` while `name` goes `from` → `to` (the poses the
 *  demo layer's poseSweep draws, from each sheet's fold plan), or null if none does; with `side` ([axis, ±1]),
 *  only those that end up on that side of the axis's zero (one of two points that swing apart). */
const movingBox = (page, { param: name, from, to, mm = 10, side = null }) => page.evaluate(async ([name, from, to, mm, side]) => {
  const [{ sequenceAngles, sequenceMesh }, { resolveParameters }, { compileExpr }] = await Promise.all([
    import("/src/core/sheetSequence.ts"), import("/src/core/parameters.ts"), import("/src/math/expr.ts")]);
  const st = window.__vibecadDemo.store.getState(), doc = st.session.doc;
  const values = Array.from({ length: 13 }, (_, i) => from + ((to - from) * i) / 12);
  const meshes = values.map((v) => {
    const scope = resolveParameters(doc.parameters.map((q) => (q.name === name ? { ...q, expr: String(v) } : q))).scope;
    return Object.values(st.solids).flatMap((sol) => {
      const f = doc.features[sol.featureId], seq = sol.sheet?.sequence;
      if (f?.kind !== "sheet" || !f.progressExpr || !seq) return [];
      return [sequenceMesh(seq.plan, sequenceAngles(seq.plan, compileExpr(f.progressExpr).eval(scope)), seq.frame).positions];
    });
  });
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let b = 0; b < meshes[0].length; b++) {
    const ps = meshes.map((m) => m[b]);
    if (ps.some((p) => p.length !== ps[0].length)) return null;
    for (let i = 0; i < ps[0].length; i += 3) {
      const far = Math.max(...ps.map((p) => Math.hypot(p[i] - ps[0][i], p[i + 1] - ps[0][i + 1], p[i + 2] - ps[0][i + 2])));
      if (far < mm || (side && ps.at(-1)[i + "xyz".indexOf(side[0])] * side[1] < 2)) continue;
      for (const p of ps) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[i + a]); hi[a] = Math.max(hi[a], p[i + a]); }
    }
  }
  return lo[0] <= hi[0] ? { min: { x: lo[0], y: lo[1], z: lo[2] }, max: { x: hi[0], y: hi[1], z: hi[2] } } : null;
}, [name, from, to, mm, side]);
const union = (boxes) => boxes.flat().reduce((a, b) => ({
  min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y), z: Math.min(a.min.z, b.min.z) },
  max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y), z: Math.max(a.max.z, b.max.z) },
}));

async function shoot(browser, key) {
  const sc = SCENES[key];
  if (!sc) throw new Error(`no scene ${key} (have ${Object.keys(SCENES).join(", ")})`);
  const takeDir = join(takesRoot, key), outDir = join(outRoot, key), stillDir = join(outDir, "stills");
  rmSync(stillDir, { recursive: true, force: true });
  rmSync(takeDir, { recursive: true, force: true });
  mkdirSync(join(takeDir, "frames"), { recursive: true });
  mkdirSync(stillDir, { recursive: true });
  console.log(`${key}: ${urlOf(sc)}`);
  const { context, page, problems } = await openPage(browser, sc);
  const timing = { scene: key, url: urlOf(sc), view: VIEW, captions: [], stills: [], moves: [], notes: [] };

  // ---- set up, off camera: the panel, the framing (every pose the scene passes through), the starting pose ----
  await demo(page, "cursor", false);
  if (!sc.panel) { await page.click(".cz-handle").catch(() => timing.notes.push("no panel handle")); await sleep(300); }
  const built = await page.evaluate((n) => window.__vibecadDemo.store.getState().session.doc.parameters.find((p) => p.name === n)?.value, sc.param);
  // the bounds at every value a move starts or ends at (a rebuild each): the camera frames each move's start and
  // end poses together, so the paper fills the picture as it shrinks (unless `follow: false`: all of them at once)
  const values = [...new Set(sc.moves.flatMap((m) => [m.from, m.to]))];
  const boxAt = {};
  for (const v of values) { await setParam(page, sc.param, v); boxAt[v] = union(await demo(page, "bounds")); }
  const all = union(Object.values(boxAt));
  const first = sc.moves[0].from;
  let focus = null;
  if (sc.mode === "pose") {
    await setParam(page, sc.param, built); // the built model is the finished one; the sweeps pose it
    if (sc.focus) focus = await movingBox(page, { param: sc.param, ...sc.focus });
    if (sc.focus && !focus) timing.notes.push("focus: nothing moves; framing the model");
    if (focus) timing.focus = focus;
    await demo(page, "poseSweep", sc.param, first, first, 1);
  } else await setParam(page, sc.param, first);
  const boxOf = (m) => focus ?? (sc.follow === false ? all : union([boxAt[m.from], boxAt[m.to]]));
  const dir = sc.dir ?? [1, -1.4, 1.1];
  const margin = sc.margin ?? 1.05; // the box's bounding sphere: less crops a long part seen close up in perspective
  await demo(page, "aim", { dir, box: boxOf(sc.moves[0]), ms: 400, margin });
  await demo(page, "settle", 300, 20000, true);

  // ---- the take ----
  const cdp = await context.newCDPSession(page);
  const frames = [], pending = new Set();
  const t0 = Date.now() / 1000;
  const now = () => Date.now() / 1000 - t0;
  let n = 0;
  cdp.on("Page.screencastFrame", (f) => {
    const file = `${String(n++).padStart(6, "0")}.jpg`;
    frames.push({ t: f.metadata.timestamp - t0, file });
    const p = writeFile(join(takeDir, "frames", file), Buffer.from(f.data, "base64")).finally(() => pending.delete(p));
    pending.add(p);
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  // a real reload (not the link following the controls: history.replaceState is a same-document navigation)
  page.on("load", () => { timing.notes.push(`page reloaded at ${now().toFixed(1)} s: re-shoot`); console.error("  ✗ page reloaded during the take"); });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: 2560, maxHeight: 1440, everyNthFrame: 1 });
  const caption = async (title, sub) => { timing.captions.push({ t: +now().toFixed(3), title, sub: sub ?? null }); await demo(page, "lowerThird", title ? { title, sub } : null); };
  let stillN = 0;
  const still = async (label) => {
    const file = `${String(++stillN).padStart(2, "0")}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.png`;
    await page.screenshot({ path: join(stillDir, file) });
    timing.stills.push({ t: +now().toFixed(3), file });
  };
  /** Hold `ms` (a still taken meanwhile counts towards it). */
  const hold = async (ms, label) => { const s = Date.now(); if (label) { await sleep(Math.min(ms, 350)); await still(label); } await sleep(Math.max(0, ms - (Date.now() - s))); };
  /** The camera's current direction (towards it from the target), so a re-aim keeps the turntable's heading. */
  const camDir = async () => { const p = await demo(page, "cameraPose"); return p ? [-p.direction.x, -p.direction.y, -p.direction.z] : dir; };

  try {
    await caption(sc.title, sc.intro);
    await demo(page, "turntable", sc.spin ?? 4);
    await hold(2500, sc.stills.includes(-1) ? "start" : null);
    for (const [i, m] of sc.moves.entries()) {
      const prev = sc.moves[i - 1];
      if (!prev || prev.title !== m.title || prev.sub !== m.sub) await caption(m.title, m.sub);
      // read the caption before the paper moves (meanwhile the camera moves to frame this move)
      if (sc.follow !== false && i > 0) await demo(page, "aim", { dir: await camDir(), box: boxOf(m), ms: 700, margin });
      else if (!prev || prev.title !== m.title) await sleep(500);
      const start = now();
      let rate = null;
      if (sc.mode === "pose") {
        // stills on the way (`stillsAt`: fractions of the move's time) while the sweep runs in the page
        const sweep = demo(page, "poseSweep", sc.param, m.from, m.to, m.ms);
        for (const f of m.stillsAt ?? []) { await sleep(Math.max(0, start + (f * m.ms) / 1000 - now()) * 1000); await still(`${m.title}-${Math.round(f * 100)}pc`); }
        await sweep;
      } else {
        // a rebuild per step, paced to take `ms` at the least; the in-page loop saves a round trip per step
        rate = await page.evaluate(async ([name, from, to, stepDeg, ms]) => {
          const d = window.__vibecadDemo, n = Math.max(1, Math.round(Math.abs(to - from) / stepDeg)), each = ms / n, times = [];
          for (let k = 1; k <= n; k++) {
            const s = performance.now();
            await d.store.getState().setParameterExpr(name, String(Math.round((from + ((to - from) * k) / n) * 100) / 100));
            await d.settle(0, 60000, false);
            const took = performance.now() - s;
            times.push(took);
            if (took < each) await new Promise((r) => setTimeout(r, each - took));
          }
          return { steps: n, meanRebuildMs: Math.round(times.reduce((a, b) => a + b, 0) / n), maxRebuildMs: Math.round(Math.max(...times)) };
        }, [sc.param, m.from, m.to, sc.stepDeg ?? 2, m.ms]);
      }
      const took = now() - start;
      timing.moves.push({ ...m, start: +start.toFixed(3), seconds: +took.toFixed(3), ...(rate ? { ...rate, updatesPerSec: +(rate.steps / took).toFixed(2) } : {}) });
      console.log(`  ${m.title}${m.sub ? ` (${m.sub})` : ""}: ${m.from} → ${m.to} in ${took.toFixed(1)} s${rate ? `, ${rate.steps} rebuilds, ${(rate.steps / took).toFixed(1)}/s (mean ${rate.meanRebuildMs} ms)` : ""}`);
      await hold(sc.holdMs ?? 700, sc.stills.includes(i) ? `${m.title}-${m.to}` : null);
    }
    if (sc.close) {
      // a close-up stays close: the last pose and its caption, a slow turn
      await demo(page, "turntable", sc.endSpin ?? 8);
      await hold(6000, "end");
    } else {
      // the finished model: the built one (a pose scene's last pose is its built shape), framed by its silhouette
      await caption(sc.finished ?? sc.title, sc.finishedSub ?? "Finished");
      if (sc.mode === "pose") await demo(page, "poseEnd");
      await demo(page, "aim", { dir: await camDir(), frame: [0.12, 0.1, sc.panel ? 0.7 : 0.88, 0.82], ms: 1500 });
      await demo(page, "turntable", sc.endSpin ?? 24);
      await hold(5000, "finished");
    }
    await demo(page, "turntable", null);
    await sleep(1200);
  } catch (e) {
    timing.notes.push(`stopped: ${e.message}`);
    console.error(`  ✗ ${key}: ${e.message}`);
  }
  timing.duration = +now().toFixed(3);
  await cdp.send("Page.stopScreencast");
  await Promise.all(pending);
  timing.problems = problems;
  writeFileSync(join(takeDir, "frames.json"), JSON.stringify(frames));
  writeFileSync(join(takeDir, "timing.json"), JSON.stringify(timing, null, 1));
  await context.close();
  const span = frames.length > 1 ? frames.at(-1).t - frames[0].t : 0;
  console.log(`  ${frames.length} frames over ${timing.duration.toFixed(1)} s (${span ? ((frames.length - 1) / span).toFixed(1) : 0} fps captured), ${stillN} stills${timing.notes.length ? `; notes: ${timing.notes.join("; ")}` : ""}`);
  return takeDir;
}

/** The take's frames, each held until the next one was painted (the last until the take ended), as an ffconcat
 *  list; encoded to H.264 at 60 fps, 1080p, raising crf (then dropping to 720p) until it fits under 19 MB. */
function encode(key, takeDir) {
  const frames = JSON.parse(readFileSync(join(takeDir, "frames.json"), "utf8"));
  const timing = JSON.parse(readFileSync(join(takeDir, "timing.json"), "utf8"));
  if (!frames.length) { console.error(`  ✗ ${key}: no frames`); return null; }
  const lines = ["ffconcat version 1.0"];
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : Math.max(timing.duration, f.t + 1 / 60);
    lines.push(`file 'frames/${f.file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(6)}`);
  });
  lines.push(`file 'frames/${frames.at(-1).file}'`); // the concat demuxer drops the last entry's duration without this
  writeFileSync(join(takeDir, "frames.ffconcat"), lines.join("\n") + "\n");
  const outDir = join(outRoot, key), out = join(outDir, `${key}.mp4`);
  mkdirSync(outDir, { recursive: true });
  for (const [w, h, crf] of [[1920, 1080, 23], [1920, 1080, 26], [1920, 1080, 29], [1280, 720, 26], [1280, 720, 30]]) {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(takeDir, "frames.ffconcat"),
      "-vf", `scale=${w}:${h}:flags=lanczos,format=yuv420p`, "-fps_mode", "cfr", "-r", "60", "-c:v", "libx264", "-preset", "medium", "-crf", String(crf),
      "-movflags", "+faststart", out], { stdio: "inherit" });
    if (r.status !== 0) { console.error(`  ✗ ffmpeg failed (${r.status})`); return null; }
    const bytes = statSync(out).size;
    const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets,r_frame_rate:format=duration", "-of", "json", out], { encoding: "utf8" });
    const info = JSON.parse(probe.stdout || "{}");
    const span = frames.length > 1 ? frames.at(-1).t - frames[0].t : 0;
    const summary = { file: out, width: w, height: h, crf, bytes, mb: +(bytes / 1048576).toFixed(2), duration: +Number(info.format?.duration ?? 0).toFixed(2),
      outFrames: Number(info.streams?.[0]?.nb_read_packets ?? 0), capturedFrames: frames.length, capturedFps: span ? +((frames.length - 1) / span).toFixed(1) : 0,
      takeSeconds: timing.duration, stills: timing.stills.length, moves: timing.moves, notes: timing.notes, problems: timing.problems };
    console.log(`  ${key}.mp4: ${w}×${h} crf ${crf}, ${summary.mb} MB, ${summary.duration} s, ${summary.outFrames} frames out, ${frames.length} captured (${summary.capturedFps} fps)`);
    if (bytes <= MAX_BYTES) { writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 1)); return summary; }
  }
  console.error(`  ✗ ${key}.mp4 is still over 19 MB`);
  return null;
}

// ---- main ----
if (flag("--encode-only")) {
  for (const key of names) encode(key, join(takesRoot, key));
} else {
  const browser = await chromium.launch({ headless: !flag("--headed"), args: ["--hide-scrollbars", "--disable-features=Translate", "--force-color-profile=srgb", ...GL] });
  // warm up: the dev server pre-bundles dependencies on first use and reloads the page when it does, which must
  // not happen inside a take — load each scene once first
  for (const key of names) { const { context } = await openPage(browser, SCENES[key]); await context.close(); }
  console.log("warmed up");
  const takes = [];
  for (const key of names) takes.push([key, await shoot(browser, key)]);
  await browser.close();
  if (!flag("--no-encode")) for (const [key, dir] of takes) encode(key, dir);
}
if (existsSync(takesRoot)) console.log(`takes in ${takesRoot}; videos in ${outRoot}`);
