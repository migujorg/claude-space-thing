"""Shared physics for atmospheres.json (docs/architecture.md §6): spectral samples, channel equivalents, molecular
Rayleigh scattering, Mie scattering and phase functions.

Spectral samples: 360-830 nm every 10 nm (48 wavelengths) in standard air, like the CIE tables. Everything is
computed first on the 1 nm CIE grid and then sampled (point values; absorption cross-sections with narrow bands,
ozone, are 10 nm box averages).

Channel equivalents (X, Y, Z, S), weighted like geometricAlbedoXYZS (docs/architecture.md §4.3), w_c(λ) = E_sun(λ)
cmf_c(λ) (TSIS-1 sunlight × CIE 1931 x̄ ȳ z̄ and V'):
  extinction   β_c = ∫β w_c / ∫w_c
  SSA          ω_c = ∫ω β w_c / ∫β w_c                      (scattering-weighted)
  asymmetry    g_c = ∫g ω β w_c / ∫ω β w_c                  (scattered-light-weighted)
These are the optically thin equivalents: for a path of optical depth τ the channel transmission is
∫w_c e^{-τ(λ)} / ∫w_c, which the spectral samples give exactly and the channel mean only to first order in τ.
"""

from __future__ import annotations

import math
from functools import lru_cache

import numpy as np
from numba import njit

from .. import cie
from . import solar
from .common import read_table_json, vacuum_to_air

GRID_NM = np.arange(360.0, 831.0, 10.0)          # the spectral samples of atmospheres.json
FINE = cie.WAVELENGTHS                            # 1 nm, 360-830
_IDX = np.searchsorted(FINE, GRID_NM)

# Phase-function angles for tabulated phase functions (scattering angle, degrees): dense near forward scattering.
ANGLES_DEG = np.array([0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 22.5, 25, 27.5, 30,
                       *range(35, 181, 5)], float)


def sample(fine: np.ndarray) -> np.ndarray:
    """Point samples at GRID_NM of a quantity given on the 1 nm grid (last axis)."""
    return np.asarray(fine)[..., _IDX]


def sample_box(fine: np.ndarray) -> np.ndarray:
    """10 nm box averages [λ-5, λ+5] (clipped to 360-830) of a quantity on the 1 nm grid (last axis)."""
    f = np.asarray(fine, float)
    out = []
    for i in _IDX:
        lo, hi = max(i - 5, 0), min(i + 5, FINE.size - 1)
        seg = f[..., lo:hi + 1]
        w = np.ones(seg.shape[-1])
        if i - 5 >= 0:
            w[0] = 0.5
        if i + 5 <= FINE.size - 1:
            w[-1] = 0.5
        out.append((seg * w).sum(axis=-1) / w.sum())
    return np.stack(out, axis=-1)


@lru_cache(maxsize=1)
def channel_weights() -> np.ndarray:
    """(4, 471): E_sun × (x̄, ȳ, z̄, V'), each row normalized to sum 1."""
    e = solar.spectrum().grid
    w = np.vstack([cie.cmfs().T, cie.scotopic()[None, :]]) * e[None, :]
    return w / w.sum(axis=1, keepdims=True)


@lru_cache(maxsize=1)
def fold_weights() -> np.ndarray:
    """(4, 48) W_ck = ∫ E_sun cmf_c φ_k dλ / ∫ E_sun cmf_c dλ, φ_k the piecewise-linear 'hat' basis on GRID_NM
    (surf_color.hat_basis, as the surface products' channelWeights). For a spectral ratio f(λ) sampled at GRID_NM
    (e.g. radiance per unit solar irradiance), the channel value is Σ_k W_ck f_k; rows sum to 1."""
    from ..surf_color import hat_basis
    return channel_weights() @ hat_basis(GRID_NM).T


def ch_extinction(beta: np.ndarray) -> np.ndarray:
    """(..., 471) -> (..., 4)."""
    return np.asarray(beta) @ channel_weights().T


def ch_ssa(beta: np.ndarray, ssa: np.ndarray) -> np.ndarray:
    """Scattering-weighted SSA per channel; beta (..., 471) or (471,), ssa broadcastable to beta."""
    w = channel_weights()
    b = np.asarray(beta, float)
    num = (b * ssa) @ w.T
    den = b @ w.T
    return np.divide(num, den, out=np.zeros_like(num), where=den > 0)


