"""Mars for atmospheres.json: seasonal column dust (MCD climatology scenario, Montabone et al.), dust single
scattering from the Wolff et al. (2009) properties used by the MCD and the MSL-measured phase function (Chen-Chen et
al. 2019), CO2 Rayleigh (Bodhaine et al. 1999 / Owens 1967), NSSDCA bulk atmosphere. docs/sources/mars-dust.md.

Areocentric solar longitude L_s from DE442 and the IAU (pck00011) pole of Mars: the Sun's longitude seen from
Mars, in Mars's orbital plane, from the vernal equinox x = pole × h (h = Mars's heliocentric orbital angular
momentum; the Sun crosses the equator northward there) — the definition used by SPICE's lspcn.
"""

from __future__ import annotations

import math
import re
from functools import lru_cache

import numpy as np
import spiceypy as sp

from .. import ephem_kernels as ek
from ..schema import BuildContext
from . import atmo
from .atmo_sources import LMD_DUST_OPTPROP, MCD_DUST_CLIM, nssdc_atmo, nssdc_table_value, first_number
from .common import read_table_json

DUST = read_table_json("mars_dust.json")
LS_BIN_DEG = 5.0
LAT_BAND_DEG = 6.0


# ---------------------------------------------------------------------------------------------- L_s
@lru_cache(maxsize=1)
def _kernels() -> tuple:
    return ek.lsk(), ek.planetary(), ek.pck()


def solar_longitude(et: np.ndarray) -> np.ndarray:
    """L_s (deg, 0-360) at TDB seconds past J2000."""
    lsk, spk, pck = _kernels()
    out = []
    with ek.pool(lsk, pck):
        sp.furnsh(str(spk))
        try:
            for t in np.atleast_1d(et):
                st, _ = sp.spkezr("MARS BARYCENTER", float(t), "J2000", "NONE", "SUN")
                r, v = np.array(st[:3]), np.array(st[3:])
                h = np.cross(r, v)
                pole = np.array(sp.tipbod("J2000", 499, float(t)))[2]
                x = np.cross(pole, h)
                x /= np.linalg.norm(x)
                z = h / np.linalg.norm(h)
                y = np.cross(z, x)
                s = -r / np.linalg.norm(r)                     # Mars -> Sun
                out.append(math.degrees(math.atan2(s @ y, s @ x)) % 360.0)
        finally:
            sp.unload(str(spk))
    return np.array(out)


def ls_zero_crossing(et_guess: float) -> float:
    """ET of the first L_s = 0 after et_guess - 400 days: daily scan (one vectorized call), then bisection."""
    t = et_guess - 400 * 86400.0 + np.arange(0.0, 800.0) * 86400.0
    ls = solar_longitude(t)
    k = int(np.nonzero(np.diff(ls) < 0)[0][0])       # wrapped 360 -> 0 between t[k] and t[k+1]
    lo, hi = t[k], t[k + 1]
    for _ in range(12):                                # 16 sub-steps per call: 86400 s / 16^12 << 1 s
        grid = np.linspace(lo, hi, 17)
        v = solar_longitude(grid)
        j = int(np.nonzero(v < 180.0)[0][0])
        lo, hi = grid[j - 1], grid[j]
        if hi - lo < 1e-3:
            break
    return 0.5 * (lo + hi)


def sol_seconds() -> float:
    """Mean solar day of Mars (s): NSSDCA 'Length of day (hrs)' (the fact sheet's solar day row)."""
    return nssdc_table_value("mars", "Length of day") * 3600.0


# ---------------------------------------------------------------------------------------------- dust columns
@lru_cache(maxsize=1)
def _dust_clim():
    from scipy.io import netcdf_file
    with netcdf_file(str(MCD_DUST_CLIM.fetch()), "r", mmap=False) as f:
        cdod = np.array(f.variables["cdod"].data, float)
        lat = np.array(f.variables["latitude"].data, float)
        sol = np.array(f.variables["Time"].data, float)
    return cdod, lat, sol


