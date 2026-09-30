"""Downloads, SourceRecords and readers of the `comets` stage (coma and tails as they would look).

Datasets (parsed):
  * lowell-comet-db-1995: A'Hearn et al. (1995) Lowell narrowband photometry of 85 comets, 1976-1992 (PDS SBN):
    per observation log Q(OH), Q(CN), Q(C2), Q(C3) and log A(theta)f rho in the blue continuum -> per-comet and
    population gas-to-gas and dust-to-gas ratios.
  * mcdonald-faint-comet-survey: Cochran et al. (1992) McDonald spectrophotometry (PDS SBN): flux-calibrated band
    fluxes of CN, C3, CH, C2 (Delta v = +1 and 0) and NH2 (0,10,0) at the same place in the coma -> measured band
    strengths of C2 (Delta v = +1) and CH relative to C2 (Delta v = 0); the dataset description lists the bands'
    wavelength windows. (The NH2 column holds positive logarithms, inconsistent with its unit: not used.)
  * lowell-comet-tools: fluorescence efficiencies (L/N) and Haser scale lengths served by Lowell Observatory's comet
    tools (A'Hearn et al. 1995 values; CN after Schleicher 2010; NH after Meier et al. 1998).
  * schleicher-2010-dust-phase: Schleicher's composite dust phase function (Lowell Observatory table).
  * omni2-2024: NASA OMNI hourly solar-wind speed at 1 au (2024) -> the median solar-wind speed for the ion tail's
    aberration.
Papers (numbers transcribed into comet_tables/activity.json, PDFs kept with their sha256): Jorda et al. (2008),
Jewitt (2015), Bhardwaj & Raghuram (2012), Agarwal et al. (2007), Moreno & Jehin (2025), Rousselot et al. (2024),
Cochran et al. (2015), Opitom et al. (2024, the Haser convention v = 1 km/s).
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

from . import download
from .photometry.common import Download
from .sb_sbdb import combined_sha256
from .schema import BuildContext, SourceRecord

TABLES = Path(__file__).parent / "comet_tables"
SUBDIR = "comets"
_ARXIV = "arXiv.org e-print (author manuscript); the published version is cited."

# ---------------------------------------------------------------------------------------------- datasets
LOWELL_DB_URL = "https://pdssbn.astro.umd.edu/holdings/ear-c-phot-3-rdr-lowell-comet-db-v1.0/data/"
LOWELL_DB_FILES = ("locdprod.tab", "locdprod.lbl")
LOWELL_DB_CITATION = (
    "A'Hearn, M. F., Millis, R. L., Schleicher, D. G., Osip, D. J. & Birch, P. V. (1995). The ensemble properties "
    "of comets: results from narrowband photometry of 85 comets, 1976-1992. Icarus 118, 223-270. "
    "DOI:10.1006/icar.1995.1190. Data: Osip, D. J. (ed.), Lowell Observatory Cometary Database, "
    "EAR-C-PHOT-3-RDR-LOWELL-COMET-DB-V1.0, NASA Planetary Data System (Small Bodies Node).")

MCDONALD_URL = "https://pdssbn.astro.umd.edu/holdings/pds4-gbo-mcdonald:faint_comet_survey-v1.0/"
MCDONALD_FILES = ("data/fluxmc.tab", "data/fluxmc.xml", "description.txt")
MCDONALD_CITATION = (
    "Cochran, A. L., Barker, E. S., Ramseyer, T. F. & Storrs, A. D. (1992). The McDonald Observatory faint comet "
    "survey: gas production in 17 comets. Icarus 98, 151-162. DOI:10.1016/0019-1035(92)90088-2. Data: Cochran, A. "
    "L., Barker, E. S., Ramseyer, T. F. & Storrs, A. D., McDonald Observatory Faint Comet Spectro-Photometric Survey "
    "(PDS4 Format), Tholen, D. (ed.), urn:nasa:pds:gbo-mcdonald:faint_comet_survey::1.0, NASA Planetary Data System, "
    "2019.")

LOWELL_TOOLS_URL = "https://asteroid.lowell.edu/api/comet/calc/"
# Fluorescence efficiencies at r = 1 au for a range of heliocentric radial velocities (CN and NH vary with it, the
# Swings effect), and at v = 0 for a range of r (NH and CN also vary with r beyond the r^-2 scaling).
GFACTOR_GRID = tuple((1.0, v) for v in (-40.0, -20.0, 0.0, 20.0, 40.0)) + ((0.5, 0.0), (2.0, 0.0))
LOWELL_TOOLS_CITATION = (
    "Lowell Observatory Minor Planet Services, comet tools (https://asteroid.lowell.edu/comet/): fluorescence "
    "efficiencies and Haser scale lengths as used by A'Hearn et al. (1995), Icarus 118, 223-270, "
    "DOI:10.1006/icar.1995.1190; CN: Schleicher, D. G. (2010), AJ 140, 973, DOI:10.1088/0004-6256/140/4/973; NH: "
    "Meier, R. et al. (1998), Icarus 136, 268; OH: Schleicher, D. G. & A'Hearn, M. F. (1988), ApJ 331, 1058; OH "
    "scale lengths: Cochran, A. L. & Schleicher, D. G. (1993), Icarus 105, 235; other scale lengths: Randall, C. E. "
    "et al. (1992), BAAS 24, 1002.")

DUST_PHASE = Download(
    id="schleicher-2010-dust-phase",
    url="https://asteroid.lowell.edu/static/comet/dustphaseHM_table.txt", subdir=SUBDIR, name="dustphaseHM_table.txt",
    title="Composite dust phase function for comets (Schleicher, 2010 May; tabulated 0-180 deg)",
    citation="Schleicher, D. G. (2010). Composite dust phase function for comets (Lowell Observatory web table, 2010 "
             "May): the Halley curve of Schleicher, D. G., Millis, R. L. & Birch, P. V. (1998), Icarus 132, 397 "
             "(DOI:10.1006/icar.1997.5902) at small phase angles spliced with the Henyey-Greenstein curve of Marcus, "
             "J. N. (2007), International Comet Quarterly 29, 39 and 119, at large phase angles.",
    version="2010 May", license="Public web table (Lowell Observatory)",
    notes="Columns: phase angle (deg), phase function normalized at 0 deg, normalized at 90 deg.")

OMNI = Download(
    id="omni2-2024",
    url="https://spdf.gsfc.nasa.gov/pub/data/omni/low_res_omni/omni2_2024.dat", subdir=SUBDIR, name="omni2_2024.dat",
    title="NASA OMNI 2 hourly near-Earth solar-wind data, 2024",
    citation="King, J. H. & Papitashvili, N. E. (2005). Solar wind spatial scales in and comparisons of hourly Wind "
             "and ACE plasma and magnetic field data. JGR 110, A02104, DOI:10.1029/2004JA010649. OMNI 2 data from "
             "NASA/GSFC Space Physics Data Facility (https://omniweb.gsfc.nasa.gov/).",
    version="2024 file", license="NASA open data",
    notes="Fixed-format ASCII, one record per hour; word 25 = plasma flow speed (km/s), fill 9999 (omni2.text).")
OMNI_FORMAT = Download(
    id="omni2-format", url="https://spdf.gsfc.nasa.gov/pub/data/omni/low_res_omni/omni2.text", subdir=SUBDIR,
    name="omni2.text", title="OMNI 2 hourly data format description", citation=OMNI.citation)

# ---------------------------------------------------------------------------------------------- papers
_P = "papers"
JORDA = Download(
    id="jorda-2008", url="https://www.lpi.usra.edu/meetings/acm2008/pdf/8046.pdf", subdir=_P, name="acm2008-8046.pdf",
    title="Jorda, Crovisier & Green (2008): correlation between visual magnitudes and water production rates",
    citation="Jorda, L., Crovisier, J. & Green, D. W. E. (2008). The correlation between visual magnitudes and water "
             "production rates. Asteroids, Comets, Meteors 2008, LPI Contribution No. 1405, paper 8046.")
JEWITT = Download(
    id="jewitt-2015-colors", url="https://arxiv.org/pdf/1510.07069v1", subdir=_P, name="arXiv-1510.07069v1.pdf",
    title="Jewitt (2015): colour systematics of comets and related bodies (mean coma colours)",
    citation="Jewitt, D. (2015). Color systematics of comets and related bodies. Astronomical Journal 150, 201. "
             "DOI:10.1088/0004-6256/150/6/201 (arXiv:1510.07069).", notes=_ARXIV)
BHARDWAJ = Download(
    id="bhardwaj-raghuram-2012", url="https://arxiv.org/pdf/1211.5008v1", subdir=_P, name="arXiv-1211.5008v1.pdf",
    title="Bhardwaj & Raghuram (2012): atomic oxygen visible line emissions in comet Hale-Bopp (yields, branching)",
    citation="Bhardwaj, A. & Raghuram, S. (2012). A coupled chemistry-emission model for atomic oxygen green and red-"
             "doublet emissions in the comet C/1995 O1 Hale-Bopp. Astrophysical Journal 748, 13. "
             "DOI:10.1088/0004-637X/748/1/13 (arXiv:1211.5008).", notes=_ARXIV)
AGARWAL = Download(
    id="agarwal-2007-dust", url="https://arxiv.org/pdf/1001.3010v1", subdir=_P, name="arXiv-1001.3010v1.pdf",
    title="Agarwal, Mueller & Gruen (2007): dust environment modelling (beta, size distributions, syndynes)",
    citation="Agarwal, J., Mueller, M. & Gruen, E. (2007). Dust environment modelling of comet 67P/Churyumov-"
             "Gerasimenko. Space Science Reviews 128, 79-131. DOI:10.1007/s11214-006-9139-2 (arXiv:1001.3010).",
    notes=_ARXIV)
MORENO = Download(
    id="moreno-jehin-2025", url="https://arxiv.org/pdf/2503.10121v1", subdir=_P, name="arXiv-2503.10121v1.pdf",
    title="Moreno & Jehin (2025): Monte Carlo dust-tail models of long-period comets (ejection speeds)",
    citation="Moreno, F. & Jehin, E. (2025). Dust shells and dark linear structures on dust tails of historical and "
             "recent long-period comets. Astronomy & Astrophysics (arXiv:2503.10121).", notes=_ARXIV)
ROUSSELOT = Download(
    id="rousselot-2024-coplus", url="https://arxiv.org/pdf/2311.05700v1", subdir=_P, name="arXiv-2311.05700v1.pdf",
    title="Rousselot et al. (2024): CO+ fluorescence efficiencies (comet-tail system, r = 1 au)",
    citation="Rousselot, P., Jehin, E., Hutsemekers, D., Opitom, C., Manfroid, J. & Hardy, P. (2024). 12CO+ and 13CO+ "
             "fluorescence models for measuring the 12C/13C isotopic ratio in comets. Astronomy & Astrophysics 683, "
             "A25. DOI:10.1051/0004-6361/202348027 (arXiv:2311.05700).", notes=_ARXIV)
COCHRAN = Download(
    id="cochran-2015-composition", url="https://arxiv.org/pdf/1507.00761v1", subdir=_P, name="arXiv-1507.00761v1.pdf",
    title="Cochran et al. (2015): the composition of comets (measured CO/H2O range)",
    citation="Cochran, A. L., Levasseur-Regourd, A.-C., Cordiner, M. et al. (2015). The composition of comets. Space "
             "Science Reviews 197, 9-46. DOI:10.1007/s11214-015-0183-6 (arXiv:1507.00761).", notes=_ARXIV)
OPITOM = Download(
    id="opitom-2024-12p", url="https://arxiv.org/pdf/2409.08133v1", subdir=_P, name="arXiv-2409.08133v1.pdf",
    title="Coma composition of 12P/Pons-Brooks (states the Haser convention v = 1 km/s with Lowell g-factors)",
    citation="Ferellec, L., Opitom, C., Donaldson, A. et al. (2024). Coma composition and profiles of comet "
             "12P/Pons-Brooks using long-slit spectroscopy. Monthly Notices of the Royal Astronomical Society "
             "(arXiv:2409.08133).", notes=_ARXIV)

PAPERS = (JORDA, JEWITT, BHARDWAJ, AGARWAL, MORENO, ROUSSELOT, COCHRAN, OPITOM)
SINGLE = (DUST_PHASE, OMNI, OMNI_FORMAT)


def lowell_db_paths() -> list[Path]:
    return [download.fetch(LOWELL_DB_URL + f, SUBDIR + "/lowell-db", f) for f in LOWELL_DB_FILES]


def mcdonald_paths() -> list[Path]:
    return [download.fetch(MCDONALD_URL + f, SUBDIR + "/mcdonald", f.split("/")[-1]) for f in MCDONALD_FILES]


def gfactor_paths() -> list[Path]:
    out = []
    for r, v in GFACTOR_GRID:
        out.append(download.fetch(LOWELL_TOOLS_URL + "gfactor", SUBDIR + "/lowell-tools", f"gfactor_r{r:g}_v{v:+g}.json",
                                  params={"r": f"{r:g}", "v": f"{v:g}"}))
        time.sleep(0.5)
    return out


def haser_path() -> Path:
    return download.fetch(LOWELL_TOOLS_URL + "haser", SUBDIR + "/lowell-tools", "haser_r1_d1_ap10.json",
                          params={"r": "1", "d": "1", "ap": "10"})


def _multi(id_: str, title: str, citation: str, url: str, paths: list[Path], version: str, notes: str,
           license_: str = "NASA Planetary Data System (public)") -> SourceRecord:
    first = download.record(paths[0])
    return SourceRecord(id=id_, title=title, citation=citation, url=url, retrieved=first["retrieved"],
                        sha256=combined_sha256(paths), version=version, license=license_,
                        notes=notes + " sha256 is SHA-256 over the per-file sha256 values (one per line, file order).")


def register(ctx: BuildContext) -> dict[str, str]:
    """Fetch everything and add the SourceRecords; returns {logical name: source id}."""
    ids: dict[str, str] = {}
    ids["lowell"] = ctx.add_source(_multi(
        "lowell-comet-db-1995", "Lowell Observatory comet database: production rates and A(theta)f rho of 85 comets "
        "(A'Hearn et al. 1995)", LOWELL_DB_CITATION, LOWELL_DB_URL + "locdprod.tab", lowell_db_paths(), "V1.0",
        "Files " + ", ".join(LOWELL_DB_FILES) + " (810 observations, fixed-width ASCII; the .lbl gives the columns)."))
    ids["mcdonald"] = ctx.add_source(_multi(
        "mcdonald-faint-comet-survey", "McDonald Observatory faint comet survey: band fluxes of CN, C3, CH, C2 and NH2 "
        "(Cochran et al. 1992)", MCDONALD_CITATION, MCDONALD_URL + "data/fluxmc.tab", mcdonald_paths(), "PDS4 1.0",
        "Files " + ", ".join(MCDONALD_FILES) + "; description.txt lists the band windows and the fluorescence "
        "efficiencies of Cochran et al. (1992)."))
    paths = gfactor_paths() + [haser_path()]
    ids["lowellTools"] = ctx.add_source(_multi(
        "lowell-comet-tools", "Fluorescence efficiencies (L/N) and Haser scale lengths of OH, NH, CN, C3, C2 (Lowell "
        "Observatory comet tools API)", LOWELL_TOOLS_CITATION, LOWELL_TOOLS_URL + "gfactor?r=<r>&v=<v>",
        paths, "retrieved 2026-09-30",
        "JSON responses: g-factors at (r, v) = " + ", ".join(f"({r:g} au, {v:+g} km/s)" for r, v in GFACTOR_GRID)
        + "; Haser scale lengths at r = 1 au (haser?r=1&d=1&ap=10).", license_="Public web service (Lowell Observatory)"))
    for d in (*SINGLE, *PAPERS):
        ids[d.id] = ctx.add_source(d.source())
    return ids


def tables() -> dict:
    return json.loads((TABLES / "activity.json").read_text())


# ---------------------------------------------------------------------------------------------- readers
def _pds3_columns(lbl: Path) -> list[tuple[str, int, int]]:
    """(name, start byte (1-based), bytes) of every COLUMN object in a PDS3 label."""
    cols, cur = [], {}
    for line in lbl.read_text(errors="replace").splitlines():
        s = line.strip()
        if s.startswith("END_OBJECT") and s.endswith("COLUMN"):
            if cur:
                cols.append((cur["NAME"], int(cur["START_BYTE"]), int(cur["BYTES"])))
            cur = {}
        elif s.startswith("OBJECT") and s.endswith("COLUMN"):
            cur = {}
        elif "=" in s:
            k, v = (x.strip() for x in s.split("=", 1))
            if k in ("NAME", "START_BYTE", "BYTES"):
                cur[k] = v.strip('"')
    return cols


def read_lowell_db() -> list[dict]:
    """Observations of the Lowell database: comet id (periodic number/type/name/IAU designation), r, Delta and the
    log production rates / log Afrho (None where not measured)."""
    tab, lbl = lowell_db_paths()
    cols = _pds3_columns(lbl)
    out = []
    for line in tab.read_text(errors="replace").splitlines():
        if not line.strip():
            continue
        rec = {}
        for name, start, n in cols:
            raw = line[start - 1:start - 1 + n].strip()
            rec[name] = raw
        num = rec.get("PERIODIC_NUMBER", "")
        row = {"periodic": int(num) if num.isdigit() else None, "type": rec.get("COMET_TYPE", ""),
               "name": rec.get("COMET_NAME", ""), "iau": rec.get("IAU_DESIGNATION", ""),
               "year": int(rec["OBSERVATION_YEAR"]), "r": float(rec["R_HELIO"]), "delta": float(rec["DELTA"])}
        for k in ("LOG_Q_OH", "LOG_Q_NH", "LOG_Q_CN", "LOG_Q_C3", "LOG_Q_C2", "LOG_AFRHO_UV_CONT", "LOG_AFRHO_B_CONT"):
            v = rec.get(k, "")
            try:
                f = float(v)
                row[k] = f if 0.0 < f < 90.0 else None  # 99.99 = not measured
            except ValueError:
                row[k] = None
        out.append(row)
    return out


def read_mcdonald() -> dict:
    """Band fluxes (log erg cm^-2 s^-1) at their aperture offsets: rows of {comet, date, bands: {band: (ew, ns,
    logF)}}; plus the band windows and log L/N constants parsed from description.txt."""
    tab, xml, desc = mcdonald_paths()
    import re
    x = xml.read_text()
    fields = []
    for m in re.finditer(r"<Field_Character>(.*?)</Field_Character>", x, re.S):
        b = m.group(1)
        name = re.search(r"<name>(.*?)</name>", b, re.S).group(1).strip()
        loc = int(re.search(r"<field_location[^>]*>(\d+)</field_location>", b).group(1))
        ln = int(re.search(r"<field_length[^>]*>(\d+)</field_length>", b).group(1))
        fields.append((name, loc, ln))
    bands = {"CN(0)": "CN(0)", "C3": "C3", "CH": "CH", "C2(1)": "C2(1)", "C2(0)": "C2(0)", "NH2": "NH2"}
    rows = []
    for line in tab.read_text(errors="replace").splitlines():
        if not line.strip():
            continue
        vals = {n: line[s - 1:s - 1 + ln].strip() for n, s, ln in fields}
        rec = {"comet": vals["Comet Name"], "date": f"{vals['Year']}-{vals['Month']}-{vals['Day']}", "bands": {}}
        for b in bands:
            ew, ns = vals.get(f"{b} EW Offset", ""), vals.get(f"{b} NS Offset", "")
            fl = vals.get(f"Log {b}") or vals.get(f"Log Flux {b}")
            try:
                f, e, n = float(fl), float(ew), float(ns)
            except (TypeError, ValueError):
                continue
            if f >= 1e31 or e >= 999999 or n >= 999999:
                continue
            rec["bands"][b] = (e, n, f)
        rows.append(rec)
    text = desc.read_text(errors="replace")
    windows = {}
    for m in re.finditer(r"^(CN \(delta NU = 0\)|C3|CH|C2 \(delta NU = 1\)|C2 \(delta NU = 0\)|NH2 \(0,10,0\))\s+"
                         r"(\d{4})-(\d{4})\s*$", text, re.M):
        windows[m.group(1)] = (float(m.group(2)), float(m.group(3)))
    consts = {}
    for m in re.finditer(r"^(C3|CH|C2 \(delta NU = 1\)|C2 \(delta NU = 0\)|NH2 \(0,10,0\))\s+(\d+\.\d+)\s*$", text, re.M):
        consts[m.group(1)] = float(m.group(2))
    return {"rows": rows, "windows": windows, "logLN": consts}


def read_gfactors() -> list[dict]:
    """[{r, v, OH, NH, CN, C3, C2}]: L/N normalised to 1 au ('one_AU') at the requested (r, v) of GFACTOR_GRID."""
    out = []
    for (r, v), p in zip(GFACTOR_GRID, gfactor_paths()):
        j = json.loads(p.read_text())
        g = j["gfactor"]["one_AU"]
        out.append({"r": r, "v": v, **{k: float(g[k]) for k in ("OH", "NH", "CN", "C3", "C2")},
                    "extrapolated": bool(j["extrapolated"])})
    return out


def read_haser() -> dict:
    """Parent and daughter Haser scale lengths at 1 au (km) per species."""
    j = json.loads(haser_path().read_text())
    s = j["scalelength"]["one_AU"]
    return {k: {"parent": float(s["parent"][k]), "daughter": float(s["daughter"][k])} for k in s["parent"]}


def read_dust_phase() -> tuple[np.ndarray, np.ndarray]:
    """(phase angle deg, phase function normalized at 0 deg)."""
    a, p = [], []
    for line in DUST_PHASE.fetch().read_text(errors="replace").splitlines():
        parts = line.split()
        if len(parts) == 3:
            try:
                x = [float(t) for t in parts]
            except ValueError:
                continue
            a.append(x[0])
            p.append(x[1])
    return np.array(a), np.array(p)


def read_omni_speed() -> np.ndarray:
    """Hourly solar-wind flow speeds (km/s) of the OMNI 2 file, fill values removed."""
    v = []
    for line in OMNI.fetch().read_text(errors="replace").splitlines():
        w = line.split()
        if len(w) > 25:
            s = float(w[24])
            if s < 9000:
                v.append(s)
    return np.array(v)
