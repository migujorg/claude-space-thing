"""Earth's clear atmosphere for atmospheres.json: molecules (US Standard Atmosphere 1976 + Bodhaine et al. 1999
Rayleigh), ozone (US76 mid-latitude ozone model + Serdyuchenko et al. 2014 cross-sections) and a global-mean
aerosol (MACv2, Kinne 2019). docs/sources/us-standard-atmosphere-1976.md, bodhaine-1999.md, serdyuchenko-2014.md,
kinne-2019-macv2.md.
"""

from __future__ import annotations

import math
from functools import lru_cache

import numpy as np

from .common import Download, bin_average, read_table_json, vacuum_to_air
from . import atmo

US76 = Download(
    id="us-standard-atmosphere-1976",
    url="https://ntrs.nasa.gov/api/citations/19770009539/downloads/19770009539.pdf",
    subdir="atmospheres", name="US_Standard_Atmosphere_1976_NTRS19770009539.pdf",
    title="U.S. Standard Atmosphere, 1976 (defining tables, main tables, mid-latitude ozone model)",
    citation="U.S. Standard Atmosphere, 1976. NOAA, NASA, USAF. NOAA-S/T 76-1562 (NASA-TM-X-74335), U.S. Government "
             "Printing Office, Washington D.C., 1976. NTRS 19770009539.",
    notes="Tables 2, 3, 4, 8 and 18 and check rows of main Tables I-II transcribed to "
          "photometry/tables/us_standard_atmosphere_1976.json (docs/sources/us-standard-atmosphere-1976.md).",
    license="U.S. Government work",
)
BODHAINE = Download(
    id="bodhaine-1999",
    url="https://journals.ametsoc.org/view/journals/atot/16/11/1520-0426_1999_016_1854_orodc_2_0_co_2.xml",
    subdir="atmospheres", name="Bodhaine1999_JTECH16_1854.html",
    title="On Rayleigh optical depth calculations (full-text page; equations and tables are images)",
    citation="Bodhaine, B. A., Wood, N. B., Dutton, E. G. & Slusser, J. R. (1999). On Rayleigh optical depth "
             "calculations. Journal of Atmospheric and Oceanic Technology 16, 1854-1861. "
             "DOI:10.1175/1520-0426(1999)016<1854:ORODC>2.0.CO;2.",
    notes="Eqs. 5, 6, 18-25, 27 and Tables 2-3 transcribed from the page's equation/table images to "
          "photometry/tables/bodhaine_1999_rayleigh.json (docs/sources/bodhaine-1999.md).",
    browser_agent=True,
    sha256="4028e03ca2e540c151b58fb5f53dc6df2d3c538ae59ce4803f5e3f92487a6ab0", retrieved="2026-09-30",
)
SERDYUCHENKO = Download(
    id="serdyuchenko-2014-o3",
    url="https://www.iup.uni-bremen.de/gruppen/molspec/downloads/serdyuchenkogorshelev5digits.dat",
    subdir="atmospheres", name="serdyuchenkogorshelev5digits.dat",
    title="Ozone absorption cross-sections 213-1100 nm at 193-293 K (IUP Bremen, version 25.07.2012)",
    citation="Serdyuchenko, A., Gorshelev, V., Weber, M., Chehade, W. & Burrows, J. P. (2014). High spectral "
             "resolution ozone absorption cross-sections - Part 2: Temperature dependence. Atmospheric "
             "Measurement Techniques 7, 625-636. DOI:10.5194/amt-7-625-2014; and Gorshelev, V., et al. (2014), "
             "Part 1: Measurements, data analysis and comparison with previous measurements around 293 K, AMT 7, "
             "609-624, DOI:10.5194/amt-7-609-2014. Data: IUP Bremen Molecular Spectroscopy Lab, O3 spectra (2011).",
    notes="Column 1 vacuum wavelength (nm), columns 2-12 cross-section (cm^2/molecule) at 293, 283, ..., 193 K "
          "(data page). Absolute accuracy < 0.5 % systematic (data page).",
)
MACV2 = Download(
    id="kinne-2019-macv2",
    url="https://b.tellusjournals.se/articles/89/files/submission/proof/89-1-1569-1-10-20220630.pdf",
    subdir="atmospheres", name="Kinne2019_TellusB71_1623639.pdf",
    title="The MACv2 aerosol climatology (global annual averages, Tables 2-3)",
    citation="Kinne, S. (2019). The MACv2 aerosol climatology. Tellus B: Chemical and Physical Meteorology 71, "
             "1623639. DOI:10.1080/16000889.2019.1623639.",
    notes="Tables 2 and 3 transcribed to photometry/tables/kinne_2019_macv2.json (docs/sources/kinne-2019-macv2.md).",
    license="CC BY 4.0",
)