def ch_asymmetry(beta: np.ndarray, ssa: np.ndarray, g: np.ndarray) -> np.ndarray:
    w = channel_weights()
    s = np.asarray(beta, float) * ssa
    num = (s * g) @ w.T
    den = s @ w.T
    return np.divide(num, den, out=np.zeros_like(num), where=den > 0)


def ch_transmittance(tau_fine: np.ndarray) -> np.ndarray:
    """Exact channel transmission ∫w e^{-τ} / ∫w for optical depths on the 1 nm grid."""
    return np.exp(-np.asarray(tau_fine, float)) @ channel_weights().T


def air_to_vacuum(wl_air_nm: np.ndarray) -> np.ndarray:
    """Inverse of common.vacuum_to_air (Edlén 1966) by fixed-point iteration (converges to < 1e-9 nm)."""
    wl_air = np.asarray(wl_air_nm, float)
    v = wl_air.copy()
    for _ in range(5):
        v = v + (wl_air - vacuum_to_air(v))
    return v


FINE_VAC = air_to_vacuum(FINE)                  # vacuum wavelengths of the 1 nm air grid (for dispersion formulas)


# ---------------------------------------------------------------------------------------------- Rayleigh
_BOD = read_table_json("bodhaine_1999_rayleigh.json")


def n_air_bodhaine(lam_vac_um: np.ndarray) -> np.ndarray:
    """Bodhaine et al. (1999) Eq. 21: refractive index of dry air with 360 ppm CO2 at 288.15 K, 1013.25 mb."""
    s2 = np.asarray(lam_vac_um, float) ** -2
    return 1.0 + (8060.77 + 2481070.0 / (132.274 - s2) + 17456.3 / (39.32957 - s2)) * 1e-8


def king_air_bodhaine(lam_vac_um: np.ndarray, c_co2_percent: float = 0.036) -> np.ndarray:
    """Bodhaine Eqs. 5, 6, 23: depolarization (King) factor of dry air; F(Ar) = 1, F(CO2) = 1.15 (Bates 1984)."""
    lam = np.asarray(lam_vac_um, float)
    f_n2 = 1.034 + 3.17e-4 / lam ** 2
    f_o2 = 1.096 + 1.385e-3 / lam ** 2 + 1.448e-4 / lam ** 4
    return ((78.084 * f_n2 + 20.946 * f_o2 + 0.934 * 1.00 + c_co2_percent * 1.15)
            / (78.084 + 20.946 + 0.934 + c_co2_percent))


def n_co2_owens(lam_vac_um: np.ndarray) -> np.ndarray:
    """Bodhaine Eq. 27 (Owens 1967): refractive index of CO2 at 15 °C, 1013.25 mb."""
    s2 = np.asarray(lam_vac_um, float) ** -2
    return 1.0 + (22822.1 + 117.8 * s2 + 2406030.0 / (130.0 - s2) + 15997.0 / (38.9 - s2)) * 1e-8


def king_n2_bodhaine(lam_vac_um: np.ndarray) -> np.ndarray:
    """Bodhaine Eq. 5 (after Bates 1984)."""
    return 1.034 + 3.17e-4 / np.asarray(lam_vac_um, float) ** 2


NS_288_M3 = _BOD["constants"]["Ns_cm3"] * 1e6          # molecules m^-3 at 288.15 K, 1013.25 mb (Bodhaine Eq. 24)
F_CO2 = _BOD["constants"]["F_CO2"]


def rayleigh_sigma(n: np.ndarray, ns_m3: float, lam_vac_nm: np.ndarray, king: np.ndarray) -> np.ndarray:
    """Bodhaine Eq. 22: cross-section per molecule (m^2); n is the refractive index at number density ns_m3."""
    lam_m = np.asarray(lam_vac_nm, float) * 1e-9
    n2 = np.asarray(n, float) ** 2
    return 24.0 * math.pi ** 3 * (n2 - 1.0) ** 2 / (lam_m ** 4 * ns_m3 ** 2 * (n2 + 2.0) ** 2) * king


