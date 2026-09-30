#!/usr/bin/env bash
# From a fresh clone to the running app, in one command (Linux, macOS, WSL, Git Bash):
#
#   ./run.sh [minimal|standard|full] [more `pipeline build` options, e.g. --skip sky]
#
# 1. checks the machine (python -m pipeline doctor: Python, packages, Node, disk space, data hosts),
# 2. builds the data with that profile (default standard; see README "Build profiles"). The build resumes: after
#    an interruption or a failed stage, run the same command again and finished work is kept,
# 3. installs the app's packages and starts the dev server in your browser.
#
# SKIP_DOCTOR=1 skips step 1, SKIP_BUILD=1 skips step 2 (start the app on the data already built).
set -euo pipefail
cd "$(dirname "$0")"

profile="${1:-standard}"
if [ $# -gt 0 ]; then shift; fi
case "$profile" in
  minimal|standard|full) ;;
  *) echo "usage: ./run.sh [minimal|standard|full] [build options]" >&2; exit 2 ;;
esac

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 not found: $2" >&2
    exit 1
  fi
}
need uv "install it from https://docs.astral.sh/uv/getting-started/installation/"
need npm "install Node.js 22 LTS from https://nodejs.org"

echo "== Python environment (pipeline/)"
(cd pipeline && uv sync --locked)

if [ "${SKIP_DOCTOR:-0}" != 1 ]; then
  echo "== Checking this machine (profile $profile)"
  if ! (cd pipeline && uv run python -m pipeline doctor --profile "$profile"); then
    echo "Fix the problems above and run ./run.sh again (or SKIP_DOCTOR=1 ./run.sh to go on anyway)." >&2
    exit 1
  fi
fi

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  echo "== Building the data (profile $profile); run the same command again to resume if it stops"
  set +e
  (cd pipeline && uv run python -m pipeline build --profile "$profile" "$@")
  rc=$?
  set -e
  if [ "$rc" -eq 130 ]; then
    echo "Build interrupted. Run ./run.sh $profile again to resume." >&2
    exit 130
  elif [ "$rc" -ne 0 ]; then
    echo "Some stages did not finish (see the summary above). The app starts with what was built and shows" >&2
    echo "what is missing; run ./run.sh $profile again later to resume the build." >&2
  fi
fi

echo "== App (app/)"
cd app
if [ -d node_modules ]; then
  npm install --no-audit --no-fund
else
  npm ci --no-audit --no-fund
fi
echo "== Starting the app at http://localhost:5173 (Ctrl-C stops it). Use Chrome or Edge (WebGPU)."
exec npm run dev -- --open
