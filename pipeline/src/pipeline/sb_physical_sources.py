"""Physical-property datasets for the `smallbodies` stage (downloads + SourceRecords + parsers).

- NEOWISE Diameters and Albedos V2.0 (PDS SBN): thermal-model diameters and visible geometric albedos, one row per
  fit, with a fit code saying which parameters were fitted.
- Asteroid Lightcurve Database (LCDB), public release: rotation periods with the reliability code U.
- Gaia DR3 Solar System Objects reflectance spectra: 16 bands 374-1034 nm, normalised to 1 at 550 nm.
- MPCORB.DAT (Minor Planet Center): the MPC's orbit uncertainty parameter U, and an independent orbit for a
  cross-check of the JPL elements.
"""

from __future__ import annotations

import csv
import math
import gzip
import io
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .photometry.common import Download

SBN = "https://sbnarchive.psi.edu/pds4/non_mission/"
NEOWISE_FILES = ["neowise_mainbelt.csv", "neowise_neos.csv", "neowise_jupiter_trojans.csv", "neowise_hildas.csv",
                 "neowise_centaurs.csv", "neowise_ambos.csv"]
NEOWISE_CITATION = (
    "Mainzer, A. K., Bauer, J. M., Cutri, R. M., Grav, T., Kramer, E. A., Masiero, J. R., Sonnett, S. & Wright, E. L. "
    "(2019). NEOWISE Diameters and Albedos V2.0. urn:nasa:pds:neowise_diameters_albedos::2.0, NASA Planetary Data "
    "System, DOI:10.26033/18S3-2Z54. Fits from Mainzer et al. (2011), ApJ 743, 156, DOI:10.1088/0004-637X/743/2/156; "
    "Masiero et al. (2011), ApJ 741, 68, DOI:10.1088/0004-637X/741/2/68; Grav et al. (2011, 2012); Masiero et al. "
    "(2012, 2014, 2017); Nugent et al. (2015, 2016) (per-row Reference column; see references.csv in the bundle).")


def neowise_downloads() -> list[Download]:
    return [Download(id="neowise-v2", url=SBN + "neowise_diameters_albedos_V2_0/data/" + f,
                     subdir="neowise_v2", name=f, title="NEOWISE Diameters and Albedos V2.0 (PDS)",
                     citation=NEOWISE_CITATION, version="V2.0 (PDS4 bundle, 2019; files dated 2021-04-15)",
                     license="NASA PDS public data")
            for f in NEOWISE_FILES]


LCDB = Download(
    id="lcdb-2023-10",
    url="https://minplanobs.org/MPInfo/datazips/LCLIST_PUB_CURRENT.zip", subdir="lcdb", name="LCLIST_PUB_CURRENT.zip",
    title="Asteroid Lightcurve Database (LCDB), public release (summary table LC_SUM_PUB)",
    citation="Warner, B. D., Harris, A. W. & Pravec, P. (2009). The asteroid lightcurve database. Icarus 202, 134-146. "
             "DOI:10.1016/j.icarus.2009.02.003. Public release distributed by the Minor Planet Center Lightcurve "
             "Database site (minplanobs.org), file LCLIST_PUB_CURRENT.zip.",
    version="public release of 2023-10-01 (file date)", license="Free for scientific use with citation (LCDB readme)",
    notes="Summary table: one row per object with the adopted period and the reliability code U (3 = unambiguous, "
          "2 = may be wrong by ~30 % or be ambiguous, 1 = may be completely wrong, 0 = later proven wrong; +/- "
          "modifiers).",
)

GAIA_BASE = "https://cdn.gea.esac.esa.int/Gaia/gdr3/Solar_system/sso_reflectance_spectrum/"
GAIA_CITATION = ("Gaia Collaboration, Galluccio, L., Delbo, M., De Angeli, F., et al. (2023). Gaia Data Release 3: "
                 "Reflectance spectra of Solar System small bodies. A&A 674, A35, DOI:10.1051/0004-6361/202243791. "
                 "Gaia Collaboration, Vallenari, A., et al. (2023), Gaia Data Release 3: Summary of the content and "
                 "survey properties, A&A 674, A1, DOI:10.1051/0004-6361/202243940. Table "
                 "gaiadr3.sso_reflectance_spectrum.")


