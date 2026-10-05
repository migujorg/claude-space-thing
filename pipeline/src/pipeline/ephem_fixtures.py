"""Regenerate the app's core references: `uv run python -m pipeline.ephem_fixtures`
(`... -m pipeline.ephem_fixtures orientation`: only core_spice_orient.json, from the kernels already in data/raw,
at the epochs the committed file has; no network).

Writes app/tests/fixtures/:
  horizons_geometric.json    JPL Horizons geometric SSB-centred ICRF states (independent of our pipeline)
  horizons_astrometric.json  JPL Horizons light-time-corrected states seen from Earth's center
  core_spice_time.json       SPICE str2et / et2utc with naif0012.tls
  core_spice_rotation.json   SPICE pxform('IAU_<BODY>', 'J2000') with pck00011.tpc
  core_spice_spk.json        SPICE spkgeo (geometric state, like spkgps + velocity) on the planetary kernel, every segment,
                             and on the satellite kernel excerpts for a sample of each kernel's segments (types 2, 3, 17)
  horizons_moons.json        JPL Horizons moons relative to their planet's centre
  core_spice_orient.json     SPICE pxform('ITRF93' / 'MOON_ME_DE440_ME421', 'J2000') with NAIF's Earth and lunar PCKs;
                             every case names the kernel files it was computed from (sha256 in kernelSha256)
It also downloads a few small satellite kernels whole (VERIFY_ORIGINALS) for pipeline/tests/test_ephem_satellites.py.

Each Horizons entry records the exact query URL. Horizons answers are built on different planetary ephemerides per
system (HORIZONS_BASE); each epoch carries `toOurs`, the SPICE-computed shift (our planetary kernel minus the one
Horizons used, for the planetary-ephemeris part of the chain) that re-bases the Horizons vector onto our kernel.
The epochs are fixed (below). A test checks the cases the build under test covers and reports the others as not
compared, so a rebuild never requires running this; move the epochs and rerun it when the window has moved so far
that most cases are reported as not compared.

SPICE values are a reference for the kernel files they were computed from. The lunar kernel and the planetary
kernels are fixed files, but NAIF reissues the Earth orientation kernel as measurements arrive (values of past,
measured days move by ~1e-11, the newest days by ~1e-9: measured between the files of 2026-09-29 and 2026-10-03).
So a test compares an ITRF93 case only with a product copied from the same kernel file (sha256), and otherwise
reports it as not compared; SPICE on the kernels of the build itself is the bodies stage's build record
(verification/orientation.json).
"""

from __future__ import annotations

import calendar
import datetime as _dt
import json
import re

import numpy as np
import spiceypy as sp

from . import ephem_horizons as hz
from . import ephem_satellites as sat
from .download import fetch, record
from .ephem_kernels import PLANETARY, lsk, naif_planets, pck, planetary
from .ephem_spk import read_pck, read_spk
from .paths import CACHE, OUT, RAW, REPO

FIXTURES = REPO / "app" / "tests" / "fixtures"

# JD TDB, chosen with binary-exact fractions so ET = (JD - 2451545) * 86400 is exact.
EPOCHS_JD = [2461012.15625, 2461178.84375, 2461313.5078125, 2461487.2890625, 2461617.9609375]
# When regenerated, every epoch lies at least this far inside the persisted window, so every case is covered by
# builds whose window was made some weeks earlier or later (tests report the cases a build does not cover).
INSIDE_MARGIN_S = 90 * 86400.0

GEOMETRIC_TARGETS = [10, 199, 299, 399, 301, 499, 599, 699, 799, 899, 999, 3, 4, 5, 6, 7, 8, 9]
ASTROMETRIC_TARGETS = [599, 301, 10, 999]
# (moon, planet centre): Io, Europa, Titan, Enceladus, Phobos, Triton, Charon, Miranda; irregulars Himalia
# (jup347) and Sycorax (ura184); Janus (sat415, SPK type 3); S/2009 S 2 (sat480, type 17); S/2011 J 4 (5-digit id).
MOON_TARGETS = [(501, 599), (502, 599), (606, 699), (602, 699), (401, 499), (801, 899), (901, 999), (705, 799),
                (506, 599), (717, 799), (610, 699), (65304, 699), (55527, 599)]
