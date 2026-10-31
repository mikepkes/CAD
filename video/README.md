# The tutorial video, automated

Everything that makes the Chisel CAD tutorial video lives here, so a take can be
re-shot after any change to the app by re-running two commands. The plan (acts,
beats, why each beat exists) is the doc *Chisel CAD video tutorial plan*; what
worked and what didn't on each pass is in [NOTES.md](NOTES.md).

```
npm run dev                                   # the app on :5173 (or npm run tauri:dev)
node video/record.mjs --run pass2             # record acts 1-3 in real time (about 7 min)
node video/edit.mjs --run pass2               # cut, speed up, subtitle and encode (about 4 min)
```

Output: `video/out/<run>/chisel-tutorial.mp4` (2560×1440, 60 fps, H.264),
`subtitles.srt`, `cue-sheet.md` (the ADR sheet for recording the voiceover to
picture) and `plan.json`. Takes (every captured frame, as JPEG) are in
`video/takes/<run>/act<N>/`; both folders are git-ignored and large (about 1 GB a
minute of takes).

## How it works

| Piece | File | What it does |
|---|---|---|
| Demo layer | `src/demo/demo.tsx` (loaded by `?demo`) | Draws the presenter cursor where the (automated) pointer really is, a ripple on each press, keycaps for real key presses, lower thirds and title cards. Exposes `window.__chiselDemo`: `settle()` (rebuild done, camera still, nothing changing), screen positions of world and sketch points, the stand builder, the mock agent. |
| The running project | `src/demo/stand.ts` | The phone stand as data and steps; `test/tutorialStand.test.ts` builds it in Node so a change that breaks the video's model fails a test first. |
| Mock agent | `src/demo/agentReplay.ts`, `video/mock/agent-*.json` | Replays a cached Claude response through the real agent loop: the text streams into the panel and the cached tool calls run as real commands. `test/videoMocks.test.ts` checks every cached call still builds. `recordAgent(prompt)` on the demo API records a real run (with an API key) to refresh a cache. |
| Director | `video/lib/director.mjs` | Opens Chromium (Playwright) at 1440×810 points × 16/9 = 2560×1440 pixels, drives the app with real mouse and keyboard input, captures every painted frame over CDP (about 57 fps), pads each beat to its narration's read time (150 words a minute + 0.5 s), and logs spans to speed up (`fast`) or remove (`cut`). |
| Playback script | `video/script/act1.mjs` … `act3.mjs` | The beats: what happens and the narration line. Steps marked `PUPPET` go through a command instead of the UI. |
| Recorder | `video/record.mjs` | One take per act, a still per beat in `beats/` for review, `VIDEO_DEBUG=1` for more stills, `--dry` to run without capturing. |
| Edit pass | `video/edit.mjs`, `video/compositor/` | Builds the 60 fps timeline (sped-up spans get a `⏩ N× speed · label` chyron; cut spans vanish), splits narration into subtitles, writes the SRT and cue sheet, and encodes in Chromium with WebCodecs + mp4-muxer. |

## Re-shooting

- One act: `node video/record.mjs --acts 2 --run pass2`, then `node video/edit.mjs --run pass2` (it picks up whichever acts exist).
- A dry run to check a script change: add `--dry` (nothing is captured; the beat stills still appear).
- Narration lives in the script beside its action, so editing a line re-times its beat on the next take.
- The voiceover is recorded after the cut, to picture, from `cue-sheet.md`; then mux it in (the MP4 has no audio track yet).
