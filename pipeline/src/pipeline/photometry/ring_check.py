"""Independent check of the ring model: Saturn's disk-integrated brightness with and without rings.

Mallama & Hilton (2018) give Saturn's V magnitude with rings (their Eq. 10, fitted to ground photometry, valid for
α ≤ 6.5° and ring inclination β ≤ 27°) and for the globe alone (Eq. 11). Their difference is the net light the rings
add: ring light that reaches the observer minus the globe light the rings block. We compute the same from the ring
model (Y channel ≈ V) by integrating over the ring plane with Saturn as an oblate spheroid that hides and shadows the
rings, and with the rings in front of the globe blocking globe light in proportion to 1 − exp(−τ/μ).
"""

from __future__ import annotations

import math

import numpy as np

from . import phase as ph
from .ring_reflectance import RingModel, lit_geometry, mu_eff, _interp_regions, _lookup

SATURN_A, SATURN_C = 60268.0, 54364.0     # equatorial and polar radii (pck00011 BODY699_RADII)


def _hits_spheroid(p: np.ndarray, d: np.ndarray) -> np.ndarray:
    """Does the ray p + t d (t > 0) hit the spheroid x²/a² + y²/a² + z²/c² = 1? p: (N, 3), d: (3,)."""
    s = np.array([1 / SATURN_A, 1 / SATURN_A, 1 / SATURN_C])
    ps, ds = p * s, d * s
    qa = np.dot(ds, ds)
    qb = 2 * ps @ ds
    qc = np.einsum("ij,ij->i", ps, ps) - 1
    disc = qb * qb - 4 * qa * qc
    t_far = (-qb + np.sqrt(np.clip(disc, 0, None))) / (2 * qa)
    return (disc > 0) & (t_far > 0)


def ring_net_flux(model: RingModel, alpha: float, elev_deg: float, globe_py: float, globe_dm: float) -> dict:
    """Net ring flux (Y) over solar flux at Saturn, times Δ² (km²): ring light seen minus globe light blocked.
    The Sun and observer are both at elevation elev_deg (β = B = B′), separated in azimuth by the phase angle."""
    b = math.radians(elev_deg)
    o = np.array([math.cos(b), 0.0, math.sin(b)])
    # Sun at the same elevation, azimuth δ such that the angle to the observer is α
    cosd = (math.cos(math.radians(alpha)) - math.sin(b) ** 2) / math.cos(b) ** 2
    d = math.acos(max(-1.0, min(1.0, cosd)))
    s = np.array([math.cos(b) * math.cos(d), math.cos(b) * math.sin(d), math.sin(b)])
    mu = mu0 = math.sin(b)
    beff = math.degrees(math.asin(mu_eff(mu, mu0)))
    r = model.radius
    w = _interp_regions(r, {k: np.array([_lookup(v[..., 1], model.beff, model.phase, beff, alpha)])
                            for k, v in model.w_xyzs.items()})[:, 0]
    lm = np.nan_to_num(model.lit_mod)
    iof = lm * w * lit_geometry(model.tau, mu, mu0)
    theta = np.linspace(0, 2 * math.pi, 720, endpoint=False)
    dr, dth = float(r[1] - r[0]), float(theta[1] - theta[0])
    rr, tt = np.meshgrid(r, theta, indexing="ij")
    pts = np.stack([rr * np.cos(tt), rr * np.sin(tt), np.zeros_like(rr)], axis=-1).reshape(-1, 3)
    hidden = _hits_spheroid(pts, o).reshape(rr.shape)
    shadow = _hits_spheroid(pts, s).reshape(rr.shape)
    area = rr * dr * dth
    seen = (~hidden) & (~shadow)
    ring = float(np.sum((iof[:, None] * area * mu)[seen]) / math.pi)
    # globe light blocked by the rings in front of it: ring points whose line of sight continues into the globe
    behind = _hits_spheroid(pts, -o).reshape(rr.shape)
    opaque = 1 - np.exp(-model.tau / mu)
    # mean radiance of the lit globe per unit projected area, in units of the solar flux: p_Y 10^(-0.4 Δm) / π
    blocked = float(np.sum((opaque[:, None] * area * mu)[behind]) * globe_py * 10 ** (-0.4 * globe_dm) / math.pi)
    return {"ring": ring, "blocked": blocked, "net": ring - blocked}


def mallama_net_flux(alpha: float, elev_deg: float, globe_radius_km: float, v_sun: float) -> dict:
    """Net ring flux from Mallama & Hilton Eqs. 10 and 11, in the same units (solar flux at the planet × km²)."""
    v_sys = ph.mh_reduced_mag(699, alpha, rings_beta=elev_deg)
    v_globe = ph.mh_reduced_mag(699, alpha)
    au = 149597870.7
    f = lambda v: 10 ** (-0.4 * (v - v_sun)) * au ** 2      # noqa: E731  flux/E_sun(1 AU) × (1 AU)² in km²
    return {"V_system": v_sys, "V_globe": v_globe, "net": f(v_sys) - f(v_globe)}