SAMPLE_PER_KERNEL = 3
# Satellite kernels small enough to download whole, so pipeline/tests can compare excerpt and original with SPICE.
VERIFY_ORIGINALS = ["mar099s", "jup348", "plu060"]

IAU_FRAMES = {10: "IAU_SUN", 199: "IAU_MERCURY", 299: "IAU_VENUS", 399: "IAU_EARTH", 301: "IAU_MOON",
              499: "IAU_MARS", 599: "IAU_JUPITER", 699: "IAU_SATURN", 799: "IAU_URANUS", 899: "IAU_NEPTUNE",
              999: "IAU_PLUTO", 401: "IAU_PHOBOS", 402: "IAU_DEIMOS", 501: "IAU_IO", 502: "IAU_EUROPA",
              602: "IAU_ENCELADUS", 606: "IAU_TITAN", 610: "IAU_JANUS", 705: "IAU_MIRANDA", 801: "IAU_TRITON",
              901: "IAU_CHARON"}

# Planetary kernel equivalent to what each Horizons answer is built on, keyed by the source Horizons names:
# - 'DE441' (Horizons' default): numerically identical to de440s in this era (measured: barycenters 3-9 agree to
#   <= 1.1e-6 km at the fixture epochs), and DE441 itself is not available as a small kernel.
# - satellite ephemerides: "Planetary Ephemeris Number" in NAIF's <name>.cmt comment files:
#   jup365, sat441, mar099, plu060 -> DE-0440; ura184, nep098 -> DE-0442.
HORIZONS_BASE = {"DE441": "de440s", "jup365": "de440s", "sat441": "de440s", "mar099": "de440s", "plu060": "de440s",
                 "ura184": "de442s", "nep098": "de442s"}
DE_IDS = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 199, 299, 301, 399}
C_KM_S = 299792.458  # speed of light, SI defining constant (BIPM SI Brochure, 9th ed., 2019)

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
    text = path.read_text(encoding="utf-8")
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


def _base_of(line: str) -> str:
    m = re.search(r"\{source:\s*([^}]+)\}", line)
    src = m.group(1).strip() if m else ""
    for k, v in HORIZONS_BASE.items():
        if src.startswith(k):
            return v
    raise ValueError(f"unknown Horizons source {src!r}: add it to HORIZONS_BASE")


def _de_part(target: int) -> int:
    """The node of the chain where the planetary ephemeris ends (planet centers hang off their barycenter)."""
    return target if target in DE_IDS else target // 100


def _ssb(kernel, target: int, et: float) -> np.ndarray:
    """SSB position of target from one planetary kernel loaded on its own."""
    sp.furnsh(str(kernel))
    try:
        return np.array(sp.spkgeo(target, et, "J2000", 0)[0][:3])
    finally:
        sp.unload(str(kernel))


def _rebase(bodies: list[dict], kernels: dict, astrometric: bool) -> None:
    """Add horizonsPlanetary and per-epoch toOurs (km) to each Horizons body entry."""
    for b in bodies:
        base = _base_of(b["targetLine"])
        b["horizonsPlanetary"] = base
        obs_base = _base_of(b["centerLine"]) if astrometric else None
        if astrometric:
            b["observerPlanetary"] = obs_base
        tgt = _de_part(b["target"])
        for e in b["epochs"]:
            t_emit = e["et"] - (np.linalg.norm(e["pos"]) / C_KM_S if astrometric else 0.0)
            d = _ssb(kernels[PLANETARY], tgt, t_emit) - _ssb(kernels[base], tgt, t_emit)
            if astrometric:
                d -= _ssb(kernels[PLANETARY], 399, e["et"]) - _ssb(kernels[obs_base], 399, e["et"])
            e["toOurs"] = d.tolist()


def _window() -> tuple[float, float]:
    from .stages.ephemeris import MARGIN_S
    w = json.loads((CACHE / "window.json").read_text(encoding="utf-8"))
    return w["startEt"] - MARGIN_S, w["endEt"] + MARGIN_S


