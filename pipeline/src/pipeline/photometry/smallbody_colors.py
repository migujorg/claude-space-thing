"""smallbody-class-colors.json: estimated colours and albedo statistics for small bodies without a measured spectrum.

Per Bus-DeMeo taxonomic class (DeMeo et al. 2009):
  * reflectance spectrum 360-830 nm: the class mean spectrum (DeMeo et al. 2009, PDS; 0.45-2.45 µm, normalized at
    0.55 µm) extended below 0.45 µm with the class's mean ECAS u and b colours (Zellner et al. 1985, PDS; 0.36 and
    0.44 µm), piecewise linear;
  * xyzsPerUnitPV: that spectrum scaled to a V-band geometric albedo of 1 and integrated against sunlight and the CIE
    observers (docs/architecture.md §4.3), so an object's geometricAlbedoXYZS = p_V × xyzsPerUnitPV;
  * p_V distribution (median, 16th/84th percentiles, n) of NEOWISE-fitted albedos (Mainzer et al. 2019, PDS) of
    objects with that class in the spectral taxonomies (DeMeo et al. 2009; the PDS taxonomy compilation of Neese 2010).
Coarse classes from SDSS colours (Carvano et al. 2010, PDS; 63 000 objects) get their own p_V statistics, and their
frequencies weight the population-level mean colour used for unclassified objects.
"""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from functools import lru_cache

import numpy as np

from .. import cie
from ..schema import BuildContext, sourced, unknown
from . import filters, solar
from .common import Download, bin_average

PSI = "https://sbnarchive.psi.edu/pds3/non_mission/"


def _pds(id_: str, path: str, title: str, citation: str, notes: str | None = None) -> Download:
    return Download(id=id_, url=PSI + path, subdir="smallbody_colors", name=path.split("/")[-1], title=title,
                    citation=citation, notes=notes, license="NASA PDS public data")


DEMEO_CIT = ("DeMeo, F. E., Binzel, R. P., Slivan, S. M. & Bus, S. J. (2009). An extension of the Bus asteroid "
             "taxonomy into the near-infrared. Icarus 202, 160-180. DOI:10.1016/j.icarus.2009.02.005. Data set: "
             "DeMeo, F. E. et al. (2011), Bus-DeMeo Taxonomy Classifications and Mean Spectra, "
             "EAR-A-VARGBDET-5-BUSDEMEOTAX-V1.0, NASA Planetary Data System.")
DEMEO_MEAN = _pds("busdemeo-mean-spectra", "EAR_A_VARGBDET_5_BUSDEMEOTAX_V1_0/data/meanspectra.tab",
                  "Bus-DeMeo class mean reflectance spectra, 0.45-2.45 µm, normalized at 0.55 µm", DEMEO_CIT)
DEMEO_MEAN_LBL = _pds("busdemeo-mean-spectra-label", "EAR_A_VARGBDET_5_BUSDEMEOTAX_V1_0/data/meanspectra.lbl",
                      "Label of meanspectra.tab (column names)", DEMEO_CIT)
DEMEO_TAX = _pds("busdemeo-classes", "EAR_A_VARGBDET_5_BUSDEMEOTAX_V1_0/data/demeotax.tab",
                 "Bus-DeMeo classes of 371 asteroids", DEMEO_CIT)
ECAS_CIT = ("Zellner, B., Tholen, D. J. & Tedesco, E. F. (1985). The eight-color asteroid survey: results for 589 "
            "minor planets. Icarus 61, 355-416. DOI:10.1016/0019-1035(85)90133-2. Data sets "
            "EAR-A-2CP-3-RDR-ECAS-MEAN-V1.0 and ...-ECAS-FILTER-CURVES-V1.0 (filters: Tedesco, E. F., Tholen, D. J. & "
            "Zellner, B. 1982, AJ 87, 1585), NASA Planetary Data System.")
ECAS_MEAN = _pds("ecas-mean-colors", "EAR_A_2CP_3_RDR_ECAS_MEAN_V1_0/data/ecasmean.tab",
                 "ECAS mean colour indices of 589 asteroids (solar colours are zero)", ECAS_CIT)
ECAS_FILTERS = _pds("ecas-filter-curves", "EAR_A_2CP_3_RDR_ECAS_FILTER_CURVES_V1_0/data/ecasfltr.tab",
                    "ECAS filter and dichroic response curves", ECAS_CIT)
