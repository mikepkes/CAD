# Video passes: what worked, what didn't

Running notes for the automated tutorial video, newest pass first. Each pass
records what to keep doing, what broke and how it was fixed, and what is still
open, so the next pass starts from here rather than from memory.

## Voiceover

Synthesised narration, 20 voices, each its own audio track in the MP4.

```
node video/vo.mjs                      # every line in every voice; only changed lines are made again
node video/vo.mjs --check              # + per line: longest/shortest voice, and the phonemes Kokoro read
node video/vo.mjs --say                # the fallback: macOS `say` (voice say-daniel), when the GPU box is unreachable
node video/vo.mjs --calibrate          # each Kokoro voice's pace over its clips, and the speed for 170 words a minute
VIDEO_VOICES=af_heart node video/…     # any subset (ids from video/lib/voices.mjs), for vo, record and edit alike
node video/checks/vo.mjs --run NAME    # after the edit: every line has its clips, each fits its beat, none overlap
```

- **The lines** live in `video/script/lines.mjs` by act and beat id (the act scripts say `d.beat(id, fn)`), plus the
  montage's. Nothing needs a browser to read them.
- **Clips:** `video/vo/<voice>/<act>-<beat>.wav`, 48 kHz 16-bit mono, with `manifest.json` per voice (text, the text
  the engine was given, hash, length by `afinfo`, peak and speech level, the silence trimmed, Kokoro's phonemes).
  A clip is used only while its hash (line, voice, speed, synth version) is current. Git-ignored.
- **Engine:** Kokoro-82M (hexgrad, Apache-2.0: free to use its output in a public video) on hexgame, over ssh:
  `vo.mjs` sends the lines as JSON to `video/tts/synth.py` (copied over each run), which runs them on the GPU with
  the most free memory, a few sentences (≤ 200 characters) at a time (given a 95-word line whole, Kokoro rushed it
  at 200–260 wpm), trims each clip's leading and trailing silence to 60 ms, levels the speech to −20 dBFS RMS
  (peaks ≤ −1 dBFS) so switching tracks doesn't jump in volume, and writes 24 kHz WAVs; they come back by rsync and
  `afconvert` makes them 48 kHz. Batches of 120 are saved as they land.
  - **The GPUs are shared:** an Ollama LLM server holds most of both cards' memory, leaving about 1 GB each. That is
    enough a few sentences at a time (all 560 clips ran on the 2080 Ti, about 1 s each, 8 minutes in all); a clip
    that runs out of memory is made on the CPU (about 10 s) and the next one tries the GPU again.
- **Voices** (`video/lib/voices.mjs`, in track order): the 20 best of Kokoro's 28 English voices by its own grades,
  11 female and 9 male, 13 American and 7 British. **The default (first track, and the preview's only one) is
  `af_heart`**, Kokoro's only A-grade voice: calm and warm. Then af_bella, bf_emma, am_michael, bm_george,
  am_fenrir, af_aoede, af_kore, am_puck, af_sarah, bm_fable, bf_isabella, af_alloy, af_nova, bm_lewis, am_onyx,
  af_sky, am_eric, bf_alice, bm_daniel. Left out: am_adam (F+), am_santa (D−), af_jessica, af_river, bf_lily,
  am_liam, am_echo (D), and af_nicole (whispery, made for headphones). To change the default, move a voice to the
  top of `KOKORO`; to add or drop one, edit the list (each needs a speed: `--calibrate`).
- **Pace:** each voice has a `speed` (0.81–1.03) that brings it to 169–173 words a minute over all the lines
  (Kokoro at speed 1 runs 166–217). The response is not linear (Eric: 186 wpm at 0.82, 163 at 0.78, 173 at 0.80),
  so after `--calibrate` check the result and nudge. Levels: speech −19.8 to −21.7 dBFS, peaks ≤ −0.6 dBFS,
  leading and trailing silence 60–120 ms after trimming.
- **Pronunciation** (`spokenText()` in `video/lib/voices.mjs`; the captions keep the written words). Checked from
  Kokoro's phonemes rather than by ear: VibeCAD → "vibe CAD" (it ran the word together), Roubo → "roo-bo" (it said
  "row-bo"), fillet → "fill-it" (it said the cooking "fil-ay"), mikepkes → "mike p kes" (garbled). Already right:
  Geneva, PETG and PLA (spelt out), STL, 3MF ("three M F"), STEP ("step"), Command K, millimetres. For `say`: the
  same words respelt, plus PETG and PLA as letters.
- **Timing:** the director pads each beat to max(its actions, the longest clip of its line across all the voices +
  0.5 s), so no voice runs into the next beat; without clips it falls back to the read time (150 wpm + 0.5 s), as
  before. `timing.json` records, per beat, `actionsMs`, `wantMs` and `defaultWantMs` (the default voice alone), and
  the edit reports how much longer the slowest voices make the cut. Each clip starts at its beat's start. The
  montage keeps its quick cuts and lets the last shot (the lamp shade turning) play on until the line is said.
- **The mix:** `video/edit.mjs` places every clip at its beat's start in the cut (the cue sheet's "In": cut and
  sped-up spans before it are already accounted for), one mix per voice (`video/out/<run>/vo/<voice>.wav`), and
  writes `vo-timeline.json`. The compositor encodes the default voice's mix as AAC (WebCodecs `AudioEncoder`) into the
  MP4 through mp4-muxer, which writes one audio track. The full render then gets all 20: `afconvert` encodes each
  mix as AAC, and ffmpeg on hexgame remuxes the video with them (`-c copy`; each named e.g. "en-US · Heart (Kokoro)"
  — ffmpeg's MP4 muxer keeps a track's name as its handler name, which players list — language eng, the first one
  default); ffprobe's report is in `tracks.json`. The preview keeps the default voice
  only. If hexgame is down, the MP4 keeps its one default track and the edit says so. `--no-vo` renders it silent.
