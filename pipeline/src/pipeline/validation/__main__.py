"""CLI: `uv run python -m pipeline.validation build [--only id,id]`, `... list`, `... report` and `... clean`.

Writes validation/cases/<id>/{case.json, reference.bin, preview.png} and validation/index.json. `clean` deletes the
downloaded images once the cases are built (the next `build` fetches them again).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
import tempfile
import os

from . import build as vb
from .cases import CASES as _FRAME_CASES
from .himawari import HIMAWARI

CASES = {**_FRAME_CASES, HIMAWARI.id: HIMAWARI}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pipeline.validation")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--only", default="", help="comma-separated case ids")
    b.add_argument("--output", type=Path, help="write candidates under DIR/cases (leave committed cases untouched)")
    b.add_argument("--unlocked", action="store_true", help="inspect changed inputs; requires --output")
    b.add_argument("--earth-pck", help="explicit Earth PCK filename for a new Himawari candidate")
    b.add_argument("--fresh-fit", action="store_true", help="ignore both optimizer caches")
    v = sub.add_parser("verify", help="rebuild and compare without changing committed cases")
    v.add_argument("--only", default="")
    v.add_argument("--cases-dir", type=Path, help="validation root to verify; defaults to committed validation/")
    v.add_argument("--fresh-fit", action="store_true")
    sub.add_parser("list")
    sub.add_parser("report")
    sub.add_parser("clean", help="delete the downloaded images; keep metadata, source documents and Horizons tables")
    args = ap.parse_args(argv)
    if args.cmd == "clean":
        from ..paths import RAW
        freed = 0
        for cid in CASES:
            d = RAW / "validation" / cid
            for f in (d.iterdir() if d.is_dir() else []):
                if f.is_file() and f.suffix.lower() != ".json":
                    freed += f.stat().st_size
                    f.unlink()
        print(f"deleted {freed / 1e6:.1f} MB of downloaded images")
        return 0
    if args.cmd == "report":
        from . import report
        # §7 from the app's last run (`cd app && npm run validate`), when there is one.
        run = json.loads(report.RUN_REPORT.read_text(encoding="utf-8")) if report.RUN_REPORT.exists() else None
        report.write(report.FINDINGS, run, report.RUN_FINDINGS)
        print(f"wrote {report.REPORT}" + (f" (with the run of {run['generatedAt']})" if run else ""))
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
    from . import reproducibility as repro, register
    from ..paths import CACHE
    if args.cmd == "build" and args.unlocked and args.output is None:
        ap.error("--unlocked requires --output; committed cases are never unlocked in place")
    if args.cmd == "build" and args.earth_pck:
        os.environ["PIPELINE_VALIDATION_EARTH_PCK"] = args.earth_pck
    if args.cmd == "build" and args.unlocked and args.output.resolve() == vb.VALIDATION.resolve():
        ap.error("--unlocked output must differ from the committed validation directory")
    register.USE_CACHE = not args.fresh_fit
    committed = args.cases_dir if args.cmd == "verify" and args.cases_dir else vb.VALIDATION
    destination = args.output if args.cmd == "build" and args.output else vb.VALIDATION
    failed = False
    CACHE.mkdir(parents=True, exist_ok=True)
    for cid in wanted:
        old_dir = committed / "cases" / cid
        old_path = old_dir / "case.json"
        expected = json.loads(old_path.read_text()) if old_path.exists() else None
        if args.cmd == "verify" and expected is None:
            print(f"[{cid}] missing committed case", file=sys.stderr)
            failed = True
            continue
        if args.cmd == "build" and args.unlocked:
            expected = None
        try:
            built = vb.build_case(CASES[cid], expected=expected)
            with tempfile.TemporaryDirectory(prefix="validation-verify-", dir=CACHE) as tmp:
                original = vb.VALIDATION
                try:
                    vb.VALIDATION = Path(tmp)
                    candidate = vb.write_case(cid, built)
                finally:
                    vb.VALIDATION = original
                result = repro.compare_cases(old_dir, candidate) if expected is not None else None
                if args.cmd == "verify":
                    print(json.dumps({"id": cid, **result}, ensure_ascii=False))
                    failed |= not result["reproduces"]
                elif destination == committed and result and not result["reproduces"]:
                    raise repro.ReproductionError("rebuild differs from committed scientific values/reference; "
                                                  "inspect with build --output DIR (or --unlocked for changed inputs)")
                else:
                    try:
                        vb.VALIDATION = destination
                        d = vb.write_case(cid, built)
                    finally:
                        vb.VALIDATION = original
                    print(f"[{cid}] wrote {d}")
        except (repro.ReproductionError, FileNotFoundError) as exc:
            print(f"[{cid}] cannot reproduce: {exc}", file=sys.stderr)
            failed = True
    if args.cmd == "build" and not failed:
        original = vb.VALIDATION
        try:
            vb.VALIDATION = destination
            vb.write_index()
        finally:
            vb.VALIDATION = original
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