_T = read_table_json("us_standard_atmosphere_1976.json")
_C = _T["table2_constants"]
K_B, N_A, R_STAR, G0, P0, R0, T0 = (_C["k_J_per_K"], _C["N_A_per_kmol"], _C["Rstar_J_per_kmol_K"], _C["g0_m_s2"],
                                    _C["P0_Pa"], _C["r0_m"], _C["T0_K"])
M0 = _T["table3_composition"]["M0_text_kg_per_kmol"]
HB = np.array(_T["table4_layers"]["Hb_km_geopotential"]) * 1e3          # m'
LMB = np.array(_T["table4_layers"]["LMb_K_per_km_geopotential"]) / 1e3   # K/m'
TOP_KM = 86.0


def _bases() -> tuple[np.ndarray, np.ndarray]:
    """T_M,b and P_b at each layer base, by applying eqs. 23, 33a/b layer by layer from the sea-level values."""
    tb, pb = [T0], [P0]
    for b in range(len(LMB)):
        dh = HB[b + 1] - HB[b]
        t1 = tb[b] + LMB[b] * dh
        if LMB[b] != 0.0:
            p1 = pb[b] * (tb[b] / t1) ** (G0 * M0 / (R_STAR * LMB[b]))
        else:
            p1 = pb[b] * math.exp(-G0 * M0 * dh / (R_STAR * tb[b]))
        tb.append(t1)
        pb.append(p1)
    return np.array(tb), np.array(pb)


TMB, PB = _bases()


def geopotential_m(z_m: np.ndarray) -> np.ndarray:
    """Eq. 18."""
    z = np.asarray(z_m, float)
    return R0 * z / (R0 + z)


def us76(z_km: np.ndarray) -> dict[str, np.ndarray]:
    """US76 T (K), P (Pa) and total number density N (m^-3) at geometric altitudes -5..86 km."""
    z = np.asarray(z_km, float) * 1e3
    if np.any(z > TOP_KM * 1e3 + 1e-6) or np.any(z < -5e3):
        raise ValueError("US76 defining equations used here cover -5..86 km")
    h = geopotential_m(z)
    b = np.clip(np.searchsorted(HB, h, side="right") - 1, 0, len(LMB) - 1)
    lb, tb, pb, hb = LMB[b], TMB[b], PB[b], HB[b]
    tm = tb + lb * (h - hb)
    with np.errstate(divide="ignore", invalid="ignore"):
        p_lin = pb * (tb / tm) ** (G0 * M0 / (R_STAR * np.where(lb == 0, 1.0, lb)))
    p_iso = pb * np.exp(-G0 * M0 * (h - hb) / (R_STAR * tb))
    p = np.where(lb != 0, p_lin, p_iso)
    t8 = _T["table8_molecular_weight_ratio"]
    ratio = np.interp(z, t8["Z_m"], t8["M_over_M0"], left=1.0, right=t8["M_over_M0"][-1])
    t = tm * ratio
    n = N_A * p / (R_STAR * t)
    return {"T": t, "T_M": tm, "P": p, "N": n}


def us76_tables_n(z_km: np.ndarray) -> np.ndarray:
    """N as tabulated in the Standard (computed with T = T_M, i.e. without the 80-86 km M/M0 ratio; Table 8 text)."""
    r = us76(z_km)
    return N_A * r["P"] / (R_STAR * r["T_M"])


