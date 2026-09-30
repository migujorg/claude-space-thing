"""Physics of the `comets` stage: what the app needs to draw a comet's coma and tails in absolute light.

1. Spectral components, each integrated once against the CIE observers and the Bessell V passband (so the app mixes
   them without spectra): the dust continuum (sunlight x measured reddening, per unit A(theta)f rho geometry), and the
   gas emission bands, per erg cm^-2 s^-1 of band flux at the observer:
     C2 Delta v = 0 and CN (0-0) and C3: fluorescence efficiencies L/N (Lowell comet tools; A'Hearn et al. 1995;
       CN with the Swings effect, Schleicher 2010);
     C2 Delta v = +1 and CH: band strengths relative to C2 Delta v = 0 measured in flux-calibrated spectra
       at identical aperture offsets (McDonald faint comet survey, Cochran et al. 1992; median over observations);
     [O I] 630.0 / 636.4 nm: photons per water molecule from the O(1D) yields and branching ratios (Bhardwaj &
       Raghuram 2012);
     CO+ comet-tail bands (ion tail): L/N at 1 au (Rousselot et al. 2024).
2. Composition: per comet (where A'Hearn et al. 1995 measured it) and population medians of log Q(X)/Q(OH) and
   log A(theta)f rho / Q(OH) (blue continuum).
3. Spatial profiles: enclosed fraction of the projected Haser distribution of each daughter species (scale lengths
   from the Lowell tools, both scaling as r^2) as a function of rho / l_d.
4. Dust grains: beta(s) from the solar luminosity, GM_sun and c (Agarwal et al. 2007, Eq. 9) with Q_pr, density,
   size index and range from the literature; ejection speeds (Moreno & Jehin 2025).
5. Solar-wind speed (ion-tail aberration): median of the 2024 OMNI hourly speeds at 1 au.

Every result carries its sources; the app composes them at the comet's actual r, Delta and phase (render/comets).
"""

from __future__ import annotations

import math
from collections import defaultdict

import numpy as np
from scipy import integrate

from . import cie
from .photometry import filters, solar

AU_CM = 1.495978707e13
KM_CM = 1e5
ERG_PER_J = 1e7
H_PLANCK = 6.62607015e-34        # J s (SI defining constant)
C_M_S = 299792458.0              # m/s (SI defining constant)
L_SUN_W = 3.828e26               # IAU 2015 Resolution B3 nominal solar luminosity (source iau-2015-b3)

GRID = cie.WAVELENGTHS            # 360..830 nm, 1 nm


# ---------------------------------------------------------------------------------------------- spectra
def v_passband_on_grid() -> np.ndarray:
    fw, ft = filters.passband("V")
    return np.interp(GRID, fw, ft, left=0.0, right=0.0)


def _band_profile(lo_nm: float, hi_nm: float) -> np.ndarray:
    """Unit band flux (1 per nm-integrated) spread uniformly over [lo, hi] nm on the 1 nm grid (bin overlap)."""
    edges_lo = GRID - 0.5
    edges_hi = GRID + 0.5
    ov = np.clip(np.minimum(edges_hi, hi_nm) - np.maximum(edges_lo, lo_nm), 0.0, None)
    if ov.sum() <= 0:
        raise ValueError(f"band {lo_nm}-{hi_nm} nm outside the CIE grid")
    return ov / (hi_nm - lo_nm) / 1.0     # per nm (bins are 1 nm wide)


def _component(spec_w_m2_nm: np.ndarray, tv: np.ndarray, v_sun: float) -> dict:
    """XYZS (lux) and the V-band flux relative to the Sun at 1 au of a spectral irradiance on GRID."""
    x = cie.xyzs(spec_w_m2_nm)
    return {"xyzs": [float(t) for t in x], "v": float((spec_w_m2_nm * tv).sum() / v_sun)}


