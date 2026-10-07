"""Saturn's ring reflectance: measured I/F (Voyager ISS radial profiles, HST regional phase curves) and a
single-scattering ring model calibrated on them (rings.json, schema `RingReflectance*`).

Measured inputs
  * Voyager ISS clear-filter radial I/F profiles, PDS Ring-Moon Systems Node volume VG_2810 (Showalter & Gordon 2004):
    Voyager 2 lit face (α = 47°, Sun 8.05° and observer 23.3° above the ring plane) and Voyager 1 unlit face
    (α = 46.6°, Sun 3.87° above, observer 11.9° below), 10 km bins.
  * HST WFPC2 phase curves of the lit face in 5 filters (336-814 nm) for three ring regions at six effective
    elevations 4.5-26.1°, as log-linear fits I/F = a ln α + b over 0.25-6.3° (Salo & French 2010, Table 4).
  * Normal optical depth τ⊥(r) from the Cassini UVIS occultation already in rings.json (rings.py).

Model (estimated): the classical single-scattering reflection and transmission of a many-particle-thick ring layer
(Chandrasekhar 1960; the form Salo & French 2010 use in their Eq. 6 and Cuzzi et al. 2002 use for their geometric
correction), with the product ϖP(α) of particle albedo and phase function taken from the data:

  lit face    I/F = A(r) · W_c(r; α, Beff) · μ0/(4(μ+μ0)) · [1 − exp(−τ(r)(1/μ + 1/μ0))]
  unlit face  I/F = A(r) · g_u(r) · W_c(r; α, Beff) · μ0/(4|μ−μ0|) · |exp(−τ_u(r)/μ) − exp(−τ_u(r)/μ0)|

with μ = |sin B| (observer), μ0 = |sin B′| (Sun), sin Beff = 2μμ0/(μ+μ0).
  * W_c(region; α, Beff): ϖP per CIE channel (solar-weighted X, Y, Z, scotopic) for the C, B and A ring regions.
    For α ≤ 6.3° it is the HST photometry inverted through the single-scattering formula (with the region's UVIS τ)
    and reconstructed across wavelength piecewise-linearly through the 5 filters. For 6.3° < α ≤ 47° it follows a
    power-law particle phase function P ∝ (π − α)^n (the Callisto-like form of Dones et al. 1993 used by Salo &
    French 2010 with n = 3.09), n per region chosen so that the model reproduces the region's mean Voyager 2 lit I/F
    at 47°. Between the regions W is interpolated linearly in radius from one region's edge to the next; outside
    them the nearest region's is used.
  * A(r): radial modulation from the Voyager 2 lit profile (the model reproduces it bin by bin at its geometry).
  * τ_u(r), g_u(r): for the unlit face, an effective optical depth and gain chosen so that the model reproduces the
    Voyager 1 unlit profile bin by bin (in the thick B ring light leaks through by multiple scattering and between
    self-gravity wakes, so τ_u < τ).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from .. import cie
from ..schema import BuildContext, sourced
from . import albedo, filters, solar
from .common import Download, bin_average, read_table_csv

_VG2810 = "https://pds-rings.seti.org/holdings/volumes/VG_28xx/VG_2810/DATA/"
VG_CITATION = ("Showalter, M. R. & Gordon, M. K. (2004). VG1/VG2 SR ISS RING PROFILES V1.0 (data set "
               "VG1/VG2-SR-ISS-4-PROFILES-V1.0), NASA Planetary Data System Ring-Moon Systems Node, volume VG_2810. "
               "Instrument: Smith, B. A. et al. (1977), Voyager imaging experiment, Space Science Reviews 21, 103-127, "
               "DOI:10.1007/BF00200847.")


def _vg_pair(stem: str, what: str) -> tuple[Download, Download]:
    notes = ("Radial profile of the ring I/F built from navigated, calibrated Voyager narrow-angle clear-filter images "
             "(VICAR FICOR77 calibration, ~5 km/pixel), spliced and aligned to the Voyager PPS occultation "
             "(volume DOCUMENT/PROFILES.TXT). Columns: radius (km), I/F, number of pixels averaged.")
    return (Download(id=f"vg2810-{stem.lower()}-label", url=f"{_VG2810}{stem}.LBL", subdir="rings", name=f"{stem}.LBL",
                     title=f"{what} (PDS label)", citation=VG_CITATION, notes=notes),
            Download(id=f"vg2810-{stem.lower()}", url=f"{_VG2810}{stem}.TAB", subdir="rings", name=f"{stem}.TAB",
                     title=what, citation=VG_CITATION, notes=notes))


VG_LIT = _vg_pair("IS2_P0001_V01_KM010", "Saturn ring I/F, lit face, Voyager 2 ISS clear filter, 1981-08-25, 10 km")
VG_UNLIT = _vg_pair("IS1_P0001_V01_KM010", "Saturn ring I/F, unlit face, Voyager 1 ISS clear filter, 1980-11-12, 10 km")

SALO_FRENCH = Download(
    id="salo-french-2010", url="https://arxiv.org/pdf/1007.0349v1", subdir="papers", name="arXiv-1007.0349v1.pdf",
    title="HST WFPC2 phase curves of Saturn's C, B and A rings at six elevations (Table 4 log-linear fits)",
    citation="Salo, H. & French, R. G. (2010). The opposition and tilt effects of Saturn's rings from HST "
             "observations. Icarus 210, 785-816. DOI:10.1016/j.icarus.2010.07.002 (accepted manuscript "
             "arXiv:1007.0349v1). Data: Cuzzi, French & Dones (2002), Icarus 158, 199; French et al. (2007a), Icarus "
             "189, 493; French et al. (2007b), PASP 119, 623.",
    notes="Table 4 (with Table 5 as a check) transcribed to photometry/tables/salo_french_2010_table4.csv "
          "(docs/sources/salo-french-2010.md).")

HST_FILTERS = ("F336W", "F439W", "F555W", "F675W", "F814W")
REGIONS = {"C": ("C ring", 78000.0, 83000.0), "B": ("B ring", 100000.0, 107000.0), "A": ("A ring", 127000.0, 129000.0)}
POWER_LAW_PUBLISHED = 3.09          # Salo & French (2010) Sec. 3.2, "a good match to the phase function of Callisto"
HST_MIN_PHASE, HST_MAX_PHASE = 0.25, 6.3
PHASE_GRID = (0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 6.3, 8.0, 10.0, 12.5,
              15.0, 20.0, 25.0, 30.0, 35.0, 40.0, 47.0)
MAX_PHASE = 47.0                    # the Voyager anchor; beyond, the ring photometry is unknown here
GAP_TAU = 0.01                      # below this UVIS optical depth a bin is treated as an empty gap


# ---------------------------------------------------------------------------------------------- inputs
@dataclass
class VoyagerProfile:
    radius: np.ndarray
    iof: np.ndarray
    pixels: np.ndarray
    phase: float
    solar_elev: float        # degrees above the ring plane on the lit side
    obs_elev: float          # degrees; positive = lit side, negative = unlit side
    side: str
    start: str
    spacecraft: str
    sources: list[str]


def _num(v: str) -> float:
    return float(v.split("/*")[0].split()[0])


def voyager_profile(pair, ctx: BuildContext | None = None) -> VoyagerProfile:
    lbl, tab = pair
    text = lbl.fetch().read_text(errors="replace", encoding="utf-8")
    meta = {m.group(1): m.group(2).strip() for m in re.finditer(r"^\s*([A-Z_]+)\s*=\s*(.+?)\s*$", text, flags=re.M)}
    d = np.loadtxt(tab.fetch(), delimiter=",")
    inc, emi = _num(meta["INCIDENCE_ANGLE"]), _num(meta["EMISSION_ANGLE"])
    return VoyagerProfile(d[:, 0], d[:, 1], d[:, 2], _num(meta["PHASE_ANGLE"]), 90.0 - inc, 90.0 - emi,
                          "lit" if emi < 90.0 else "unlit", meta["START_TIME"], meta["SPACECRAFT_NAME"].strip('"'),
                          [lbl.register(ctx) if ctx else lbl.id, tab.register(ctx) if ctx else tab.id])


@lru_cache(maxsize=1)
def hst_fits() -> dict[tuple[str, float, str], tuple[float, float]]:
    return {(r["region"], float(r["beff_deg"]), r["filter"]): (float(r["a"]), float(r["b"]))
            for r in read_table_csv("salo_french_2010_table4.csv")}


def hst_beffs() -> list[float]:
    return sorted({k[1] for k in hst_fits()})


def mu_eff(mu: float, mu0: float) -> float:
    return 2.0 * mu * mu0 / (mu + mu0)


def lit_geometry(tau, mu, mu0):
    return mu0 / (4.0 * (mu + mu0)) * (1.0 - np.exp(-np.asarray(tau) * (1.0 / mu + 1.0 / mu0)))


def unlit_geometry(tau, mu, mu0):
    """Single-scattering diffuse transmission of a slab (Sun and observer on opposite sides), per unit ϖP."""
    tau = np.asarray(tau, float)
    if abs(mu - mu0) < 1e-9:
        return tau / (4.0 * mu) * np.exp(-tau / mu)
    return mu0 / (4.0 * abs(mu - mu0)) * np.abs(np.exp(-tau / mu) - np.exp(-tau / mu0))


# ---------------------------------------------------------------------------------------------- spectra and channels
@lru_cache(maxsize=1)
def _channel_weights():
    e = solar.spectrum()
    return cie.xyzs(e.grid)


def channels(wl: np.ndarray, p: np.ndarray) -> np.ndarray:
    """Solar-weighted CIE channel averages of a reflectance spectrum: X, Y, Z, S of p·E☉ divided by those of E☉."""
    e = solar.spectrum()
    return cie.xyzs(bin_average(wl, p) * e.grid) / _channel_weights()


def region_tau(tau_r: np.ndarray, tau: np.ndarray, region: str) -> np.ndarray:
    _, lo, hi = REGIONS[region]
    r = np.arange(lo, hi + 1e-6, 10.0)
    return np.interp(r, tau_r, tau)


def hst_wp(region: str, beff: float, alpha: float, tau_reg: np.ndarray) -> dict[str, float]:
    """ϖP per HST filter: the geometrically corrected I/F = (ϖP/8)(1 − exp(−2τ/μeff)) inverted with the region's τ."""
    mue = math.sin(math.radians(beff))
    g = float(np.mean(1.0 - np.exp(-2.0 * tau_reg / mue)))
    out = {}
    for f in HST_FILTERS:
        a, b = hst_fits()[(region, beff, f)]
        out[f] = 8.0 * (a * math.log(alpha) + b) / g
    return out


