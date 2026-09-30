"""CLI: `uv run python -m pipeline build [--only stage,stage] [--window-days N]`.

Stages are modules in pipeline/stages exposing `run(ctx: BuildContext) -> None` and a `DEPENDS` tuple.
They run in the order listed in STAGES.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import importlib
import sys

from .output import write_manifest
from .schema import BuildContext

# Order matters: later stages may read earlier stages' outputs.
STAGES = ["time", "ephemeris", "light", "bodies", "stars"]

J2000_UNIX = 946727935.816  # 2000-01-01T12:00:00 TDB expressed in Unix seconds (UTC), for window selection only


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pipeline")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--only", default="", help="comma-separated stage names")
    b.add_argument("--window-days", type=float, default=548.0, help="half-width of the time window around now")
    args = ap.parse_args(argv)

    now = _dt.datetime.now(_dt.timezone.utc).timestamp()
    half = args.window_days * 86400.0
    # Window is coarse (days); exact TDB conversion is irrelevant at this granularity.
    ctx = BuildContext(start_et=round(now - J2000_UNIX - half), end_et=round(now - J2000_UNIX + half))

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


if __name__ == "__main__":
    raise SystemExit(main())
