"""Diffuse sky: Pioneer 10/11 IPP maps, HEALPix binning/smoothing, S10sun <-> physical units, two-band spectra.

Units. The Pioneer maps are in S10(G2V) = S10sun: the brightness of one solar-type star of V = 10 per square degree,
i.e. 1 S10sun = 6.61e-12 F_sun / sr in any band (Leinert et al. 1998, p. 4), F_sun = solar flux at 1 AU averaged
over that band (here from the TSIS-1 HSRS spectrum used by the light stage). A band radiance L (W m^-2 nm^-1 sr^-1)
is therefore L / (6.61e-12 F_sun,band) S10sun.
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np
from scipy import sparse
from scipy.spatial import cKDTree

from . import sky_healpix as hp
from .download import fetch

PIONEER_BASE = "https://www.stsci.edu/~kgordon/pioneer_ipp/"
PIONEER_SUBDIR = "sky/pioneer_ipp"
S10_PER_SOLAR_FLUX_SR = 6.61e-12


def fetch_pioneer() -> dict[str, object]:
    paths = {n: fetch(PIONEER_BASE + n, PIONEER_SUBDIR) for n in
             ("README", "Pioneer_10_11_IPP.html", "P_all_1_B.fits", "P_all_1_R.fits")}
    return paths


def load_pioneer(band: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(values [720, 1440] S10sun with NaN where there is no data (stored as 0), lon centres, lat centres), galactic.
    Pixel (row, col) has centre l = 180 + (col + 1 - 720) * 0.25, b = (row + 1 - 360) * 0.25 (FITS header CRPIX,
    CRVAL, CDELT; 1-based pixel indices)."""
    from astropy.io import fits
    p = fetch(PIONEER_BASE + f"P_all_1_{band}.fits", PIONEER_SUBDIR)
    with fits.open(p) as h:
        hd = h[0].header
        d = np.asarray(h[0].data, float)
    if hd["CTYPE1"].strip() != "gal. long." or hd["CTYPE2"].strip() != "gal. lat.":
        raise ValueError(f"unexpected Pioneer map axes: {hd['CTYPE1']!r}, {hd['CTYPE2']!r}")
    ny, nx = d.shape
    lon = hd["CRVAL1"] + (np.arange(nx) + 1 - hd["CRPIX1"]) * hd["CDELT1"]
    lat = hd["CRVAL2"] + (np.arange(ny) + 1 - hd["CRPIX2"]) * hd["CDELT2"]
    d[d == 0.0] = np.nan
    return d, lon, lat


@lru_cache(maxsize=1)
def galactic_to_icrs() -> np.ndarray:
    """3x3 rotation matrix v_icrs = M @ v_gal (IAU 1958 galactic system as realised by astropy for ICRS)."""
    from astropy.coordinates import SkyCoord
    import astropy.units as u
    e = SkyCoord(l=[0.0, 90.0, 0.0] * u.deg, b=[0.0, 0.0, 90.0] * u.deg, frame="galactic").icrs
    cols = hp.ang_to_vec(e.ra.deg, e.dec.deg)
    return cols.T