def gaia_downloads() -> list[Download]:
    return [Download(id="gaia-dr3-sso-reflectance", url=GAIA_BASE + f"SsoReflectanceSpectrum_{k:02d}.csv.gz",
                     subdir="gaia_dr3_sso", name=f"SsoReflectanceSpectrum_{k:02d}.csv.gz",
                     title="Gaia DR3 SSO reflectance spectra (gaiadr3.sso_reflectance_spectrum)",
                     citation=GAIA_CITATION, version="Gaia DR3 (2022-06-13)",
                     license="CC BY-NC 3.0 IGO (ESA/Gaia/DPAC)")
            for k in range(20)]


SSOBFT = Download(
    id="ssodnet-ssobft",
    url="https://ssp.imcce.fr/data/ssoBFT-latest_Asteroid.parquet", subdir="ssodnet", name="ssoBFT-latest_Asteroid.parquet",
    title="SsODNet ssoBFT: best-estimate physical properties of asteroids (Parquet, IMCCE)",
    citation="Berthier, J., Carry, B., Mahlke, M. & Normand, J. (2023). SsODNet: Solar system Open Database Network. "
             "A&A 671, A151. DOI:10.1051/0004-6361/202244878. Phase functions: Mahlke, M., Carry, B. & Denneau, L. "
             "(2021), Icarus 354, 114094, DOI:10.1016/j.icarus.2020.114094 (ATLAS) and later SsODNet compilations "
             "(per-row facility); H, G1, G2 system: Muinonen, K. et al. (2010), Icarus 209, 542, "
             "DOI:10.1016/j.icarus.2010.04.003. Spins: compilation incl. DAMIT (Durech et al. 2010, A&A 513, A46) and "
             "Gaia DR3 inversions (Durech & Hanus 2023, A&A 675, A24). Taxonomy: Mahlke, Carry & Mattei (2022), A&A 665, "
             "A26, DOI:10.1051/0004-6361/202243587, and earlier schemes (per-row scheme).",
    version="ssoBFT-latest, file dated 2026-09-22 (IMCCE updates it weekly)",
    license="SsODNet data policy: free use with citation of Berthier et al. (2023)",
    notes="Only the phase_functions, spins and taxonomy columns are read (pyarrow). The flat table gives per-value "
          "errors, facility/technique and filter, but not the bibcode of each value; the per-value reference is in "
          "the SsODNet ssoCard of the object.",
)

MPCORB = Download(
    id="mpc-mpcorb",
    url="https://minorplanetcenter.net/iau/MPCORB/MPCORB.DAT.gz", subdir="mpc", name="MPCORB.DAT.gz",
    title="MPCORB.DAT: Minor Planet Center orbit database (all numbered and unnumbered minor planets)",
    citation="Minor Planet Center, Smithsonian Astrophysical Observatory / International Astronomical Union. MPCORB.DAT "
             "orbit file, format described at https://minorplanetcenter.net/iau/info/MPOrbitFormat.html; "
             "uncertainty parameter U: https://www.minorplanetcenter.net/iau/info/UValue.html.",
    license="MPC data; the MPCORB header's terms of use apply (acknowledge the MPC)",
    notes="Daily file. Used here only for the MPC's U parameter and for an independent cross-check of the JPL orbits "
          "(the JPL SBDB elements are the ones propagated).",
)


# ---------------------------------------------------------------------------------------------- NEOWISE
@dataclass
class NeowiseFit:
    number: int | None
    prov: str | None
    packed: str
    H: float
    G: float
    mean_jd: float
    nobs: int
    fit_code: str
    D: float
    D_err: float
    pV: float
    pV_err: float
    reference: str
    notes: str
    file: str


def _f(x: str) -> float:
    try:
        return float(x)
    except ValueError:
        return float("nan")


def read_neowise(paths: list[Path]) -> list[NeowiseFit]:
    out = []
    for p in paths:
        for row in csv.reader(io.StringIO(p.read_text(encoding="utf-8"))):
            if not row:
                continue
            r = [c.strip() for c in row]
            num = int(r[0]) if r[0] and r[0] != "0" and r[0].isdigit() else None
            prov = r[1] if r[1] not in ("-", "") else None
            n = sum(int(x) for x in r[6:10] if x.lstrip("-").isdigit())
            out.append(NeowiseFit(num, prov, r[2], _f(r[3]), _f(r[4]), _f(r[5]), n, r[10], _f(r[11]), _f(r[12]),
                                  _f(r[13]), _f(r[14]), r[20] if len(r) > 20 else "", r[21] if len(r) > 21 else "",
                                  p.name))
    return out