def spectrum_from_filters(wp: dict[str, float]) -> tuple[np.ndarray, np.ndarray]:
    wl, p, _ = albedo.broadband_reconstruction({f"wfpc2.{f}": v for f, v in wp.items()}, wl_min=250.0)
    return wl, p


# ---------------------------------------------------------------------------------------------- the model
@dataclass
class RingModel:
    radius: np.ndarray
    tau: np.ndarray
    lit_mod: np.ndarray            # A(r), NaN where Voyager 2 did not cover
    unlit_tau: np.ndarray
    unlit_gain: np.ndarray
    phase: np.ndarray
    beff: np.ndarray
    w_xyzs: dict[str, np.ndarray]  # region -> [beff][phase][4]
    w_clear: dict[str, np.ndarray]  # region -> [beff][phase]
    n: dict[str, float]
    lit: VoyagerProfile
    unlit: VoyagerProfile
    region_check: dict[str, dict]


def _interp_regions(r: np.ndarray, values: dict[str, np.ndarray]) -> np.ndarray:
    """Region value inside each calibrated region; linear in radius between the edges of neighbouring regions; the
    nearest region's value outside them. Works for arrays of any trailing shape."""
    keys = sorted(values, key=lambda k: REGIONS[k][1])
    knots, vals = [], []
    for k in keys:
        knots += [REGIONS[k][1], REGIONS[k][2]]
        vals += [values[k], values[k]]
    knots = np.array(knots)
    stack = np.stack(vals)
    idx = np.clip(np.searchsorted(knots, r, side="right") - 1, 0, len(knots) - 2)
    span = knots[idx + 1] - knots[idx]
    t = np.clip((r - knots[idx]) / span, 0.0, 1.0)
    shape = (-1,) + (1,) * (stack.ndim - 1)
    return stack[idx] * (1 - t).reshape(shape) + stack[idx + 1] * t.reshape(shape)


