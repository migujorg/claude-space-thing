"""JPL Horizons API: geometric/astrometric state-vector queries, cached through download.fetch.

Every response is stored verbatim under data/raw/horizons/ with its sha256 and the exact query URL in the
download ledger, so a value derived from it can always be traced back to the request that produced it.

Horizons documentation: https://ssd-api.jpl.nasa.gov/doc/horizons.html
"""

from __future__ import annotations

import datetime as _dt
import re
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import requests

from . import download
from .paths import RAW

API_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
J2000_JD = 2451545.0          # JD of the SPICE/TDB epoch J2000 (2000-01-01T12:00:00 TDB)
SECONDS_PER_DAY = 86400.0
POLITE_PAUSE_S = 1.5          # between live requests (Horizons asks for sequential, modest use)

CITATION = ("Giorgini, J. D., Yeomans, D. K., Chamberlin, A. B., Chodas, P. W., Jacobson, R. A., Keesey, M. S., "
            "Lieske, J. H., Ostro, S. J., Standish, E. M., Wimberly, R. N. (1996). JPL's On-Line Solar System Data "
            "Service. Bulletin of the American Astronomical Society 28(3), 1158. JPL Horizons API: "
            "https://ssd-api.jpl.nasa.gov/doc/horizons.html")


def et_to_tdb_calendar(et: float) -> str:
    """'YYYY-MM-DD HH:MM:SS.fff' TDB calendar string for ET (TDB is uniform, so plain day arithmetic applies)."""
    t = _dt.datetime(2000, 1, 1, 12, 0, 0) + _dt.timedelta(seconds=et)
    return t.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def et_to_jd(et: float) -> float:
    return J2000_JD + et / SECONDS_PER_DAY


def jd_to_et(jd: np.ndarray | float) -> np.ndarray:
    return (np.asarray(jd, dtype=np.float64) - J2000_JD) * SECONDS_PER_DAY


def vector_params(target: str, center: str, *, start: str | None = None, stop: str | None = None,
                  step: str | None = None, tlist: list[str] | None = None, corr: str = "NONE") -> dict[str, str]:
    """Parameters for an ICRF, km, km/s, TDB state-vector table (VEC_TABLE=2, CSV)."""
    p = {
        "format": "text",
        "COMMAND": f"'{target}'",
        "OBJ_DATA": "'NO'",
        "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'VECTORS'",
        "CENTER": f"'{center}'",
        "TIME_TYPE": "'TDB'",
        "REF_SYSTEM": "'ICRF'",
        "REF_PLANE": "'FRAME'",
        "OUT_UNITS": "'KM-S'",
        "VEC_TABLE": "'2'",
        "VEC_CORR": f"'{corr}'",
        "VEC_LABELS": "'NO'",
        "CSV_FORMAT": "'YES'",
    }
    if tlist is not None:
        p["TLIST_TYPE"] = "'JD'"
        p["TLIST"] = " ".join(f"'{t}'" for t in tlist)
    else:
        p["START_TIME"] = f"'{start}'"
        p["STOP_TIME"] = f"'{stop}'"
        p["STEP_SIZE"] = f"'{step}'"
    return p


def query_url(params: dict[str, str]) -> str:
    """The exact GET URL requests will send for these params."""
    return requests.Request("GET", API_URL, params=params).prepare().url


@dataclass
class VectorTable:
    jd_tdb: np.ndarray        # (N,)
    states: np.ndarray        # (N, 6) km, km/s
    target_line: str          # e.g. "Target body name: Jupiter (599)   {source: jup365_merged}"
    center_line: str
    output_type: str          # e.g. "GEOMETRIC cartesian states"
    rows: list[str]           # verbatim CSV rows between $$SOE and $$EOE

    @property
    def et(self) -> np.ndarray:
        return jd_to_et(self.jd_tdb)

    @property
    def target_source(self) -> str | None:
        m = re.search(r"\{source:\s*([^}]+)\}", self.target_line)
        return m.group(1).strip() if m else None


def parse_vectors(text: str) -> VectorTable:
    if "$$SOE" not in text or "$$EOE" not in text:
        raise ValueError("Horizons response has no $$SOE/$$EOE block:\n" + text[:2000])
    body = text.split("$$SOE", 1)[1].split("$$EOE", 1)[0]
    rows = [r.strip() for r in body.strip().splitlines() if r.strip()]
    jd, st = [], []
    for r in rows:
        f = [x.strip() for x in r.split(",")]
        jd.append(float(f[0]))
        st.append([float(x) for x in f[2:8]])

    def line(prefix: str) -> str:
        for ln in text.splitlines():
            if ln.startswith(prefix):
                return re.sub(r"\s+", " ", ln).strip()
        return ""

    return VectorTable(np.array(jd), np.array(st), line("Target body name"), line("Center body name"),
                       line("Output type").split(":", 1)[-1].strip(), rows)


def fetch_vectors(params: dict[str, str], subdir: str, name: str) -> tuple[Path, VectorTable]:
    """Download (once) and parse a vector table. An error response is removed from the cache and raised."""
    dest = RAW / subdir / name
    live = not dest.exists()
    path = download.fetch(API_URL, subdir, name, params=params)
    if live:
        time.sleep(POLITE_PAUSE_S)
    text = path.read_text(encoding="utf-8")
    try:
        table = parse_vectors(text)
    except ValueError:
        _forget(path)
        raise
    return path, table


def _forget(path: Path) -> None:
    """Drop a bad download so the next build retries it (uses the ledger helpers of download.py)."""
    download.update_ledger(download.ledger_key(path), None)
    path.unlink(missing_ok=True)