# ---------------------------------------------------------------------------------------------- LCDB
@dataclass
class LcdbEntry:
    number: int | None
    name: str
    desig: str
    period_h: float
    u: str          # e.g. "3", "2+", "1-"
    flags: str      # LCDB period flags (e.g. '>' or '<' for limits, 'S' for sparse data)


def read_lcdb(zip_path: Path) -> tuple[list[LcdbEntry], str]:
    """Rows of LC_SUM_PUB (fixed-width; column positions from the readme inside the zip)."""
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        summ = [n for n in names if n.lower() == "lc_summary_pub.txt"]
        if not summ:
            raise ValueError(f"no lc_summary_pub.txt in {zip_path.name}: {names}")
        text = z.read(summ[0]).decode("latin-1")
    return parse_lcdb_summary(text), summ[0]


def parse_lcdb_summary(text: str) -> list[LcdbEntry]:
    """Fixed-width LCDB summary. Column starts come from the header line (NUMBER, NAME, DESIG, FAM, ..., F PERIOD,
    P DESC, ..., U, NOTES): the number is right-aligned in columns 0-6, the period flag sits under 'F' of 'F PERIOD'
    and the value follows it up to 'P DESC'; U is the two characters under ' U '."""
    lines = text.splitlines()
    hi = next(i for i, ln in enumerate(lines) if ln.startswith("NUMBER") and "PERIOD" in ln)
    h = lines[hi]
    i_name, i_des, i_fam = h.index("NAME"), h.index("DESIG"), h.index("FAM")
    i_per, i_pdesc = h.index("F PERIOD"), h.index("P DESC")
    i_u = h.index(" U ") + 1
    out = []
    for ln in lines[hi + 2:]:
        if len(ln) < i_u + 2 or not ln[:7].strip():
            continue
        num = ln[0:7].strip()
        flag = ln[i_per].strip()
        per = ln[i_per + 1:i_pdesc].strip()
        try:
            p = float(per)
        except ValueError:
            continue
        out.append(LcdbEntry(int(num) if num.isdigit() and int(num) > 0 else None, ln[i_name:i_des].strip(),
                             ln[i_des:i_fam].strip(), p, ln[i_u:i_u + 2].strip(), flag))
    return out


# ---------------------------------------------------------------------------------------------- Gaia
GAIA_WAVELENGTHS_NM = np.array([374.0, 418.0, 462.0, 506.0, 550.0, 594.0, 638.0, 682.0, 726.0, 770.0, 814.0, 858.0,
                                902.0, 946.0, 990.0, 1034.0])


@dataclass
class GaiaSpectra:
    number: np.ndarray         # (M,) int, 0 if none
    name: np.ndarray           # (M,) str (denomination)
    refl: np.ndarray           # (M, 16) normalised reflectance, NaN where missing
    err: np.ndarray            # (M, 16)
    flag: np.ndarray           # (M, 16) int, -1 missing
    wavelengths: np.ndarray    # (16,) nm


def read_gaia(paths: list[Path]) -> GaiaSpectra:
    """One row per (object, wavelength) in the CSVs; pivot to one spectrum per object."""
    spectra: dict[tuple[int, str], dict[float, tuple[float, float, int]]] = {}
    for p in paths:
        with gzip.open(p, "rt") as fh:
            rows = [ln for ln in fh if not ln.startswith("#")]
        rd = csv.DictReader(rows)
        for r in rd:
            key = (int(r["number_mp"]) if r.get("number_mp") not in (None, "", "null") else 0, r["denomination"])
            wl = float(r["wavelength"])
            refl = _f(r["reflectance_spectrum"])
            err = _f(r["reflectance_spectrum_err"])
            flag = int(r["reflectance_spectrum_flag"]) if r["reflectance_spectrum_flag"] not in ("", "null") else -1
            spectra.setdefault(key, {})[wl] = (refl, err, flag)
    keys = sorted(spectra)
    m = len(keys)
    refl = np.full((m, 16), np.nan)
    err = np.full((m, 16), np.nan)
    flag = np.full((m, 16), -1, dtype=np.int16)
    for i, k in enumerate(keys):
        for wl, (r, e, f) in spectra[k].items():
            j = int(np.argmin(np.abs(GAIA_WAVELENGTHS_NM - wl)))
            if abs(GAIA_WAVELENGTHS_NM[j] - wl) > 1.0:
                raise ValueError(f"unexpected Gaia wavelength {wl}")
            refl[i, j], err[i, j], flag[i, j] = r, e, f
    return GaiaSpectra(np.array([k[0] for k in keys]), np.array([k[1] for k in keys], dtype=object), refl, err, flag,
                       GAIA_WAVELENGTHS_NM)


