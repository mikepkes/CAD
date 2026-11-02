// The voiceover's voices, how each line is said, and where its clips live. Shared by video/vo.mjs (synthesis), the
// director (beat timing) and video/edit.mjs (the mix). No browser and no network here.
//
// Clips: video/vo/<voice id>/<act>-<beat id>.wav (48 kHz 16-bit mono, silence trimmed, levelled), plus a
// manifest.json per voice recording each clip's text, hash and length. A clip counts only while its hash matches
// the line as it is now, so an edited line falls back to its read-time estimate until it's re-synthesised.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const VO_ROOT = new URL("../vo/", import.meta.url).pathname;
export const VO_TAIL_MS = 500; // the settled tail after the longest clip of a line, before the next beat
export const SYNTH_VERSION = 3; // bump to re-synthesise everything (a change to chunking, trimming or levelling in synth.py)

/** Kokoro-82M (Apache-2.0), run on the GPU box. Each voice's speed brings it to 170 ± 4 words a minute over all the
 *  lines (`node video/vo.mjs --calibrate`; at speed 1 they run 166–217). The first voice is the default: the MP4's
 *  first (default) audio track and the preview's only one. */
const K = (voice, name, accent, speed = 1) => ({ id: voice, engine: "kokoro", voice, name, accent, speed, lang: voice[0] === "b" ? "b" : "a", title: `${accent === "UK" ? "en-GB" : "en-US"} · ${name} (Kokoro)` });
export const KOKORO = [
  K("af_heart", "Heart", "US", 0.90),
  K("af_bella", "Bella", "US", 0.98),
  K("bf_emma", "Emma", "UK", 0.83),
  K("am_michael", "Michael", "US", 1.03),
  K("bm_george", "George", "UK", 1.00),
  K("am_fenrir", "Fenrir", "US", 0.90),
  K("af_aoede", "Aoede", "US", 0.88),
  K("af_kore", "Kore", "US", 0.91),
  K("am_puck", "Puck", "US", 0.87),
  K("af_sarah", "Sarah", "US", 0.91),
  K("bm_fable", "Fable", "UK", 0.87),
  K("bf_isabella", "Isabella", "UK", 0.85),
  K("af_alloy", "Alloy", "US", 0.83),
  K("af_nova", "Nova", "US", 0.81),
  K("bm_lewis", "Lewis", "UK", 1.00),
  K("am_onyx", "Onyx", "US", 0.82),
  K("af_sky", "Sky", "US", 0.85),
  K("am_eric", "Eric", "US", 0.80),
  K("bf_alice", "Alice", "UK", 0.86),
  K("bm_daniel", "Daniel", "UK", 0.82),
];

/** The fallback when the GPU box is unreachable: macOS `say` with the best installed English voice
 *  (only compact voices are installed; Daniel is the clearest, and en-GB matches the script's spelling). */
export const SAY = [{ id: "say-daniel", engine: "say", voice: "Daniel", name: "Daniel", accent: "UK", rate: 175, title: "en-GB · Daniel (macOS say)" }];

export const ALL_VOICES = [...KOKORO, ...SAY];

/** The voice set in use: the default voice (Heart) alone; VIDEO_VOICES="af_heart,bm_george" (ids) or "all" (every
 *  Kokoro voice, the first the default) for more, or VIDEO_TTS=say for the fallback. */
export function selectVoices({ voices = process.env.VIDEO_VOICES, engine = process.env.VIDEO_TTS } = {}) {
  if (voices === "all") return KOKORO;
  if (voices) {
    return String(voices).split(",").map((id) => {
      const v = ALL_VOICES.find((x) => x.id === id.trim());
      if (!v) throw new Error(`unknown voice ${id} (known: ${ALL_VOICES.map((x) => x.id).join(", ")})`);
      return v;
    });
  }
  if (engine === "say") return SAY;
  return KOKORO.slice(0, 1);
}

