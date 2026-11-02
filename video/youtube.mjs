// Upload a cut to YouTube, private: `node video/youtube.mjs upload --run NAME --video demo|tutorial [--dry]`.
// One-time setup (yours, in a browser): a Google Cloud project with the YouTube Data API v3 enabled, an OAuth consent
// screen (External, in testing, your account a test user) and an OAuth client of type "Desktop app", its JSON saved as
// ~/.config/vibecad-youtube/client_secret.json (or --client PATH). Then `node video/youtube.mjs auth` opens Google's
// consent page; approve it and the token is kept beside the client file (~/.config/vibecad-youtube/token.json, only
// readable by you). Nothing secret is written to the repo.
//
// An upload sends the full render (video/out/NAME/VIDEO/<file>.mp4: YouTube plays its first, default voice), with the
// title and description from VIDEOS (script/lines.mjs), the chapter list (chapters.txt) under the description, and
// subtitles.srt as English captions; always private (videos from an API project YouTube hasn't reviewed stay private
// anyway — make one public in YouTube Studio). The result, with the video's link, goes to youtube.json beside the cut.
// --dry prints what would be sent. Uploads are resumable in 16 MB pieces and pick up where they stopped after a dropped
// connection. No dependencies: Node's fetch.

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, openSync, readSync, closeSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { VIDEOS } from "./script/lines.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const cmd = process.argv[2];
const CLIENT = arg("--client", join(homedir(), ".config", "vibecad-youtube", "client_secret.json"));
const TOKEN = join(dirname(CLIENT), "token.json");
// upload videos, and manage their captions
const SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.force-ssl"];
const ROOT = new URL("..", import.meta.url).pathname;

function client() {
  if (!existsSync(CLIENT)) throw new Error(`no OAuth client at ${CLIENT}: create a "Desktop app" OAuth client in Google Cloud and save its JSON there (or pass --client PATH)`);
  const j = JSON.parse(readFileSync(CLIENT, "utf8"));
  const c = j.installed ?? j.web;
  if (!c?.client_id) throw new Error(`${CLIENT} isn't an OAuth client file (no installed.client_id)`);
  return c;
}

/** The installed-app flow: a loopback redirect to a port of ours, PKCE, the code swapped for a refresh token. */
async function auth() {
  const c = client(), verifier = randomBytes(32).toString("base64url"), state = randomBytes(16).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/") { res.statusCode = 404; res.end(); return; }
      const err = u.searchParams.get("error"), got = u.searchParams.get("code");
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (err || !got || u.searchParams.get("state") !== state) { res.end("<p>Not authorized. You can close this tab.</p>"); server.close(); reject(new Error(err ?? "no code (or the state didn't match)")); return; }
      res.end("<p>VibeCAD can upload to your YouTube channel now. You can close this tab.</p>");
      server.close(); resolve({ code: got, redirect: `http://127.0.0.1:${server.address().port}` });
    }).listen(0, "127.0.0.1", () => {
      const redirect = `http://127.0.0.1:${server.address().port}`;
      const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: c.client_id, redirect_uri: redirect, response_type: "code", scope: SCOPES.join(" "), access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256" })}`;
      console.log(`Opening Google's consent page (if it doesn't open, visit this):\n${url}\n`);
      try { execFileSync("open", [url]); } catch { /* printed above */ }
    });
  });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret ?? "", code: code.code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: code.redirect }) });
  const t = await r.json();
  if (!r.ok || !t.refresh_token) throw new Error(`token exchange failed: ${JSON.stringify(t)}`);
  mkdirSync(dirname(TOKEN), { recursive: true });
  writeFileSync(TOKEN, JSON.stringify({ refresh_token: t.refresh_token, scope: t.scope }, null, 1));
  chmodSync(TOKEN, 0o600);
  console.log(`authorized: token saved to ${TOKEN}`);
}

async function accessToken() {
  if (!existsSync(TOKEN)) throw new Error(`not authorized yet: run node video/youtube.mjs auth`);
  const c = client(), { refresh_token } = JSON.parse(readFileSync(TOKEN, "utf8"));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret ?? "", refresh_token, grant_type: "refresh_token" }) });
  const t = await r.json();
  if (!r.ok) throw new Error(`refreshing the token failed (run auth again?): ${JSON.stringify(t)}`);
  return t.access_token;
}

