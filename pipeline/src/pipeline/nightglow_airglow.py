"""Nightglow (airglow) of the Earth: emission spectra, intensities and climatology for the `nightglow` stage.

Source: PALACE v1.0, the Paranal Airglow Line And Continuum Emission model (Noll et al. 2025, GMD 18, 4353; data
CC-BY-4.0, Zenodo 10.5281/zenodo.14064022). It is a semi-empirical model built from 10 years of VLT X-shooter
spectra (and UVES data) at Cerro Paranal (24.6 deg S, 70.4 deg W): 26 541 lines and three unresolved continua of
OH, O2, HO2, FeO, Na, K, O, N and H, with top-of-atmosphere zenith intensities (the annual nocturnal mean at a
solar radio flux of 100 sfu) and, for 23 variability classes, a climatology on 12 months x 12 local-time bins:
relative intensity f0, solar-cycle slope m_SCE (% per sfu) and residual variability. The scaling (PALACE Eq. 1):

    f(month, LT, srf) = f0(month, LT) [1 + 0.01 m_SCE(month, LT) (srf - 100)],

srf being the centred 27-day mean of the 10.7 cm solar radio flux (sfu). Bins are "night" where the solar zenith
angle exceeds 100 deg (wbin = nighttime fraction of the bin at Paranal); values in bins without Paranal night are
PALACE's extrapolations.

What this module adds (each step stated in the product's `method` fields):
* Spectra -> colour: each class's lines (vacuum wavelengths -> standard air, Edlen 1966) and continuum (R/nm) are
  integrated against the CIE observers: luminance (X, Y, Z in cd/m^2, S in scotopic cd/m^2) of a column emission
  of 1 rayleigh of the class's spectrum, i.e. radiance 1e10/(4 pi) photons m^-2 s^-1 sr^-1 per R.
* Vertical structure (not in PALACE, which needs only a reference height for the van Rhijn effect): a Gaussian
  volume-emission profile at PALACE's reference layer height with an FWHM of 8.6 km for the mesopause emissions
  (the mean OH layer thickness from 34 rocket flights, Baker & Stair 1988, as quoted by Wuest et al. 2023 and
  PALACE Sect. 4.1) and sigma = 50 km for the thermospheric O and N lines (PALACE Sect. 4.5: "the major fraction
  of the emission is usually emitted between 200 and 300 km, and typical peak heights are around 250 km", read
  as +-1 sigma). Both are assumptions for the other species (estimated).
* srf: daily 10.7 cm flux observed at DRAO Penticton (the 20 UT measurement), centred 27-day means; months
  without observations use the NOAA SWPC predicted monthly F10.7 (estimated).
"""

from __future__ import annotations

import datetime as _dt
import io
import json
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import cie
from .photometry.common import bin_average, spectral_density_to_air, vacuum_to_air

H_PLANCK = 6.62607015e-34        # J s (SI defining constant)
C_M_S = 299792458.0              # m/s (SI defining constant)
#: photons m^-2 s^-1 sr^-1 of radiance per rayleigh of column emission rate (1 R = 1e10/(4 pi) of these; Hunten,
#: Roach & Chamberlain 1956, the definition of the rayleigh: 1e6 photons cm^-2 s^-1 emitted into 4 pi)
PHOTON_RADIANCE_PER_R = 1e10 / (4.0 * np.pi)
SRF0 = 100.0                     # PALACE reference solar radio flux (sfu); also the FITS header SRF0
NIGHT_MIN_SZA_DEG = 100.0        # PALACE's nighttime limit (solar zenith angle at the ground)
LT_BIN_CENTRES_H = [-5.5, -4.5, -3.5, -2.5, -1.5, -0.5, 0.5, 1.5, 2.5, 3.5, 4.5, 5.5]  # tbin 1..12 (18-19 h ... 5-6 h)

