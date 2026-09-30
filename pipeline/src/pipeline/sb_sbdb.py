"""JPL Small-Body Database (SBDB) downloads for the `smallbodies` stage: bulk orbits, physical parameters and the
non-gravitational model constants of every object that has them.

Every request goes through `download.fetch` (sha256 + URL in the download ledger). Requests are strictly
sequential with a pause between live requests, as the JPL SSD API fair-use policy asks
(https://ssd-api.jpl.nasa.gov/, "one request at a time"). Set the environment variable PIPELINE_CONTACT to an
e-mail address or URL to include it in the User-Agent (JPL asks for a contact; none is sent unless configured).

Snapshots: one download of the whole database is a *snapshot* under data/raw/sbdb/<YYYY-MM-DD>/. The newest
complete snapshot is reused by later builds; SB_SNAPSHOT=new forces a fresh one (dated today), SB_SNAPSHOT=<date>
selects an existing one. The query API is paged (sort=spkid, limit/limit-from); the database can change between
pages, so the pages are de-duplicated on spkid and the count is re-checked at the end (see `load_orbits`).
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

from . import download
from .paths import RAW
from .schema import BuildContext, SourceRecord

QUERY_URL = "https://ssd-api.jpl.nasa.gov/sbdb_query.api"
OBJECT_URL = "https://ssd-api.jpl.nasa.gov/sbdb.api"
PAGE = 50000
PAUSE_S = 1.0          # between live bulk pages
PAUSE_OBJECT_S = 0.4   # between live single-object requests

ORBIT_FIELDS = [
    "spkid", "full_name", "pdes", "name", "prefix", "kind", "class", "neo", "pha",
    "orbit_id", "epoch", "equinox", "e", "a", "q", "i", "om", "w", "ma", "tp",
    "condition_code", "data_arc", "n_obs_used", "two_body", "source", "pe_used",
    "H", "G", "H_sigma", "A1", "A2", "A3", "DT", "S0", "M1", "K1", "M2", "K2", "PC",
]
PHYS_FIELDS = [
    "spkid", "diameter", "diameter_sigma", "extent", "GM", "density", "rot_per", "pole", "albedo",
    "BV", "UB", "IR", "spec_T", "spec_B",
]
PHYS_CONSTRAINT = {"OR": [f"{f}|DF" for f in PHYS_FIELDS[1:]]}
NONGRAV_FIELDS = ("A1", "A2", "A3", "DT", "S0")
CURRENT_PE = "DE441"   # planetary ephemeris of the current JPL orbit solutions (SBDB pe_used)

CITATION = ("JPL Small-Body Database (SBDB), Solar System Dynamics Group, Jet Propulsion Laboratory, California "
            "Institute of Technology; SBDB Query API v1.0 (https://ssd-api.jpl.nasa.gov/doc/sbdb_query.html) and "
            "SBDB API (https://ssd-api.jpl.nasa.gov/doc/sbdb.html). Orbit determination: Giorgini, J. D. et al. "
            "(1996), JPL's On-Line Solar System Data Service, BAAS 28(3), 1158; per-object orbit solutions by "
            "their listed producers (JPL, or the MPC for orbits JPL copies from the MPC files).")
LICENSE = "JPL/NASA public data (U.S. Government work); see https://ssd-api.jpl.nasa.gov/ (fair-use policy)"


def user_agent() -> str:
    contact = os.environ.get("PIPELINE_CONTACT", "").strip()
    return "space-thing-pipeline/0.1 (solar-system simulator data build)" + (f" contact: {contact}" if contact else "")


def _headers() -> dict:
    return {"User-Agent": user_agent()}


# ---------------------------------------------------------------------------------------------- snapshots
def _snapshots() -> list[str]:
    root = RAW / "sbdb"
    if not root.exists():
        return []
    return sorted(p.name for p in root.iterdir() if p.is_dir() and (p / "complete.json").exists())


def snapshot_tag() -> str:
    want = os.environ.get("SB_SNAPSHOT", "").strip()
    if want == "new":
        return _dt.date.today().isoformat()
    if want:
        return want
    done = _snapshots()
    return done[-1] if done else _dt.date.today().isoformat()


@dataclass
class Snapshot:
    tag: str
    orbit_pages: list[Path]
    phys_pages: list[Path]
    nongrav: dict[int, Path]       # spkid -> sbdb.api JSON

    @property
    def dir(self) -> Path:
        return RAW / "sbdb" / self.tag


def _fetch_live(url: str, subdir: str, name: str, params: dict, pause: float) -> Path:
    dest = RAW / subdir / name
    live = not dest.exists()
    p = download.fetch(url, subdir, name, params=params, headers=_headers(), timeout=600.0)
    if live:
        time.sleep(pause)
    return p


def _paged(subdir: str, stem: str, fields: list[str], extra: dict | None = None) -> list[Path]:
    pages: list[Path] = []
    total = None
    k = 0
    while total is None or k * PAGE < total:
        params = {"fields": ",".join(fields), "full-prec": "1", "sort": "spkid", "limit": str(PAGE),
                  "limit-from": str(k * PAGE)}
        if extra:
            params.update(extra)
        p = _fetch_live(QUERY_URL, subdir, f"{stem}_{k:03d}.json", params, PAUSE_S)
        d = json.loads(p.read_text(encoding="utf-8"))
        if d.get("fields") != fields:
            raise ValueError(f"{p.name}: unexpected fields {d.get('fields')}")
        total = int(d["count"])
        pages.append(p)
        if k == 0 or (RAW / subdir / f"{stem}_{k:03d}.json").stat().st_mtime > time.time() - 60:
            print(f"[smallbodies] SBDB {stem} page {k}: {len(d['data'])} rows (count {total})")
        k += 1
    return pages


def fetch_snapshot(tag: str | None = None) -> Snapshot:
    tag = tag or snapshot_tag()
    subdir = f"sbdb/{tag}"
    orbit_pages = _paged(subdir, "orbits", ORBIT_FIELDS)
    phys_pages = _paged(subdir, "phys", PHYS_FIELDS, {"sb-cdata": json.dumps(PHYS_CONSTRAINT, separators=(",", ":"))})
    # Non-gravitational model constants (ALN, NM, NN, NK, R0 ...) are only in the single-object API.
    # Also every orbit solved against a planetary ephemeris other than the current one (old or special solutions,
    # e.g. Bennu's): their model_pars may hold terms the propagator does not model.
    ng_ids: list[int] = []
    for p in orbit_pages:
        d = json.loads(p.read_text(encoding="utf-8"))
        idx = [d["fields"].index(f) for f in NONGRAV_FIELDS]
        ipe = d["fields"].index("pe_used")
        for row in d["data"]:
            if any(row[i] is not None for i in idx) or row[ipe] not in (None, CURRENT_PE):
                ng_ids.append(int(row[0]))
    nongrav: dict[int, Path] = {}
    for n, spk in enumerate(sorted(set(ng_ids))):
        nongrav[spk] = _fetch_live(OBJECT_URL, f"{subdir}/nongrav", f"{spk}.json",
                                   {"spk": str(spk), "full-prec": "1"}, PAUSE_OBJECT_S)
        if n % 500 == 0:
            print(f"[smallbodies] SBDB non-grav model parameters {n}/{len(set(ng_ids))}")
    snap = Snapshot(tag, orbit_pages, phys_pages, nongrav)
    done = snap.dir / "complete.json"
    if not done.exists():
        done.write_text(json.dumps({"completed": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
                                    "orbitPages": len(orbit_pages), "physPages": len(phys_pages),
                                    "nongrav": len(nongrav)}, indent=1), encoding="utf-8", newline="\n")
    return snap


def combined_sha256(paths: list[Path]) -> str:
    """SHA-256 over the newline-joined per-file sha256 values, in order (one fingerprint for a paged download)."""
    h = hashlib.sha256()
    for p in paths:
        h.update((download.record(p)["sha256"] + "\n").encode())
    return h.hexdigest()


def register(ctx: BuildContext, snap: Snapshot) -> dict[str, str]:
    first = download.record(snap.orbit_pages[0])
    ids = {}
    ids["orbits"] = ctx.add_source(SourceRecord(
        id="jpl-sbdb-orbits",
        title="JPL SBDB osculating orbital elements of all asteroids and comets (full precision)",
        citation=CITATION,
        url=QUERY_URL + "?fields=" + ",".join(ORBIT_FIELDS) + "&full-prec=1&sort=spkid&limit=50000&limit-from=<k*50000>",
        retrieved=first["retrieved"], sha256=combined_sha256(snap.orbit_pages),
        version=f"snapshot {snap.tag} ({len(snap.orbit_pages)} pages)", license=LICENSE,
        notes="Heliocentric osculating elements referred to the IAU76/80 ecliptic and equinox J2000, epochs in TDB; "
              "the orbit_id of each object's solution is kept per object. sha256 is SHA-256 over the per-page "
              f"sha256 values (one per line, page order); pages are in data/raw/sbdb/{snap.tag}/.",
    ))
    pr = download.record(snap.phys_pages[0])
    ids["phys"] = ctx.add_source(SourceRecord(
        id="jpl-sbdb-physical",
        title="JPL SBDB physical parameters (diameter, albedo, rotation period, colours, taxonomy)",
        citation=CITATION + " SBDB physical parameters are compilations of published measurements; the reference "
                            "for each value is listed per object by the SBDB API (phys_par[].ref).",
        url=QUERY_URL + "?fields=" + ",".join(PHYS_FIELDS) + "&full-prec=1&sb-cdata=" + json.dumps(PHYS_CONSTRAINT),
        retrieved=pr["retrieved"], sha256=combined_sha256(snap.phys_pages),
        version=f"snapshot {snap.tag}", license=LICENSE,
        notes="Only objects with at least one of these fields defined. sha256 as for jpl-sbdb-orbits.",
    ))
    if snap.nongrav:
        paths = [snap.nongrav[k] for k in sorted(snap.nongrav)]
        nr = download.record(paths[0])
        ids["nongrav"] = ctx.add_source(SourceRecord(
            id="jpl-sbdb-nongrav",
            title="JPL SBDB non-gravitational model parameters (A1, A2, A3, DT and model constants) per object",
            citation=CITATION + " Model: Marsden, B. G., Sekanina, Z. & Yeomans, D. K. (1973), Comets and "
                                "nongravitational forces. V, AJ 78, 211, DOI:10.1086/111402; delay DT: Yeomans, D. K. "
                                "& Chodas, P. W. (1989), AJ 98, 1083, DOI:10.1086/115201.",
            url=OBJECT_URL + "?spk=<spkid>&full-prec=1", retrieved=nr["retrieved"],
            sha256=combined_sha256(paths), version=f"snapshot {snap.tag} ({len(paths)} objects)", license=LICENSE,
            notes="One sbdb.api response per object whose orbit uses non-gravitational parameters; model_pars "
                  "carries the g(r) constants (ALN, R0, NM, NN, NK) where they differ from the Marsden defaults.",
        ))
    return ids
