"""Cross-check: predicted apparent V magnitudes vs JPL Horizons APmag.

Horizons' APmag for the planets implements Mallama & Hilton (2018); for the moons it uses the V(1,0) printed in
the object-data header (JPL's compiled satellite physical parameters) plus, where Horizons has one, a phase law.
For each body we compare
  ours     = V(1,0) implied by our p_V and the pck00011 radius + 5 log10(r Δ) + our phase function Δm(α)
  mh       = our reimplementation of Mallama & Hilton (2018) as coded in Ap_Mag_V3 (checks geometry and equations)
  horizons = APmag
using Horizons' own r, Δ, phase angle and sub-observer/sub-solar latitudes. Responses are fetched through
download.fetch (sha256-recorded) and copies are kept as test fixtures under pipeline/tests/fixtures/horizons/.
Moon requests include the object-data header (OBJ_DATA=YES) so its V(1,0) and geometric albedo can be reported.
"""

from __future__ import annotations

import math
import re
import time
from dataclasses import dataclass
from pathlib import Path

from ..download import fetch
from . import albedo, phase
from .bodies import BODIES, PLANETS, BodyResult
from .common import read_table_json

API = "https://ssd.jpl.nasa.gov/api/horizons.api"
EPOCHS_JD = (2461313.5, 2461420.5, 2461557.5)   # 2026-09-30, 2027-01-15, 2027-06-01 00:00 UT
OBSERVER = {399: "500@499"}                        # Earth is observed from Mars' centre; everything else from Earth's
QUANTITIES = "9,14,15,19,20,24"
FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "horizons"


def _params(naif: int) -> dict:
    obj = "'NO'" if naif in PLANETS else "'YES'"
    return {"format": "text", "COMMAND": f"'{naif}'", "OBJ_DATA": obj, "MAKE_EPHEM": "'YES'",
            "EPHEM_TYPE": "'OBSERVER'", "CENTER": f"'{OBSERVER.get(naif, '500@399')}'",
            "TLIST": "'" + "','".join(f"{jd}" for jd in EPOCHS_JD) + "'", "TLIST_TYPE": "'JD'", "TIME_TYPE": "'UT'",
            "QUANTITIES": f"'{QUANTITIES}'", "CSV_FORMAT": "'YES'", "ANG_FORMAT": "'DEG'"}


def fixture_name(naif: int) -> str:
    return f"horizons_{naif}_{OBSERVER.get(naif, '500@399').replace('@', 'at')}.txt"


def download(naif: int) -> Path:
    """Fetch (once, cached and sha256-recorded) the Horizons observer table for a body."""
    return fetch(API, "horizons", fixture_name(naif), params=_params(naif))


@dataclass
class Row:
    date: str
    apmag: float | None
    obs_sub_lat: float
    sun_sub_lat: float
    r_au: float
    delta_au: float
    phase_deg: float


def parse(text: str) -> list[Row]:
    body = text.split("$$SOE", 1)[1].split("$$EOE", 1)[0]
    rows = []
    for line in body.strip().splitlines():
        f = [x.strip() for x in line.split(",")]
        # date, (blank), (blank), APmag, S-brt, ObsLON, ObsLAT, SunLON, SunLAT, r, rdot, delta, deldot, S-T-O
        ap = None if f[3] in ("n.a.", "") else float(f[3])

        def num(x):     # sub-observer/sub-solar latitudes are n.a. for bodies without a rotation model
            return math.nan if x in ("n.a.", "") else float(x)

        rows.append(Row(f[0], ap, num(f[6]), num(f[8]), float(f[9]), float(f[11]), float(f[13])))
    return rows


def header_values(text: str) -> dict[str, str]:
    """'V(1,0)' and 'Geometric Albedo' from a Horizons satellite object-data header (strings as printed)."""
    head = text.split("$$SOE", 1)[0]
    out = {}
    for key in ("V(1,0)", "Geometric Albedo", "Geometric albedo"):
        m = re.search(re.escape(key) + r"[ \t]*=[ \t]*(\S[^\n]*?)(?:[ \t]{2,}|$)", head, flags=re.M)
        if m:
            out[key.replace("albedo", "Albedo")] = m.group(1).strip()
    return out


