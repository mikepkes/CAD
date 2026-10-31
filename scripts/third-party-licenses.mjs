// Writes public/THIRD_PARTY_LICENSES.txt: every third-party package a build
// ships, with its license and the license text it carries, so the web app and
// the desktop app keep the notices their (MIT, BSD, ISC, Apache, LGPL, MPL…)
// licenses ask for. Runs before every `npm run build` (and so before
// `tauri build`). npm: the production packages in package-lock.json. Rust: the
// desktop app's crates for the target being built, from `cargo metadata`, only
// in a desktop build (Tauri sets TAURI_ENV_*) or with `--rust`: the website
// ships no Rust.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "public", "THIRD_PARTY_LICENSES.txt");
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i;

/** The license texts in a package directory (LICENSE-MIT before LICENSE-APACHE, so a dual crate leads with MIT). */
function licenseTexts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort((a, b) => (/mit/i.test(b) ? 1 : 0) - (/mit/i.test(a) ? 1 : 0) || a.localeCompare(b))
    .map((f) => readFileSync(join(dir, f), "utf8").trim()).filter(Boolean);
}

const items = []; // { name, version, license, source, texts }

const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
for (const [path, info] of Object.entries(lock.packages ?? {})) {
  if (!path || info.dev) continue;
  const dir = join(ROOT, path);
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); } catch { /* not installed on this platform */ }
  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  items.push({ name: pkg.name ?? path.replace(/^.*node_modules\//, ""), version: pkg.version ?? info.version, license: String(pkg.license ?? info.license ?? "UNKNOWN"), source: repo ?? pkg.homepage ?? "", texts: licenseTexts(dir) });
}

const desktop = !!process.env.TAURI_ENV_PLATFORM || process.argv.includes("--rust");
let rustNote = desktop ? "" : "\n(Web build: the desktop app's Rust crates are listed only in the desktop app's copy of this file.)\n";
if (desktop) try {
  const target = process.env.TAURI_ENV_TARGET_TRIPLE || execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/host: (\S+)/)[1];
  const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--filter-platform", target, "--manifest-path", join(ROOT, "src-tauri", "Cargo.toml")], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }));
  const used = new Set(meta.resolve.nodes.map((n) => n.id));
  for (const p of meta.packages) {
    if (!used.has(p.id) || !p.source) continue; // the app's own crate has no source
    items.push({ name: p.name, version: p.version, license: p.license ?? (p.license_file ? `see ${p.license_file}` : "UNKNOWN"), source: p.repository ?? "", texts: licenseTexts(join(p.manifest_path, "..")) });
  }
} catch {
  rustNote = "\n(The desktop app's Rust crates are not listed: cargo was not available when this file was generated.)\n";
}

items.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

// Each distinct license text once, followed by the packages that carry it.
const groups = new Map();
const bare = [];
for (const it of items) {
  if (!it.texts.length) { bare.push(it); continue; }
  const key = createHash("sha256").update(it.texts.join("\n\n")).digest("hex");
  (groups.get(key) ?? groups.set(key, { texts: it.texts, items: [] }).get(key)).items.push(it);
}
const line = (it) => `  ${it.name} ${it.version} (${it.license})${it.source ? ` ${it.source.replace(/^git\+/, "")}` : ""}`;

let out = `Chisel CAD: third-party software\n\nChisel CAD is MIT licensed (see LICENSE). It ships the third-party packages below under their own licenses.\nThe LGPL libraries (OpenCASCADE via replicad-opencascadejs, PlaneGCS) are separate, replaceable WebAssembly modules; see THIRD_PARTY_NOTICES.md for where to get their source and how to replace them.\n${rustNote}\n${items.length} packages.\n`;
for (const g of groups.values()) {
  out += `\n${"=".repeat(78)}\n${g.items.map(line).join("\n")}\n${"-".repeat(78)}\n${g.texts.join(`\n\n${"-".repeat(40)}\n\n`)}\n`;
}
if (bare.length) out += `\n${"=".repeat(78)}\nPackages that carry no license file (license as declared):\n${bare.map(line).join("\n")}\n`;
writeFileSync(OUT, out);
console.log(`third-party licenses: ${items.length} packages, ${groups.size} distinct license texts → ${OUT.replace(ROOT, "")}`);
