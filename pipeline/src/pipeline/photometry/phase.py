"""Disk-integrated phase curves -> schema `PhaseFunction`s (docs/architecture.md §4.3: E(α) = E(0)·Φ(α), Φ(0) = 1).

Sources:
  Mercury..Neptune  Mallama & Hilton (2018) V-band equations (tables/mallama_hilton_2018.json), checked against the
                    authors' reference code Ap_Mag_V3.f90.
  Moon              ROLO model (Kieffer & Stone 2005; photometry/rolo.py) for 1.55-97°, Lane & Irvine (1973) Table V
                    V passband (tables/lane_irvine_1973_phase.csv) joined to it for 97-120°.
  Pluto             Buie et al. (2010) linear V phase coefficient over 0.36-1.74 deg (tables/buie_2010a_pluto.json).

`deltaMag`/`coeffs` are magnitudes added to the zero-phase magnitude, so Φ(α) = 10^(-0.4 Δm(α)).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from ..schema import BuildContext, Label
from .common import Download, read_table_csv, read_table_json

APMAG_CODE = Download(
    id="mallama-hilton-2018",
    url="https://sourceforge.net/projects/planetary-magnitudes/files/Ap_Mag_Current_Version/Ap_Mag_V3.f90/download",
    subdir="papers", name="Ap_Mag_V3.f90",
    title="Planetary V-magnitude equations for The Astronomical Almanac (paper Eqs. 2-17 and reference code Ap_Mag V3)",
    citation="Mallama, A. & Hilton, J. L. (2018). Computing apparent planetary magnitudes for The Astronomical "
             "Almanac. Astronomy and Computing 25, 10-24. DOI:10.1016/j.ascom.2018.08.002 (arXiv:1808.01973). "
             "Reference implementation Ap_Mag_V3.f90, https://sourceforge.net/projects/planetary-magnitudes/.",
    version="Ap_Mag V3 (2018-03-13)",
    notes="Equations transcribed from the paper into pipeline/src/pipeline/photometry/tables/mallama_hilton_2018.json; "
          "every coefficient is checked to appear in this Fortran file (the sha256 is of the Fortran file). The "
          "underlying observations: Mercury SOHO/LASCO + ground (Mallama et al. 2002), Venus SOHO + ground (Mallama "
          "et al. 2006), Mars (Mallama 2007), Jupiter ground + Cassini ISS (Mallama & Schmude 2012; Mayorga et al. "
          "2016), Saturn (Mallama 2012; Dyudina et al. 2005 model), Uranus (Schmude et al. 2015; Voyager, Pearl et "
          "al. 1990), Neptune (Schmude et al. 2016; Voyager, Pearl & Conrath 1991).",
)

LANE_IRVINE = Download(
    id="lane-irvine-1973",
    url="https://articles.adsabs.harvard.edu/pdf/1973AJ.....78..267L", subdir="papers", name="1973AJ.....78..267L.pdf",
    title="Monochromatic phase curves and albedos for the lunar disk (Tables I, V, VII, VIII)",
    citation="Lane, A. P. & Irvine, W. M. (1973). Monochromatic phase curves and albedos for the lunar disk. "
             "Astronomical Journal 78, 267-277. DOI:10.1086/111414.",
    notes="Photoelectric photometry of the whole lunar disk, Le Houga Observatory 1964-1965, 9 narrow bands "
          "(359-1064 nm) + UBV, phase angles 6-120 deg. Tables transcribed to photometry/tables/lane_irvine_1973*.csv "
          "(docs/sources/lane-irvine-1973.md). Albedos and phase curves exclude the opposition effect (linear "
          "extrapolation from i >= 6 deg).",
)

BUIE = Download(
    id="buie-2010a",
    url="https://iopscience.iop.org/article/10.1088/0004-6256/139/3/1117/pdf", subdir="papers",
    name="Buie2010_AJ139_1117.pdf",
    title="Pluto and Charon with the Hubble Space Telescope. I. Light curves (Tables 7, 8, 12; phase coefficients)",
    citation="Buie, M. W., Grundy, W. M., Young, E. F., Young, L. A. & Stern, S. A. (2010). Pluto and Charon with the "
             "Hubble Space Telescope. I. Monitoring global change and improved surface properties from light curves. "
             "Astronomical Journal 139, 1117-1127. DOI:10.1088/0004-6256/139/3/1117.",
    notes="HST ACS/HRC B and V photometry of Pluto and Charon separately, 2002-2003, phase 0.36-1.74 deg. Numbers "
          "transcribed to photometry/tables/buie_2010a_pluto.json (docs/sources/buie-2010a.md).",
    browser_agent=True,
    sha256="89b6dd0c8fdf1fb9c0f32db27aa6147054ae12a90fbc105fc32a9e961f162bb5", retrieved="2026-09-30",
)

MH = read_table_json("mallama_hilton_2018.json")


# ---------------------------------------------------------------------------------------------- M&H equations
def _piece_mag(piece: dict, a: float) -> float:
    c = piece["coeffs"]
    if piece["kind"] == "poly":
        return piece["const"] + sum(ci * a ** i for i, ci in enumerate(c))
    if piece["kind"] == "logpoly180":
        x = a / 180.0
        return piece["const"] - 2.5 * math.log10(sum(ci * x ** i for i, ci in enumerate(c)))
    raise ValueError(piece["kind"])


def mh_reduced_mag(naif: int, alpha: float, *, phi_prime: float = 0.0, year: float = 2026.0,
                   rings_beta: float | None = None, as_coded: bool = False) -> float | None:
    """V(1, α) from Mallama & Hilton (2018). `as_coded` reproduces Ap_Mag_V3.f90's choices where it differs from a
    continuous reading of the paper (Uranus/Neptune phase term only beyond the geocentric limit). For Saturn,
    `rings_beta` (deg, effective ring inclination) selects Eq. 10 (globe + rings) where it applies. Mars omits the
    L(λe), L(Ls) terms. Returns None outside the equations' domain."""
    b = MH["bodies"][str(naif)]
    if naif == 699 and rings_beta is not None:
        e = b["rings_eq10"]
        if alpha <= e["max_alpha_deg"] and rings_beta <= e["max_beta_deg"]:
            sb = math.sin(math.radians(rings_beta))
            return e["const"] + e["sin_beta"] * sb + e["alpha"] * alpha + e["sin_beta_exp"] * sb * math.exp(
                e["exp_rate"] * alpha)
    pieces = b["pieces"]
    if alpha < 0 or alpha > pieces[-1]["max_deg"]:
        return None
    piece = next(p for p in pieces if alpha <= p["max_deg"])
    if naif == 799:
        base = b["V10_zero_phase"] + b["latitude_coeff_per_deg"] * phi_prime
        if as_coded and alpha <= 3.1:
            return base
        return base + _piece_mag(piece, alpha) - piece["const"]
    if naif == 899:
        if year <= 2000.0:
            return None  # Eq. 16 pre-2000 branches are not needed in the v1 window
        if as_coded and alpha <= 1.9:
            return piece["const"]
        return _piece_mag(piece, alpha)
    return _piece_mag(piece, alpha)