def sigma_air(lam_vac_nm: np.ndarray) -> np.ndarray:
    lam_um = np.asarray(lam_vac_nm, float) / 1e3
    return rayleigh_sigma(n_air_bodhaine(lam_um), NS_288_M3, lam_vac_nm, king_air_bodhaine(lam_um))


def sigma_co2(lam_vac_nm: np.ndarray) -> np.ndarray:
    lam_um = np.asarray(lam_vac_nm, float) / 1e3
    return rayleigh_sigma(n_co2_owens(lam_um), NS_288_M3, lam_vac_nm, np.full_like(lam_um, F_CO2))


def depolarization(king: np.ndarray) -> np.ndarray:
    """ρ from F = (6 + 3ρ)/(6 - 7ρ)."""
    f = np.asarray(king, float)
    return 6.0 * (f - 1.0) / (3.0 + 7.0 * f)


def rayleigh_phase(cos_theta: np.ndarray, rho: float) -> np.ndarray:
    """Phase function (mean over the sphere = 1) of anisotropic molecules for unpolarized light with depolarization
    ratio ρ: P = 3[(1 + ρ) + (1 - ρ) cos²Θ] / (4 + 2ρ). (Scattered intensity ∝ (1 + ρ) + (1 - ρ) cos²Θ: the two
    polarization components are 1 and cos²Θ for ρ = 0, and 1 and ρ at Θ = 90°, the definition of ρ.)"""
    mu = np.asarray(cos_theta, float)
    return 3.0 * ((1.0 + rho) + (1.0 - rho) * mu ** 2) / (4.0 + 2.0 * rho)


# ---------------------------------------------------------------------------------------------- phase functions
def hg(cos_theta: np.ndarray, g: float) -> np.ndarray:
    """Henyey-Greenstein, mean over the sphere = 1."""
    mu = np.asarray(cos_theta, float)
    return (1.0 - g * g) / (1.0 + g * g - 2.0 * g * mu) ** 1.5


def dhg(cos_theta: np.ndarray, g1: float, g2: float, alpha: float) -> np.ndarray:
    return alpha * hg(cos_theta, g1) + (1.0 - alpha) * hg(cos_theta, g2)


def mean_over_sphere(p_of_mu, n: int = 20001) -> float:
    mu = np.linspace(-1.0, 1.0, n)
    return float(np.trapezoid(p_of_mu(mu), mu) / 2.0)


def asymmetry_of(p_of_mu, n: int = 20001) -> float:
    mu = np.linspace(-1.0, 1.0, n)
    p = p_of_mu(mu)
    return float(np.trapezoid(p * mu, mu) / np.trapezoid(p, mu))