# ---------------------------------------------------------------------------------------------- SsODNet ssoBFT
# One phase function per object: the band closest to V first (the MPC-photometry V fits, then Gaia G, ATLAS o/c,
# ZTF r/g). One spin solution per object with a pole: lightcurve inversion, radar, occultation-constrained and
# thermophysical solutions before the statistical amplitude-magnitude (A-M) poles.
PHASE_FILTER_ORDER = ["V", "G", "orange", "cyan", "r", "g", "R", "i"]
SPIN_TECHNIQUE_ORDER = ["SPACE", "Radar", "Radar-LC", "KOALA", "ADAM", "SAGE", "LC+Occ", "TE-Occ", "LC+IM", "TE-IM",
                        "Bin-IM", "LC+TPM", "LC-TPM", "LCI", "TE", "LC"]   # then any other technique, then "A-M"


@dataclass
class SsoBft:
    number: np.ndarray        # int (0 = unnumbered)
    name: np.ndarray          # str
    phase: dict[str, np.ndarray]   # H, G1, G2, H_err, G1_err, G2_err, phase_min, phase_max, rms (float); N (int);
    phase_filter: np.ndarray       # str ('' = none)
    phase_facility: np.ndarray     # str
    spin: dict[str, np.ndarray]    # RA0, DEC0, period (float)
    spin_technique: np.ndarray     # str
    tax_class: np.ndarray          # str ('' = none)
    tax_scheme: np.ndarray
    tax_technique: np.ndarray


def _at(lst, j):
    """Element j of a Parquet list cell (None when the cell or the element is missing)."""
    return lst[j] if lst is not None and j < len(lst) else None


def _err(lo, hi) -> float:
    vals = [abs(v) for v in (lo, hi) if v is not None and v == v]
    return max(vals) if vals else math.nan


def read_ssobft(path: Path) -> SsoBft:
    import pyarrow.parquet as pq

    pf = ["name_filter", "H.value", "H.error.min", "H.error.max", "G1.value", "G1.error.min", "G1.error.max",
          "G2.value", "G2.error.min", "G2.error.max", "N", "phase.min", "phase.max", "rms", "facility"]
    sp = ["RA0.value", "DEC0.value", "period.value", "technique"]
    cols = (["number", "name"] + [f"phase_functions.{c}" for c in pf] + [f"spins.{c}" for c in sp]
            + ["taxonomy.class", "taxonomy.scheme", "taxonomy.technique"])
    t = pq.read_table(path, columns=cols)
    d = {c: t.column(c).to_pylist() for c in cols}
    n = t.num_rows
    ph = {k: np.full(n, np.nan) for k in ("H", "G1", "G2", "H_err", "G1_err", "G2_err", "phase_min", "phase_max",
                                          "rms")}
    ph["N"] = np.zeros(n, dtype=np.int64)
    pfilt = np.full(n, "", dtype=object)
    pfac = np.full(n, "", dtype=object)
    spin = {k: np.full(n, np.nan) for k in ("RA0", "DEC0", "period")}
    stech = np.full(n, "", dtype=object)
    rank_f = {f: k for k, f in enumerate(PHASE_FILTER_ORDER)}
    rank_s = {f: k for k, f in enumerate(SPIN_TECHNIQUE_ORDER)}
    rank_s["A-M"] = len(SPIN_TECHNIQUE_ORDER) + 1
    for i in range(n):
        filters = d["phase_functions.name_filter"][i]
        if filters:
            best = None
            for j, f in enumerate(filters):
                g1, g2 = _at(d["phase_functions.G1.value"][i], j), _at(d["phase_functions.G2.value"][i], j)
                if g1 is None or g2 is None or _at(d["phase_functions.H.value"][i], j) is None:
                    continue
                key = (rank_f.get(f, len(rank_f)), -(_at(d["phase_functions.N"][i], j) or 0))
                if best is None or key < best[0]:
                    best = (key, j)
            if best is not None:
                j = best[1]
                g = lambda c: _at(d[f"phase_functions.{c}"][i], j)  # noqa: E731
                ph["H"][i], ph["G1"][i], ph["G2"][i] = g("H.value"), g("G1.value"), g("G2.value")
                ph["H_err"][i] = _err(g("H.error.min"), g("H.error.max"))
                ph["G1_err"][i] = _err(g("G1.error.min"), g("G1.error.max"))
                ph["G2_err"][i] = _err(g("G2.error.min"), g("G2.error.max"))
                for k, c in (("phase_min", "phase.min"), ("phase_max", "phase.max"), ("rms", "rms")):
                    v = g(c)
                    ph[k][i] = v if v is not None else np.nan
                ph["N"][i] = g("N") or 0
                pfilt[i] = filters[j]
                pfac[i] = g("facility") or ""
        ra = d["spins.RA0.value"][i]
        if ra:
            best = None
            for j, a in enumerate(ra):
                dec = _at(d["spins.DEC0.value"][i], j)
                if a is None or dec is None or a != a or dec != dec:
                    continue
                tech = _at(d["spins.technique"][i], j) or ""
                key = rank_s.get(tech, len(SPIN_TECHNIQUE_ORDER))
                if best is None or key < best[0]:
                    best = (key, j)
            if best is not None:
                j = best[1]
                spin["RA0"][i], spin["DEC0"][i] = ra[j], _at(d["spins.DEC0.value"][i], j)
                p = _at(d["spins.period.value"][i], j)
                spin["period"][i] = p if p is not None else np.nan
                stech[i] = _at(d["spins.technique"][i], j) or ""
    num = np.array([x or 0 for x in d["number"]], dtype=np.int64)
    s = lambda c: np.array([x or "" for x in d[c]], dtype=object)  # noqa: E731
    return SsoBft(num, np.array(d["name"], dtype=object), ph, pfilt, pfac, spin, stech, s("taxonomy.class"),
                  s("taxonomy.scheme"), s("taxonomy.technique"))


