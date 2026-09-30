"""Disk integration of published surface photometric models -> disk-integrated phase curves.

A sphere is described in photometric coordinates (latitude β, longitude γ) with the observer at (0, 0) and the Sun at
(0, α) in the same great circle, so μ = cos β cos γ, μ0 = cos β cos(γ - α), and the lit, visible part is
α - π/2 ≤ γ ≤ π/2. The disk-integrated reflectivity (flux relative to a Lambert disk of the same radius seen face-on at
the same distances) is

    A(α) = (1/π) ∫∫ (I/F)(i, e, α) μ cos β dβ dγ ,        A(0) = geometric albedo,  Φ(α) = A(α)/A(0).

Two models are used:
  * Akimov disk function × phase function (Shkuratov et al. 1999; the form fitted by Filacchione et al. 2022). The
    integral has a closed form (below) and is checked against numerical quadrature in the tests.
  * Hapke (1981, 1986) bidirectional reflectance with a constant single-particle phase function P, the shadow-hiding
    opposition term B(α) = B0 / (1 + tan(α/2)/h) and the H-function approximation H(x) = (1 + 2x)/(1 + 2γx),
    γ = sqrt(1 - w), without macroscopic roughness. Used only at small phase angles (≤ 2°), where the roughness
    correction is nearly independent of α and cancels in Φ; the tests check it against the zero-phase corrections that
    Buie et al. (2010) derived from their own Hapke fits.
"""

from __future__ import annotations

import math

import numpy as np

_NODES = 96
_X, _W = np.polynomial.legendre.leggauss(_NODES)


def _gauss(a: float, b: float) -> tuple[np.ndarray, np.ndarray]:
    return 0.5 * (b - a) * _X + 0.5 * (b + a), 0.5 * (b - a) * _W


def integrate(radiance_factor, alpha_deg: float) -> float:
    """(1/π) ∫∫ (I/F)(μ0, μ, α) μ cos β dβ dγ over the lit, visible hemisphere (Gauss-Legendre in β and γ)."""
    a = math.radians(alpha_deg)
    g, wg = _gauss(a - math.pi / 2, math.pi / 2)
    b, wb = _gauss(-math.pi / 2, math.pi / 2)
    G, B = np.meshgrid(g, b, indexing="ij")
    W = np.outer(wg, wb)
    mu = np.cos(B) * np.cos(G)
    mu0 = np.cos(B) * np.cos(G - a)
    f = radiance_factor(np.clip(mu0, 0.0, None), np.clip(mu, 0.0, None), a, B, G)
    return float(np.sum(W * f * mu * np.cos(B)) / math.pi)


# ---------------------------------------------------------------------------------------------- Akimov
def akimov_disk(beta, gamma, a):
    """Akimov disk function D(β, γ, α) (Shkuratov et al. 1999, as Filacchione et al. 2022 Eq. 4), α in radians."""
    with np.errstate(divide="ignore", invalid="ignore"):
        d = (math.cos(a / 2) * np.cos(math.pi / (math.pi - a) * (gamma - a / 2))
             * np.cos(beta) ** (a / (math.pi - a)) / np.cos(gamma))
    return np.where(np.cos(gamma) > 0, d, 0.0)


def akimov_integral(alpha_deg: float) -> float:
    """J(α) = (1/π) ∫∫ D μ cos β dβ dγ in closed form. With D·cos γ separable,
    J = (1/π) cos(α/2) · [2(π-α)/π] · ∫ cos^n β dβ,  n = 2 + α/(π-α),  ∫_{-π/2}^{π/2} cos^n = √π Γ((n+1)/2)/Γ(n/2+1).
    J(0) = 1, so for I/F = D·F(α) the disk-integrated reflectivity is F(α)·J(α) and the geometric albedo is F(0)."""
    a = math.radians(alpha_deg)
    n = 2.0 + a / (math.pi - a)
    beta_int = math.sqrt(math.pi) * math.exp(math.lgamma((n + 1) / 2) - math.lgamma(n / 2 + 1))
    return math.cos(a / 2) * 2.0 * (math.pi - a) / math.pi * beta_int / math.pi


# ---------------------------------------------------------------------------------------------- Hapke
def hapke1986(w: float, p: float, b0: float, h: float):
    """Radiance factor I/F = π r of Hapke's (1981/1986) model with constant particle phase function P (no roughness)."""
    gam = math.sqrt(1.0 - w)

    def H(x):
        return (1.0 + 2.0 * x) / (1.0 + 2.0 * gam * x)

    def rf(mu0, mu, a, beta, gamma):
        bterm = b0 / (1.0 + math.tan(a / 2) / h) if h > 0 else 0.0
        with np.errstate(divide="ignore", invalid="ignore"):
            ls = np.where(mu0 + mu > 0, mu0 / (mu0 + mu), 0.0)
        return w / 4.0 * ls * ((1.0 + bterm) * p + H(mu0) * H(mu) - 1.0)

    return rf


def hapke1986_delta_mag(w: float, p: float, b0: float, h: float, alpha_deg: float) -> float:
    rf = hapke1986(w, p, b0, h)
    return -2.5 * math.log10(integrate(rf, alpha_deg) / integrate(rf, 0.0))
