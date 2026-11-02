#!/usr/bin/env bash
# The in-app benchmark matrix on a headless Linux box (e.g. hexgame): the web app in Chromium
# and the desktop app (Tauri, WebKitGTK) under Xvfb, at the given pool sizes, N times each.
#   scripts/bench/linux-matrix.sh [--reps 2] [--pools "1 2 4"] [--targets "web tauri"] [--only walker,roubo] [--out results]
# Needs: node on PATH (~/.local/node/bin), cargo (~/.cargo/bin), xvfb-run, Playwright's Chromium
# (npx playwright install chromium), and the Tauri app built once (cargo build in src-tauri).
set -euo pipefail
export PATH="$HOME/.local/node/bin:$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")/../.."
reps=2; pools="1 2 4"; targets="web tauri"; only=""; out="bench-results"
while [ $# -gt 0 ]; do case "$1" in
  --reps) reps=$2; shift 2;; --pools) pools=$2; shift 2;; --targets) targets=$2; shift 2;; --only) only="--only $2"; shift 2;; --out) out=$2; shift 2;; *) echo "unknown $1"; exit 2;; esac; done
mkdir -p "$out"
port=5190
npx vite --port $port --strictPort > "$out/vite.log" 2>&1 &
vite=$!
trap 'kill $vite 2>/dev/null || true' EXIT
until curl -s -o /dev/null "http://localhost:$port/"; do sleep 0.5; done
for rep in $(seq 1 "$reps"); do
  for target in $targets; do
    for pool in $pools; do
      echo "== $target pool $pool rep $rep"
      xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/bench/app.mjs --target "$target" --url "http://localhost:$port" --pool "$pool" $only --drag 5000 --out "$out/$target-p$pool-$rep.json" 2>&1 | grep -v "^|" || true
    done
  done
done