// ---- pronunciation: how the engines should say the words they get wrong (the captions keep the written words) ----
// Kokoro takes inline IPA as [word](/phonemes/) in misaki's notation; American and British use different symbols.
// bistable: misaki already marks the stress (bIstˈAbᵊl) but Kokoro still says the long "bi" louder than a short, quiet
// "sta"; lengthening the stressed vowel (ː) brings it to the level and pitch of a stressed syllable (as in "sustainable").
// GitHub: misaki shifts the stress to "hub" before a noun ("GitHub releases").
// mikepkes: one word, "mike-p-kess" (an s, not a z).
const IPA = {
  a: { VibeCAD: "vˈIb kˈæd", Roubo: "ɹˈubO", mikepkes: "mˈIkpikɛs", fillet: "fˈɪlɪt", bistable: "bIstˈAːbᵊl", Bistable: "bIstˈAːbᵊl", GitHub: "ɡˈɪthʌb" },
  b: { VibeCAD: "vˈIb kˈad", Roubo: "ɹˈubQ", mikepkes: "mˈIkpiːkɛs", fillet: "fˈɪlɪt", bistable: "bIstˈAːbᵊl", Bistable: "bIstˈAːbᵊl", GitHub: "ɡˈɪthʌb" },
};
/** Phrases said as one word: a compound noun, stressed on its first part ("PHONE-stand", not "phone STAND"). */
const IPA_PHRASES = {
  a: { "phone stand": "fˈOnstˌænd" },
  b: { "phone stand": "fˈOnstˌand" },
};
const SAY_AS = { mikepkes: "mike p kess", PETG: "P E T G", PLA: "P L A", fillet: "fillit", Roubo: "Roobo" };

/** The text an engine is given for a line. */
export function spokenText(text, voice) {
  if (voice.engine !== "kokoro") return text.replace(/\b[\w']+\b/g, (w) => SAY_AS[w] ?? w);
  // phrases first (their words then sit inside the [..](/..) markup and are left alone), then single words
  const phrases = Object.entries(IPA_PHRASES[voice.lang] ?? {});
  const parts = [];
  let rest = text;
  for (;;) {
    let best = null;
    for (const [ph, ipa] of phrases) { const m = new RegExp(`\\b${ph.replace(/ /g, "\\s+")}\\b`, "i").exec(rest); if (m && (!best || m.index < best.m.index)) best = { m, ipa }; }
    if (!best) { parts.push({ text: rest }); break; }
    parts.push({ text: rest.slice(0, best.m.index) }, { said: `[${best.m[0]}](/${best.ipa}/)` });
    rest = rest.slice(best.m.index + best.m[0].length);
  }
  const map = Object.fromEntries(Object.entries(IPA[voice.lang]).map(([w, p]) => [w, `[${w}](/${p}/)`]));
  return parts.map((p) => p.said ?? p.text.replace(/\b[\w']+\b/g, (w) => map[w] ?? w)).join("");
}

export function lineHash(text, voice) {
  const how = voice.engine === "kokoro" ? { speed: voice.speed } : { rate: voice.rate };
  return createHash("sha1").update(JSON.stringify({ v: SYNTH_VERSION, engine: voice.engine, voice: voice.voice, ...how, text: spokenText(text, voice) })).digest("hex").slice(0, 16);
}

export const voiceDir = (voice) => join(VO_ROOT, voice.id);
export function readManifest(voice) {
  const f = join(voiceDir(voice), "manifest.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
}

/** The clips for these voices: clip(key, text) → { voice, file, ms }[] for the voices whose clip is current. */
export function loadClips(voices = selectVoices()) {
  const manifests = voices.map((v) => [v, readManifest(v)]);
  return {
    voices,
    /** Every current clip of a line (key "act1-cold-open"), one per voice that has it. */
    clips(key, text) {
      const out = [];
      for (const [v, m] of manifests) {
        const c = m[key];
        const file = join(voiceDir(v), `${key}.wav`);
        if (c && c.hash === lineHash(text, v) && existsSync(file)) out.push({ voice: v, file, ms: c.ms });
      }
      return out;
    },
    /** True when at least one clip exists anywhere for these voices (the VO has been generated). */
    any: manifests.some(([, m]) => Object.keys(m).length > 0),
  };
}
