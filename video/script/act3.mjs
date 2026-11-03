// Act 3 · The demo's showcase, rapid fire: about seven seconds per idea, mostly the bundled examples, then the mock
// agent, and the outro pointing to the tutorial.
// Loading each model is cut from the edit; slow processing is sped up with its speed shown.
// Narration: lines.mjs, by beat id.

import { readFileSync } from "node:fs";

import { existsSync } from "node:fs";

const agentCache = JSON.parse(readFileSync(new URL("../mock/agent-vase.json", import.meta.url), "utf8"));
const forcesCache = JSON.parse(readFileSync(new URL("../mock/agent-bistable-forces.json", import.meta.url), "utf8"));
const hasExample = (name) => existsSync(new URL(`../../public/examples/${name}.json`, import.meta.url));

/** Open an example inside a cut. `setup` (optional) runs inside the cut too, so the beat's first frame already
 *  shows its starting state (e.g. a fold posed flat) rather than the example as saved. */
async function load(d, name, setup) {
  await d.cut(async () => {
    await d.run(async (n) => {
      const D = window.__vibecadDemo;
      D.closeCards();
      D.store.getState().setSection(null);
      const text = await (await fetch(`/examples/${n}.json`)).text();
      await D.openText(text, `${n}.vibecad.json`);
      if (D.store.getState().showPlanes) D.store.getState().toggleShowPlanes();
      D.ui.getState().togglePanel("workbench", false); // no pins in the montage
      D.view("iso");
      await new Promise((r) => setTimeout(r, 700));
      D.frameAll(); // fill the frame with the model
    }, name);
    if (setup) await setup();
    await d.settle(500);
  });
}

/** Sweep a parameter through `values` (PUPPET: set by command, as dragging its slider would), sped up when rebuilds are slow. */
async function sweep(d, name, values, ms = 3000) {
  const t0 = Date.now();
  const step = ms / values.length;
  const run = async () => {
    for (const v of values) {
      const t = Date.now();
      await d.run(async ([n, x]) => { await window.__vibecadDemo.store.getState().setParameterExpr(n, String(x)); }, [name, v]);
      await d.settle(60, { camera: false }); // a turntable may be running
      const left = step - (Date.now() - t);
      if (left > 0) await d.wait(left);
    }
  };
  // a sweep that ran long because of rebuilds is marked for speeding up after the fact
  const start = d.now();
  await run();
  if (Date.now() - t0 > ms * 1.6) d.timing.fast.push({ label: `rebuilding ${name}`, start, end: d.now() });
}
/** The gyroscope's +X pivot: the middle ring's cone pin, from its root to its point in the frame ring's socket. */
const GYRO_PIVOT = { min: { x: 36, y: -3, z: -7 }, max: { x: 52, y: 3, z: 7 } };
const range = (a, b, n) => Array.from({ length: n }, (_, i) => +(a + ((b - a) * i) / (n - 1)).toFixed(3));
const there = (a, b, n) => [...range(a, b, n), ...range(b, a, n).slice(1)];

