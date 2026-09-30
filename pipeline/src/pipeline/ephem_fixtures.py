"""Regenerate the app's core verification fixtures: `uv run python -m pipeline.ephem_fixtures`.

Writes app/tests/fixtures/:
  horizons_geometric.json    JPL Horizons geometric SSB-centred ICRF states (independent of our pipeline)
  horizons_astrometric.json  JPL Horizons light-time-corrected states seen from Earth's center
  core_spice_time.json       SPICE str2et / et2utc with naif0012.tls
  core_spice_rotation.json   SPICE pxform('IAU_<BODY>', 'J2000') with pck00011.tpc
  core_spice_spk.json        SPICE spkgeo (geometric state, like spkgps + velocity) on the planetary kernel, every segment

Each Horizons entry records the exact query URL. The epochs are fixed (below) and must lie inside the data
window of the build being tested (now ± ~18 months); move them and rerun this when that stops being true.
"""

from __future__ import annotations

import calendar
import datetime as _dt
import json
import re

import numpy as np
import spiceypy as sp

from . import ephem_horizons as hz
from .download import record
from .ephem_kernels import lsk, pck, planetary
from .ephem_spk import read_spk
from .paths import REPO

FIXTURES = REPO / "app" / "tests" / "fixtures"

# JD TDB, chosen with binary-exact fractions so ET = (JD - 2451545) * 86400 is exact.
EPOCHS_JD = [2461012.15625, 2461178.84375, 2461313.5078125, 2461487.2890625, 2461617.9609375]

GEOMETRIC_TARGETS = [10, 199, 299, 399, 301, 499, 599, 699, 799, 899, 999, 3, 4, 5, 6, 7, 8, 9]
ASTROMETRIC_TARGETS = [599, 301, 10, 999]

IAU_FRAMES = {10: "IAU_SUN", 199: "IAU_MERCURY", 299: "IAU_VENUS", 399: "IAU_EARTH", 301: "IAU_MOON",
              499: "IAU_MARS", 599: "IAU_JUPITER", 699: "IAU_SATURN", 799: "IAU_URANUS", 899: "IAU_NEPTUNE",
              999: "IAU_PLUTO"}

UTC_CASES = [
    "1960-01-01T00:00:00", "1972-01-01T00:00:00", "1999-12-31T23:59:59", "2000-01-01T12:00:00",
    "2012-06-30T23:59:59.999", "2012-07-01T00:00:00", "2016-12-31T23:59:59", "2016-12-31T23:59:59.5",
    "2017-01-01T00:00:00", "2017-01-01T00:00:00.25", "2026-09-30T08:00:00", "2027-06-15T18:30:15.125",
    "2028-02-29T23:59:59",
]
LEAP_SECOND_UTC = ["2016-12-31T23:59:60", "2016-12-31T23:59:60.5", "2016-12-31T23:59:60.999"]


def _unix_ms(utc: str) -> float:
    m = re.fullmatch(r"(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(\.\d+)?", utc)
    assert m, utc
    y, mo, d, h, mi, s = (int(x) for x in m.groups()[:6])
    frac = float(m.group(7) or 0.0)
    return (calendar.timegm((y, mo, d, h, mi, s)) + frac) * 1000.0


def _horizons(target: int, center: str, corr: str, tag: str) -> dict:
    params = hz.vector_params(str(target), center, tlist=[repr(j) for j in EPOCHS_JD], corr=corr)
    path, table = hz.fetch_vectors(params, "horizons/fixtures", f"{tag}_{target}_from_{center.replace('@', '_')}.txt")
    et = hz.jd_to_et(table.jd_tdb)
    if not np.allclose(table.jd_tdb, EPOCHS_JD, rtol=0, atol=1e-9):
        raise ValueError("Horizons returned different epochs")
    text = path.read_text()
    corr_desc = ""
    if "ABERRATIONS AND CORRECTIONS" in text:
        corr_desc = re.sub(r"\s+", " ", text.split("ABERRATIONS AND CORRECTIONS", 1)[1].split("Computations by", 1)[0]).strip()
    rec = record(path)
    return {
        "target": target,
        "center": center,
        "queryUrl": query_check(params, rec["url"]),
        "retrieved": rec["retrieved"],
        "sha256": rec["sha256"],
        "targetLine": table.target_line,
        "centerLine": table.center_line,
        "outputType": table.output_type,
        "corrections": corr_desc,
        "rows": table.rows,
        "epochs": [{"jdTdb": float(j), "et": float(e), "pos": s[:3].tolist(), "vel": s[3:].tolist()}
                   for j, e, s in zip(table.jd_tdb, et, table.states)],
    }