def _satellite_spk(epochs_et: list[float]) -> list[dict]:
    """spkgeo on each satellite excerpt for up to SAMPLE_PER_KERNEL of its product segments (all type 3/17 ones)."""
    t0, t1 = _window()
    by_kernel: dict[str, list[tuple[str, dict]]] = {}
    for p in sorted((OUT / "ephem").glob("sat-*.json")):
        for s in json.loads(p.read_text(encoding="utf-8"))["segments"]:
            by_kernel.setdefault(s["sources"][0].removeprefix("naif-"), []).append((f"ephem/{p.stem}", s))
    out = []
    for k in sat.KERNELS:
        segs = by_kernel[k.name]
        pick = [x for x in segs if x[1]["type"] != 2 or x[1]["target"] % 100 == 99 and x[1]["target"] < 1000]
        pick += [x for x in segs if x not in pick][: max(0, SAMPLE_PER_KERNEL - len(pick))]
        path = sat.kernel_path(k, t0, t1)
        sp.furnsh(str(path))
        try:
            for product, s in pick:
                cases = []
                for e in epochs_et:
                    st, _ = sp.spkgeo(s["target"], e, "J2000", s["center"])
                    cases.append({"et": e, "pos": list(st[:3]), "vel": list(st[3:])})
                out.append({"product": product, "kernel": path.name, "target": s["target"], "center": s["center"],
                            "type": s["type"], "cases": cases})
        finally:
            sp.unload(str(path))
    return out


def _moons(common: dict) -> None:
    """JPL Horizons: moons relative to their planet's centre (independent of the planetary ephemeris)."""
    bodies = [_horizons(t, f"500@{c}", "NONE", "moons") for t, c in MOON_TARGETS]
    _write("horizons_moons.json", {**common, "description": "JPL Horizons geometric states of moons relative to "
           "their planet's centre (500@<planet>), ICRF, km and km/s, TDB epochs. Checked against "
           "positionSSB(moon) - positionSSB(planet); the planetary ephemeris cancels.", "bodies": bodies})


def _orientation(common: dict, ets: list[float]) -> None:
    """SPICE pxform for the precise orientation frames (ITRF93, MOON_ME_DE440_ME421) at `ets`, with the newest
    Earth kernels in data/raw. Each case names the kernel files its value comes from."""
    pck_dir = RAW / "naif" / "pck"
    hp = sorted(pck_dir.glob("earth_000101_*.bpc"))[-1]
    pr = sorted(pck_dir.glob("earth_*_predict.bpc"))[-1]
    moon_pa = pck_dir / "moon_pa_de440_200625.bpc"
    moon_fk = RAW / "naif" / "fk-satellites" / "moon_de440_250416.tf"
    kernels = [pr, hp, moon_pa, moon_fk]  # high-precision after predict: it takes priority, as in orient/earth
    hp_end = max(s.end for s in read_pck(hp))

    def used(body: int, et: float) -> list[str]:
        return [moon_pa.name, moon_fk.name] if body == 301 else [hp.name if et <= hp_end else pr.name]

    for k in kernels:
        sp.furnsh(str(k))
    try:
        out = [{"id": i, "frame": f, "cases": [{"et": e, "kernels": used(i, e),
                                                "bodyToJ2000": np.array(sp.pxform(f, "J2000", e)).reshape(-1).tolist()}
                                               for e in sorted(ets)]}
               for i, f in ((399, "ITRF93"), (301, "MOON_ME_DE440_ME421"))]
    finally:
        for k in kernels:
            sp.unload(str(k))
    _write("core_spice_orient.json", {**common, "kernels": [k.name for k in kernels],
           "kernelSha256": {k.name: record(k)["sha256"] for k in kernels},
           "spiceVersion": sp.tkvrsn("TOOLKIT"), "description": "Row-major body-fixed -> J2000 matrices from "
           "spiceypy.pxform(frame, 'J2000', et) with NAIF's Earth and lunar PCKs. A reference for the kernel files "
           "each case names (`kernels`, sha256 in kernelSha256): comparable only with a product copied from the same "
           "files.", "bodies": out})


def orientation() -> None:
    """Only core_spice_orient.json, from the kernels already downloaded, at the committed file's epochs."""
    old = json.loads((FIXTURES / "core_spice_orient.json").read_text(encoding="utf-8"))
    _orientation({"generatedBy": "uv run python -m pipeline.ephem_fixtures orientation",
                  "generated": _dt.date.today().isoformat()},
                 sorted({c["et"] for b in old["bodies"] for c in b["cases"]}))


