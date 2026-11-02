// Act 1 · The tutorial: blank page to a parametric phone stand, by hand first. (Its cold open, the finished stand
// turned and its phone dragged, is the demo's opening too: Act 0 uses the preroll and showStand from here.)
// Each beat: what happens (real input unless marked PUPPET); its narration is in lines.mjs, under the same id.

const W = (x, y, z) => ({ x, y, z });

/** Organizational assist's answers for this act (the mock agent replies with these; others get its heuristic name). */
const NAMES = { "Sketch 1": "Back plate profile", "Sketch 2": "Lip profile", "Extrude": ["Back plate", "Lip"] };

/** Before recording: the finished stand for the cold open (built by the same steps the tests build), under `title`. */
export async function preroll(d, title = TITLE) {
  await d.run((names) => window.__vibecadDemo.mockAgent({ prompt: "", model: "claude-haiku-5-5", source: "video act 1 names", turns: [], names }), NAMES);
  await d.run(async () => {
    const D = window.__vibecadDemo, st = D.store.getState();
    await st.dispatch("parameter.add", { name: "phone", expression: "9" });
    await st.dispatch("parameter.setBounds", { name: "phone", min: 6, max: 16 });
    await D.standStep("box");
    const back = await D.standStep("sideSketch");
    await D.standStep("backProfile", back);
    await D.standStep("across", back);
    const lip = await D.standStep("sideSketch");
    await D.standStep("lipProfile", lip, D.STAND, "phone");
    await D.standStep("across", lip);
    D.ui.getState().setOpenFeature(null);
    if (D.store.getState().showPlanes) D.store.getState().toggleShowPlanes(); // PUPPET: no origin planes in the video (nothing is sketched on them)
    D.view("iso");
  });
  await d.api("cursor", false);
  await d.api("titleCard", title); // up before the take starts, so the first frame is the title
  await d.settle(600);
}

/** The tutorial's title. */
const TITLE = { title: "Model a phone stand", subtitle: "A VibeCAD tutorial: a parametric part, from a blank page", hero: true };

/** Side-on to the stand's profile, a little from the front and above: the lip and the phone gap face the camera. */
const STAND_VIEW = [1, -0.45, 0.4];
/** The Parameters panel's width while a value is dragged on camera (it's 272 otherwise). */
const WIDE = 480;

/** The value → x position of a range input's thumb. */
const thumbX = (r, min, max, v) => r.x + 8 + ((v - min) / (max - min)) * (r.w - 16);

/** Push/Pull a face by dragging its number in the face card. */
async function scrubFace(d, dx) {
  const n = await d.rect(".wb-verbs .k-live");
  await d.drag({ x: n.cx, y: n.cy }, { x: n.cx + dx, y: n.cy }, Math.min(1600, 500 + Math.abs(dx) * 3));
  await d.settle();
}
/** Type a face's number: click it (a click starts typing, the value selected), the value, Enter. */
async function typeFace(d, value) {
  const n = await d.rect(".wb-verbs .k-live");
  await d.click(n.cx, n.cy);
  await d.wait(150);
  await d.type(String(value), 8);
  await d.wait(250);
  await d.key("Enter");
  await d.settle();
}
/** A point on the base's top, in front of the lip. */
const topOfBase = (S) => W(0, -S.depth / 2 + 4, S.base);
/** The base box's bounds right now. */
const baseBox = (d) => d.run(() => window.__vibecadDemo.bounds()[0]);
async function clickFace(d, which) {
  await d.api("closeCards"); // PUPPET: as clicking away would; an open card can cover the face
  const b = await baseBox(d);
  // off-centre on purpose: a face's centre can sit on an origin plane, which then wins the pick
  const c = { x: b.min.x + 0.42 * (b.max.x - b.min.x), y: b.min.y + 0.42 * (b.max.y - b.min.y), z: b.min.z + 0.6 * (b.max.z - b.min.z) };
  const p = { "+x": W(b.max.x, c.y, c.z), "-x": W(b.min.x, c.y, c.z), "+y": W(c.x, b.max.y, c.z), "-y": W(c.x, b.min.y, c.z), "+z": W(c.x, c.y, b.max.z) }[which];
  await d.clickWorld(p);
  await d.settle();
  await d.shot(`face${which}`);
}

