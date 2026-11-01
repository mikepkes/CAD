// Act 2 · Grow: the stand becomes a product. Starts from the parametric stand Act 1 ends with
// (rebuilt by command in the preroll: width, depth and phone are bounded parameters).

const W = (x, y, z) => ({ x, y, z });

export async function preroll(d) {
  await d.run(async () => {
    const D = window.__vibecadDemo, st = D.store.getState(), S = D.STAND;
    for (const [name, v, min, max] of [["width", S.width, 70, 120], ["depth", S.depth, 60, 90], ["phone", S.phone, 6, 16]]) {
      await st.dispatch("parameter.add", { name, expression: String(v) });
      await st.dispatch("parameter.setBounds", { name, min, max });
    }
    await st.dispatch("feature.primitive", { shape: "box", x: "width", y: "depth", z: String(S.base), at: { x: 0, y: 0, z: S.base / 2 }, name: "Base" });
    const back = await D.standStep("sideSketch");
    await D.standStep("backProfile", back);
    await D.standStep("across", back);
    const lip = await D.standStep("sideSketch");
    await D.standStep("lipProfile", lip, S, "phone");
    await D.standStep("across", lip);
    D.closeCards();
    if (D.store.getState().showPlanes) D.store.getState().toggleShowPlanes(); // PUPPET: no origin planes in the video
    D.view("iso");
  });
  await d.settle(600);
}

const toggle = (d, label) => d.clickEl(".k-panel-toggle button", label);

