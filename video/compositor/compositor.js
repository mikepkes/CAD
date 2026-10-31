// Draws every output frame (the captured frame, the speed chyron, the burned-in subtitle) and encodes the cut.
// Driven by video/edit.mjs; writes the MP4 back through its local server (POST /write?pos=).
import { Muxer, StreamTarget } from "/node_modules/mp4-muxer/build/mp4-muxer.mjs";

const q = new URLSearchParams(location.search);

function wrap(ctx, text, max) {
  const words = text.split(" "), lines = [];
  let cur = "";
  for (const w of words) { const t = cur ? `${cur} ${w}` : w; if (ctx.measureText(t).width > max && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur);
  return lines;
}

function drawSubtitle(ctx, text, W, H) {
  ctx.font = "600 44px -apple-system, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif";
  const lines = wrap(ctx, text, W * 0.62);
  const lh = 58, pad = 22, y0 = H - 70 - lines.length * lh;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
  ctx.fillStyle = "rgba(10, 11, 14, 0.78)";
  ctx.beginPath(); ctx.roundRect((W - w) / 2, y0 - pad + 6, w, lines.length * lh + pad * 1.4, 14); ctx.fill();
  ctx.fillStyle = "#f5f6f8"; ctx.textAlign = "center"; ctx.textBaseline = "top";
  lines.forEach((l, i) => ctx.fillText(l, W / 2, y0 + i * lh));
}

function drawChyron(ctx, text, W) {
  ctx.font = "700 36px -apple-system, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif";
  const w = ctx.measureText(text).width + 44, h = 64, x = W - w - 40, y = 40;
  ctx.fillStyle = "#f0a44b";
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 32); ctx.fill();
  ctx.fillStyle = "#16181c"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText(text, x + 22, y + h / 2 + 1);
}

/** A contact sheet: the composited output frames `indices`, tiled 4 across at a quarter size, as a PNG data URL. */
window.sheet = async function sheet(indices) {
  const plan = await (await fetch(q.get("plan"))).json();
  const { width: W, height: H } = plan, tw = W / 4, th = H / 4, cols = 4;
  const out = new OffscreenCanvas(tw * cols, th * Math.ceil(indices.length / cols));
  const o = out.getContext("2d");
  const one = new OffscreenCanvas(W, H), ctx = one.getContext("2d");
  for (const [n, i] of indices.entries()) {
    const [ti, fi] = plan.frames[Math.min(i, plan.frames.length - 1)], t = plan.takes[ti];
    const bmp = await createImageBitmap(await (await fetch(`/${t.dir}/${t.files[fi]}`)).blob());
    ctx.drawImage(bmp, 0, 0, W, H); bmp.close();
    const chy = plan.chyrons.find((c) => i >= c.from && i < c.to), cap = plan.captions.find((c) => i >= c.from && i < c.to);
    if (chy) drawChyron(ctx, chy.text, W);
    if (cap) drawSubtitle(ctx, cap.text, W, H);
    o.drawImage(one, (n % cols) * tw, Math.floor(n / cols) * th, tw, th);
    o.fillStyle = "#f0a44b"; o.font = "600 22px sans-serif"; o.textAlign = "left"; o.textBaseline = "top";
    o.fillText(`${Math.floor(i / plan.fps / 60)}:${String(Math.floor(i / plan.fps) % 60).padStart(2, "0")}`, (n % cols) * tw + 8, Math.floor(n / cols) * th + 6);
  }
  const blob = await out.convertToBlob({ type: "image/png" });
  return await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
};

window.render = async function render() {
  const plan = await (await fetch(q.get("plan"))).json();
  const { fps, width: W, height: H } = plan;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d");
  let pending = Promise.resolve(), bytes = 0;
  const target = new StreamTarget({
    chunked: true,
    chunkSize: 8 * 1024 * 1024,
    onData: (data, position) => { bytes = Math.max(bytes, position + data.byteLength); const copy = data.slice(); pending = pending.then(() => fetch(`/write?pos=${position}`, { method: "POST", body: copy })); },
  });
  let codec = "avc1.640033", mux = "avc";
  const cfg = { codec, width: W, height: H, bitrate: 14_000_000, framerate: fps, latencyMode: "quality", avc: { format: "avc" } };
  if (!(await VideoEncoder.isConfigSupported(cfg)).supported) { codec = "vp09.00.51.08"; mux = "vp9"; delete cfg.avc; cfg.codec = codec; }
  const muxer = new Muxer({ target, video: { codec: mux, width: W, height: H, frameRate: fps }, fastStart: false, firstTimestampBehavior: "offset" });
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => console.error(e.message) });
  encoder.configure(cfg);

  const capAt = new Array(plan.frames.length).fill(null), chyAt = new Array(plan.frames.length).fill(null);
  for (const c of plan.captions) for (let f = c.from; f < c.to && f < capAt.length; f++) capAt[f] = c.text;
  for (const c of plan.chyrons) for (let f = c.from; f < c.to && f < chyAt.length; f++) chyAt[f] = c.text;

  let lastKey = null, bitmap = null, next = null, nextKey = null;
  const load = async (key) => { const [ti, fi] = key; const t = plan.takes[ti]; const r = await fetch(`/${t.dir}/${t.files[fi]}`); return createImageBitmap(await r.blob()); };
  const t0 = performance.now();
  for (let i = 0; i < plan.frames.length; i++) {
    const key = plan.frames[i];
    if (!lastKey || key[0] !== lastKey[0] || key[1] !== lastKey[1]) {
      bitmap?.close();
      bitmap = nextKey && nextKey[0] === key[0] && nextKey[1] === key[1] ? await next : await load(key);
      lastKey = key;
      // prefetch the next distinct frame
      const nk = plan.frames.slice(i + 1, i + 8).find((k) => k[0] !== key[0] || k[1] !== key[1]);
      if (nk) { nextKey = nk; next = load(nk); } else { nextKey = null; next = null; }
    }
    ctx.drawImage(bitmap, 0, 0, W, H);
    if (chyAt[i]) drawChyron(ctx, chyAt[i], W);
    if (capAt[i]) drawSubtitle(ctx, capAt[i], W, H);
    const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();
    while (encoder.encodeQueueSize > 12) await new Promise((r) => setTimeout(r, 2));
    if (i % 300 === 0) fetch("/progress", { method: "POST", body: `${i}/${plan.frames.length} frames, ${((performance.now() - t0) / 1000).toFixed(0)} s` });
  }
  await encoder.flush();
  muxer.finalize();
  await pending;
  return { frames: plan.frames.length, bytes, codec };
};