#: Layer thickness assumptions (module docstring)
MESOPAUSE_FWHM_KM = 8.6          # Baker & Stair (1988): 86.8 +- 2.6 km peak, 8.6 +- 3.1 km FWHM (34 rocket flights)
MESOPAUSE_FWHM_SD_KM = 3.1
THERMOSPHERE_SIGMA_KM = 50.0     # PALACE Sect. 4.5, 200-300 km as +-1 sigma around 250 km
THERMOSPHERE_MIN_KM = 150.0      # a layer whose reference height is above this is thermospheric

NAMES = {
    "Og": "[O I] 557.7 nm green line", "Or": "[O I] 630.0/636.4 nm red lines", "Orc": "O I recombination lines (777.4 nm, ...)",
    "Na": "Na D 589.0/589.6 nm", "K": "K D 766.5/769.9 nm", "N": "[N I] 519.8/520.0 nm", "H": "H Balmer lines (geocorona)",
    "O2a": "O2 a-X (1.27 um)", "O2b": "O2 b-X atmospheric bands (762, 865 nm ...)", "O2Ac": "O2 Herzberg/Chamberlain bands + continuum",
    "HO2": "HO2 pseudo-continuum", "FeO": "FeO pseudo-continuum (~600 nm)",
}


def _oh_name(v: str) -> str:
    return f"OH Meinel bands, class {v[2:]}"


@dataclass
class Palace:
    lines: dict          # columns of palace_lines.fits (numpy arrays)
    cont: dict           # lam (um, vacuum) and fcont1..3 (R/nm) + meta
    var: dict            # columns of palace_var.fits (144 rows: mbin x tbin)
    var_meta: dict
    cont_meta: dict
    version: str


def read_palace(zip_path: Path) -> Palace:
    """The three model FITS tables from the Zenodo release zip (PALACE.zip)."""
    from astropy.io import fits
    out = {}
    metas = {}
    with zipfile.ZipFile(zip_path) as z:
        for key in ("lines", "cont", "var"):
            name = next(n for n in z.namelist() if n.endswith(f"palace_{key}.fits"))
            with fits.open(io.BytesIO(z.read(name))) as h:
                hdu = h[1]
                out[key] = {c: np.array(hdu.data[c]) for c in hdu.columns.names}
                metas[key] = {k: hdu.header[k] for k in hdu.header if k not in ("COMMENT", "HISTORY")}
    var_meta = metas["var"]
    if float(var_meta.get("SRF0", SRF0)) != SRF0:
        raise ValueError(f"PALACE SRF0 {var_meta.get('SRF0')} != {SRF0}")
    return Palace(lines=out["lines"], cont=out["cont"], var=out["var"], var_meta=var_meta, cont_meta=metas["cont"],
                  version=str(metas["cont"].get("VERSION", "")))


def class_ids(p: Palace) -> list[str]:
    return [p.var_meta[f"VARID{j:02d}"] for j in range(1, int(p.var_meta["NVARID"]) + 1)]


def class_chem(p: Palace) -> dict[str, str]:
    return {p.var_meta[f"VARID{j:02d}"]: p.var_meta[f"CHEM{j:02d}"] for j in range(1, int(p.var_meta["NVARID"]) + 1)}


def _decode(a) -> np.ndarray:
    return np.array([x.decode() if isinstance(x, bytes) else str(x) for x in a]).astype(str)


# ---------------------------------------------------------------------------------------------- spectra -> XYZS

def _observer_at(wl_air_nm: np.ndarray) -> np.ndarray:
    """(n, 4) K_m x̄, K_m ȳ, K_m z̄, K'_m V' at the given standard-air wavelengths (linear in the 1 nm CIE tables;
    zero outside 360-830 nm)."""
    wl = np.asarray(wl_air_nm, float)
    cm = cie.cmfs()
    v = cie.scotopic()
    g = cie.WAVELENGTHS
    cols = [np.interp(wl, g, cm[:, k], left=0.0, right=0.0) * cie.KM_PHOTOPIC for k in range(3)]
    cols.append(np.interp(wl, g, v, left=0.0, right=0.0) * cie.KM_SCOTOPIC)
    return np.stack(cols, axis=1)


