# The tutorial video, automated

Everything that makes the VibeCAD tutorial video lives here, so a take can be
re-shot after any change to the app by re-running two commands. The plan (acts,
beats, why each beat exists) is the doc *VibeCAD video tutorial plan*; what
worked and what didn't on each pass is in [NOTES.md](NOTES.md).

```
npm run dev                                   # the app on :5173 (or npm run tauri:dev)
node video/vo.mjs                             # the voiceover: every line in 20 voices (Kokoro on the GPU box; --say for macOS)
node video/record.mjs --run pass2             # record acts 1-3 in real time (about 7 min)
node video/edit.mjs --run pass2               # cut, speed up, subtitle and encode (about 4 min)
node video/edit.mjs --run pass2 --preview     # a 720p copy under 30 MB, for review on a phone
node video/sheet.mjs --run pass2 --every 15   # contact sheets of the cut, for review
node video/checks/vo.mjs --run pass2          # every line has its clips, each fits its beat, none overlap
```

Don't change files in the repo while a take records: the dev server reloads the page (it ignores `video/takes`,
`video/out` and `.claude/`, but not your source). `record.mjs` warms the app up first and flags any reload.

Output: `video/out/<run>/vibecad-tutorial.mp4` (2560×1440, 60 fps, H.264),
`subtitles.srt`, `cue-sheet.md` (the ADR sheet for recording the voiceover to
picture) and `plan.json`, plus `vo/<voice>.wav` (the mix per voice) and `vo-timeline.json`. The MP4 carries
every voice as its own audio track (the first, the default, is Heart); the preview carries just the default. Takes (every captured frame, as JPEG) are in
`video/takes/<run>/act<N>/`; both folders are git-ignored and large (about 1 GB a
minute of takes).

## How it works

| Piece | File | What it does |
|---|---|---|
| Demo layer | `src/demo/demo.tsx` (loaded by `?demo`) | Draws the presenter cursor where the (automated) pointer really is, a ripple on each press, keycaps for real key presses, lower thirds and title cards. Exposes `window.__vibecadDemo`: `settle()` (rebuild done, camera still, nothing changing), screen positions of world and sketch points, the stand builder, the mock agent. |
| The running project | `src/demo/stand.ts` | The phone stand as data and steps; `test/tutorialStand.test.ts` builds it in Node so a change that breaks the video's model fails a test first. |
| Mock agent | `src/demo/agentReplay.ts`, `video/mock/agent-*.json` | Replays a cached Claude response through the real agent loop: the text streams into the panel and the cached tool calls run as real commands. `test/videoMocks.test.ts` checks every cached call still builds. `recordAgent(prompt)` on the demo API records a real run (with an API key) to refresh a cache. |
| Director | `video/lib/director.mjs` | Opens Chromium (Playwright) at 1440×810 points × 16/9 = 2560×1440 pixels, drives the app with real mouse and keyboard input, captures every painted frame over CDP (about 57 fps), pads each beat until its line has been said (the longest of its voiceover clips + 0.5 s, or the read time at 150 words a minute without clips), and logs spans to speed up (`fast`) or remove (`cut`). |
| Playback script | `video/script/act1.mjs` … `act3.mjs` | The beats: what happens. Steps marked `PUPPET` go through a command instead of the UI. |
| Narration | `video/script/lines.mjs` | Every beat's spoken line by act and beat id (and the montage's), read by the director, the voiceover and the edit. |
| Voiceover | `video/vo.mjs`, `video/lib/voices.mjs`, `video/tts/synth.py` | One clip per line per voice in `video/vo/<voice>/`, cached by a hash of the line and the voice. See NOTES.md, "Voiceover". |
| Recorder | `video/record.mjs` | One take per act, a still per beat in `beats/` for review, `VIDEO_DEBUG=1` for more stills, `--dry` to run without capturing. |
| Edit pass | `video/edit.mjs`, `video/compositor/` | Builds the 60 fps timeline (sped-up spans get a `⏩ N× speed · label` chyron; cut spans vanish), splits narration into subtitles, writes the SRT and cue sheet, mixes each voice's clips at their beats' starts, and encodes in Chromium with WebCodecs + mp4-muxer (the default voice as AAC); ffmpeg on the GPU box then adds the other voices as tracks. |

## Re-shooting

- One act: `node video/record.mjs --acts 2 --run pass2`, then `node video/edit.mjs --run pass2` (it picks up whichever acts exist).
- A dry run to check a script change: add `--dry` (nothing is captured; the beat stills still appear).
- Narration lives in `video/script/lines.mjs`, by beat id. After editing a line, run `node video/vo.mjs` (only that line's clips are made again), then re-shoot the act so its beat is re-timed to them.
- To record a human voiceover instead, `cue-sheet.md` still lists every line with its timecode; `--no-vo` renders the MP4 silent.
