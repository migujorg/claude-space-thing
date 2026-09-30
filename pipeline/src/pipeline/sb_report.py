"""Print the number tables of docs/reports/small-bodies.md from the last `smallbodies` build:
`uv run python -m pipeline.sb_report` (reads data/cache/smallbodies_report.json and the product headers)."""

from __future__ import annotations

import json

from .paths import CACHE, OUT


def _fmt(n) -> str:
    return f"{n:,}" if isinstance(n, int) else str(n)


def main() -> None:
    rep = json.loads((CACHE / "smallbodies_report.json").read_text())
    core = json.loads((OUT / "smallbodies" / "core.json").read_text())
    st = rep["statistics"]
    print(f"Objects: {st['objects']:,} (snapshot {core['snapshot']}, epoch {core['epochTdb']} TDB)\n")
    k = st["kinds"]
    print("| Kind | Objects |\n|---|---|")
    for name, key in (("Numbered asteroids", "numberedAsteroids"), ("Unnumbered asteroids", "unnumberedAsteroids"),
                      ("Numbered comets", "numberedComets"), ("Unnumbered comets", "unnumberedComets")):
        print(f"| {name} | {k[key]:,} |")
    print(f"| NEOs / PHAs | {st['neo']:,} / {st['pha']:,} |\n")
    names = {c["code"]: c["name"] for c in core["orbitClasses"]}
    print("| SBDB class | Meaning | Objects | Class median p_V (n measured) |\n|---|---|---|---|")
    ca = core["classAlbedo"]
    for code, cnt in st["orbitClasses"].items():
        alb = ca.get(code)
        a = f"{alb['median']:.3f} ({alb['n']:,})" if alb else f"all-class {ca['*']['median']:.3f}" if code and not code.endswith(("c", "C", "P", "R")) else "—"
        print(f"| {code} | {names.get(code, '')} | {cnt:,} | {a} |")
    print()
    labs = ["measured", "derived", "estimated", "unknown"]
    print("| Attribute | " + " | ".join(labs) + " |\n|---|" + "---|" * len(labs))
    for attr, c in st["labels"].items():
        print(f"| {attr} | " + " | ".join(_fmt(c.get(l, 0)) for l in labs) + " |")
    print()
    print("Physical sources:", json.dumps(st["physical"], indent=None))
    print("MPC cross-check:", json.dumps(st["mpcCrossCheck"]))
    print("Propagation:", json.dumps({k: v for k, v in st["propagation"].items() if k != "horizonsNotes"}))
    for n in st["propagation"]["horizonsNotes"]:
        print("  -", n)
    print()
    print("| Object | Class | q (au) | e | SBDB orbit = Horizons solution | Max error (km) | Tolerance | Max level |")
    print("|---|---|---|---|---|---|---|---|")
    for v in rep["verification"]:
        print(f"| {v['object']} | {v['category']} | {v['qAu']:.3f} | {v['e']:.3f} | {v['sbdbOrbit']} = "
              f"{v['horizonsSolution']} ({'yes' if v['sameSolution'] else 'NO'}) | {v['maxErrKm']:.2f} | "
              f"{v['toleranceKm']:g} | {v['maxLevel']} |")
    print()
    print("Timing (s):", json.dumps(rep["timing"]))
    print("\n| Product | Bytes |\n|---|---|")
    tot = 0
    for p, e in sorted(rep["products"].items()):
        tot += e["bytes"]
        print(f"| {p} | {e['bytes']:,} |")
    print(f"| total | {tot:,} |")


if __name__ == "__main__":
    main()