/** Draw a closed outline with the line tool: click each corner, then the first again (closing the loop ends the chain). */
async function drawOutline(d, pts) {
  for (const p of [...pts, pts[0]]) {
    const s = await d.api("sketchWorldToScreen", p);
    await d.click(s.x, s.y, { ms: 380 });
    await d.wait(120);
  }
  await d.settle();
}
/** Extrude the open sketch across the base up to its far side: Extent "To face", then press and hold over that hidden
 *  face to open the selection picker, point at the entries (each lights its face on the model) and choose the far one. */
async function extrudeToFarSide(d, S, far = W(-S.width / 2, -S.depth / 2 + 8, S.base / 2)) {
  await d.key("e");
  await d.wait(400);
  const selects = d.page.locator(".extrude-panel select"); // Profile, Extent, Operation
  const ext = selects.nth(1), eb = await ext.boundingBox();
  await d.move(eb.x + eb.width / 2, eb.y + eb.height / 2);
  await ext.selectOption("toFace");
  await d.wait(400);
  await pickBehind(d, far, (it) => it.kind === "face" && it.normal.x < -0.99);
  await d.settle(300);
  const op = selects.last(), ob = await op.boundingBox();
  await d.move(ob.x + ob.width / 2, ob.y + ob.height / 2);
  await op.selectOption("join");
  await d.wait(350);
  await d.clickEl(".extrude-panel .btn.primary", "Extrude");
  await d.settle(400);
}

/** Press and hold over `world` (a point that may be hidden behind the model), then in the picker point at each entry
 *  down to the one `want` matches, and choose it. */
async function pickBehind(d, world, want) {
  const s = await d.world(world);
  await d.move(s.x, s.y, 600);
  await d.page.mouse.down();
  await d.wait(700); // the long press opens the picker
  await d.page.mouse.up();
  await d.wait(250);
  const items = await d.run(() => window.__vibecadDemo.store.getState().pickMenu?.items ?? []);
  const k = items.findIndex(want);
  if (k < 0) throw new Error(`picker has no matching entry (${items.map((i) => i.label).join(", ")})`);
  const rows = d.page.locator(".pick-item");
  for (let i = 0; i <= k; i++) { const b = await rows.nth(i).boundingBox(); await d.move(b.x + 40, b.y + b.height / 2, 380); await d.wait(i === k ? 700 : 450); }
  const b = await rows.nth(k).boundingBox();
  await d.click(b.x + 40, b.y + b.height / 2, { ms: 120 });
  await d.shot("picked");
}

/** The finished stand, turned slowly, then side-on with its phone thickness dragged up and back: the whole stand
 *  follows (the tutorial's cold open, the demo's "what it is"). */
export async function showStand(d) {
  await d.api("cursor", false);
  await d.api("turntable", 12); // degrees a second: a slow, readable turn (pass 1's 3D-mouse drift ran at about 450°/s)
  await d.wait(2200);
  await d.api("turntable", null);
  // stop side-on to the profile, where the lip and the phone gap face the camera, and widen the numbers to drag
  await d.api("aim", { dir: STAND_VIEW, ms: 1300, margin: 0.95 });
  await d.api("sideWidth", "left", WIDE, 500);
  await d.api("cursor", true);
  const r = await d.rect(".param-slider input[type=range]");
  await d.move(thumbX(r, 6, 16, 9), r.cy, 700);
  await d.drag({ x: thumbX(r, 6, 16, 9), y: r.cy }, { x: thumbX(r, 6, 16, 15), y: r.cy }, 1800);
  await d.wait(600);
  await d.drag({ x: thumbX(r, 6, 16, 15), y: r.cy }, { x: thumbX(r, 6, 16, 9), y: r.cy }, 1500);
  await d.api("cursor", false);
  await d.api("sideWidth", "left", 272, 500);
}

