# Video passes: what worked, what didn't

Running notes for the automated tutorial video, newest pass first. Each pass
records what to keep doing, what broke and how it was fixed, and what is still
open, so the next pass starts from here rather than from memory.

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
