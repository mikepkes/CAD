// In-page rebuild benchmark, for the web app in a browser and the desktop app alike: runs
// inside the page (loaded by src/main.tsx in dev when the URL has ?bench=<port>), works the
// store the way the UI does, and reports to the driver (scripts/bench/app.mjs) listening on
// 127.0.0.1:<port>. One page load measures one example — the one in ?example= — then asks
// the driver for the next and navigates to it.
//
// Per example: the cold open (page open → kernel ready → first model built); one slider
// change (a geometry slider and a joint-drive one: median and p90 of the rebuild after each
// of several distinct values); a sustained drag (new values every 16 ms for a few seconds:
// the rebuilds per second the preview keeps up with, and the lag of the last one). Memory is
// the driver's to sample (process RSS from outside).

const q = new URLSearchParams(location.search);
// the driver, behind the dev server's /__bench proxy (vite.config.ts): the page's own origin
const base = "/__bench";
const example = q.get("example");
const store = window.__vibecad;
const state = () => store.getState();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const p90 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] : null; };
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Resolve once the model is built: solids with meshes and no build in flight. */
const built = () => new Promise((res) => {
  const tick = () => { const s = state(); if (s.kernelReady && !s.build && Object.values(s.solids).some((b) => b.mesh)) res(); else setTimeout(tick, 5); };
  tick();
});

/** The sliders to sweep: one that changes geometry (read by a sketch/feature, by no joint) and one
 *  that only poses it (a joint drive). `n` distinct values each, none the current one. */
function sliders(doc, n) {
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
    return { name: p.name, values: values.filter((x) => Number(x) !== v), original: p.expr, min: bounded(p) ? p.min : v * 0.5, max: bounded(p) ? p.max : v * 1.5 };
  };
  const g = pick(doc.parameters.filter((p) => reads(geomText, p) && !reads(jointText, p))) ?? pick(doc.parameters.filter((p) => reads(geomText, p)));
  const j = pick(doc.parameters.filter((p) => reads(jointText, p) && !reads(geomText, p))) ?? pick(doc.parameters.filter((p) => reads(jointText, p)));
  return { geom: g ? sweep(g) : null, pose: j ? sweep(j) : null };
}

/** One slider change, as the parameters panel does it: set the expression, wait for the new
 *  solids to land with no build in flight. */
async function change(name, expr) {
  const solids0 = state().solids;
  const t0 = performance.now();
  await state().setParameterExpr(name, expr);
  await new Promise((res) => {
    const tick = () => { const s = state(); if (!s.build && s.solids !== solids0) res(); else setTimeout(tick, 2); };
    setTimeout(tick, 2);
  });
  return performance.now() - t0;
}

/** A drag: a new value every 16 ms for `ms`, sweeping the range back and forth, never waiting;
 *  counts the rebuilds that landed and how far behind the last one was. */
async function drag(slider, ms) {
  let landed = 0;
  const unsub = store.subscribe((s, prev) => { if (s.solids !== prev.solids) landed++; });
  const t0 = performance.now();
  let i = 0;
  const span = slider.max - slider.min;
  while (performance.now() - t0 < ms) {
    const phase = ((i++ * 16) / 1500) % 2; // a full back-and-forth every 3 s
    const f = phase < 1 ? phase : 2 - phase;
    const v = slider.min + span * (0.1 + 0.8 * f);
    void state().setParameterExpr(slider.name, String(Math.round(v * 1000) / 1000));
    await sleep(16);
  }
  const sent = i;
  const tEnd = performance.now();
  await built(); // the last value lands
  const lag = performance.now() - tEnd;
  unsub();
  await state().setParameterExpr(slider.name, slider.original);
  await built();
  return { perSecond: r1(landed / ((tEnd - t0) / 1000)), landed, sent, lagMs: r1(lag) };
}

async function main() {
  if (!example) { const r = await (await fetch(`${base}/next`)).json(); if (r.example) go(r.example); return; }
  await new Promise((res) => { const tick = () => (state().kernelReady ? res() : setTimeout(tick, 5)); tick(); });
  const kernelReadyMs = performance.now();
  await built();
  const firstModelMs = performance.now();
  await sleep(500); // let the measuring settle before the sliders
  const repeats = Number(q.get("repeats") ?? 7);
  const doc = state().session.doc;
  const sl = sliders(doc, repeats);
  const one = async (s) => {
    if (!s) return null;
    const times = [];
    for (const v of [...s.values, s.original]) { const t = await change(s.name, v); if (v !== s.original) times.push(t); }
    return { name: s.name, medianMs: r1(median(times)), p90Ms: r1(p90(times)), times: times.map(r1) };
  };
  const geom = await one(sl.geom);
  const pose = await one(sl.pose);
  const dragMs = Number(q.get("drag") ?? 6000);
  const geomDrag = sl.geom ? await drag(sl.geom, dragMs) : null;
  const poseDrag = sl.pose ? await drag(sl.pose, dragMs) : null;
  const bodies = Object.values(state().solids).filter((b) => b.mesh).length;
  // a store update that changes nothing: what the viewport costs to take new solids (its part of every change above)
  const updates = [];
  for (let i = 0; i < 5; i++) { const t = performance.now(); store.setState({ rev: state().rev + 1 }); updates.push(performance.now() - t); await sleep(50); }
  const updateMs = r1(median(updates));
  await post("/result", { updateMs, example, pool: q.get("pool") ?? "default", cores: navigator.hardwareConcurrency, ua: navigator.userAgent, kernelReadyMs: r1(kernelReadyMs), firstModelMs: r1(firstModelMs), geom, pose, geomDrag, poseDrag, bodies });
  const r = await (await fetch(`${base}/next`)).json();
  if (r.example) go(r.example); else await post("/done", {});
}

function go(next) {
  const u = new URL(location.href);
  u.searchParams.set("example", next);
  location.href = u.toString();
}

main().catch((e) => post("/error", { example, message: String(e?.stack ?? e) }));