def _lookup(table: np.ndarray, beffs: np.ndarray, phases: np.ndarray, beff: float, alpha: float) -> np.ndarray:
    """Bilinear interpolation of a [beff][phase](...) table (clamped in Beff)."""
    b = float(np.clip(beff, beffs[0], beffs[-1]))
    j = int(np.clip(np.searchsorted(beffs, b) - 1, 0, len(beffs) - 2))
    tb = (b - beffs[j]) / (beffs[j + 1] - beffs[j])
    k = int(np.clip(np.searchsorted(phases, alpha) - 1, 0, len(phases) - 2))
    ta = (alpha - phases[k]) / (phases[k + 1] - phases[k])
    row = lambda jj: table[jj, k] * (1 - ta) + table[jj, k + 1] * ta  # noqa: E731
    return row(j) * (1 - tb) + row(j + 1) * tb


@lru_cache(maxsize=1)
def build_model() -> RingModel:
    from . import rings
    _, _, prof = rings.saturn_profile(None)
    ok = np.isfinite(prof.tau)
    tau_r, tau_v = prof.radius[ok], np.clip(prof.tau[ok], 0.0, None)
    lit, unlit = voyager_profile(VG_LIT), voyager_profile(VG_UNLIT)

    beffs = np.array(hst_beffs())
    phases = np.array(PHASE_GRID)
    mu0_l, mu_l = math.sin(math.radians(lit.solar_elev)), math.sin(math.radians(abs(lit.obs_elev)))
    beff_l = math.degrees(math.asin(mu_eff(mu_l, mu0_l)))

    w_xyzs, w_clear, n, check = {}, {}, {}, {}
    for reg, (name, lo, hi) in REGIONS.items():
        treg = region_tau(tau_r, tau_v, reg)
        hst = np.full((len(beffs), len(phases)), np.nan)
        hst_c = np.full((len(beffs), len(phases), 4), np.nan)
        for j, be in enumerate(beffs):
            for k, al in enumerate(phases):
                if al > HST_MAX_PHASE:
                    continue
                wl, p = spectrum_from_filters(hst_wp(reg, be, al, treg))
                hst[j, k] = filters.band_average("voyager.nac.Clear", wl, p)
                hst_c[j, k] = channels(wl, p)
        # Voyager 2 lit anchor: region-mean ϖP at 47° in the clear band
        m = (lit.radius >= lo) & (lit.radius <= hi)
        geo = lit_geometry(np.interp(lit.radius[m], tau_r, tau_v), mu_l, mu0_l)
        wp_v = float(np.mean(lit.iof[m]) / np.mean(geo))
        k63 = int(np.searchsorted(phases, HST_MAX_PHASE))
        wp_h63 = float(np.interp(beff_l, beffs, hst[:, k63]))
        ratio = (math.pi - math.radians(lit.phase)) / (math.pi - math.radians(HST_MAX_PHASE))
        n[reg] = math.log(wp_v / wp_h63) / math.log(ratio)
        for k, al in enumerate(phases):
            if al > HST_MAX_PHASE:
                f = ((math.pi - math.radians(al)) / (math.pi - math.radians(HST_MAX_PHASE))) ** n[reg]
                hst[:, k] = hst[:, k63] * f
                hst_c[:, k] = hst_c[:, k63] * f
        w_clear[reg], w_xyzs[reg] = hst, hst_c
        check[reg] = {"voyager_wP_47": wp_v, "hst_wP_6.3_at_voyager_beff": wp_h63, "mean_tau": float(np.mean(treg))}

    # per-bin radial modulation from the Voyager 2 lit profile
    r = lit.radius
    tau_bin = np.interp(r, tau_r, tau_v)
    geo = lit_geometry(tau_bin, mu_l, mu0_l)
    wclear_r = _interp_regions(r, {k: np.array([_lookup(v, beffs, phases, beff_l, lit.phase)]) for k, v in
                                   w_clear.items()})[:, 0]
    with np.errstate(divide="ignore", invalid="ignore"):
        a = lit.iof / (wclear_r * geo)
    a[geo < 0.005] = np.nan                      # empty gaps: brightness ~0 whatever A is
    good = np.isfinite(a)
    a = np.clip(np.interp(r, r[good], a[good]), 0.0, None)

    # unlit face: effective optical depth and gain from Voyager 1
    ru = unlit.radius
    mu0_u, mu_u = math.sin(math.radians(unlit.solar_elev)), math.sin(math.radians(abs(unlit.obs_elev)))
    beff_u = math.degrees(math.asin(mu_eff(mu_u, mu0_u)))
    tau_u0 = np.interp(ru, tau_r, tau_v)
    a_u = np.interp(ru, r, a, left=np.nan, right=np.nan)
    w_u = _interp_regions(ru, {k: np.array([_lookup(v, beffs, phases, beff_u, unlit.phase)]) for k, v in
                               w_clear.items()})[:, 0]
    amp = a_u * w_u
    tstar = math.log(mu_u / mu0_u) / (1.0 / mu0_u - 1.0 / mu_u)
    kmax = float(unlit_geometry(tstar, mu_u, mu0_u))
    tau_u = tau_u0.copy()
    gain = np.ones_like(tau_u0)
    grid = np.linspace(tstar, 12.0, 4000)
    kgrid = unlit_geometry(grid, mu_u, mu0_u)          # decreasing in τ beyond τ*
    for i in range(ru.size):
        if not np.isfinite(amp[i]) or amp[i] <= 0 or tau_u0[i] < GAP_TAU:
            continue            # empty gaps (and edges misregistered between the data sets): plain model
        k_meas = max(float(unlit.iof[i]), 0.0) / amp[i]
        k_tau = float(unlit_geometry(tau_u0[i], mu_u, mu0_u))
        if k_tau * amp[i] < 1e-5 and k_meas * amp[i] < 1e-5:
            continue
        if tau_u0[i] <= tstar or k_meas <= k_tau:
            gain[i] = k_meas / k_tau if k_tau > 0 else 1.0     # thin ring, or darker than single scattering allows
        elif k_meas <= kmax:
            tau_u[i] = float(np.interp(k_meas, kgrid[::-1], grid[::-1]))
        else:
            tau_u[i], gain[i] = tstar, k_meas / kmax
    # model grid = the Voyager 1 grid (it covers the Voyager 2 one)
    lit_mod = np.interp(ru, r, a, left=np.nan, right=np.nan)
    return RingModel(ru, tau_u0, lit_mod, tau_u, gain, phases, beffs, w_xyzs, w_clear, n, lit, unlit, check)