def planetocentric(lat_det_deg: float, naif: int) -> float:
    a, _, c = albedo.pck_radii()[naif]
    return math.degrees(math.atan((c / a) ** 2 * math.tan(math.radians(lat_det_deg))))


def mh_prediction(naif: int, row: Row) -> tuple[float | None, str]:
    geo = 5.0 * math.log10(row.r_au * row.delta_au)
    year = 2000.0 + (float(row.date[:4]) - 2000.0)
    if naif == 699:
        be, bs = planetocentric(row.obs_sub_lat, 699), planetocentric(row.sun_sub_lat, 699)
        beta = math.sqrt(be * bs) if be * bs > 0 else 0.0
        v = phase.mh_reduced_mag(699, row.phase_deg, rings_beta=abs(beta))
        return (None if v is None else v + geo), f"β_eff={abs(beta):.2f}° (rings in Eq. 10)" if row.phase_deg <= 6.5 \
            and abs(beta) <= 27 else "globe"
    if naif == 799:
        phi = 0.5 * (abs(row.obs_sub_lat) + abs(row.sun_sub_lat))
        v = phase.mh_reduced_mag(799, row.phase_deg, phi_prime=phi, as_coded=True)
        return (None if v is None else v + geo), f"φ′={phi:.1f}°"
    if naif in (199, 299, 399, 499, 599, 899):
        v = phase.mh_reduced_mag(naif, row.phase_deg, year=year, as_coded=True)
        return (None if v is None else v + geo), ("no L(λe), L(Ls) terms" if naif == 499 else "")
    return None, "Horizons formula not from Mallama & Hilton"


def charon_mag(row: Row) -> float:
    """Rough Charon V for combining with Pluto (Horizons' Pluto APmag includes Charon). Buie et al. (2010) mean
    Charon V at 0° and 1° phase (mean opposition distance), linear in α between/beyond; ±~0.05 mag."""
    t = read_table_json("buie_2010a_pluto.json")
    ch = t["charon"]
    geo0 = 5.0 * math.log10(t["mean_opposition_r_au"] * t["mean_opposition_delta_au"])
    v1 = ch["V_a0_1deg"] - geo0
    v0 = v1 + ch["V_to_zero_phase"]
    return v0 + (v1 - v0) * row.phase_deg + 5.0 * math.log10(row.r_au * row.delta_au)


def our_prediction(res: BodyResult, row: Row) -> float | None:
    pf = res.entry["phaseFunction"]["value"]
    if res.v10 is None or pf is None:
        return None
    dm = phase.delta_mag(pf, row.phase_deg)
    if dm is None:
        return None
    v = res.v10 + 5.0 * math.log10(row.r_au * row.delta_au) + dm
    if res.naif == 999:  # add Charon's light for comparison with Horizons (Pluto + Charon)
        v = -2.5 * math.log10(10 ** (-0.4 * v) + 10 ** (-0.4 * charon_mag(row)))
    return v


@dataclass
class Comparison:
    naif: int
    name: str
    row: Row
    horizons: float | None
    mh: float | None
    ours: float | None
    note: str


def compare(results: dict[int, BodyResult], texts: dict[int, str] | None = None) -> list[Comparison]:
    """Compare predictions with Horizons. `texts` (NAIF id -> Horizons response) defaults to fetching."""
    out = []
    for naif, res in results.items():
        if texts is not None:
            text = texts[naif]
        else:
            text = download(naif).read_text()
            time.sleep(1.0)  # be polite to the Horizons API (only matters for uncached fetches)
        for row in parse(text):
            mh, note = mh_prediction(naif, row)
            out.append(Comparison(naif, res.name, row, row.apmag, mh, our_prediction(res, row), note))
    return out


def save_fixtures(ids=None) -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    for naif in (ids or BODIES):
        (FIXTURES / fixture_name(naif)).write_text(download(naif).read_text())
        time.sleep(1.0)


def load_fixtures(ids=None) -> dict[int, str]:
    return {naif: (FIXTURES / fixture_name(naif)).read_text() for naif in (ids or BODIES)}