# ---------------------------------------------------------------------------------------------- Mie
@njit(cache=True)
def _mie_single(x, m, mu):
    """Bohren & Huffman (1983, Appendix A) BHMIE for one homogeneous sphere of size parameter x and relative
    refractive index m: Q_ext, Q_sca, g and |S1|² + |S2|² at the scattering-angle cosines mu."""
    nstop = int(x + 4.05 * x ** (1.0 / 3.0) + 2.0)
    y = m * x
    nmx = int(max(nstop, abs(y))) + 15
    d = np.zeros(nmx + 1, np.complex128)
    for n in range(nmx, 0, -1):
        d[n - 1] = n / y - 1.0 / (d[n] + n / y)
    psi0, psi1 = math.cos(x), math.sin(x)
    chi0, chi1 = -math.sin(x), math.cos(x)
    xi1 = complex(psi1, -chi1)
    na = mu.size
    pi0 = np.zeros(na)
    pi1 = np.ones(na)
    s1 = np.zeros(na, np.complex128)
    s2 = np.zeros(na, np.complex128)
    qsca = 0.0
    qext = 0.0
    gsum = 0.0
    an_p = 0j
    bn_p = 0j
    for n in range(1, nstop + 1):
        fn = (2.0 * n + 1.0) / (n * (n + 1.0))
        psi = (2.0 * n - 1.0) * psi1 / x - psi0
        chi = (2.0 * n - 1.0) * chi1 / x - chi0
        xi = complex(psi, -chi)
        an = ((d[n] / m + n / x) * psi - psi1) / ((d[n] / m + n / x) * xi - xi1)
        bn = ((d[n] * m + n / x) * psi - psi1) / ((d[n] * m + n / x) * xi - xi1)
        qsca += (2.0 * n + 1.0) * (abs(an) ** 2 + abs(bn) ** 2)
        qext += (2.0 * n + 1.0) * (an.real + bn.real)
        if n > 1:
            gsum += ((n - 1.0) * (n + 1.0) / n * (an_p * an.conjugate() + bn_p * bn.conjugate()).real
                     + (2.0 * n - 1.0) / ((n - 1.0) * n) * (an_p * bn_p.conjugate()).real)
        for j in range(na):
            tau = n * mu[j] * pi1[j] - (n + 1.0) * pi0[j]
            s1[j] += fn * (an * pi1[j] + bn * tau)
            s2[j] += fn * (an * tau + bn * pi1[j])
            p_next = ((2.0 * n + 1.0) * mu[j] * pi1[j] - (n + 1.0) * pi0[j]) / n
            pi0[j] = pi1[j]
            pi1[j] = p_next
        psi0, psi1 = psi1, psi
        chi0, chi1 = chi1, chi
        xi1 = complex(psi1, -chi1)
        an_p, bn_p = an, bn
    gsum += (2.0 * nstop + 1.0) / (nstop * (nstop + 1.0)) * (an_p * bn_p.conjugate()).real
    qsca_v = 2.0 / x ** 2 * qsca
    qext_v = 2.0 / x ** 2 * qext
    g = 4.0 / (x ** 2 * qsca_v) * gsum
    s12 = np.empty(na)
    for j in range(na):
        s12[j] = abs(s1[j]) ** 2 + abs(s2[j]) ** 2
    return qext_v, qsca_v, g, s12


def mie_single(x: float, m: complex, mu: np.ndarray) -> tuple[float, float, float, np.ndarray]:
    return _mie_single(float(x), complex(m), np.ascontiguousarray(mu, dtype=float))


def gamma_distribution(r_eff: float, v_eff: float, n: int = 300) -> tuple[np.ndarray, np.ndarray]:
    """Radii (µm) and number weights of the two-parameter gamma distribution n(r) ∝ r^((1-3b)/b) exp(-r/(ab)),
    a = r_eff, b = v_eff, whose effective radius (∫r³n/∫r²n) and effective variance are a and b; the grid covers
    its bulk (weights renormalized)."""
    a, b = r_eff, v_eff
    r = np.linspace(max(a * (1 - 6 * math.sqrt(b)), a * 0.02), a * (1 + 10 * math.sqrt(b)), n)
    logn = (1.0 - 3.0 * b) / b * np.log(r) - r / (a * b)
    w = np.exp(logn - logn.max())
    return r, w / w.sum()


def mie_ensemble(radii_um: np.ndarray, weights: np.ndarray, m: complex, lam_um: float, mu: np.ndarray) -> dict:
    """Size-averaged Mie properties of spheres: mean cross-sections (µm²), SSA, asymmetry g and the phase function
    (mean over the sphere = 1) at cos θ = mu: P = 2π Σ w (|S1|²+|S2|²)/k² / Σ w C_sca, k = 2π/λ (Bohren & Huffman
    1983, §3.4)."""
    mu = np.ascontiguousarray(mu, dtype=float)
    cext = csca = gcs = 0.0
    s = np.zeros_like(mu)
    k2 = (2.0 * math.pi / lam_um) ** 2
    for r, w in zip(np.atleast_1d(radii_um), np.atleast_1d(weights)):
        x = 2.0 * math.pi * r / lam_um
        qe, qs, g, s12 = mie_single(x, m, mu)
        area = math.pi * r * r
        cext += w * qe * area
        csca += w * qs * area
        gcs += w * g * qs * area
        s += w * s12 / k2
    return {"cext_um2": cext, "csca_um2": csca, "ssa": csca / cext, "g": gcs / csca,
            "phase": 2.0 * math.pi * s / csca}