def model_iof(model: RingModel, r: float, alpha: float, obs_elev: float, sun_elev: float, channel: int = 1) -> float:
    """Evaluate the ring model (for tests and reports). Elevations in degrees, signed: positive = the Sun's side."""
    mu, mu0 = abs(math.sin(math.radians(obs_elev))), abs(math.sin(math.radians(sun_elev)))
    beff = math.degrees(math.asin(mu_eff(mu, mu0)))
    tables = model.w_clear if channel is None else {k: v[..., channel] for k, v in model.w_xyzs.items()}
    w = _interp_regions(np.array([r]), {k: np.array([_lookup(v, model.beff, model.phase, beff, alpha)])
                                        for k, v in tables.items()})[0, 0]
    i = int(np.argmin(np.abs(model.radius - r)))
    if obs_elev * sun_elev > 0:
        return float(model.lit_mod[i] * w * lit_geometry(model.tau[i], mu, mu0))
    return float(model.lit_mod[i] * model.unlit_gain[i] * w * unlit_geometry(model.unlit_tau[i], mu, mu0))


# ---------------------------------------------------------------------------------------------- JSON
def _grid(r: np.ndarray) -> dict:
    """A uniform radial grid as start and step (checked)."""
    step = float(np.round(r[1] - r[0], 6))
    if not np.allclose(np.diff(r), step, atol=1e-6):
        raise ValueError("radial grid is not uniform")
    return {"radiusStartKm": float(r[0]), "radiusStepKm": step, "count": int(r.size)}


