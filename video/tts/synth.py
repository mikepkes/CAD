"""Kokoro-82M narration for the VibeCAD tutorial video; runs on the GPU box (hexgame), driven by video/vo.mjs.

    python synth.py OUT_DIR < jobs.json      # jobs: [{"key", "voice", "text"}]; writes OUT_DIR/<key>.wav
    python synth.py --phonemes "text" [--lang a|b]

For each job it synthesises the line, trims the leading and trailing silence (keeping a short pad), levels the speech
to a common loudness so switching voice tracks doesn't jump in volume, and writes 24 kHz 16-bit mono WAV. It prints
one JSON line per job: duration, the trimmed silence, peak and speech RMS (dBFS), and the phonemes Kokoro read,
so pronunciation can be checked without listening.

Model: hexgrad/Kokoro-82M (Apache-2.0), fetched from Hugging Face on first use into $HF_HOME.
"""
import json
import re
import sys
import time

import numpy as np
import soundfile as sf
import torch
from kokoro import KModel, KPipeline

SR = 24000
PAD_S = 0.06  # silence kept at each end after trimming
GATE_DB = -45.0  # below this (relative to the clip's peak) counts as silence when trimming
TARGET_RMS_DB = -20.0  # speech level (RMS over the voiced frames)
PEAK_CEIL_DB = -1.0  # never louder than this
REPO = "hexgrad/Kokoro-82M"
CHUNK_CHARS = 200  # Kokoro rushes long inputs (a 95-word line came out at 200-260 wpm), so lines go in by sentences


def chunked(text):
    """Group a line's sentences into chunks of about CHUNK_CHARS (never splitting a sentence), one per line: Kokoro
    synthesises each separately, at an even pace, and short sentences ride along with a neighbour (it is weak on
    very short inputs)."""
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    chunks = []
    for s in sentences:
        if chunks and len(chunks[-1]) + 1 + len(s) <= CHUNK_CHARS:
            chunks[-1] += " " + s
        else:
            chunks.append(s)
    return "\n".join(chunks)


def db(x):
    return float(20 * np.log10(max(float(x), 1e-9)))


def pick_device():
    if not torch.cuda.is_available():
        return "cpu"
    free = [torch.cuda.mem_get_info(i)[0] for i in range(torch.cuda.device_count())]
    best = int(np.argmax(free))
    return f"cuda:{best}" if free[best] > 900e6 else "cpu"


def frames_rms(a, n=480):
    k = len(a) // n
    return np.sqrt(np.mean(a[: k * n].reshape(k, n) ** 2, axis=1) + 1e-12) if k else np.array([np.sqrt(np.mean(a**2) + 1e-12)])


def finish(audio):
    """Trim silence, level, and report."""
    a = audio.astype(np.float32)
    peak = np.max(np.abs(a)) + 1e-9
    env = frames_rms(a, 120)  # 5 ms frames
    on = np.where(env > peak * 10 ** (GATE_DB / 20))[0]
    lead = trail = 0.0
    if len(on):
        s = max(0, on[0] * 120 - int(PAD_S * SR))
        e = min(len(a), (on[-1] + 1) * 120 + int(PAD_S * SR))
        lead, trail = s / SR, (len(a) - e) / SR
        a = a[s:e]
    fr = frames_rms(a)
    voiced = fr[fr > np.max(fr) * 10 ** (-30 / 20)]
    rms = float(np.sqrt(np.mean(voiced**2))) if len(voiced) else 1e-9
    gain = 10 ** (TARGET_RMS_DB / 20) / rms
    gain = min(gain, 10 ** (PEAK_CEIL_DB / 20) / (np.max(np.abs(a)) + 1e-9))
    a = a * gain
    return a, {
        "ms": round(len(a) / SR * 1000),
        "trimmedLeadMs": round(lead * 1000),
        "trimmedTrailMs": round(trail * 1000),
        "rawPeakDb": round(db(peak), 1),
        "gainDb": round(db(gain), 1),
        "peakDb": round(db(np.max(np.abs(a))), 1),
        "rmsDb": round(db(rms * gain), 1),
    }


class Engine:
    """Kokoro on the emptiest GPU. The GPUs are shared (an LLM server may hold most of their memory), so a clip that
    runs out of GPU memory is made on the CPU instead, and the next one tries the GPU again."""

    def __init__(self):
        self.device = pick_device()
        self.models, self.pipes = {}, {}
        try:
            self.model(self.device)
        except torch.OutOfMemoryError:
            self.device = "cpu"

    def model(self, device):
        if device not in self.models:
            self.models[device] = KModel(repo_id=REPO).to(device).eval()
        return self.models[device]

    def pipe(self, lang, device):
        if (lang, device) not in self.pipes:
            self.pipes[(lang, device)] = KPipeline(lang_code=lang, repo_id=REPO, model=self.model(device))
        return self.pipes[(lang, device)]

    def say(self, text, voice, speed=1.0):
        """→ (audio, phonemes, the device that made it)"""
        if self.device != "cpu":
            try:
                return (*self._say(text, voice, speed, self.device), self.device)
            except torch.OutOfMemoryError:
                torch.cuda.empty_cache()
        return (*self._say(text, voice, speed, "cpu"), "cpu")

    @torch.inference_mode()
    def _say(self, text, voice, speed, device):
        pipe = self.pipe(voice[0], device)  # af_/am_ → American, bf_/bm_ → British
        parts, phon = [], []
        for r in pipe(chunked(text), voice=voice, speed=speed, split_pattern=r"\n+"):
            if r.audio is not None:
                parts.append(r.audio.detach().cpu().numpy())
                phon.append(r.phonemes)
        return np.concatenate(parts), " | ".join(phon)


def main():
    if sys.argv[1] == "--phonemes":
        lang = sys.argv[sys.argv.index("--lang") + 1] if "--lang" in sys.argv else "a"
        pipe = KPipeline(lang_code=lang, repo_id=REPO, model=False)
        for r in pipe(sys.argv[2], split_pattern=r"\n+"):
            print(r.phonemes)
        return
    out = sys.argv[1]
    jobs = json.load(sys.stdin)
    eng = Engine()
    print(json.dumps({"device": eng.device, "torch": torch.__version__, "jobs": len(jobs)}), flush=True)
    for j in jobs:
        t = time.time()
        audio, phon, device = eng.say(j["text"], j["voice"], j.get("speed", 1.0))
        a, info = finish(audio)
        sf.write(f"{out}/{j['key']}.wav", a, SR, subtype="PCM_16")
        print(json.dumps({"key": j["key"], **info, "phonemes": phon, "device": device, "secs": round(time.time() - t, 2)}), flush=True)


if __name__ == "__main__":
    main()
