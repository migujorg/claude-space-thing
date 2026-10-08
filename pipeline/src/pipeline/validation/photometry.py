"""Instrument-band I/F → band radiance and absolute XYZS radiance (what the renderer's HDR buffer holds).

Band I/F (as the calibrations define it): the solar-weighted band average of the scene reflectance r(λ),
    I/F_b = ∫ r E☉ T_b w dλ / ∫ E☉ T_b w dλ,      w = λ for photon-counting responses, 1 otherwise.
Band radiance: L_b = I/F_b · Ē_b / (π d²), Ē_b = ∫ E☉ T_b w dλ / ∫ T_b w dλ (1 AU, W m⁻² nm⁻¹), d in AU.

XYZS: the ROI spectrum is modelled exactly as the app models surface colour (pipeline/surf_color.py):
    r(λ) = p̃(λ)·ρ(λ),   ρ_b = I/F_b / p̃_b   (p̃_b: band average of p̃ with the same weighting),
p̃ = the body's disk-integrated geometric-albedo spectrum (the `light` stage input; any normalisation), ρ interpolated
linearly between the bands' effective wavelengths and held flat beyond. Then
    L_c = G_c · Σ_b W_cb ρ_b,   G_c = K_c ∫ p̃ E☉ c̄(λ) dλ / (π d²),   W = surf_color.channel_weights(λ_b, p̃, E☉),
with K_c = 683.002 lm/W (X, Y, Z; cd/m²) or 1700.06 lm/W (S; scotopic cd/m²) and c̄ the CIE 1931 2° / 1951 scotopic
observers on the CIE standard-air grid — the same units and solar spectrum as light.json.

Uncertainties (1σ, relative, per band): calibration (from the instrument documentation), noise (ROI std/√n) and
registration (ROI mean gradient × the registration error). Calibration is treated as fully correlated between bands
(conservative: it scales all channels together), noise and registration as independent. The spectral model adds
the spread between linear and monotone-cubic (PCHIP) interpolation of ρ (surf_color.interpolation_spread) when there
are ≥ 2 bands, and for a single band the difference between the p̃-shaped spectrum and a flat (grey) one, taken as
the 1σ of the unknown spectral shape.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from .. import cie, surf_color
from ..photometry import filters, solar

CHANNELS = ("X", "Y", "Z", "S")


@lru_cache(maxsize=None)
def band_weights(key: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(λ, T·w, E☉·T·w) on the HSRS air grid inside the passband."""
    lam, ew = filters.solar_weights(key)
    fw, ft = filters.passband(key)
    t = np.interp(lam, fw, ft, left=0.0, right=0.0)
    tw = t * lam if key in filters.PHOTON_COUNTERS else t
    return lam, tw, ew


def band_solar_irradiance(key: str) -> float:
    """Ē_b at 1 AU, W m⁻² nm⁻¹."""
    lam, tw, ew = band_weights(key)
    return float(ew.sum() / tw.sum())


def band_average(key: str, wl: np.ndarray, p: np.ndarray) -> float:
    lam, _, ew = band_weights(key)
    return float(np.sum(np.interp(lam, wl, p) * ew) / ew.sum())


def effective_wavelength(key: str, wl: np.ndarray, p: np.ndarray) -> float:
    lam, _, ew = band_weights(key)
    w = ew * np.interp(lam, wl, p)
    return float(np.sum(lam * w) / w.sum())


@dataclass
class ShapeSpectrum:
    wl: np.ndarray
    p: np.ndarray
    label: str
    sources: list[str]
    note: str

    def on_grid(self) -> np.ndarray:
        return np.interp(cie.WAVELENGTHS, self.wl, self.p)       # flat beyond the tabulated range


FLAT = ShapeSpectrum(np.array([300.0, 1100.0]), np.array([1.0, 1.0]), "estimated", [],
                     "flat (grey) spectrum: no measured spectral shape for this surface")


@dataclass
class BandValue:
    key: str
    iof: float
    sigma_rel: dict[str, float]          # calibration, noise, registration