# ---------------------------------------------------------------------------------------------- ozone
def ozone_n(z_km: np.ndarray) -> np.ndarray:
    """US76 Table 18 mid-latitude ozone number density (m^-3), log-linear between the 2 km levels; constant
    below 2 km (assumption; the table starts at 2 km) and zero above 74 km."""
    t = _T["table18_ozone"]
    zt = np.array(t["Z_m"], float) / 1e3
    ln = np.log(np.array(t["n_O3_m3"], float))
    z = np.asarray(z_km, float)
    out = np.exp(np.interp(z, zt, ln))
    return np.where(z > zt[-1], 0.0, out)


@lru_cache(maxsize=1)
def ozone_cross_sections() -> tuple[np.ndarray, np.ndarray]:
    """(temperatures K ascending (11,), σ (11, 471) m^2): Serdyuchenko et al. cross-sections averaged over each 1 nm
    bin of the CIE (standard-air) grid; vacuum wavelengths converted with Edlén (1966)."""
    path = SERDYUCHENKO.fetch()
    rows = []
    with path.open() as f:
        for line in f:
            parts = line.split()
            if len(parts) != 12:
                continue
            try:
                vals = [float(v) for v in parts]
            except ValueError:
                continue
            if 350.0 <= vals[0] <= 840.0:
                rows.append(vals)
    a = np.array(rows)
    wl_air = vacuum_to_air(a[:, 0])
    temps = np.array([293, 283, 273, 263, 253, 243, 233, 223, 213, 203, 193], float)
    sig = np.vstack([bin_average(wl_air, a[:, 1 + k]) for k in range(11)]) * 1e-4   # cm^2 -> m^2
    order = np.argsort(temps)
    return temps[order], sig[order]


def ozone_sigma_at(temp_k: np.ndarray) -> np.ndarray:
    """(n_alt, 471): cross-sections linearly interpolated in temperature (clamped to 193-293 K)."""
    temps, sig = ozone_cross_sections()
    t = np.clip(np.asarray(temp_k, float), temps[0], temps[-1])
    i = np.clip(np.searchsorted(temps, t) - 1, 0, temps.size - 2)
    f = (t - temps[i]) / (temps[i + 1] - temps[i])
    return sig[i] * (1 - f)[:, None] + sig[i + 1] * f[:, None]


# ---------------------------------------------------------------------------------------------- aerosol
_MAC = read_table_json("kinne_2019_macv2.json")


def aerosol_spectral() -> dict[str, np.ndarray]:
    """MACv2 global annual mean AOD, SSA and asymmetry on the 1 nm grid: AOD log-log interpolated between 450, 550
    and 1000 nm (piecewise Ångström law; below 450 nm the 450-550 nm exponent continued), SSA and ASY linear in
    ln λ (constant below 450 nm)."""
    t = _MAC["table2"]
    lam = np.array(t["lambda_um"]) * 1e3
    ln_l = np.log(atmo.FINE)
    aod = np.exp(np.interp(ln_l, np.log(lam), np.log(t["AOD_total"])))
    slope = (math.log(t["AOD_total"][1]) - math.log(t["AOD_total"][0])) / (math.log(lam[1]) - math.log(lam[0]))
    below = atmo.FINE < lam[0]
    aod[below] = t["AOD_total"][0] * (atmo.FINE[below] / lam[0]) ** slope
    ssa = np.interp(ln_l, np.log(lam), t["SSA_total"])
    asy = np.interp(ln_l, np.log(lam), t["ASY_total"])
    return {"aod": aod, "ssa": ssa, "g": asy}


def aerosol_profile(z_km: np.ndarray) -> np.ndarray:
    """Relative extinction profile (km^-1 per unit column) from MACv2 Table 3 layer AODs (0-1, 1-3, 3-6, 6-12 km
    a.s.l.), piecewise constant, sampled at the grid altitudes and renormalized so that the trapezoid column over the
    grid is 1."""
    t = _MAC["table3"]
    z = np.asarray(z_km, float)
    layers = np.array(t["layers_km_asl"], float)
    aod = np.array(t["AOD_per_layer_total"], float)
    frac = aod / aod.sum()
    prof = np.zeros_like(z)
    for (lo, hi), f in zip(layers, frac):
        prof[(z >= lo) & (z < hi)] = f / (hi - lo)
    return prof / np.trapezoid(prof, z)
