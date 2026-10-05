"""The Monte Carlo reference (photometry/titan_rt.py), the yardstick of Titan's model and of its rendering
(docs/reports/atmospheres.md "Titan"), against cases with exact solutions. No data products are needed."""

import math

import numpy as np
import pytest

from pipeline.photometry import atmo_bodies as ab, titan_rt as rt


def _bin_means(fn, mu_edges: np.ndarray, n: int = 41) -> np.ndarray:
    """Mean of fn(α) over each bin, uniform in cos α (the tally's solid-angle weighting)."""
    out = []
    for hi, lo in zip(mu_edges[:-1], mu_edges[1:]):
        mu = np.linspace(lo, hi, n)
        out.append(np.trapezoid([fn(math.acos(float(m))) for m in mu], mu) / (hi - lo))
    return np.array(out)


def test_bare_lambert_sphere():
    # No air: a Lambert sphere of reflectance ρ has A_g = 2ρ/3 and Φ(α) = (sin α + (π − α) cos α)/π (e.g. Russell
    # 1916). Tests the entry sampling, the surface reflection, the tally and its π R_top²/R² normalization: the
    # empty shell reaches 500 km above the sphere, and the sunlight that crosses it without touching the sphere is
    # not reflected light (it would otherwise pile up in the last bin).
    rho = 0.3
    alt = np.array([0.0, 250.0, 500.0])
    zero = np.zeros(alt.size)
    c = rt.disk_phase_curve(R=2575.0, alt=alt, ext=zero, sca=[zero], kinds=[-1], rhos=[0.0], phase_tables=[],
                            surface=rho, n_photons=400_000, nbins=36, seed=3)
    exact = _bin_means(lambda a: (2.0 * rho / 3.0) * (math.sin(a) + (math.pi - a) * math.cos(a)) / math.pi,
                       c["muEdges"])
    assert np.all(c["shell"] == 0.0)                       # nothing comes from beyond the solid limb
    assert np.all(np.abs(c["AgPhi"] - exact) <= 4.0 * c["sigma"] + 5e-4)
    assert c["AgPhi"][0] == pytest.approx(exact[0], rel=0.02)      # 0–19°: just under A_g = 2ρ/3
    assert 0.95 * (2.0 * rho / 3.0) < exact[0] < 2.0 * rho / 3.0
    assert c["AgPhi"][-1] < 1e-3                           # no transmitted beam in the tally


def _h_isotropic(omega: float, n: int = 64) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Chandrasekhar's H function for isotropic scattering on Gauss–Legendre nodes of (0, 1):
    1/H(μ) = √(1 − ω) + (ω/2) ∫ μ' H(μ')/(μ + μ') dμ' (Chandrasekhar 1960, §39), by iteration."""
    x, w = np.polynomial.legendre.leggauss(n)
    mu, w = 0.5 * (x + 1.0), 0.5 * w
    h = np.ones(n)
    for _ in range(500):
        new = 1.0 / (math.sqrt(1.0 - omega) + 0.5 * omega * ((w * mu * h)[None, :] / (mu[:, None] + mu[None, :])).sum(1))
        if np.abs(new - h).max() < 1e-13:
            break
        h = new
    return mu, w, h


def test_semi_infinite_isotropic_atmosphere():
    # A deep (τ = 40) isotropically scattering layer of single-scattering albedo ω over a black surface, on a sphere so
    # large that it is plane-parallel: the reflected radiance is Chandrasekhar's law I/F = (ω/4) μ0/(μ + μ0) H(μ) H(μ0),
    # so A_gΦ(α) = (1/π) ∫ (I/F) μ dΩ over the lit, visible part of the sphere. Tests the free paths (delta tracking
    # across bands), the implicit capture, the tabulated-phase sampling and the direction bookkeeping.
    omega = 0.6
    mu_n, _, h_n = _h_isotropic(omega)
    o = np.argsort(mu_n)
    h_of = lambda m: np.interp(m, mu_n[o], h_n[o])        # noqa: E731

    def exact(alpha: float) -> float:
        n = 240
        th = (np.arange(n) + 0.5) * math.pi / n            # colatitude from the pole perpendicular to the Sun-observer plane
        ph = (np.arange(2 * n) + 0.5) * math.pi / n
        st, ct = np.sin(th)[:, None], np.cos(th)[:, None]
        nx, ny, nz = st * np.cos(ph)[None, :], st * np.sin(ph)[None, :], ct + 0 * ph[None, :]
        mu = nz
        mu0 = nx * math.sin(alpha) + nz * math.cos(alpha)
        _ = ny
        lit = (mu > 0) & (mu0 > 0)
        m, m0 = np.where(lit, mu, 1.0), np.where(lit, mu0, 1.0)
        iof = (omega / 4.0) * m0 / (m + m0) * h_of(m) * h_of(m0)
        d_omega = st * (math.pi / n) ** 2
        return float((np.where(lit, iof * m, 0.0) * d_omega).sum() / math.pi)

    alt = np.array([0.0, 0.5, 1.0])
    ext = np.full(alt.size, 40.0)
    c = rt.disk_phase_curve(R=1.0e7, alt=alt, ext=ext, sca=[omega * ext], kinds=[0], rhos=[0.0],
                            phase_tables=[(np.array([0.0, 180.0]), np.array([1.0, 1.0]))], surface=0.0,
                            n_photons=400_000, nbins=18, seed=5)
    ref = _bin_means(exact, c["muEdges"], n=9)
    s = c["alphaDeg"] < 150.0                                # beyond, the reflected light is a few 1e-4 of the disk's
    assert np.all(np.abs(c["AgPhi"][s] - ref[s]) <= 4.0 * c["sigma"][s] + 0.01 * ref[s])
    # the geometric albedo itself: (ω/4) ∫ H(μ)² μ dμ
    mu, w, h = _h_isotropic(omega)
    assert exact(0.0) == pytest.approx(float(0.25 * omega * (w * h * h * mu).sum()), rel=2e-3)


def test_tabulated_phase_sampling_keeps_the_asymmetry():
    # The inverse-CDF sampler reproduces ⟨cos θ⟩ of a forward-peaked table (a Henyey–Greenstein function, g = 0.75,
    # on the product's angle grid).
    g = 0.75
    ang = ab.TITAN_PHASE_ANGLES
    p = (1 - g * g) / (1 + g * g - 2 * g * np.cos(np.radians(ang))) ** 1.5
    p = p / ab.mean_over_sphere_tab(ang, p)[0]
    mu_t, cdf_t = rt.phase_cdf(ang, p)
    u = (np.arange(20000) + 0.5) / 20000
    mu = np.array([rt._sample_tab(mu_t[0], cdf_t[0], float(x)) for x in u])
    assert mu.mean() == pytest.approx(float(ab.tab_asymmetry(ang, p)[0]), abs=2e-3)
    assert mu.mean() == pytest.approx(g, abs=0.01)
