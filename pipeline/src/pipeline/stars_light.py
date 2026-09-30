"""Star light: spectra -> (X, Y, Z, S) illuminance through `cie`, and the photometric estimate for stars without
a usable spectrum.

All spectral integration goes through `cie.resample` + `cie.xyzs` (docs/architecture.md §4.2). For the ~0.5 M
Gaia XP spectra, which all share one wavelength grid, the composition resample∘xyzs is linear, so it is
evaluated once per grid sample (`linear_operator`) and applied as a matrix product: numerically identical to
calling the two functions per star, just fast.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import cie


def linear_operator(wl_nm: np.ndarray) -> np.ndarray:
    """(len(wl), 4) matrix W with xyzs(resample(wl, f)) == f @ W for any spectrum f sampled on wl."""
    n = wl_nm.size
    W = np.empty((n, 4))
    for j in range(n):
        e = np.zeros(n)
        e[j] = 1.0
        g = cie.resample(wl_nm, e)
        W[j] = cie.xyzs(g) if not np.isnan(g).any() else np.nan
    if np.isnan(W).any():
        raise ValueError("grid does not cover the CIE range")
    return W


def covers_cie(wl_nm: np.ndarray, valid: np.ndarray) -> bool:
    """True when valid samples bracket 360-830 nm and no sample in between is missing.

    A missing sample would force interpolation across unmeasured wavelengths, which is an assumption.
    """
    wl_nm = np.asarray(wl_nm)
    lo_idx = np.nonzero(valid & (wl_nm <= cie.WAVELENGTHS[0]))[0]
    hi_idx = np.nonzero(valid & (wl_nm >= cie.WAVELENGTHS[-1]))[0]
    if lo_idx.size == 0 or hi_idx.size == 0:
        return False
    return bool(valid[lo_idx.max():hi_idx.min() + 1].all())


def spectrum_xyzs(wl_nm: np.ndarray, flux: np.ndarray) -> np.ndarray:
    """(X, Y, Z, S) of one spectrum (W m^-2 nm^-1) with arbitrary sampling; NaN samples are dropped first."""
    ok = np.isfinite(flux)
    if not covers_cie(wl_nm, ok):
        raise ValueError("spectrum does not cover 360-830 nm without gaps")
    return cie.xyzs(cie.resample(wl_nm[ok], flux[ok]))


# ------------------------------------------------------------------------------- photometric estimate

@dataclass
class PhotometricRelation:
    """Empirical relation k(c) = median over calibration stars of XYZS * 10^(0.4 m), in bins of colour c.

    Predicts XYZS = 10^(-0.4 m) * k(c) for a star with magnitude m and colour c in the same photometric system.
    The calibration stars are stars whose XYZS was derived from their own Gaia XP spectrum, so the relation
    carries the XP flux scale and the assumption "stars of the same colour index have the same spectral
    shape" -- which is what makes the result `estimated`.
    """
    system: str             # e.g. "Hipparcos V, B-V"
    centers: np.ndarray     # bin centres in colour
    k: np.ndarray           # (nbins, 4)
    scatter_mag: np.ndarray  # robust sigma of -2.5 log10(Y_true / Y_pred) per bin
    n: np.ndarray           # stars per bin
    c_min: float
    c_max: float

    def predict(self, m: np.ndarray, c: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """(XYZS, extrapolated flag). Colours outside the calibrated range use the end bin (flagged)."""
        m = np.asarray(m, dtype=np.float64)
        c = np.asarray(c, dtype=np.float64)
        cc = np.clip(c, self.c_min, self.c_max)
        k = np.stack([np.interp(cc, self.centers, self.k[:, i]) for i in range(4)], axis=-1)
        return 10.0 ** (-0.4 * m)[:, None] * k, (c < self.c_min) | (c > self.c_max)

    def sigma_mag(self, c: np.ndarray) -> np.ndarray:
        return np.interp(np.clip(c, self.c_min, self.c_max), self.centers, self.scatter_mag)

    def summary(self) -> dict:
        return {"system": self.system, "colorRange": [self.c_min, self.c_max], "bins": int(self.centers.size),
                "stars": int(self.n.sum()),
                "medianScatterMag": float(np.median(self.scatter_mag))}


def fit_relation(system: str, m: np.ndarray, c: np.ndarray, xyzs: np.ndarray, *, per_bin: int = 50,
                 max_width: float = 0.25) -> PhotometricRelation:
    ok = np.isfinite(m) & np.isfinite(c) & np.isfinite(xyzs).all(axis=1) & (xyzs > 0).all(axis=1)
    m, c, xyzs = m[ok], c[ok], xyzs[ok]
    o = np.argsort(c)
    m, c, xyzs = m[o], c[o], xyzs[o]
    k_all = xyzs * 10.0 ** (0.4 * m)[:, None]
    # Adaptive bins: `per_bin` stars each, but never wider than max_width in colour (sparse ends get smaller n).
    edges = [0]
    while edges[-1] < c.size:
        i0 = edges[-1]
        i1 = min(i0 + per_bin, c.size)
        j = np.searchsorted(c, c[i0] + max_width, side="right")
        edges.append(max(i0 + 1, min(i1, j)))
    centers, ks, sc, ns = [], [], [], []
    for i0, i1 in zip(edges[:-1], edges[1:]):
        if i1 - i0 < 20:
            continue
        kk = np.median(k_all[i0:i1], axis=0)
        resid = -2.5 * np.log10(k_all[i0:i1, 1] / kk[1])
        centers.append(np.median(c[i0:i1]))
        ks.append(kk)
        sc.append(1.4826 * np.median(np.abs(resid - np.median(resid))))
        ns.append(i1 - i0)
    centers = np.array(centers)
    return PhotometricRelation(system=system, centers=centers, k=np.array(ks), scatter_mag=np.array(sc),
                               n=np.array(ns), c_min=float(centers[0]), c_max=float(centers[-1]))


def chromaticity(xyzs: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    s = xyzs[..., 0] + xyzs[..., 1] + xyzs[..., 2]
    return xyzs[..., 0] / s, xyzs[..., 1] / s
