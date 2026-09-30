"""Checks of atmospheres.json against published values (docs/reports/atmospheres.md; tests/test_atmospheres.py)."""

from __future__ import annotations

import math
import re
import warnings

import numpy as np

from .. import cie
from . import atmo, atmo_bodies as ab, atmo_earth as ae, atmo_mars as am, atmo_sources as src, solar
from .common import read_table_json

BOD = read_table_json("bodhaine_1999_rayleigh.json")
US = read_table_json("us_standard_atmosphere_1976.json")
M_U = 1.66053906660e-27     # kg (CODATA 2018 atomic mass constant)
K_B = 1.380649e-23


def bodhaine_sigma() -> dict:
    t = BOD["table3"]
    lam = np.array(t["lambda_um"]) * 1e3
    ours = atmo.sigma_air(lam) * 1e4
    return {"lambda_nm": lam, "ours_cm2": ours, "table_cm2": np.array(t["sigma_cm2"]),
            "max_rel": float(np.max(np.abs(ours / np.array(t["sigma_cm2"]) - 1))),
            "king_max_abs": float(np.max(np.abs(atmo.king_air_bodhaine(lam / 1e3) - np.array(t["king_factor"]))))}


def bodhaine_g_eff() -> float:
    """Bodhaine's effective gravity implied by Table 3 (τ/σ = P A/(m_a g)) at 550 nm, m/s²."""
    t = BOD["table3"]
    i = t["lambda_um"].index(0.55)
    col_cm2 = t["tau_sea_level_45N"][i] / t["sigma_cm2"][i]
    return 1013250.0 * BOD["constants"]["N_A_per_mol"] / (BOD["constants"]["m_a_360ppm_g_per_mol"] * col_cm2) / 100.0


def co2_check() -> dict:
    """Bodhaine Table 2 τ(CO2) for 360 ppm at 300, 340, 370 nm: σ_CO2 P A/(44.01 g) × 0.00036 with the g implied
    by their Table 3 (their Section 5 recipe)."""
    t = BOD["table2_co2"]
    lam = np.array(t["lambda_nm"], float)
    g = bodhaine_g_eff()
    col = 101325.0 * BOD["constants"]["N_A_per_mol"] / (44.01e-3 * g)
    ours = atmo.sigma_co2(lam) * col * 0.00036
    i = list(lam).index(370.0)
    return {"lambda_nm": lam, "ours": ours, "table": np.array(t["tau_CO2"]),
            "max_rel": float(np.max(np.abs(ours / np.array(t["tau_CO2"]) - 1))),
            "table_ratio370": float(t["tau_CO2"][i] / (t["tau_N2_O2_Ar"][i] * 0.00036)),
            "our_ratio370": float(atmo.sigma_co2(np.array([370.0]))[0] / atmo.sigma_air(np.array([370.0]))[0])}


def co2_refractivity_check() -> dict:
    """Owens' CO2 refractivity (Bodhaine Eq. 27, 15 °C) scaled to 0 °C by density (273.15 -> 288.15 K) vs
    Bideau-Mehu et al. (1973) at 0 °C (refractiveindex.info formula 6)."""
    txt = src.BIDEAU_MEHU_CO2.fetch().read_text()
    c = [float(v) for v in re.search(r"coefficients:\s*([^\n]+)", txt).group(1).split()]
    lam = np.array([400.0, 550.0, 700.0, 830.0])
    s2 = (lam / 1e3) ** -2
    bm = c[0] + sum(c[i] / (c[i + 1] - s2) for i in range(1, len(c) - 1, 2))
    ow = (atmo.n_co2_owens(lam / 1e3) - 1.0) * 288.15 / 273.15
    return {"lambda_nm": lam, "owens_0C": ow, "bideau_mehu_0C": bm, "max_rel": float(np.max(np.abs(ow / bm - 1)))}


