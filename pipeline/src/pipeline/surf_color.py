"""Band maps → relative XYZS texels (docs/architecture.md §4.4, research note m2-worlds §1c "multiband").

A multiband map gives, at each texel x, the ratio ρ_b(x) = M_b(x)/⟨M_b⟩ of the local reflectance to its disk
average in each band b (centre λ_b). The local spectrum is modelled as r(x, λ) = p(λ)·ρ(x, λ), where p is the
body's measured disk-integrated albedo spectrum (the `light` stage input) and ρ(x, λ) is the band ratio
interpolated linearly between band centres and held flat beyond the outermost ones. Then

    texel_c(x) = ∫ p E☉ cmf_c ρ(x, λ) dλ / ∫ p E☉ cmf_c dλ = Σ_b W_cb ρ_b(x),     Σ_b W_cb = 1,

a fixed linear map per body (c ∈ X, Y, Z, S). Because ⟨ρ_b⟩ = 1 in every band, the disk average of every
channel is exactly 1 and the disk-integrated colour stays the measured one (energy consistency, §4.3).

The interpolation is an assumption. Criterion for calling the *colour* `derived` instead of `estimated`
(`color_label`): the bands must (a) bracket ≥ 99 % of every channel's sunlight-weighted observer integrand, and
(b) be spaced no wider than half the narrowest full width at half maximum of the four observer functions (x̄'s
main lobe, ȳ, z̄, V′) inside the range that holds the central 98 % of any channel's integrand, i.e. sample the
spectrum at the Nyquist rate of the eye's own spectral resolution. Otherwise the colour is `estimated`, and
`interpolation_spread` quantifies how much a different, equally defensible interpolant (monotone cubic) changes
the texels.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.interpolate import PchipInterpolator

from . import cie

CHANNELS = ("X", "Y", "Z", "S")


def observer_functions() -> np.ndarray:
    """(4, N): x̄, ȳ, z̄, V′ on cie.WAVELENGTHS."""
    return np.vstack([cie.cmfs().T, cie.scotopic()[None, :]])


def hat_basis(centers_nm) -> np.ndarray:
    """(nb, N) piecewise-linear interpolation basis on the CIE grid, flat beyond the outermost centres."""
    c = np.asarray(centers_nm, float)
    if np.any(np.diff(c) <= 0):
        raise ValueError("band centres must increase")
    eye = np.eye(c.size)
    return np.vstack([np.interp(cie.WAVELENGTHS, c, eye[b]) for b in range(c.size)])


def integrands(p_grid: np.ndarray, e_grid: np.ndarray) -> np.ndarray:
    """(4, N) p(λ)·E☉(λ)·observer_c(λ)."""
    return observer_functions() * (p_grid * e_grid)[None, :]


def channel_weights(centers_nm, p_grid: np.ndarray, e_grid: np.ndarray) -> np.ndarray:
    """(4, nb) W_cb: texel_c = Σ_b W_cb ρ_b. Rows sum to 1."""
    g = integrands(p_grid, e_grid)
    phi = hat_basis(centers_nm)
    return (g @ phi.T) / g.sum(axis=1, keepdims=True)


def _fwhm(f: np.ndarray, lobe: tuple[float, float] | None = None) -> float:
    wl = cie.WAVELENGTHS
    if lobe is not None:
        f = np.where((wl >= lobe[0]) & (wl <= lobe[1]), f, 0)
    half = f.max() / 2
    above = wl[f >= half]
    return float(above.max() - above.min())


def nyquist_spacing_nm() -> float:
    """Half the narrowest FWHM among x̄ (main lobe, > 500 nm), ȳ, z̄ and V′."""
    obs = observer_functions()
    widths = [_fwhm(obs[0], (500, 830)), _fwhm(obs[1]), _fwhm(obs[2]), _fwhm(obs[3])]
    return min(widths) / 2


@dataclass
class ColorDiagnostics:
    centers_nm: list[float]
    below_first: list[float]      # fraction of each channel's integrand below the first band centre
    above_last: list[float]       # ... above the last band centre
    max_gap_nm: float             # widest gap between adjacent centres inside the central 98 % range
    nyquist_nm: float
    label: str
    reason: str

    def to_json(self) -> dict:
        return {"bandCentersNm": self.centers_nm,
                "integrandFractionBelowFirstBand": dict(zip(CHANNELS, [round(v, 5) for v in self.below_first])),
                "integrandFractionAboveLastBand": dict(zip(CHANNELS, [round(v, 5) for v in self.above_last])),
                "widestBandGapNm": round(self.max_gap_nm, 1), "nyquistSpacingNm": round(self.nyquist_nm, 1),
                "colorLabelCriterion": self.reason}


def diagnostics(centers_nm, p_grid: np.ndarray, e_grid: np.ndarray) -> ColorDiagnostics:
    wl = cie.WAVELENGTHS
    c = np.asarray(centers_nm, float)
    g = integrands(p_grid, e_grid)
    tot = g.sum(axis=1)
    below = [float(g[k, wl < c[0]].sum() / tot[k]) for k in range(4)]
    above = [float(g[k, wl > c[-1]].sum() / tot[k]) for k in range(4)]
    lo, hi = 830.0, 360.0
    for k in range(4):
        cum = np.cumsum(g[k]) / tot[k]
        lo = min(lo, float(wl[np.searchsorted(cum, 0.01)]))
        hi = max(hi, float(wl[np.searchsorted(cum, 0.99)]))
    # interpolation gaps: consecutive band centres whose interval overlaps the central 98 % range
    pairs = [(a, b) for a, b in zip(c[:-1], c[1:]) if b > lo and a < hi]
    max_gap = float(max((b - a for a, b in pairs), default=hi - lo))
    nyq = nyquist_spacing_nm()
    ok_range = max(below) <= 0.005 and max(above) <= 0.005
    ok_gap = max_gap <= nyq
    label = "derived" if (ok_range and ok_gap) else "estimated"
    reason = (f"Band centres {', '.join(f'{v:g}' for v in c)} nm. Colour is 'derived' only if the bands bracket "
              f"≥ 99 % of every channel's sunlight-weighted observer integrand (here {100 * (1 - max(below) - max(above)):.1f} % "
              f"for the worst channel) and no gap between band centres inside the central 98 % range "
              f"({lo:.0f}-{hi:.0f} nm) exceeds half the narrowest observer-function FWHM ({nyq:.0f} nm; widest gap "
              f"here {max_gap:.0f} nm). Result: {label}.")
    return ColorDiagnostics([float(v) for v in c], below, above, max_gap, nyq, label, reason)


def interpolation_spread(rho: np.ndarray, centers_nm, p_grid: np.ndarray, e_grid: np.ndarray) -> dict:
    """Per-channel spread between linear and monotone-cubic (PCHIP) interpolation of the band ratios, for a sample
    of texels rho (n, nb). Returns 50th/99th percentile and max of |Δtexel/texel|."""
    c = np.asarray(centers_nm, float)
    g = integrands(p_grid, e_grid)
    tot = g.sum(axis=1)
    W = channel_weights(c, p_grid, e_grid)
    lin = rho @ W.T
    wl = cie.WAVELENGTHS
    x = np.clip(wl, c[0], c[-1])
    cub = np.empty_like(lin)
    for n in range(rho.shape[0]):
        spec = PchipInterpolator(c, rho[n])(x)
        cub[n] = (g * spec[None, :]).sum(axis=1) / tot
    d = np.abs(cub - lin) / np.maximum(np.abs(lin), 1e-12)
    return {ch: {"p50": float(np.percentile(d[:, k], 50)), "p99": float(np.percentile(d[:, k], 99)),
                 "max": float(d[:, k].max())} for k, ch in enumerate(CHANNELS)}