NEESE = _pds("pds-asteroid-taxonomy-v6", "EAR_A_5_DDR_TAXONOMY_V6_0/data/taxonomy10.tab",
             "Asteroid taxonomic classifications (Tholen, Barucci, Tedesco, Howell, SMASS, Bus, S3OS2, Bus-DeMeo)",
             "Neese, C., Ed. (2010). Asteroid Taxonomy V6.0. EAR-A-5-DDR-TAXONOMY-V6.0, NASA Planetary Data System "
             "(compilation; per-scheme references in the label).")
SDSS = _pds("sdss-taxonomy-carvano2010", "EAR_A_I0035_5_SDSSTAX_V1_1/data/sdsstax_ast_table.tab",
            "SDSS-based taxonomic classification of 63 468 asteroids",
            "Carvano, J. M., Hasselmann, P. H., Lazzaro, D. & Mothé-Diniz, T. (2010). SDSS-based taxonomic "
            "classification and orbital distribution of main belt asteroids. A&A 510, A43. "
            "DOI:10.1051/0004-6361/200913322. Data set: Hasselmann, P. H., Carvano, J. M. & Lazzaro, D. (2012), SDSS-"
            "based Asteroid Taxonomy V1.1, EAR-A-I0035-5-SDSSTAX-V1.1, NASA Planetary Data System.")

# Bus-DeMeo class names as printed in the label (upper case) -> the usual spelling.
DEMEO_CLASSES = ["A", "B", "C", "Cb", "Cg", "Cgh", "Ch", "D", "K", "L", "O", "Q", "R", "S", "Sa", "Sq", "Sr", "Sv",
                 "T", "V", "X", "Xc", "Xe", "Xk"]
COMPLEX = {"S": ("S", "Sa", "Sq", "Sr", "Sv"), "C": ("B", "C", "Cb", "Cg", "Cgh", "Ch"), "X": ("X", "Xc", "Xe", "Xk")}
SDSS_CLASSES = ("A", "C", "D", "L", "O", "Q", "S", "V", "X")     # Carvano et al. (2010) single-letter classes
MIN_N = 3                # smallest sample for an albedo statistic (and for a complex-level ECAS mean)


# ---------------------------------------------------------------------------------------------- readers
def fixed_width(tab_text: str, columns: dict[str, tuple[int, int]]) -> list[dict[str, str]]:
    """Rows of a PDS3 fixed-width table; columns: name -> (START_BYTE (1-based), BYTES)."""
    out = []
    for line in tab_text.splitlines():
        if not line.strip():
            continue
        out.append({k: line[s - 1:s - 1 + n].strip() for k, (s, n) in columns.items()})
    return out


@lru_cache(maxsize=1)
def mean_spectra() -> tuple[np.ndarray, dict[str, np.ndarray]]:
    names = re.findall(r'NAME\s*=\s*"([A-Z]+)_(?:MEAN|VAL)"', DEMEO_MEAN_LBL.fetch().read_text(encoding="utf-8"))
    d = np.loadtxt(DEMEO_MEAN.fetch())
    wl = d[:, 0] * 1000.0
    out = {}
    for k, n in enumerate(names):
        cls = n[0] + n[1:].lower()
        out[cls] = d[:, 1 + 2 * k]
    if sorted(out) != sorted(DEMEO_CLASSES):
        raise ValueError(f"unexpected classes in meanspectra.lbl: {sorted(out)}")
    return wl, out


@lru_cache(maxsize=1)
def memberships() -> dict[int, set[str]]:
    """Asteroid number -> Bus-DeMeo classes from the spectral taxonomies (DeMeo 2009; the Neese compilation's
    BUS_DEMEO_CLASS, and its BUS_CLASS where the Bus name is also a Bus-DeMeo class)."""
    m: dict[int, set[str]] = defaultdict(set)
    for r in fixed_width(DEMEO_TAX.fetch().read_text(encoding="utf-8"), {"num": (1, 7), "cls": (38, 3)}):
        if r["num"].isdigit() and r["cls"] in DEMEO_CLASSES:
            m[int(r["num"])].add(r["cls"])
    for r in fixed_width(NEESE.fetch().read_text(encoding="utf-8"), {"num": (1, 7), "bus": (81, 3), "bd": (97, 3)}):
        if not r["num"].isdigit():
            continue
        for c in (r["bd"], r["bus"]):
            if c in DEMEO_CLASSES:
                m[int(r["num"])].add(c)
                break
    return {k: v for k, v in m.items() if len(v) == 1}          # ambiguous entries dropped