- **Installed on hexgame** (user space, nothing system-wide, no services): `~/vibecad-tts/` holds a Python 3.12 venv
  (`venv/`, 5.9 GB: kokoro 0.9.4, misaki 0.9.4 with spaCy 3.8 and en_core_web_sm 3.8.0, torch 2.15.0 + CUDA 13.2
  wheels, transformers, soundfile, espeakng-loader, phonemizer-fork; 117 packages from PyPI), the model
  (`hf/`, 323 MB: hexgrad/Kokoro-82M from Hugging Face, `kokoro-v1_0.pth`, `config.json` and the 20 voice packs),
  and `synth.py`. Nothing runs between uses; `out/` and `mux/` are emptied after each run. ffmpeg/ffprobe are the
  system's (`/usr/bin`), already there. To remove it all: `rm -rf ~/vibecad-tts`.
- **Re-creating it:** `python3 -m venv ~/vibecad-tts/venv && ~/vibecad-tts/venv/bin/pip install kokoro==0.9.4
  soundfile`; the model downloads on first use (`HF_HOME=~/vibecad-tts/hf`).
- **First test (run `vo-test`, Act 1 only, recorded against a dev server on :5187):** 188.7 s cut, 10 voiced beats;
  the 20 voices make it 1.7 s longer than Heart alone would. Every clip is heard within 60 ms of its beat's start
  (the trim pad) and nothing outside the clips; the tightest fit leaves 0.49 s before the next beat; ffprobe lists
  20 AAC tracks of 188.67 s against 188.65 s of video; `video/checks/vo.mjs` passes (852 checks). The take itself
  has five beat failures that the unchanged pass-5 scripts also have against the current app (raise-the-back's
  picker finds only the YZ plane, and the beats after it miss their elements): re-check Act 1 before pass 5.
- **Not chosen:** Orpheus (an older setup is in hexgame's home) is a 3B model built on Llama 3.2 (that licence's
  terms apply) and needs GPU memory the Ollama server holds; F5-TTS's released weights are CC-BY-NC (not for a
  public video); Dia-1.6B (Apache-2.0) needs several GB of GPU memory, against the ~1 GB free. Kokoro fits, its
  licence is clean, and it is a strong narrator.

## Pass 6 (not recorded yet): two videos

The one video splits in two, because a showcase and a focused tutorial serve different viewers: someone deciding
whether VibeCAD is worth trying wants breadth fast; someone learning wants one model, start to finish, without
detours.

