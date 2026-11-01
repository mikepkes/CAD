#!/usr/bin/env node
// Merge interleaved A/B benchmark runs (JSON from run.mjs or browser.mjs) into one before/after
// table: per example and metric, the median over the A files and over the B files.
//
//   node scripts/bench/compare.mjs --a base1.json,base2.json --b new1.json,new2.json [--metrics coldMs,editMs]
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const load = (list) => list.split(",").map((f) => JSON.parse(readFileSync(f, "utf8")));
const A = load(opt("--a")), B = load(opt("--b"));
const metrics = opt("--metrics", null)?.split(",");
const median = (xs) => { const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const examples = [...new Set([...A, ...B].flat().map((r) => r.example))];
const keys = metrics ?? [...new Set([...A, ...B].flat().flatMap((r) => Object.keys(r)))].filter((k) => [...A, ...B].flat().some((r) => typeof r[k] === "number") && !["bodies", "triangles", "meshBytes", "docBytes", "hits", "misses", "programs"].includes(k));
const fmt = (v) => (v == null ? "" : Number.isInteger(v) ? String(v) : v.toFixed(1));
console.log(`| example | metric | before | after | change |`);
console.log(`|---|---|---|---|---|`);
for (const ex of examples) {
  for (const k of keys) {
    const a = median(A.map((run) => run.find((r) => r.example === ex)?.[k]));
    const b = median(B.map((run) => run.find((r) => r.example === ex)?.[k]));
    if (a == null && b == null) continue;
    const change = a != null && b != null && a !== 0 ? `${b < a ? "−" : "+"}${Math.abs(Math.round((1 - b / a) * 100))}%` : "";
    console.log(`| ${ex} | ${k} | ${fmt(a)} | ${fmt(b)} | ${change} |`);
  }
}