@lru_cache(maxsize=1)
def sdss_rows() -> list[dict[str, str]]:
    return fixed_width(SDSS.fetch().read_text(encoding="utf-8"), {"num": (1, 6), "cls": (36, 4)})


@lru_cache(maxsize=1)
def sdss_classes() -> dict[int, str]:
    """Numbered asteroids with a single-letter SDSS class (two-letter labels such as 'LS' are ambiguous)."""
    return {int(r["num"]): r["cls"] for r in sdss_rows() if r["num"].isdigit() and r["cls"] in SDSS_CLASSES}


@lru_cache(maxsize=1)
def sdss_frequencies() -> tuple[dict[str, float], int]:
    """Class frequencies over all classified rows; a two-letter label counts half for each letter."""
    c: Counter = Counter()
    n = 0
    for r in sdss_rows():
        lab = r["cls"]
        letters = [x for x in lab if x in SDSS_CLASSES]
        if not lab or lab == "U" or len(letters) != len(lab):
            continue
        n += 1
        for x in letters:
            c[x] += 1.0 / len(letters)
    return {k: c[k] / n for k in SDSS_CLASSES}, n


@lru_cache(maxsize=1)
def ecas_ratios() -> dict[int, tuple[float, float]]:
    """Asteroid number -> (R_u/R_v, R_b/R_v) from the ECAS mean colours u-v and b-v (magnitudes, solar = 0)."""
    out = {}
    for r in fixed_width(ECAS_MEAN.fetch().read_text(encoding="utf-8"), {"num": (1, 5), "uv": (18, 6), "bv": (29, 6)}):
        try:
            num, uv, bv = int(r["num"]), float(r["uv"]), float(r["bv"])
        except ValueError:
            continue
        out[num] = (10 ** (-0.4 * uv), 10 ** (-0.4 * bv))
    return out


@lru_cache(maxsize=1)
def ecas_wavelengths() -> tuple[float, float, float]:
    """Solar-weighted effective wavelengths (nm) of ECAS u, b, v from the filter × dichroic curves and TSIS-1."""
    cols = {"wl": (1, 5), "dr": (9, 5), "u": (21, 5), "b": (27, 5), "dt": (35, 5), "v": (41, 5)}
    rows = fixed_width(ECAS_FILTERS.fetch().read_text(encoding="utf-8"), cols)
    val = lambda r, k: float(r[k]) if r[k] else 0.0      # noqa: E731  blank = no response
    wl = np.array([val(r, "wl") for r in rows]) * 1000.0
    s = solar.spectrum()
    e = np.interp(wl, s.wl_air, s.ssi_air)
    out = []
    for f, d in (("u", "dr"), ("b", "dr"), ("v", "dt")):   # u, b reflected by the dichroic; v transmitted
        t = np.array([val(r, f) * val(r, d) for r in rows])
        out.append(float(np.sum(wl * t * e) / np.sum(t * e)))
    return tuple(out)


@lru_cache(maxsize=1)
def neowise_albedos() -> dict[int, float]:
    """Asteroid number -> median fitted p_V over its NEOWISE fits (fit code with V fitted)."""
    from ..sb_physical_sources import neowise_downloads, read_neowise
    fits = read_neowise([d.fetch() for d in neowise_downloads()])
    per = defaultdict(list)
    for f in fits:
        if f.number and len(f.fit_code) > 1 and f.fit_code[1] == "V" and math.isfinite(f.pV) and f.pV > 0:
            per[f.number].append(f.pV)
    return {k: float(np.median(v)) for k, v in per.items()}


# ---------------------------------------------------------------------------------------------- build
def _stats(vals: list[float]) -> dict | None:
    if len(vals) < MIN_N:
        return None
    a = np.array(vals)
    return {"median": round(float(np.median(a)), 4), "p16": round(float(np.percentile(a, 16)), 4),
            "p84": round(float(np.percentile(a, 84)), 4), "n": int(a.size)}


