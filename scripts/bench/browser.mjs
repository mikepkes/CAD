#!/usr/bin/env node
// In-browser benchmark (Playwright, headed Chromium so WebGL is real): for each
// bundled example, the time to the first model on load, the cost of a store
// update (the viewport rebuilding its scene), frame time and draw calls while
// orbiting, frames drawn per second while idle, and the rebuild after one slider
// edit (a geometry slider and a joint-drive one).
//
//   node scripts/bench/browser.mjs [--url http://localhost:5186/] [--only gimbal,roubo] [--out browser.json]
//
// The example is loaded the way the app loads a document on start: from the
// autosave slot in localStorage.
import { chromium } from "/Users/mike/git/CAD/node_modules/playwright/index.mjs";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const url = opt("--url", "http://localhost:5186/");
const only = opt("--only", null)?.split(",");
const out = opt("--out", null);
const repeats = Number(opt("--repeats", "3"));

const dir = join(root, "public", "examples");
const examples = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().filter((f) => !only || only.includes(f.replace(/\.json$/, "")));

/** Runs in the page: wait until the store says the model is built (solids with meshes, no build in flight). */
const waitBuilt = async (page, timeout = 300000) => {
  await page.waitForFunction(() => {
    const s = window.__vibecad?.getState();
    return !!s && s.kernelReady && !s.build && Object.values(s.solids).some((b) => b.mesh);
  }, null, { timeout, polling: 20 });
};

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

