"""CLI: `uv run python -m pipeline.validation build [--only id,id]`, `... list` and `... report`.

Writes validation/cases/<id>/{case.json, reference.bin, preview.png} and validation/index.json.
"""

from __future__ import annotations

import argparse
import json
import sys

from . import build as vb
from .cases import CASES as _FRAME_CASES
from .himawari import HIMAWARI

CASES = {**_FRAME_CASES, HIMAWARI.id: HIMAWARI}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pipeline.validation")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--only", default="", help="comma-separated case ids")
    sub.add_parser("list")
    sub.add_parser("report")
    args = ap.parse_args(argv)
    if args.cmd == "report":
        from . import report
        report.write(report.FINDINGS)
        print(f"wrote {report.REPORT}")
        return 0
    if args.cmd == "list":
        for cid, c in CASES.items():
            print(f"{cid:34s} {c.title}")
        return 0
    wanted = [s for s in args.only.split(",") if s] or list(CASES)
    unknown = set(wanted) - set(CASES)
    if unknown:
        print(f"unknown cases {sorted(unknown)}; known: {list(CASES)}", file=sys.stderr)
        return 2
    for cid in wanted:
        built = vb.build_case(CASES[cid])
        d = vb.write_case(cid, built)
        print(f"[{cid}] wrote {d}")
    vb.write_index()
    return 0


if __name__ == "__main__":
    sys.exit(main())