def _uv_ratios(cls: str) -> tuple[tuple[float, float], str, int]:
    """Mean ECAS (R_u/R_v, R_b/R_v) for the class, else its complex, else all ECAS objects with a class."""
    mem, ec = memberships(), ecas_ratios()
    groups = [(cls, (cls,), 1)]
    for cx, members in COMPLEX.items():
        if cls in members:
            groups.append((f"{cx}-complex", members, MIN_N))
    groups.append(("all classified", tuple(DEMEO_CLASSES), MIN_N))
    for name, members, need in groups:
        v = [ec[n] for n, c in mem.items() if n in ec and next(iter(c)) in members]
        if len(v) >= need:
            a = np.array(v)
            return (float(a[:, 0].mean()), float(a[:, 1].mean())), name, len(v)
    raise ValueError("no ECAS colours")


def class_spectrum(cls: str) -> tuple[np.ndarray, np.ndarray, dict]:
    """Reflectance (normalized at 550 nm) on 350-2450 nm: DeMeo mean ≥ 450 nm, ECAS u, b colours below."""
    wl, ms = mean_spectra()
    r = ms[cls].copy()
    (ru, rb), group, n = _uv_ratios(cls)
    lu, lb, lv = ecas_wavelengths()
    # ECAS ratio at 450 nm by linear interpolation between b and v, matched to the DeMeo value at 450 nm
    rb450 = rb + (1.0 - rb) * (450.0 - lb) / (lv - lb)
    scale = r[0] / rb450
    wl_out = np.concatenate([[lu, lb], wl])
    r_out = np.concatenate([[ru * scale, rb * scale], r])
    return wl_out, r_out, {"ultravioletFrom": group, "ecasN": n, "ecasWavelengthsNm": [round(lu, 1), round(lb, 1)]}


def xyzs_per_unit_pv(wl: np.ndarray, r: np.ndarray) -> list[float]:
    grid = bin_average(wl, r) if wl.min() <= 359.5 else np.interp(cie.WAVELENGTHS, wl, r)
    rv = filters.band_average("V", cie.WAVELENGTHS, grid)
    return [round(float(v), 3) for v in cie.xyzs(grid / rv * solar.spectrum().grid)]


