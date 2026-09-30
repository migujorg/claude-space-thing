"""CLI: `uv run python -m pipeline build [--only stage,stage] [--new-window] [--window-days N]`.

The time window is fixed by the first build and stored in data/cache/window.json, so partial (--only) rebuilds
keep every product on the same window. `--new-window` recenters it on now (then rebuild all time-dependent stages).

Stages are modules in pipeline/stages exposing `run(ctx: BuildContext) -> None` and a `DEPENDS` tuple.
They run in the order listed in STAGES.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import importlib
import json
import sys

from .output import write_manifest
from .paths import CACHE
from .schema import BuildContext

# Order matters: later stages may read earlier stages' outputs.
STAGES = ["time", "ephemeris", "light", "surfaces", "shapes", "bodies", "smallbodies", "sbphotometry", "synthetic",
          "stars", "deepstars", "sky"]

J2000_UNIX = 946727935.816  # 2000-01-01T12:00:00 TDB expressed in Unix seconds (UTC), for window selection only
WINDOW_FILE = CACHE / "window.json"
DEFAULT_WINDOW_DAYS = 548.0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pipeline")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--only", default="", help="comma-separated stage names")
    b.add_argument("--new-window", action="store_true", help=f"recenter the time window on now ({WINDOW_FILE})")
    b.add_argument("--window-days", type=float, default=None,
                   help=f"half-width of a new window in days (default {DEFAULT_WINDOW_DAYS:g})")
    args = ap.parse_args(argv)

    ctx = BuildContext(*_window(args.new_window, args.window_days))

    wanted = [s for s in args.only.split(",") if s] or STAGES
    unknown_stages = set(wanted) - set(STAGES)
    if unknown_stages:
        print(f"unknown stages: {sorted(unknown_stages)}; known: {STAGES}", file=sys.stderr)
        return 2
    for name in STAGES:
        if name not in wanted:
            continue
        try:
            mod = importlib.import_module(f".stages.{name}", __package__)
        except ModuleNotFoundError as e:
            if e.name and e.name.endswith(f"stages.{name}"):
                print(f"[{name}] not implemented yet, skipping")
                continue
            raise
        print(f"[{name}] running")
        mod.run(ctx)
    write_manifest(ctx)
    print(f"wrote {len(ctx.products)} products")
    return 0


def _window(new: bool, days: float | None) -> tuple[float, float]:
    """(start_et, end_et): the stored window, or a new one centered on now (stored for later builds)."""
    if WINDOW_FILE.exists() and not new:
        w = json.loads(WINDOW_FILE.read_text())
        note = "; --window-days ignored (add --new-window)" if days is not None else ""
        print(f"window: {w['startEt']}..{w['endEt']} ET from {WINDOW_FILE} (created {w['createdAt']}){note}")
        return w["startEt"], w["endEt"]
    now = _dt.datetime.now(_dt.timezone.utc)
    half = (days if days is not None else DEFAULT_WINDOW_DAYS) * 86400.0
    t = now.timestamp() - J2000_UNIX
    # Window is coarse (days); exact TDB conversion is irrelevant at this granularity.
    w = {"startEt": round(t - half), "endEt": round(t + half), "halfWidthDays": half / 86400.0,
         "createdAt": now.isoformat(timespec="seconds")}
    WINDOW_FILE.write_text(json.dumps(w, indent=1))
    print(f"window: new {w['startEt']}..{w['endEt']} ET (now +/- {w['halfWidthDays']:g} d) -> {WINDOW_FILE}; "
          "rebuild all time-dependent stages")
    return w["startEt"], w["endEt"]


if __name__ == "__main__":
    raise SystemExit(main())
