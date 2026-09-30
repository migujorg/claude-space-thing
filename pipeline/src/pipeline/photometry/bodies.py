"""photometry.json: NAIF id -> BodyPhotometry (docs/architecture.md §4.3), plus consistency diagnostics."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .. import cie
from ..schema import BuildContext, sourced, worst
from . import albedo, filters, phase, solar
from .common import AU_KM, bin_average

BODIES = {199: "Mercury", 299: "Venus", 399: "Earth", 301: "Moon", 499: "Mars", 599: "Jupiter", 699: "Saturn",
          799: "Uranus", 899: "Neptune", 999: "Pluto"}


@dataclass
class BodyResult:
    naif: int
    name: str
    spectrum: albedo.AlbedoSpectrum
    phase: phase.Phase
    p_grid: np.ndarray
    xyzs: np.ndarray
    p_v: float
    p_v_band: float | None      # Bessell-V band average of the spectrum (equals p_v unless overridden)
    radius_km: float
    v10: float                  # V(1,0) implied by p_v and radius
    v10_published: float | None
    entry: dict


def v10_from_albedo(p_v: float, radius_km: float) -> float:
    return albedo.sun_mag("V") - 2.5 * math.log10(p_v * (radius_km / AU_KM) ** 2)


def build_body(naif: int, ctx: BuildContext | None = None) -> BodyResult:
    spec = albedo.spectrum_for(naif, ctx)
    ph = phase.phase_for(naif, ctx)
    e = solar.spectrum()
    p_grid = bin_average(spec.wl, spec.p)
    if np.isnan(p_grid).any():
        raise ValueError(f"{naif}: albedo spectrum does not cover 360-830 nm")
    xyzs = cie.xyzs(p_grid * e.grid)
    p_v_band = filters.band_average("V", spec.wl, spec.p)
    p_v = p_v_band
    r = albedo.mean_radius(naif)
    v10 = v10_from_albedo(p_v, r)

    if ctx is not None:
        common_src = [solar.HSRS.register(ctx), *cie.register_sources(ctx)]
        v_src = filters.register(ctx, ("V",))
    else:
        common_src = [solar.HSRS.id, cie.SOURCE_CMF, cie.SOURCE_SCOTOPIC]
        v_src = ["bessell-1990-v"]

    def uniq(xs):
        return list(dict.fromkeys(xs))

    x_label = worst(spec.label, "derived")
    entry = {
        "geometricAlbedoXYZS": sourced(
            [float(v) for v in xyzs], x_label, uniq([*spec.sources, *common_src]), unit="lux at 1 AU",
            method=f"{spec.method} XYZS = K∫p(λ)E_sun,1AU(λ)cmf(λ)dλ on the 1 nm 360-830 nm grid (p and the TSIS-1 "
                   f"HSRS both averaged over 1 nm bins; K_m = 683.002, K′_m = 1700.06 lm/W). Referenced to R = "
                   f"{r:.1f} km (volumetric mean radius (abc)^(1/3) from pck00011): E_obs(α=0) = XYZS·(1/d²)(R/Δ)².",
            uncertainty=spec.uncertainty),
        "geometricAlbedoV": sourced(
            round(float(p_v), 5),
            spec.p_v_label or x_label,
            uniq([*spec.sources, *v_src]),
            method=spec.p_v_method or (
                "Johnson V geometric albedo: band average of p(λ) weighted by the Bessell (1990) V passband × the "
                f"TSIS-1 HSRS solar spectrum, referenced to R = {r:.1f} km."),
            uncertainty=spec.uncertainty),
        "phaseFunction": sourced(ph.function, ph.label, ph.sources, method=ph.method, uncertainty=ph.uncertainty),
    }
    published = ph.zero_phase_V10
    if naif == 799:
        # V1(0) = -7.110 - 8.4e-4 phi' ; for the source epoch (1995 July) evaluate at that epoch's phi'
        published = None
    return BodyResult(naif, BODIES[naif], spec, ph, p_grid, xyzs, float(p_v), p_v_band, r, v10, published, entry)


def build_all(ctx: BuildContext | None = None) -> dict[int, BodyResult]:
    return {n: build_body(n, ctx) for n in BODIES}


def photometry_json(results: dict[int, BodyResult]) -> dict:
    return {str(n): r.entry for n, r in results.items()}