export async function act2(d) {
  const S = await d.run(() => window.__vibecadDemo.STAND);

  await d.beat("soften", "Sharp corners chip and catch. Click the top of the base and choose Round corners: its four corners get a fillet, and the radius is just another number you can drag, type or name. Make it generous: fifteen millimetres.", async () => {
    await d.clickWorld(W(-S.width / 4, -S.depth / 2 + 4, S.base)); await d.settle();
    await d.clickEl(".wb-verbs button", "Round corners");
    await d.settle(400);
    const n = await d.rect(".wb-card .k-live");
    await d.drag({ x: n.cx, y: n.cy }, { x: n.cx + 40, y: n.cy }, 900);
    await d.settle(300);
    const m = await d.rect(".wb-card .k-live");
    await d.click(m.cx, m.cy);
    await d.key("Enter");
    await d.type("15", 8);
    await d.wait(250);
    await d.key("Enter");
    await d.settle(400);
    await d.api("closeCards");
  }, { lower: { title: "Fillet", sub: "a feature like any other, in the history" } });

  await d.beat("rules", "Instead of checking by eye after every change, write down what must stay true. Here, the stand must weigh under two hundred grams: Command K, mass at most two hundred. It lands in the ledger, which checks it on every change, and when it fails, builds fixes and offers them. Accept one.", async () => {
    await toggle(d, "Ledger"); await d.settle(300);
    await d.intent("mass <= 200", "Keep mass <= 200", { dwell: 900 });
    await d.settle(400);
    await d.lower("Design intent", "checked on every rebuild");
    await d.fast("searching for fixes", () => d.page.waitForSelector("button:has-text('Accept')", { timeout: 120000 }));
    await d.clickEl("button", "=Accept");
    await d.settle(500);
    await d.wait(800);
  });

  await d.beat("better-versions", "Sliders show one version at a time. The design space shows them all at once: width against depth, shaded by weight, with the edge of what passes your rule. Pin the one you have, jump to the lightest that passes, and compare the two, one ghosted over the other.", async () => {
    await d.lower(null);
    await toggle(d, "Space"); await d.settle(300);
    await d.fast("sampling 81 designs", async () => {
      await d.page.waitForFunction(() => !/sampling \d+ \/ \d+/.test(document.body.innerText), null, { timeout: 180000 });
    });
    await d.clickEl("button", "=Pin");
    await d.settle(300);
    await d.clickEl("button", "Jump to lightest");
    await d.settle(400);
    await d.clickEl("button", "=Compare");
    await d.settle(400);
    await d.wait(1500);
  });

  await d.beat("materials", "Materials are one click, each drawn as it really looks: polished brass, walnut, grip rubber. Or as it will print: PLA, with its layer lines. Print it on its side instead, and the layers turn with it. Across the layers is a print's weak direction, and the strength studies take it into account.", async () => {
    await toggle(d, "Space"); await toggle(d, "Ledger");
    await toggle(d, "Materials"); await d.settle(300);
    await d.api("sideWidth", "right", 400, 500);
    const preset = async (name) => {
      const el = d.page.locator(".mats-preset", { hasText: name }).first();
      await el.scrollIntoViewIfNeeded();
      await d.clickEl(".mats-preset", name);
      await d.settle(400);
    };
    await d.api("aim", { dir: [1, -0.8, 0.5], ms: 1000, margin: 0.95 });
    await preset("Polished brass"); await d.api("turntable", 10); await d.wait(1500); await d.api("turntable", null); await d.shot("brass");
    await preset("Walnut"); await d.wait(1300); await d.shot("walnut");
    await preset("Grip rubber"); await d.wait(1300); await d.shot("rubber");
    await preset("PLA"); await d.wait(500);
    // close on the slanted back, where the layers show as lines up its face
    const b = (await d.api("bounds"))[0];
    // about 20 mm of the slanted back's face, mid-width (not the side profile, where layers along X can't show):
    // close enough that 0.2 mm layers are drawn
    const cx = (b.min.x + b.max.x) / 2, cy = b.min.y + (b.max.y - b.min.y) * 0.62, cz = b.min.z + (b.max.z - b.min.z) * 0.55;
    await d.api("aim", { dir: [0.3, -1, 0.6], box: { min: { x: cx - 8, y: cy - 8, z: cz - 8 }, max: { x: cx + 8, y: cy + 8, z: cz + 8 } }, ms: 1400, margin: 0.6 });
    await d.wait(1600); await d.shot("pla-flat");
    await d.clickEl("button[aria-label='Edit PLA']"); await d.wait(500);
    await d.clickEl("[aria-label='Print direction'] button", "=X");
    // on its side the layers cross this face at their true 0.2 mm (flat, the slope spread them out): push in to show them
    await d.api("aim", { dir: [0.3, -1, 0.6], box: { min: { x: cx - 8, y: cy - 8, z: cz - 8 }, max: { x: cx + 8, y: cy + 8, z: cz + 8 } }, ms: 1200, margin: 0.38 });
    await d.settle(400); await d.wait(1600); await d.shot("pla-side");
    await d.clickEl("[aria-label='Print direction'] button", "=Z");
    await d.api("aim", { dir: [0.3, -1, 0.6], box: { min: { x: cx - 8, y: cy - 8, z: cz - 8 }, max: { x: cx + 8, y: cy + 8, z: cz + 8 } }, ms: 900, margin: 0.6 });
    await d.settle(400); await d.wait(700);
    await toggle(d, "Materials");
    await d.api("sideWidth", "right", 272, 400);
    await d.api("aim", { dir: [1, -1, 0.7], ms: 900, margin: 1.0 });
  }, { lower: { title: "Materials", sub: "metal, wood, rubber, and prints with their layer lines" } });

  await d.beat("will-it-print", "Will it print? Bring up the lens and switch it to overhangs: red would need supports. Then zebra stripes: on the rounded corner they bend smoothly through the curve and on into the flat faces, with no kinks.", async () => {
    await toggle(d, "Lens"); await d.settle(400);
    await d.move(820, 420, 500);
    await d.key("5"); await d.settle(400); await d.wait(1800);
    // zebra on the big rounded corner: stripes bend through the curve and flow on into the flat faces
    await d.key("1"); await d.settle(400);
    const b = (await d.api("bounds"))[0]; // the stand as it is now (the design space changed its width and depth)
    const R = 15, cx = b.max.x - R, cy = b.min.y + R; // the front-right corner's centre
    await d.api("aim", { dir: [1, -1, 0.7], box: { min: { x: cx - 6, y: b.min.y - 2, z: 0 }, max: { x: b.max.x + 2, y: cy + 6, z: S.base + 4 } }, ms: 1500, margin: 1.6 });
    const c = await d.world(W(cx + R * 0.71, cy - R * 0.71, S.base / 2));
    await d.move(c.x, c.y, 600);
    await d.api("turntable", 5); await d.wait(2600); await d.api("turntable", null);
    await d.wait(400);
    await toggle(d, "Lens");
    await d.api("view", "iso");
  }, { lower: { title: "Analysis lens", sub: "overhang, draft, curvature, zebra, x-ray" } });

  await d.beat("make-it-yours", "Every action has a key, and the ones you use most can live on the action ring. Each context has its own ring, and you decide what's on it. Put Round edges on the face ring, and it's one flick away: here it softens every edge around the top of the base.", async () => {
    await d.lower(null);
    await d.clickEl("button[title='Keyboard shortcuts']");
    await d.settle(300);
    await d.clickEl(".hk-modal button", "Ring");
    await d.wait(600);
    await d.clickEl(".hk-ring-ctx button", "Face");
    await d.wait(500);
    await d.clickEl(".hk-slot[data-slot=SW]");
    await d.wait(400);
    const pick = d.page.locator(".hk-slot-picker select"), pb = await pick.boundingBox();
    await d.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
    await pick.selectOption("face.fillet");
    await d.wait(900);
    await d.clickEl(".hk-modal button", "Done");
    await d.settle(300);
    // use it: the top of the base, in front of the lip, then the ring's new slot
    const b = (await d.api("bounds"))[0];
    await d.api("closeCards");
    await d.clickWorld(W(b.min.x + 0.3 * (b.max.x - b.min.x), b.min.y + 4, S.base)); await d.settle();
    await d.ring("Round");
    await d.settle(400);
    await d.wait(800);
    await d.api("closeCards");
  });

  await d.beat("ship-it", "When it's right, export it: STL for any printer, 3MF to keep parts and materials together, or STEP for other CAD tools.", async () => {
    await d.clickEl("button", "Export ▾"); await d.wait(500);
    await d.clickEl("[role=menuitem]", "3MF");
    await d.fast("exporting", () => d.settle(500));
    await d.wait(800);
  }, { lower: { title: "Export", sub: "STL · 3MF · STEP" } });
}