def us76_rows() -> list[dict]:
    out = []
    for r in US["checks"]["rows"]:
        z = r["Z_m"] / 1e3
        if "n_m3" in r:
            ours = float(ae.us76_tables_n(np.array([z]))[0])
            out.append({"Z_km": z, "table": r["n_m3"], "ours": ours, "rel": ours / r["n_m3"] - 1, "what": "n"})
        if "rho_kg_m3" in r:
            p = ae.us76(np.array([z]))
            rho = float(p["P"][0] * ae.M0 / (ae.R_STAR * p["T"][0]))
            out.append({"Z_km": z, "table": r["rho_kg_m3"], "ours": rho, "rel": rho / r["rho_kg_m3"] - 1,
                        "what": "rho"})
    return out


def earth_rayleigh_tau(diag: dict) -> dict:
    """Our column Rayleigh τ vs Bodhaine Table 3 (sea level, 1013.25 mb, 45°)."""
    t = BOD["table3"]
    alt = diag["prof"]
    n_col = float(np.trapezoid(ae.us76(np.arange(0.0, 86.0 + 1e-9, 0.25))["N"], np.arange(0.0, 86.0 + 1e-9, 0.25) * 1e3))
    lam = np.array(t["lambda_um"]) * 1e3
    ours = atmo.sigma_air(lam) * n_col
    return {"lambda_nm": lam, "ours": ours, "table": np.array(t["tau_sea_level_45N"]), "n_col": n_col,
            "ratio550": float(ours[4] / t["tau_sea_level_45N"][4]), "alt": alt}


def ozone_column_du(diag: dict) -> float:
    return diag["o3_col_m2"] / 2.6868e20


def zenith_sky(earth_diag: dict, elevations_deg=(60.0, 30.0, 10.0)) -> list[dict]:
    """Single-scattering zenith sky radiance spectrum for the Sun at the given elevations: L ∝ E_sun Σ_i ∫ ω_i β_i
    P_i(Θ) e^{-τ_above/μ0} e^{-τ_below} dz with Θ = the solar zenith angle (plane-parallel; multiple scattering
    and ground reflection omitted). Returns chromaticity and CCT (Hernández-Andrés 1999, colour-science)."""
    import colour
    alt = np.arange(0.0, 86.0 + 1e-9, 1.0)
    d = earth_diag
    br, bo, ba = d["ray"]["beta"], d["oz"]["beta"], d["aer"]["beta"]
    aer = ae.aerosol_spectral()
    rho = atmo.depolarization(atmo.king_air_bodhaine(atmo.FINE_VAC / 1e3))
    beta = br + bo + ba
    dz = np.diff(alt)
    cum_above = np.concatenate([np.cumsum(((beta[1:] + beta[:-1]) / 2 * dz[:, None])[::-1], axis=0)[::-1],
                                np.zeros((1, beta.shape[1]))])
    cum_below = np.concatenate([np.zeros((1, beta.shape[1])), np.cumsum((beta[1:] + beta[:-1]) / 2 * dz[:, None],
                                                                        axis=0)])
    e = solar.spectrum().grid
    out = []
    for el in elevations_deg:
        th = math.radians(90.0 - el)
        mu0 = math.cos(th)
        p_r = atmo.rayleigh_phase(np.full_like(rho, math.cos(th)), rho)
        p_a = atmo.hg(math.cos(th), aer["g"])
        src_ = br * p_r + ba * aer["ssa"] * p_a
        integrand = src_ * np.exp(-cum_above / mu0 - cum_below)
        L = e * np.trapezoid(integrand, alt, axis=0)
        X, Y, Z, _ = cie.xyzs(L)
        x, y = X / (X + Y + Z), Y / (X + Y + Z)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            cct = float(colour.temperature.xy_to_CCT_Hernandez1999(np.array([x, y])))
            yd = float(colour.temperature.CCT_to_xy_CIE_D(np.clip(cct, 4000, 25000))[1])
        out.append({"elevation": el, "x": x, "y": y, "cct": cct, "y_daylight_locus": yd})
    return out


def direct_sun(earth_diag: dict, zenith_deg=(0.0, 60.0, 80.0)) -> list[dict]:
    d = earth_diag
    tau = d["ray"]["col_fine"] + d["oz"]["col_fine"] + d["aer"]["col_fine"]
    e = solar.spectrum().grid
    out = []
    for z in zenith_deg:
        m = 1.0 / math.cos(math.radians(z))
        s = e * np.exp(-m * tau)
        X, Y, Z, _ = cie.xyzs(s)
        X0, Y0, Z0, _ = cie.xyzs(e)
        out.append({"zenith": z, "airmass": m, "T_Y": Y / Y0, "x": X / (X + Y + Z), "y": Y / (X + Y + Z)})
    return out


