// Act 0 · The demo's opening, after the montage: the title, what VibeCAD is (the finished phone stand, its phone
// dragged: the whole stand follows), where to get it. Then the demo goes straight to the showcase (Act 3).
// Narration: lines.mjs, by beat id.

import { preroll as standPreroll, showStand } from "./act1.mjs";

/** The title that follows the montage. */
const TITLE = { title: "VibeCAD", subtitle: "Parametric CAD in your browser. Drag it, type it, or just ask.", hero: true };

export async function preroll(d) {
  await standPreroll(d, TITLE); // up before the take starts, so the montage cuts straight to it
}

export async function act0(d) {
  await d.beat("title", async () => {
    await d.api("titleCard", TITLE);
    await d.wait(2600);
    await d.api("titleCard", null);
  });

  await d.beat("what-it-is", () => showStand(d));

  await d.beat("get-vibecad", async () => {
    await d.api("cursor", false);
    await d.api("titleCard", { title: "Get VibeCAD", subtitle: "mikepkes.github.io/CAD   ·   desktop app: GitHub Releases", chips: ["Free", "Open source (MIT)"] });
  });
}
