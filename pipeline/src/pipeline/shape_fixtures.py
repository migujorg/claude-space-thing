"""Regenerate the app's shape-orientation fixture: `uv run python -m pipeline.shape_fixtures`.

Writes app/tests/fixtures/shape_orientation.json, the reference for app/tests/render-mesh-orientation.test.ts:
  frames   for shapes whose frame has rotation constants (`sourceRotation` in the header): SPICE
           pxform(<frame>, 'J2000') with the mission kernels the header names, at fixed epochs
  damit    DAMIT models that DAMIT also converted to the IAU form (IAUspin): the spin state (λ, β, P, t0, φ0,
           YORP) and the IAU constants (α0, δ0, W0, Ẇ), an independent implementation of the same rotation
Needs a built `shapes` stage (headers and damit-index) and the kernels in data/raw/shapes.
"""

from __future__ import annotations

import json

import numpy as np
import spiceypy as sp

from . import shape_catalog
from .paths import OUT, RAW, REPO
from .sb_table import read_table
from .shape_orient import et_of

FIXTURE = REPO / "app" / "tests" / "fixtures" / "shape_orientation.json"
EPOCHS = ("2000-01-01T12:00:00", "2010-06-15T00:00:00", "2026-10-01T00:00:00")
FRAMES = ("phobos", "deimos", "eros", "lutetia", "vesta", "bennu")


def frame_cases() -> list[dict]:
    index = json.loads((OUT / "shapes" / "index.json").read_text())
    by_name = {b["name"]: k for k, b in index["bodies"].items()}
    out = []
    for src in shape_catalog.ALL:
        if src.key not in FRAMES:
            continue
        h = json.loads((OUT / "shapes" / f"{by_name[src.name]}.json").read_text())
        kernels = [RAW / "shapes" / src.key / "kernels" / k for k in h["orientation"]["kernels"]]
        sp.kclear()
        try:
            for k in kernels:
                sp.furnsh(str(k))
            cases = [{"et": et_of(e), "bodyToJ2000": [float(x) for x in np.array(sp.pxform(src.frame, "J2000",
                                                                                           et_of(e))).ravel()]}
                     for e in EPOCHS]
        finally:
            sp.kclear()
        out.append({"key": src.key, "id": h["id"], "frame": src.frame, "kernels": h["orientation"]["kernels"],
                    "sourceRotation": h["orientation"]["sourceRotation"], "cases": cases})
    return out


def damit_cases(n: int = 12) -> list[dict]:
    h, rec = read_table(OUT / "shapes" / "damit-index.json")
    ok = np.isfinite(rec["poleRaDeg"]) & np.isfinite(rec["w0Deg"]) & (rec["preferred"] == 1)
    rows = rec[ok]
    # a spread of models: some with a YORP term, the rest by asteroid number
    yorp = rows[np.abs(rows["yorpRadPerDay2"]) > 0][:3]
    plain = rows[rows["yorpRadPerDay2"] == 0][:: max(1, len(rows) // n)][: n - len(yorp)]
    out = []
    for r in list(yorp) + list(plain):
        out.append({k: (int(r[k]) if k in ("spkid", "damitModelId") else float(r[k])) for k in (
            "spkid", "damitModelId", "lambdaDeg", "betaDeg", "periodHours", "jd0", "phi0Deg", "yorpRadPerDay2",
            "poleRaDeg", "poleDecDeg", "w0Deg", "wDotDegPerDay")})
    return out


def main() -> None:
    obj = {"description": __doc__.strip().splitlines()[0], "epochs": list(EPOCHS),
           "frames": frame_cases(), "damit": damit_cases()}
    FIXTURE.write_text(json.dumps(obj, indent=1) + "\n")
    print(f"wrote {FIXTURE}")


if __name__ == "__main__":
    main()