export async function act1(d) {
  const S = await d.run(() => window.__vibecadDemo.STAND);

  await d.beat("title", async () => {
    await d.api("titleCard", TITLE);
    await d.wait(2600);
    await d.api("titleCard", null);
  });

  await d.beat("cold-open", () => showStand(d));

  await d.beat("get-vibecad", async () => {
    await d.api("cursor", false);
    await d.api("titleCard", { title: "Get VibeCAD", subtitle: "mikepkes.github.io/CAD   ·   desktop app: GitHub Releases", chips: ["Free", "Open source (MIT)"] });
  });

  await d.beat("the-room", async () => {
    await d.api("titleCard", null);
    await d.api("cursor", true);
    await d.clickEl(".toolbar button, button", "New");
    await d.clickEl("[role=dialog] button", "New document");
    await d.settle(500);
    await d.run(() => { const st = window.__vibecadDemo.store.getState(); if (st.showPlanes) st.toggleShowPlanes(); }); // PUPPET: New brings the origin planes back
    await d.api("view", "iso"); await d.settle(300);
    await d.run((names) => window.__vibecadDemo.mockAgent({ prompt: "", model: "claude-haiku-5-5", source: "video act 1 names", turns: [], names }), NAMES); // fresh names for the new document
    await d.move(820, 380, 700); await d.wait(700);
    await d.moveTo(await d.rect(".wb-strip"), 600); await d.wait(800);
    await d.moveTo(await d.rect(".panel-head", "Parameters"), 600); await d.wait(800);
    await d.moveTo(await d.rect(".k-panel-toggle button", "⌘K"), 600); await d.wait(500);
    await d.move(820, 420, 500);
    await d.key(" ");
    await d.wait(1800);
    await d.key("Escape");
  });

  await d.beat("block", async () => {
    await d.move(820, 420, 400);
    await d.ring("Add a box");
    await d.settle(400);
    await d.key("Escape");
    await clickFace(d, "+x"); await scrubFace(d, 250);
    await clickFace(d, "-y"); await scrubFace(d, 150);
    await clickFace(d, "+z"); await scrubFace(d, -140);
    await d.api("view", "left"); await d.wait(900);
    await clickFace(d, "-x"); await typeFace(d, S.width);
    await d.api("view", "back"); await d.wait(900);
    await clickFace(d, "+y"); await scrubFace(d, 150);
    await d.api("view", "iso"); await d.wait(900);
    await d.key("Escape");
  }, { lower: null });

  let lipSketch = null;
  const side = W(S.width / 2, -S.depth / 2 + 8, S.base / 2); // the base's +X side, clear of the plate and the lip
  await d.beat("raise-the-back", async () => {
    await d.api("closeCards");
    await d.clickWorld(side); await d.settle();
    await d.shot("side");
    await d.ring("Sketch");
    await d.settle(300);
    await d.key("f"); await d.wait(900);
    const back = await d.run(() => window.__vibecadDemo.backOutline());
    // Look at frames the face, and the tall outline then reaches up under the panel switches at the top of the
    // view: pinch out a step (a trackpad pinch is a ctrl+wheel) so every corner is clear of them
    await d.move(820, 470, 300);
    await d.page.keyboard.down("Control");
    for (let i = 0; i < 6; i++) { await d.page.mouse.wheel(0, 40); await d.wait(40); }
    await d.page.keyboard.up("Control");
    await d.wait(600);
    await drawOutline(d, back.map((p) => W(S.width / 2, p.y, p.z)));
    await d.page.keyboard.press("Meta+Enter"); await d.settle(300);
    await d.api("view", "iso"); await d.wait(700);
    await extrudeToFarSide(d, S);
    await d.api("closeCards");
    await d.clickWorld(side); await d.settle();
    await d.shot("side");
    await d.key("s");
    await d.settle(300);
    lipSketch = await d.run(() => window.__vibecadDemo.store.getState().activeSketchId);
    await d.key("f"); await d.wait(900);
    await d.key("r");
    const lip = await d.run(() => window.__vibecadDemo.lipOutline());
    for (const p of [lip[0], lip[2]]) { const s = await d.api("sketchWorldToScreen", W(S.width / 2, p.y, p.z)); await d.click(s.x, s.y); }
    await d.key("Escape");
    await d.page.keyboard.press("Meta+Enter"); await d.settle(300);
    await d.api("view", "iso"); await d.wait(700);
    await extrudeToFarSide(d, S, W(-S.width / 2, (back[0].y + back[2].y) / 2 + 2, S.base + S.height * 0.6)); // the plate's far side: the base's is behind the panel now
  });

  await d.beat("what-it-kept", async () => {
    const r = await d.rect(".wb-strip input[type=range]");
    await d.drag({ x: r.x + r.w - 6, y: r.cy }, { x: r.x + r.w * 0.2, y: r.cy }, 2200);
    await d.wait(500);
    await d.drag({ x: r.x + r.w * 0.2, y: r.cy }, { x: r.x + r.w - 2, y: r.cy }, 2000);
    await d.settle();
  }, { lower: { title: "Parametric history", sub: "direct edits are recorded as features" } });

  await d.beat("make-it-parametric", async () => {
    await d.lower("Design intent", "named numbers, and the rules between them");
    await d.api("closeCards");
    await d.clickWorld(topOfBase(S)); await d.settle();
    await d.key("Enter"); await d.settle(300);
    for (const [label, name] of [["Y", "depth"], ["X", "width"]]) {
      await d.clickEl(".wb-card button", `Name this number (${label})`);
      await d.wait(300);
      await d.page.keyboard.press("Meta+A");
      await d.type(name, 9);
      await d.key("Enter");
      await d.settle(300);
    }
    // PUPPET: the phone parameter and the lip's dimensions go in by command (the inline dimension tool on a face sketch is not scripted yet).
    const lipBox = await d.run(() => window.__vibecadDemo.lipOutline());
    await d.moveTo(await d.rect(".panel-head", "Parameters"), 500);
    await d.run(async () => { const st = window.__vibecadDemo.store.getState(); await st.dispatch("parameter.add", { name: "phone", expression: "9" }); await st.dispatch("parameter.setBounds", { name: "phone", min: 6, max: 16 }); });
    await d.settle();
    const s = await d.world(W(S.width / 2, lipBox[1].y, lipBox[2].z)); await d.move(s.x, s.y, 600);
    await d.lower("lip = phone + 2", "a dimension written as a formula");
    await d.run(async (sid) => { await window.__vibecadDemo.lipDims(sid, "phone"); }, lipSketch);
    await d.settle();
    await d.key("Escape");
  });

  await d.beat("turn-the-dials", async () => {
    await d.lower(null);
    await d.api("aim", { dir: STAND_VIEW, ms: 1000, margin: 0.95 });
    await d.api("sideWidth", "left", WIDE, 500);
    const r = await d.rect(".param-slider input[type=range]");
    await d.drag({ x: thumbX(r, 6, 16, 9), y: r.cy }, { x: thumbX(r, 6, 16, 14), y: r.cy }, 1800);
    await d.settle(400); await d.wait(800);
    await d.page.keyboard.press("Meta+Z"); await d.settle(400);
    await d.api("sideWidth", "left", 272, 500);
  });

  await d.beat("just-type-it", async () => {
    await d.lower("Intent line", "⌘K: type what you want");
    await d.intent("right", "View right");
    await d.wait(500);
    await d.intent("phone 14", "phone = 14");
    await d.wait(1200);
    await d.intent("back to 2", "Back to 2");
    await d.wait(1200);
    await d.intent("roll end", "Roll to the end");
    await d.wait(600);
    await d.api("aim", { dir: STAND_VIEW, ms: 900 });
    await d.lower(null);
  });

  await d.beat("keep-it", async () => {
    await d.clickEl("button", "Save");
    await d.wait(600);
  });
}
