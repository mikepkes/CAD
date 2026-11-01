# Video passes: what worked, what didn't

Running notes for the automated tutorial video, newest pass first. Each pass
records what to keep doing, what broke and how it was fixed, and what is still
open, so the next pass starts from here rather than from memory.

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