export async function act3(d) {
  await d.api("cursor", false);
  await d.cut(async () => {
    await d.run(() => window.__vibecadDemo.ui.getState().togglePanel("workbench", false));
    // the montage shows the model, not the panels (there is no presentation mode yet: a gap)
    await d.clickEl(".side-toggle.left"); await d.clickEl(".side-toggle.right");
  });

  const clip = async (id, name, title, sub, act, setup) => {
    await load(d, name, setup);
    await d.beat(id, async () => { await d.lower(title, sub); await act(); }, { minMs: 6500 });
  };

  await clip("gyroscope", "gyroscope", "Print-in-place gyroscope", "a section view, then a motion study", async () => {
    // the section: tick Section in the toolbar, cut on the vertical XZ plane through the middle
    await d.api("cursor", true);
    const at = await d.toolbar("section");
    const sec = await d.rect(`${at} .grid-controls label`, "Section");
    await d.click(sec.x + 10, sec.cy);
    await d.settle(300);
    const plane = d.page.locator(`${at} .grid-controls select[title='Section plane']`), pb = await plane.boundingBox();
    await d.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
    await plane.selectOption("XZ");
    await d.settle(300);
    if (at.includes("menu")) { await d.key("Escape"); await d.settle(200); } // close the more menu over the view
    await d.api("cursor", false);
    // square to the cut face, then in on a pivot: the middle ring's cone pin, pointing into the frame ring's socket
    await d.api("aim", { dir: [0, 1, 0.0001], ms: 2000, margin: 1.05 });
    await d.wait(900);
    await d.api("aim", { dir: [0, 1, 0.0001], box: GYRO_PIVOT, ms: 2200, margin: 1.35 });
    await d.wait(400); d.pick("gyroscope bearing"); await d.wait(2400);
    await d.api("aim", { dir: [0.55, 1, 0.6], ms: 1800, margin: 1.0 });
    await d.fast("motion study", async () => {
      // with Show motion on, the rings it turns sweep round as see-through ghosts while each pose is checked
      await d.run(async () => { const st = window.__vibecadDemo.store.getState(); st.setMotionGhost(true); await st.runMotionStudy(); });
      await d.page.waitForFunction(() => !["running", "pending"].includes(window.__vibecadDemo.store.getState().motionStatus), null, { timeout: 180000 });
    });
    await d.wait(1200);
  });
  if (hasExample("clockwork")) {
    await clip("clockwork", "clockwork", "Gears of every kind", "spur, helical, herringbone, ring, rack, bevel, worm, and a Geneva drive", async () => {
      // no turntable: the camera holds still between shots and only the gears move (posed from the turn parameter,
      // not rebuilt). Each shot lands on the word that names its mechanism, from the default voice's word timings
      // (video/vo/af_heart/act3-clockwork.words.json, made by the sync check) when cached, else these.
      const fallback = { so: 6.66, planets: 9.74, worm: 12.38, geneva: 16.36, steps: 18.64, flicks: 21.44, end: 25.88 };
      let words = [];
      try { words = JSON.parse(readFileSync(new URL("../vo/af_heart/act3-clockwork.words.json", import.meta.url), "utf8")).words ?? []; } catch {}
      const said = (w) => (w === "end" ? words.at(-1)?.e : words.find((x) => x.w.toLowerCase().replace(/[^a-z]/g, "") === w)?.s) ?? fallback[w];
      const t0 = d.timing.events.findLast((e) => e.kind === "beat")?.t ?? d.now(); // the line starts with the beat
      let at = 0, lag = 0; // a sweep overruns its time a little: the next one starts that much sooner
      const turn = async (to, s) => {
        await d.api("poseSweep", "turn", at, to, Math.max(150, Math.round((t0 + s - d.now() - lag) * 1000)), { ease: false });
        at = to; lag = Math.max(0, lag + d.now() - (t0 + s));
      };
      const fly = (opts) => { d.api("aim", opts).catch(() => {}); }; // the camera moves while the gears keep turning
      const GENEVA = ["Geneva crank", "Geneva star"];
      // the Geneva crank turns at -5/8 of the knob, so the star steps once per 576 deg of turn, mid-step at 288 (mod 576):
      // one step on "steady motion into steps", the next on "flicks the star", the third on "until the next"
      const tA = said("steps") - 0.45, tB = said("flicks") + 0.45, v = 576 / (tB - tA);
      const tP = said("planets") - 1.2, tW = said("worm") - 0.7, tG = said("geneva") - 1.1, tEnd = said("end") + 0.4;
      // the whole model, pushed in to fill the frame side to side (by the frame and gears: the rack slides as they turn)
      fly({ dir: [0.2, -0.5, 1], frame: [0.07, 0.04, 0.9, 1.03], except: ["Rack"], ms: 1200 });
      await turn(360, said("so"));
      d.pick("clockwork");
      await turn(540, tP);
      // the planets in the ring, with the Geneva drive beside them nearer the middle
      fly({ dir: [0.15, -0.35, 1], frame: [0.46, 0.28, 0.65, 0.7], parts: GENEVA, ms: 1100 });
      await turn(540 + 100 * (tW - tP), tW);
      // the worm and its wheel, the knob fast so the wheel visibly creeps
      fly({ dir: [0.5, -0.6, 0.75], box: await d.api("componentBox", ["Cross shaft", "Wheel"]), ms: 1000, margin: 0.9 });
      let k = 0;
      while (288 + 576 * k - v * (tA - tG) < at + 1100) k++;
      await turn(288 + 576 * k - v * (tA - tG), tG);
      // the Geneva drive, turning steadily, through the whole of its sentence
      fly({ dir: [0.1, -0.55, 1], frame: [0.25, 0.12, 0.75, 0.8], parts: GENEVA, ms: 1000 });
      await turn(at + v * (tEnd - tG), tEnd);
    });
  } else d.note("no clockwork example yet: gears clip skipped");
  /**
   * The walker's leg nearest the camera (lowest y: the side its close-up looks from), found by the example's
   * structure, not by ids: a leg is a parent component named like one ("Leg w0", its bars as children), else the
   * components sharing a leg tag, the first word with a digit in their names ("Rocker w0" … "Foot w0"; "w0m" its
   * mirror). Parts jointed to one leg's bars only (pins) go with that leg. Returns its name, its world box at the
   * built pose, and what to fade out for its close-up: every other leg (top component ids), the fixed bodies between
   * it and the camera (body ids: the frame, whose end wall covers the leg's upper bars) and the sketches still shown
   * (the bars' outlines would clutter the one leg); null when fewer than two legs are found.
   */
  const walkerLeg = () => d.run(() => {
    const st = window.__vibecadDemo.store.getState(), doc = st.session.doc, root = doc.rootComponentId;
    const comps = Object.values(doc.components).filter((c) => c.id !== root);
    const tree = (id, out = new Set()) => { if (out.has(id)) return out; out.add(id); for (const k of doc.components[id]?.children ?? []) tree(k, out); return out; };
    let legs = comps.filter((c) => c.children?.length && /\bleg\b/i.test(c.name)).map((c) => ({ name: c.name, top: [c.id], ids: tree(c.id) }));
    if (legs.length < 2) {
      const byTag = new Map();
      for (const c of comps) {
        const tag = c.name.split(/\s+/).find((w) => /\d/.test(w));
        if (tag) byTag.set(tag, [...(byTag.get(tag) ?? []), c]);
      }
      legs = [...byTag].map(([tag, cs]) => {
        const ids = new Set(); for (const c of cs) tree(c.id, ids);
        return { name: `leg ${tag}`, top: cs.filter((c) => !cs.some((p) => p.id === c.parentId)).map((c) => c.id), ids };
      }).filter((l) => l.ids.size >= 3);
    }
    if (legs.length < 2) return null;
    const legOf = (id) => legs.find((l) => l.ids.has(id));
    for (const c of comps) {
      if (legOf(c.id)) continue;
      const touched = new Set(Object.values(doc.joints ?? {}).flatMap((j) => (j.moved === c.id ? [j.base] : j.base === c.id ? [j.moved] : [])).map(legOf).filter(Boolean));
      if (touched.size === 1) { const l = [...touched][0]; l.top.push(c.id); tree(c.id, l.ids); }
    }
    const boxOf = (ids) => {
      const lo = { x: Infinity, y: Infinity, z: Infinity }, hi = { x: -Infinity, y: -Infinity, z: -Infinity };
      for (const b of Object.values(st.solids)) {
        const cid = (b.sketchId ? doc.sketches[b.sketchId]?.componentId : undefined) ?? root;
        if (!b.mesh || !b.bounds || !ids.has(cid)) continue;
        for (const k of ["x", "y", "z"]) { lo[k] = Math.min(lo[k], b.bounds.min[k]); hi[k] = Math.max(hi[k], b.bounds.max[k]); }
      }
      return lo.x <= hi.x ? { min: lo, max: hi } : null;
    };
    const boxed = legs.map((l) => ({ ...l, box: boxOf(l.ids) })).filter((l) => l.box);
    if (boxed.length < 2) return null;
    const near = boxed.reduce((a, b) => (b.box.min.y + b.box.max.y < a.box.min.y + a.box.max.y ? b : a));
    const others = boxed.filter((l) => l !== near), inLeg = (cid) => boxed.some((l) => l.ids.has(cid));
    // the fixed frame reaches from the camera's side past the leg (its end wall covers the leg's upper bars); what a
    // joint moves (the crankshaft) stays, as part of the mechanism
    const moved = new Set(Object.values(doc.joints ?? {}).map((j) => j.moved));
    const front = Object.values(st.solids).filter((b) => {
      const cid = (b.sketchId ? doc.sketches[b.sketchId]?.componentId : undefined) ?? root;
      return b.mesh && b.bounds && !inLeg(cid) && !moved.has(cid) && b.bounds.min.y <= near.box.min.y + 0.01;
    }).map((b) => b.featureId);
    const sketches = Object.values(doc.sketches).filter((sk) => !others.some((l) => l.ids.has(sk.componentId))).map((sk) => sk.id);
    return { name: near.name, box: near.box, fade: [...others.flatMap((l) => l.top), ...new Set(front), ...sketches] };
  });
  if (hasExample("walker")) {
    let leg = null; // found while the model loads (inside its cut): the beat's picture never waits on it
    await clip("walker", "walker", "Jansen wind walker", "one crank, twelve legs, overlapping strides", async () => {
      // posed from the crank angle: the legs' joint positions are parameters that follow `t`. The crank never stops
      // or changes speed; a short look at the whole walker, then, as "twelve legs" is said, every leg but one and
      // the frame fade out (display only: nothing rebuilds, so no cut) while the camera moves in on that one leg,
      // which holds the rest of the line. Shots land on words from the default voice's timings
      // (video/vo/af_heart/act3-walker.words.json, made by the sync check) when cached, else these.
      const fallback = { legs: 5.78, end: 14.14 };
      let words = [];
      try { words = JSON.parse(readFileSync(new URL("../vo/af_heart/act3-walker.words.json", import.meta.url), "utf8")).words ?? []; } catch {}
      const said = (w) => (w === "end" ? words.at(-1)?.e : words.find((x) => x.w.toLowerCase().replace(/[^a-z]/g, "") === w)?.s) ?? fallback[w];
      const t0 = d.timing.events.findLast((e) => e.kind === "beat")?.t ?? d.now(); // the line starts with the beat
      const tIso = said("legs"), tEnd = said("end") + 0.7;
      // about 100°/s, a whole number of turns by the end: the built pose, so putting the parts back shows no jump
      const v = (360 * Math.max(1, Math.round((tEnd * 100) / 360))) / tEnd;
      let at = 0;
      const turn = async (s) => { // the crank, at its steady rate, until `s` into the line (an overrun is made up by the next)
        const to = v * s;
        await d.api("poseSweep", "t", at, to, Math.max(150, Math.round((t0 + s - d.now()) * 1000)), { ease: false });
        at = to;
      };
      await Promise.all([d.api("aim", { dir: [0.35, -1, 0.3], ms: 1000, margin: 0.85 }), turn(Math.min(2.6, tIso / 2))]);
      d.pick("walker");
      await Promise.all([d.api("aim", { dir: [0.9, -0.6, 0.15], ms: 1500, margin: 0.8 }), turn(tIso)]);
      if (!leg) { d.note("walker: no leg assembly found among the example's components; the whole walker kept turning"); console.error("  ✗ walker: no leg assembly found"); }
      else d.event("view", `one leg: ${leg.name}`);
      // "…of eleven bars each": the rest fade out as the camera comes in from the side, along the crank axis, so the
      // leg's linkage reads; then a slow push in from lower down, through "gliding along the ground"
      await Promise.all([
        leg && d.api("fadeComponents", leg.fade, 0, 900),
        leg && d.api("aim", { dir: [0.25, -1, 0.12], box: leg.box, ms: 1800, margin: 1.15 }).then(() => d.api("aim", { dir: [0.4, -1, 0.02], box: leg.box, ms: 4200, margin: 1.05 })),
        turn(tEnd),
      ]);
      await d.api("poseEnd"); // the others stay faded out: nothing pops back
    }, async () => { // the leg, and the others' see-through look compiled here, so the fade starts without a stall
      leg = await walkerLeg();
      if (leg) await d.api("prepareFade", leg.fade);
    });
  } else d.note("no walker example yet: walker clip skipped");
  await clip("skadis", "skadis", "SKÅDIS gravity holder", "the load's own weight closes the grip", async () => {
    await d.api("aim", { dir: [0.25, -1, 0.35], ms: 1000, margin: 0.9 });
    await d.api("poseSweep", "drop", 0, 6.4, 2600);
    d.pick("skadis holder");
    await d.wait(900);
    await d.api("poseSweep", "drop", 6.4, 0, 1800);
    // closer, from below the front: the pinions and parallelogram arms on the cheeks
    await d.api("aim", { dir: [0.6, -1, -0.35], box: await d.api("componentBox", ["Lower arm, right", "Upper arm, right", "Pad, right", "Lower arm, left", "Upper arm, left", "Pad, left", "Rack"]), ms: 1400, margin: 1.15 });
    await d.api("poseSweep", "drop", 0, 6.4, 2400);
    await d.wait(700);
    await d.api("poseEnd");
  });
  await clip("handlebar", "handlebar", "Bike handlebar", "a 3D sweep with a tapering section, a wrapped hex grip", async () => {
    // timed to the line's words (seconds into the beat, Heart's clip): the whole bar while "one sweep along a 3D curve",
    // the stem by "stem clamp" (7.5 s), then in close on a grip just before "rubber grips" (9.3 s), held through "wings" (12 s)
    const t0 = d.timing.events.findLast((e) => e.kind === "beat")?.t ?? d.now();
    const at = (s) => d.wait(Math.max(0, (t0 + s - d.now()) * 1000));
    const stem = await d.api("componentBox", ["Stem", "Faceplate", "Faceplate bolts", "Top cap"]);
    const grip = await d.api("componentBox", ["Grip R", "Collar R", "End plug R"]);
    await d.api("aim", { dir: [0.3, -1, 0.55], ms: 1000, margin: 0.8 });
    await d.api("turntable", 10);
    await at(5.0);
    await d.api("turntable", null);
    await at(5.7);
    await d.api("aim", { dir: [0.2, -0.7, 0.9], box: stem, ms: 1400, margin: 1.2 });
    await at(8.0);
    await d.api("aim", { dir: [0.6, -0.8, 0.5], box: grip, ms: 1200, margin: 0.8 });
    d.pick("handlebar grip");
    await at(12.1);
  });
  await clip("origami", "origami", "Paper airplane", "a flat sheet to a finished dart, fold by fold", async () => {
    await d.api("aim", { dir: [0.4, -0.8, 0.9], ms: 900, margin: 0.75 });
    d.pick("origami folds", { len: 2.2, speed: 3 }); // the whole fold, sped up: the montage's longer shot
    await d.api("poseSweep", "fold", 0, 6, 6600, { ease: false });
    await d.api("aim", { dir: [0.8, -0.5, 0.45], ms: 1500, margin: 0.85 });
    await d.wait(800);
    await d.api("poseEnd");
  }, () => d.api("poseSweep", "fold", 6, 0, 1)); // posed flat inside the load's cut: the saved example is the finished dart
  // the stage count grows the lift, so the camera dollies out ahead of the new stages and back in once they're gone
  const liftView = { dir: [1, -1, 0.8], margin: 1.2 }; // the iso view, a little room round the lift
  const setStages = (n) => d.run(async (x) => { await window.__vibecadDemo.store.getState().setParameterExpr("stages", String(x)); }, n);
  const liftBox = () => d.run(() => window.__vibecadDemo.bounds().reduce((a, b) => ({
    min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y), z: Math.min(a.min.z, b.min.z) },
    max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y), z: Math.max(a.max.z, b.max.z) },
  })));
  // a glide that doesn't wait: the stages keep changing under it
  const dolly = (box, ms) => { d.event("view", "aim"); return d.run((o) => { window.__vibecadDemo.aim(o); }, { ...liftView, box, ms }); };
  await load(d, "scissor-jointed");
  const lift = await d.cut(async () => { // the lift's box at each stage count, built off camera; then framed at three
    const boxes = {};
    for (const n of [4, 5, 3]) { await setStages(n); await d.settle(100); boxes[n] = await liftBox(); }
    await d.api("aim", { ...liftView, box: boxes[3], ms: 300 });
    return boxes;
  });
  await d.beat("scissor-jointed", async () => {
    await d.lower("Jointed scissor lift", "the stage count is a slider, and it still moves");
    // 3→4→5→4→3 (as `sweep`): out to five stages across the first two steps, hold, then in to three once the fifth is gone
    const values = [3, 4, 5, 4, 3], step = 2600 / values.length, t0 = Date.now(), start = d.now();
    await dolly(lift[5], 2 * step);
    for (const [i, v] of values.entries()) {
      const t = Date.now();
      await setStages(v);
      await d.settle(60, { camera: false });
      if (i === 3) await dolly(lift[3], 2 * step);
      const left = step - (Date.now() - t);
      if (left > 0) await d.wait(left);
    }
    if (Date.now() - t0 > 2600 * 1.6) d.timing.fast.push({ label: "rebuilding stages", start, end: d.now() });
    // the opening angle drives the stamped joints: the bars swing at display rate, no rebuild (closed and open again,
    // ending on the built 40°, so putting the parts back shows no jump)
    d.pick("scissor lift");
    await d.api("poseSweep", "theta", 40, 22, 1300);
    await d.api("poseSweep", "theta", 22, 40, 1300);
    await d.api("poseEnd");
  }, { minMs: 6500 });
  await clip("starbox", "starbox", "Snap-together star box", "snaps sized for each material", async () => { await sweep(d, "width", [64, 76], 900); d.pick("star box"); await sweep(d, "width", [88, 76, 64], 2100); });

  // the bistable switch: ask Claude, which opens the force analysis itself (set_panel / run_action), sweeps it, and puts the lens on strain
  await d.cut(async () => {
    await load(d, "bistable");
    await d.clickEl(".side-toggle.right"); // the Mechanism tab lives in the right panel
    await d.run((c) => window.__vibecadDemo.mockAgent(c), forcesCache);
  });
  await d.beat("bistable-forces", async () => {
    await d.lower("Bistable switch", "Claude opens the force analysis for you");
    await d.api("cursor", true);
    await d.clickEl(`${await d.toolbar("agent")} button`, "Agent");
    await d.clickEl(".agent-input textarea");
    await d.type(forcesCache.prompt, 40);
    await d.key("Enter");
    await d.fast("Claude working", () => d.page.waitForFunction(() => !window.__vibecadDemo.store.getState().agentRunning, null, { timeout: 120000 }));
    await d.page.waitForSelector("[data-testid=rest-marker]", { timeout: 60000 }).catch(() => d.note("no rest markers"));
    await d.page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Sweep travel"), null, { timeout: 60000 }).catch(() => d.note("sweep did not finish"));
    await d.api("cursor", false);
    await d.wait(300); d.pick("force analysis");
    await d.wait(1200);
  }, { minMs: 12000 });
  await d.beat("print-direction", async () => {
    await d.lower("Print direction", "the strain study knows a print is weaker across its layers");
    await d.api("cursor", true);
    await d.run(() => { const st = window.__vibecadDemo.store.getState(); st.agentOpen && st.toggleAgent(); });
    await d.clickEl(".k-panel-toggle button", "Materials"); await d.settle(300);
    await d.clickEl("button[aria-label^='Edit TPU 68D']"); await d.wait(600);
    await d.clickEl("[aria-label='Print direction'] button", "=X");
    await d.settle(500); await d.wait(900);
    await d.clickEl(".k-tabs button", "Mechanism"); await d.settle(400);
    await d.wait(2600);
    await d.clickEl(".k-tabs button", "Materials"); await d.wait(300);
    await d.clickEl("button[aria-label^='Edit TPU 68D']"); await d.wait(400); // the editor closed with the tab
    await d.clickEl("[aria-label='Print direction'] button", "=Z");
    await d.settle(400);
    await d.clickEl(".k-tabs button", "Mechanism"); await d.settle(300);
    await d.api("cursor", false);
    await d.wait(1600);
  }, { minMs: 9000 });
  await d.cut(async () => {
    await d.run(() => { const D = window.__vibecadDemo; D.ui.getState().togglePanel("lens", false); D.ui.getState().togglePanel("mechanism", false); D.ui.getState().togglePanel("materials", false); D.store.getState().agentOpen && D.store.getState().toggleAgent(); });
    await d.clickEl(".side-toggle.right");
  });

  await clip("gimbal", "gimbal", "Flexure gimbal", "steers a mirror on eight blades", async () => { await sweep(d, "alpha", there(-8, 8, 6), 2400); d.pick("gimbal"); await sweep(d, "beta", there(-8, 8, 6), 2400); });
  await clip("roubo", "roubo", "Roubo workbench", "the leg vise, and the shop drawing to build it from", async () => {
    const t0 = d.now(), fast0 = d.timing.fast.length;
    // seconds of the clip seen so far: a sped-up span (over 3 s) plays at 1/ceil(len/3) of its length
    const onScreen = () => d.timing.fast.slice(fast0).reduce((t, f) => {
      const len = f.end - f.start;
      return t - (f.cut ? len : len <= 3 ? 0 : len - len / Math.ceil(len / 3));
    }, d.now() - t0);
    // the vise opens on "Its leg vise opens" (the default voice's word timings, seconds into the clip)
    let opensAt = 4.3;
    try {
      const w = JSON.parse(readFileSync(new URL("../vo/af_heart/act3-roubo.words.json", import.meta.url), "utf8")).words;
      const i = w.findIndex((x, k) => /^its$/i.test(x.w) && /^leg/i.test(w[k + 1]?.w ?? ""));
      if (i >= 0) opensAt = w[i].s;
    } catch { /* no cached timings: the fallback */ }
    await d.api("aim", { dir: [0.45, -1, 0.5], ms: 1000, margin: 0.7 });
    await sweep(d, "L", there(1700, 2100, 4), 2400);
    // in on the leg vise, square-on to its travel (the slider's axis, from the model) so the chop's motion lies in
    // the picture, seen from the end of the bench it sits at, a little from above; then it opens and closes (posed)
    const vise = await d.api("componentBox", ["Vise chop", "Leg FL"]), gap = [60, 170];
    const view = await d.run(([box, travel]) => {
      const D = window.__vibecadDemo, doc = D.store.getState().session.doc;
      const j = Object.values(doc.joints).find((q) => q.kind === "slider" && q.valueExpr.trim() === "viseGap");
      const a = j?.axis ?? { x: 0, y: -1, z: 0 }; // in the base's frame: the vise slides on the bench (ground)
      const n = Math.hypot(a.x, a.y, a.z) || 1, ax = [a.x / n, a.y / n, a.z / n];
      // across the travel, level: axis × up, turned toward the vise's side of the bench
      let p = [ax[1], -ax[0], 0];
      if (Math.hypot(p[0], p[1]) < 1e-6) p = [1, 0, 0];
      const all = D.bounds().reduce((u, b) => ({ x0: Math.min(u.x0, b.min.x), x1: Math.max(u.x1, b.max.x), y0: Math.min(u.y0, b.min.y), y1: Math.max(u.y1, b.max.y) }), { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity });
      const off = [(box.min.x + box.max.x) / 2 - (all.x0 + all.x1) / 2, (box.min.y + box.max.y) / 2 - (all.y0 + all.y1) / 2];
      if (p[0] * off[0] + p[1] * off[1] < 0) p = [-p[0], -p[1], 0];
      // a little from above, kept square to the travel
      const v = [p[0], p[1], 0.3], k = v[0] * ax[0] + v[1] * ax[1] + v[2] * ax[2];
      // the box framed: the leg and chop, stretched over the chop's travel so the opening stays centred
      const t = { x: ax[0] * travel, y: ax[1] * travel, z: ax[2] * travel }, frame = { min: { ...box.min }, max: { ...box.max } };
      for (const c of ["x", "y", "z"]) { frame.min[c] += Math.min(0, t[c]); frame.max[c] += Math.max(0, t[c]); }
      return { dir: [v[0] - k * ax[0], v[1] - k * ax[1], v[2] - k * ax[2]], frame };
    }, [vise, gap[1] - gap[0]]);
    // the move lands as "Its" is said (shortened, down to 0.8 s, when the resize ran long)
    const aimMs = Math.round(1000 * Math.min(1.3, Math.max(0.8, opensAt - onScreen())));
    const lead = opensAt - aimMs / 1000 - onScreen();
    if (lead > 0) await d.wait(lead * 1000);
    await d.api("aim", { dir: view.dir, box: view.frame, ms: aimMs, margin: 1.15 });
    await d.api("poseSweep", "viseGap", gap[0], gap[1], 2200);
    d.pick("leg vise");
    await d.api("poseSweep", "viseGap", gap[1], gap[0], 1800);
    await d.api("poseEnd");
    await d.api("aim", { dir: [0.45, -1, 0.5], ms: 1000, margin: 0.7 });
    await d.api("cursor", true);
    await d.clickEl("button", "Export ▾"); await d.wait(400);
    await d.clickEl("[role=menuitem]", "Shop drawing");
    await d.fast("drawing the views", () => d.page.waitForSelector(".drawing-sheet svg", { timeout: 60000 }));
    await d.api("cursor", false);
    await d.wait(3000);
    // the drawing stays up to the end of the clip; it closes in the cut, so the bench never flashes back
  });

  await d.cut(async () => {
    await d.run(() => window.__vibecadDemo.store.getState().closeDrawing());
    await d.api("newDocument");
    await d.run((c) => { const D = window.__vibecadDemo; D.mockAgent(c); D.view("iso"); const st = D.store.getState(); if (st.showPlanes) st.toggleShowPlanes(); }, agentCache);
    await d.settle(400);
  });
  await d.beat("agent", async () => {
    await d.lower("Ask Claude", "it builds with the same commands you do");
    await d.api("cursor", true);
    await d.clickEl(`${await d.toolbar("agent")} button`, "Agent");
    const ask = async (text, label) => {
      await d.clickEl(".agent-input textarea");
      await d.type(text, 40);
      await d.key("Enter");
      await d.fast(label, async () => {
        await d.page.waitForFunction(() => !window.__vibecadDemo.store.getState().agentRunning, null, { timeout: 120000 });
        // re-cutting the windows rebuilds the shell's three cuts, which can take longer than settle's usual 20 s
        if (!(await d.api("settle", 400, 60000, true))) d.note("settle timed out");
      });
    };
    await ask(agentCache.prompt, "Claude building");
    await d.api("aim", { dir: [1, -1, 0.45], ms: 1200, margin: 0.9 });
    await d.wait(1600);
    // the refinements, more prompts in the same conversation: the lamp shade, then windows that don't overlap
    const [shade, ...more] = agentCache.followUps ?? [];
    if (shade) {
      await ask(shade, "Claude refining");
      // hold on the shade long enough to see its windows run into each other near the corners
      await d.api("aim", { dir: [1, -1, 0.3], ms: 1200, margin: 0.85 });
      await d.wait(2000);
    }
    for (const f of more) await ask(f, "Claude fixing");
    await d.api("aim", { dir: [1, -1, 0.3], ms: 1200, margin: 0.85 });
    await d.api("turntable", 8);
    await d.wait(1200); d.pick("lamp shade");
    await d.wait(2400);
    await d.api("turntable", null);
  }, { minMs: 20000 });

  await d.beat("outro", async () => {
    await d.lower(null);
    await d.api("cursor", false);
    await d.api("titleCard", { title: "VibeCAD", subtitle: "mikepkes.github.io/CAD", chips: ["Free", "Open source (MIT)", "Browser or desktop"] });
  }, { minMs: 6000 });
}
