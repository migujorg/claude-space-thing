"""Per-object physical attributes of small bodies, each with its own provenance label and source.

Attribute rules (NORTH_STAR 3.2; docs/research/m3-small-bodies.md §3):
- diameter, geometric albedo p_V: `measured` from the JPL SBDB physical-parameter compilation (thermal models,
  occultations, radar, spacecraft) or, where SBDB has none, from NEOWISE V2.0 fits in which that parameter was
  fitted (fit code contains D / V). Several NEOWISE fits of one object are combined by inverse-variance weighting.
- estimated diameter (separate column, never overwrites): D = 1329 km / sqrt(p_V) 10^(-H/5) (Pravec & Harris 2007,
  Eq. 3) with p_V = the median measured albedo of the object's SBDB orbit class (population statistic computed here
  from the measured albedos, listed in the header). Only where no measured diameter exists and H is known;
  never for comets (their H is not a nucleus magnitude).
- rotation period: LCDB (U >= 2- measured; U = 1-..1+ or unrated estimated; U = 0 and period limits are not used),
  else the SBDB rot_per (measured, quality not given).
- taxonomy (SMASSII/Bus, Tholen) and B-V, U-B, I-R colours: SBDB, measured.
- phase function (H, G1, G2 and the phase range fitted), spin pole and SsODNet taxonomy: SsODNet ssoBFT, measured
  (fits outside the H-G1-G2 constraints are not used).
- geometricAlbedoXYZS: Gaia DR3 reflectance spectrum x p_V integrated against sunlight and the CIE observers
  (docs/architecture.md §4.3); `derived` when the spectrum bands are unflagged and p_V is measured, `estimated`
  when p_V is the class statistic or a band inside 418-814 nm had to be bridged (the 374 and 858 nm edge bands,
  often flagged, may be bridged: measured effect < 0.5 %).
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import cie
from .photometry import filters, solar
from .sb_catalog import Catalog
from .sb_physical_sources import GaiaSpectra, LcdbEntry, NeowiseFit, SsoBft, unpack_designation
from .sb_table import LABEL_CODE

D_H_CONSTANT_KM = 1329.0  # Pravec & Harris (2007), Icarus 190, 250, Eq. 3: D = 1329 km / sqrt(p_V) * 10^(-H/5)
MIN_CLASS_SAMPLE = 20

M, D, E, U = LABEL_CODE["measured"], LABEL_CODE["derived"], LABEL_CODE["estimated"], LABEL_CODE["unknown"]

LCDB_U_CODES = ["", "0-", "0", "0+", "1-", "1", "1+", "2-", "2", "2+", "3-", "3"]


@dataclass
class Physical:
    n: int
    cols: dict[str, np.ndarray] = field(default_factory=dict)
    class_albedo: dict[str, dict] = field(default_factory=dict)
    taxonomy_B: list[str] = field(default_factory=lambda: [""])
    taxonomy_T: list[str] = field(default_factory=lambda: [""])
    phase_filters: list[str] = field(default_factory=lambda: [""])
    phase_facilities: list[str] = field(default_factory=lambda: [""])
    spin_techniques: list[str] = field(default_factory=lambda: [""])
    taxonomy_bft: list[str] = field(default_factory=lambda: [""])
    stats: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------------------------- matching
def designation_index(cat: Catalog) -> dict[str, int]:
    """pdes -> row, plus the principal provisional designation in parentheses of numbered objects' full names."""
    idx: dict[str, int] = {}
    for i, (p, fn) in enumerate(zip(cat.s["pdes"], cat.s["full_name"])):
        idx[str(p)] = i
    for i, (p, fn) in enumerate(zip(cat.s["pdes"], cat.s["full_name"])):
        if fn and "(" in fn and str(cat.s["kind"][i]).startswith("a"):
            alt = fn[fn.index("(") + 1: fn.rindex(")")].strip() if ")" in fn else ""
            if alt and alt not in idx:
                idx[alt] = i
    return idx


def load_sbdb_phys(pages: list[Path]) -> dict[int, dict]:
    out: dict[int, dict] = {}
    for p in pages:
        d = json.loads(p.read_text(encoding="utf-8"))
        f = d["fields"]
        for r in d["data"]:
            out[int(r[0])] = dict(zip(f, r))
    return out