def build(ctx: BuildContext | None = None) -> dict:
    alb = neowise_albedos()
    mem = memberships()
    sd = sdss_classes()
    src = lambda d: d.register(ctx) if ctx else d.id      # noqa: E731
    from ..sb_physical_sources import neowise_downloads
    s_common = [src(solar.HSRS), *(cie.register_sources(ctx) if ctx else [cie.SOURCE_CMF, cie.SOURCE_SCOTOPIC]),
                *filters.register(ctx, ("V",))]
    s_spec = [src(DEMEO_MEAN), src(DEMEO_MEAN_LBL), src(ECAS_MEAN), src(ECAS_FILTERS), src(DEMEO_TAX), src(NEESE)]
    s_alb = [src(neowise_downloads()[0]), src(DEMEO_TAX), src(NEESE)]
    classes = {}
    for cls in DEMEO_CLASSES:
        wl, r, info = class_spectrum(cls)
        members = [n for n, c in mem.items() if next(iter(c)) == cls]
        pv = _stats([alb[n] for n in members if n in alb])
        classes[cls] = {
            "colour": sourced(
                {"xyzsPerUnitPV": xyzs_per_unit_pv(wl, r),
                 "spectrum": {"wavelengthNm": [round(float(x), 1) for x in wl if x <= 900],
                              "reflectance": [round(float(y), 4) for x, y in zip(wl, r) if x <= 900]},
                 **info},
                "derived", [*s_spec, *s_common],
                method=f"Bus-DeMeo {cls} mean spectrum (DeMeo et al. 2009) from 450 nm, extended to the ECAS u and b "
                       f"filters with the mean ECAS colours of {info['ecasN']} asteroids ({info['ultravioletFrom']}), "
                       "matched at 450 nm; piecewise linear, constant below u; scaled to V-band p = 1 and integrated "
                       "against TSIS-1 sunlight and the CIE observers. Applied to an object of this class it is an "
                       "ESTIMATE of that object's colour.",
                uncertainty="class spread: DeMeo et al.'s per-wavelength standard deviations (a few percent in the "
                            "visible for well-populated classes; single-object classes Cg, O, R have none); ECAS "
                            "colours ±0.02-0.05 mag"),
            "pV": sourced(pv, "derived", s_alb,
                          method=f"NEOWISE-fitted p_V (median over each object's fits with V fitted) of the "
                                 f"{len(members)} numbered asteroids classified {cls} in the spectral taxonomies; "
                                 f"{pv['n'] if pv else 0} have one. Median and 16th/84th percentiles.",
                          uncertainty="small spectroscopic samples are biased toward bright, large objects")
            if pv else unknown(f"fewer than {MIN_N} numbered asteroids of this class have a NEOWISE-fitted albedo"),
        }
    # coarse SDSS classes: albedo statistics and frequencies
    freq, n_sdss = sdss_frequencies()
    count = Counter(sd.values())
    sdss = {}
    for c in SDSS_CLASSES:
        pv = _stats([alb[n] for n, k in sd.items() if k == c and n in alb])
        sdss[c] = {"meanSpectrumClass": c, "frequency": round(freq[c], 4), "numberedSingleLetter": count[c],
                   "pV": pv}
    # population: frequency-weighted mean spectrum of the SDSS classes (each mapped to the same-letter DeMeo mean)
    grid = cie.WAVELENGTHS
    acc = np.zeros_like(grid, dtype=float)
    for c in SDSS_CLASSES:
        wl, r, _ = class_spectrum(c)
        acc += sdss[c]["frequency"] * np.interp(grid, wl, r)
    acc /= sum(sdss[c]["frequency"] for c in SDSS_CLASSES)
    all_pv = _stats(list(alb.values()))
    population = {
        "colour": sourced({"xyzsPerUnitPV": xyzs_per_unit_pv(grid, acc)}, "estimated",
                          [*s_spec, src(SDSS), *s_common],
                          method="Mean of the class spectra weighted by the frequencies of the SDSS colour classes of "
                                 f"{n_sdss} asteroids (Carvano et al. 2010; a two-letter label counts half for each): "
                                 + ", ".join(f"{c} {sdss[c]['frequency']:.3f}" for c in SDSS_CLASSES)
                                 + ". An assumption for an object of unknown class (the SDSS sample is magnitude-"
                                   "limited, H ≲ 17, mostly main belt).",
                          uncertainty="the spread of the classes themselves: S- vs C-type colours differ by ~0.02 "
                                      "in x"),
        "pV": sourced(all_pv, "derived", [src(neowise_downloads()[0])],
                      method=f"All {all_pv['n']} numbered asteroids with a NEOWISE-fitted p_V: median and 16th/84th "
                             "percentiles (thermal-infrared selection favours dark objects).",
                      uncertainty="sampling bias"),
    }
    return {
        "definition": "geometricAlbedoXYZS of an object = p_V × xyzsPerUnitPV (lux at 1 AU per unit V-band "
                      "geometric albedo; docs/architecture.md §4.3). Class names are Bus-DeMeo (DeMeo et al. 2009); "
                      "the aliases map other schemes' labels to them. Using a class colour or albedo for an object "
                      "makes that object's attribute 'estimated'.",
        "classes": classes,
        "sdssClasses": sdss,
        "population": population,
        "aliases": ALIASES,
    }


# Other schemes' labels -> the Bus-DeMeo class whose mean spectrum is used (an assumption for each non-identical
# name, stated here; the small-body stage decides whether to use them).
ALIASES = {
    "rule": "ASSUMED correspondences (this product's, not a published mapping): an exact Bus-DeMeo name maps to "
            "itself; Bus (SMASSII) classes that DeMeo et al. (2009) no longer use map Sk -> Sq, Sl -> S, Ld -> L; "
            "Tholen classes map by the tables below (F -> B, G -> Cgh, E -> Xe, M -> Xk, P -> X by spectral "
            "similarity in the visible); Mahlke et al. (2022) E, M, P, Z likewise; a multi-letter Tholen/SDSS "
            "label (e.g. 'CX', 'SQ') uses its first letter; anything else uses the population entry. Tholen E, M and "
            "P are X-complex objects told apart by albedo, so the Xe/Xk/X p_V statistics here do not represent "
            "them; only the colour mapping is meant.",
    "bus": {"Sk": "Sq", "Sl": "S", "Ld": "L"},
    "tholen": {"S": "S", "C": "C", "B": "B", "F": "B", "G": "Cgh", "D": "D", "T": "T", "V": "V", "A": "A", "Q": "Q",
               "R": "R", "E": "Xe", "M": "Xk", "P": "X", "X": "X"},
    "mahlke": {"E": "Xe", "M": "Xk", "P": "X", "Z": "D"},
}
