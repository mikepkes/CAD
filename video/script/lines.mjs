// The narration: every beat's spoken line, by act and beat id, in the order the beats play.
// There are two videos (VIDEOS): the demo, a showcase of what VibeCAD does (the montage, Act 0's opening, Act 3), and
// the tutorial, one focused walkthrough that models a phone stand (Acts 1 and 2). They're cut from separate takes and
// say different things: the demo shows breadth and points to the tutorial; the tutorial teaches and points to the demo.
// The director reads a beat's line from here (`d.beat(id, fn)`), video/vo.mjs synthesises each line to a clip per
// voice, and video/edit.mjs captions them. Lines are written for the ear: addresses are spelled out ("mikepkes dot
// github dot io slash CAD"; the captions turn them back into written form) and "Command K" is said in words.
// "" is a silent beat (no voice, no caption). Change a line here and only its clips are re-synthesised.
// " | " splits a line into sentence groups the script cues one by one (`d.cue()`), so each is said as its action
// happens rather than the whole line at the beat's start (partsOf, below).

/** The two videos: which acts each is cut from, in order, and the file it renders to (video/out/<run>/<video>/). */
export const VIDEOS = {
  demo: {
    title: "VibeCAD demo", file: "vibecad-demo", acts: [0, 3], montage: true,
    // the YouTube description (video/youtube.mjs adds the chapters under it)
    description: "VibeCAD is free, open-source parametric CAD that runs in your browser or as a desktop app. This demo shows what it can do: section views and motion studies, gears and linkages, compliant mechanisms and their forces, organic surfaces, folded paper, a shop drawing from a workbench, and parts built just by asking Claude.\n\nTry it: https://mikepkes.github.io/CAD\nSource (MIT): https://github.com/mikepkes/CAD\nTo learn to model, watch the phone stand tutorial.",
  },
  tutorial: {
    title: "VibeCAD tutorial: model a phone stand", file: "vibecad-tutorial", acts: [1, 2],
    description: "Model a parametric phone stand in VibeCAD, from a blank page: push and pull a box, sketch the slanted back and the lip, then name the numbers that matter so the whole stand follows the phone's thickness. Then round it, set a weight rule, compare versions in the design space, pick a material, check it will print, and export it.\n\nTry it: https://mikepkes.github.io/CAD\nSource (MIT): https://github.com/mikepkes/CAD\nTo see what else VibeCAD can do, watch the demo.",
  },
};

/** The demo's intro montage line (the edit cuts the montage from Act 3's picks, before Act 0). */
export const MONTAGE = "Sections, gears, mechanisms, forces, and parts built just by asking.";

