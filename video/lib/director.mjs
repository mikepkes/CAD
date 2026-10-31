// The video director: plays a playback script against the app in a real
// Chromium window, in real time, while capturing every painted frame. Input is
// real (Playwright mouse and keyboard through CDP), so the app reacts exactly as
// it would to a person; the app's demo layer (src/demo/demo.tsx, `?demo`) draws
// the cursor and keycaps. Each beat is padded to the time its narration takes
// to read, so the voiceover can be recorded to picture afterwards (ADR).
//
// One take = one act: video/takes/<run>/<act>/frames/*.jpg + frames.json +
// timing.json. video/edit.mjs turns takes into the finished video.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const VIEW = { width: 1440, height: 810, scale: 2560 / 1440 }; // 1440p capture of a 1440×810-point window
export const WPM = 150; // a competent reading pace
export const HANDLE_MS = 500; // the settled tail after each line
export const MAX_FAST_MS = 3000; // a sped-up span lasts at most this long on screen

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const readMs = (text) => Math.round((text.trim().split(/\s+/).filter(Boolean).length / WPM) * 60000) + HANDLE_MS;
/** On-screen length of a span after the edit speeds it up (and the factor it uses). */
export function fastened(ms) {
  if (ms <= MAX_FAST_MS) return { ms, factor: 1 };
  const factor = Math.ceil(ms / MAX_FAST_MS);
  return { ms: ms / factor, factor };
}

