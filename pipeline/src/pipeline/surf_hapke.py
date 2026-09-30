"""Hapke bidirectional reflectance in the form used for the LROC WAC Hapke parameter maps.

Sato, H., Robinson, M. S., Hapke, B., Denevi, B. W. & Boyd, A. K. (2014), Resolved Hapke parameter maps of the Moon,
JGR Planets 119, 1775, doi:10.1002/2013JE004580, built on Hapke, B. (2012), Theory of Reflectance and Emittance
Spectroscopy, 2nd ed., Cambridge Univ. Press, doi:10.1017/CBO9781139025683:

    r(i, e, g) = K (w/4π) μ0e/(μ0e + μe) [p(g)(1 + B_S0 B_S(g)) + H(μ0e/K) H(μe/K) − 1] [1 + B_C0 B_C(g)] S(i, e, ψ)

with the double Henyey–Greenstein particle phase function
    p(g) = (1+c)/2 (1−b²)/(1 − 2b cos g + b²)^{3/2} + (1−c)/2 (1−b²)/(1 + 2b cos g + b²)^{3/2},
shadow-hiding opposition effect B_S(g) = 1/(1 + tan(g/2)/h_s), coherent-backscatter B_C (its amplitude B_C0 is
fixed at 0 in the maps), Hapke's (2002) approximation of Chandrasekhar's H function, and the macroscopic-roughness
correction of Hapke (1984) (μ0e, μe, S with mean slope θ̄, fixed at 23.657° in the maps). The maps also fix the
"filling factor" φ = 1; we read that as porosity factor K = 1 (Hapke's K(φ) formula is only defined for φ < 0.752).
The radiance factor (I/F) is RADF = π r; the normal albedo is RADF(0, 0, 0).
"""

from __future__ import annotations

import numpy as np

THETA_BAR_DEG = 23.657  # fixed in the maps (WAC_HAPKEPARAMMAP_README.TXT)


def h_function(x, w):
    """Hapke (2002) approximation to Chandrasekhar's isotropic H function (accuracy ~1 %)."""
    x = np.asarray(x, float)
    w = np.asarray(w, float)
    gamma = np.sqrt(np.clip(1.0 - w, 0.0, 1.0))
    r0 = (1 - gamma) / (1 + gamma)
    xs = np.maximum(x, 1e-12)
    return 1.0 / (1.0 - w * xs * (r0 + (1 - 2 * r0 * xs) / 2 * np.log((1 + xs) / xs)))


def phase_dhg(g, b, c):
    cg = np.cos(g)
    b2 = b * b
    return ((1 + c) / 2 * (1 - b2) / (1 - 2 * b * cg + b2) ** 1.5
            + (1 - c) / 2 * (1 - b2) / (1 + 2 * b * cg + b2) ** 1.5)


def _roughness(i, e, psi, theta_bar):
    """(μ0e, μe, S) of Hapke's rough-surface correction; angles in radians, arrays broadcast."""
    tb = np.tan(theta_bar)
    chi = 1.0 / np.sqrt(1.0 + np.pi * tb * tb)
    cot_t = 1.0 / tb

    def cot(x):
        return np.cos(x) / np.maximum(np.sin(x), 1e-12)

    def E1(x):
        return np.exp(-2.0 / np.pi * cot_t * cot(x))

    def E2(x):
        return np.exp(-1.0 / np.pi * cot_t ** 2 * cot(x) ** 2)

    def eta(x):
        return chi * (np.cos(x) + np.sin(x) * tb * E2(x) / (2.0 - E1(x)))

    mu0, mu = np.cos(i), np.cos(e)
    s2 = np.sin(psi / 2) ** 2
    f = np.exp(-2.0 * np.tan(np.minimum(psi, np.pi - 1e-9) / 2))
    # case i <= e
    d1 = 2.0 - E1(e) - psi / np.pi * E1(i)
    mu0e_1 = chi * (np.cos(i) + np.sin(i) * tb * (np.cos(psi) * E2(e) + s2 * E2(i)) / d1)
    mue_1 = chi * (np.cos(e) + np.sin(e) * tb * (E2(e) - s2 * E2(i)) / d1)
    S_1 = (mue_1 / eta(e)) * (mu0 / eta(i)) * chi / (1 - f + f * chi * (mu0 / eta(i)))
    # case e <= i
    d2 = 2.0 - E1(i) - psi / np.pi * E1(e)
    mu0e_2 = chi * (np.cos(i) + np.sin(i) * tb * (E2(i) - s2 * E2(e)) / d2)
    mue_2 = chi * (np.cos(e) + np.sin(e) * tb * (np.cos(psi) * E2(i) + s2 * E2(e)) / d2)
    S_2 = (mue_2 / eta(e)) * (mu0 / eta(i)) * chi / (1 - f + f * chi * (mu / eta(e)))
    first = i <= e
    return (np.where(first, mu0e_1, mu0e_2), np.where(first, mue_1, mue_2), np.where(first, S_1, S_2))


def radf(i_deg, e_deg, g_deg, w, b, c, bs0, hs, bc0=0.0, hc=1.0, theta_bar_deg=THETA_BAR_DEG, K=1.0):
    """Radiance factor I/F = π·r(i, e, g). Angles in degrees; the azimuth ψ follows from (i, e, g)."""
    i, e, g = (np.radians(np.asarray(v, float)) for v in (i_deg, e_deg, g_deg))
    si, se = np.sin(i), np.sin(e)
    denom = si * se
    cpsi = np.where(denom > 1e-12, (np.cos(g) - np.cos(i) * np.cos(e)) / np.where(denom > 1e-12, denom, 1), 1.0)
    psi = np.arccos(np.clip(cpsi, -1, 1))
    mu0e, mue, S = _roughness(i, e, psi, np.radians(theta_bar_deg))
    tg = np.tan(g / 2)
    Bs = 1.0 / (1.0 + tg / hs)
    x = tg / hc
    with np.errstate(invalid="ignore", divide="ignore"):
        Bc = np.where(x > 1e-9, (1 + (1 - np.exp(-x)) / np.where(x > 1e-9, x, 1)) / (2 * (1 + x) ** 2), 1.0)
    M = h_function(mu0e / K, w) * h_function(mue / K, w) - 1.0
    r = K * w / (4 * np.pi) * mu0e / (mu0e + mue) * (phase_dhg(g, b, c) * (1 + bs0 * Bs) + M) \
        * (1 + bc0 * Bc) * S
    return np.pi * r


def normal_over_standard(w, b, c, bs0, hs, bc0=0.0, hc=1.0, std=(60.0, 0.0, 60.0)):
    """RADF(0, 0, 0) / RADF(i, e, g)_std: converts reflectance normalized to the standard geometry into normal
    albedo with the same model and parameters that were used for the normalization."""
    return radf(0.0, 0.0, 0.0, w, b, c, bs0, hs, bc0, hc) / radf(*std, w, b, c, bs0, hs, bc0, hc)