def line_xyzs(wl_vac_nm: np.ndarray, intensity_r: np.ndarray) -> np.ndarray:
    """XYZS (cd/m^2, scotopic cd/m^2) of emission lines given as column intensities in R (zenith radiance of a
    layer seen face-on): sum of K_m cmf(λ) (hc/λ) I 1e10/(4 pi)."""
    wl = vacuum_to_air(np.asarray(wl_vac_nm, float))
    e_ph = H_PLANCK * C_M_S / (wl * 1e-9)
    rad_w = np.asarray(intensity_r, float) * PHOTON_RADIANCE_PER_R * e_ph       # W m^-2 sr^-1
    return (rad_w[:, None] * _observer_at(wl)).sum(axis=0)


def line_xyzs_air(nm_air: float, intensity_r: float) -> np.ndarray:
    """XYZS of one line given in standard-air wavelength (nm) and column intensity (R)."""
    wl = np.array([float(nm_air)])
    e_ph = H_PLANCK * C_M_S / (wl * 1e-9)
    return float(intensity_r) * PHOTON_RADIANCE_PER_R * float(e_ph[0]) * _observer_at(wl)[0]


def tables() -> dict:
    return json.loads((Path(__file__).parent / "nightglow_tables" / "airglow.json").read_text(encoding="utf-8"))


def continuum_xyzs(lam_vac_um: np.ndarray, flux_r_per_nm: np.ndarray) -> np.ndarray:
    """XYZS of a continuum given in R per nm of vacuum wavelength (PALACE's unit), via the CIE grid (1 nm bins of
    standard-air wavelength, exact bin averages of the piecewise-linear spectrum)."""
    wl_vac = np.asarray(lam_vac_um, float) * 1e3
    m = (wl_vac > 340.0) & (wl_vac < 850.0)
    wl_air, per_nm_air = spectral_density_to_air(wl_vac[m], np.asarray(flux_r_per_nm, float)[m])
    grid = bin_average(wl_air, per_nm_air)                         # R per nm (air) on the CIE grid
    e_ph = H_PLANCK * C_M_S / (cie.WAVELENGTHS * 1e-9)
    return cie.xyzs(grid * PHOTON_RADIANCE_PER_R * e_ph)


@dataclass
class ClassSpectrum:
    id: str
    chem: str
    layer_km: float
    total_r: float                  # all lines + continua, 0.3-2.5 um (TOA zenith, annual nocturnal mean, 100 sfu)
    visible_r: float                # 360-830 nm (air)
    xyzs_ref: np.ndarray            # zenith XYZS at the reference intensity
    lines_vis: list                 # brightest lines in 360-830 nm: (nm air, R)

    @property
    def xyzs_per_r(self) -> np.ndarray:
        return self.xyzs_ref / self.total_r if self.total_r > 0 else np.zeros(4)


