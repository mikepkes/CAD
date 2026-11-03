// Act 0 · The demo's opening, after the montage: the title, and what VibeCAD is (its first sentence said over the title,
// the second over a model turning slowly, one of its numbers changed). Then the demo goes straight to the showcase (Act 3); where to get it is the outro's. The phone stand is the
// tutorial's; the demo doesn't show it.
// Narration: lines.mjs, by beat id.

/** The title that follows the montage. */
const TITLE = { title: "VibeCAD", subtitle: "Parametric CAD in your browser. Drag it, type it, or just ask.", hero: true };

/** Before recording: the first showcase model behind the title (dimmed by the card), the title up so the montage cuts
 *  straight to it. */
export async function preroll(d) {
  await d.run(async () => {
    const D = window.__vibecadDemo;
    D.closeCards();
    const text = await (await fetch("/examples/gyroscope.json")).text();
    await D.openText(text, "gyroscope.vibecad.json");
    if (D.store.getState().showPlanes) D.store.getState().toggleShowPlanes(); // PUPPET: no origin planes in the video
    D.ui.getState().togglePanel("workbench", false);
    D.view("iso");
    await new Promise((r) => setTimeout(r, 700));
    D.frameAll();
  });
  await d.api("cursor", false);
  await d.api("titleCard", TITLE);
  await d.settle(600);
}

export async function act0(d) {
  // the title while "VibeCAD is parametric CAD that runs in your browser"; then (group 2) the title lifts off the
  // gyroscope, its parameters on the left, and on "change one, and the whole design follows" its ring height steps
  // up and every ring grows with it (PUPPET: set by command, as dragging its slider would)
  await d.beat("what-it-is", async () => {
    await d.api("titleCard", TITLE);
    await d.api("turntable", 10);
    await d.cue(); // "Every model is a recipe of named numbers: change one, and the whole design follows."
    await d.api("titleCard", null);
    await d.wait(2300);
    for (const h of [15, 18, 21]) {
      const t = Date.now();
      await d.run(async (x) => { await window.__vibecadDemo.store.getState().setParameterExpr("ringH", String(x)); }, h);
      await d.settle(60, { camera: false }); // the turntable is running
      if (Date.now() - t < 400) await d.wait(400 - (Date.now() - t));
    }
  });
  await d.api("turntable", null);
}
