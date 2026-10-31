// Act 2 · Grow: the stand becomes a product. Starts from the parametric stand Act 1 ends with
// (rebuilt by command in the preroll: width, depth and phone are bounded parameters).

const W = (x, y, z) => ({ x, y, z });

export async function preroll(d) {
  await d.run(async () => {
    const D = window.__chiselDemo, st = D.store.getState(), S = D.STAND;
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
  const S = await d.run(() => window.__chiselDemo.STAND);

  await d.beat("soften", "Sharp edges chip and catch. Click the front face and choose Round edges: every edge around it gets a fillet, and its radius is just another number you can drag or name.", async () => {
    await d.clickWorld(W(-S.width / 4, -S.depth / 2, S.base * 0.6)); await d.settle();
    await d.clickEl(".wb-verbs button", "Round edges");
    await d.settle(400);
    const n = await d.rect(".wb-card .k-live");
    await d.drag({ x: n.cx, y: n.cy }, { x: n.cx + 30, y: n.cy }, 900);
    await d.settle(400);
    await d.api("closeCards");
  }, { lower: { title: "Fillet", sub: "a feature like any other, in the history" } });

  await d.beat("rules", "Instead of checking by eye after every change, write down what must stay true. Here, the stand must weigh under two hundred grams. Chisel checks it on every change, and when it fails, it builds fixes and offers them. Accept one.", async () => {
    await toggle(d, "Ledger"); await d.settle(300);
    await d.clickEl("input[aria-label=Intent]");
    await d.type("mass <= 200", 12);
    await d.clickEl("input[aria-label=Label]");
    await d.type("Light enough", 14);
    await d.key("Enter");
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

  await d.beat("will-it-print", "Will it print? Bring up the lens and switch it to overhangs: red would need supports. Then zebra stripes show how smoothly the surfaces flow into each other.", async () => {
    await toggle(d, "Space"); await toggle(d, "Ledger");
    await toggle(d, "Lens"); await d.settle(400);
    await d.move(820, 420, 500);
    await d.key("5"); await d.settle(400); await d.wait(1800);
    await d.key("1"); await d.settle(400); await d.wait(1500);
    await toggle(d, "Lens");
  }, { lower: { title: "Analysis lens", sub: "overhang, draft, curvature, zebra, x-ray" } });

  await d.beat("make-it-yours", "Every action has a key, and the ones you use most can live on the action ring. Each context has its own ring, and you decide what's on it.", async () => {
    await d.lower(null);
    await d.clickEl("button[title='Keyboard shortcuts']");
    await d.settle(300);
    await d.clickEl(".hk-modal button", "Ring");
    await d.wait(2200);
    await d.clickEl(".hk-modal button", "Done");
  });

  await d.beat("ship-it", "When it's right, export it: STL for any printer, 3MF to keep parts and materials together, or STEP for other CAD tools.", async () => {
    await d.clickEl("button", "Export ▾"); await d.wait(500);
    await d.clickEl("[role=menuitem]", "3MF");
    await d.fast("exporting", () => d.settle(500));
    await d.wait(800);
  }, { lower: { title: "Export", sub: "STL · 3MF · STEP" } });
}
