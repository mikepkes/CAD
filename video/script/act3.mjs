// Act 3 · Rapid fire: about seven seconds per idea, mostly the bundled examples, then the mock agent.
// Loading each model is cut from the edit; slow processing is sped up with its speed shown.

import { readFileSync } from "node:fs";

const agentCache = JSON.parse(readFileSync(new URL("../mock/agent-coaster.json", import.meta.url), "utf8"));

async function load(d, name) {
  await d.cut(async () => {
    await d.run(async (n) => {
      const D = window.__chiselDemo;
      D.closeCards();
      D.store.getState().setSection(null);
      const text = await (await fetch(`/examples/${n}.json`)).text();
      await D.openText(text, `${n}.chisel.json`);
      if (D.store.getState().showPlanes) D.store.getState().toggleShowPlanes();
      D.ui.getState().togglePanel("workbench", false); // no pins in the montage
      D.view("iso");
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
      await d.run(async ([n, x]) => { await window.__chiselDemo.store.getState().setParameterExpr(n, String(x)); }, [name, v]);
      await d.settle(60);
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
    await d.run(() => window.__chiselDemo.ui.getState().togglePanel("workbench", false));
    // the montage shows the model, not the panels (there is no presentation mode yet: a gap)
    await d.clickEl(".side-toggle.left"); await d.clickEl(".side-toggle.right");
  });

  const clip = async (id, name, title, sub, narration, act) => {
    await load(d, name);
    await d.beat(id, narration, async () => { await d.lower(title, sub); await act(); }, { minMs: 6500 });
  };

  await clip("gyroscope", "gyroscope", "Print-in-place gyroscope", "a section view, then a motion study", "A gyroscope that prints in one piece, already assembled. Cut it open to see the pins and clearances inside, then let the motion study turn every joint through a full circle and check that nothing collides.", async () => {
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
    await d.api("turntable", 10);
    await d.wait(2600);
    await d.api("turntable", null);
    await d.fast("motion study", async () => {
      await d.run(async () => { await window.__chiselDemo.store.getState().runMotionStudy(); });
      await d.page.waitForFunction(() => !["running", "pending"].includes(window.__chiselDemo.store.getState().motionStatus), null, { timeout: 180000 });
    });
    await d.wait(1200);
  });
  await clip("scissor", "scissor", "Scissor lift", "the number of stages is a slider", "A scissor lift, where even the number of stages is a parameter.", () => sweep(d, "stages", [3, 4, 5, 6, 7, 6, 5, 4, 3], 4200));
  await clip("scissor-jointed", "scissor-jointed", "Jointed scissor", "patterned, and it still moves", "The same lift as a jointed assembly: patterned, and it still moves.", () => sweep(d, "theta", there(40, 18, 8).concat(range(40, 66, 8)), 4200));
  await clip("starbox", "starbox", "Snap-together star box", "snaps sized for each material", "A box that snaps together, with every snap sized for the material you print it in.", () => sweep(d, "width", there(64, 96, 8), 4000));
  await clip("bistable", "bistable", "Bistable switch", "two stable rests, from beam theory", "A bistable switch: curved beams that snap between two rest positions.", () => sweep(d, "travel", there(0, 10, 9), 4000));
  await clip("gripper", "gripper", "Compliant gripper", "ten flexure hinges, no pins", "A gripper with ten flexure hinges and not a single pin.", () => sweep(d, "push", there(0, 5, 7), 4000));
  await clip("xystage", "xystage", "XY flexure stage", "two inputs, no bearings", "A precision XY stage that moves on flexing blades instead of bearings.", () => sweep(d, "x", there(-2, 2, 7), 4000));
  await clip("gimbal", "gimbal", "Flexure gimbal", "steers a mirror on eight blades", "A two-axis flexure gimbal, the kind satellites use to steer a mirror.", async () => { await sweep(d, "alpha", there(-8, 8, 6), 2400); await sweep(d, "beta", there(-8, 8, 6), 2400); });
  await clip("roubo", "roubo", "Roubo workbench", "furniture, at full scale", "And not just mechanisms: a full-size woodworking bench, resized from one number.", () => sweep(d, "L", there(1700, 2300, 6), 3600));

  await d.cut(async () => {
    await d.api("newDocument");
    await d.run((c) => { const D = window.__chiselDemo; D.mockAgent(c); D.view("iso"); }, agentCache);
    await d.settle(400);
  });
  await d.beat("agent", "Or just describe it. Claude builds it with the same commands you use, and the result is an ordinary parametric model you can keep editing.", async () => {
    await d.lower("Ask Claude", "it builds with the same commands you do");
    await d.api("cursor", true);
    await d.clickEl("button", "Agent");
    await d.clickEl(".agent-input textarea");
    await d.type(agentCache.prompt, 40);
    await d.key("Enter");
    await d.fast("Claude building", async () => {
      await d.page.waitForFunction(() => !window.__chiselDemo.store.getState().agentRunning, null, { timeout: 120000 });
      await d.settle(400);
    });
    await d.api("frameAll");
    await d.wait(2000);
  }, { minMs: 9000 });

  await d.beat("outro", "That's Chisel. Free, open source, in your browser or on your desktop. Thanks for watching.", async () => {
    await d.lower(null);
    await d.api("cursor", false);
    await d.api("titleCard", { title: "Chisel CAD", subtitle: "mikepkes.github.io/CAD", chips: ["Free", "Open source (MIT)", "Browser or desktop"] });
  }, { minMs: 6000 });
}