def _r(x, nd=5):
    return None if x is None or not np.isfinite(x) else float(f"{x:.{nd}g}")


def measurements_json(ctx: BuildContext | None) -> dict:
    lit, unlit = voyager_profile(VG_LIT, ctx), voyager_profile(VG_UNLIT, ctx)
    sf = SALO_FRENCH.register(ctx) if ctx else SALO_FRENCH.id
    fsrc = filters.register(ctx, ("voyager.nac.Clear", *(f"wfpc2.{f}" for f in HST_FILTERS)))
    beffs = hst_beffs()
    profiles = []
    for p in (lit, unlit):
        profiles.append({
            "name": f"{p.spacecraft.title()} ISS {p.side} face", "side": p.side,
            "instrument": f"{p.spacecraft.title()} ISS narrow-angle camera", "filter": "CLEAR",
            "effectiveWavelengthNm": round(filters.effective_wavelength("voyager.nac.Clear"), 1),
            "start": p.start, "phaseDeg": p.phase, "solarElevationDeg": round(p.solar_elev, 2),
            "observerElevationDeg": round(p.obs_elev, 2),
            **_grid(p.radius), "iOverF": [_r(x, 4) for x in p.iof]})
    regional = {
        "definition": "Geometrically corrected lit-face I/F = a ln(α) + b, α in degrees, reduced to the effective "
                      "elevation sin Beff = 2μμ0/(μ+μ0) by the factor (μ+μ0)/(2μ0).",
        "minPhaseDeg": HST_MIN_PHASE, "maxPhaseDeg": HST_MAX_PHASE,
        "filters": [{"name": f, "effectiveWavelengthNm": round(filters.effective_wavelength(f"wfpc2.{f}"), 1)}
                    for f in HST_FILTERS],
        "elevationEffDeg": beffs,
        "regions": [{"name": name, "radiusKm": [lo, hi],
                     "a": [[hst_fits()[(k, be, f)][0] for f in HST_FILTERS] for be in beffs],
                     "b": [[hst_fits()[(k, be, f)][1] for f in HST_FILTERS] for be in beffs]}
                    for k, (name, lo, hi) in REGIONS.items()],
    }
    return {
        "radialProfiles": sourced(
            profiles, "measured", [*lit.sources, *unlit.sources, fsrc[0]],
            method="Voyager ISS narrow-angle clear-filter I/F of Saturn's rings vs radius, 10 km bins, as archived "
                   "(PDS VG_2810): navigated, calibrated images spliced and aligned to the Voyager PPS occultation. "
                   "Each profile is at one geometry (given with it); I/F is in the broad clear band (effective "
                   "wavelength for sunlight given).",
            uncertainty="absolute calibration of the Voyager vidicon images (not quantified in the archive "
                        "documentation); radial registration after alignment to the PPS profile; residual baseline "
                        "offsets in regions without empty gaps (PROFILES.TXT step 5)"),
        "regionalPhaseCurves": sourced(
            regional, "measured", [sf, *fsrc[1:]],
            method="Salo & French (2010) Table 4: log-linear fits I/F = a ln α + b to HST WFPC2 photometry of three "
                   "ring regions (C 78 000-83 000, B 100 000-107 000, A 127 000-129 000 km) in five filters at six "
                   "effective elevations, for 0.25° ≤ α ≤ 6.3°. The I/F is geometrically corrected to Beff (paper "
                   "Eqs. 1-2).",
            uncertainty="fit quality as shown in the paper's Figs. 4-5; HST absolute calibration as in French et "
                        "al. (2007a); below α = 0.25° the true-opposition surge (French et al. 2007b) is steeper than "
                        "the fit"),
    }