def xyzs_radiance(bands: list[BandValue], shape: ShapeSpectrum, sun_au: float) -> dict:
    """Expected XYZS radiance and its uncertainty budget from band I/F values."""
    e_grid = solar.spectrum().grid
    p_grid = shape.on_grid()
    order = sorted(range(len(bands)), key=lambda i: effective_wavelength(bands[i].key, shape.wl, shape.p))
    bs = [bands[i] for i in order]
    centers = np.array([effective_wavelength(b.key, shape.wl, shape.p) for b in bs])
    rho = np.array([b.iof / band_average(b.key, shape.wl, shape.p) for b in bs])
    G = cie.xyzs(p_grid * e_grid) / (np.pi * sun_au ** 2)
    if len(bs) >= 2:
        W = surf_color.channel_weights(centers, p_grid, e_grid)
    else:
        W = np.ones((4, 1))
    L = G * (W @ rho)
    cal = np.array([b.sigma_rel["calibration"] for b in bs])
    ind = np.array([np.hypot(b.sigma_rel["noise"], b.sigma_rel["registration"]) for b in bs])
    wr = W * rho[None, :]
    s_cal = G * np.abs(wr @ cal)                                   # fully correlated
    s_ind = G * np.sqrt((wr ** 2) @ (ind ** 2))
    if len(bs) >= 2:
        sp = surf_color.interpolation_spread(rho[None, :], centers, p_grid, e_grid)
        s_model = np.array([sp[c]["max"] for c in CHANNELS]) * np.abs(L)
        model_note = "linear vs monotone-cubic interpolation of ρ between band centres"
    else:
        # grey spectrum through the same band value
        Gf = cie.xyzs(e_grid) / (np.pi * sun_au ** 2)
        Lf = Gf * bs[0].iof / band_average(bs[0].key, FLAT.wl, FLAT.p)
        s_model = np.abs(L - Lf)
        model_note = "single band: difference between the p̃-shaped and a grey spectrum through the band value"
    total = np.sqrt(s_cal ** 2 + s_ind ** 2 + s_model ** 2)
    diag = surf_color.diagnostics(centers, p_grid, e_grid) if len(bs) >= 2 else None
    return {
        "value": [float(v) for v in L],
        "sigma": [float(v) for v in total],
        "budget": {"calibration": [float(v) for v in s_cal], "noiseAndRegistration": [float(v) for v in s_ind],
                   "spectralModel": [float(v) for v in s_model], "spectralModelMethod": model_note},
        "bandCentersNm": [round(float(c), 2) for c in centers],
        "bandOrder": [b.key for b in bs],
        "rho": [float(r) for r in rho],
        "channelWeights": [[float(v) for v in row] for row in W],
        "radiancePerUnitRho": [float(v) for v in G],
        "colorCriterion": diag.reason if diag else "single band: colour from the shape spectrum only",
        "label": ("derived" if diag is not None and diag.label == "derived" and shape.label != "estimated"
                  else "estimated"),
    }


def band_radiance(key: str, iof: float, sun_au: float) -> float:
    """W m⁻² sr⁻¹ nm⁻¹."""
    return float(iof * band_solar_irradiance(key) / (np.pi * sun_au ** 2))


def ratio_spectral_spread(rho_a, rho_b, centers_nm, shape: ShapeSpectrum) -> np.ndarray:
    """Non-cancelling linear/PCHIP spread of a same-body ratio, in ratio units.

    Apply each existing spectral convention to BOTH regions before dividing. A
    common multiplicative spectral factor cancels; differences in local band
    colours can leave a differential interpolation term. This extends the region
    budget's established convention (linear/PCHIP difference counted as 1 sigma).
    """
    from scipy.interpolate import PchipInterpolator
    centers = np.asarray(centers_nm, float)
    if centers.size == 1:
        return np.zeros(4)
    p_grid, e_grid = shape.on_grid(), solar.spectrum().grid
    W = surf_color.channel_weights(centers, p_grid, e_grid)
    weights = surf_color.integrands(p_grid, e_grid)
    x = np.clip(cie.WAVELENGTHS, centers[0], centers[-1])
    a, b = np.asarray(rho_a), np.asarray(rho_b)
    lin = (W @ a) / (W @ b)
    cub = (weights @ PchipInterpolator(centers, a)(x)) / (weights @ PchipInterpolator(centers, b)(x))
    return np.abs(cub - lin)
