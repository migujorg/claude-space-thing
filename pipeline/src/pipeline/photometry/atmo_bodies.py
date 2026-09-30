"""Titan, Venus and Pluto physics for atmospheres.json (sources in atmo_sources.py; transcriptions in
tables/titan_disr_haze.json, venus_clouds.json, pluto_haze.json)."""

from __future__ import annotations

import math
import re
from functools import lru_cache

import numpy as np

from . import atmo
from .atmo_sources import HASI_DESCENT, HASI_ENTRY, PECK_KHANNA_N2
from .common import read_table_json

K_B = 1.380649e-23          # J/K, SI defining constant (2019)

TITAN = read_table_json("titan_disr_haze.json")
VENUS = read_table_json("venus_clouds.json")
PLUTO = read_table_json("pluto_haze.json")


# ---------------------------------------------------------------------------------------------- Titan gas
def _read_hasi(path) -> np.ndarray:
    rows = []
    for line in path.read_text().splitlines():
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
    txt = PECK_KHANNA_N2.fetch().read_text()
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
