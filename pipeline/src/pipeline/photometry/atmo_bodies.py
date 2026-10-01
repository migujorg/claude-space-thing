"""Titan, Venus and Pluto physics for atmospheres.json (sources in atmo_sources.py; transcriptions in
tables/titan_disr_haze.json, venus_clouds.json, pluto_haze.json)."""

from __future__ import annotations

import math
import re
from functools import lru_cache

import numpy as np

from . import atmo
from .atmo_sources import HASI_DESCENT, HASI_ENTRY, HUYGENS_DTWG_DESCENT, HUYGENS_GCMS_CH4, PECK_KHANNA_N2
from .common import read_table_csv, read_table_json

K_B = 1.380649e-23          # J/K, SI defining constant (2019)

TITAN = read_table_json("titan_disr_haze.json")
VENUS = read_table_json("venus_clouds.json")
PLUTO = read_table_json("pluto_haze.json")


# ---------------------------------------------------------------------------------------------- Titan gas
def _read_hasi(path) -> np.ndarray:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = [p.strip() for p in line.split(";")]
        if len(parts) < 4 or not parts[1]:
            continue
        try:
            rows.append([float(parts[1]), float(parts[2]), float(parts[3])])
        except ValueError:
            continue
    return np.array(rows)          # altitude m, pressure Pa, temperature K


@lru_cache(maxsize=1)
def hasi_profile() -> dict[str, np.ndarray]:
    """HASI descent (0-147 km) and entry (157-1380 km) P, T merged, sorted by altitude; n = P/(kT)."""
    d = _read_hasi(HASI_DESCENT.fetch())
    e = _read_hasi(HASI_ENTRY.fetch())
    a = np.vstack([d, e])
    a = a[np.argsort(a[:, 0])]
    z = a[:, 0] / 1e3
    keep = np.concatenate([[True], np.diff(z) > 0])
    a, z = a[keep], z[keep]
    return {"z_km": z, "P": a[:, 1], "T": a[:, 2], "n": a[:, 1] / (K_B * a[:, 2]),
            "descent_top_km": float(d[:, 0].max() / 1e3), "entry_bottom_km": float(e[:, 0].min() / 1e3)}


def titan_n(z_km: np.ndarray) -> np.ndarray:
    """Gas number density (m^-3), log-linear interpolation of the HASI profile. Between the descent top (147 km) and
    the entry bottom (157 km) the interpolation bridges the gap."""
    p = hasi_profile()
    return np.exp(np.interp(z_km, p["z_km"], np.log(p["n"])))


@lru_cache(maxsize=1)
def peck_khanna() -> tuple[float, float, float, tuple[float, float]]:
    """(C1, C2, C3, range µm) of n - 1 = C1 + C2/(C3 - λ^-2) (refractiveindex.info 'formula 6', 0 °C, 101.325 kPa)."""
    txt = PECK_KHANNA_N2.fetch().read_text(encoding="utf-8")
    m = re.search(r"type:\s*formula 6.*?wavelength_range:\s*([0-9.]+)\s+([0-9.]+).*?coefficients:\s*([^\n]+)", txt,
                  re.S)
    c = [float(v) for v in m.group(3).split()]
    return c[0], c[1], c[2], (float(m.group(1)), float(m.group(2)))


def sigma_n2(lam_vac_nm: np.ndarray) -> np.ndarray:
    c1, c2, c3, _ = peck_khanna()
    lam_um = np.asarray(lam_vac_nm, float) / 1e3
    n = 1.0 + c1 + c2 / (c3 - lam_um ** -2)
    ns0 = 101325.0 / (K_B * 273.15)
    return atmo.rayleigh_sigma(n, ns0, lam_vac_nm, atmo.king_n2_bodhaine(lam_um))