export const LINES = {
  // Act 0 · The demo's opening: what VibeCAD is, said over the title, and where to get it. Then straight to the showcase.
  0: {
    "what-it-is":
      "VibeCAD is parametric CAD that runs in your browser. Every model is a recipe of steps and named numbers: change one, and the whole design follows.",
    "get-vibecad":
      "It's free and open source, at mikepkes dot github dot io slash CAD, or as a desktop app. Here's what it can do.",
  },

  // Act 1 · The tutorial: blank page to a parametric phone stand, by hand first.
  1: {
    title:
      "",
    "cold-open":
      "In this tutorial you'll model this phone stand from a blank page. It's parametric: drag one number, the phone's thickness, and the back plate moves back, the lip moves forward, and the lip grows taller to hold it. You'll shape it by hand, make it parametric, then round it, check it and export it to print.",
    "get-vibecad":
      "VibeCAD runs in your browser at mikepkes dot github dot io slash CAD, or as a desktop app from the project's GitHub releases. It's free, and it's open source under the MIT licence.",
    "the-room":
      "Start a new document. | Four places matter: the model in the middle, | its history along the bottom, | its numbers on the left, | and two shortcuts. Command K runs anything you can type, | and Space opens the action ring.",
    block:
      "Start with a block. Hold Space for the action ring, point at Box and let go. | Then click a face and drag its number to push it out. | Pull the top down to make a thin base. | Turn the model to reach the far sides, | and type a size when you know it.",
    "raise-the-back":
      "Pushing sets sizes, but it can't tilt. | For the slanted back, click the side face and pick Sketch from its action ring: the ring changes with what you've selected. | Draw the outline corner by corner, | finish the sketch, | and extrude it up to the far side of the base, so it always spans the base, whatever its width. | That side is hidden, so press and hold: VibeCAD lists everything under the cursor and lights each one as you point at it. | The lip in front of the phone is a rectangle, made the same way.",
    "what-it-kept":
      "Here's the quiet part: VibeCAD kept a recipe of everything you did by hand. Every push and every sketch is a step in the history. | Drag back through it, and forward again. | Nothing has to be redone, and every step can still change.",
    "make-it-parametric":
      "Now make it parametric. | Open the base and name the numbers that matter: its depth and its width. | Add a phone parameter | and size the slot from it: phone plus two millimetres wide, the back plate and the lip each half of that from its middle, so the phone's weight stays over the base. And the lip stands phone plus one tall.",
    "turn-the-dials":
      "Now turn the dial. | A thicker phone, and the back plate leans further back, the lip steps forward, and it grows to hold the phone. | That's all parametric means: change one number, and everything that depends on it follows. | And Command Z puts it back.",
    "just-type-it":
      "Or skip the mouse. Command K, and type what you want. | Right, for a side view. | Phone fourteen, and the slot opens to fit it. | Back to step two, and the history rolls back with it; | roll to the end, and it's all there again.",
    "keep-it":
      "Save it to a file whenever you like. VibeCAD also keeps your work as you go, so you can experiment freely.",
  },

  // Act 2 · The tutorial, continued: the stand becomes a product.
  2: {
    soften:
      "Sharp corners chip and catch. | Click the top of the base and choose Round corners: its four corners get a fillet, | and the radius is just another number you can drag, type or name. Make it generous: fifteen millimetres.",
    rules:
      "Instead of checking by eye after every change, write down what must stay true. | Here, the stand must weigh under two hundred grams: Command K, mass at most two hundred. | It lands in the ledger, which checks it on every change, | and when it fails, builds fixes and offers them. Accept one.",
    "better-versions":
      "Sliders show one version at a time. | The design space shows them all at once: width against depth, shaded by weight, with the edge of what passes your rule. | Pin the one you have, | jump to the lightest that passes, | and compare the two, one ghosted over the other.",
    materials:
      "Materials are one click, each drawn as it really looks: | polished brass, | walnut, | grip rubber. | Or as it will print: PLA, with its layer lines. | Print it on its side instead, and the layers turn with it. | Across the layers is a print's weak direction, and the strength studies take it into account.",
    "will-it-print":
      "Will it print? | Bring up the lens and switch it to overhangs: red would need supports. | Then zebra stripes: on the rounded corner they bend smoothly through the curve and on into the flat faces, with no kinks.",
    "make-it-yours":
      "Every action has a key, and the ones you use most can live on the action ring. | Each context has its own ring, and you decide what's on it. | Put Round edges on the face ring, | and it's one flick away: here it softens every edge around the top of the base.",
    "ship-it":
      "When it's right, export it: STL for any printer, 3MF to keep parts and materials together, or STEP for other CAD tools.",
    "wrap-up":
      "That's the whole stand: a box, two sketches and a few named numbers, kept right by a rule. To see what else VibeCAD can do, from gears to folded paper, watch the demo.",
  },

  // Act 3 · The demo's showcase, rapid fire: the bundled examples, then the agent.
  3: {
    gyroscope:
      "A gyroscope that prints in one piece, already assembled. Cut it open and turn square to the cut: each ring hangs on cone pins that come to a point inside a socket, with just enough clearance to spin. Then the motion study turns every joint through a full circle and checks that nothing collides.",
    clockwork:
      "Gears of every kind, generated from a module and a tooth count, and geared together by expressions, so one number turns the whole train. The planets roll inside the ring gear, and the worm creeps its wheel round at a fraction of the speed. And a Geneva drive turns steady motion into steps: the pin catches a slot, flicks the star a quarter turn, and the locking disc holds it still until the next.",
    walker:
      "A wind walker in the spirit of Theo Jansen's beach animals. One crank turns twelve legs of eleven bars each, sixty degrees apart, so some feet are always gliding along the ground while the rest lift and swing forward.",
    skadis:
      "A pegboard holder that grips by weight. Set something in it, and its weight pushes a rack down between two pinions, swinging the side pads in to clamp it. The heavier it is, the harder it holds, and every part prints, pins included.",
    handlebar:
      "Organic surfaces: a mountain-bike cockpit. The bar is one sweep along a 3D curve, tapering from the stem clamp to the grips, and the rubber grips wear a hex pattern wrapped round their wings.",
    origami:
      "And paper. One slider takes a flat sheet through every fold to a finished dart, each layer kept a paper's thickness from the next, white on one side and red on the other.",
    "scissor-jointed":
      "A scissor lift where even the number of stages is a slider, patterned as a jointed assembly that still moves.",
    starbox:
      "A box that snaps together, with every snap sized for the material you print it in.",
    "bistable-forces":
      "Ask about a design, and Claude can drive the interface for you: here it opens the force analysis on a bistable switch, sweeps it through its travel, and turns the lens to strain. Both rest positions and the snap force are marked on the curve.",
    "print-direction":
      "It's a print, and prints are weakest across their layers. Flat on the bed, the blades bend along their layers. Stand it on its end, and every blade is pulled across them: the same strain is now a bigger share of a lower limit.",
    gimbal:
      "A two-axis flexure gimbal, the kind satellites use to steer a mirror.",
    roubo:
      "A full-size woodworking bench, resized from one number. Its leg vise opens on a slider joint, and the shop drawing and cut list come straight from the model.",
    agent:
      "Or just describe it. Claude builds it with the same commands you use: a twisted vase, every section sized from a parameter. Then refine it in plain words. Turn it into a lamp shade, and Claude cuts the windows and sets the material. Some windows overlap? Say so, and it thins them out. The result is an ordinary parametric model you can keep editing.",
    outro:
      "That's VibeCAD. Free, open source, in your browser or on your desktop. To build your first model, watch the phone stand tutorial. Thanks for watching.",
  },
};

