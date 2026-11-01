// `node video/checks/pinJitter.mjs` (dev server on :5173): drag a new box's face number as the tutorial does and
// track its feature pin on screen every frame. The pin should glide with the box, never jump between faces.
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
await page.goto("http://localhost:5173/?demo");
await page.waitForFunction(() => window.__vibecadDemo, null, { timeout: 60000 });
await page.evaluate(async () => { const D = window.__vibecadDemo; await D.newDocument(); D.view("iso"); await new Promise((r) => setTimeout(r, 900)); });
await page.mouse.move(820, 420); await page.keyboard.press("b"); await page.waitForTimeout(800); await page.keyboard.press("Escape");
// the box's +X face, then drag its number in the face card
const b = await page.evaluate(() => window.__vibecadDemo.bounds()[0]);
const s = await page.evaluate((p) => window.__vibecadDemo.worldToScreen(p), { x: b.max.x, y: b.min.y + 0.42 * (b.max.y - b.min.y), z: b.min.z + 0.6 * (b.max.z - b.min.z) });
await page.mouse.click(s.x, s.y); await page.waitForTimeout(600);
const n = await page.evaluate(() => window.__vibecadDemo.rect(".wb-verbs .k-live"));
await page.evaluate(() => {
  window.__pinTrack = [];
  const tick = () => { const el = document.querySelector(".k-pin"); if (el) { const r = el.getBoundingClientRect(); window.__pinTrack.push([r.x, r.y]); } if (window.__pinTrack.length < 400) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
await page.mouse.move(n.cx, n.cy); await page.mouse.down();
for (let i = 1; i <= 60; i++) { await page.mouse.move(n.cx + i * 5, n.cy); await page.waitForTimeout(25); }
await page.mouse.up(); await page.waitForTimeout(800);
const track = await page.evaluate(() => window.__pinTrack);
let worst = 0; for (let i = 1; i < track.length; i++) worst = Math.max(worst, Math.hypot(track[i][0] - track[i - 1][0], track[i][1] - track[i - 1][1]));
const jumps = []; for (let i = 1; i < track.length; i++) { const d = Math.hypot(track[i][0] - track[i - 1][0], track[i][1] - track[i - 1][1]); if (d > 8) jumps.push(`${i}:${d.toFixed(0)}@(${track[i - 1].map(Math.round)})->(${track[i].map(Math.round)})`); }
if (process.env.VERBOSE) console.log(jumps.join("  "));
console.log(`samples ${track.length}, largest jump between frames ${worst.toFixed(1)} px`);
await browser.close();