def mars_checks(diag: dict) -> dict:
    o = am.dust_optics()
    g650 = float(np.interp(650.0, o["wl_nm"], o["g"]))
    w650 = float(np.interp(650.0, o["wl_nm"], o["ssa"]))
    cc = am.DUST["chen_chen_2019_phase_function"]
    dhg_g = cc["alpha"] * cc["g1"] + (1 - cc["alpha"]) * cc["g2"]
    s = diag["seasonal"]
    i_max, i_min = int(np.nanargmax(s["global"])), int(np.nanargmin(s["global"]))
    return {"g650_table": g650, "g_dhg": dhg_g, "g_text": cc["asymmetry_text"], "ssa650_table": w650,
            "ssa_assumed_cc": cc["ssa_assumed"], "annual": s["annual_global"],
            "max": float(s["global"][i_max]), "ls_max": float(s["ls_centers"][i_max]),
            "min": float(s["global"][i_min]), "ls_min": float(s["ls_centers"][i_min]),
            "ls0_et": diag["ls0"], "rayleigh550": float(np.interp(550, atmo.FINE, diag["ray"]["col_fine"])),
            "dust550": float(np.interp(550, atmo.FINE, diag["dust"]["col_fine"]))}


def titan_checks(diag: dict) -> dict:
    t = ab.TITAN
    tau = ab.titan_haze_tau(np.array([0.0]), np.array([531.0, 550.0, 650.0, 940.0, 1080.0]))[0]
    hp = ab.hasi_profile()
    return {"tau_1080": float(tau[4]), "tau_1080_tomasko": t["vincendon_langevin_2010"]["tau_total_1080nm_tomasko"],
            "tau_531": float(tau[0]), "tau_550": float(tau[1]), "tau_650": float(tau[2]), "tau_940": float(tau[3]),
            "rayleigh550": float(np.interp(550, atmo.FINE, diag["ray"]["col_fine"])),
            "surface_n": float(hp["n"][0]), "surface_P": float(hp["P"][0]), "surface_T": float(hp["T"][0])}


def giants() -> list[dict]:
    out = []
    for n, body in (599, "jupiter"), (699, "saturn"), (799, "uranus"), (899, "neptune"):
        t = src.first_number(src.nssdc_atmo(body, "Temperature at 1 bar"))
        mus = [float(v) for v in re.findall(r"\d+(?:\.\d+)?", src.nssdc_atmo(body, "Mean molecular weight"))]
        hs = [float(v) for v in re.findall(r"\d+(?:\.\d+)?", src.nssdc_atmo(body, "Scale height"))]
        g = src.nssdc_table_value(body, "Gravity (mean, 1 bar)")
        h = K_B * t / (np.mean(mus) * M_U * g) / 1e3
        out.append({"naif": n, "name": body.capitalize(), "T": t, "mu": float(np.mean(mus)), "g": g, "H_calc": h,
                    "H_nssdc": float(np.mean(hs))})
    return out


def pluto_checks(diag: dict) -> dict:
    pm = diag["mie"]
    t4 = ab.PLUTO["cheng_2017"]["table4"]
    ratio_meas = t4["IF_at_45km"][3] / t4["IF_at_45km"][0]
    mu = np.cos(np.radians([180.0 - 167.0, 180.0 - 20.0]))
    g = ab.PLUTO["gladstone_2016"]
    e = atmo.mie_ensemble(np.array([g["min_radius_um"]]), np.array([1.0]), complex(g["tholin_n"], g["tholin_k"]),
                          g["lorri_pivot_nm"] / 1e3, mu)
    return {"P165": pm["P165"], "Qsca": pm["Qsca"], "ssa": pm["ssa"], "g": pm["g"], "a": diag["a"],
            "ratio_meas_45km": ratio_meas, "ratio_mie": float(e["phase"][0] / e["phase"][1])}