def query_check(params: dict, ledger_url: str) -> str:
    url = hz.query_url(params)
    if url != ledger_url:
        raise ValueError(f"URL mismatch:\n{url}\n{ledger_url}")
    return url


def main() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    today = _dt.date.today().isoformat()
    lsk_path, pck_path, spk_path = lsk(), pck(), planetary()
    epochs_et = [float(hz.jd_to_et(j)) for j in EPOCHS_JD]
    t0, t1 = _window()
    outside = [j for j, e in zip(EPOCHS_JD, epochs_et) if not (t0 + INSIDE_MARGIN_S <= e <= t1 - INSIDE_MARGIN_S)]
    if outside:
        raise ValueError(f"EPOCHS_JD {outside} are not {INSIDE_MARGIN_S / 86400:g} days inside the persisted window "
                         f"(ET {t0:.0f}..{t1:.0f}): move them into the window and regenerate")
    common = {"generatedBy": "uv run python -m pipeline.ephem_fixtures", "generated": today}

    # Horizons fixtures first: re-basing loads one planetary kernel at a time.
    kernels = {PLANETARY: spk_path}
    for name in sorted(set(HORIZONS_BASE.values()) - {PLANETARY}):
        kernels[name] = naif_planets(name)
    rebase_doc = (f"toOurs = (our {PLANETARY} minus the planetary kernel Horizons used for this answer, "
                  "horizonsPlanetary) for the planetary-ephemeris part of the chain, via spiceypy.spkgeo; "
                  "for astrometric entries target part at et - |pos|/c minus observer (399) part at et. "
                  "Horizons vector + toOurs = the same answer on our planetary ephemeris.")
    geo = [_horizons(t, "500@0", "NONE", "geometric") for t in GEOMETRIC_TARGETS]
    _rebase(geo, kernels, astrometric=False)
    _write("horizons_geometric.json", {**common, "description": "JPL Horizons geometric states wrt the SSB "
           "(500@0), ICRF, km and km/s, TDB epochs.", "ourPlanetary": PLANETARY, "rebase": rebase_doc,
           "bodies": geo})
    ast = [_horizons(t, "500@399", "LT", "astrometric") for t in ASTROMETRIC_TARGETS]
    _rebase(ast, kernels, astrometric=True)
    _write("horizons_astrometric.json", {**common, "description": "JPL Horizons light-time-corrected "
           "(astrometric, VEC_CORR=LT) states of targets as seen from Earth's center (500@399), ICRF, km, TDB.",
           "ourPlanetary": PLANETARY, "rebase": rebase_doc, "bodies": ast})

    for p in (lsk_path, pck_path, spk_path):
        sp.furnsh(str(p))
    try:

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
    finally:
        for p in (lsk_path, pck_path, spk_path):
            sp.unload(str(p))
    _write("core_spice_spk.json", {**common, "kernel": {"file": spk_path.name, "sha256": sr["sha256"]},
           "spiceVersion": sp.tkvrsn("TOOLKIT"), "description": "spiceypy.spkgeo(target, et, 'J2000', center) "
           f"on the original kernel for every {PLANETARY} segment; `satellites`: the same on the satellite "
           "kernel excerpts (each loaded alone) for a sample of every kernel's segments.", "segments": spk,
           "satellites": _satellite_spk(epochs_et)})
    _moons(common)
    _orientation(common, sorted(set(epochs_et) | {float(x) for x in np.linspace(t0 + INSIDE_MARGIN_S,
                                                                               t1 - INSIDE_MARGIN_S, 7)}))
    for name in VERIFY_ORIGINALS:
        fetch(f"{sat.SAT_URL}/{name}.bsp", "naif/spk-satellites-full")  # for pipeline/tests (excerpt vs original)


def _write(name: str, obj: dict) -> None:
    (FIXTURES / name).write_text(json.dumps(obj, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {FIXTURES / name}")


if __name__ == "__main__":
    import sys
    if sys.argv[1:] == ["orientation"]:
        orientation()
    elif sys.argv[1:]:
        raise SystemExit("usage: python -m pipeline.ephem_fixtures [orientation]")
    else:
        main()