/** Each video's chapters: a title per beat that starts one, by act and beat id ("montage" is the demo's intro, before Act 0).
 *  A beat with no title here (the title card) stays in the chapter before it. The edit embeds them in the MP4 and
 *  writes them as a YouTube description list (chapters.txt). */
export const CHAPTERS = {
  0: {
    montage: "Intro",
    "what-it-is": "What VibeCAD is",
    "get-vibecad": "Getting VibeCAD",
  },
  1: {
    "cold-open": "What you'll build",
    "get-vibecad": "Getting VibeCAD",
    "the-room": "The workspace",
    block: "Start with a block",
    "raise-the-back": "Sketch the slanted back",
    "what-it-kept": "The history",
    "make-it-parametric": "Make it parametric",
    "turn-the-dials": "Turn the dials",
    "just-type-it": "Command K",
    "keep-it": "Saving your work",
  },
  2: {
    soften: "Round the corners",
    rules: "Rules: keep it under 200 g",
    "better-versions": "The design space",
    materials: "Materials and print direction",
    "will-it-print": "Will it print?",
    "make-it-yours": "Your own action ring",
    "ship-it": "Export",
    "wrap-up": "Wrap-up",
  },
  3: {
    gyroscope: "Print-in-place gyroscope",
    clockwork: "Gears and a Geneva drive",
    walker: "Jansen wind walker",
    skadis: "SKÅDIS gravity holder",
    handlebar: "Bike handlebar",
    origami: "Paper airplane",
    "scissor-jointed": "Jointed scissor lift",
    starbox: "Snap-together star box",
    "bistable-forces": "Claude runs a force analysis",
    "print-direction": "Print direction and strain",
    gimbal: "Flexure gimbal",
    roubo: "Roubo workbench and shop drawing",
    agent: "Ask Claude to build it",
    outro: "Thanks for watching",
  },
};

/** A line's sentence groups: " | " splits a line into parts, each its own clip, the first said as the beat starts and
 *  each later one where the script calls `d.cue()` (the picture holding until the one before has been said), or
 *  straight after the one before when the script doesn't cue it. A line without " | " is one part. */
export const partsOf = (text) => String(text ?? "").split(/\s*\|\s*/).map((p) => p.trim()).filter(Boolean);
/** A part's id: the beat's for the first part, "<beat>.2", "<beat>.3", … for the rest. */
export const partId = (beat, k) => (k ? `${beat}.${k + 1}` : beat);

/** Every spoken part, in playing order: { act, id, beat, key, text }. The montage plays before Act 0 as "act0-montage". */
export function spoken(acts = [0, 1, 2, 3]) {
  const out = [];
  if (acts.includes(0)) out.push({ act: 0, id: "montage", beat: "montage", key: "act0-montage", text: MONTAGE });
  for (const act of acts) for (const [beat, text] of Object.entries(LINES[act] ?? {})) {
    partsOf(text).forEach((p, k) => out.push({ act, id: partId(beat, k), beat, key: `act${act}-${partId(beat, k)}`, text: p }));
  }
  return out;
}
