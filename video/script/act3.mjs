// Act 3 · The demo's showcase, rapid fire: about seven seconds per idea, mostly the bundled examples, then the mock
// agent, and the outro pointing to the tutorial.
// Loading each model is cut from the edit; slow processing is sped up with its speed shown.
// Narration: lines.mjs, by beat id.

import { readFileSync } from "node:fs";

import { existsSync } from "node:fs";

import { partsOf } from "./lines.mjs";

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

  await clip("gyroscope", "gyroscope", "Print-in-place gyroscope", "a motion study, then a section view", async () => {
    // the motion study first, on the whole gyroscope, at real speed (not sped up): with Show motion on, the rings it
    // turns sweep round as see-through ghosts, each through a full circle, while the check runs behind them. Then the
    // section, so it goes on once and never has to come off again for the study
    await d.wait(500);
    d.pick("gyroscope bearing");
    await d.cue(); // "The motion study turns every joint a full circle…"
    await d.run(async () => { const st = window.__vibecadDemo.store.getState(); st.setMotionGhost(true); await st.runMotionStudy(); });
    await d.page.waitForFunction(() => !["running", "pending"].includes(window.__vibecadDemo.store.getState().motionStatus), null, { timeout: 180000 });
    // the section: tick Section in the toolbar, cut on the level XY plane through the middle, the rings' pivot plane
    await d.api("cursor", true);
    const at = await d.toolbar("section");
    const sec = await d.rect(`${at} .grid-controls label`, "Section");
    await d.click(sec.x + 10, sec.cy);
    await d.wait(150);
    await d.cue(); // the section is on: "And cut open, each ring hangs on cone pins…"
    await d.settle(300);
    if (at.includes("menu")) { await d.key("Escape"); await d.settle(200); } // close the more menu over the view
    await d.api("cursor", false);
    // no turn to the cut: the same oblique angle as the study, pushed in once to fill the frame with what the cut
    // leaves. Both bearings show cut open at once (the cone pins of the middle ring in the frame ring, and of the
    // inner ring in the middle one)
    const kept = (await d.api("bounds")).reduce((a, b) => ({ // what the cut leaves: the model below the XY plane
      min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y), z: Math.min(a.min.z, b.min.z) },
      max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y), z: Math.min(Math.max(a.max.z, b.max.z), 0) },
    }));
    await d.api("aim", { dir: [1, -1, 1.2], box: kept, ms: 1600, margin: 0.8 });
  }, async () => {
    // the angle the whole beat holds, the whole gyroscope filling the frame from the first frame
    await d.api("aim", { dir: [1, -1, 1.2], ms: 300, margin: 0.85 });
  });
  if (hasExample("clockwork")) {
    // the knob turns at one steady rate through the beat, a third of the last cut's (its average was about 147 deg/s)
    const RATE = 48; // deg of turn a second
    const GENEVA = ["Geneva crank", "Geneva star"];
    // the line's two groups, the gear train then the Geneva drive: the second is cued as the first has been said,
    // and the beat ends as it has been said in turn, with the tail
    const [say1, say2] = partsOf(d.lines.clockwork).map((p, k) => d.partMs("clockwork", k, p));
    const cueAt = (say1 + 150) / 1000, end = cueAt + (say2 + 500) / 1000;
    // the Geneva crank turns at -5/8 of the knob, so the star steps once per 576 deg of turn, mid-step at 288 (mod
    // 576), over 144 deg (3 s at this rate). The knob starts where its step comes 1.6 s after the cue: the star
    // flicks round under "turns steady motion into steps"
    let from = 288 - RATE * (cueAt + 1.6);
    while (from < -288) from += 576;
    const setup = async () => {
      await d.api("poseSweep", "turn", 0, from, 150, { ease: false });
      // the whole model, pushed in to fill the frame side to side (by the frame and gears: the rack slides as they turn)
      await d.api("aim", { dir: [0.2, -0.5, 1], frame: [0.07, 0.04, 0.9, 1.03], except: ["Rack"], ms: 300 });
    };
    await clip("clockwork", "clockwork", "Gears of every kind", "spur, helical, herringbone, ring, rack, bevel, worm, and a Geneva drive", async () => {
      // two shots: the whole train, held still while every gear turns and the rack runs back and forth on its Scotch
      // yoke, then in on the Geneva drive. The gears are posed from the turn parameter (not rebuilt) by one sweep
      // for the whole beat, the camera moving while it runs
      const t0 = d.now();
      const sweep = d.api("poseSweep", "turn", from, from + RATE * end, Math.round(end * 1000), { ease: false });
      await d.wait(2500); d.pick("clockwork");
      await d.cue(); // "And a Geneva drive turns steady motion into steps."
      await d.api("aim", { dir: [0.1, -0.55, 1], frame: [0.25, 0.12, 0.75, 0.8], parts: GENEVA, ms: 1000 });
      await sweep;
      if (d.now() - t0 > end + 0.3) d.note(`clockwork: the gears ran ${(d.now() - t0 - end).toFixed(1)} s past the line`);
    }, setup);
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
  /** Wait (inside a load's cut) until the "Opened …" toast has gone: a short beat would otherwise open under it. */
  const noToast = () => d.page.waitForFunction(() => !document.querySelector(".toast"), null, { timeout: 6000 }).catch(() => {});
  if (hasExample("walker")) {
    let leg = null; // found while the model loads (inside its cut): the beat's picture never waits on it
    await clip("walker", "walker", "Jansen wind walker", "one crank, twelve legs, overlapping strides", async () => {
      // posed from the crank angle: the legs' joint positions are parameters that follow `t`. The crank never stops
      // or changes speed. The whole walker while "one crank drives twelve legs"; as that's said, every leg but one
      // and the frame fade out (display only: nothing rebuilds, so no cut) while the camera moves in on that one
      // leg, and the second group ("Each foot glides along the ground, then lifts and swings forward") is cued as
      // the close-up lands, so the leg's foot glides and swings under it. The close-up holds most of the beat.
      // Timed from the default voice's clip lengths (seconds into the beat).
      const t0 = d.timing.events.findLast((e) => e.kind === "beat")?.t ?? d.now(); // the line starts with the beat
      const [m1, m2] = d.speech.ms.map((ms) => ms / 1000);
      const tClose = Math.max(1.8, m1 - 1.0), tCue = Math.max(tClose + 1.3, m1 + 0.15), tEnd = tCue + m2 + 0.5;
      // about 100°/s, a whole number of turns by the end: the built pose, so putting the parts back shows no jump
      const v = (360 * Math.max(1, Math.round((tEnd * 100) / 360))) / tEnd;
      let at = 0;
      const turn = async (s) => { // the crank, at its steady rate, until `s` into the line (an overrun is made up by the next)
        const to = v * s;
        await d.api("poseSweep", "t", at, to, Math.max(150, Math.round((t0 + s - d.now()) * 1000)), { ease: false });
        at = to;
      };
      // the crank runs on its own clock, through the cue's wait
      const crank = turn(tClose).then(() => turn(tEnd));
      await d.api("aim", { dir: [0.5, -1, 0.3], ms: Math.round(tClose * 1000) - 100, margin: 0.85 });
      d.pick("walker");
      if (!leg) { d.note("walker: no leg assembly found among the example's components; the whole walker kept turning"); console.error("  ✗ walker: no leg assembly found"); }
      else d.event("view", `one leg: ${leg.name}`);
      // the rest fade out as the camera comes in from the side, along the crank axis, so the leg's linkage reads;
      // then a slow push in from lower down, through "glides along the ground … swings forward"
      const close = leg && Promise.all([
        d.api("fadeComponents", leg.fade, 0, 900),
        d.api("aim", { dir: [0.25, -1, 0.12], box: leg.box, ms: 1500, margin: 1.15 })
          .then(() => d.api("aim", { dir: [0.4, -1, 0.02], box: leg.box, ms: Math.max(1500, Math.round((tEnd - tClose - 1.6) * 1000)), margin: 1.05 })),
      ]);
      await d.wait(Math.max(0, (t0 + tCue - d.now()) * 1000));
      await d.cue();
      await Promise.all([close, crank]);
      await d.api("poseEnd"); // the others stay faded out: nothing pops back
    }, async () => { // the leg, and the others' see-through look compiled here, so the fade starts without a stall
      leg = await walkerLeg();
      if (!leg) return;
      // posed already (at the built pose, so nothing moves), and what will fade drawn a hair see-through: each part's
      // see-through copy is made and drawn here, in the cut, not on the frame the fade starts (a half-second hitch)
      await d.api("poseSweep", "t", 0, 0, 1);
      await d.api("fadeComponents", leg.fade, 0.99, 0);
      await d.settle(200, { camera: false });
      await noToast();
    });
  } else d.note("no walker example yet: walker clip skipped");
  await clip("skadis", "skadis", "SKÅDIS gravity holder", "the load's own weight closes the grip", async () => {
    // cued to the line's three sentence groups: the whole holder while "a pegboard holder that grips by weight", the
    // cover going see-through as the camera closes in; then (group 2) the rack drops between the pinions behind it on
    // "the load pushes a rack down between two pinions" and the pads shut on "clamp it"; then (group 3) out to a
    // three-quarter view, the parts sliding apart along the way they go together on "every part prints, pins included":
    // the pins that go in from behind, the rack and arms, the cover, foot and pads, and the shouldered pins in front
    const works = await d.api("componentBox", ["Back plate", "Lower arm*", "Upper arm*"]);
    const out = -1; // -y: out from the board, toward the viewer
    const explode = {
      "Foot pin*": [0, 20 * out, 0], "Pad pin*": [0, 20 * out, 0],
      Linkage: [0, 45 * out, 0],
      Cover: [0, 95 * out, 0], Foot: [0, 95 * out, 0],
      "Pad, right": [70, 95 * out, 0], "Pad, left": [-70, 95 * out, 0], // and aside, so they don't hide the middle
      "Pivot pin*": [0, 135 * out, 0], "Guide pin*": [0, 135 * out, 0],
      "Stand-in item*": [0, 95 * out, 250], // lifted up out of the frame: not a part
    };
    await d.api("aim", { dir: [0.25, -1, 0.35], ms: 900, margin: 0.9 });
    await Promise.all([d.api("poseGhost", ["Cover"], 0, 1, 1000), d.api("aim", { dir: [0.1, -1, 0.2], box: works, ms: 1300, margin: 1.15 })]);
    await d.cue(); // "the load pushes a rack down between two pinions, swinging the pads in to clamp it"
    d.event("view", "cover see-through: the rack and pinions");
    const drop = d.api("poseSweep", "drop", 0, 6.4, 4200);
    await d.wait(1600);
    d.pick("skadis holder");
    await drop;
    // the printed parts' box, as far apart as they'll go (about: the pads go aside as well as out)
    const parts = await d.api("componentBox", ["Back plate", "Lower arm*", "Upper arm*", "Foot"]); // the item stands clear
    const apart = { min: { ...parts.min, x: parts.min.x - 70, y: parts.min.y + 95 * out }, max: { ...parts.max, x: parts.max.x + 70 } };
    const back = Promise.all([d.api("poseGhost", ["Cover"], 1, 0, 900), d.api("aim", { dir: [0.75, -1, 0.4], box: apart, ms: 1600, margin: 0.85 })]);
    await d.cue(); // "Every part prints, pins included."
    d.event("view", "exploded along the assembly");
    await d.api("poseExplode", explode, 1, 1400);
    await back;
    // held apart to the end: the next clip's load puts the parts back (openText ends the pose)
  });
  // the handlebar's construction, from the example's own features: the bar's 3D sweep and the right grip's. Each
  // sweep's path sketch, shown, draws its spine and its sections on it (core/sweepGuides); they're shown inside the
  // load's cut and faded out, so the beat opens on the finished cockpit.
  let bar = null;
  await clip("handlebar", "handlebar", "Bike handlebar", "a 3D sweep with a tapering section, a wrapped hex grip", async () => {
    // "A bike cockpit, in organic surfaces": the whole cockpit, turning. "The bar sweeps a tapering section along a 3D
    // curve" (cued): everything else fades away and the bar with it, leaving its spine and the profile along it,
    // shrinking from the clamp to the grips; then the swept bar fades in over them. "and the grips wear a hex pattern
    // wrapped round them" (cued): in on the right grip, its five sections on its axis, then the rubber grip, hex and
    // all, fading in over them as the rest of the cockpit comes back
    const t0 = d.timing.events.findLast((e) => e.kind === "beat")?.t ?? d.now();
    const at = (s) => d.wait(Math.max(0, (t0 + s - d.now()) * 1000));
    const fade = (ids, to, ms) => d.api("fadeComponents", ids, to, ms);
    await d.api("aim", { dir: [0.35, -1, 0.6], ms: 1200, margin: 0.72 });
    await d.api("turntable", 8);
    await at(Math.max(1.4, d.speech.ms[0] / 1000 - 0.9));
    await d.api("turntable", null); // eases to a stop by the cue
    await d.cue();
    if (!bar) { d.note("handlebar: no 3D sweeps found"); return; }
    d.event("view", "the bar's spine and tapering sections");
    await Promise.all([
      fade([...bar.rest, ...bar.grip, bar.barBody], 0, 700),
      fade([bar.barPath], 1, 700),
      // the bar side to side, from in front and above, so its rise and sweep read
      d.api("aim", { dir: [0.2, -1, 0.55], frame: [0.04, 0.2, 0.96, 0.8], parts: ["Bar"], ms: 1300 }),
    ]);
    await d.wait(700);
    d.event("view", "the swept bar");
    await Promise.all([fade([bar.barBody], 1, 900), fade([bar.barPath], 0.35, 900)]);
    d.pick("handlebar sweep");
    await d.cue();
    d.event("view", "the grip's sections, then the grip");
    await Promise.all([
      fade([bar.gripPath], 1, 600), fade([bar.barPath], 0, 600),
      d.api("aim", { dir: [0.75, -0.9, 0.45], box: bar.gripBox, ms: 1000, margin: 0.85 }),
    ]);
    await d.wait(400); // the five sections on the grip's axis, round at the collar, swelling into the palm wing
    await Promise.all([fade(bar.grip, 1, 900), fade(bar.rest, 1, 900), fade([bar.gripPath], 0, 900)]);
    d.pick("handlebar grip");
    await d.api("turntable", 10);
    await d.wait(700);
    await d.api("turntable", null);
  }, async () => {
    // show the bar's and the right grip's path sketches (each draws its sweep's construction), faded out to start
    bar = await d.run(async () => {
      const D = window.__vibecadDemo, st = D.store.getState(), doc = st.session.doc;
      const sweep = (n) => Object.values(doc.features).find((f) => f.kind === "sweep" && f.path3d && f.name === n);
      const b = sweep("Bar"), g = sweep("Grip R");
      if (!b || !g) return null;
      const compOf = (f) => doc.sketches[f.pathSketch]?.componentId;
      await st.setVisibility([b.pathSketch, g.pathSketch], true);
      const top = doc.components[doc.rootComponentId]?.children ?? [];
      const cockpit = top.length === 1 ? doc.components[top[0]]?.children ?? [] : top; // the parts, under one assembly
      return {
        barPath: b.pathSketch, gripPath: g.pathSketch, barBody: b.id,
        // the grip's bodies, not its component: that would fade its path sketch along with it
        grip: D.componentBodies(["Grip R"]), rest: cockpit.filter((c) => c !== compOf(b) && c !== compOf(g)),
        barBox: D.bounds(b.id), gripBox: D.componentBox(["Grip R", "Collar R", "End plug R"]),
      };
    });
    if (!bar) return;
    await d.settle(200);
    // all but gone, not gone: a guide still drawn has its see-through look compiled, so it fades in without a stall
    await d.api("fadeComponents", [bar.barPath, bar.gripPath], 0.004, 0);
    // what will fade, drawn a hair see-through: its see-through copies are made here, in the cut, not on the frame
    // the fade starts
    await d.api("fadeComponents", [...bar.rest, ...bar.grip, bar.barBody], 0.99, 0);
    await d.settle(200);
    await noToast();
  });
  // one sentence (about 3.4 s): the whole fold under it, the camera swinging round to the finished dart as it folds
  // posed flat inside the load's cut: the saved example is the finished dart
  await load(d, "origami", async () => { await d.api("poseSweep", "fold", 6, 0, 1); await noToast(); });
  await d.beat("origami", async () => {
    await d.lower("Paper airplane", "a flat sheet to a finished dart, fold by fold");
    d.pick("origami folds", { len: 2.2, speed: 3 }); // the whole fold, sped up: the montage's longer shot
    const ms = Math.max(2400, d.speech.ms[0] - 200);
    await Promise.all([
      d.api("poseSweep", "fold", 0, 6, ms, { ease: false }),
      // framed by the built dart's box: room to spare for the flat sheet, closing in as it folds to the dart
      d.api("aim", { dir: [0.4, -0.8, 0.9], ms: 700, margin: 1.3 }).then(() => d.api("aim", { dir: [0.8, -0.5, 0.45], ms: ms - 600, margin: 0.85 })),
    ]);
    await d.wait(300);
    await d.api("poseEnd");
  });
  // the stage count grows the lift, so the camera dollies out ahead of the new stages and back in once they're gone
  const liftView = { dir: [1, -1, 0.8], margin: 1.2 }; // the iso view, a little room round the lift
  const setStages = (n) => d.run(async (x) => { await window.__vibecadDemo.store.getState().setParameterExpr("stages", String(x)); }, n);
  const liftBox = () => d.run(() => window.__vibecadDemo.bounds().reduce((a, b) => ({
    min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y), z: Math.min(a.min.z, b.min.z) },
    max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y), z: Math.max(a.max.z, b.max.z) },
  })));
  // a glide that doesn't wait: the stages keep changing under it
  const dolly = (box, ms) => { d.event("view", "aim"); return d.run((o) => { window.__vibecadDemo.aim(o); }, { ...liftView, box, ms }); };
  await load(d, "scissor-jointed", noToast);
  const lift = await d.cut(async () => { // the lift's box at each stage count, built off camera; then framed at three
    const boxes = {};
    for (const n of [4, 5, 3]) { await setStages(n); await d.settle(100); boxes[n] = await liftBox(); }
    await d.api("aim", { ...liftView, box: boxes[3], ms: 300 });
    return boxes;
  });
  await d.beat("scissor-jointed", async () => {
    await d.lower("Jointed scissor lift", "the stage count is a slider, and it still moves");
    // about 4 s in all, for a 3 s line: the stage count 3→4→5→4→3 (as `sweep`), out to five stages across the first
    // two steps, then in to three once the fifth is gone; then one quick close and open
    const values = [3, 4, 5, 4, 3], ms = 2000, step = ms / values.length, t0 = Date.now(), start = d.now();
    await dolly(lift[5], 2 * step);
    for (const [i, v] of values.entries()) {
      const t = Date.now();
      await setStages(v);
      await d.settle(60, { camera: false });
      if (i === 3) await dolly(lift[3], 2 * step);
      const left = step - (Date.now() - t);
      if (left > 0) await d.wait(left);
    }
    if (Date.now() - t0 > ms * 1.6) d.timing.fast.push({ label: "rebuilding stages", start, end: d.now() });
    // the opening angle drives the stamped joints: the bars swing at display rate, no rebuild (closed and open again,
    // ending on the built 40°, so putting the parts back shows no jump)
    d.pick("scissor lift");
    await d.api("poseSweep", "theta", 40, 24, 900);
    await d.api("poseSweep", "theta", 24, 40, 900);
    await d.api("poseEnd");
  });
  // one sentence (about 3.3 s): no minimum, the beat is its line
  await load(d, "starbox", noToast);
  await d.beat("starbox", async () => {
    await d.lower("Snap-together star box", "snaps sized for each material");
    // each width is a rebuild of a couple of seconds: one sweep out and back, sped up as a whole to fit the line
    d.pick("star box"); await sweep(d, "width", [76, 88, 76, 64], 2600);
  });

  // the bistable switch: ask Claude, which opens the force analysis itself (set_panel / run_action), sweeps it, and puts the lens on strain
  await d.cut(async () => {
    await load(d, "bistable");
    await d.clickEl(".side-toggle.right"); // the Mechanism tab lives in the right panel
    await d.run((c) => window.__vibecadDemo.mockAgent(c), forcesCache);
    await d.run(() => { const st = window.__vibecadDemo.store.getState(); if (!st.agentOpen) st.toggleAgent(); }); // Claude's panel open
    await d.settle(300);
  });
  // the line's three groups land on the prompt, the analysis opening (the callout on "bistable switch") and the marks
  await d.beat("bistable-forces", async () => {
    await d.api("cursor", true);
    await d.clickEl(".agent-input textarea");
    await d.type(forcesCache.prompt, 40);
    await d.key("Enter");
    await d.cue(); // it runs the force analysis on a bistable switch
    const g2 = d.now();
    await d.api("cursor", false);
    // at speed until Claude opens the analysis (its first tool call); the callout as the line names the switch
    // ("bistable switch" ends 2.4 s into its group, in the default voice)
    await d.page.waitForFunction(() => window.__vibecadDemo.ui.getState().panels.mechanism, null, { timeout: 60000 }).catch(() => d.note("no mechanism panel"));
    const early = 2450 - d.screenSince(g2);
    if (early > 0) await d.wait(early);
    await d.lower("Bistable switch", "Claude opens the force analysis for you");
    await d.fast("Claude working", async () => {
      await d.page.waitForFunction(() => !window.__vibecadDemo.store.getState().agentRunning, null, { timeout: 120000 });
      await d.page.waitForSelector("[data-testid=rest-marker]", { timeout: 60000 }).catch(() => d.note("no rest markers"));
      await d.page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Sweep travel"), null, { timeout: 60000 }).catch(() => d.note("sweep did not finish"));
    });
    await d.cue(); // and marks both rest positions and the snap force
    await d.wait(300); d.pick("force analysis");
  });
  // off camera: Claude's panel closes, the switch is pushed part way (3.5 mm, near the snap) so its blades are strained
  // and the strain lens reads a share of the limit, and its material's editor opens on the print direction (Z: flat
  // on the bed, as the example saves it)
  await d.cut(async () => {
    await d.run(async () => {
      const D = window.__vibecadDemo, st = D.store.getState();
      if (st.agentOpen) st.toggleAgent();
      await st.setParameterExpr("travel", "3.5");
      D.ui.getState().togglePanel("materials", true);
    });
    await d.settle(300);
    await d.clickEl("button[aria-label^='Edit TPU 68D']");
    await d.settle(300);
  });
  await d.beat("print-direction", async () => {
    await d.lower("Print direction", "the strain study knows a print is weaker across its layers");
    await d.api("cursor", true);
    await d.cue(); // Stand it on end: printed along X, its blades are pulled across their layers
    await d.clickEl("[aria-label='Print direction'] button", "=X");
    await d.settle(400); await d.wait(300);
    await d.clickEl(".k-tabs button", "Mechanism"); await d.settle(300); // the same strain, a bigger share of a lower limit
    await d.api("cursor", false);
  });
  await d.cut(async () => {
    await d.run(() => { const D = window.__vibecadDemo; D.ui.getState().togglePanel("lens", false); D.ui.getState().togglePanel("mechanism", false); D.ui.getState().togglePanel("materials", false); D.store.getState().agentOpen && D.store.getState().toggleAgent(); });
    await d.clickEl(".side-toggle.right");
  });

  // one sentence (about 3.5 s): no minimum, the beat is its line
  await load(d, "gimbal", noToast);
  await d.beat("gimbal", async () => {
    await d.lower("Flexure gimbal", "steers a mirror on eight blades");
    await sweep(d, "alpha", there(-8, 8, 4), 1600); d.pick("gimbal"); await sweep(d, "beta", there(-8, 8, 4), 1600);
  });
  // the workbench, from one camera angle: the whole bench seen from the end its leg vise is on, the vise standing open
  // its full 170 mm so its threaded screw shows. The length resizes it, then the shop drawing opens on its words.
  await load(d, "roubo", async () => {
    await d.run(async () => { await window.__vibecadDemo.store.getState().setParameterExpr("viseGap", "170"); });
    await d.settle(300);
    await d.api("aim", { dir: [-1, -0.4, 0.4], ms: 300, margin: 0.85 }); // the left end: square across the vise's gap
    await noToast();
  });
  await d.beat("roubo", async () => {
    await d.lower("Roubo workbench", "resized from its length, with the shop drawing to build it from");
    await sweep(d, "L", there(1700, 2100, 3), 2000);
    d.pick("workbench");
    await d.api("cursor", true);
    await d.clickEl("button", "Export ▾");
    await d.cue(); // with its shop drawing and cut list straight from the model
    await d.clickEl("[role=menuitem]", "Shop drawing");
    await d.fast("drawing the views", () => d.page.waitForSelector(".drawing-sheet svg", { timeout: 60000 }));
    await d.api("cursor", false);
    await d.wait(500);
    // the drawing stays up to the end of the beat; it closes in the cut, so the bench never flashes back
  });

  await d.cut(async () => {
    await d.run(() => window.__vibecadDemo.store.getState().closeDrawing());
    await d.api("newDocument");
    await d.run((c) => { const D = window.__vibecadDemo; D.mockAgent(c); D.view("iso"); const st = D.store.getState(); if (st.showPlanes) st.toggleShowPlanes(); }, agentCache);
    // PUPPET: the panel opens off camera (the bistable beat already showed the Agent button), its prompt box focused,
    // so the beat starts on the typing
    await d.run(() => { const st = window.__vibecadDemo.store.getState(); if (!st.agentOpen) st.toggleAgent(); });
    await d.settle(300);
    await d.clickEl(".agent-input textarea");
  });
  await d.beat("agent", async () => {
    // Four sentence groups, each cued to what it names: the vase as its prompt is typed and built; the lamp shade and
    // the Voronoi pattern each as its prompt is sent, so "cuts the windows" and "wraps the cells" land as that result
    // appears; the parametric model as its parameters and history open. The prompts are typed fast and the builds sped
    // up (Claude's turns and the rebuilds take about 14, 50 and 70 s live; at most 3 s on screen each, with the speed
    // chyron), so the line, not the waiting, sets the beat's length.
    await d.lower("Ask Claude", "it builds with the same commands you do");
    await d.api("cursor", true);
    const build = (label) => d.fast(label, async () => {
      await d.page.waitForFunction(() => !window.__vibecadDemo.store.getState().agentRunning, null, { timeout: 120000 });
      // the window cuts, and then the Voronoi openings (one boolean of ~50 cutters through the twisted shell's
      // spline walls), take far longer than settle's usual 20 s
      if (!(await d.api("settle", 400, 150000, true))) d.note("settle timed out");
    });
    // a prompt typed in about `ms`, a few characters a keystroke (a long prompt at typing speed would hold the beat)
    const typeIn = async (text, ms) => {
      d.event("type", text);
      const n = Math.ceil(text.length / 4);
      for (let i = 0; i < text.length; i += 4) {
        const t = Date.now();
        await d.page.keyboard.type(text.slice(i, i + 4));
        const left = ms / n - (Date.now() - t);
        if (left > 0) await d.wait(left);
      }
    };
    const prompt = async (text, ms) => { await d.clickEl(".agent-input textarea", undefined, { ms: 250 }); await typeIn(text, ms); };
    // "Or just describe it: Claude builds a twisted vase with the same commands you use": typed under "describe it",
    // sent by "Claude builds", its commands streaming into the panel under "the same commands you use"
    await typeIn(agentCache.prompt, 1500);
    await d.key("Enter");
    await build("Claude building");
    // the refinements, more prompts in the same conversation: the lamp shade, then its holes as a Voronoi pattern
    const [shade, voronoi] = agentCache.followUps ?? [];
    if (shade) {
      // the vase turns to three-quarters while the next prompt is typed
      await Promise.all([d.api("aim", { dir: [1, -1, 0.45], ms: 1200, margin: 0.9 }), prompt(shade, 1000)]);
      await d.cue(); // "Ask for a lamp shade, and it cuts the windows."
      await d.key("Enter");
      await build("Claude cutting windows");
    }
    if (voronoi) {
      // in a little lower, its rows of round windows held a moment before the Voronoi prompt is typed
      await Promise.all([d.api("aim", { dir: [1, -1, 0.3], ms: 1200, margin: 0.85 }), (async () => { await d.wait(900); await prompt(voronoi, 600); })()]);
      await d.cue(); // "Ask for a Voronoi pattern instead, and it wraps the cells round the shade."
      await d.key("Enter");
      await build("Claude laying out the cells");
    }
    // the Voronoi shade: turn it round so the cells are seen wrapping all the way, leaning with the twist
    await d.api("aim", { dir: [1, -1, 0.3], ms: 900, margin: 0.85 });
    await d.api("turntable", 14);
    d.pick("Voronoi lamp shade");
    await d.cue(); // "The result is still an ordinary parametric model."
    // its parameters, and planes placed by expressions of them, in the left panel; the shade framed again between it and
    // the agent panel (the callout would cover the parameters)
    await d.lower(null);
    await Promise.all([d.clickEl(".side-toggle.left", undefined, { ms: 350 }), d.api("turntable", null)]);
    await d.api("cursor", false);
    // frame: fractions of the window, the gap between the left panel (to 0.22) and the agent panel (from 0.75)
    await d.api("aim", { dir: [1, -1, 0.3], frame: [0.26, 0.1, 0.73, 0.95], ms: 800 });
    await d.api("turntable", 10);
    await d.wait(1200);
    await d.api("turntable", null);
  });

  // the call to action: where to get it, said over the card that shows it; then (group 2) the tutorial joins the card as
  // "watch the phone stand tutorial" is said
  const getIt = { title: "Get VibeCAD", subtitle: "mikepkes.github.io/CAD   ·   desktop app: GitHub Releases", chips: ["Free", "Open source (MIT)", "Browser or desktop"] };
  await d.beat("outro", async () => {
    await d.lower(null);
    await d.api("cursor", false);
    await d.api("titleCard", getIt);
    await d.cue(); // "To build your first model, watch the phone stand tutorial. Thanks for watching."
    await d.wait(1200);
    await d.api("titleCard", { ...getIt, chips: [...getIt.chips, "Next: the phone stand tutorial"] });
  }, { minMs: 6000 });
}
