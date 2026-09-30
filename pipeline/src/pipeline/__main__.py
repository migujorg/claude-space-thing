"""CLI: `uv run python -m pipeline <command>`.

  build   [--profile minimal|standard|full] [--only a,b] [--skip a,b] [--set key=value ...] [--force]
          [--stop-on-error] [--force-space] [--dry-run] [--new-window] [--window-days N]
  build --adopt [--profile P]: run and download nothing; record the stages whose existing products check out
          (hashed against manifest.json) as built, and say for every other stage why not
  plan    the same options as build: what would run and why, with each stage's typical cost
  doctor  [--profile P] [--offline]: check Python, packages, Node, disk space, long paths and every data host
  params  list the build profiles and parameters (pipeline/config.py)
  costs   [--markdown]: the per-stage cost table (README.md "Build profiles")

A profile build resumes: stages already built with the same code, parameters, window and inputs are skipped, so
re-running after a failure continues where it stopped (pipeline/build.py). `--only` runs exactly the named stages.

The time window is fixed by the first build and stored in data/cache/window.json, so partial (--only) rebuilds
keep every product on the same window. `--new-window` recenters it on now (then rebuild all time-dependent stages).

Stages are modules in pipeline/stages exposing `run(ctx: BuildContext) -> None` and a `DEPENDS` tuple.
They run in the order listed in config.STAGES.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import subprocess
import sys

from .config import STAGES  # noqa: F401  (re-exported: the stage order)
from .paths import CACHE

J2000_UNIX = 946727935.816  # 2000-01-01T12:00:00 TDB expressed in Unix seconds (UTC), for window selection only
WINDOW_FILE = CACHE / "window.json"
DEFAULT_WINDOW_DAYS = 548.0


def _build_args(p: argparse.ArgumentParser) -> None:
    from . import config
    p.add_argument("--profile", choices=sorted(config.PROFILES), default=None,
                   help=f"which stages and levels to build (default {config.DEFAULT_PROFILE}); see `params`")
    p.add_argument("--only", default="", help="comma-separated stages to run now, whether up to date or not")
    p.add_argument("--skip", default="", help="comma-separated stages to leave out of the profile")
    p.add_argument("--set", action="append", default=[], metavar="KEY=VALUE",
                   help="set a build parameter (repeatable); see `params`")
    p.add_argument("--force", action="store_true", help="rerun every stage of the profile, even if up to date")
    p.add_argument("--stop-on-error", action="store_true",
                   help="stop at the first failed stage (default: go on with the stages that do not need it)")
    p.add_argument("--dry-run", action="store_true", help="show what would run, and why, without running it")
    p.add_argument("--adopt", action="store_true",
                   help="run and download nothing: record existing products that check out as built, and say why the "
                        "others do not")
    p.add_argument("--force-space", action="store_true",
                   help="start stages even when the free disk space looks too small for them")
    p.add_argument("--new-window", action="store_true", help=f"recenter the time window on now ({WINDOW_FILE})")
    p.add_argument("--window-days", type=float, default=None,
                   help=f"half-width of a new window in days (default {DEFAULT_WINDOW_DAYS:g})")
    p.add_argument("--no-log", action="store_true", help="do not copy the output to data/cache/logs/")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pipeline", description="Build the simulator's data products.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    _build_args(sub.add_parser("build", help="build data products (resumable)"))
    _build_args(sub.add_parser("plan", help="show what `build` would do with the same options"))
    d = sub.add_parser("doctor", help="check prerequisites, disk space and data hosts")
    d.add_argument("--profile", default="standard")
    d.add_argument("--offline", action="store_true", help="skip the network checks")
    sub.add_parser("params", help="list profiles and build parameters")
    c = sub.add_parser("costs", help="per-stage cost table")
    c.add_argument("--markdown", action="store_true")
    args = ap.parse_args(argv)

    if args.cmd == "doctor":
        from . import doctor
        return doctor.main(args.profile, offline=args.offline)
    if args.cmd == "params":
        from . import config
        print(config.describe())
        return 0
    if args.cmd == "costs":
        from . import config
        print(config.cost_table(markdown=args.markdown))
        return 0
    return _build(args, dry_run=args.cmd == "plan" or args.dry_run)


def _build(args, dry_run: bool) -> int:
    from . import build, config
    split = lambda s: [x.strip() for x in s.split(",") if x.strip()]  # noqa: E731
    try:
        only, skip = split(args.only), split(args.skip)
        sets = config.parse_sets(args.set)
        plan = build.make_plan(args.profile, only, skip, args.force)
        params = config.resolve(plan.profile if not plan.explicit else args.profile, sets, only=plan.explicit)
    except (config.ConfigError, KeyError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    config.export_env(params)
    from .schema import BuildContext
    if args.adopt and not WINDOW_FILE.exists():
        _window_from_manifest(build.read_manifest())
    ctx = BuildContext(*_window(args.new_window, args.window_days), params=params, plan=tuple(plan.stages))
    try:
        if args.adopt:
            return build.adopt(ctx, plan)
        if dry_run or args.no_log:
            return build.run(ctx, plan, keep_going=not args.stop_on_error, dry_run=dry_run,
                             force_space=args.force_space)
        with build.build_log() as log_path:
            return build.run(ctx, plan, keep_going=not args.stop_on_error, force_space=args.force_space,
                             log_path=log_path)
    except KeyboardInterrupt:   # between stages (inside one, build.run records the stage and stops)
        print("\ninterrupted; run the same command again to resume", file=sys.stderr)
        return 130


def _window(new: bool, days: float | None) -> tuple[float, float]:
    """(start_et, end_et): the stored window, or a new one centered on now (stored for later builds)."""
    if WINDOW_FILE.exists() and not new:
        w = json.loads(WINDOW_FILE.read_text(encoding="utf-8"))
        note = "; --window-days ignored (add --new-window)" if days is not None else ""
        print(f"window: {w['startEt']}..{w['endEt']} ET from {WINDOW_FILE} (created {w['createdAt']}){note}")
        return w["startEt"], w["endEt"]
    now = _dt.datetime.now(_dt.timezone.utc)
    half = (days if days is not None else DEFAULT_WINDOW_DAYS) * 86400.0
    t = now.timestamp() - J2000_UNIX
    # Window is coarse (days); exact TDB conversion is irrelevant at this granularity.
    w = {"startEt": round(t - half), "endEt": round(t + half), "halfWidthDays": half / 86400.0,
         "createdAt": now.isoformat(timespec="seconds")}
    WINDOW_FILE.parent.mkdir(parents=True, exist_ok=True)
    WINDOW_FILE.write_text(json.dumps(w, indent=1), encoding="utf-8", newline="\n")
    print(f"window: new {w['startEt']}..{w['endEt']} ET (now +/- {w['halfWidthDays']:g} d) -> {WINDOW_FILE}; "
          "rebuild all time-dependent stages")
    return w["startEt"], w["endEt"]


def _window_from_manifest(manifest: dict) -> None:
    """Adopting products built before data/cache/window.json existed (or after data/cache was deleted): keep
    their window instead of centering a new one on now."""
    w = manifest.get("window")
    if w:
        WINDOW_FILE.parent.mkdir(parents=True, exist_ok=True)
        WINDOW_FILE.write_text(json.dumps({"startEt": w["startEt"], "endEt": w["endEt"],
                                           "halfWidthDays": (w["endEt"] - w["startEt"]) / 2 / 86400.0,
                                           "createdAt": manifest.get("generatedAt", "")}, indent=1),
                               encoding="utf-8", newline="\n")
        print(f"window: {w['startEt']}..{w['endEt']} ET taken from manifest.json -> {WINDOW_FILE}")


def _utf8_or_reexec() -> int | None:
    """On Windows, Python < 3.15 reads and writes text in the ANSI code page unless UTF-8 mode is on; third-party
    readers and redirected output (logs) then garble or fail on non-ASCII text. Re-run this command in UTF-8 mode
    (the same as setting PYTHONUTF8=1). Returns the child's exit code, or None to go on in this process."""
    if os.name != "nt" or sys.flags.utf8_mode or os.environ.get("PIPELINE_NO_REEXEC") == "1":
        return None
    env = {**os.environ, "PIPELINE_NO_REEXEC": "1"}
    cmd = [sys.executable, "-X", "utf8", "-m", "pipeline", *sys.argv[1:]]
    proc = subprocess.Popen(cmd, env=env)
    while True:
        try:
            return proc.wait()
        except KeyboardInterrupt:   # the child got the same Ctrl-C: let it record its state and exit
            continue


if __name__ == "__main__":
    rc = _utf8_or_reexec()
    raise SystemExit(main() if rc is None else rc)