def query_check(params: dict, ledger_url: str) -> str:
    url = hz.query_url(params)
    if url != ledger_url:
        raise ValueError(f"URL mismatch:\n{url}\n{ledger_url}")
    return url


def main() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    today = _dt.date.today().isoformat()
    lsk_path, pck_path, spk_path = lsk(), pck(), planetary()
    for p in (lsk_path, pck_path, spk_path):
        sp.furnsh(str(p))
    try:
        epochs_et = [float(hz.jd_to_et(j)) for j in EPOCHS_JD]
        common = {"generatedBy": "uv run python -m pipeline.ephem_fixtures", "generated": today}

        geo = [_horizons(t, "500@0", "NONE", "geometric") for t in GEOMETRIC_TARGETS]
        _write("horizons_geometric.json", {**common, "description": "JPL Horizons geometric states wrt the SSB "
               "(500@0), ICRF, km and km/s, TDB epochs.", "bodies": geo})
        ast = [_horizons(t, "500@399", "LT", "astrometric") for t in ASTROMETRIC_TARGETS]
        _write("horizons_astrometric.json", {**common, "description": "JPL Horizons light-time-corrected "
               "(astrometric, VEC_CORR=LT) states of targets as seen from Earth's center (500@399), ICRF, km, TDB.",
               "bodies": ast})

        time_cases = [{"utc": u, "unixMs": _unix_ms(u), "et": sp.str2et(u)} for u in UTC_CASES]
        leap_cases = [{"utc": u, "et": sp.str2et(u)} for u in LEAP_SECOND_UTC]
        inverse = [{"et": e, "utc": sp.et2utc(e, "ISOC", 6)} for e in epochs_et + [0.0, -1.0e9]]
        lr = record(lsk_path)
        _write("core_spice_time.json", {**common, "kernel": {"file": lsk_path.name, "sha256": lr["sha256"]},
               "spiceVersion": sp.tkvrsn("TOOLKIT"), "utcToEt": time_cases, "leapSecondUtcToEt": leap_cases,
               "etToUtc": inverse})

        rot_epochs = [sp.str2et("1950-01-01T00:00:00"), 0.0] + epochs_et + [sp.str2et("2100-01-01T00:00:00")]
        rot = [{"id": i, "frame": f, "cases": [{"et": e, "bodyToJ2000": np.array(sp.pxform(f, "J2000", e)).reshape(-1).tolist()}
                                              for e in rot_epochs]}
               for i, f in IAU_FRAMES.items()]
        pr = record(pck_path)
        _write("core_spice_rotation.json", {**common, "kernel": {"file": pck_path.name, "sha256": pr["sha256"]},
               "spiceVersion": sp.tkvrsn("TOOLKIT"), "description": "Row-major 3x3 body-fixed -> J2000 matrices "
               "from spiceypy.pxform(frame, 'J2000', et).", "bodies": rot})

        spk = []
        for s in read_spk(spk_path):
            cases = []
            for e in epochs_et:
                st, _ = sp.spkgeo(s.target, e, "J2000", s.center)
                cases.append({"et": e, "pos": list(st[:3]), "vel": list(st[3:])})
            spk.append({"target": s.target, "center": s.center, "cases": cases})
        sr = record(spk_path)
        _write("core_spice_spk.json", {**common, "kernel": {"file": spk_path.name, "sha256": sr["sha256"]},
               "spiceVersion": sp.tkvrsn("TOOLKIT"), "description": "spiceypy.spkgeo(target, et, 'J2000', center) "
               "on the original kernel for every de440s segment.", "segments": spk})
    finally:
        for p in (lsk_path, pck_path, spk_path):
            sp.unload(str(p))


def _write(name: str, obj: dict) -> None:
    (FIXTURES / name).write_text(json.dumps(obj, indent=1) + "\n")
    print(f"wrote {FIXTURES / name}")


if __name__ == "__main__":
    main()