async function benchExample(browser, file) {
  const text = readFileSync(join(dir, file), "utf8");
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript((doc) => { try { localStorage.setItem("vibecad.autosave.v1", doc); } catch { /* ignore */ } }, text);
  await page.goto(url, { waitUntil: "commit" });
  await page.waitForFunction(() => !!window.__vibecad?.getState().kernelReady, null, { timeout: 300000, polling: 20 });
  const kernelReadyMs = await page.evaluate(() => performance.now());
  await waitBuilt(page);
  const load = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const paint = performance.getEntriesByName("first-contentful-paint")[0];
    return { firstModelMs: performance.now(), fcpMs: paint?.startTime ?? null, domInteractiveMs: nav?.domInteractive ?? null };
  });
  // frame it so orbiting draws the whole model
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("vibecad:frame")));
  await page.waitForTimeout(700);

  // a store update that changes nothing: the viewport still rebuilds its view from the store
  const update = await page.evaluate((n) => {
    const st = window.__vibecad;
    const times = [];
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      st.setState({ rev: st.getState().rev + 1 });
      times.push(performance.now() - t);
    }
    return times;
  }, 5);

  // orbit: rotate the camera about Z over ~90 frames, timing each rAF and the CPU time inside renderer.render
  const orbit = await page.evaluate(() => new Promise((resolve) => {
    const scene = window.__scene;
    const cam = scene.camera, ctl = scene.controls;
    const r = Math.hypot(cam.position.x - ctl.target.x, cam.position.y - ctl.target.y);
    const z = cam.position.z, a0 = Math.atan2(cam.position.y - ctl.target.y, cam.position.x - ctl.target.x);
    const times = [], renders = []; let last = performance.now(), i = 0; let calls = 0, tris = 0, programs = 0;
    const renderer = scene.renderer, origRender = renderer.render.bind(renderer);
    renderer.render = (...args) => { const t = performance.now(); origRender(...args); renders.push(performance.now() - t); };
    const step = () => {
      const a = a0 + (i / 90) * Math.PI;
      cam.position.set(ctl.target.x + r * Math.cos(a), ctl.target.y + r * Math.sin(a), z);
      cam.lookAt(ctl.target);
      const now = performance.now(); times.push(now - last); last = now;
      const info = scene.renderer.info; calls = info.render.calls; tris = info.render.triangles; programs = info.programs?.length ?? 0;
      if (++i < 90) requestAnimationFrame(step); else { renderer.render = origRender; resolve({ times: times.slice(5), renders: renders.slice(5), calls, triangles: tris, programs }); }
    };
    requestAnimationFrame(step);
  }));

  // idle: frames the renderer draws in a second with nothing changing
  await page.waitForTimeout(500);
  const idleFrames = await page.evaluate(() => new Promise((resolve) => {
    const info = window.__scene.renderer.info;
    const f0 = info.render.frame;
    setTimeout(() => resolve(info.render.frame - f0), 1000);
  }));

  // slider edits, as the parameters panel does them
  const sliders = await page.evaluate((n) => {
    const doc = window.__vibecad.getState().session.doc;
    const geomText = JSON.stringify([doc.features, doc.sketches, doc.planes]);
    const jointText = JSON.stringify([doc.joints, doc.jointTemplates ?? {}]);
    const reads = (text, p) => new RegExp(`\\b${p.name}\\b`).test(text);
    const bounded = (p) => p.min != null && p.max != null;
    const pick = (ps) => ps.find(bounded) ?? ps[0];
    const sweep = (p) => {
      const v = Number(p.value), values = [];
      for (let i = 0; i < n; i++) {
        const f = 0.15 + (0.7 * i) / Math.max(1, n - 1);
        const next = bounded(p) ? p.min + (p.max - p.min) * f : v * (1.1 + 0.1 * i) + 0.5 * (i + 1);
        values.push(String(Math.round(next * 1000) / 1000));
      }
      return { name: p.name, values: values.filter((x) => Number(x) !== v), original: p.expr };
    };
    const g = pick(doc.parameters.filter((p) => reads(geomText, p) && !reads(jointText, p))) ?? pick(doc.parameters.filter((p) => reads(geomText, p)));
    const j = pick(doc.parameters.filter((p) => reads(jointText, p) && !reads(geomText, p))) ?? pick(doc.parameters.filter((p) => reads(jointText, p)));
    return { geom: g ? sweep(g) : null, pose: j ? sweep(j) : null };
  }, repeats);
  const edit = async (slider) => {
    if (!slider) return null;
    const times = [];
    for (const v of [...slider.values, slider.original]) {
      const t = await page.evaluate(async ([name, expr]) => {
        const st = window.__vibecad.getState();
        const solids0 = st.solids;
        const t0 = performance.now();
        await st.setParameterExpr(name, expr);
        // the rebuild is coalesced and async: it is done once new solids landed and no build is in flight
        await new Promise((res) => {
          const tick = () => { const s = window.__vibecad.getState(); if (!s.build && s.solids !== solids0) res(); else setTimeout(tick, 2); };
          setTimeout(tick, 2);
        });
        return performance.now() - t0;
      }, [slider.name, v]);
      if (v !== slider.original) times.push(t);
    }
    return { name: slider.name, ms: r1(median(times)) };
  };
  const geomEdit = await edit(sliders.geom);
  const poseEdit = await edit(sliders.pose);

  const bodies = await page.evaluate(() => Object.values(window.__vibecad.getState().solids).filter((b) => b.mesh).length);
  await context.close();
  return {
    example: file.replace(/\.json$/, ""),
    firstModelMs: r1(load.firstModelMs), kernelReadyMs: r1(kernelReadyMs), fcpMs: r1(load.fcpMs),
    updateMs: r1(median(update)),
    frameMs: r1(median(orbit.times)), frameP95Ms: r1([...orbit.times].sort((a, b) => a - b)[Math.floor(orbit.times.length * 0.95)]),
    renderMs: orbit.renders.length ? Math.round(median(orbit.renders) * 100) / 100 : null,
    drawCalls: orbit.calls, triangles: orbit.triangles, programs: orbit.programs, idleFps: idleFrames,
    editMs: geomEdit?.ms ?? null, slider: geomEdit?.name ?? null, poseMs: poseEdit?.ms ?? null, poseSlider: poseEdit?.name ?? null,
    bodies,
  };
}

const browser = await chromium.launch({ headless: false, args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
const rows = [];
try {
  for (const f of examples) {
    try {
      const row = await benchExample(browser, f);
      rows.push(row);
      console.error(`${row.example}: first model ${row.firstModelMs} (kernel ${row.kernelReadyMs}, fcp ${row.fcpMs}) update ${row.updateMs} frame ${row.frameMs} (p95 ${row.frameP95Ms}, render ${row.renderMs}) calls ${row.drawCalls} programs ${row.programs} idle ${row.idleFps} fps edit ${row.editMs} (${row.slider}) pose ${row.poseMs} (${row.poseSlider})`);
    } catch (e) {
      console.error(`${f}: ${e.message}`);
      rows.push({ example: f.replace(/\.json$/, ""), error: String(e.message).slice(0, 200) });
    }
  }
} finally {
  await browser.close();
}
const cols = ["example", "firstModelMs", "kernelReadyMs", "fcpMs", "updateMs", "frameMs", "renderMs", "drawCalls", "programs", "idleFps", "editMs", "slider", "poseMs", "poseSlider", "bodies"];
console.log(`| ${cols.join(" | ")} |`);
console.log(`|${cols.map(() => "---").join("|")}|`);
for (const r of rows) console.log(`| ${cols.map((c) => r[c] ?? "").join(" | ")} |`);
if (out) writeFileSync(out, JSON.stringify(rows, null, 2));
