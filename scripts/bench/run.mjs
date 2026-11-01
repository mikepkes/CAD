#!/usr/bin/env node
// Runs scripts/bench/rebuild.ts for every bundled example, each in a process of
// its own, and prints a markdown table (plus JSON to --out <file>).
//
//   node scripts/bench/run.mjs [--repeats 3] [--out bench.json] [--only gimbal,starbox]
import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const repeats = opt("--repeats", "3");
const out = opt("--out", null);
const only = opt("--only", null)?.split(",");

const dir = join(root, "public", "examples");
const examples = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().filter((f) => !only || only.includes(f.replace(/\.json$/, "")));
const rows = [];
for (const f of examples) {
  const r = spawnSync("npx", ["vite-node", "scripts/bench/rebuild.ts", join("public", "examples", f), repeats], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
  const line = r.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  if (!line) { console.error(`${f}: ${r.stderr.slice(-2000)}`); rows.push({ example: f.replace(/\.json$/, ""), error: "failed" }); continue; }
  const row = JSON.parse(line);
  rows.push(row);
  console.error(`${row.example}: kernel ${row.kernelMs} recompute ${row.recomputeMs} cold ${row.coldMs} warm ${row.warmMs} edit ${row.editMs} (${row.slider}) pose ${row.poseMs} (${row.poseSlider}) bodies ${row.bodies} tris ${row.triangles}${row.errors?.length ? ` ERRORS ${row.errors.join("; ")}` : ""}`);
}
const cols = ["example", "kernelMs", "recomputeMs", "coldMs", "warmMs", "editMs", "editRecomputeMs", "slider", "poseMs", "poseSlider", "bodies", "triangles"];
console.log(`| ${cols.join(" | ")} |`);
console.log(`|${cols.map(() => "---").join("|")}|`);
for (const r of rows) console.log(`| ${cols.map((c) => r[c] ?? "").join(" | ")} |`);
if (out) writeFileSync(out, JSON.stringify(rows, null, 2));