def class_spectra(p: Palace) -> dict[str, ClassSpectrum]:
    lam = p.lines["lam"] * 1e3
    inten = p.lines["I"].astype(float)
    var = _decode(p.lines["varID"])
    hl = p.lines["hlayer"].astype(float)
    chem = class_chem(p)
    out: dict[str, ClassSpectrum] = {}
    cont_ids = {p.cont_meta[f"VARID{i}"]: i for i in range(1, int(p.cont_meta["NCONT"]) + 1)}
    for cid in class_ids(p):
        m = var == cid
        xyzs = line_xyzs(lam[m], inten[m]) if m.any() else np.zeros(4)
        tot = float(inten[m].sum())
        wl_air = vacuum_to_air(lam[m]) if m.any() else np.zeros(0)
        vis_m = (wl_air >= 360.0) & (wl_air <= 830.0)
        vis = float(inten[m][vis_m].sum())
        heights = set(hl[m].tolist())
        layer = heights.pop() if heights else None
        if heights:
            raise ValueError(f"PALACE class {cid}: lines on several layer heights")
        if cid in cont_ids:
            i = cont_ids[cid]
            fc = p.cont[f"fcont{i}"].astype(float)
            lamc = p.cont["lam"].astype(float)
            xyzs = xyzs + continuum_xyzs(lamc, fc)
            tot += float(np.trapezoid(fc, lamc * 1e3))
            wa = vacuum_to_air(lamc * 1e3)
            mv = (wa >= 360.0) & (wa <= 830.0)
            vis += float(np.trapezoid(fc[mv], lamc[mv] * 1e3))
            hc = float(p.cont_meta[f"HLAYER{i}"])
            if layer is not None and layer != hc:
                raise ValueError(f"PALACE class {cid}: continuum layer {hc} km != line layer {layer} km")
            layer = hc
        top = np.argsort(-np.where(vis_m, inten[m], 0.0))[:6] if m.any() else []
        lines_vis = [(round(float(wl_air[k]), 3), round(float(inten[m][k]), 3)) for k in top if vis_m[k] and inten[m][k] > 0]
        out[cid] = ClassSpectrum(id=cid, chem=chem[cid], layer_km=float(layer if layer is not None else -1.0),
                                 total_r=tot, visible_r=vis, xyzs_ref=xyzs, lines_vis=lines_vis)
    return out


# ---------------------------------------------------------------------------------------------- climatology

def climatology(p: Palace, cid: str) -> dict[str, list[list[float]]]:
    """12 x 12 [month][LT bin] tables of f0 (rI), m_SCE (SCE, % per sfu) and the residual variability (rdI)."""
    mb, tb = p.var["mbin"].astype(int), p.var["tbin"].astype(int)
    out = {}
    for key, col in (("f0", f"rI_{cid}"), ("sce", f"SCE_{cid}"), ("sigma", f"rdI_{cid}")):
        t = np.full((12, 12), np.nan)
        t[mb - 1, tb - 1] = p.var[col]
        if not np.isfinite(t).all():
            raise ValueError(f"PALACE climatology {col} incomplete")
        out[key] = [[round(float(x), 5) for x in row] for row in t]
    return out


def night_weights(p: Palace) -> list[list[float]]:
    mb, tb = p.var["mbin"].astype(int), p.var["tbin"].astype(int)
    t = np.zeros((12, 12))
    t[mb - 1, tb - 1] = p.var["wbin"]
    return [[round(float(x), 4) for x in row] for row in t]


def month_centre_doy(p: Palace) -> list[int]:
    mb, d = p.var["mbin"].astype(int), p.var["cDOY"].astype(int)
    return [int(d[mb == m][0]) for m in range(1, 13)]


def scale(f0: float, sce: float, srf: float) -> float:
    """PALACE Eq. 1."""
    return f0 * (1.0 + 0.01 * sce * (srf - SRF0))


def annual_nocturnal_mean(p: Palace, cid: str, srf: float = SRF0) -> float:
    """Night-weighted mean of the scaling factor over all bins (PALACE's reference is 1 at 100 sfu, to the
    accuracy of their Gaussian-mixture averaging)."""
    c = climatology(p, cid)
    w = np.array(night_weights(p))
    f = np.array([[scale(c["f0"][i][j], c["sce"][i][j], srf) for j in range(12)] for i in range(12)])
    return float((f * w).sum() / w.sum())


# ---------------------------------------------------------------------------------------------- layers

def layer_profile(height_km: float) -> dict:
    """Gaussian vertical profile (module docstring): {centreKm, sigmaKm, fwhmKm, kind}."""
    if height_km >= THERMOSPHERE_MIN_KM:
        s = THERMOSPHERE_SIGMA_KM
        kind = "thermosphere"
    else:
        s = MESOPAUSE_FWHM_KM / (2.0 * np.sqrt(2.0 * np.log(2.0)))
        kind = "mesopause"
    return {"centreKm": float(height_km), "sigmaKm": float(s), "fwhmKm": float(2.0 * np.sqrt(2.0 * np.log(2.0)) * s),
            "kind": kind}