def dust_reflectance(col: dict, sun: dict) -> tuple[np.ndarray, dict]:
    """Relative reflectance R(lambda) of the dust (piecewise linear through the Bessell B, V, R, I effective
    wavelengths, from colour excesses over the Sun), normalised to 1 at 484.5 nm (the blue continuum of Afrho)."""
    lam = {b: filters.effective_wavelength(b) for b in "BVRI"}
    e_bv = col["BV"] - sun["BV"]
    e_vr = col["VR"] - sun["VR"]
    e_ri = col.get("RI", sun["RI"]) - sun["RI"]
    r = {"V": 1.0}
    r["B"] = 10 ** (-0.4 * e_bv)
    r["R"] = 10 ** (0.4 * e_vr)
    r["I"] = r["R"] * 10 ** (0.4 * e_ri)
    xs = np.array([lam[b] for b in "BVRI"])
    ys = np.array([r[b] for b in "BVRI"])
    refl = np.interp(GRID, xs, ys)
    lo = GRID < xs[0]
    refl[lo] = ys[0] + (GRID[lo] - xs[0]) * (ys[1] - ys[0]) / (xs[1] - xs[0])
    hi = GRID > xs[-1]
    refl[hi] = ys[-1] + (GRID[hi] - xs[-1]) * (ys[-1] - ys[-2]) / (xs[-1] - xs[-2])
    refl = np.clip(refl, 0.05, None)
    refl /= np.interp(484.5, GRID, refl)
    gradient = (np.interp(650.0, GRID, refl) - np.interp(450.0, GRID, refl)) / (
        0.5 * (np.interp(650.0, GRID, refl) + np.interp(450.0, GRID, refl))) / 2.0  # per 100 nm
    return refl, {"effectiveWavelengthsNm": {b: float(lam[b]) for b in "BVRI"}, "reflectanceAtBands": r,
                  "normalizedGradientPer100nm": float(gradient)}


def components(tabs: dict, mcd_ratios: dict, windows_nm: dict) -> dict:
    """Spectral components of the coma and the ion tail (see module doc)."""
    e_sun = solar.spectrum().grid                 # W m^-2 nm^-1 at 1 au
    tv = v_passband_on_grid()
    v_sun = float((e_sun * tv).sum())
    out = {"vSunUnits": "V-band flux relative to the Sun at 1 au (Bessell V, energy weighting)"}
    col = tabs["dustColour"]
    dust = {}
    for kind in ("longPeriod", "shortPeriod"):
        refl, info = dust_reflectance(col[kind], col["sun"])
        d = _component(e_sun * refl, tv, v_sun)
        d.update(info)
        dust[kind] = d
    out["dust"] = dust
    out["dustUnit"] = ("u = Afrho[cm] * rho[cm] / (4 r[au]^2 Delta[cm]^2): the continuum within projected radius rho "
                       "is u times these (Afrho in the blue continuum, 484.5 nm)")
    bands = {}
    per_erg = 1e-3                                  # 1 erg cm^-2 s^-1 = 1e-3 W m^-2
    for key, lohi in windows_nm.items():
        prof = _band_profile(*lohi) * per_erg
        c = _component(prof, tv, v_sun)
        c["windowNm"] = [float(lohi[0]), float(lohi[1])]
        bands[key] = c
    oi = tabs["oxygenRedDoublet"]
    for line, lam in oi["wavelengthsNm"].items():
        prof = _band_profile(lam - 0.5, lam + 0.5) * per_erg
        c = _component(prof, tv, v_sun)
        c["windowNm"] = [lam - 0.5, lam + 0.5]
        bands[f"OI{line}"] = c
    cp = tabs["coPlus"]
    for band, lines in cp["linesA"].items():
        lam = float(np.mean(lines)) / 10.0
        prof = _band_profile(lam - 0.5, lam + 0.5) * per_erg
        c = _component(prof, tv, v_sun)
        c["windowNm"] = [lam - 0.5, lam + 0.5]
        bands[f"COplus{band}"] = c
    out["bands"] = bands
    out["bandUnit"] = "1 erg cm^-2 s^-1 of band flux at the observer"
    out["sunV"] = {"vFlux1Au": v_sun, "xyzs1Au": [float(t) for t in cie.xyzs(e_sun)]}
    return out