async function upload() {
  const run = arg("--run"), videoId = arg("--video");
  const v = VIDEOS[videoId];
  if (!run || !v) throw new Error(`usage: node video/youtube.mjs upload --run NAME --video ${Object.keys(VIDEOS).join("|")} [--dry]`);
  const out = join(ROOT, "video", "out", run, videoId), mp4 = join(out, `${v.file}.mp4`), srt = join(out, "subtitles.srt"), chap = join(out, "chapters.txt");
  if (!existsSync(mp4)) throw new Error(`no render at ${mp4}: run node video/edit.mjs --run ${run} --video ${videoId}`);
  const chapters = existsSync(chap) ? readFileSync(chap, "utf8").trim() : "";
  const meta = {
    snippet: { title: v.title, description: `${v.description}${chapters ? `\n\nChapters:\n${chapters}` : ""}`, tags: ["VibeCAD", "CAD", "parametric CAD", "3D modeling", "open source"], categoryId: "28", defaultLanguage: "en", defaultAudioLanguage: "en" },
    status: { privacyStatus: "private", selfDeclaredMadeForKids: false, embeddable: true },
  };
  const size = statSync(mp4).size;
  console.log(`${v.title} (${run}): ${mp4} (${(size / 1e6).toFixed(0)} MB), private${existsSync(srt) ? ", English captions" : ""}\n--- description ---\n${meta.snippet.description}\n---`);
  if (process.argv.includes("--dry")) return;
  const auth = { authorization: `Bearer ${await accessToken()}` };
  // a resumable session, then the file in pieces (each a multiple of 256 KiB but the last)
  const start = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", { method: "POST", headers: { ...auth, "content-type": "application/json; charset=UTF-8", "x-upload-content-length": String(size), "x-upload-content-type": "video/mp4" }, body: JSON.stringify(meta) });
  if (!start.ok) throw new Error(`starting the upload failed: ${start.status} ${await start.text()}`);
  const session = start.headers.get("location");
  const CHUNK = 64 * 256 * 1024, fd = openSync(mp4, "r");
  let at = 0, video, tries = 0;
  try {
    while (!video) {
      const n = Math.min(CHUNK, size - at), buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, at);
      let r;
      try { r = await fetch(session, { method: "PUT", headers: { ...auth, "content-length": String(n), "content-range": `bytes ${at}-${at + n - 1}/${size}` }, body: buf }); }
      catch (e) { if (++tries > 5) throw e; at = await resumeAt(session, auth, size); continue; }
      if (r.status === 308) { const range = r.headers.get("range"); at = range ? Number(range.split("-")[1]) + 1 : 0; tries = 0; process.stdout.write(`\r  ${((100 * at) / size).toFixed(0)}% `); continue; }
      if (r.status >= 500 && ++tries <= 5) { at = await resumeAt(session, auth, size); continue; }
      if (!r.ok) throw new Error(`upload failed: ${r.status} ${await r.text()}`);
      video = await r.json();
    }
  } finally { closeSync(fd); }
  console.log(`\nuploaded: https://youtu.be/${video.id} (private; processing on YouTube's side may take a while)`);
  let captions;
  if (existsSync(srt)) {
    const boundary = `vibecad${randomBytes(8).toString("hex")}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ snippet: { videoId: video.id, language: "en", name: "English", isDraft: false } })}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`),
      readFileSync(srt), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const r = await fetch("https://www.googleapis.com/upload/youtube/v3/captions?uploadType=multipart&part=snippet", { method: "POST", headers: { ...auth, "content-type": `multipart/related; boundary=${boundary}` }, body });
    captions = r.ok ? (await r.json()).id : undefined;
    console.log(r.ok ? "captions added (English)" : `✗ captions failed: ${r.status} ${await r.text()}`);
  }
  writeFileSync(join(out, "youtube.json"), JSON.stringify({ id: video.id, url: `https://youtu.be/${video.id}`, privacy: "private", uploaded: new Date().toISOString(), title: v.title, captions }, null, 1));
}

/** Where an interrupted resumable upload stands: the next byte to send. */
async function resumeAt(session, auth, size) {
  const r = await fetch(session, { method: "PUT", headers: { ...auth, "content-length": "0", "content-range": `bytes */${size}` } });
  if (r.status !== 308) throw new Error(`resuming the upload failed: ${r.status} ${await r.text()}`);
  const range = r.headers.get("range");
  return range ? Number(range.split("-")[1]) + 1 : 0;
}

try {
  if (cmd === "auth") await auth();
  else if (cmd === "upload") await upload();
  else { console.error("usage: node video/youtube.mjs auth | upload --run NAME --video demo|tutorial [--dry]"); process.exit(1); }
} catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
