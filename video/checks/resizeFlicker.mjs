// `node video/checks/resizeFlicker.mjs` (dev server on :5173): count screencast frames where the model vanishes
// while the left panel is resized. 0 expected; before the fix (a resize cleared the canvas until the next frame) it was 232 of 240.
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 2 });
await page.goto("http://localhost:5173/?demo");
await page.waitForFunction(() => window.__vibecadDemo, null, { timeout: 60000 });
await page.evaluate(async () => {
  const D = window.__vibecadDemo;
  await D.openText(await (await fetch("/examples/gimbal.json")).text(), "g.vibecad.json");
  D.ui.getState().togglePanel("workbench", false);
  D.view("iso"); await new Promise((r) => setTimeout(r, 900)); D.frameAll(); await new Promise((r) => setTimeout(r, 900));
});
const cdp = await page.context().newCDPSession(page);
const shots = [];
cdp.on("Page.screencastFrame", (f) => { shots.push(f.data); cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {}); });
await cdp.send("Page.startScreencast", { format: "png", maxWidth: 720, maxHeight: 405, everyNthFrame: 1 });
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => window.__vibecadDemo.sideWidth("left", 520, 700));
  await page.evaluate(() => window.__vibecadDemo.sideWidth("left", 272, 700));
}
await cdp.send("Page.stopScreencast");
// a frame "has the model" if the viewport's middle band has enough non-background pixels
const blanks = await page.evaluate(async (list) => {
  let blank = 0;
  for (const b64 of list) {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height), g = c.getContext("2d"); g.drawImage(img, 0, 0);
    const d = g.getImageData(Math.round(img.width * 0.45), Math.round(img.height * 0.3), Math.round(img.width * 0.25), Math.round(img.height * 0.4)).data;
    let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 200) lit++;
    if (lit / (d.length / 4) < 0.02) blank++;
  }
  return blank;
}, shots);
console.log(`frames ${shots.length}, blank ${blanks}`);
await browser.close();
