"""Epoch propagation of catalogue astrometry (rigorous linear space motion).

Implements the standard formulae of The Hipparcos and Tycho Catalogues (ESA 1997, SP-1200, Vol. 1,
Sect. 1.5.5), also used for Gaia (Lindegren et al. 2021, A&A 649, A2, and the Gaia DR3 documentation,
"epoch propagation"):

    r(t) = [ r0 (1 + mu_r t) + mu0 t ] * f,   f = [1 + 2 mu_r t + (mu0^2 + mu_r^2) t^2]^(-1/2)

with r0 the barycentric unit vector at the reference epoch, mu0 = p mu_alpha* + q mu_delta the proper-motion
vector, and mu_r = v_r * parallax / A the "radial proper motion". When the parallax or radial velocity is
missing, mu_r = 0 (the perspective-acceleration term is dropped; its effect over a few decades is < 1 mas for
all but a handful of very nearby high-velocity stars).

Directions are barycentric (no parallax, no aberration), matching docs/architecture.md §3.4.
"""

from __future__ import annotations

import numpy as np

MAS = np.pi / (180.0 * 3600.0 * 1000.0)  # radians per milliarcsecond
#: 1 au/Julian year in km/s: au (IAU 2012 Resolution B2, 149 597 870.700 km) / (365.25 * 86400 s).
AU_PER_YR_KMS = 149597870.700 / (365.25 * 86400.0)
JULIAN_YEAR_S = 365.25 * 86400.0


def et_to_jyear(et: float) -> float:
    """TDB seconds past J2000 -> Julian epoch (J2000.0 + et / Julian year)."""
    return 2000.0 + et / JULIAN_YEAR_S


def radec_to_unit(ra_deg: np.ndarray, dec_deg: np.ndarray) -> np.ndarray:
    ra, dec = np.radians(ra_deg), np.radians(dec_deg)
    cd = np.cos(dec)
    return np.stack([cd * np.cos(ra), cd * np.sin(ra), np.sin(dec)], axis=-1)


def unit_to_radec(u: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    ra = np.degrees(np.arctan2(u[..., 1], u[..., 0])) % 360.0
    dec = np.degrees(np.arcsin(np.clip(u[..., 2] / np.linalg.norm(u, axis=-1), -1.0, 1.0)))
    return ra, dec


def propagate(ra_deg, dec_deg, pmra_masyr, pmdec_masyr, epoch0, epoch1, parallax_mas=None, rv_kms=None
              ) -> np.ndarray:
    """Barycentric unit vectors at epoch1 (Julian years) from positions at epoch0.

    pmra is mu_alpha* = mu_alpha cos(delta). Missing proper motion (NaN) is an error: callers decide what to
    do with 2-parameter solutions. Missing parallax / RV (NaN or None) drop the perspective term only.
    """
    ra = np.radians(np.asarray(ra_deg, dtype=np.float64))
    dec = np.radians(np.asarray(dec_deg, dtype=np.float64))
    pma = np.asarray(pmra_masyr, dtype=np.float64) * MAS
    pmd = np.asarray(pmdec_masyr, dtype=np.float64) * MAS
    if np.isnan(pma).any() or np.isnan(pmd).any():
        raise ValueError("proper motion missing for some stars")
    t = np.asarray(epoch1, dtype=np.float64) - np.asarray(epoch0, dtype=np.float64)
    sa, ca, sd, cd = np.sin(ra), np.cos(ra), np.sin(dec), np.cos(dec)
    p = np.stack([-sa, ca, np.zeros_like(ra)], axis=-1)
    q = np.stack([-sd * ca, -sd * sa, cd], axis=-1)
    r = np.stack([cd * ca, cd * sa, sd], axis=-1)
    mu0 = p * pma[..., None] + q * pmd[..., None]  # rad/yr
    mur = np.zeros_like(ra)
    if parallax_mas is not None and rv_kms is not None:
        plx = np.asarray(parallax_mas, dtype=np.float64)
        rv = np.asarray(rv_kms, dtype=np.float64)
        ok = np.isfinite(plx) & np.isfinite(rv) & (plx > 0)
        mur = np.where(ok, rv * np.where(ok, plx, 0.0) / AU_PER_YR_KMS * MAS, 0.0)  # rad/yr
    mu2 = (mu0 * mu0).sum(axis=-1)
    f = 1.0 / np.sqrt(1.0 + 2.0 * mur * t + (mu2 + mur * mur) * t * t)
    u = (r * (1.0 + mur * t)[..., None] + mu0 * np.asarray(t)[..., None]) * f[..., None]
    return u / np.linalg.norm(u, axis=-1, keepdims=True)


def position_sigma_mas(pos_sigma_mas, pm_sigma_masyr, dt_yr):
    """Rough 1-sigma position uncertainty after propagation (ignores correlations)."""
    return np.sqrt(np.asarray(pos_sigma_mas) ** 2 + (np.asarray(pm_sigma_masyr) * np.abs(dt_yr)) ** 2)


def separation_arcsec(u1: np.ndarray, u2: np.ndarray) -> np.ndarray:
    """Angle between unit vectors, arcsec (numerically stable for tiny angles)."""
    c = np.linalg.norm(np.cross(u1, u2), axis=-1)
    d = (u1 * u2).sum(axis=-1)
    return np.degrees(np.arctan2(c, d)) * 3600.0