- **Demo** (Acts 0 and 3, with the montage): a new Act 0 after the montage. The VibeCAD title, then "what it is":
  the finished phone stand turned and its phone thickness dragged (Act 1's cold open, shared), then where to get it,
  then straight into the showcase. The outro now points to the tutorial.
- **Tutorial** (Acts 1 and 2): titled "Model a phone stand". No montage; the cold open says what you'll build and the
  route (by hand, parametric, then rounded, checked, exported). Act 2 gains a `wrap-up` beat: the finished stand
  turning, then an end card pointing to the demo.
- Each video has its own chapters, cue sheet, subtitles and voice tracks, in `video/out/<run>/<demo|tutorial>/`.
  The montage line is now `act0-montage` (its clips were made again under that key).

## Pass 5 (not recorded yet): your pass 4 review

### Your review of pass 4, and what changed

- **"Do you show command K in action?"** It wasn't shown. Two places now:
  - **Act 1:** a new beat, *just-type-it*, after the dials. ⌘K → "right" (side view), "phone 14", "back to 2", "roll end".
  - **Act 2:** the *rules* beat adds `mass <= 200` through ⌘K instead of the Ledger's field.
  - **Director:** `d.intent(text, expect)` checks that the top suggestion is `expect` before pressing Enter.
  - **App fix this found:** every hotkey was ignored while an `<input>` had focus, including a slider just dragged. Now only text fields keep all their keys. Sliders and checkboxes keep their plain keys and let ⌘/Ctrl shortcuts through (`TEXT_INPUTS` in `src/model/hotkeys.ts`).
- **A Geneva drive on the clockwork.**
  - **Mechanism:** spur G (12 teeth) meshes spur A and turns a crank at −5/8 of `turn`. The crank pin steps a four-slot star a quarter turn per revolution, and a locking disc holds the star in its arcs between steps.
  - **The star's joint:** the step count is `floor(t/360)`. While the pin is in the slot, the star angle is `atan2(sin ψ, 1/sin(π/4) − cos ψ)`, with ψ clamped to ±45°.
  - **Tests:** `test/clockwork.build.test.ts` checks the dwell and the step values, that the slot points at the pin through a step, and that the drive is clear at crank 140°, 165°, 195° and 220°.
  - **Act 3:** the clockwork clip ends on a close-up of three steps.
- **"The URL on the burnt-in subtitles is spelled out."** The narration says "mikepkes dot github dot io slash CAD" so the voice reads it right. The captions now write it out as `mikepkes.github.io/CAD` (`written()` in `video/edit.mjs`, applied after chunking so the dots don't split sentences). It only matches words ending in a real domain, so "a dot on the plate" is left alone. The cue sheet keeps the spoken form.
- **"We should probably have a title screen right after the montage."**
  - **The title:** a silent *title* beat opens Act 1. It shows a large "VibeCAD" with an accent V and "Parametric CAD in your browser. Drag it, type it, or just ask." on an opaque ground, held for 2.6 s.
  - **No flash of the model:** the card goes up in the preroll, before the take starts, so the montage cuts straight to it.
  - **Edit:** silent beats get no cue or caption.
  - **Get VibeCAD:** the later download card is retitled "Get VibeCAD", so it doesn't repeat the title.
- **"The montage should only have one shot of each model."** It now has 8 shots, one per model: gyroscope, clockwork, scissor lift, star box, force analysis, gimbal, leg vise, lamp shade. Dropped: planetary, worm, Geneva, shop drawing, agent build. The caption is now "Sections, gears, mechanisms, forces, and parts built just by asking."

## Pass 4 (2026-11-01): your pass 3 review

### Your review of pass 3, and what changed

- **The model blinked out while a side panel was resized.** Fixed in the
  app (a resize now redraws at once); see "From reviewing pass 3" below.
- **The pin on the block jumped about while its size was dragged.** Fixed in
  the app (stable face, true centre, no side-flipping near the middle).
- **The coaster wasn't impressive, and the agent should take a refinement.**
  The agent beat is now a two-prompt conversation (`video/mock/agent-vase.json`,
  which replaces the coaster):
  1. "Design a twisted vase…": three parameters, six hexagon sections up the
     height (each 18° on from the one below, sized from `width`), a loft
     through them and a shell with an open top;
  2. "Now turn it into a lamp shade…": three vertical planes 60° apart, a
     3 × 7 grid of round windows on each, cut through both walls, then a white
     PETG material.
  The cache was made by running every tool call in a fresh document, so the
  ids it refers to are the ones the app creates; every sketch and feature is
  named, so organizational assist never renames one mid-replay (a rename uses
  up an id and would shift the rest). `AgentCache.followUps` holds the
  refinement prompts; the script types each after the previous run ends.
  The vase and the lamp shade are both montage picks.

### What broke this pass, and the fix

| Problem | Cause | Fix |
|---|---|---|
| The lamp shade stayed lavender after "make it in white PETG" | A loft has no single sketch, so the viewport found no component for it and ignored the document-wide (root) material | App: `materialForComponent` falls back to the root component (also fixes 3MF export and the cut list) |
| The last sketch's dimension and a DOF count stayed on screen after the agent finished | The agent's feature commands switched to model mode but left the sketch open | App: a feature from the agent closes the open sketch, as finishing one does |
| The loft twisted much less than designed | Hexagons repeat every 60°: steps of 30° or more between sections made the loft match the nearer corners and twist back | Six sections 18° apart |

## Pass 3 (2026-11-01): your pass 2 review, and the rename

Recorded once the review notes were in. Each note below was acted on; "What
changed" says how, and "Still open" what remains.

### Renamed to VibeCAD

The app is now **VibeCAD** (was Chisel CAD). The scripts, title cards, VO
lines and output names (`vibecad-tutorial.mp4`) say VibeCAD; the demo API is
`window.__vibecadDemo`. Passes 1 and 2 below keep the old name as recorded.
Their cuts still show "Chisel": pass 3 must be recorded fresh, with nothing
reused from older takes (the montage included). The address stays
mikepkes.github.io/CAD while the repository is named CAD.

### Your review of pass 2

- **Gyroscope section: show the bearing.** The bearing is the most interesting
  part of the cut. Pass 2 cut on XZ and then turned the model at 10°/s, so the
  bearing was only seen at an angle. Next pass:
  - after the cut, ease the camera into a straight-on view, looking square at
    the cut face (along Y for the XZ plane), rather than just spinning;
  - frame the view (or zoom) on a pivot so the bearing reads clearly, and hold
    long enough to see how its cone comes to a point inside its seat;
  - the motion study follows after that.
  - Needs: named views already ease over 0.5 s (`SceneManager` tween), which
    is quick on camera, so a slower duration in the demo API; and a way to
    frame a world-space box (the pivot's) instead of `frameAll`.
- **Intro: a rapid-fire jump-cut montage.** At the start, during the intro,
  flash through the most exciting things Chisel can do, each held only a
  quarter to a third of a second (15–20 frames at 60 fps), so the viewer sees
  the range before the slow walkthrough begins.
  - Candidates: gyroscope section, clockwork gears turning, bistable force
    chart and strain lens, star box closing, scissor mechanism, gimbal, Roubo
    shop drawing, the agent building the coaster, the phone stand adapting.
  - Likely build: cut it in `edit.mjs` from the Act 3 takes (and Act 1/2 where
    useful) rather than recording it, as a list of (take, source time) picks;
    choose the frames when each clip's motion is at its most striking.
  - Decide where it sits against the cold open's phone-stand drag and the
    title card (before, or between them), and that the montage is long
    enough for its VO line: ~10 clips × 0.3 s is about 3 s.
- **Cold open: the phone-thickness drag lands edge-on.** The turntable keeps
  turning at 12°/s through the drag (`act1.mjs`, cold-open beat), and the
  9 → 15 → 9 mm edits happen while the stand is side-on to the camera, so the
  lip gap widening is hard to see. Next pass:
  - ease the turntable to a stop (or ease into a fixed view) before the drag,
    at a three-quarter angle where the lip and the phone gap face the camera;
  - pick that angle from the model, not from timing: the stand's side profile
    (the lip and back plate) should read clearly, so the gap visibly opens;
  - resume the slow turn after the drag back, if at all;
  - check by sampling frames during the drag (as with the spin check), not by
    eye on the full cut.
- **Clockwork: fill the frame and show the gears turning together.** The
  gears should fill most of the viewport, and we should see them rotate so
  the ratios between them read (the worm creeping the wheel, the rack
  sliding, the bevels turning the cross shaft). In pass 2 the model sat small
  in the frame under a turntable, and the `turn` sweep was 40 coarse steps
  played at 19× (each step a full rebuild), so it read as jumps, not motion.
  Next pass:
  - frame the gear train tightly (front or three-quarter view onto the gear
    faces), with no turntable, so the camera holds still and only the gears
    move;
  - turn them smoothly at real speed: drive `turn` as a pose (transforms of
    the rebuilt bodies, as the motion study does) instead of a rebuild per
    step, or pre-bake the frames; fixes the "19×" open item too;
  - slow enough to follow a tooth through a mesh, perhaps a close-in on one
    pair (worm and wheel) after the wide shot.
  - **No turntable at all in the gear clip** (your follow-up): the spinning
    camera detracts. Spend that time on the gear motions instead, and go
    further into the mechanisms: after the wide shot, move in on two or three
    meshes in turn (worm and wheel, rack and pinion, the bevel pair, the ring
    gear and its planets) with the camera still while each turns.
- **Roubo bench: fill the frame, and open the leg vise before the drawing.**
  The bench sat too small in frame (the iso `frameAll` leaves a lot of floor
  around a long, low bench). Next pass:
  - frame it tighter: a three-quarter front view that puts the bench's length
    across the frame, so it fills most of the viewport;
  - before switching to the shop drawing, a quick animation of the leg vise
    opening: sweep the `viseGap` parameter (0–170 mm), which drives the vise
    chop's slider joint and the crisscross arms with it, ideally moving in on
    the vise while it opens; then out and on to the drawing;
  - as with the gears, drive it as a pose rather than a rebuild per step, so
    it moves smoothly at real speed.
- **Zebra stripes need a curved surface to show off.** In Act 2's
  will-it-print beat the zebra view (key 5) landed on the stand's flat faces,
  where the stripes are just straight bands and show nothing. The only fillet
  is the small round on the base's front edges (the soften beat). Next pass:
  - give the phone holder an aggressive fillet on a corner (a large radius,
    e.g. the outside corner where the back plate rises from the base, or the
    back plate's top corners), either in the soften beat or as its own short
    step, so a real curved surface is on screen;
  - aim the camera at that fillet when zebra comes on, with a slow move
    (orbit a few degrees) so the stripes visibly sweep and bend through the
    curve, which is what shows the surfaces flow into each other;
  - check the fillet still builds across the phone-thickness range and keeps
    the mass rule in Act 2 passing (it removes material, so it should).
- **The action ring is shown but never used.** In pass 2 the ring appears
  twice and does nothing either time: Act 1's room tour presses Space, holds
  1.8 s and presses Escape; Act 2's make-it-yours opens the shortcuts dialog
  on its Ring tab and clicks Done without changing a slot. Nobody sees it run
  an action, see that it changes with context, or that editing it matters.
  Next pass:
  - use it for real in Act 1 at a natural moment, with the hold-point-release
    gesture visible (Space held, the cursor flicks toward a slot, the slot
    lights, release runs it): e.g. start the block from the model ring's Box
    slot, and later, with a face selected, use the face ring for Sketch or
    Round edges, so the ring visibly changes with what's selected;
  - in Act 2's make-it-yours, actually change a slot (put an action you just
    used, e.g. Round edges, on an empty slot), close the dialog and use the
    new slot straight away;
  - the cursor matters here: keep it on and slow the flick enough to follow.
- **Widen the Parameters panel while values are being edited.** The panel is
  narrow, and each parameter row splits its width four ways (name,
  expression, slider, value: `.param-row` in `styles.css`), so the slider is
  about 40 px on camera. Next pass, at least for the stretches where we edit
  values (the cold-open drag, naming numbers, adding `phone`, the montage
  sweeps):
  - widen the left panel smoothly for the edit and narrow it again after, so
    the slider and value read clearly: `D.sideWidth("left", 480, 600)` eases
    it (and back to 272 after);
  - **fixed in the app**: both side panels now resize by dragging their inner
    edge (double-click resets; the width is remembered), and a bounded
    parameter's slider has its own full-width line under its row, with its
    extents at the ends and the expression still editable in the row. The
    script's `.param-slider input[type=range]` selector still finds it.
- **A flash of the bench before "just describe it".** Cause: the Roubo clip
  ends with `d.key("Escape")` inside the recorded beat (`act3.mjs`), which
  closes the shop drawing and shows the bench again for the rest of the beat
  (its padding to VO length plus the 0.5 s handle) before the cut to the new
  document. Fix: end the Roubo beat on the drawing, and close it inside the
  following `d.cut` (`closeDrawing()` with `newDocument`). Check every clip's
  last frames for the same pattern: nothing should change on screen after a
  clip's final shot.

### What changed

- **Demo API for camera work and motion** (`src/demo/demo.tsx`):
  - `aim({ dir, box, ms, margin })` flies the camera to look at a box (or
    everything) from a direction, over a chosen time;
  - `componentBox(names)` is the world box of named components;
  - `poseSweep(name, from, to, ms)` drives a parameter by moving the built
    parts (`SceneManager.beginAnimation(…, live)`), never rebuilding:
    0.1 ms a pose on the clockwork, so gears and the vise move smoothly at
    real speed; sweeps chain, `poseEnd()` returns to the built model;
  - `sideWidth(side, px, ms)` eases a side panel's width.
- **Director**: `d.ring(label)` uses the action ring for real (hold Space,
  glide to the slot, release; it always lets go of Space, even on an
  error); `d.pick(label)` marks a moment for the intro montage.
- **Edit**: the montage is a third of a second from each of Act 3's picks
  (11), cut before the cold open, with its own VO line.
- **Act 1**: the cold open stops side-on to the stand's profile, widens the
  Parameters panel, drags phone 9 → 15 → 9 and narrows it again; the block
  starts from the model ring (Add a box) and the back plate's sketch from
  the face ring; turn-the-dials widens the panel too; New no longer brings
  the origin planes back.
- **Act 2**: soften uses the new **Round corners** (a 15 mm fillet on the
  base's four corners), and zebra comes on aimed at a rounded corner with
  a slow orbit; make-it-yours puts Round edges on the face ring's SW slot,
  closes the editor and uses it on the base's top.
- **Act 3**: the gyroscope turns square to the cut and moves in on a cone
  pivot; the clockwork has no turntable, a still wide shot, then the
  planetary set and the worm and wheel; the Roubo is framed long-ways, its
  leg vise opens and closes in close-up, and the shop drawing closes in the
  cut (no bench flash).
- **App**: Round corners on a face card (and `face.roundCorners`): rounds
  the edges running back from an axis-aligned face, e.g. a plate's corners.

### What broke this pass, and the fix

| Problem | Cause | Fix |
|---|---|---|
| Act 2's ring step found no Round slot, and Export failed after it | The click on the back plate's thin top used the stand's default size, but the design space had changed width and depth, so no face was selected; the helper then left Space held, the ring open over the menu | Positions come from the stand's actual bounds; `d.ring` releases Space and presses Escape on any error |
| The zebra close-up aimed past the corner | Same: the default-size corner | Same: actual bounds |
| The worm's montage pick landed in the cut after the clip | Picked after the last sweep | Pick mid-sweep |
| Vise close-up too tight, bench clipped at the right | Margins | Vise 1.2, bench 0.7 |

### From reviewing pass 3

- **The model blinked out whenever a side panel was resized** (several
  times in the cut, wherever the Parameters panel widened or narrowed).
  Resizing the canvas clears it, and nothing drew again until the next
  animation frame, so the browser could paint it blank. Fixed in the app:
  `SceneManager.onResize` redraws at once. `video/checks/resizeFlicker.mjs`
  measures it: 232 of 240 frames blank during a resize before, 0 after.

- **The feature pin on the block jumped about while its size was dragged.**
  Three causes, all in the app: the pin sat on the largest face, which
  switched between top and sides as the box changed shape; it sat on the
  centre of the triangle nearest the face's centre, which hopped between the
  face's two triangles; and its leader pointed away from the viewport
  centre, flipping sides whenever the anchor crossed the middle. Now it
  prefers the largest upward-facing face, sits on the face's true centre,
  and keeps to the north-east within 60 px of the middle.
  `video/checks/pinJitter.mjs` drags a box's number as Act 1 does: the
  largest jump between frames was 126 px, now 0.5 px.

### Still open after pass 3

- The face ring opens over the face card in Act 1 (true to the app, but
  busy); the card could step aside while the ring is open.
- The zebra loupe shares the frame with the lens settings popover.
- Adding `phone` and the lip's dimension are still done by command
  (PUPPET), and the parameter sweeps in the montage clips still rebuild.
- The voiceover, and the release before the final cut.

## Pass 2 (2026-10-31): review fixes and new features

### Your review of pass 1, and what changed

| Note | Finding | Change |
|---|---|---|
| "Opening spin is super fast" | Successive frames (a contact sheet at 0.1 s steps, `video/sheet.mjs --at 0.5,0.6,…`) showed about 45° per tenth of a second, around 450°/s. The spin went through 3D-mouse input, whose rate depends on the device tuning | A real turntable in the demo layer, in degrees per second (`turntable(12)`), easing in and out |
| "The angled extrude distance should be able to go to a surface, like the extent in F360" | Extrude only had a distance (a minus sign to go into the body) or through all | `feature.extrude` extent **To face** (`toFace` face ref, re-found on every rebuild, so the extrude follows the face when the base changes). The panel has Extent: Distance / To face; the catalog says "up to a face". Parallel planar faces for now |
| "Confused what the 1, 2, 3 are pointing at" | Pins anchored on top of the body's bounding box; once the parts are joined into one body, every pin pointed at empty air at the height of the back plate | Pins anchor on the largest face their own feature made (`faceAnchor`), so 1 sits on the base, 2 on the back plate, 3 on the lip |
| The far face is hidden (behind the model, then behind the extrude panel) | Turning the view to reach it worked once, then the face sat under the panel | A Fusion-style **long-press selection picker**: hold still for 0.45 s to list everything under the cursor, nearest first (back faces and planes included); hovering an entry lights that face on the model, drawn through whatever is in front; choosing acts exactly as clicking that face would. Act 1 now picks the far face this way on camera |
| "Export options don't need to be top-level buttons" | STEP, STL and 3MF were toolbar buttons | One **Export ▾** menu: STEP, STL, 3MF and the Shop drawing |
| "Show off drawings for the woodworking bench" | `core/drawings.ts` already made a third-angle sheet and cut list, with no way to see them | **Shop drawing** view (Export ▾, or the `model.drawing` action): the sheet, the cut list, SVG and CSV downloads, made on the geometry worker |

Built in parallel by three agents (separate worktrees and branches, merged before recording):
- **Gears** (`feature.gear`): spur, helical, herringbone, ring, rack, straight bevel, worm and worm wheel, with bores, hubs, spokes and print backlash, and meshing by expression. The **clockwork** example drives every type from one `turn` slider through the real tooth ratios. It also fixed backlash on internal gears, and a kernel memory leak per boolean that ran the examples suite out of memory.
- **Compliant data**: a **Mechanism** tab with a force-travel chart (rests, tipping point, snap force, a live marker, Sweep) and per-flexure strain bars, and a **Strain** lens mode.
- **Organizational assist**: default-named sketches and features are named by Claude (Haiku) a few seconds after you stop; a status-bar inbox; `get_assist_inbox` / `resolve_assist` and an inbox resource with change notifications for MCP agents; `set_panel` and `run_action` so an agent can open any panel or run any action.

### Result

`video/out/pass2/chisel-tutorial.mp4`: 5:49, 1440p60, 122 MB; `chisel-tutorial-preview.mp4`: the same at 720p, 24 MB, for a phone (`node video/edit.mjs --run pass2 --preview`). All 24 beats ran without a failure. Act 3 is now: gyroscope with a section cut and the motion study, the gears clockwork, the jointed scissor, the star box, the bistable switch (asking Claude, which opens the force analysis, sweeps it and turns the lens to strain), the gimbal, the Roubo bench and its shop drawing, and the coaster built by describing it.

### What broke this pass, and the fix

| Problem | Cause | Fix |
|---|---|---|
| Acts 2 and 3 recorded an empty page | Deleting the agents' worktrees while recording made Vite clear its cache and force a full reload; it was also watching `video/takes`, where the frames are written | Vite ignores `.claude/`, `video/takes/` and `video/out/`. Never change the working tree during a take |
| A white frame and a reload one second into Act 1 | Vite pre-bundling dependencies on first use of newly merged code, then reloading the page | `record.mjs` warms the app up (loads it and the examples) before any take; the director notes any page reload during a take as "re-shoot this act" |
| The clockwork sweep took 803 s in a dry run | The clip ran a turntable, and each sweep step waited for the camera to stop, so every step hit the 20 s timeout | `settle(…, { camera: false })` for sweeps; the montage frames each model after loading it |
| Both extrudes were named "Back plate" | The mock's names are keyed by default name, and both were "Extrude" | A name list is used in order; one replay client per mock, so it advances across requests |
| The lip's far face was behind the extrude panel | The base is 6 mm tall; in the side view it sits where the panel is | The selection picker, from a point on the back plate's far side (the same plane) |

### Still open after pass 2

- **The origin planes reappear after New in Act 1** (the preroll hides them; New shows them again). Hide them after New.
- **The clockwork sweep runs at 19×**: every turn step rebuilds in the browser here, although the agent saw the slider update at once. Worth profiling.
- **The lens HUD is half behind the agent panel** in the bistable clip.
- **The timeline shows command names** ("Extrude", "Sketch 1 · face") while everything else shows the assist's names.
- **The parameter sliders are still tiny** on camera.
- The phone parameter and the lip's dimension are still puppeted, and the voiceover is still to record.

## Pass 1 (2026-10-31): first automated cut

### Tooling decisions

- **Capture in Playwright's Chromium, not the desktop app.** This Mac has no Chrome, ffmpeg or Homebrew. Playwright's Chromium (a dev dependency, 1.64.1) gives real input, GPU WebGL (ANGLE on Metal), H.264 encoding at 1440p in WebCodecs, and frame capture over CDP at about 57 fps at 2560×1440. The front end is the same as the desktop app's; only the window chrome differs. Capturing the Tauri window would need ScreenCaptureKit and the Screen Recording permission.
- **No ffmpeg anywhere.** Compositing and encoding run in a Chromium page with WebCodecs and `mp4-muxer` (already a dependency, used by the turntable export). The file streams to disk through a small local server, so a long cut never sits in browser memory. Rendering runs at about 1.7× real time.
- **1440p as 1440×810 points at a 16/9 scale factor.** More room than 1280×720 at 2×, and the text is still large enough on a phone. The toolbar still wraps onto two rows at this width.
- **Input is real.** Clicks, drags, keys and typing go through Playwright's mouse and keyboard, so hover states, previews, snapping and inference behave as they do for a person. The demo layer only draws what happened: the cursor at the real pointer, a ripple on a press, keycaps for real key presses.
- **Beats are timed by their words.** Each beat runs at least as long as its line takes to read at 150 words a minute plus a 0.5 s handle. Sped-up spans count at their sped-up length. This keeps picture and voiceover in step for ADR recording without stretching anything.
- **The running project is code** (`src/demo/stand.ts`) with a test, and the mock agent's cache has a test too. A model change that would break a take fails CI first.

### Result

`video/out/pass1/chisel-tutorial.mp4`: 5:25, 2560×1440, 60 fps, H.264, 94 MB, silent, with burned-in subtitles; plus `subtitles.srt` (71 captions) and `cue-sheet.md`. 406 s of takes (23,135 frames, 4.8 GB) recorded with no failed beats. Act 3 went from 162 s of capture to 81 s on screen (9 cuts, 5 sped-up spans).

Review it with `node video/sheet.mjs --run pass1 --every 14`: contact sheets of composited frames (chyrons and subtitles included) in `video/out/pass1/sheet-*.png`.

### What worked well

- Building the stand by hand on camera with the real UI: B for a box, clicking faces, dragging the Push/Pull number, typing one size, turning to the hidden faces with standard views, drawing the slanted back with real line-tool clicks on the face sketch, the extrude panel's distance and Join.
- Name this number (ƒ) on the box's card, straight from the UI.
- The Ledger: typing an intent, waiting for a built fix and accepting it. The Design Space: sampling, Pin, Jump to lightest, Compare.
- The mock agent: the real panel, typed prompt, replayed text and real tool calls building the coaster. Deterministic and indistinguishable from a live run.
- Beat stills (`beats/*.png`) after every take made each failure obvious in seconds.
- The cut span: loading each montage model vanishes from the edit.

### What broke, and the fix

| Problem | Cause | Fix |
|---|---|---|
| Face clicks selected nothing | The face's centre lay on an origin plane (y = 0 or x = 0), and after the cold-open stand the planes were big enough to win the pick | Aim off-centre on faces; hide origin planes for the video (nothing is sketched on them) |
| A face click hit the wrong place | The camera was still moving when the point was projected | `settle()` also waits for the camera to stop |
| `settle()` never returned | Orbit damping leaves sub-pixel drift, so the pose never read as still | Compare the pose rounded to 0.1; a timeout is now a logged note, not a failure |
| Later face clicks landed on cards | The feature card that opens with a new box, and the face card, cover nearby faces | Close cards before each face click (`closeCards`, as clicking away would; a PUPPET step) |
| The cold open left the camera spun round, so +X faced away | The drift wasn't followed by a view reset | Reset to the iso view after New |
| "Pin" clicked the Pins toggle | Text matching by "includes" | `=text` for an exact match |
| "Compare" was below the right panel's fold | No scrolling before the click | `rect()` scrolls the element into view first |
| The extrude panel's operation wasn't set | The panel has two dropdowns (Profile, Operation) | Select the last one |
| No fix was offered for "mass ≤ 150" | 232 g at the default aluminium density; nothing in range gets under 150 | Use 200 g, which some sizes pass |

### Puppeted steps (a command instead of the UI), to replace with real UI

- Adding the `phone` parameter and the lip's dimensions (`phone + 2`): the inline dimension tool on a face sketch isn't scripted yet. This is the beat that most needs to be real.
- Closing cards before face clicks.
- Hiding origin planes, collapsing the side panels and turning off pins for the montage.
- Sweeping example parameters in the montage (`setParameterExpr` in steps rather than dragging the slider: the panel's sliders are tiny on camera).
- Running the gyroscope's motion study (the store action rather than its button).

### Gaps in Chisel this pass exposed

- **The Parameters panel's sliders are tiny** (about 40 px) and hard to see on camera or to drag precisely.
- **Extruding from a side face into the body needs a negative distance** (−90). A Flip direction toggle would read better than a minus sign.
- **No presentation mode.** The montage had to collapse the side panels by hand; a mode that hides everything but the model (and a lower third) would serve demos and screenshots.
- **Mass assumes aluminium** until a material is assigned. For a printed part PLA is the natural default, and assigning a material isn't one click.
- **Sketches show as "custom" in the browser but "face" in the timeline** for the same face sketch.
- **Long action ring labels are cut short** (from the plan; still open).

### From reviewing the cut

- **It's 5:25, not about 12 minutes.** Act 2 is a subset of the plan, and Act 3 runs at seven seconds a clip after its loads are cut. Act 1 (2:40) is close to the planned four minutes.
- **The star box's width sweep ran at 13× speed** (33 s of rebuilds for 8 values). A sweep this slow should step fewer values, or be pre-built as variants and cross-faded.
- **Spoken and written forms differ.** The subtitle reads "mikepkes dot github dot io slash CAD" because it is the spoken line. The script needs both forms (for example `{spoken|written}`), with the written form used for subtitles.
- **The toolbar lists every datum plane as a button**, so the gimbal and star box show a crowded toolbar (a product gap).
- **Cuts between montage clips are hard cuts.** A short cross-fade would read better, and the edit pass could do it.
- **The ring and hotkeys beat shows the editor only briefly.** It should show a slot being changed, then the ring.

### Still to do

- Record the voiceover to picture from `cue-sheet.md` and mux it in (the MP4 is silent).
- Replace the puppeted parameter and dimension steps with real UI.
- Act 2 is a subset of the plan: the cable slot, two materials and configurations are not in it yet.
- The montage lacks sheet metal, weldments, and gears and threads (no example files for them yet).
- Capture from the desktop app itself (ScreenCaptureKit) once the browser version is settled.