# Known, documented differences between the paper (which we transcribe) and Ap_Mag_V3.f90.
PAPER_VS_CODE = {("699", "12", 3): -1.506e-06}


def verify_against_code() -> list[str]:
    """Every coefficient in the transcription must appear in the downloaded Ap_Mag_V3.f90 (returns problems)."""
    text = APMAG_CODE.fetch().read_text(errors="replace")
    nums = {float(m.group().lower().replace("d", "e"))
            for m in re.finditer(r"(?<![\w.])[-+]?\d+\.\d*(?:[eEdD][-+]?\d+)?", text)}
    nums |= {-x for x in nums}
    problems = []

    def check(v, where, key=None):
        if v in (0.0, 1.0):
            return
        if key in PAPER_VS_CODE:
            v = PAPER_VS_CODE[key]
        if not any(math.isclose(v, n, rel_tol=1e-9, abs_tol=0) for n in nums):
            problems.append(f"{where}: {v!r} not found in Ap_Mag_V3.f90")

    for naif, b in MH["bodies"].items():
        for p in b["pieces"]:
            check(p["const"], f"{naif} Eq.{p['eq']} const")
            for i, c in enumerate(p["coeffs"]):
                check(c, f"{naif} Eq.{p['eq']} c{i}", (naif, p["eq"], i))
        if "rings_eq10" in b:
            for k in ("const", "sin_beta", "alpha", "sin_beta_exp", "exp_rate"):
                check(b["rings_eq10"][k], f"{naif} Eq.10 {k}")
    return problems