# ---------------------------------------------------------------------------------------------- measured ratios
def mcdonald_band_ratios(rows: list[dict], rel_tol: float = 0.05) -> dict:
    """Median flux ratio F(band) / F(C2 Delta v = 0) over observations where both were measured at the same position
    in the coma: the band's aperture offset from the photocentre within rel_tol (relative) of C2's (the offsets of
    one exposure differ by band through atmospheric dispersion, ~1000 km). NH2 is not used: its column in fluxmc.tab
    holds positive logarithms, inconsistent with the stated unit (erg cm^-2 s^-1)."""
    ratios = defaultdict(list)
    for rec in rows:
        b = rec["bands"]
        if "C2(0)" not in b:
            continue
        e0, n0, f0 = b["C2(0)"]
        d0 = math.hypot(e0, n0)
        for k in ("C2(1)", "CH", "CN(0)", "C3"):
            if k not in b:
                continue
            d = math.hypot(b[k][0] - e0, b[k][1] - n0)
            if d <= 1.0 or (d0 > 0 and d / d0 <= rel_tol):
                ratios[k].append(10 ** (b[k][2] - f0))
    out = {}
    for k, v in ratios.items():
        a = np.array(v)
        out[k] = {"median": float(np.median(a)), "p16": float(np.percentile(a, 16)), "p84": float(np.percentile(a, 84)),
                  "n": int(a.size)}
    return out


def lowell_ratios(db: list[dict]) -> dict:
    """Per comet (key: periodic number or name) medians of log Q(X)/Q(OH) and log Afrho(blue)/Q(OH), and population
    medians of the per-comet values (A'Hearn et al. 1995 photometry)."""
    per = defaultdict(lambda: defaultdict(list))
    ident = {}
    for o in db:
        key = f"{o['periodic']}P" if o["periodic"] else f"{o['type']}/{o['iau']}"
        ident[key] = {"periodic": o["periodic"], "type": o["type"], "name": o["name"], "iau": o["iau"]}
        oh = o["LOG_Q_OH"]
        if oh is None:
            continue
        for k, name in (("LOG_Q_C2", "C2"), ("LOG_Q_CN", "CN"), ("LOG_Q_C3", "C3"), ("LOG_AFRHO_B_CONT", "afrho")):
            if o[k] is not None:
                per[key][name].append(o[k] - oh)
        per[key]["rAu"].append(o["r"])
    comets = {}
    for key, d in per.items():
        if not d:
            continue
        c = {k: float(np.median(v)) for k, v in d.items() if k != "rAu" and v}
        c["n"] = {k: len(v) for k, v in d.items() if k != "rAu"}
        c["rRangeAu"] = [float(min(d["rAu"])), float(max(d["rAu"]))]
        comets[key] = ident[key] | c
    pop = {}
    for k in ("C2", "CN", "C3", "afrho"):
        vals = np.array([c[k] for c in comets.values() if k in c])
        pop[k] = {"median": float(np.median(vals)), "p16": float(np.percentile(vals, 16)),
                  "p84": float(np.percentile(vals, 84)), "n": int(vals.size)}
    return {"comets": comets, "population": pop}


# ---------------------------------------------------------------------------------------------- Haser
def haser_enclosed(lp_over_ld: float, x: np.ndarray) -> np.ndarray:
    """Fraction of all daughters (Haser 1957, parent scale l_p, daughter scale l_d) whose projected distance from the
    nucleus is < rho, for x = rho / l_d. Volume density n(r) ∝ (exp(-r/l_d) - exp(-r/l_p)) / r^2; the enclosed
    projected fraction is 1 - (fraction outside the cylinder), computed as
      F(rho) = 1 - int_0^inf n(r) 4 pi r^2 P(r, rho) dr / N,  P(r, rho) = sqrt(1 - rho^2/r^2) for r > rho
    (the part of the shell of radius r projected outside rho)."""
    k = lp_over_ld
    norm = 1.0 - k                 # int_0^inf (e^{-u} - e^{-u/k}) du with u = r/l_d
    out = np.empty_like(x)
    for i, xi in enumerate(x):
        f = lambda u: (math.exp(-u) - math.exp(-u / k)) * math.sqrt(max(0.0, 1.0 - (xi / u) ** 2))
        val, _ = integrate.quad(f, xi, np.inf, limit=400)
        out[i] = 1.0 - val / norm
    return np.clip(out, 0.0, 1.0)