# ---------------------------------------------------------------------------------------------- MPCORB
@dataclass
class MpcOrbits:
    desig: np.ndarray    # readable designation (number as str, or provisional) matching SBDB pdes
    U: np.ndarray        # str ('0'..'9', 'E', 'D', 'F', '' ...)
    epoch_packed: np.ndarray
    elems: np.ndarray    # (M, 7): M, peri, node, inc, e, n, a (deg, deg/d, au)
    H: np.ndarray
    G: np.ndarray


_PACK = {c: i for i, c in enumerate("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")}


def unpack_designation(p: str) -> str:
    """MPC packed designation (columns 1-7 of MPCORB) -> SBDB pdes (number or provisional designation)."""
    p = p.strip()
    if len(p) == 5 and (p.isdigit() or (p[0].isalpha() and p[1:].isdigit())):
        return str(_PACK[p[0]] * 10000 + int(p[1:]))
    if len(p) == 5 and p[0] == "~":
        n = 0
        for c in p[1:]:
            n = n * 62 + _PACK[c]
        return str(620000 + n)
    if len(p) == 7:
        century = {"I": 18, "J": 19, "K": 20}.get(p[0])
        if century is not None and p[1:3].isdigit():
            year = century * 100 + int(p[1:3])
            if p[3:5] in ("PL", "T1", "T2", "T3"):
                pass
            half, letter2 = p[3], p[6]
            cyc = _PACK[p[4]] * 10 + int(p[5])
            return f"{year} {half}{letter2}" + (str(cyc) if cyc else "")
    if p.startswith(("PLS", "T1S", "T2S", "T3S")):
        return f"{p[3:]} {p[0]}-{p[1]}" if p[0] == "T" else f"{p[3:]} P-L"
    return p


def read_mpcorb(path: Path) -> MpcOrbits:
    des, U, ep, el, H, G = [], [], [], [], [], []
    with gzip.open(path, "rt", encoding="latin-1") as fh:
        started = False
        for ln in fh:
            if not started:
                if ln.startswith("-----"):
                    started = True
                continue
            if len(ln) < 160 or not ln.strip():
                continue
            try:
                row = [float(ln[26:35]), float(ln[37:46]), float(ln[48:57]), float(ln[59:68]), float(ln[70:79]),
                       float(ln[80:91]), float(ln[92:103])]
            except ValueError:
                continue
            des.append(unpack_designation(ln[0:7]))
            U.append(ln[105].strip())
            ep.append(ln[20:25])
            el.append(row)
            H.append(_f(ln[8:13]))
            G.append(_f(ln[14:19]))
    return MpcOrbits(np.array(des, dtype=object), np.array(U, dtype=object), np.array(ep, dtype=object),
                     np.array(el), np.array(H), np.array(G))
