// Act 0 · The demo's opening, after the montage: the title, and what VibeCAD is (said over the title, a model turning
// slowly behind it). Then the demo goes straight to the showcase (Act 3); where to get it is the outro's. The phone stand is the
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
  await d.beat("what-it-is", async () => {
    await d.api("titleCard", TITLE);
    await d.api("turntable", 10);
  }, { minMs: 6000 });
  await d.api("turntable", null);
}