# ---------------------------------------------------------------------------------------------- schema objects
@dataclass(frozen=True)
class Phase:
    function: dict           # schema PhaseFunction
    label: Label
    sources: list[str]
    method: str
    uncertainty: str | None = None
    zero_phase_V10: float | None = None   # published V(1,0) this curve is normalized to (for consistency checks)


def _tabulate(fn, amax: float, breaks: tuple[float, ...] = (), step: float = 0.5) -> dict:
    grid = sorted(set(np.round(np.arange(0.0, amax + 1e-9, step), 6).tolist()) | set(breaks) | {amax})
    return {"kind": "tabulated", "alphaDeg": [float(a) for a in grid], "deltaMag": [round(float(fn(a)), 5) for a in grid]}


def _mh_delta(naif: int, zero: float):
    return lambda a: mh_reduced_mag(naif, a) - zero


@lru_cache(maxsize=None)
def _lane_irvine_phase() -> tuple[list[float], list[float]]:
    rows = read_table_csv("lane_irvine_1973_phase.csv")
    return [float(r["phase_deg"]) for r in rows], [float(r["V"]) for r in rows]


def phase_for(naif: int, ctx: BuildContext | None = None) -> Phase:
    src_mh = APMAG_CODE.register(ctx) if ctx else APMAG_CODE.id
    mh_note = ("Mallama & Hilton (2018) V-band magnitude equations for The Astronomical Almanac, normalized to their "
               "zero-phase value.")
    if naif == 199:
        b = MH["bodies"]["199"]
        p = b["pieces"][0]
        c0 = round(p["const"] - b["V10_zero_phase"], 6)
        return Phase({"kind": "poly-mag", "coeffs": [c0, *p["coeffs"][1:]], "minDeg": 2.0, "maxDeg": 170.0},
                     "measured", [src_mh],
                     f"{mh_note} Eq. 2 (sixth-order fit to SOHO/LASCO and ground photometry, 2 < α < 170°). Its "
                     f"constant term (-0.613) excludes the opposition surge; the zero-phase reference is the "
                     f"surge-inclusive -0.694 (Mallama et al. 2002 physical model, as used for p_V = 0.142 by Mallama "
                     f"et al. 2017), so c0 = +{c0}: the curve is valid only for 2° ≤ α ≤ 170° and Φ(0) = 1 is not "
                     f"part of its domain.",
                     "fit rms ~0.05 mag", zero_phase_V10=b["V10_zero_phase"])
    if naif == 299:
        z = MH["bodies"]["299"]["V10_zero_phase"]
        return Phase(_tabulate(_mh_delta(299, z), 179.0, (163.7,)), "measured", [src_mh],
                     f"{mh_note} Eq. 3 (α < 163.7°) and Eq. 4 (163.7-179°) from SOHO/LASCO and ground CCD photometry "
                     "(2 < α < 179°), including the glory near 0° and the forward-scattering excess near 170°. "
                     "Tabulated every 0.5° (interpolation error < 0.002 mag).", zero_phase_V10=z)
    if naif == 399:
        from . import earth
        return earth.earth_phase(ctx)
    if naif == -399:          # Mallama & Hilton's own normalization (kept for comparisons)
        b = MH["bodies"]["399"]
        p = b["pieces"][0]
        return Phase({"kind": "poly-mag", "coeffs": list(p["coeffs"]), "minDeg": 0.0, "maxDeg": 170.0}, "estimated",
                     [src_mh],
                     f"{mh_note} Eq. 5 is a spline fit to the 'realistic clouds' radiative-transfer model of Tinetti "
                     "et al. (2006), not to observations of Earth's disk-integrated phase curve; Earth's real phase "
                     "behaviour varies with cloud cover.", zero_phase_V10=b["V10_zero_phase"])
    if naif == 499:
        z = MH["bodies"]["499"]["V10_zero_phase"]
        return Phase(_tabulate(_mh_delta(499, z), 120.0, (50.0,)), "estimated", [src_mh],
                     f"{mh_note} 0-50°: Eq. 6, fit to ground photometry (Mallama 2007) - measured. 50-120°: Eq. 7, "
                     "the authors' approximation averaging the Mercury and Earth curves (no observations) - an "
                     "assumption, hence 'estimated' for the whole curve. The rotational L(λe) (rms 0.035 mag) and "
                     "seasonal L(Ls) terms are not represented. Tabulated every 0.5°.", zero_phase_V10=z)
    if naif == 599:
        z = MH["bodies"]["599"]["V10_zero_phase"]
        return Phase(_tabulate(_mh_delta(599, z), 130.0, (12.0,)), "measured", [src_mh],
                     f"{mh_note} Eq. 8 (0-12°, ground photometry, Mallama & Schmude 2012) and Eq. 9 (12-130°, Cassini "
                     "ISS green-filter phase curve of Mayorga et al. 2016, offset for continuity at 12°). Tabulated "
                     "every 0.5°.", "few hundredths of a magnitude intrinsic variability (belts)", zero_phase_V10=z)
    if naif == 699:
        z = MH["bodies"]["699"]["V10_zero_phase"]
        return Phase(_tabulate(_mh_delta(699, z), 150.0, (6.5,)), "estimated", [src_mh],
                     f"{mh_note} Globe without rings. 0-6.5°: Eq. 11, which adopts Jupiter's phase polynomial for "
                     "Saturn's globe (assumption). 6.5-150°: Eq. 12, a fit to the Pioneer-based scattering model of "
                     "Dyudina et al. (2005) for red light (a model). Tabulated every 0.5°. Ring shadows, ring "
                     "occultation and ringshine are not included.", zero_phase_V10=z)
    if naif == 799:
        p = MH["bodies"]["799"]["pieces"][0]
        return Phase({"kind": "poly-mag", "coeffs": list(p["coeffs"]), "minDeg": 0.0, "maxDeg": 154.0}, "measured",
                     [src_mh],
                     f"{mh_note} Eq. 15 phase term: second-order fit to Voyager 2 radiometer phase data (Pearl et al. "
                     "1990). Applied at all α here; Ap_Mag_V3/Horizons apply it only above α = 3.1°, so at "
                     "Earth-visible phase angles this curve is up to 0.021 mag fainter than theirs. The latitude "
                     "term -8.4e-4·φ′ of V1(0) is a property of the albedo, not of Φ.",
                     zero_phase_V10=MH["bodies"]["799"]["V10_zero_phase"])
    if naif == 899:
        p = MH["bodies"]["899"]["pieces"][0]
        return Phase({"kind": "poly-mag", "coeffs": list(p["coeffs"]), "minDeg": 0.0, "maxDeg": 133.14}, "measured",
                     [src_mh],
                     f"{mh_note} Eq. 17 phase term: second-order fit to Voyager 2 radiometer data (Pearl & Conrath "
                     "1991), valid to the last direct full-disk measurement at 133.14°. Applied at all α here; "
                     "Ap_Mag_V3/Horizons apply it only above α = 1.9° (≤ 0.015 mag difference).",
                     zero_phase_V10=MH["bodies"]["899"]["V10_zero_phase"])
    if naif == 301:
        return _moon(ctx)
    if naif == 999:
        src = BUIE.register(ctx) if ctx else BUIE.id
        t = read_table_json("buie_2010a_pluto.json")["pluto"]
        return Phase({"kind": "poly-mag", "coeffs": [0.0, t["beta_V_mag_per_deg"]], "minDeg": 0.0,
                      "maxDeg": t["phase_range_deg"][1]}, "measured", [src],
                     f"Buie et al. (2010) linear V phase coefficient β = {t['beta_V_mag_per_deg']} ± "
                     f"{t['beta_V_err']} mag/deg for Pluto alone (HST ACS/HRC, 2002-2003), observed over "
                     f"{t['phase_range_deg'][0]}-{t['phase_range_deg'][1]}°. Their Hapke fit puts the 1°→0° step at "
                     "0.0398 mag (used for the albedo) vs 0.0355 from β: a 0.004 mag inconsistency at α < 1°. "
                     "Beyond 1.74° (any viewpoint off the Earth-Sun line) Pluto's phase curve is not represented "
                     "here (New Horizons phase curves were not available in machine-usable form).",
                     f"±{t['beta_V_err']} mag/deg")
    raise KeyError(naif)