def gaussian_column_limb_ratio(r_km: float, sigma_km: float) -> float:
    """Limb-to-zenith ratio of a thin spherical Gaussian layer for a tangent ray at the peak (closed form of
    ∫exp(-(s^2/2r)^2/(2 sigma^2)) ds / (sigma sqrt(2 pi)), the parabolic approximation h - h_t = s^2/(2r)): the
    order of magnitude a limb view enhances the zenith brightness (check value for the renderer's quadrature)."""
    from math import gamma, sqrt, pi
    return 2.0 * gamma(1.25) * (8.0 * r_km ** 2 * sigma_km ** 2) ** 0.25 / (sigma_km * sqrt(2.0 * pi))


# ---------------------------------------------------------------------------------------------- solar radio flux

def read_drao_fluxtable(path: Path) -> list[tuple[_dt.date, float]]:
    """Daily observed 10.7 cm flux (sfu) from DRAO's fluxtable.txt: the 20:00 UT measurement of each day (the
    'local noon' reference value; 17:00 or 23:00 UT where 20:00 is missing)."""
    by_day: dict[_dt.date, dict[int, float]] = {}
    for ln in path.read_text(encoding="utf-8", errors="replace").splitlines():
        f = ln.split()
        if len(f) < 7 or not f[0].isdigit() or len(f[0]) != 8:
            continue
        try:
            d = _dt.date(int(f[0][:4]), int(f[0][4:6]), int(f[0][6:8]))
            hour = int(f[1]) // 10000
            obs = float(f[4])
        except ValueError:
            continue
        if obs <= 0:
            continue
        by_day.setdefault(d, {})[hour] = obs
    out = []
    for d in sorted(by_day):
        h = by_day[d]
        v = next((h[k] for k in (20, 17, 23, 18, 19, 21, 22) if k in h), None)
        if v is not None:
            out.append((d, v))
    return out


def read_swpc_predicted_f107(path: Path) -> dict[str, float]:
    """NOAA SWPC predicted monthly F10.7 ('YYYY-MM' -> sfu) from predicted-solar-cycle.json."""
    d = json.loads(path.read_text(encoding="utf-8"))
    out = {}
    for x in d:
        v = x.get("predicted_f10.7")
        if v is not None:
            out[x["time-tag"]] = float(v)
    return out


def srf_series(daily: list[tuple[_dt.date, float]], predicted: dict[str, float], start: _dt.date, end: _dt.date
               ) -> dict:
    """Centred 27-day means of the daily flux for every day start..end. A day whose window holds 27 observed days
    is 'derived'; otherwise the missing days take the SWPC predicted monthly value of their month and the day is
    'estimated' (a day with no prediction and no observation is 'unknown', value null)."""
    obs = {d: v for d, v in daily}
    days, vals, labels = [], [], []
    d = start
    while d <= end:
        win = [d + _dt.timedelta(days=k) for k in range(-13, 14)]
        xs, n_obs, n_pred = [], 0, 0
        for w in win:
            if w in obs:
                xs.append(obs[w])
                n_obs += 1
            elif f"{w.year:04d}-{w.month:02d}" in predicted:
                xs.append(predicted[f"{w.year:04d}-{w.month:02d}"])
                n_pred += 1
        if n_obs + n_pred == 27:
            vals.append(round(float(np.mean(xs)), 2))
            labels.append("derived" if n_pred == 0 else "estimated")
        else:
            vals.append(None)
            labels.append("unknown")
        days.append(d.isoformat())
        d += _dt.timedelta(days=1)
    segs = []
    for i, lab in enumerate(labels):
        if not segs or segs[-1]["label"] != lab:
            segs.append({"label": lab, "from": days[i], "to": days[i]})
        else:
            segs[-1]["to"] = days[i]
    last_obs = max((x for x in obs if x <= end), default=None)
    return {"firstDay": days[0], "values": vals, "labelSegments": segs,
            "lastObservedDay": last_obs.isoformat() if last_obs else None}
