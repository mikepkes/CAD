// Act 3 · The demo's showcase, rapid fire: about seven seconds per idea, mostly the bundled examples, then the mock
// agent, and the outro pointing to the tutorial.
// Loading each model is cut from the edit; slow processing is sped up with its speed shown.
// Narration: lines.mjs, by beat id.

import { readFileSync } from "node:fs";

import { existsSync } from "node:fs";

const agentCache = JSON.parse(readFileSync(new URL("../mock/agent-vase.json", import.meta.url), "utf8"));
const forcesCache = JSON.parse(readFileSync(new URL("../mock/agent-bistable-forces.json", import.meta.url), "utf8"));
const hasExample = (name) => existsSync(new URL(`../../public/examples/${name}.json`, import.meta.url));

async function load(d, name) {
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

  const clip = async (id, name, title, sub, act) => {
    await load(d, name);
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
      await d.run(async () => { await window.__vibecadDemo.store.getState().runMotionStudy(); });
      await d.page.waitForFunction(() => !["running", "pending"].includes(window.__vibecadDemo.store.getState().motionStatus), null, { timeout: 180000 });
    });
    await d.wait(1200);
  });
  if (hasExample("clockwork")) {
    await clip("clockwork", "clockwork", "Gears of every kind", "spur, helical, herringbone, ring, rack, bevel, worm, and a Geneva drive", async () => {
      // no turntable: the camera holds still and only the gears move (posed from the turn parameter, not rebuilt)
      await d.api("aim", { dir: [0.2, -0.5, 1], ms: 1200, margin: 0.8 });
      await d.api("poseSweep", "turn", 0, 360, 5200, { ease: false });
      d.pick("clockwork");
      await d.api("poseSweep", "turn", 360, 540, 1800, { ease: false });
      await d.api("aim", { dir: [0.15, -0.35, 1], box: await d.api("componentBox", ["Ring", "Planet 1", "Planet 2", "Planet 3", "Carrier"]), ms: 1400, margin: 0.85 });
      await d.api("poseSweep", "turn", 540, 900, 4000, { ease: false });
      await d.api("aim", { dir: [0.5, -0.6, 0.75], box: await d.api("componentBox", ["Cross shaft", "Wheel"]), ms: 1600, margin: 0.9 });
      await d.api("poseSweep", "turn", 900, 1620, 2500, { ease: false });
      await d.api("poseSweep", "turn", 1620, 2340, 2500, { ease: false });
      // the crank turns at −5/8 of the knob: three steps of the star in 1728° of turn
      await d.api("aim", { dir: [0.1, -0.55, 1], box: await d.api("componentBox", ["Geneva crank", "Geneva star"]), ms: 1500, margin: 1.05 });
      await d.api("poseSweep", "turn", 2340, 3204, 3000, { ease: false });
      await d.api("poseSweep", "turn", 3204, 4068, 3000, { ease: false });
    });
  } else d.note("no clockwork example yet: gears clip skipped");
  /**
   * The walker's leg nearest the camera (lowest y: the side its close-up looks from), found by the example's
   * structure, not by ids: a leg is a parent component named like one ("Leg w0", its bars as children), else the
   * components sharing a leg tag, the first word with a digit in their names ("Rocker w0" … "Foot w0"; "w0m" its
   * mirror). Parts jointed to one leg's bars only (pins) go with that leg. Returns its name, its world box at the
   * built pose, and what to hide for its close-up: every other leg (top ids), the fixed bodies between it and the
   * camera (the frame, whose end wall covers the leg's upper bars) and the sketches still shown (each bar's outline
   * stays at the built pose while the posed bar moves); null when fewer than two legs are found.
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
    }).map((b) => b.featureId.split("/")[0]);
    const sketches = Object.values(doc.sketches).filter((sk) => !others.some((l) => l.ids.has(sk.componentId))).map((sk) => sk.id);
    return { name: near.name, box: near.box, hide: [...others.flatMap((l) => l.top), ...new Set(front), ...sketches] };
  });
  if (hasExample("walker")) {
    await clip("walker", "walker", "Jansen wind walker", "one crank, twelve legs, overlapping strides", async () => {
      // posed from the crank angle: the legs' joint positions are parameters that follow `t`. The crank never stops
      // (120°/s, then 90°/s on the one leg): the camera moves while it turns, and the hiding is cut from the edit.
      const turn = (from, to, ms) => d.api("poseSweep", "t", from, to, ms, { ease: false });
      await Promise.all([d.api("aim", { dir: [0.35, -1, 0.3], ms: 1000, margin: 0.85 }), turn(0, 360, 3000)]);
      d.pick("walker");
      await Promise.all([d.api("aim", { dir: [0.9, -0.6, 0.15], ms: 1500, margin: 0.8 }), turn(360, 720, 3000)]);
      await turn(720, 1440, 6000);
      // "…while the rest lift and swing forward": every leg but one goes, and the camera closes in on that one
      const leg = await d.cut(async () => {
        const found = await walkerLeg();
        if (!found) return null;
        // PUPPET: hidden by command, as clicking their eye toggles in the browser would (the panels are closed for
        // the montage). Hiding re-evaluates the document (seconds, frozen): cut, and the crank resumes where it was.
        await d.run(async (ids) => { await window.__vibecadDemo.store.getState().setVisibility(ids, false); }, found.hide);
        await turn(1440, 1440, 1); // re-pose the visible bodies inside the cut too
        return found;
      });
      if (!leg) { d.note("walker: no leg assembly found among the example's components; the whole walker kept turning"); console.error("  ✗ walker: no leg assembly found"); }
      else d.event("view", `one leg: ${leg.name}`);
      // in from the side, along the crank axis, so the leg's linkage reads; it ends on a whole turn (the built pose),
      // so putting the parts back shows no jump
      await Promise.all([leg && d.api("aim", { dir: [0.25, -1, 0.12], box: leg.box, ms: 1400, margin: 1.15 }), turn(1440, 1800, 4000)]);
      await d.api("poseEnd");
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
    await d.api("aim", { dir: [0.3, -1, 0.55], ms: 1000, margin: 0.8 });
    await d.api("turntable", 10);
    await d.wait(2600);
    await d.api("turntable", null);
    await d.api("aim", { dir: [0.6, -0.8, 0.5], box: await d.api("componentBox", ["Grip R", "Collar R", "End plug R"]), ms: 1800, margin: 1.1 });
    await d.wait(500); d.pick("handlebar grip");
    await d.wait(1600);
    await d.api("aim", { dir: [0.2, -0.7, 0.9], box: await d.api("componentBox", ["Stem", "Faceplate", "Faceplate bolts", "Top cap"]), ms: 1600, margin: 1.2 });
    await d.wait(1200);
  });
  await clip("origami", "origami", "Paper airplane", "a flat sheet to a finished dart, fold by fold", async () => {
    await d.api("poseSweep", "fold", 6, 0, 1); // start flat
    await d.api("aim", { dir: [0.4, -0.8, 0.9], ms: 900, margin: 0.75 });
    d.pick("origami folds", { len: 2.2, speed: 3 }); // the whole fold, sped up: the montage's longer shot
    await d.api("poseSweep", "fold", 0, 6, 6600, { ease: false });
    await d.api("aim", { dir: [0.8, -0.5, 0.45], ms: 1500, margin: 0.85 });
    await d.wait(800);
    await d.api("poseEnd");
  });
  await clip("scissor-jointed", "scissor-jointed", "Jointed scissor lift", "the stage count is a slider, and it still moves", async () => { await sweep(d, "stages", [3, 4, 5, 4, 3], 2600); d.pick("scissor lift"); await sweep(d, "theta", there(40, 22, 6), 2600); });
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
    await d.api("aim", { dir: [0.45, -1, 0.5], ms: 1000, margin: 0.7 });
    await sweep(d, "L", there(1700, 2100, 4), 2400);
    // in on the leg vise while it opens and closes (posed, not rebuilt)
    await d.api("aim", { dir: [-0.45, -1, 0.4], box: await d.api("componentBox", ["Vise chop", "Leg FL"]), ms: 1600, margin: 1.2 });
    await d.api("poseSweep", "viseGap", 60, 170, 2200);
    d.pick("leg vise");
    await d.api("poseSweep", "viseGap", 170, 60, 1800);
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
        await d.settle(400);
      });
    };
    await ask(agentCache.prompt, "Claude building");
    await d.api("aim", { dir: [1, -1, 0.45], ms: 1200, margin: 0.9 });
    await d.wait(1600);
    // the refinement: a second prompt in the same conversation
    for (const f of agentCache.followUps ?? []) await ask(f, "Claude refining");
    await d.api("aim", { dir: [1, -1, 0.3], ms: 1200, margin: 0.85 });
    await d.api("turntable", 8);
    await d.wait(1200); d.pick("lamp shade");
    await d.wait(2400);
    await d.api("turntable", null);
  }, { minMs: 14000 });

  await d.beat("outro", async () => {
    await d.lower(null);
    await d.api("cursor", false);
    await d.api("titleCard", { title: "VibeCAD", subtitle: "mikepkes.github.io/CAD", chips: ["Free", "Open source (MIT)", "Browser or desktop"] });
  }, { minMs: 6000 });
}