def _moon(ctx: BuildContext | None) -> Phase:
    """ROLO (Kieffer & Stone 2005) for 1.55-97°, Lane & Irvine's (1973) shape beyond, relative to the ROLO reference
    albedo at 1.55° that geometricAlbedoXYZS holds (photometry/rolo.py)."""
    from . import rolo
    from .. import cie
    from . import solar
    src_li = LANE_IRVINE.register(ctx) if ctx else LANE_IRVINE.id
    src_rolo = rolo.ROLO.register(ctx) if ctx else rolo.ROLO.id
    common = ([solar.HSRS.register(ctx), *cie.register_sources(ctx)] if ctx else
              [solar.HSRS.id, cie.SOURCE_CMF, cie.SOURCE_SCOTOPIC])
    p_y = rolo.reference_py()
    a, dm = _lane_irvine_phase()
    t = rolo.phase_table(p_y, a, dm)
    fn = t["function"]
    m = rolo.channel_model()
    return Phase(
        fn, "estimated", [src_rolo, src_li, *common],
        "Φ(α) = A_Y(α)/p_Y. 1.55° ≤ α ≤ 97°: A_Y is the ROLO whole-Moon reflectance (Kieffer & Stone 2005 Eq. 10, "
        "version 311g, fitted to USGS Robotic Lunar Observatory photometry in 32 bands; see diskReflectanceModel, "
        "which also has libration and waxing/waning) for the Y channel at zero libration, geometric mean of the "
        "waxing and waning Moon (the waxing Moon is brighter: "
        f"{m.ln_a(60.0, 60.0)[1] - m.ln_a(60.0, -60.0)[1]:.2f} in ln A at 60°), "
        f"divided by the same at 1.55°, p_Y = {p_y:.4f}, the reference of geometricAlbedoXYZS (so Φ(1.55°) = 1). "
        "It includes the opposition surge down to 1.55°. "
        "97-120°: Lane & Irvine's (1973) measured V curve (Table V), shifted by "
        f"{t['tail_shift_mag']:+.3f} mag to join ROLO at 97° (assumption: their shape with ROLO's level; hence "
        "'estimated' for the whole curve). Tabulated (linear interpolation in magnitudes, error < 0.002 mag). Below "
        "1.55° (eclipse geometry from Earth) and beyond 120° the curve is unknown. As a single α-only curve it "
        "describes the near side as seen from Earth.",
        "ROLO: mean absolute fit residual 0.0096 in ln A; absolute scale uncertain by several percent (paper Sec. "
        "4.3, 5). Beyond 97°: Lane & Irvine ~0.05 mag per observation plus the join. Libration changes the "
        "brightness by up to 7 % or more over a Saros cycle (paper Sec. 4.1) and waxing vs waning by ~10 % at 60° (use "
        "diskReflectanceModel for those).",
        zero_phase_V10=None)


def delta_mag(pf: dict, alpha: float) -> float | None:
    """Evaluate a schema PhaseFunction (magnitudes added to the zero-phase magnitude); None outside its domain."""
    if pf["kind"] == "poly-mag":
        if alpha < pf["minDeg"] - 1e-9 or alpha > pf["maxDeg"] + 1e-9:
            return None
        return float(sum(c * alpha ** i for i, c in enumerate(pf["coeffs"])))
    if pf["kind"] == "tabulated":
        a, d = pf["alphaDeg"], pf["deltaMag"]
        if alpha < a[0] or alpha > a[-1]:
            return None
        return float(np.interp(alpha, a, d))
    if pf["kind"] == "lambert":
        x = math.radians(alpha)
        return -2.5 * math.log10((math.sin(x) + (math.pi - x) * math.cos(x)) / math.pi)
    raise ValueError(pf["kind"])
