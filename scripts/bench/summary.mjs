#!/usr/bin/env node
// Several benchmark configurations side by side: for each metric, a table with a row per
// example and a column per configuration — the median over that configuration's runs
// (JSON files from app.mjs, run.mjs or profile-style rows with an `example` field).
//
//   node scripts/bench/summary.mjs --metrics firstModelMs,geomMedianMs before=b1.json,b2.json pool1=a1.json,a2.json pool4=c1.json,c2.json
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const metrics = opt("--metrics", "firstModelMs,geomMedianMs,geomP90Ms,poseMedianMs,poseP90Ms,geomDragPerS,geomDragLagMs,poseDragPerS,peakRssMB").split(",");
const configs = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--metrics").map((a) => { const [label, files] = a.split("="); return { label, runs: files.split(",").map((f) => JSON.parse(readFileSync(f, "utf8"))) }; });
const median = (xs) => { const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const fmt = (v) => (v == null ? "" : Number.isInteger(v) ? String(v) : v.toFixed(1));
const examples = [...new Set(configs.flatMap((c) => c.runs.flat().map((r) => r.example)))];
for (const m of metrics) {
  console.log(`\n**${m}**\n`);
  console.log(`| example | ${configs.map((c) => c.label).join(" | ")} |`);
  console.log(`|---|${configs.map(() => "---").join("|")}|`);
  for (const ex of examples) {
    const cells = configs.map((c) => fmt(median(c.runs.map((run) => run.find((r) => r.example === ex)?.[m]))));
    if (cells.every((x) => x === "")) continue;
    console.log(`| ${ex} | ${cells.join(" | ")} |`);
  }
}