def _flt(x) -> float:
    """SBDB numeric string -> float. Asymmetric uncertainties such as '-1/+4' give the larger magnitude."""
    if x in (None, ""):
        return math.nan
    try:
        return float(x)
    except ValueError:
        if "/" in str(x):
            return max(abs(float(p)) for p in str(x).split("/"))
        raise


# ---------------------------------------------------------------------------------------------- merge
def build(cat: Catalog, sbdb_phys: dict[int, dict], neowise: list[NeowiseFit], lcdb: list[LcdbEntry],
          gaia: GaiaSpectra, src: dict[str, int], bft: SsoBft | None = None) -> Physical:
    """src: source-table indices for 'sbdb', 'neowise', 'lcdb', 'gaia', 'stat' (class albedo statistic) and, with
    bft (SsODNet ssoBFT), 'bft'."""
    n = cat.n
    ph = Physical(n)
    c = ph.cols
    nan = lambda: np.full(n, np.nan, dtype=np.float64)  # noqa: E731
    lab = lambda: np.full(n, U, dtype=np.uint8)          # noqa: E731
    zero = lambda: np.zeros(n, dtype=np.uint8)           # noqa: E731
    for k in ("diameter", "diameterSigma", "albedo", "albedoSigma", "rotPeriod", "diameterEst", "albedoAssumed",
              "BV", "UB", "IR", "phaseH", "phaseG1", "phaseG2", "phaseHSigma", "phaseG1Sigma", "phaseG2Sigma",
              "phaseMinDeg", "phaseMaxDeg", "poleRA", "poleDec", "spinPeriod"):
        c[k] = nan()
    c["geometricAlbedoXYZS"] = np.full((n, 4), np.nan)
    for k in ("diameterLabel", "albedoLabel", "rotLabel", "diameterEstLabel", "colorLabel", "taxonomyLabel",
              "colorIndexLabel", "phaseLabel", "spinLabel", "taxonomyBftLabel"):
        c[k] = lab()
    for k in ("diameterSrc", "albedoSrc", "rotSrc", "diameterEstSrc", "colorSrc", "taxonomySrc", "colorIndexSrc",
              "rotQuality", "taxonomyB", "taxonomyT", "gaiaBandsUsed", "phaseSrc", "phaseFilter", "phaseFacility",
              "spinSrc", "spinTechnique", "taxonomyBft", "taxonomyBftSrc"):
        c[k] = zero()
    c["phaseN"] = np.zeros(n, dtype=np.uint16)
    idx = designation_index(cat)
    row_of_spk = {int(s): i for i, s in enumerate(cat.spkid)}
    is_comet = np.array([str(k).startswith("c") for k in cat.s["kind"]])

    # --- SBDB compilation
    tb, tt = {"": 0}, {"": 0}
    for spk, r in sbdb_phys.items():
        i = row_of_spk.get(spk)
        if i is None:
            continue
        d, ds, a = _flt(r["diameter"]), _flt(r["diameter_sigma"]), _flt(r["albedo"])
        if d > 0:
            c["diameter"][i], c["diameterSigma"][i], c["diameterLabel"][i], c["diameterSrc"][i] = d, ds, M, src["sbdb"]
        if a > 0:
            c["albedo"][i], c["albedoLabel"][i], c["albedoSrc"][i] = a, M, src["sbdb"]
        per = _flt(r["rot_per"])
        if per > 0:
            c["rotPeriod"][i], c["rotLabel"][i], c["rotSrc"][i] = per, M, src["sbdb"]
        got = False
        for k, key in (("BV", "BV"), ("UB", "UB"), ("IR", "IR")):
            v = _flt(r[key])
            if math.isfinite(v):
                c[k][i] = v
                got = True
        if got:
            c["colorIndexLabel"][i], c["colorIndexSrc"][i] = M, src["sbdb"]
        sB, sT = r.get("spec_B"), r.get("spec_T")
        if sB or sT:
            if sB:
                c["taxonomyB"][i] = tb.setdefault(sB, len(tb))
            if sT:
                c["taxonomyT"][i] = tt.setdefault(sT, len(tt))
            c["taxonomyLabel"][i], c["taxonomySrc"][i] = M, src["sbdb"]
    ph.taxonomy_B = sorted(tb, key=tb.get)
    ph.taxonomy_T = sorted(tt, key=tt.get)
    if len(tb) > 255 or len(tt) > 255:
        raise ValueError("too many taxonomy classes for a u8 index")
    n_sbdb_d = int((c["diameterLabel"] == M).sum())
    n_sbdb_a = int((c["albedoLabel"] == M).sum())

    # --- NEOWISE (fills where SBDB has no value)
    fits: dict[int, list[NeowiseFit]] = {}
    unmatched = 0
    for f in neowise:
        key = str(f.number) if f.number else unpack_designation(f.packed)
        i = idx.get(key)
        if i is None and f.prov:
            i = idx.get(f.prov)
        if i is None:
            unmatched += 1
            continue
        fits.setdefault(i, []).append(f)
    agree = []
    n_nw_d = n_nw_a = 0
    for i, fl in fits.items():
        dv = [(f.D, f.D_err) for f in fl if "D" in f.fit_code[:1] and f.D > 0 and f.D_err > 0]
        av = [(f.pV, f.pV_err) for f in fl if len(f.fit_code) > 1 and f.fit_code[1] == "V" and f.pV > 0 and f.pV_err > 0]
        if dv:
            m, s = _combine(dv)
            if c["diameterLabel"][i] == M:
                agree.append(c["diameter"][i] / m)
            else:
                c["diameter"][i], c["diameterSigma"][i], c["diameterLabel"][i], c["diameterSrc"][i] = m, s, M, src["neowise"]
                n_nw_d += 1
        if av and c["albedoLabel"][i] != M:
            m, s = _combine(av)
            c["albedo"][i], c["albedoSigma"][i], c["albedoLabel"][i], c["albedoSrc"][i] = m, s, M, src["neowise"]
            n_nw_a += 1
    agree = np.array(agree)

    # --- LCDB (takes precedence over the SBDB rot_per: it carries the reliability code)
    n_lc = {"measured": 0, "estimated": 0, "limit": 0, "U0": 0, "unmatched": 0}
    for e in lcdb:
        i = idx.get(str(e.number)) if e.number else None
        if i is None and e.desig:
            i = idx.get(e.desig)
        if i is None and e.name:
            i = idx.get(e.name)
        if i is None:
            n_lc["unmatched"] += 1
            continue
        if e.flags in (">", "<"):
            n_lc["limit"] += 1
            continue
        u = e.u.strip()
        if u.startswith("0"):
            n_lc["U0"] += 1
            continue
        code = LCDB_U_CODES.index(u) if u in LCDB_U_CODES else 0
        good = u[:1] in ("2", "3")
        c["rotPeriod"][i] = e.period_h
        c["rotQuality"][i] = code
        c["rotLabel"][i] = M if good else E
        c["rotSrc"][i] = src["lcdb"]
        n_lc["measured" if good else "estimated"] += 1

    # --- class albedo statistic and estimated diameters
    H = cat.f["H"]
    cls = cat.s["class"]
    has_a = (c["albedoLabel"] == M) & np.isfinite(c["albedo"])
    for k in sorted(set(cls[~is_comet])):
        m = (cls == k) & has_a
        if m.sum() >= MIN_CLASS_SAMPLE:
            a = c["albedo"][m]
            ph.class_albedo[k] = {"median": float(np.median(a)), "p16": float(np.percentile(a, 16)),
                                  "p84": float(np.percentile(a, 84)), "n": int(m.sum())}
    allm = has_a & ~is_comet
    ph.class_albedo["*"] = {"median": float(np.median(c["albedo"][allm])), "p16": float(np.percentile(c["albedo"][allm], 16)),
                            "p84": float(np.percentile(c["albedo"][allm], 84)), "n": int(allm.sum())}
    for i in range(n):
        if is_comet[i] or not math.isfinite(H[i]) or c["diameterLabel"][i] == M:
            continue
        st = ph.class_albedo.get(cls[i], ph.class_albedo["*"])
        pv = c["albedo"][i] if has_a[i] else st["median"]
        c["albedoAssumed"][i] = pv
        c["diameterEst"][i] = D_H_CONSTANT_KM / math.sqrt(pv) * 10.0 ** (-H[i] / 5.0)
        c["diameterEstLabel"][i] = E
        c["diameterEstSrc"][i] = src["neowise"] if (has_a[i] and c["albedoSrc"][i] == src["neowise"]) else (
            src["sbdb"] if has_a[i] else src["stat"])

    # --- Gaia spectra -> geometricAlbedoXYZS
    n_gaia = _gaia_colors(cat, ph, gaia, idx, src, has_a)

    # --- SsODNet ssoBFT: H-G1-G2 phase functions, spin poles, taxonomy where the SBDB has none
    n_bft = _ssobft(ph, bft, idx, src) if bft is not None else {}

    ph.stats = {"sbdbDiameter": n_sbdb_d, "sbdbAlbedo": n_sbdb_a, "neowiseMatchedObjects": len(fits),
                "neowiseRowsUnmatched": unmatched, "neowiseDiameterAdded": n_nw_d, "neowiseAlbedoAdded": n_nw_a,
                "sbdbOverNeowiseDiameterRatio": {"n": int(agree.size),
                                                 "median": float(np.median(agree)) if agree.size else None,
                                                 "within1pct": float(np.mean(np.abs(agree - 1) < 0.01)) if agree.size else None},
                "lcdb": n_lc, "gaia": n_gaia, "ssobft": n_bft}
    return ph


