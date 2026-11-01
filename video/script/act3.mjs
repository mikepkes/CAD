// Act 3 · Rapid fire: about seven seconds per idea, mostly the bundled examples, then the mock agent.
// Loading each model is cut from the edit; slow processing is sped up with its speed shown.

import { readFileSync } from "node:fs";

import { existsSync } from "node:fs";

const agentCache = JSON.parse(readFileSync(new URL("../mock/agent-coaster.json", import.meta.url), "utf8"));
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
      await d.run(async () => { await window.__vibecadDemo.store.getState().runMotionStudy(); });
      await d.page.waitForFunction(() => !["running", "pending"].includes(window.__vibecadDemo.store.getState().motionStatus), null, { timeout: 180000 });
    });
    await d.wait(1200);
  });
  if (hasExample("clockwork")) {
    await clip("clockwork", "clockwork", "Gears of every kind", "spur, helical, herringbone, ring, rack, bevel, worm", "Gears of every kind, generated from a module and a tooth count, and geared together by expressions, so one number turns the whole train.", async () => {
      // the driving parameter: the first bounded one (the clockwork's turn)
      const drive = await d.run(() => window.__vibecadDemo.store.getState().session.doc.parameters.find((p) => p.min != null && p.max != null));
      if (!drive) throw new Error("the clockwork has no bounded drive parameter");
      await d.api("turntable", 6);
      await sweep(d, drive.name, range(drive.min, Math.min(drive.max, drive.min + 360), 40), 6000);
      await d.api("turntable", null);
    });
  } else d.note("no clockwork example yet: gears clip skipped");
  await clip("scissor-jointed", "scissor-jointed", "Jointed scissor lift", "the stage count is a slider, and it still moves", "A scissor lift where even the number of stages is a slider, patterned as a jointed assembly that still moves.", async () => { await sweep(d, "stages", [3, 4, 5, 4, 3], 2600); await sweep(d, "theta", there(40, 22, 6), 2600); });
  await clip("starbox", "starbox", "Snap-together star box", "snaps sized for each material", "A box that snaps together, with every snap sized for the material you print it in.", () => sweep(d, "width", [64, 76, 88, 76, 64], 3000));

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
    await d.wait(1200);
  }, { minMs: 12000 });
  await d.cut(async () => {
    await d.run(() => { const D = window.__vibecadDemo; D.ui.getState().togglePanel("lens", false); D.ui.getState().togglePanel("mechanism", false); D.store.getState().agentOpen && D.store.getState().toggleAgent(); });
    await d.clickEl(".side-toggle.right");
  });

  await clip("gimbal", "gimbal", "Flexure gimbal", "steers a mirror on eight blades", "A two-axis flexure gimbal, the kind satellites use to steer a mirror.", async () => { await sweep(d, "alpha", there(-8, 8, 6), 2400); await sweep(d, "beta", there(-8, 8, 6), 2400); });
  await clip("roubo", "roubo", "Roubo workbench", "and the shop drawing to build it from", "A full-size woodworking bench, resized from one number, with the shop drawing and cut list to build it from.", async () => {
    await sweep(d, "L", there(1700, 2100, 4), 2400);
    await d.api("cursor", true);
    await d.clickEl("button", "Export ▾"); await d.wait(400);
    await d.clickEl("[role=menuitem]", "Shop drawing");
    await d.fast("drawing the views", () => d.page.waitForSelector(".drawing-sheet svg", { timeout: 60000 }));
    await d.api("cursor", false);
    await d.wait(3000);
    await d.key("Escape");
  }, );

  await d.cut(async () => {
    await d.api("newDocument");
    await d.run((c) => { const D = window.__vibecadDemo; D.mockAgent(c); D.view("iso"); }, agentCache);
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
      await d.page.waitForFunction(() => !window.__vibecadDemo.store.getState().agentRunning, null, { timeout: 120000 });
      await d.settle(400);
    });
    await d.api("frameAll");
    await d.wait(2000);
  }, { minMs: 9000 });

  await d.beat("outro", "That's VibeCAD. Free, open source, in your browser or on your desktop. Thanks for watching.", async () => {
    await d.lower(null);
    await d.api("cursor", false);
    await d.api("titleCard", { title: "VibeCAD", subtitle: "mikepkes.github.io/CAD", chips: ["Free", "Open source (MIT)", "Browser or desktop"] });
  }, { minMs: 6000 });
}
