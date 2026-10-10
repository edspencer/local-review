#!/usr/bin/env bash
# Run Local Review on the demo test bed (npm run demo:seed), isolated from the machine it runs on.
#
#   tools/docs-media/serve.sh [<seed dir>] [--port <n>]      default: demo/out, port $PORT or 5622
#
# The ONE place that says how the rig launches Local Review: capture.ts runs this script. It runs the compiled CLI
# from this checkout (scripts/start.mjs builds dist/ if it's stale), the same thing an installed `local-review`
# runs. To shoot an installed package instead, change LAUNCH below.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SEED="$ROOT/demo/out"
PORT_ARG="${PORT:-5622}"
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT_ARG="$2"; shift 2 ;;
    *) SEED="$1"; shift ;;
  esac
done
SEED="$(cd "$SEED" && pwd)"
[ -f "$SEED/manifest.json" ] || { echo "no demo seed in $SEED (run: npm run demo:seed)" >&2; exit 1; }

# A scrubbed environment: no inherited GIT_* variables, credentials or LOCAL_REVIEW_* settings, and a throwaway HOME
# (the seed's own), so `~` in project.yaml means the demo repos and nothing can touch the real ~/.local-review.
LAUNCH=(node "$ROOT/scripts/start.mjs" --port "$PORT_ARG")
exec /usr/bin/env -i \
  PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$(dirname "$(command -v node)")" \
  HOME="$SEED/home" \
  LOCAL_REVIEW_HOME="$SEED/home/.local-review" \
  LOCAL_REVIEW_USER="maya" \
  GIT_CONFIG_GLOBAL=/dev/null \
  GIT_CONFIG_NOSYSTEM=1 \
  TZ=UTC \
  LANG=C.UTF-8 \
  "${LAUNCH[@]}"