def dust_seasonal(ref_ls0_et: float) -> dict:
    """Visible column dust optical depth at 610 Pa (the LMD factor 2.6 × the 9.3 µm absorption CDOD) of the MCD
    climatology scenario, zonally averaged in LAT_BAND_DEG bands and binned in LS_BIN_DEG of L_s; plus the
    area-weighted global mean. Sol-of-year s of the file -> L_s by counting sols from an L_s = 0 epoch
    (ref_ls0_et) with the NSSDCA solar day."""
    cdod, lat, sol = _dust_clim()
    vis = DUST["lmd_climatology_page"]["visible_per_9um_absorption"] * cdod
    ls = solar_longitude(ref_ls0_et + (sol + 0.5) * sol_seconds())
    zonal = np.nanmean(vis, axis=2)                                   # (sol, lat)
    w = np.cos(np.radians(lat))
    glob = (zonal * w[None, :]).sum(axis=1) / w.sum()
    edges_ls = np.arange(0.0, 360.0 + LS_BIN_DEG, LS_BIN_DEG)
    b_ls = np.clip(np.digitize(ls, edges_ls) - 1, 0, edges_ls.size - 2)
    edges_lat = np.arange(-90.0, 90.0 + LAT_BAND_DEG, LAT_BAND_DEG)
    b_lat = np.clip(np.digitize(lat, edges_lat) - 1, 0, edges_lat.size - 2)
    nls, nlat = edges_ls.size - 1, edges_lat.size - 1
    tab = np.full((nls, nlat), np.nan)
    gl = np.full(nls, np.nan)
    for i in range(nls):
        rows = b_ls == i
        gl[i] = glob[rows].mean()
        for j in range(nlat):
            cols = b_lat == j
            tab[i, j] = np.average(zonal[np.ix_(rows, cols)].mean(axis=0), weights=w[cols])
    annual = float((glob).mean())
    return {"ls_centers": 0.5 * (edges_ls[:-1] + edges_ls[1:]), "lat_centers": 0.5 * (edges_lat[:-1] + edges_lat[1:]),
            "zonal": tab, "global": gl, "annual_global": annual, "sol_count": int(sol.size),
            "max_zonal": float(np.nanmax(zonal)), "min_global": float(glob.min()), "max_global": float(glob.max())}


# ---------------------------------------------------------------------------------------------- dust optics
@lru_cache(maxsize=1)
def dust_optics() -> dict:
    """LMD optprop_dustvis_TM.dat: wavelength (m), Q_ext, SSA, g for r_eff = 1.5 µm."""
    txt = LMD_DUST_OPTPROP.fetch().read_text()
    blocks = [b for b in re.split(r"#.*\n", txt) if b.strip()]
    nums = [np.array(b.split(), float) for b in blocks]
    nw = int(nums[0][0])
    wl = nums[2] * 1e9
    radius = float(nums[3][0])
    qext, ssa, g = nums[4], nums[5], nums[6]
    assert wl.size == nw == qext.size == ssa.size == g.size
    return {"wl_nm": wl, "qext": qext, "ssa": ssa, "g": g, "radius_m": radius}


def dust_spectral() -> dict[str, np.ndarray]:
    """On the 1 nm grid (the file's nodes are 263, 325, 388, 450, 513, 575, 638, 700, 800, 1173 nm; linear
    interpolation): Q_ext relative to 700 nm, SSA, g."""
    o = dust_optics()
    lam = atmo.FINE_VAC        # the file's wavelengths are physical (vacuum) wavelengths
    q = np.interp(lam, o["wl_nm"], o["qext"])
    q700 = float(np.interp(700.0, o["wl_nm"], o["qext"]))
    return {"qrel": q / q700, "ssa": np.interp(lam, o["wl_nm"], o["ssa"]), "g": np.interp(lam, o["wl_nm"], o["g"])}


def chen_chen_dhg() -> dict:
    c = DUST["chen_chen_2019_phase_function"]
    return {"g1": c["g1"], "g2": c["g2"], "alpha": c["alpha"]}


# ---------------------------------------------------------------------------------------------- gas
def bulk() -> dict:
    """NSSDCA surface pressure (Pa, at mean radius), scale height (km), mean molecular weight, surface gravity."""
    return {"p_pa": first_number(nssdc_atmo("mars", "Surface pressure")) * 100.0,
            "H_km": first_number(nssdc_atmo("mars", "Scale height")),
            "mu": first_number(nssdc_atmo("mars", "Mean molecular weight")),
            "g": nssdc_table_value("mars", "Surface gravity"),
            "co2_fraction": co2_fraction()}


def co2_fraction() -> float:
    m = re.search(r"Carbon Dioxide \(CO 2 \) - ([0-9.]+)%", nssdc_atmo("mars", "Major"))
    if not m:
        raise KeyError("Mars CO2 fraction not found in the NSSDCA sheet")
    return float(m.group(1)) / 100.0


def gas_column_m2(b: dict) -> float:
    """Column number density N = P / (m g) (hydrostatic, as Bodhaine Eq. 25)."""
    return b["p_pa"] / (b["mu"] * 1.66053906660e-27 * b["g"])


def build_ctx_sources(ctx: BuildContext | None) -> None:
    if ctx is not None:
        ek.lsk(ctx), ek.planetary(ctx), ek.pck(ctx)