def bin_grid_to_healpix(values: np.ndarray, lon: np.ndarray, lat: np.ndarray, order: int,
                        rot: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Area-weighted mean of a lon/lat grid (NaN = no data) in each HEALPix pixel; returns (mean, covered solid
    angle fraction). `rot` rotates grid vectors into the HEALPix frame."""
    L, B = np.meshgrid(lon, lat)
    v = hp.ang_to_vec(L.ravel(), B.ravel())
    if rot is not None:
        v = v @ rot.T
    pix = hp.vec2pix(order, v)
    w = np.cos(np.radians(B.ravel()))                  # cell solid angle is proportional to cos(b)
    ok = np.isfinite(values.ravel())
    n = hp.npix(order)
    num = np.bincount(pix[ok], weights=(values.ravel() * w)[ok], minlength=n)
    den = np.bincount(pix[ok], weights=w[ok], minlength=n)
    tot = np.bincount(pix, weights=w, minlength=n)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(den > 0, num / den, np.nan), np.where(tot > 0, den / tot, 0.0)


def gauss_matrix(order_in: int, order_out: int, fwhm_deg: float, radius_sigma: float = 3.0) -> sparse.csr_matrix:
    """Sparse (npix_out x npix_in) Gaussian kernel exp(-theta^2 / 2 sigma^2) between pixel centres (unnormalised)."""
    sig = np.radians(fwhm_deg) / np.sqrt(8 * np.log(2))
    vin = hp.pix2vec(order_in, np.arange(hp.npix(order_in)))
    vout = hp.pix2vec(order_out, np.arange(hp.npix(order_out)))
    tree = cKDTree(vin)
    rmax = 2 * np.sin(radius_sigma * sig / 2)
    lists = tree.query_ball_point(vout, rmax)
    rows = np.repeat(np.arange(len(lists)), [len(x) for x in lists])
    cols = np.concatenate([np.asarray(x, np.int64) for x in lists])
    cosang = np.einsum("ij,ij->i", vout[rows], vin[cols])
    theta = np.arccos(np.clip(cosang, -1, 1))
    w = np.exp(-theta ** 2 / (2 * sig ** 2))
    return sparse.csr_matrix((w, (rows, cols)), shape=(vout.shape[0], vin.shape[0]))


def smooth(K: sparse.csr_matrix, values: np.ndarray, weights: np.ndarray | None = None) -> np.ndarray:
    """Normalised convolution: K (v w) / K w; NaN values carry no weight."""
    v = np.asarray(values, float)
    w = np.ones_like(v) if weights is None else np.asarray(weights, float)
    w = np.where(np.isfinite(v), w, 0.0)
    num = K @ np.where(w > 0, v * w, 0.0)
    den = K @ w
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(den > 0, num / den, np.nan)


def to_parent(values: np.ndarray, order_in: int, order_out: int, weights: np.ndarray | None = None) -> np.ndarray:
    """Weighted mean over NESTED children (order_out < order_in)."""
    f = 4 ** (order_in - order_out)
    v = np.asarray(values, float).reshape(-1, f)
    w = np.ones_like(v) if weights is None else np.asarray(weights, float).reshape(-1, f)
    w = np.where(np.isfinite(v), w, 0.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(w.sum(1) > 0, np.nansum(v * w, 1) / w.sum(1), np.nan)


def to_children(values: np.ndarray, order_in: int, order_out: int) -> np.ndarray:
    return np.repeat(np.asarray(values), 4 ** (order_out - order_in))


# ---------------------------------------------------------------------------------------------- spectra

def band_mean(wl_nm: np.ndarray, f: np.ndarray, center: float, width: float) -> float:
    lo, hi = center - width / 2, center + width / 2
    fine = np.arange(lo, hi + 0.005, 0.01)
    return float(np.trapezoid(np.interp(fine, wl_nm, f), fine) / (fine[-1] - fine[0]))


class TwoBand:
    """Spectra of the form I(lambda) = a F_sun(lambda) (lambda / lambda_B)^alpha: solar spectrum with a power-law
    tilt, fixed by two band brightnesses in S10sun (B and R). XYZS per unit `a` is tabulated in alpha."""

    def __init__(self, wl_nm: np.ndarray, f_sun: np.ndarray, grid_f_sun: np.ndarray, grid_wl: np.ndarray, xyzs_fn,
                 bands: dict[str, tuple[float, float]]):
        self.bands = bands
        (cb, wb), (cr, wr) = bands["B"], bands["R"]
        self.fb = band_mean(wl_nm, f_sun, cb, wb)
        self.fr = band_mean(wl_nm, f_sun, cr, wr)
        self.alpha = np.linspace(-6.0, 6.0, 1201)
        rb, rr, xyzs = [], [], []
        for a in self.alpha:
            t = (wl_nm / cb) ** a
            rb.append(band_mean(wl_nm, f_sun * t, cb, wb) / self.fb)
            rr.append(band_mean(wl_nm, f_sun * t, cr, wr) / self.fr)
            xyzs.append(xyzs_fn(grid_f_sun * (grid_wl / cb) ** a))
        self.rb, self.rr, self.xyzs = np.array(rb), np.array(rr), np.array(xyzs)
        self.ratio = self.rr / self.rb           # S10_R / S10_B as a function of alpha (monotonic increasing)

    def xyzs_from_s10(self, s10_b: np.ndarray, s10_r: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """(XYZS radiance in cd/m^2 and scotopic cd/m^2, alpha); NaN where B or R <= 0 or not finite."""
        b = np.asarray(s10_b, float)
        r = np.asarray(s10_r, float)
        ok = np.isfinite(b) & np.isfinite(r) & (b > 0) & (r > 0)
        q = np.where(ok, r / np.where(ok, b, 1.0), np.nan)
        alpha = np.interp(q, self.ratio, self.alpha, left=np.nan, right=np.nan)
        out = np.full(b.shape + (4,), np.nan)
        good = ok & np.isfinite(alpha)
        # a = S10_B * 6.61e-12 / rb(alpha): the tilted spectrum's B-band mean equals S10_B solar B-band means / sr
        for c in range(4):
            xyz_c = np.interp(alpha[good], self.alpha, self.xyzs[:, c])
            rb = np.interp(alpha[good], self.alpha, self.rb)
            out[good, c] = b[good] * S10_PER_SOLAR_FLUX_SR / rb * xyz_c
        return out, alpha