def _combine(vals: list[tuple[float, float]]) -> tuple[float, float]:
    """Inverse-variance mean; uncertainty = max(formal error of the mean, scatter of the fits)."""
    v = np.array(vals)
    w = 1.0 / v[:, 1] ** 2
    m = float(np.sum(w * v[:, 0]) / np.sum(w))
    formal = float(1.0 / math.sqrt(np.sum(w)))
    scatter = float(np.std(v[:, 0], ddof=1)) if len(v) > 1 else 0.0
    return m, max(formal, scatter)


# ---------------------------------------------------------------------------------------------- Gaia colours
GAIA_BANDS_FOR_CIE = 11  # 374 ... 814 nm cover 360-830 nm (with the 374 nm band extended to 360 nm)


def spectrum_on_grid(wl: np.ndarray, refl: np.ndarray) -> np.ndarray:
    """Linear interpolation between band centres onto the CIE grid; flat beyond the outermost bands."""
    return np.interp(cie.WAVELENGTHS, wl, refl)


def _gaia_colors(cat: Catalog, ph: Physical, g: GaiaSpectra, idx: dict[str, int], src: dict[str, int],
                 has_a: np.ndarray) -> dict:
    c = ph.cols
    sun = solar.spectrum().grid
    obs = {"matched": 0, "unmatched": 0, "derived": 0, "estimated": 0, "unusable": 0}
    wl = g.wavelengths
    need = np.arange(GAIA_BANDS_FOR_CIE + 1)  # 374..858 nm: the band past 830 nm bounds the interpolation
    for k in range(g.refl.shape[0]):
        key = str(int(g.number[k])) if g.number[k] else str(g.name[k])
        i = idx.get(key)
        if i is None:
            obs["unmatched"] += 1
            continue
        obs["matched"] += 1
        ok = (g.flag[k, need] == 0) & np.isfinite(g.refl[k, need])
        # Usable: the 418-770 nm core (where the eye's response is) must be present and unflagged.
        core = (wl[need] >= 418) & (wl[need] <= 770)
        if not ok[core].all():
            obs["unusable"] += 1
            continue
        use = need[ok]
        r = spectrum_on_grid(wl[use], g.refl[k, use])
        rv = filters.band_average("V", cie.WAVELENGTHS, r)
        if rv is None or not rv > 0:
            obs["unusable"] += 1
            continue
        if c["albedoLabel"][i] == M:
            pv = c["albedo"][i]
        elif math.isfinite(c["albedoAssumed"][i]):
            pv = c["albedoAssumed"][i]
        else:
            obs["unusable"] += 1
            continue
        p = pv * r / rv
        c["geometricAlbedoXYZS"][i] = cie.xyzs(p * sun)
        c["gaiaBandsUsed"][i] = int(ok.sum())
        # The 374 and 858 nm edge bands (often flagged) may be bridged: their weight is measured by
        # edge_band_effect (< 0.5 % of XYZS). A gap inside 418-814 nm makes the colour estimated.
        bridged = not ok[1:GAIA_BANDS_FOR_CIE].all()
        derived = has_a[i] and not bridged
        c["colorLabel"][i] = D if derived else E
        c["colorSrc"][i] = src["gaia"]
        obs["derived" if derived else "estimated"] += 1
    obs["edgeBandEffectMax"] = edge_band_effect(g)
    return obs