export class Director {
  static async open({ url, takeDir, headless = false, record = true }) {
    const browser = await chromium.launch({ headless, args: ["--hide-scrollbars", "--disable-features=Translate", "--force-color-profile=srgb"] });
    const context = await browser.newContext({ viewport: { width: VIEW.width, height: VIEW.height }, deviceScaleFactor: VIEW.scale, acceptDownloads: true, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("  [page error]", e.message));
    page.on("console", (m) => { if (m.type() === "error") console.error("  [console]", m.text().slice(0, 300)); });
    await page.goto(url);
    await page.waitForFunction(() => !!window.__chiselDemo, null, { timeout: 30000 });
    const d = new Director(browser, context, page, takeDir, record);
    await d.api("settle");
    return d;
  }

  constructor(browser, context, page, takeDir, record) {
    Object.assign(this, { browser, context, page, takeDir, record });
    this.pointer = { x: VIEW.width / 2, y: VIEW.height / 2 };
    this.timing = { view: VIEW, beats: [], fast: [], captions: [], notes: [] };
    this.frames = [];
    this.t0 = null;
  }

  // ---- capture ----
  async startRecording() {
    this.t0 = Date.now() / 1000;
    if (!this.record) return;
    const dir = join(this.takeDir, "frames");
    mkdirSync(dir, { recursive: true });
    this.cdp = await this.context.newCDPSession(this.page);
    let n = 0;
    this.pending = new Set();
    this.cdp.on("Page.screencastFrame", (f) => {
      const file = `${String(n++).padStart(6, "0")}.jpg`;
      this.frames.push({ t: f.metadata.timestamp - this.t0, file });
      const p = writeFile(join(dir, file), Buffer.from(f.data, "base64")).finally(() => this.pending.delete(p));
      this.pending.add(p);
      this.cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 2560, maxHeight: 1440, everyNthFrame: 1 });
  }
  async stopRecording() {
    this.timing.duration = this.now();
    if (this.cdp) { await this.cdp.send("Page.stopScreencast"); await Promise.all(this.pending); }
    mkdirSync(this.takeDir, { recursive: true });
    writeFileSync(join(this.takeDir, "frames.json"), JSON.stringify(this.frames));
    writeFileSync(join(this.takeDir, "timing.json"), JSON.stringify(this.timing, null, 1));
  }
  async close() { await this.browser.close(); }
  now() { return this.t0 == null ? 0 : Date.now() / 1000 - this.t0; }

  // ---- the app ----
  /** Call window.__chiselDemo[name](...args) in the page. */
  api(name, ...args) { return this.page.evaluate(([n, a]) => window.__chiselDemo[n](...a), [name, args]); }
  /** Run `fn(demo, arg)` in the page (fn must be self-contained). */
  run(fn, arg) { return this.page.evaluate(fn, arg); }
  async settle(quietMs = 250) { const ok = await this.api("settle", quietMs); if (!ok) this.note("settle timed out"); return ok; }
  async rect(selector, text) {
    const r = await this.api("rect", selector, text);
    if (!r) throw new Error(`no element ${selector}${text ? ` with "${text}"` : ""}`);
    return r;
  }
  async world(p) {
    const s = await this.api("worldToScreen", p);
    if (!s) throw new Error("no scene");
    return s;
  }

  // ---- beats ----
  /** One beat: run `fn`, then hold until its narration has had time to be read (sped-up spans count at their sped length). */
  async beat(id, narration, fn, opts = {}) {
    const start = this.now();
    const fastBefore = this.timing.fast.length;
    console.log(`  beat ${id}`);
    try { await fn(); }
    catch (e) { this.note(`beat ${id} failed: ${e.message}`); console.error(`  ✗ ${id}: ${e.message}`); }
    const fast = this.timing.fast.slice(fastBefore);
    const saved = fast.reduce((s, f) => s + (f.end - f.start) * 1000 - (f.cut ? 0 : fastened((f.end - f.start) * 1000).ms), 0);
    const onScreen = (this.now() - start) * 1000 - saved;
    const want = Math.max(readMs(narration), opts.minMs ?? 0);
    if (onScreen < want) await sleep(want - onScreen);
    this.timing.beats.push({ id, start, end: this.now(), narration, lower: opts.lower ?? null });
  }
  /** Mark everything `fn` does as a span the edit speeds up, with `label` on the speed chyron. */
  async fast(label, fn) {
    const start = this.now();
    const r = await fn();
    this.timing.fast.push({ label, start, end: this.now() });
    return r;
  }
  /** A debug still (only with VIDEO_DEBUG=1), into the take's debug/ folder. */
  async shot(name) {
    if (!process.env.VIDEO_DEBUG) return;
    mkdirSync(join(this.takeDir, "debug"), { recursive: true });
    await this.page.screenshot({ path: join(this.takeDir, "debug", `${String(++this.shots || (this.shots = 1)).padStart(3, "0")}-${name}.png`) });
  }
  /** Mark everything `fn` does as dead time the edit removes (loading a model between montage clips). */
  async cut(fn) {
    const start = this.now();
    const r = await fn();
    this.timing.fast.push({ label: "", start, end: this.now(), cut: true });
    return r;
  }
  note(text) { this.timing.notes.push({ t: this.now(), text }); }
  async lower(title, sub) { await this.api("lowerThird", title ? { title, sub } : null); }

  // ---- input ----
  async move(x, y, ms = 450) {
    const from = { ...this.pointer };
    const steps = Math.max(2, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) {
      const k = ease(i / steps);
      await this.page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k);
      await sleep(ms / steps);
    }
    this.pointer = { x, y };
  }
  async moveTo(r, ms) { await this.move(r.cx ?? r.x, r.cy ?? r.y, ms); }
  async click(x, y, { ms = 450, pause = 120, button = "left" } = {}) {
    await this.move(x, y, ms);
    await sleep(pause);
    await this.page.mouse.down({ button });
    await sleep(70);
    await this.page.mouse.up({ button });
    await sleep(150);
  }
  async clickEl(selector, text, opts) { const r = await this.rect(selector, text); await this.click(r.cx, r.cy, opts); return r; }
  async clickWorld(p, opts) { const s = await this.world(p); await this.click(s.x, s.y, opts); return s; }
  async drag(from, to, ms = 900) {
    await this.move(from.x, from.y);
    await this.page.mouse.down();
    await sleep(80);
    await this.move(to.x, to.y, ms);
    await sleep(80);
    await this.page.mouse.up();
    await sleep(150);
  }
  async key(k, hold = 70) { await this.page.keyboard.down(k); await sleep(hold); await this.page.keyboard.up(k); await sleep(180); }
  async type(text, cps = 14) { for (const ch of text) { await this.page.keyboard.type(ch); await sleep(1000 / cps); } }
  wait(ms) { return sleep(ms); }
}
