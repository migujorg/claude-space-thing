#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
profile="${1:-full}"
if [ $# -gt 0 ]; then shift; fi
case "$profile" in
  minimal|standard|full) ;;
  *) echo "usage: ./run-workstation.sh [minimal|standard|full] [pipeline build options]" >&2; exit 2 ;;
esac
export PYTHONUNBUFFERED=1
export PIPELINE_XP_CACHE_BULK=1
export PIPELINE_KEEP_RAW=1
export UV_CACHE_DIR="$PWD/data/cache/uv"
export UV_LINK_MODE=copy
if [ ! -x pipeline/.venv/bin/python ]; then
  (cd pipeline && uv sync --locked)
fi
if ! pipeline/.venv/bin/python -c 'import socks' 2>/dev/null; then
  uv pip install --python pipeline/.venv/bin/python PySocks==1.7.1
fi
if [ "${SKIP_BUILD:-0}" != 1 ]; then
  if pipeline/.venv/bin/python scripts/workstation_build.py --profile "$profile" --jobs 4 --set gaia.xpWorkers=8 --set gaia.tapWorkers=8 --set gaia.tapService=ari --set gaia.sumsFormat=fits --set deepstars.xpSource=bulk "$@"; then
    echo "Data build complete."
    # Vite can retain a public-file list from before a large stage created its
    # directories, answering new binary URLs with index.html. Refresh after
    # actual builds so the app sees all newly published files.
    if systemctl --user is-active --quiet space-thing-app.service 2>/dev/null && \
       pipeline/.venv/bin/python -c 'import json,sys; s=json.load(open("data/cache/parallel-status.json")); sys.exit(0 if "built" in s["finished"].values() else 1)'; then
      systemctl --user restart space-thing-app.service
    fi
  else
    rc=$?
    if [ "$rc" -eq 130 ]; then exit "$rc"; fi
    echo "Some data stages failed; rerun this command to resume. Starting the app with available data."
  fi
fi
if systemctl --user is-active --quiet space-thing-app.service 2>/dev/null; then
  echo "App already running at http://localhost:5173 (space-thing-app.service)."
  exit 0
fi
cd app
if [ ! -d node_modules ]; then npm ci --no-audit --no-fund; fi
exec npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