# ---------------------------------------------------------------------------------------------- Titan haze
def titan_tau_components(lam_nm: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    t = TITAN["bazzon_A4"]
    lam = np.asarray(lam_nm, float)
    f = lambda k: t[k]["coefficient"] * lam ** t[k]["exponent"]      # noqa: E731
    return f("tau80"), f("tau30"), f("tau0")


def titan_haze_tau(z_km: np.ndarray, lam_nm: np.ndarray) -> np.ndarray:
    """Cumulative haze optical depth from the top down to altitude z (Bazzon et al. eqs. A.11-A.13), (n_z, n_λ)."""
    t80, t30, t0 = titan_tau_components(lam_nm)
    h = TITAN["bazzon_A4"]["scale_height_above_80_km"]
    z = np.asarray(z_km, float)[:, None]
    above = t80 * np.exp(-(z - 80.0) / h)
    mid = t80 + t30 * (1.0 - (z - 30.0) / 50.0)
    low = t80 + t30 + t0 * (1.0 - z / 30.0)
    return np.where(z > 80.0, above, np.where(z >= 30.0, mid, low))


def titan_haze_beta(z_km: np.ndarray, lam_nm: np.ndarray) -> np.ndarray:
    """Extinction coefficient (km^-1) = -dτ/dz of the model: τ80/65 e^{-(z-80)/65} above 80 km, τ30/50 at 30-80 km,
    τ0/30 below 30 km."""
    t80, t30, t0 = titan_tau_components(lam_nm)
    h = TITAN["bazzon_A4"]["scale_height_above_80_km"]
    z = np.asarray(z_km, float)[:, None]
    return np.where(z > 80.0, t80 / h * np.exp(-(z - 80.0) / h), np.where(z >= 30.0, t30 / 50.0 + 0 * z,
                                                                          t0 / 30.0 + 0 * z))


# ---------------------------------------------------------------------------------------------- Titan haze optics
def _ssa_rows() -> dict[str, tuple[np.ndarray, np.ndarray]]:
    rows = read_table_csv("titan_doose_2016_ssa.csv")
    out = {}
    for curve in ("above_200km", "below_80km"):
        r = [(float(x["wavelength_nm"]), float(x["ssa"])) for x in rows if x["curve"] == curve]
        a = np.array(r)
        out[curve] = (a[:, 0], a[:, 1])
    return out


def doose_rule(omega_top: np.ndarray) -> np.ndarray:
    """Doose et al. (2016): ω(z < 80 km) = (0.565 + ω(z > 200 km)) / 1.5 (Es-sayeh et al. 2023; Rannou et al. 2026)."""
    r = TITAN["doose_2016_ssa_rule"]
    return (r["offset"] + np.asarray(omega_top, float)) / r["divisor"]


def titan_ssa_extrapolation() -> tuple[float, float]:
    """(slope per nm, intercept) of the line through the digitized above-200-km albedo over the fit range."""
    lam, w = _ssa_rows()["above_200km"]
    lo, hi = TITAN["doose_2016_ssa_extrapolation"]["fit_range_nm"]
    s = (lam >= lo) & (lam <= hi)
    k, c = np.polyfit(lam[s], w[s], 1)
    return float(k), float(c)


def titan_ssa(lam_nm: np.ndarray) -> dict[str, np.ndarray]:
    """Haze single-scattering albedo above 200 km ('top') and below 80 km ('low') at air wavelengths lam_nm (the
    figure's axis is in µm without an air/vacuum statement; the difference, 0.15 nm, is far below its resolution).
    Digitized curves (linear between vertices) from their first vertex (499.8 nm) on; shortward, the top curve
    continued linearly (titan_ssa_extrapolation) and the low one from Doose's rule. Capped at 1. 'extrapolated'
    marks the wavelengths below the first vertex."""
    rows = _ssa_rows()
    lam = np.asarray(lam_nm, float)
    lt, wt = rows["above_200km"]
    ll, wl = rows["below_80km"]
    k, c = titan_ssa_extrapolation()
    first = max(lt[0], ll[0])
    ext = lam < first
    top = np.where(ext, k * lam + c, np.interp(lam, lt, wt))
    low = np.where(ext, doose_rule(k * lam + c), np.interp(lam, ll, wl))
    return {"top": np.clip(top, 0.0, 1.0), "low": np.clip(low, 0.0, 1.0), "extrapolated": ext, "first_nm": first}


def titan_upper_weight(z_km: np.ndarray) -> np.ndarray:
    """Weight of the above-200-km albedo: 0 below 80 km, 1 above 200 km, linear between (Doose et al. 2016)."""
    r = TITAN["doose_2016_ssa_rule"]
    return np.clip((np.asarray(z_km, float) - r["below_km"]) / (r["above_km"] - r["below_km"]), 0.0, 1.0)


def read_tomasko_phase(path) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(angles deg, wavelengths nm, P[wavelength][angle]) of an Adamkovics refdata table (header 'deg' and wavelengths
    in Angstrom; rows: angle then one value per wavelength)."""
    lines = [ln.split() for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    lam = np.array([float(v) for v in lines[0][1:]]) / 10.0
    a = np.array([[float(v) for v in ln] for ln in lines[1:]])
    if a.shape[1] != lam.size + 1:
        raise ValueError(f"{path}: {a.shape[1] - 1} value columns for {lam.size} wavelengths")
    return a[:, 0], lam, a[:, 1:].T


def mean_over_sphere_tab(angles_deg: np.ndarray, p: np.ndarray) -> np.ndarray:
    """Mean over the sphere of tabulated phase functions p[..., angle], linear in angle between nodes (the schema's
    interpolation), integrated on a fine angle grid."""
    th = np.radians(np.linspace(0.0, 180.0, 18001))
    pp = np.stack([np.interp(np.degrees(th), angles_deg, row) for row in np.atleast_2d(p)])
    return np.trapezoid(pp * np.sin(th), th, axis=-1) / 2.0


#: Angles of the resampled Titan phase functions: 0.25° steps through the forward peak, then 1° to 30°, 2° beyond.
TITAN_PHASE_ANGLES = np.concatenate([np.arange(0.0, 10.0, 0.25), np.arange(10.0, 30.0, 1.0),
                                     np.arange(30.0, 180.0 + 1e-9, 2.0)])


def _loglinear_in_angle(ang: np.ndarray, p: np.ndarray, to: np.ndarray) -> np.ndarray:
    return np.exp(np.stack([np.interp(to, ang, np.log(row)) for row in np.atleast_2d(p)]))


def titan_phase_on_grid(path, grid_nm: np.ndarray) -> dict:
    """Tomasko et al. (2008) phase functions at the product's wavelengths: linear in wavelength between the tabulated
    wavelengths (355, 430, 491, 600, 713, 822, 935 nm in the visible), log-linear in angle between the tabulated angles
    onto TITAN_PHASE_ANGLES (the table's 1° steps under-resolve the forward peak: linear interpolation of them would
    add 2-4 % to the integral, log-linear 0.1-1 %), each row then renormalized to a mean of 1 over the sphere with
    the schema's linear interpolation between the new nodes. Returns the table and diagnostics."""
    ang, lam, p = read_tomasko_phase(path)
    g = np.asarray(grid_nm, float)
    by_lam = np.stack([np.interp(g, lam, p[:, j]) for j in range(ang.size)], axis=1)
    out = _loglinear_in_angle(ang, by_lam, TITAN_PHASE_ANGLES)
    norm = mean_over_sphere_tab(TITAN_PHASE_ANGLES, out)
    raw_lin = mean_over_sphere_tab(ang, p)
    raw_log = mean_over_sphere_tab(TITAN_PHASE_ANGLES, _loglinear_in_angle(ang, p, TITAN_PHASE_ANGLES))
    return {"anglesDeg": TITAN_PHASE_ANGLES, "values": out / norm[:, None], "raw_lambda_nm": lam, "raw": p,
            "raw_angles": ang, "raw_norm": raw_log, "raw_norm_linear": raw_lin, "norm": norm}


def tab_asymmetry(angles_deg: np.ndarray, p: np.ndarray) -> np.ndarray:
    th = np.radians(np.linspace(0.0, 180.0, 18001))
    pp = np.stack([np.interp(np.degrees(th), angles_deg, row) for row in np.atleast_2d(p)])
    return np.trapezoid(pp * np.cos(th) * np.sin(th), th, axis=-1) / np.trapezoid(pp * np.sin(th), th, axis=-1)


# ---------------------------------------------------------------------------------------------- Titan methane
def _utc_seconds(s: str) -> float:
    import datetime as _dt
    return _dt.datetime.fromisoformat(s.strip()).replace(tzinfo=_dt.timezone.utc).timestamp()


@lru_cache(maxsize=1)
def titan_methane_profile() -> dict[str, np.ndarray]:
    """Huygens GCMS methane mole fraction (PDS, by UTC) placed at the DTWG reconstructed altitude of each UTC (PDS),
    sorted by altitude and averaged in 1 km bins. Returns z_km, x (mole fraction), the altitude range and the raw
    sample count."""
    g = [ln.split(",") for ln in HUYGENS_GCMS_CH4.fetch().read_text(encoding="utf-8").splitlines()[1:] if ln.strip()]
    t = np.array([_utc_seconds(r[0]) for r in g])
    x = np.array([float(r[1]) for r in g])
    d = [ln.split() for ln in HUYGENS_DTWG_DESCENT.fetch().read_text(encoding="utf-8").splitlines() if ln.strip()]
    td = np.array([_utc_seconds(r[2]) for r in d])
    zd = np.array([float(r[4]) for r in d])
    o = np.argsort(td)
    if t.min() < td.min() - 60 or t.max() > td.max() + 60:
        raise ValueError("GCMS samples outside the DTWG descent trajectory")
    z = np.interp(t, td[o], zd[o])
    edges = np.arange(np.floor(z.min()), np.ceil(z.max()) + 1.0, 1.0)
    idx = np.digitize(z, edges) - 1
    zc, xc = [], []
    for i in range(edges.size - 1):
        s = idx == i
        if s.any():
            zc.append(float(z[s].mean()))
            xc.append(float(x[s].mean()))
    return {"z_km": np.array(zc), "x": np.array(xc), "z_range": (float(z.min()), float(z.max())), "n": int(t.size)}


def titan_methane_fraction(z_km: np.ndarray) -> np.ndarray:
    """Mole fraction at altitude z: the binned GCMS profile, held at its highest (lowest) bin above (below) it."""
    p = titan_methane_profile()
    return np.interp(np.asarray(z_km, float), p["z_km"], p["x"])


@lru_cache(maxsize=1)
def karkoschka_methane_k() -> tuple[np.ndarray, np.ndarray]:
    """(air wavelength nm, methane absorption coefficient per km-amagat) of Karkoschka (1998), PDS 1995LOW.TAB columns
    2 and 3 (0.4 nm sampling, 1 nm resolution, 300-1050 nm)."""
    from . import albedo
    d = np.loadtxt(albedo.KARKOSCHKA.fetch())
    return d[:, 1], d[:, 2]


def methane_k_fine(fine_air_nm: np.ndarray) -> np.ndarray:
    """k on the 1 nm air grid: mean of the 0.4 nm samples within ±0.5 nm of each grid point (k is itself a 1 nm
    resolution quantity; the box only resamples it)."""
    lam, k = karkoschka_methane_k()
    out = np.empty(np.asarray(fine_air_nm).size)
    for i, l0 in enumerate(np.asarray(fine_air_nm, float)):
        s = (lam >= l0 - 0.5) & (lam <= l0 + 0.5)
        out[i] = k[s].mean() if s.any() else np.interp(l0, lam, k)
    return out


# ---------------------------------------------------------------------------------------------- Venus
def venus_tau365(z_km: np.ndarray) -> np.ndarray:
    """Cumulative cloud/haze optical depth at 365 nm from the top: τ = 1 at 70 km with a 4 km scale height (Lee et
    al. 2021) up to 80 km, and the upper-haze scale height 4.8 km (Pere et al. 2016) above."""
    lee, pere = VENUS["lee_2021"], VENUS["pere_2016"]
    z0, h1 = lee["cloud_top_km"], lee["cloud_scale_height_km"]
    zb, h2 = pere["above_km"], pere["upper_haze_scale_height_km"]
    z = np.asarray(z_km, float)
    t_b = math.exp(-(zb - z0) / h1)
    return np.where(z <= zb, np.exp(-(z - z0) / h1), t_b * np.exp(-(z - zb) / h2))


def venus_beta365(z_km: np.ndarray) -> np.ndarray:
    lee, pere = VENUS["lee_2021"], VENUS["pere_2016"]
    z = np.asarray(z_km, float)
    h = np.where(z <= pere["above_km"], lee["cloud_scale_height_km"], pere["upper_haze_scale_height_km"])
    return venus_tau365(z) / h


def venus_n_real(lam_um: np.ndarray) -> np.ndarray:
    h = VENUS["hansen_hovenier_1974"]["refractive_index"]
    return np.interp(lam_um, h["lambda_um"], h["n"])


@lru_cache(maxsize=1)
def venus_mie() -> dict[str, np.ndarray]:
    """Mie properties of Hansen & Hovenier's droplets (gamma distribution r_eff 1.05 µm, v_eff 0.07, n(λ) from their
    three values, k = 0) at the 48 sample wavelengths and at 365 nm: relative extinction, g, phase tables."""
    hh = VENUS["hansen_hovenier_1974"]
    r, w = atmo.gamma_distribution(hh["r_eff_um"], hh["v_eff"])
    mu = np.cos(np.radians(atmo.ANGLES_DEG))
    lams = np.concatenate([[365.0], atmo.air_to_vacuum(atmo.GRID_NM)]) / 1e3
    cext, g, ph, ssa = [], [], [], []
    for lam in lams:
        e = atmo.mie_ensemble(r, w, complex(float(venus_n_real(lam)), 0.0), float(lam), mu)
        cext.append(e["cext_um2"])
        g.append(e["g"])
        ph.append(e["phase"])
        ssa.append(e["ssa"])
    cext = np.array(cext)
    return {"rel_ext": cext[1:] / cext[0], "g": np.array(g[1:]), "phase": np.array(ph[1:]), "ssa": np.array(ssa[1:]),
            "cext365_um2": float(cext[0])}


# ---------------------------------------------------------------------------------------------- Pluto
def pluto_shape(z_km: np.ndarray) -> np.ndarray:
    """Relative haze extinction: e^{-z/50} below 100 km, 30 km scale height above (Gladstone et al. 2016)."""
    g = PLUTO["gladstone_2016"]
    h1, h2 = g["scale_height_low_km"], g["scale_height_100_200_km"]
    z = np.asarray(z_km, float)
    return np.where(z <= 100.0, np.exp(-z / h1), math.exp(-100.0 / h1) * np.exp(-(z - 100.0) / h2))


@lru_cache(maxsize=1)
def pluto_mie() -> dict:
    g = PLUTO["gladstone_2016"]
    mu = np.cos(np.radians(atmo.ANGLES_DEG))
    lam = g["lorri_pivot_nm"] / 1e3
    e = atmo.mie_ensemble(np.array([g["min_radius_um"]]), np.array([1.0]), complex(g["tholin_n"], g["tholin_k"]),
                          lam, mu)
    # Gladstone et al.'s P(165 deg) is at PHASE angle 165 deg, i.e. scattering angle 15 deg
    p165 = atmo.mie_ensemble(np.array([g["min_radius_um"]]), np.array([1.0]), complex(g["tholin_n"], g["tholin_k"]),
                             lam, np.array([math.cos(math.radians(180.0 - 165.0))]))["phase"][0]
    qs = e["csca_um2"] / (math.pi * g["min_radius_um"] ** 2)
    return {**e, "P165": float(p165), "Qsca": qs}


def pluto_color_exponent() -> tuple[float, float, float]:
    """Ångström-type exponent a (extinction ∝ λ^-a) implied by the MVIC blue/red haze I/F ratio at high phase,
    assuming the phase function is wavelength independent: a = ln(I_b/I_r)/ln(λ_r/λ_b) at the band centres.
    Returns (a mid, a low, a high) for the midpoint and extreme ratios of Gladstone et al.'s ranges."""
    g = PLUTO["gladstone_2016"]
    lb, lr = np.mean(g["blue_band_nm"]), np.mean(g["red_band_nm"])
    ib, ir = np.mean(g["IF_blue_high_phase"]), np.mean(g["IF_red_high_phase"])
    f = lambda ratio: math.log(ratio) / math.log(lr / lb)       # noqa: E731
    return (f(ib / ir), f(g["IF_blue_high_phase"][0] / g["IF_red_high_phase"][1]),
            f(g["IF_blue_high_phase"][1] / g["IF_red_high_phase"][0]))