def edge_band_effect(g: GaiaSpectra, limit: int = 2000) -> float:
    """Largest relative change of any XYZS channel when the 374 and 858 nm bands are dropped (the spectrum is then
    flat below 418 nm and above 814 nm: the bridging applied to flagged edge bands), over up to `limit` spectra whose
    bands 374-858 nm are all good. Bounds what bridging an edge band can do to a colour."""
    sun = solar.spectrum().grid
    need = np.arange(GAIA_BANDS_FOR_CIE + 1)
    good = np.nonzero(((g.flag[:, need] == 0) & np.isfinite(g.refl[:, need])).all(axis=1))[0][:limit]
    worst = 0.0
    for k in good:
        out = []
        for use in (need, need[1:-1]):
            r = spectrum_on_grid(g.wavelengths[use], g.refl[k, use])
            out.append(cie.xyzs(r / filters.band_average("V", cie.WAVELENGTHS, r) * sun))
        worst = max(worst, float(np.max(np.abs(out[1] / out[0] - 1.0))))
    return worst


# ---------------------------------------------------------------------------------------------- SsODNet
def _ssobft(ph: Physical, b: SsoBft, idx: dict[str, int], src: dict[str, int]) -> dict:
    """Phase function (H, G1, G2 and the phase-angle range it was fitted over), spin pole and taxonomy from ssoBFT.
    A phase function outside the H-G1-G2 constraints (G1 >= 0, G2 >= 0, G1 + G2 <= 1; Muinonen et al. 2010) is not a
    usable phase curve and is left unknown."""
    c = ph.cols
    filt, fac, tech, tax = {"": 0}, {"": 0}, {"": 0}, {"": 0}
    stats = {"matched": 0, "unmatched": 0, "phase": 0, "phaseOutsideConstraints": 0, "spin": 0, "taxonomy": 0,
             "taxonomySbdbAlreadyKnown": 0}
    for k in range(b.number.size):
        key = str(int(b.number[k])) if b.number[k] else str(b.name[k])
        i = idx.get(key)
        if i is None:
            stats["unmatched"] += 1
            continue
        stats["matched"] += 1
        g1, g2 = b.phase["G1"][k], b.phase["G2"][k]
        if b.phase_filter[k]:
            if g1 >= 0 and g2 >= 0 and g1 + g2 <= 1:
                for col, key2 in (("phaseH", "H"), ("phaseG1", "G1"), ("phaseG2", "G2"), ("phaseHSigma", "H_err"),
                                  ("phaseG1Sigma", "G1_err"), ("phaseG2Sigma", "G2_err"), ("phaseMinDeg", "phase_min"),
                                  ("phaseMaxDeg", "phase_max")):
                    c[col][i] = b.phase[key2][k]
                c["phaseN"][i] = min(int(b.phase["N"][k]), 65535)
                c["phaseFilter"][i] = filt.setdefault(str(b.phase_filter[k]), len(filt))
                c["phaseFacility"][i] = fac.setdefault(str(b.phase_facility[k]), len(fac))
                c["phaseLabel"][i], c["phaseSrc"][i] = M, src["bft"]
                stats["phase"] += 1
            else:
                stats["phaseOutsideConstraints"] += 1
        if math.isfinite(b.spin["RA0"][k]):
            c["poleRA"][i], c["poleDec"][i], c["spinPeriod"][i] = b.spin["RA0"][k], b.spin["DEC0"][k], b.spin["period"][k]
            c["spinTechnique"][i] = tech.setdefault(str(b.spin_technique[k]), len(tech))
            c["spinLabel"][i], c["spinSrc"][i] = M, src["bft"]
            stats["spin"] += 1
        if b.tax_class[k]:
            entry = f"{b.tax_scheme[k]}|{b.tax_class[k]}|{b.tax_technique[k]}"
            c["taxonomyBft"][i] = tax.setdefault(entry, len(tax))
            c["taxonomyBftLabel"][i], c["taxonomyBftSrc"][i] = M, src["bft"]
            stats["taxonomy"] += 1
            if c["taxonomyLabel"][i] == M:
                stats["taxonomySbdbAlreadyKnown"] += 1
    for lst, d in ((ph.phase_filters, filt), (ph.phase_facilities, fac), (ph.spin_techniques, tech),
                   (ph.taxonomy_bft, tax)):
        if len(d) > 255:
            raise ValueError("too many distinct ssoBFT codes for a u8 index")
        lst[:] = sorted(d, key=d.get)
    return stats
