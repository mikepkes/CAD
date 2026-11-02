// A contact sheet of a cut, for review: `node video/sheet.mjs --run NAME [--video demo|tutorial] [--at 0:05,1:30,...] [--every 20] [--prefix sheet]`.
// Composites the chosen output frames exactly as the encoder does (chyrons, subtitles) → video/out/NAME/VIDEO/sheet-*.png
// (the tutorial unless --video says otherwise).
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const run = arg("--run");
const videoId = arg("--video", "tutorial");
const prefix = arg("--prefix", "sheet");
const ROOT = new URL("..", import.meta.url).pathname;
const plan = JSON.parse(readFileSync(join(ROOT, "video", "out", run, videoId, "plan.json"), "utf8"));
const secs = arg("--at") ? arg("--at").split(",").map((t) => t.split(":").reduce((a, v) => a * 60 + Number(v), 0))
  : Array.from({ length: Math.ceil(plan.frames.length / plan.fps / Number(arg("--every", 20))) }, (_, i) => i * Number(arg("--every", 20)) + 3);
const indices = secs.map((s) => Math.round(s * plan.fps));
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".jpg": "image/jpeg" };
const server = createServer((req, res) => {
  const file = join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
  res.setHeader("content-type", types[extname(file)] ?? "application/octet-stream");
  createReadStream(file).pipe(res);
}).listen(0);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://localhost:${server.address().port}/video/compositor/index.html?plan=/video/out/${run}/${videoId}/plan.json`);
for (let k = 0; k < indices.length; k += 12) {
  const url = await page.evaluate((ix) => window.sheet(ix), indices.slice(k, k + 12));
  const file = join(ROOT, "video", "out", run, videoId, `${prefix}-${String(k / 12 + 1).padStart(2, "0")}.png`);
  writeFileSync(file, Buffer.from(url.split(",")[1], "base64"));
  console.log(file);
}
await browser.close(); server.close();
