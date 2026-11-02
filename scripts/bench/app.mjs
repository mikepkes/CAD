#!/usr/bin/env node
// Drives the in-page rebuild benchmark (scripts/bench/inpage.mjs) in the web app (Playwright,
// headed Chromium) or the desktop app (`tauri dev` against the same dev server), samples the
// target's memory from outside, and prints a table (plus JSON with --out).
//
//   npx vite --port 5190 &                                             # a dev server of this tree
//   node scripts/bench/app.mjs --target web   --url http://localhost:5190 [--pool 4] [--only walker,roubo] [--out web.json]
//   node scripts/bench/app.mjs --target tauri --url http://localhost:5190 [--pool 4] ...
//
// --pool N sets the geometry worker pool size (?pool=N; "default" leaves it to the host:
// one on the web, up to four in the desktop app). --repeats (7) distinct values per slider,
// --drag (6000) ms per sustained drag. Memory: the peak resident set of the process tree —
// Chromium's processes, or the desktop app plus the WebKit helper processes started after it.
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const target = opt("--target", "web");
const url = opt("--url", "http://localhost:5190");
const pool = opt("--pool", null);
const only = opt("--only", null)?.split(",");
const out = opt("--out", null);
const repeats = opt("--repeats", "7");
const dragMs = opt("--drag", "6000");
const port = Number(opt("--port", "4674"));

const dir = join(root, "public", "examples");
const queue = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort().filter((n) => !only || only.includes(n));
const rows = [];
let current = null;
let peak = new Map(); // example → peak RSS (kB)
let done;
const finished = new Promise((res) => { done = res; });

const server = createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") { res.end(); return; }
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (req.url === "/next") { current = queue.shift() ?? null; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ example: current })); return; }
    if (req.url === "/result") {
      const r = JSON.parse(body);
      r.peakRssMB = Math.round((peak.get(r.example) ?? 0) / 1024);
      rows.push(r);
      console.error(`${r.example}: first model ${r.firstModelMs} (kernel ${r.kernelReadyMs}) edit ${r.geom?.medianMs ?? "-"}/${r.geom?.p90Ms ?? "-"} (${r.geom?.name ?? ""}) pose ${r.pose?.medianMs ?? "-"}/${r.pose?.p90Ms ?? "-"} (${r.pose?.name ?? ""}) drag ${r.geomDrag?.perSecond ?? "-"}/s (lag ${r.geomDrag?.lagMs ?? "-"}) pose drag ${r.poseDrag?.perSecond ?? "-"}/s update ${r.updateMs ?? "-"} peak ${r.peakRssMB} MB`);
      res.end("ok"); return;
    }
    if (req.url === "/error") { console.error(`error: ${body}`); current = null; res.end("ok"); return; }
    if (req.url === "/done") { res.end("ok"); done(); return; }
    res.statusCode = 404; res.end();
  });
});
await new Promise((res) => server.listen(port, "127.0.0.1", res));

/** Every process: pid, ppid, rss (kB), start time (s since the epoch), command. */
function processes() {
  const text = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,lstart=,comm="], { encoding: "utf8", maxBuffer: 1 << 26 });
  return text.split("\n").filter(Boolean).map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/);
    return m ? { pid: +m[1], ppid: +m[2], rss: +m[3], start: Date.parse(m[4]) / 1000, comm: m[5] } : null;
  }).filter(Boolean);
}
/** The resident set of `pid`'s process tree (kB). */
function treeRss(pid, ps) {
  const kids = new Map();
  for (const p of ps) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)).push(p);
  let total = 0;
  const walk = (id) => { for (const c of kids.get(id) ?? []) { total += c.rss; walk(c.pid); } };
  const me = ps.find((p) => p.pid === pid);
  if (me) total += me.rss;
  walk(pid);
  return total;
}

let sampler = null;
function sample(rssOf) {
  sampler = setInterval(() => {
    try { const kb = rssOf(); if (current) peak.set(current, Math.max(peak.get(current) ?? 0, kb)); } catch { /* gone */ }
  }, 250);
}

