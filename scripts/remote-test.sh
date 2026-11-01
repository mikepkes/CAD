#!/usr/bin/env bash
# Run vitest on a remote Linux box (default mike@hexgame): sync this working tree there
# (no node_modules, .git, video media or worktrees), install dependencies when the
# lockfile changed, then run `npx vitest run <args>` with output streamed back.
#   scripts/remote-test.sh                       # the whole suite
#   scripts/remote-test.sh test/walker.build.test.ts
#   REMOTE=me@box REMOTE_DIR=~/vibecad scripts/remote-test.sh …
# Env passed through: anything named BUILD_* (example generators write their JSON into
# REMOTE_DIR/out/, copied back to ./remote-out/ afterwards).
set -euo pipefail
REMOTE="${REMOTE:-mike@hexgame}"
DIR="${REMOTE_DIR:-vibecad}"
cd "$(dirname "$0")/.."
rsync -az --delete --exclude node_modules --exclude .git --exclude 'video/takes' --exclude 'video/out' \
  --exclude '.claude' --exclude dist --exclude 'src-tauri/target' --exclude remote-out ./ "$REMOTE:$DIR/"
envs=""
for v in $(env | grep -o '^BUILD_[A-Z_]*' || true); do envs+="$v=\$HOME/$DIR/out "; done
ssh -o BatchMode=yes "$REMOTE" "set -e; cd ~/$DIR; export PATH=\$HOME/.local/node/bin:\$PATH; mkdir -p out
  if ! cmp -s package-lock.json node_modules/.lock-synced 2>/dev/null; then npm ci --no-audit --no-fund >/dev/null && cp package-lock.json node_modules/.lock-synced; fi
  $envs npx vitest run $*"
status=$?
if [ -n "$envs" ]; then mkdir -p remote-out && rsync -az "$REMOTE:$DIR/out/" remote-out/; fi
exit $status
