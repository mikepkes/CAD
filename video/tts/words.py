"""Word timestamps for voiceover clips, on the GPU box: `python words.py jobs.json out.json`.

jobs.json is [{"key": ..., "file": ..., "text": ...}]; each clip is transcribed with faster-whisper (word timestamps,
the script's own line as the prompt so names come out as written) and out.json maps key -> [{"w", "s", "e", "p"}]
(word, start and end seconds into the clip, probability). Used by video/checks/sync.mjs.
"""
import json, sys
import numpy as np
import soundfile as sf
from faster_whisper import WhisperModel


def load(path):
    """A clip as Whisper wants it: mono float32 at 16 kHz (the clips are 48 kHz WAVs; resampled here, not by PyAV)."""
    x, sr = sf.read(path, dtype="float32", always_2d=True)
    x = x.mean(axis=1)
    if sr != 16000:
        t = np.arange(0, len(x) / sr, 1 / 16000)
        # a short moving average first, so the decimation doesn't alias
        k = max(1, round(sr / 16000))
        if k > 1:
            x = np.convolve(x, np.ones(k) / k, mode="same")
        x = np.interp(t, np.arange(len(x)) / sr, x).astype("float32")
    return x

jobs = json.load(open(sys.argv[1]))
try:
    model = WhisperModel("small.en", device="cuda", compute_type="float16")
except Exception:  # no GPU: slower, same answer
    model = WhisperModel("small.en", device="cpu", compute_type="int8")
out = {}
for i, j in enumerate(jobs):
    segs, _ = model.transcribe(load(j["file"]), language="en", word_timestamps=True, initial_prompt=j.get("text", ""), vad_filter=False, beam_size=5)
    out[j["key"]] = [{"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3), "p": round(w.probability, 3)} for s in segs for w in (s.words or [])]
    print(f"{i + 1}/{len(jobs)} {j['key']}: {len(out[j['key']])} words", flush=True)
json.dump(out, open(sys.argv[2], "w"))