def haser_tables(scales: dict, species: tuple[str, ...]) -> dict:
    x = np.logspace(-4, 2, 121)
    tabs = {}
    for s in species:
        lp, ld = scales[s]["parent"], scales[s]["daughter"]
        tabs[s] = {"parentKm1Au": lp, "daughterKm1Au": ld, "log10X": [float(t) for t in np.log10(x)],
                   "enclosed": [float(t) for t in haser_enclosed(lp / ld, x)]}
    return tabs


# ---------------------------------------------------------------------------------------------- dust grains
def beta_of_radius(s_m: np.ndarray, gm_sun_km3_s2: float, rho: float, qpr: float) -> np.ndarray:
    """beta = 3 L Q_pr / (16 pi c G M rho s) (Agarwal et al. 2007, Eq. 9)."""
    gm = gm_sun_km3_s2 * 1e9
    return 3.0 * L_SUN_W * qpr / (16.0 * math.pi * C_M_S * gm * rho * s_m)


def grains(tabs: dict, gm_sun: float) -> dict:
    g = tabs["dustGrains"]
    rho, qpr = g["densityKgM3"], g["qPr"]
    s_max = (3.0 * g["massMaxKg"] / (4.0 * math.pi * rho)) ** (1.0 / 3.0)
    b_max = float(beta_of_radius(np.array([g["radiusMinM"]]), gm_sun, rho, qpr)[0])
    b_min = float(beta_of_radius(np.array([s_max]), gm_sun, rho, qpr)[0])
    cpr_equiv = b_max * 2.0 * rho * g["radiusMinM"] / qpr
    ej = tabs["dustEjection"]
    return {
        "betaMin": b_min, "betaMax": b_max, "radiusMaxM": s_max, "radiusMinM": g["radiusMinM"],
        # cross-section-weighted distribution in beta: n(s) ∝ s^k, sigma ∝ s^2, beta ∝ 1/s => dSigma/dbeta ∝ beta^(-k-4)
        "crossSectionBetaExponent": -g["sizeIndex"] - 4.0,
        "sizeIndex": g["sizeIndex"], "densityKgM3": rho, "qPr": qpr,
        "cprEquivalentKgM2": cpr_equiv,
        "cprMorenoJehinKgM2": 1.191e-3,
        "ejection": {"v0KmS": ej["v0KmS"], "gamma": ej["gamma"], "Gamma": ej["Gamma"]},
    }


def dust_phase(a_deg: np.ndarray, p: np.ndarray) -> dict:
    return {"phaseDeg": [float(t) for t in a_deg], "value": [float(t) for t in p]}


# ---------------------------------------------------------------------------------------------- gas / ion
def oxygen_photons_per_h2o(tabs: dict) -> float:
    o = tabs["oxygenRedDoublet"]
    return o["yieldO1DFromH2O"] + o["yieldOHFromH2O"] * o["yieldO1DFromOH"]


def photon_energy_erg(lam_nm: float) -> float:
    return H_PLANCK * C_M_S / (lam_nm * 1e-9) * ERG_PER_J


def co_plus(tabs: dict) -> dict:
    cp = tabs["coPlus"]
    g = np.array(cp["gErgPerSIon1Au"])
    total = float(g.sum())
    g20, g30 = float(g[2, 0]), float(g[3, 0])
    lo, hi = tabs["coAbundance"]["rangeFraction"]
    return {"gTotalErgPerSIon1Au": total, "share": {"(2,0)": g20 / (g20 + g30), "(3,0)": g30 / (g20 + g30)},
            "coPerH2O": float(math.sqrt(lo * hi))}


def cn_gfactor_table(gf: list[dict]) -> dict:
    """CN and C2, C3 L/N at 1 au versus heliocentric radial velocity (r = 1 au rows of the Lowell grid)."""
    rows = sorted([g for g in gf if g["r"] == 1.0], key=lambda g: g["v"])
    uniq = {}
    for g in rows:
        uniq[g["v"]] = g
    rows = [uniq[v] for v in sorted(uniq)]
    return {"vKmS": [g["v"] for g in rows], "CN": [g["CN"] for g in rows], "C2": rows[0]["C2"], "C3": rows[0]["C3"]}