FORMULA = ("lit face (Sun and observer on the same side): I/F_c = litModulation(r) · W_c(r; α, Beff) · μ0/(4(μ+μ0)) · "
           "[1 − exp(−normalTau(r)·(1/μ + 1/μ0))]; unlit face (opposite sides): I/F_c = litModulation(r) · "
           "unlitGain(r) · W_c(r; α, Beff) · μ0/(4|μ−μ0|) · |exp(−unlitTau(r)/μ) − exp(−unlitTau(r)/μ0)| (for μ = μ0: "
           "(unlitTau/(4μ))·exp(−unlitTau/μ)). μ = |sin B| of the observer, μ0 = |sin B′| of the Sun above the ring "
           "plane, sin Beff = 2μμ0/(μ+μ0), α the phase angle. W_c(r; α, Beff) = ϖP for CIE channel c (X, Y, Z, "
           "scotopic; solar-weighted, like geometricAlbedoXYZS): bilinear in (α, Beff) within each region's table "
           "(Beff clamped to the table's range); inside a region its table, between regions linear in radius from "
           "one region's edge to the next, outside them the nearest region's. Radiance = I/F · E☉(d)/π per channel, with E☉ from light.json scaled to the Sun's distance.")


def model_json(ctx: BuildContext | None) -> tuple[dict, RingModel]:
    m = build_model()
    lit_src = voyager_profile(VG_LIT, ctx).sources + voyager_profile(VG_UNLIT, ctx).sources
    js = {
        "kind": "single-scattering-v1",
        "formula": FORMULA,
        **_grid(m.radius),
        "normalTau": [_r(x, 4) for x in m.tau],
        "litModulation": [_r(x, 4) for x in m.lit_mod],
        "unlitTau": [_r(x, 4) for x in m.unlit_tau],
        "unlitGain": [_r(x, 4) for x in m.unlit_gain],
        "phaseDeg": list(PHASE_GRID),
        "elevationEffDeg": [float(b) for b in m.beff],
        "minPhaseDeg": HST_MIN_PHASE, "maxPhaseDeg": MAX_PHASE,
        "regions": [{"name": name, "radiusKm": [lo, hi], "centerKm": (lo + hi) / 2,
                     "powerLawExponent": round(m.n[k], 3),
                     "amplitudeXYZS": [[[_r(v, 5) for v in m.w_xyzs[k][j, i]] for i in range(len(PHASE_GRID))]
                                       for j in range(len(m.beff))]}
                    for k, (name, lo, hi) in REGIONS.items()],
    }
    sources = [*lit_src, SALO_FRENCH.register(ctx) if ctx else SALO_FRENCH.id,
               *filters.register(ctx, ("voyager.nac.Clear", *(f"wfpc2.{f}" for f in HST_FILTERS))),
               solar.HSRS.register(ctx) if ctx else solar.HSRS.id,
               *(cie.register_sources(ctx) if ctx else [cie.SOURCE_CMF, cie.SOURCE_SCOTOPIC])]
    ns = ", ".join(f"{REGIONS[k][0]} {v:.2f}" for k, v in m.n.items())
    method = (
        "Uses the estimated cleaned UVIS profile (rings.json opticalDepthEstimate, saturn_profile), retained "
        "as fitted: main-ring negative clamping and outside running-median removal/run selection; the full "
        "assumptions and parameters are in opticalDepthEstimate.method. normalTau and all inversions/fits that "
        "depend on it inherit estimated, regardless of which optical-depth profile the renderer admits. "
        "Classical single-scattering model of a many-particle-thick ring (Chandrasekhar 1960, Radiative Transfer; "
        "the reflection form is Salo & French 2010 Eq. 6, the transmission form is its diffuse-transmission "
        "counterpart), calibrated on measurements. (1) ϖP per channel for the C, B and A ring regions at α ≤ 6.3° "
        "and Beff = 4.5-26.1°: the HST WFPC2 phase curves (Salo & French 2010 Table 4) inverted through the model "
        "with each region's UVIS optical depth, reconstructed across wavelength piecewise-linearly through the five "
        "filters (photon-counting WFPC2 responses) and integrated against sunlight and the CIE observers. (2) From "
        "6.3° to 47°: a power-law particle phase function (π − α)^n, the form Salo & French use with n = 3.09 "
        f"('a good match to the phase function of Callisto', after Dones et al. 1993), with n fitted per region so "
        f"that the model reproduces the mean Voyager 2 lit I/F at 47° ({ns}; the independent HST and Voyager anchors "
        "agree with a Callisto-like phase function). Colour beyond 6.3° is held at its 6.3° value. (3) litModulation: "
        "radial structure from the Voyager 2 lit profile (clear filter), so the model reproduces that profile bin by "
        "bin at its geometry; its colour and phase dependence are those of the regions, interpolated between them (an assumption "
        "for radii away from the three HST regions, e.g. the Cassini Division and the outer B and A rings). (4) Unlit "
        "face: unlitTau and unlitGain make the model reproduce the Voyager 1 unlit profile bin by bin; the unlit "
        "face's colour and phase shape are ASSUMED to follow the lit face's (in empty gaps, τ⊥ < 0.01, and at edges "
        "whose radii differ between the Voyager and UVIS cuts, gain 1 and unlitTau = normalTau). (5) Outside the "
        "HST elevation range (Beff < 4.5° or > 26.1°) W is held at the table's edge value (assumption; the "
        "single-scattering factor still carries the elevation dependence). Domain: 0.25° ≤ α ≤ 47° (outside, unknown); "
        "radii 74 000-140 600 km (litModulation null beyond the Voyager 2 coverage, 138 700 km: the F ring's "
        "brightness is not modelled).")
    uncertainty = ("reproduces its calibration data by construction. Independent check (docs/reports/planet-colors.md, "
                   "tests): the net light the rings add to Saturn agrees with Mallama & Hilton's (2018) ground "
                   "photometry (their Eq. 10 minus Eq. 11) within 10 % for ring elevations 15-26° at α = 1-3°; at "
                   "elevations ≤ 10° the comparison is inconclusive (the model is brighter than the M&H difference, "
                   "which itself turns negative at 5°, 6°). Not verified: the tilt and phase "
                   "behaviour outside the three HST regions, the unlit face at other geometries (multiple scattering "
                   "is represented only through the fitted unlitTau/unlitGain), self-gravity-wake azimuthal "
                   "asymmetries of the A ring (French et al. 2007a) and spokes are not modelled; below "
                   "0.25° the opposition surge continues to rise; beyond 47° (forward scattering by dust) unknown")
    return {"reflectance": sourced(js, "estimated", sources, method=method, uncertainty=uncertainty)}, m
