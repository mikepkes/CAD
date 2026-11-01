// Act 3 · Rapid fire: about seven seconds per idea, mostly the bundled examples, then the mock agent.
// Loading each model is cut from the edit; slow processing is sped up with its speed shown.

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

  const clip = async (id, name, title, sub, narration, act) => {
    await load(d, name);
    await d.beat(id, narration, async () => { await d.lower(title, sub); await act(); }, { minMs: 6500 });
  };

  await clip("gyroscope", "gyroscope", "Print-in-place gyroscope", "a section view, then a motion study", "A gyroscope that prints in one piece, already assembled. Cut it open and turn square to the cut: each ring hangs on cone pins that come to a point inside a socket, with just enough clearance to spin. Then the motion study turns every joint through a full circle and checks that nothing collides.", async () => {
    // the section: tick Section in the toolbar, cut on the vertical XZ plane through the middle
    await d.api("cursor", true);
    const sec = await d.rect(".grid-controls label", "Section");
    await d.click(sec.x + 10, sec.cy);
    await d.settle(300);
    const plane = d.page.locator(".grid-controls select[title='Section plane']"), pb = await plane.boundingBox();
    await d.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
    await plane.selectOption("XZ");
    await d.settle(300);
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
    await clip("clockwork", "clockwork", "Gears of every kind", "spur, helical, herringbone, ring, rack, bevel, worm, and a Geneva drive", "Gears of every kind, generated from a module and a tooth count, and geared together by expressions, so one number turns the whole train. The planets roll inside the ring gear, and the worm creeps its wheel round at a fraction of the speed. And a Geneva drive turns steady motion into steps: the pin catches a slot, flicks the star a quarter turn, and the locking disc holds it still until the next.", async () => {
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
  await clip("scissor-jointed", "scissor-jointed", "Jointed scissor lift", "the stage count is a slider, and it still moves", "A scissor lift where even the number of stages is a slider, patterned as a jointed assembly that still moves.", async () => { await sweep(d, "stages", [3, 4, 5, 4, 3], 2600); d.pick("scissor lift"); await sweep(d, "theta", there(40, 22, 6), 2600); });
  await clip("starbox", "starbox", "Snap-together star box", "snaps sized for each material", "A box that snaps together, with every snap sized for the material you print it in.", async () => { await sweep(d, "width", [64, 76], 900); d.pick("star box"); await sweep(d, "width", [88, 76, 64], 2100); });

  // the bistable switch: ask Claude, which opens the force analysis itself (set_panel / run_action), sweeps it, and puts the lens on strain
  await d.cut(async () => {
    await load(d, "bistable");
    await d.clickEl(".side-toggle.right"); // the Mechanism tab lives in the right panel
    await d.run((c) => window.__vibecadDemo.mockAgent(c), forcesCache);
  });
  await d.beat("bistable-forces", "Ask about a design, and Claude can drive the interface for you: here it opens the force analysis on a bistable switch, sweeps it through its travel, and turns the lens to strain. Both rest positions and the snap force are marked on the curve.", async () => {
    await d.lower("Bistable switch", "Claude opens the force analysis for you");
    await d.api("cursor", true);
    await d.clickEl("button", "Agent");
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
  await d.cut(async () => {
    await d.run(() => { const D = window.__vibecadDemo; D.ui.getState().togglePanel("lens", false); D.ui.getState().togglePanel("mechanism", false); D.store.getState().agentOpen && D.store.getState().toggleAgent(); });
    await d.clickEl(".side-toggle.right");
  });

  await clip("gimbal", "gimbal", "Flexure gimbal", "steers a mirror on eight blades", "A two-axis flexure gimbal, the kind satellites use to steer a mirror.", async () => { await sweep(d, "alpha", there(-8, 8, 6), 2400); d.pick("gimbal"); await sweep(d, "beta", there(-8, 8, 6), 2400); });
  await clip("roubo", "roubo", "Roubo workbench", "the leg vise, and the shop drawing to build it from", "A full-size woodworking bench, resized from one number. Its leg vise opens on a slider joint, and the shop drawing and cut list come straight from the model.", async () => {
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
  await d.beat("agent", "Or just describe it. Claude builds it with the same commands you use: a twisted vase, every section sized from a parameter. Then refine it in plain words. Turn it into a lamp shade, and Claude cuts the windows and sets the material. The result is an ordinary parametric model you can keep editing.", async () => {
    await d.lower("Ask Claude", "it builds with the same commands you do");
    await d.api("cursor", true);
    await d.clickEl("button", "Agent");
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

  await d.beat("outro", "That's VibeCAD. Free, open source, in your browser or on your desktop. Thanks for watching.", async () => {
    await d.lower(null);
    await d.api("cursor", false);
    await d.api("titleCard", { title: "VibeCAD", subtitle: "mikepkes.github.io/CAD", chips: ["Free", "Open source (MIT)", "Browser or desktop"] });
  }, { minMs: 6000 });
}