const pageUrl = (example) => { const u = new URL(url); u.searchParams.set("bench", String(port)); u.searchParams.set("repeats", repeats); u.searchParams.set("drag", dragMs); if (pool) u.searchParams.set("pool", pool); if (example) u.searchParams.set("example", example); return u.toString(); };

let child = null;
let browser = null;
try {
  current = queue.shift() ?? null;
  if (!current) { console.error("nothing to run"); process.exit(1); }
  if (target === "web") {
    const { chromium } = createRequire(import.meta.url)("playwright");
    browser = await chromium.launch({ headless: false, args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    page.on("pageerror", (e) => console.error(`page error: ${e.message}`));
    // the browser process: the first Chromium started since the launch (its renderers and helpers are its children)
    const launchedAt = Date.now() / 1000 - 2;
    sample(() => { const ps = processes(); const roots = ps.filter((p) => /chrom/i.test(p.comm) && p.start > launchedAt).sort((a, b) => a.pid - b.pid); return roots.length ? treeRss(roots[0].pid, ps) : 0; });
    await page.goto(pageUrl(current), { waitUntil: "commit" });
  } else {
    // the desktop app, pointed at the dev server: its own window, WebKit's helper processes beside it
    const launchedAt = Date.now() / 1000 - 1;
    const config = JSON.stringify({ build: { devUrl: pageUrl(current), beforeDevCommand: "" } });
    child = spawn("npx", ["tauri", "dev", "--no-watch", "--config", config], { cwd: root, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, PATH: `${process.env.HOME}/.local/node/bin:${process.env.HOME}/.cargo/bin:${process.env.PATH}` } });
    const webkit = /WebKit|WebContent|GPU|Networking/;
    sample(() => {
      const ps = processes();
      return treeRss(child.pid, ps) + ps.filter((p) => webkit.test(p.comm) && p.start > launchedAt && !ps.some((a) => a.pid === p.ppid && a.comm.includes("Safari"))).reduce((a, p) => a + p.rss, 0);
    });
  }
  await Promise.race([finished, new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), 40 * 60 * 1000))]);
} finally {
  if (sampler) clearInterval(sampler);
  if (browser) await browser.close();
  if (child) {
    // the app binary is a grandchild (npx → cargo → app): end every process under the launcher, nothing else
    const ps = processes();
    const under = (pid) => ps.filter((p) => p.ppid === pid).flatMap((p) => [p.pid, ...under(p.pid)]);
    for (const pid of under(child.pid).reverse()) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
    child.kill("SIGTERM");
  }
  server.close();
}

const cols = ["example", "pool", "firstModelMs", "kernelReadyMs", "geomMedianMs", "geomP90Ms", "slider", "poseMedianMs", "poseP90Ms", "poseSlider", "geomDragPerS", "geomDragLagMs", "poseDragPerS", "updateMs", "peakRssMB", "bodies"];
const flat = rows.map((r) => ({ example: r.example, pool: r.pool, firstModelMs: r.firstModelMs, kernelReadyMs: r.kernelReadyMs, geomMedianMs: r.geom?.medianMs, geomP90Ms: r.geom?.p90Ms, slider: r.geom?.name, poseMedianMs: r.pose?.medianMs, poseP90Ms: r.pose?.p90Ms, poseSlider: r.pose?.name, geomDragPerS: r.geomDrag?.perSecond, geomDragLagMs: r.geomDrag?.lagMs, poseDragPerS: r.poseDrag?.perSecond, updateMs: r.updateMs, peakRssMB: r.peakRssMB, bodies: r.bodies, target, cores: r.cores, ua: r.ua }));
console.log(`| ${cols.join(" | ")} |`);
console.log(`|${cols.map(() => "---").join("|")}|`);
for (const r of flat) console.log(`| ${cols.map((c) => r[c] ?? "").join(" | ")} |`);
if (out) writeFileSync(out, JSON.stringify(flat, null, 2));
process.exit(0);
