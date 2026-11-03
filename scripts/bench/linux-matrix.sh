#!/usr/bin/env bash
# The in-app benchmark matrix on a headless Linux box (e.g. hexgame): the web app in Chromium
# and the desktop app (Tauri, WebKitGTK) under Xvfb, at the given pool sizes, N times each.
#   scripts/bench/linux-matrix.sh [--reps 2] [--pools "1 2 4"] [--targets "web tauri"] [--only walker,roubo] [--out results]
#                                 [--port 5190] [--drag 5000] [--repeats 7]
# A pool of "default" leaves the size to the host (scripts/bench/summary.mjs puts the runs side by
# side). Two trees can't share a port: the dev server's (--port) and its driver's (--port + 1000,
# the dev server's /__bench proxy) are checked to be free first, so a stale server of another tree
# is never measured instead. Needs: node on PATH (~/.local/node/bin), cargo (~/.cargo/bin),
# xvfb-run, Playwright's Chromium (npx playwright install chromium), and the Tauri app built once
# (cargo build in src-tauri).
set -euo pipefail
export PATH="$HOME/.local/node/bin:$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")/../.."
reps=2; pools="1 2 4"; targets="web tauri"; only=""; out="bench-results"; port=5190; drag=5000; repeats=7
while [ $# -gt 0 ]; do case "$1" in
  --reps) reps=$2; shift 2;; --pools) pools=$2; shift 2;; --targets) targets=$2; shift 2;; --only) only="--only $2"; shift 2;; --out) out=$2; shift 2;;
  --port) port=$2; shift 2;; --drag) drag=$2; shift 2;; --repeats) repeats=$2; shift 2;; *) echo "unknown $1"; exit 2;; esac; done
mkdir -p "$out"
driver=$((port + 1000))
if curl -s -o /dev/null "http://localhost:$port/"; then echo "port $port is taken (another dev server?)"; exit 1; fi
export VIBECAD_BENCH_PORT=$driver
# in a process group of its own, so all of it (npx → sh → node) goes at the end
setsid npx vite --port "$port" --strictPort > "$out/vite.log" 2>&1 &
vite=$!
trap 'kill -- -$vite 2>/dev/null || true' EXIT
until curl -s -o /dev/null "http://localhost:$port/"; do sleep 0.5; kill -0 $vite 2>/dev/null || { cat "$out/vite.log"; exit 1; }; done
for rep in $(seq 1 "$reps"); do
  for target in $targets; do
    for pool in $pools; do
      echo "== $target pool $pool rep $rep"
      poolArg=(); [ "$pool" != default ] && poolArg=(--pool "$pool")
      xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/bench/app.mjs --target "$target" --url "http://localhost:$port" --port "$driver" "${poolArg[@]}" $only --drag "$drag" --repeats "$repeats" --out "$out/$target-p$pool-$rep.json" 2>&1 | grep -v "^|" || true
    done
  done
done
