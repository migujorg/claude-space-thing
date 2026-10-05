"""atmospheres.json (light stage): per body, the optical properties a renderer needs for multiple-scattering sky and
limb rendering (AtmosphereFile in app/src/data/schema.ts; docs/architecture.md §6; docs/reports/atmospheres.md).

Each body lists components (molecules, ozone, aerosol, dust, haze, cloud) on an altitude grid:
  extinctionPerKm[i][k]    β_ext (km^-1) at altitudesKm[i] and wavelengthsNm[k]
  singleScatteringAlbedo   ω per wavelength
  phaseFunction            rayleigh (depolarization ρ) | henyey-greenstein (g) | double-henyey-greenstein
                           (g1, g2, alpha) | tabulated (anglesDeg, values[wavelength][angle]) | none (pure absorber);
                           all normalized to a mean of 1 over the sphere (∫P dΩ = 4π)
  channelEquivalents       the same per CIE channel X, Y, Z, S (atmo.py)
  columnOpticalDepth       τ from altitude 0 to the top per wavelength (trapezoid over the grid; a convenience)
Optical depth along a path is ∫β ds with β interpolated linearly in altitude; the scattering coefficient is ω β.
"""

from __future__ import annotations

import math
import re

import numpy as np

from .. import cie
from ..schema import BuildContext, sourced, unknown, worst
from . import albedo, atmo, atmo_bodies as ab, atmo_earth as ae, atmo_mars as am, atmo_sources as src, moons, solar

EARTH_ALT = np.arange(0.0, 86.0 + 1e-9, 1.0)
MARS_ALT = np.arange(0.0, 80.0 + 1e-9, 1.0)
TITAN_ALT = np.concatenate([np.arange(0.0, 150.0, 2.0), np.arange(150.0, 500.0 + 1e-9, 5.0)])
VENUS_ALT = np.arange(60.0, 110.0 + 1e-9, 0.5)
PLUTO_ALT = np.arange(0.0, 300.0 + 1e-9, 5.0)
TITAN_DISR_TOP_KM = 150.0          # DISR measured from ~150 km down (Tomasko et al. 2008 via Bazzon et al. 2014)
LOSCHMIDT_M3 = 2.686780111e25      # m^-3 at 273.15 K, 101.325 kPa (one amagat): CODATA 2018 Loschmidt constant
LS_TABLE_STEP_DAYS = 2.0
DEFAULT_WINDOW = (796688664.0, 891383064.0)      # the build window (TDB s) when run without a BuildContext


def _sig(x, n: int = 4):
    """Round to n significant digits, recursively (keeps JSON small)."""
    if isinstance(x, (list, tuple, np.ndarray)):
        return [_sig(v, n) for v in x]
    if x is None:
        return None
    v = float(x)
    if v == 0.0 or not math.isfinite(v):
        return 0.0 if v == 0.0 else None
    return float(f"{v:.{n}g}")


def _col(beta_fine: np.ndarray, alt: np.ndarray) -> np.ndarray:
    return np.trapezoid(beta_fine, alt, axis=0)


class Build:
    """Collects source ids per ctx; each body function returns (entry, diagnostics)."""

    def __init__(self, ctx: BuildContext | None):
        self.ctx = ctx

    def s(self, d) -> str:
        return d.register(self.ctx) if self.ctx is not None else d.id

    def common(self) -> list[str]:
        ids = [self.s(solar.HSRS)]
        ids += cie.register_sources(self.ctx) if self.ctx is not None else [cie.SOURCE_CMF, cie.SOURCE_SCOTOPIC]
        if self.ctx is not None:
            ids.append(self.ctx.add_source(solar.edlen_source()))
        else:
            ids.append("edlen-1966")
        return ids


def component(cid: str, description: str, alt: np.ndarray, beta: np.ndarray, *, beta_label, beta_sources,
              beta_method, beta_uncertainty=None, ssa=None, ssa_label=None, ssa_sources=(), ssa_method=None,
              phase=None, phase_label=None, phase_sources=(), phase_method=None, g_fine=None,
              ch_sources=(), extra=None) -> tuple[dict, dict]:
    """beta: (n_alt, 471) km^-1 on the 1 nm grid; ssa: (471,) or None (unknown) or 0 (absorber); g_fine: (471,)
    asymmetry for the channel equivalents (None for unknown phase)."""
    beta_s = atmo.sample(beta)
    out = {"id": cid, "description": description,
           "extinctionPerKm": sourced(_sig(beta_s), beta_label, list(beta_sources), unit="km^-1", method=beta_method,
                                      uncertainty=beta_uncertainty)}
    ch_ext = atmo.ch_extinction(beta)
    ch_ssa = ch_g = None
    if ssa is None:
        out["singleScatteringAlbedo"] = unknown(ssa_method)
    else:
        ssa_f = np.broadcast_to(np.asarray(ssa, float), beta.shape[-1:] if np.ndim(ssa) <= 1 else beta.shape)
        out["singleScatteringAlbedo"] = sourced(_sig(atmo.sample(ssa_f), 4), ssa_label, list(ssa_sources),
                                                method=ssa_method)
        col = beta.sum(axis=0)
        ch_ssa = atmo.ch_ssa(col, ssa_f if ssa_f.ndim == 1 else ssa_f.mean(axis=0))
        if g_fine is not None:
            ch_g = atmo.ch_asymmetry(col, ssa_f if ssa_f.ndim == 1 else ssa_f.mean(axis=0), g_fine)
    out["phaseFunction"] = (sourced(phase, phase_label, list(phase_sources), method=phase_method)
                            if phase is not None else unknown(phase_method))
    labels = [beta_label] + ([ssa_label] if ssa is not None else []) + ([phase_label] if phase is not None else [])
    out["channelEquivalents"] = sourced(
        {"extinctionPerKm": _sig(ch_ext), "singleScatteringAlbedo": _sig(ch_ssa) if ch_ssa is not None else None,
         "asymmetry": _sig(ch_g) if ch_g is not None else None},
        worst(*labels), sorted(set(beta_sources) | set(ssa_sources) | set(phase_sources) | set(ch_sources)),
        method="Channel equivalents X, Y, Z, S weighted by TSIS-1 sunlight × CIE observer (atmo.py): β_c = ∫β w_c/∫w_c "
               "per altitude; ω_c scattering-weighted, g_c scattered-light-weighted over the whole column. Optically "
               "thin equivalents: exact channel transmission of a thick path needs the spectral samples.")
    colt = _col(beta_s, alt)
    out["columnOpticalDepth"] = _sig(colt)
    if extra:
        out.update(extra)
    return out, {"beta": beta, "col_fine": _col(beta, alt), "ch_ext": ch_ext}


def separable(n_m3: np.ndarray, sigma_m2_fine: np.ndarray, label, sources, method) -> dict:
    """The molecular extinction as number density × cross-section (extinctionPerKm = 1e3 n σ)."""
    return {"separable": sourced({"numberDensityPerM3": _sig(n_m3), "crossSectionM2": _sig(atmo.sample(sigma_m2_fine))},
                                 label, list(sources), method=method)}


# ---------------------------------------------------------------------------------------------- Earth
def earth(b: Build) -> tuple[dict, dict]:
    common = b.common()
    s_us, s_bod, s_o3, s_mac = b.s(ae.US76), b.s(ae.BODHAINE), b.s(ae.SERDYUCHENKO), b.s(ae.MACV2)
    s_nss = b.s(src.nssdc("earth"))
    alt = EARTH_ALT
    prof = ae.us76(alt)
    lam_vac = atmo.FINE_VAC
    sig = atmo.sigma_air(lam_vac)                                   # m^2
    beta_r = prof["N"][:, None] * sig[None, :] * 1e3                # km^-1
    king = atmo.king_air_bodhaine(lam_vac / 1e3)
    rho = atmo.depolarization(king)
    ray, d_ray = component(
        "rayleigh", "Molecular (Rayleigh) scattering by dry air", alt, beta_r,
        beta_label="estimated", beta_sources=[s_us, s_bod, *common],
        beta_method="β = N(z) σ(λ). N(z): U.S. Standard Atmosphere 1976, an idealized steady-state atmosphere for "
                    "moderate solar activity (defining eqs. 17-19, 23, 33a/b with Tables 2-4, T = T_M M/M0 (Table 8) "
                    "at 80-86 km, N = N_A P/(R* T)); per its introduction (p. 1) the profile below 51 km' keeps the "
                    "traditional (1962) definitions, which 'do not necessarily represent an average' of the "
                    "observations, and 51-86 km follows averages of the data. ESTIMATE: this standard stands in for "
                    "Earth's (variable) atmosphere. σ(λ): Bodhaine et al. (1999) Eq. 22 with the Peck & Reeder "
                    "refractive index of dry air with 360 ppm CO2 (Eq. 21) and the Bates King factor of air (Eqs. 5, "
                    "6, 23), evaluated at the vacuum wavelength of each standard-air sample (Edlén 1966) — derived.",
        beta_uncertainty="σ reproduces Bodhaine's Table 3 to < 0.01 %; the column is the US76 mean (real surface "
                         "pressure varies by a few percent with weather and elevation; scale extinction with local "
                         "surface pressure); water vapour and CO2 above 360 ppm change σ by < 0.1 %.",
        ssa=np.ones(atmo.FINE.size), ssa_label="derived", ssa_sources=[s_bod],
        ssa_method="Rayleigh scattering by air molecules is conservative (absorbing gases are separate components).",
        phase={"kind": "rayleigh", "depolarization": _sig(atmo.sample(rho), 5)}, phase_label="derived",
        phase_sources=[s_bod],
        phase_method="P(Θ) = 3[(1+ρ) + (1-ρ)cos²Θ]/(4+2ρ) with the depolarization ratio ρ = 6(F-1)/(3+7F) of "
                     "Bodhaine's King factor F(λ) (Eq. 22's (6+3ρ)/(6-7ρ)).",
        g_fine=np.zeros(atmo.FINE.size),
        extra=separable(prof["N"], sig, "estimated", [s_us, s_bod],
                        "US76 total number density N(z) and Bodhaine's cross-section per molecule σ(λ)."))

    n_o3 = ae.ozone_n(alt)
    s_o3x = ae.ozone_sigma_at(prof["T"])                               # (n_alt, 471)
    beta_o = n_o3[:, None] * s_o3x * 1e3
    o3_col = float(np.trapezoid(n_o3, alt * 1e3))
    beta_o_samples = atmo.sample_box(beta_o)
    oz, d_oz = component(
        "ozone", "Ozone absorption (Chappuis band); pure absorber", alt, beta_o,
        beta_label="estimated", beta_sources=[s_us, s_o3, *common],
        beta_method="β = n_O3(z) σ_O3(λ, T(z)). n_O3: the U.S. Standard Atmosphere 1976 mid-latitude ozone model "
                    "(Table 18: balloon and rocket soundings, 2-74 km; log-linear in z; held at the 2 km value below "
                    f"2 km, zero above 74 km); column {o3_col / 2.6868e20:.0f} DU. σ_O3: Serdyuchenko et al. (2014) "
                    "at the US76 temperature of each altitude (linear between their 10 K steps, clamped to 193-293 K), "
                    "averaged over 1 nm standard-air bins; the extinctionPerKm samples are 10 nm box averages. "
                    "ESTIMATE: one mid-latitude profile (US76: 'weighted towards the solar maximum conditions which "
                    "existed in the late 1960's') for the whole planet.",
        beta_uncertainty="The US76 table's own standard deviations are 11-109 % per level (its 'percent "
                         "variability' column); cross-sections < 1 % in the Chappuis band.",
        ssa=np.zeros(atmo.FINE.size), ssa_label="derived", ssa_sources=[s_o3],
        ssa_method="Absorption only.", phase={"kind": "none"}, phase_label="derived", phase_sources=[s_o3],
        phase_method="Pure absorber: no scattering.", g_fine=np.zeros(atmo.FINE.size))
    oz["extinctionPerKm"]["value"] = _sig(beta_o_samples)
    oz["columnOpticalDepth"] = _sig(_col(beta_o_samples, alt))

    aer = ae.aerosol_spectral()
    shape = ae.aerosol_profile(alt)
    beta_a = shape[:, None] * aer["aod"][None, :]
    mac = ae._MAC["table2"]
    ae_comp, d_ae = component(
        "aerosol", "Tropospheric aerosol, global annual mean", alt, beta_a,
        beta_label="estimated", beta_sources=[s_mac, *common],
        beta_method="MACv2 (Kinne 2019; AERONET/MAN sun-photometer statistics merged with global modelling) global "
                    f"annual mean total AOD {mac['AOD_total']} at {[int(x * 1e3) for x in mac['lambda_um']]} nm "
                    "(Table 2), log-log interpolated (the 450-550 nm Ångström exponent continued below 450 nm), "
                    "distributed vertically by the MACv2 layer AODs of Table 3 (0-1, 1-3, 3-6, 6-12 km a.s.l.; "
                    "piecewise constant, renormalized to the grid's trapezoid column). ESTIMATE: a global mean "
                    "stands in for local, highly variable aerosol.",
        beta_uncertainty="A global annual mean: local and seasonal values differ strongly (the MACv2 maps, Kinne 2019 "
                         "Fig. 8 and Appendix A; not reproduced here).",
        ssa=aer["ssa"], ssa_label="estimated", ssa_sources=[s_mac],
        ssa_method="MACv2 Table 2 total SSA (0.902, 0.941, 0.956 at 450, 550, 1000 nm), linear in ln λ, constant "
                   "below 450 nm.",
        phase={"kind": "henyey-greenstein", "g": _sig(atmo.sample(aer["g"]), 4)}, phase_label="estimated",
        phase_sources=[s_mac],
        phase_method="Henyey-Greenstein with the MACv2 Table 2 asymmetry factor (0.718, 0.702, 0.693 at 450, 550, "
                     "1000 nm; linear in ln λ). The HG form is an assumption (real aerosol phase functions have a "
                     "sharper forward peak and a weak backscatter rise).",
        g_fine=aer["g"])

    top = ae.us76(np.array([alt[-1]]))
    g_top = ae.G0 * (ae.R0 / (ae.R0 + alt[-1] * 1e3)) ** 2
    above86 = float(top["N"][0] * ae.R_STAR * top["T"][0] / (ae.M0 * g_top) / np.trapezoid(prof["N"], alt * 1e3))
    entry = {
        "name": "Earth", "naifId": 399, "referenceRadiusKm": _sig(albedo.mean_radius(399), 7),
        "altitudeReference": "altitude above mean sea level (US76 geometric altitude Z)",
        "altitudesKm": _sig(alt), "topAltitudeKm": float(alt[-1]), "topRadiusKm": None,
        "scaleHeightKm": sourced(first_nss("earth", "Scale height"), "derived", [s_nss],
                                 method="NSSDCA Earth fact sheet."),
        "surfacePressurePa": sourced(ae.P0, "derived", [s_us], method="US76 sea-level pressure P0 (Table 2)."),
        "meanMolecularWeight": sourced(ae.M0, "derived", [s_us], unit="kg/kmol",
                                       method="US76 M0 (Table 3 composition)."),
        "components": [ray, oz, ae_comp],
        "omitted": "Not included (unknown here): water-vapour and O2 line absorption (e.g. the O2 A band at 760 nm, "
                   "H2O bands at 720 and 820 nm), NO2, clouds, polar stratospheric and volcanic aerosol, airglow; "
                   f"the atmosphere above 86 km (about {above86:.1e} of the Rayleigh column: N(86 km) times its "
                   "scale height).",
    }
    diag = {"ray": d_ray, "oz": d_oz, "aer": d_ae, "prof": prof, "o3_col_m2": o3_col, "beta_o_samples": beta_o_samples}
    return entry, diag


def first_nss(body: str, key: str) -> float:
    return src.first_number(src.nssdc_atmo(body, key))


# ---------------------------------------------------------------------------------------------- Mars
def mars(b: Build) -> tuple[dict, dict]:
    common = b.common()
    s_clim, s_opt, s_man, s_page = b.s(src.MCD_DUST_CLIM), b.s(src.LMD_DUST_OPTPROP), b.s(src.MCD_MANUAL), \
        b.s(src.LMD_DUST_PAGE)
    s_m20, s_cc, s_vl, s_bod, s_nss = b.s(src.MONTABONE_2020), b.s(src.CHEN_CHEN_2019), b.s(src.VINCENDON_2010), \
        b.s(ae.BODHAINE), b.s(src.nssdc("mars"))
    am.build_ctx_sources(b.ctx)
    s_eph = ["naif-lsk-naif0012", "naif-de442s", "naif-pck00011"]
    alt = MARS_ALT
    bulk = am.bulk()
    H = bulk["H_km"]
    ncol = am.gas_column_m2(bulk)
    n_z = ncol / (H * 1e3) * np.exp(-alt / H)
    sig = bulk["co2_fraction"] * atmo.sigma_co2(atmo.FINE_VAC) + (1 - bulk["co2_fraction"]) * ab.sigma_n2(atmo.FINE_VAC)
    beta_r = n_z[:, None] * sig[None, :] * 1e3
    rho = atmo.depolarization(np.full(atmo.FINE.size, atmo.F_CO2))
    ray, d_ray = component(
        "rayleigh", "Molecular scattering by CO2 (95 %) and the rest (as N2)", alt, beta_r,
        beta_label="estimated", beta_sources=[s_bod, s_nss, b.s(src.PECK_KHANNA_N2), *common],
        beta_method=f"Column N = P/(m g) = {ncol:.3e} m^-2 from the NSSDCA surface pressure {bulk['p_pa']:.0f} Pa (at "
                    f"the mean radius), mean molecular weight {bulk['mu']} and gravity {bulk['g']} m/s²; distributed "
                    f"exponentially with the NSSDCA scale height {H} km (isothermal ESTIMATE). σ = "
                    f"{bulk['co2_fraction']:.3f} σ_CO2 + the rest as N2: σ_CO2 from Bodhaine et al. (1999) Eq. 22 "
                    "with Owens' CO2 refractive index (Eq. 27) and F(CO2) = 1.15; σ_N2 from Peck & Khanna (1966) and "
                    "Bodhaine's F(N2).",
        beta_uncertainty="Surface pressure varies 4.0-8.7 mb with season (NSSDCA) and strongly with elevation (the "
                         "exponential profile scales it). Small next to dust.",
        ssa=np.ones(atmo.FINE.size), ssa_label="derived", ssa_sources=[s_bod], ssa_method="Conservative.",
        phase={"kind": "rayleigh", "depolarization": _sig(atmo.sample(rho), 4)}, phase_label="derived",
        phase_sources=[s_bod], phase_method="CO2 King factor 1.15 (Bates 1984 via Bodhaine) -> ρ = 0.0784 (the N2 "
                                           "share neglected).", g_fine=np.zeros(atmo.FINE.size),
        extra=separable(n_z, sig, "estimated", [s_bod, s_nss],
                        "Isothermal exponential number density and the mixture cross-section."))

    # dust
    t_start = b.ctx.start_et if b.ctx is not None else DEFAULT_WINDOW[0]
    t_ls0_prev = am.ls_zero_crossing(t_start)
    seas = am.dust_seasonal(t_ls0_prev)
    dsp = am.dust_spectral()
    p_ratio = bulk["p_pa"] / am.DUST["lmd_climatology_page"]["reference_pressure_Pa"]
    tau_ref = seas["annual_global"] * p_ratio
    beta_d = (tau_ref * np.exp(-alt / H) / H)[:, None] * dsp["qrel"][None, :]
    dhg = am.chen_chen_dhg()
    cc = am.DUST["chen_chen_2019_phase_function"]
    dust, d_dust = component(
        "dust", "Airborne mineral dust, annual global mean (scale with dustColumn)", alt, beta_d,
        beta_label="estimated", beta_sources=[s_clim, s_page, s_m20, s_man, s_opt, s_vl, s_nss, *common],
        beta_method=f"Column: the annual, area-weighted global mean ({seas['annual_global']:.3f}) of the visible "
                    "column dust optical depth at 610 Pa of the Mars Climate Database climatology scenario (daily "
                    "kriged 9.3 µm absorption CDOD maps reconstructed from TES, THEMIS and MCS observations of "
                    "MY 24-35 without a global dust storm; Montabone et al. 2015, 2020) × 2.6 (the LMD/Montabone "
                    f"conversion to 'equivalent visible' optical depth), × {p_ratio:.4f} to the NSSDCA mean-radius "
                    f"surface pressure. Assigned to 700 nm; spectral shape Q_ext(λ)/Q_ext(700 nm) of the MCD's "
                    f"Wolff et al. (2009) dust (r_eff 1.5 µm). Vertical: dust mixed with the gas, e^(-z/{H} km) "
                    "(ESTIMATE; OMEGA-derived dust scale heights are 6-12 km depending on season, Vincendon & "
                    "Langevin 2010).",
        beta_uncertainty="Seasonal and regional variation is large (dustColumn); interannual variation and dust "
                         "storms are not predictable for the build window; the 2.6 factor and its reference "
                         "wavelength (not stated in the accessible sources) add an unquantified uncertainty.",
        ssa=dsp["ssa"], ssa_label="derived", ssa_sources=[s_opt, s_man],
        ssa_method="Wolff et al. (2009) dust single-scattering albedo for r_eff = 1.5 µm as used by the Mars Climate "
                   "Database (LMD file optprop_dustvis_TM.dat), linear between its nodes 263, 325, 388, 450, 513, "
                   "575, 638, 700, 800, 1173 nm: 0.73 at 388 nm rising to 0.975 at 700 nm (the reddish sky).",
        phase={"kind": "double-henyey-greenstein", "g1": [dhg["g1"]] * atmo.GRID_NM.size,
               "g2": [dhg["g2"]] * atmo.GRID_NM.size, "alpha": [dhg["alpha"]] * atmo.GRID_NM.size},
        phase_label="estimated", phase_sources=[s_cc],
        phase_method=f"Measured at 650 nm: double Henyey-Greenstein fitted to MSL Navcam/Hazcam sky radiance "
                     f"(Chen-Chen et al. 2019: g1 = {cc['g1']} ± {cc['g1_sigma']}, g2 = {cc['g2']} ± {cc['g2_sigma']}, "
                     f"α = {cc['alpha']} ± {cc['alpha_sigma']}; asymmetry 0.687 ± 0.081). ESTIMATE at other "
                     "wavelengths (same shape); the MCD dust's asymmetry is 0.77 at 450 nm and 0.68 at 700-800 nm "
                     "('asymmetry' field).",
        g_fine=np.full(atmo.FINE.size, dhg["alpha"] * dhg["g1"] + (1 - dhg["alpha"]) * dhg["g2"]),
        extra={"asymmetry": sourced(_sig(atmo.sample(dsp["g"]), 4), "derived", [s_opt, s_man],
                                    method="Asymmetry factor of the MCD's Wolff et al. (2009) dust (r_eff 1.5 µm), "
                                           "for reference.")})

    # L_s over the build window and the seasonal dust table
    ctx = b.ctx
    t0, t1 = (ctx.start_et, ctx.end_et) if ctx is not None else DEFAULT_WINDOW
    et = np.arange(t0, t1 + 1.0, LS_TABLE_STEP_DAYS * 86400.0)
    ls = am.solar_longitude(et)
    seasonal = {
        "dustColumn": sourced(
            {"lsDeg": _sig(seas["ls_centers"]), "latitudeDeg": _sig(seas["lat_centers"]),
             "opticalDepth610Pa": _sig(seas["zonal"], 3), "globalMean610Pa": _sig(seas["global"], 3),
             "annualGlobalMean610Pa": _sig(seas["annual_global"], 4), "referencePressurePa": 610.0,
             "wavelengthNm": 700.0},
            "estimated", [s_clim, s_page, s_m20, s_man, *s_eph, s_nss],
            method=f"Mars Climate Database climatology scenario (dust_clim.nc: {seas['sol_count']} daily 3°×3° maps "
                   "of 9.3 µm absorption column dust optical depth at 610 Pa) × 2.6 (visible), zonally averaged in "
                   f"{am.LAT_BAND_DEG:.0f}° latitude bands and in {am.LS_BIN_DEG:.0f}° bins of L_s (sol of year "
                   "counted from L_s = 0 with the NSSDCA solar day; L_s from DE442 + IAU pole). To use: dust "
                   "extinction(z, λ, lat, t) = component 'dust' extinctionPerKm × opticalDepth610Pa(L_s(t), lat) / "
                   "annualGlobalMean610Pa; local terrain is handled by the exponential profile (the column above an "
                   "elevation h scales as e^(-h/H) like pressure). ESTIMATE for the build window: a typical year "
                   "without a global dust storm; real years differ, and regional storms are not in a zonal mean.",
            uncertainty="Real years differ from this typical one (compare the per-year MCD scenario files, not used "
                        "here). Global dust storms: the MCD's storm scenario uses τ = 5 during northern fall and "
                        "winter (L_s 180-360; MCD manual §1.2); in MY 34 Opportunity saw visible opacity 10.8 "
                        "(Montabone et al. 2020)."),
        "solarLongitude": sourced({"et": _sig(et, 10), "lsDeg": _sig(ls, 5)}, "derived", s_eph,
                                  method=f"L_s every {LS_TABLE_STEP_DAYS:.0f} days over the build window: the Sun's "
                                         "longitude seen from Mars in Mars's orbital plane from the vernal equinox "
                                         "(pole × orbital angular momentum), DE442 + pck00011 (as SPICE lspcn)."),
    }
    entry = {
        "name": "Mars", "naifId": 499, "referenceRadiusKm": _sig(albedo.mean_radius(499), 7),
        "altitudeReference": "altitude above the mean radius (NSSDCA surface pressure is quoted there)",
        "altitudesKm": _sig(alt), "topAltitudeKm": float(alt[-1]), "topRadiusKm": None,
        "scaleHeightKm": sourced(H, "derived", [s_nss], method="NSSDCA Mars fact sheet."),
        "surfacePressurePa": sourced(bulk["p_pa"], "derived", [s_nss],
                                     method="NSSDCA: 6.36 mb at mean radius (variable 4.0-8.7 mb with season)."),
        "meanMolecularWeight": sourced(bulk["mu"], "derived", [s_nss], unit="kg/kmol", method="NSSDCA."),
        "components": [ray, dust],
        **seasonal,
        "omitted": "Not included (unknown here): water-ice clouds (aphelion cloud belt, polar hoods), dust storms "
                   "beyond the climatology, detached dust layers, the wavelength dependence of the dust phase "
                   "function, CO2 ice clouds.",
    }
    return entry, {"ray": d_ray, "dust": d_dust, "seasonal": seas, "ls": ls, "et": et, "ls0": t_ls0_prev,
                   "ncol": ncol, "dsp": dsp, "tau_ref": tau_ref}


# ---------------------------------------------------------------------------------------------- Titan
def titan(b: Build) -> tuple[dict, dict]:
    common = b.common()
    s_hd, s_he, s_pk, s_bz, s_vl, s_bod = b.s(src.HASI_DESCENT), b.s(src.HASI_ENTRY), b.s(src.PECK_KHANNA_N2), \
        b.s(src.BAZZON_2014), b.s(src.VINCENDON_2010), b.s(ae.BODHAINE)
    alt = TITAN_ALT
    n = ab.titan_n(alt)
    sig = ab.sigma_n2(atmo.FINE_VAC)
    beta_r = n[:, None] * sig[None, :] * 1e3
    rho = atmo.depolarization(atmo.king_n2_bodhaine(atmo.FINE_VAC / 1e3))
    hp = ab.hasi_profile()
    ray, d_ray = component(
        "rayleigh", "Molecular scattering by N2 (methane, 1.5-5 %, counted as N2)", alt, beta_r,
        beta_label="estimated", beta_sources=[s_hd, s_he, s_pk, s_bod, *common],
        beta_method="β = n(z) σ_N2(λ). n = P/(kT) from the Huygens HASI measured profiles (descent 0-"
                    f"{hp['descent_top_km']:.0f} km, entry {hp['entry_bottom_km']:.0f}-1380 km; log-linear, bridging "
                    "the gap); σ_N2 from Bodhaine Eq. 22 with Peck & Khanna's (1966) N2 refractive index "
                    "(0 °C, 101.325 kPa; fitted 468-2059 nm, extrapolated below 468 nm) and F(N2) (Bodhaine Eq. 5). "
                    "ESTIMATE: methane treated as N2 and the landing-site profile used globally.",
        ssa=np.ones(atmo.FINE.size), ssa_label="derived", ssa_sources=[s_bod], ssa_method="Conservative.",
        phase={"kind": "rayleigh", "depolarization": _sig(atmo.sample(rho), 4)}, phase_label="derived",
        phase_sources=[s_bod], phase_method="ρ from Bodhaine's F(N2).", g_fine=np.zeros(atmo.FINE.size),
        extra=separable(n, sig, "estimated", [s_hd, s_he, s_pk, s_bod],
                        "HASI number density and the N2 cross-section."))
    beta_h = ab.titan_haze_beta(alt, atmo.FINE_VAC)
    s_ph_lo, s_ph_hi, s_barnes, s_es, s_gm = b.s(src.TOMASKO_PHASE_LOW), b.s(src.TOMASKO_PHASE_HIGH), \
        b.s(src.BARNES_2018), b.s(src.ES_SAYEH_2023), b.s(moons.GARCIA_MUNOZ)
    s_gcms, s_dtwg, s_kark, s_k94 = b.s(src.HUYGENS_GCMS_CH4), b.s(src.HUYGENS_DTWG_DESCENT), \
        b.s(albedo.KARKOSCHKA), b.s(moons.KARKOSCHKA_1994_TEXT)
    beta_method = ("The Huygens DISR haze model of Tomasko et al. (2008) as transcribed by Bazzon et al. (2014, "
                   "eqs. A.8-A.13): cumulative optical depth τ80 = 1.012e7 λ^-2.339 above 80 km (scale height "
                   "65 km), + τ30 = 2.029e4 λ^-1.409 linear over 30-80 km, + τ0 = 6.270e2 λ^-0.9706 linear below "
                   "30 km (λ in nm); β = -dτ/dz. Measured by DISR from ~150 km to the surface at 350-1600 nm "
                   f"(Bazzon: 400-1600 nm); ABOVE {TITAN_DISR_TOP_KM:.0f} km the 65 km exponential is extrapolated "
                   "(Cassini VIMS limb data give 80 ± 10 km, Vincendon & Langevin 2010), and 360-400 nm is a power-"
                   "law extrapolation. Landing-site (10° S, 2005) model used globally. The haze is split into "
                   "three components that share this extinction, so that the single-scattering albedo can follow "
                   "Doose et al. (2016) in altitude (below 80 km; above 80 km with weights 1 − w and w, w = (z − 80 "
                   "km)/120 km clipped to 0-1): their sum is the whole haze.")
    beta_unc = ("The haze varies with latitude and season (north-south asymmetry, detached layer near 500 km, polar "
                "hoods) — not represented. Doose et al. (2016) revised the DISR extinction profile (not accessible); "
                "the albedos below are theirs, the extinction Tomasko et al.'s (2008).")
    ss = ab.titan_ssa(atmo.FINE)
    k_ext, c_ext = ab.titan_ssa_extrapolation()
    first = ss["first_nm"]
    rule = ab.TITAN["doose_2016_ssa_rule"]
    ssa_method = (f"Huygens DISR haze single-scattering albedo of Doose et al. (2016): {{which}}. Digitized from the "
                  f"vector drawing of Barnes et al. (2018, Fig. 4; tables/titan_doose_2016_ssa.csv), which plots "
                  f"Doose et al.'s values for below 80 km and above 200 km from {first:.1f} nm; between 80 and 200 km "
                  f"Doose et al. interpolate linearly (here: two components weighted 1 − w and w). The curves obey "
                  f"Doose et al.'s rule ω(< 80 km) = ({rule['offset']} + ω(> 200 km))/{rule['divisor']} (as stated by "
                  f"Es-sayeh et al. 2023 and Rannou et al. 2026) to 0.0006. ESTIMATE below {first:.0f} nm: the DISR "
                  f"albedo is 'poorly constrained shortwards of 490 nm' (García Muñoz et al. 2017) and not plotted "
                  f"there; the above-200-km curve is continued linearly ({k_ext * 100:.4f} per 100 nm, the line "
                  f"through its 500-600 nm vertices), the below-80-km one by the rule; capped at 1. Landing-site "
                  f"profile used globally.")
    ph_lo = ab.titan_phase_on_grid(src.TOMASKO_PHASE_LOW.fetch(), atmo.GRID_NM)
    ph_hi = ab.titan_phase_on_grid(src.TOMASKO_PHASE_HIGH.fetch(), atmo.GRID_NM)
    phase_method = ("Huygens DISR aerosol phase function of Tomasko et al. (2008, Table 1: the fractal-aggregate "
                    "phase functions fitted to the DISR measurements, {which}), from the machine-readable copy in the "
                    "reference data of Adamkovics et al. (2016); linear in wavelength between the tabulated 355, 430, "
                    "491, 600, 713, 822 and 935 nm, log-linear in angle onto 0.25° steps through the forward peak "
                    "(0-10°), 1° to 30° and 2° beyond (the table's 1° steps under-resolve the peak), each row "
                    "renormalized to a mean of 1 over the sphere (the tabulated rows integrate to "
                    "{norm_lo:.4f}-{norm_hi:.4f}). Asymmetry 0.73-0.80. ESTIMATE: a secondary transcription, "
                    "interpolated in wavelength, the landing-site fit used globally.")
    w = ab.titan_upper_weight(alt)[:, None]
    low_mask = (alt <= 80.0)[:, None].astype(float)
    common_h = dict(beta_label="estimated", beta_sources=[s_bz, s_vl, *common], beta_method=beta_method,
                    beta_uncertainty=beta_unc, ssa_label="estimated", ssa_sources=[s_barnes, s_es, s_gm])
    which_low = "the 'below 80 km' curve"
    which_top = "the 'above 200 km' curve"
    tab = lambda p: {"kind": "tabulated", "anglesDeg": _sig(p["anglesDeg"]), "values": _sig(p["values"], 4)}  # noqa: E731
    g_lo = np.interp(atmo.FINE, atmo.GRID_NM, ab.tab_asymmetry(ph_lo["anglesDeg"], ph_lo["values"]))
    g_hi = np.interp(atmo.FINE, atmo.GRID_NM, ab.tab_asymmetry(ph_hi["anglesDeg"], ph_hi["values"]))
    pm_lo = phase_method.format(which="below 80 km", norm_lo=ph_lo["raw_norm"].min(), norm_hi=ph_lo["raw_norm"].max())
    pm_hi = phase_method.format(which="above 80 km", norm_lo=ph_hi["raw_norm"].min(), norm_hi=ph_hi["raw_norm"].max())
    haze_low, d_haze_low = component(
        "haze-below-80km", "Photochemical haze and mist below 80 km (Huygens DISR)", alt, beta_h * low_mask,
        ssa=ss["low"], ssa_method=ssa_method.format(which=which_low),
        phase=tab(ph_lo), phase_label="estimated", phase_sources=[s_ph_lo], phase_method=pm_lo, g_fine=g_lo,
        ch_sources=[*common], **common_h)
    haze_mid, d_haze_mid = component(
        "haze-above-80km-a", "Photochemical haze above 80 km: the share (1 − w) with the below-80-km albedo",
        alt, beta_h * (1.0 - low_mask) * (1.0 - w),
        ssa=ss["low"], ssa_method=ssa_method.format(which=which_low + ", weighted 1 − w above 80 km"),
        phase=tab(ph_hi), phase_label="estimated", phase_sources=[s_ph_hi], phase_method=pm_hi, g_fine=g_hi,
        ch_sources=[*common], **common_h)
    haze_top, d_haze_top = component(
        "haze-above-80km-b", "Photochemical haze above 80 km: the share w with the above-200-km albedo",
        alt, beta_h * (1.0 - low_mask) * w,
        ssa=ss["top"], ssa_method=ssa_method.format(which=which_top + ", weighted w above 80 km"),
        phase=tab(ph_hi), phase_label="estimated", phase_sources=[s_ph_hi], phase_method=pm_hi, g_fine=g_hi,
        ch_sources=[*common], **common_h)

    # methane absorption: n_CH4(z) k(λ)
    x_ch4 = ab.titan_methane_fraction(alt)
    k_fine = ab.methane_k_fine(atmo.FINE)
    n_ch4 = n * x_ch4
    beta_m = (n_ch4 / LOSCHMIDT_M3)[:, None] * k_fine[None, :]          # km^-1 (k per km-amagat)
    mp = ab.titan_methane_profile()
    col_ch4 = float(np.trapezoid(n_ch4 / LOSCHMIDT_M3, alt))              # km-amagat
    km = ab.TITAN["karkoschka_1994_methane"]
    meth, d_meth = component(
        "methane", "Methane absorption bands (pure absorber; its Rayleigh scattering is in 'rayleigh')", alt, beta_m,
        beta_label="estimated", beta_sources=[s_gcms, s_dtwg, s_hd, s_he, s_kark, s_k94, *common],
        beta_method=f"β = k(λ) n_CH4(z)/n_L (n_L = {LOSCHMIDT_M3:.5e} m^-3, one amagat). n_CH4 = x(z) n(z): the "
                    f"Huygens GCMS methane mole fraction (PDS, {mp['n']} samples by UTC) placed at the DTWG "
                    f"reconstructed altitude of each sample, averaged in 1 km bins ({mp['z_range'][0]:.1f}-"
                    f"{mp['z_range'][1]:.1f} km; x = {mp['x'][-1]:.4f} at the top, held above, {mp['x'][0]:.4f} at "
                    f"the surface), times the HASI number density. Column {col_ch4:.2f} km-amagat. k(λ): "
                    "Karkoschka's (1998) cold-temperature methane absorption coefficients (PDS GBAT_0001 1995LOW.TAB, "
                    "1 nm resolution; 'one cold-temperature methane spectrum is sufficient to model methane "
                    "absorptions for all jovian planets and Titan', Karkoschka 1994), averaged over 1 nm air bins; the "
                    "extinctionPerKm samples are 10 nm box averages of β. ESTIMATE: the PDS calls k 'estimated' "
                    f"(±{km['accuracy'] * 100:.0f} %, inferred from planetary spectra including Titan's); a band "
                    "average of k is not the band average of e^(−k u) (exact only for weak absorption: a renderer "
                    "that needs band transmissions should work at the 1 nm resolution of k).",
        beta_uncertainty=f"k ±{km['accuracy'] * 100:.0f} %, continuum ±{km['continuum_uncertainty_km_am']['400']} "
                         f"(400 nm) to ±{km['continuum_uncertainty_km_am']['1000']} km-am^-1 (1000 nm); Niemann et "
                         "al. (2010) later revised the GCMS mole fractions to 1.48 % (stratosphere) and 5.65 % "
                         "(surface), 5 and 15 % above this PDS stage-2 product.",
        ssa=np.zeros(atmo.FINE.size), ssa_label="derived", ssa_sources=[s_kark],
        ssa_method="Absorption only.", phase={"kind": "none"}, phase_label="derived", phase_sources=[s_kark],
        phase_method="Pure absorber: no scattering.", g_fine=np.zeros(atmo.FINE.size),
        extra={"methaneMoleFraction": sourced({"altitudeKm": _sig(mp["z_km"]), "moleFraction": _sig(mp["x"], 4)},
                                              "derived", [s_gcms, s_dtwg],
                                              method="Huygens GCMS mole fraction by UTC (PDS hpgcms_0001 "
                                                     "DTWG_MOLE_FRACTION, stage 2) at the DTWG altitude of each UTC "
                                                     "(PDS hpdtwg_0001, linear in time between its records), means "
                                                     "over 1 km bins: computed from two measured products."),
               "absorptionCoefficient": sourced({"wavelengthNm": [float(x) for x in atmo.FINE],
                                                 "perKmAmagat": _sig(k_fine, 4)}, "estimated", [s_kark, s_k94],
                                                method="Karkoschka (1998) k on the 1 nm air grid (mean of the 0.4 nm "
                                                       "samples within ±0.5 nm), for renderers that resolve the "
                                                       "bands.")})
    beta_m_s = atmo.sample_box(beta_m)
    meth["extinctionPerKm"]["value"] = _sig(beta_m_s)
    meth["columnOpticalDepth"] = _sig(_col(beta_m_s, alt))

    sfc = ab.TITAN["garcia_munoz_2017_surface"]
    lam_s, r_s = np.array(sfc["lambda_eff_nm"], float), np.array(sfc["reflectance"], float)
    o = np.argsort(lam_s, kind="stable")
    r_fine = np.interp(atmo.FINE, lam_s[o], r_s[o])
    surface = sourced(
        {"wavelengthsNm": [float(x) for x in atmo.GRID_NM], "reflectance": _sig(atmo.sample(r_fine), 4),
         "channelEquivalents": _sig(atmo.channel_weights() @ r_fine, 4)},
        "estimated", [s_gm],
        method="Lambert reflectance of the surface below the haze: the values García Muñoz et al. (2017, Methods) "
               "adopted at their filters' effective wavelengths (306-938 nm, 0.023-0.151), interpolated from "
               "Karkoschka & Schröder's (2016) DISR eight-colour surface maps around the Huygens landing site (Table "
               "1, not accessible); linear in wavelength between them. ESTIMATE: one landing-site spectrum used "
               "for the whole globe, Lambertian. channelEquivalents: sunlight × observer weighted means (X, Y, Z, S).",
        uncertainty="Titan's surface albedo varies by a factor of a few across the globe (dark dune fields to bright "
                    "Xanadu) — visible only faintly through the haze.")
    entry = {
        "name": "Titan", "naifId": 606, "referenceRadiusKm": _sig(albedo.mean_radius(606), 7),
        "altitudeReference": "altitude above the surface at the Huygens landing site (HASI)",
        "altitudesKm": _sig(alt), "topAltitudeKm": float(alt[-1]), "topRadiusKm": None,
        "scaleHeightKm": unknown("Not a single number on Titan (it changes with temperature through the "
                                 "troposphere and stratosphere): use the tabulated HASI-based profiles."),
        "surfacePressurePa": sourced(_sig(float(np.interp(0.0, hp["z_km"], hp["P"])), 6), "measured", [s_hd],
                                     method="HASI descent profile, lowest sample (at the surface, 2005-01-14)."),
        "components": [ray, haze_low, haze_mid, haze_top, meth],
        "surfaceReflectance": surface,
        "omitted": "Not included: the detached haze layer near 500 km (seasonal; it vanished in 2012-2016), "
                   "latitude/season variation of the haze (north-south asymmetry, polar hoods), clouds, methane "
                   "Rayleigh scattering as its own species (counted as N2), the temperature dependence of methane "
                   "absorption, gases other than N2 and CH4.",
    }
    diag = {"ray": d_ray, "haze_low": d_haze_low, "haze_mid": d_haze_mid, "haze_top": d_haze_top, "methane": d_meth,
            "ssa": ss, "phase_lo": ph_lo, "phase_hi": ph_hi, "ch4_column_km_am": col_ch4, "surface_fine": r_fine,
            "ssa_extrapolation": (k_ext, c_ext)}
    return entry, diag


# ---------------------------------------------------------------------------------------------- Venus
def venus(b: Build) -> tuple[dict, dict]:
    common = b.common()
    s_hh, s_lee, s_pere, s_nss = b.s(src.HANSEN_HOVENIER), b.s(src.LEE_2021), b.s(src.PERE_2016), \
        b.s(src.nssdc("venus"))
    alt = VENUS_ALT
    vm = ab.venus_mie()
    rel = np.interp(atmo.FINE, atmo.GRID_NM, vm["rel_ext"])
    beta = ab.venus_beta365(alt)[:, None] * rel[None, :]
    g_f = np.interp(atmo.FINE, atmo.GRID_NM, vm["g"])
    hh = ab.VENUS["hansen_hovenier_1974"]
    n_above = hh["tau1_pressure_mb"] * 100.0 / (first_nss("venus", "Mean molecular weight") * 1.66053906660e-27
                                               * src.nssdc_table_value("venus", "Surface gravity"))
    tau_r550 = float(n_above * np.interp(550.0, atmo.FINE, atmo.sigma_co2(atmo.FINE_VAC)))
    cloud, d_cloud = component(
        "cloud", "Upper cloud and upper haze of sulfuric-acid droplets above 60 km", alt, beta,
        beta_label="estimated", beta_sources=[s_lee, s_pere, s_hh, *common],
        beta_method="Cumulative optical depth at 365 nm τ = e^(-(z-70 km)/4 km) (cloud top τ = 1 at 70 km and 4 km "
                    "cloud scale height, as adopted by Lee et al. 2021 from Venus Express and Akatsuki analyses), "
                    "continued above 80 km with the upper-haze aerosol scale height 4.8 ± 0.5 km measured from the "
                    "2012 transit aureole (Pere et al. 2016); β = τ/H. Wavelength dependence: Mie extinction of "
                    "Hansen & Hovenier's (1974) droplets relative to 365 nm. Below 60 km (τ > 12) the deck is "
                    "opaque: render it with photometry.json. ESTIMATE: one global profile (the cloud top is lower "
                    "toward the poles).",
        beta_uncertainty="One global profile: the latitude dependence of the cloud top and the day-to-day "
                         "variability of the upper haze are not represented.",
        ssa=np.ones(atmo.FINE.size), ssa_label="estimated", ssa_sources=[s_hh, s_lee],
        ssa_method="1: Hansen & Hovenier's polarimetric retrieval gives a real refractive index; the unknown UV "
                   "absorber that colours Venus lies within ~5 km below the τ = 1 level (Lee et al. 2021), so the "
                   "disk colour belongs to photometry.json, not to these limb layers. ESTIMATE.",
        phase={"kind": "tabulated", "anglesDeg": _sig(atmo.ANGLES_DEG), "values": _sig(vm["phase"], 4)},
        phase_label="estimated", phase_sources=[s_hh],
        phase_method=f"Mie phase function of spheres with Hansen & Hovenier's (1974) polarimetric retrieval: gamma "
                     f"size distribution with effective radius {hh['r_eff_um']} µm and effective variance "
                     f"{hh['v_eff']}, refractive index 1.46 / 1.44 / 1.43 at 365 / 550 / 990 nm (linear between), "
                     "k = 0 (ESTIMATE: the gamma form and k = 0 are assumptions; H&H's parameters are measured).",
        g_fine=g_f, extra={"asymmetry": sourced(_sig(vm["g"], 4), "estimated", [s_hh],
                                                method="Mie asymmetry of the same droplets.")})
    entry = {
        "name": "Venus", "naifId": 299, "referenceRadiusKm": _sig(albedo.mean_radius(299), 7),
        "altitudeReference": "altitude above the mean surface radius; the grid starts at 60 km inside the optically "
                             "thick deck (τ_365 ≈ 12): use 60 km as the lower boundary, with the reflectance of "
                             "photometry.json",
        "altitudesKm": _sig(alt), "topAltitudeKm": float(alt[-1]), "topRadiusKm": None,
        "cloudTopAltitudeKm": sourced(ab.VENUS["lee_2021"]["cloud_top_km"], "derived", [s_lee],
                                      method="τ = 1 at 365 nm (Lee et al. 2021, from Venus Express/Akatsuki studies); "
                                             "Hansen & Hovenier (1974) put τ = 1 near 50 mb."),
        "scaleHeightKm": sourced(first_nss("venus", "Scale height"), "derived", [s_nss],
                                 method="NSSDCA Venus fact sheet: at the SURFACE (737 K). The cloud-top gas and "
                                        "aerosol scale heights are ~4-5 km (see the cloud component)."),
        "surfacePressurePa": sourced(first_nss("venus", "Surface pressure") * 1e5, "derived", [s_nss],
                                     method="NSSDCA: 92 bar."),
        "meanMolecularWeight": sourced(first_nss("venus", "Mean molecular weight"), "derived", [s_nss],
                                       unit="kg/kmol", method="NSSDCA."),
        "components": [cloud],
        "omitted": f"Not included: CO2 Rayleigh scattering above the cloud tops (column above Hansen & Hovenier's "
                   f"50 mb τ = 1 level ≈ {n_above:.2g} m^-2 with the NSSDCA surface gravity, τ ≈ {tau_r550:.3f} at "
                   "550 nm), the UV absorber and SO2 (disk colour: photometry.json), the lower clouds, latitude "
                   "variation (polar collar), mode 1 / mode 3 particles.",
    }
    return entry, {"cloud": d_cloud, "mie": vm}


# ---------------------------------------------------------------------------------------------- Pluto
def pluto(b: Build) -> tuple[dict, dict]:
    common = b.common()
    s_gl, s_ch, s_nss = b.s(src.GLADSTONE_2016), b.s(src.CHENG_2017), b.s(src.nssdc("pluto"))
    alt = PLUTO_ALT
    g = ab.PLUTO["gladstone_2016"]
    pm = ab.pluto_mie()
    a_mid, a_lo, a_hi = ab.pluto_color_exponent()
    shape = ab.pluto_shape(alt)
    shape = shape / np.trapezoid(shape, alt)
    tau_ext_607 = g["vertical_scattering_optical_depth_607nm"] / pm["ssa"]
    spec = (atmo.FINE_VAC / g["lorri_pivot_nm"]) ** (-a_mid)
    beta = tau_ext_607 * shape[:, None] * spec[None, :]
    haze, d_haze = component(
        "haze", "Photochemical haze (New Horizons)", alt, beta,
        beta_label="estimated", beta_sources=[s_gl, *common],
        beta_method=f"Vertical scattering optical depth ~{g['vertical_scattering_optical_depth_607nm']} at 607.6 nm "
                    "(Gladstone et al. 2016: from I/F ≈ 0.2-0.3 at phase 165° with P ≈ 5 for Mie spheres of radius "
                    f"≥ 0.2 µm), / ω = {pm['ssa']:.3f} for extinction; vertical profile e^(-z/50 km) below 100 km and "
                    "a 30 km scale height above (their brightness scale heights; continued above 200 km). Colour: "
                    f"extinction ∝ λ^-{a_mid:.1f}, from the MVIC blue/red I/F ratio ~3 (0.7-0.8 vs 0.2-0.3 at "
                    "phase 165-169°) assuming a wavelength-independent phase function (ESTIMATE). ~20 thin layers are "
                    "not represented.",
        beta_uncertainty=f"Column model-dependent (Cheng et al. 2017 obtain ~0.018 with the same reasoning); colour "
                         f"exponent {a_lo:.1f}-{a_hi:.1f} over the quoted I/F ranges.",
        ssa=np.full(atmo.FINE.size, pm["ssa"]), ssa_label="estimated", ssa_sources=[s_gl],
        ssa_method=f"Mie single-scattering albedo {pm['ssa']:.3f} of Gladstone et al.'s example particles (radius "
                   "0.2 µm, tholin-like n = 1.69, k = 0.018 at 607.6 nm), used at all wavelengths (ESTIMATE).",
        phase={"kind": "tabulated", "anglesDeg": _sig(atmo.ANGLES_DEG),
               "values": _sig(np.tile(pm["phase"], (atmo.GRID_NM.size, 1)), 4)},
        phase_label="estimated", phase_sources=[s_gl, s_ch],
        phase_method=f"Mie phase function of the same particles at 607.6 nm (P = {pm['P165']:.2f} at phase 165°, "
                     f"i.e. scattering angle 15°, vs Gladstone's P ≈ 5; Q_sca = {pm['Qsca']:.2f} vs their ~2.7), used "
                     "at all wavelengths. Aggregate particles (Cheng et al. 2017) are more forward-scattering at "
                     "altitude.",
        g_fine=np.full(atmo.FINE.size, pm["g"]))
    ch4 = ab.PLUTO["cheng_2017"]["table4"]
    entry = {
        "name": "Pluto", "naifId": 999, "referenceRadiusKm": _sig(albedo.mean_radius(999), 7),
        "altitudeReference": "altitude above the surface (reference radius)",
        "altitudesKm": _sig(alt), "topAltitudeKm": float(alt[-1]), "topRadiusKm": None,
        "scaleHeightKm": sourced(first_nss("pluto", "Scale height"), "derived", [s_nss],
                                 method="NSSDCA: '~18 km lower atmosphere, ~50 km above 30 km' (gas)."),
        "surfacePressurePa": sourced(first_nss("pluto", "Surface pressure") * 0.1, "derived", [s_nss],
                                     method="NSSDCA: ~13 microbar."),
        "components": [haze],
        "hazeMeasurements": sourced(
            {"phaseDeg": ch4["phase_deg"], "peakIoverF": ch4["peak_IF"], "IoverFat45km": ch4["IF_at_45km"],
             "wavelengthNm": g["lorri_pivot_nm"]}, "measured", [s_ch],
            method="Cheng et al. (2017) Table 4: haze I/F above the limb (LORRI) at four phase angles, at the peak just "
                   "above the surface and at 45 km."),
        "omitted": "Not included: the ~20 discrete haze layers, the north-south asymmetry, gas Rayleigh scattering "
                   "(~13 µbar: negligible).",
    }
    return entry, {"haze": d_haze, "mie": pm, "a": (a_mid, a_lo, a_hi)}


# ---------------------------------------------------------------------------------------------- giants
GIANTS = {599: "jupiter", 699: "saturn", 799: "uranus", 899: "neptune"}


def giant(b: Build, naif: int) -> dict:
    body = GIANTS[naif]
    s_nss = b.s(src.nssdc(body))
    h_txt = src.nssdc_atmo(body, "Scale height")
    nums = [float(v) for v in re.findall(r"\d+(?:\.\d+)?", h_txt)]
    h = sum(nums) / len(nums)
    mu_txt = src.nssdc_atmo(body, "Mean molecular weight")
    mus = [float(v) for v in re.findall(r"\d+(?:\.\d+)?", mu_txt)]
    return {
        "name": body.capitalize(), "naifId": naif, "referenceRadiusKm": _sig(albedo.mean_radius(naif), 7),
        "altitudeReference": "the 1 bar level (NSSDCA values)",
        "altitudesKm": [], "topAltitudeKm": None, "topRadiusKm": None,
        "scaleHeightKm": sourced(_sig(h, 4), "derived", [s_nss],
                                 method=f"NSSDCA fact sheet: '{h_txt}'" + (" (midpoint)" if len(nums) > 1 else "") +
                                        ", near the 1 bar level."),
        "temperatureAt1barK": sourced(first_nss(body, "Temperature at 1 bar"), "derived", [s_nss], method="NSSDCA."),
        "densityAt1barKgM3": sourced(first_nss(body, "Density at 1 bar"), "derived", [s_nss], method="NSSDCA."),
        "meanMolecularWeight": sourced(_sig(sum(mus) / len(mus), 4), "derived", [s_nss], unit="kg/kmol",
                                       method=f"NSSDCA: '{mu_txt}'."),
        "components": [],
        "limbHaze": unknown("No measured limb-haze extinction/phase profile is used for the giant planets here; the "
                            "disk is calibrated by photometry.json."),
    }


# ---------------------------------------------------------------------------------------------- file
DEFINITION = (
    "Optical properties for physically based sky and limb rendering. Per body: altitudesKm (above referenceRadiusKm's "
    "sphere, see altitudeReference) and components, each with extinctionPerKm[altitude][wavelength] (km^-1; linear "
    "in altitude between grid levels, zero above the top unless stated), singleScatteringAlbedo (per wavelength), a "
    "phaseFunction normalized to a mean of 1 over the sphere, channelEquivalents (X, Y, Z, S: sunlight × CIE "
    "observer weighted, as geometricAlbedoXYZS) and columnOpticalDepth (altitude 0 to top). Wavelengths are "
    "standard-air nm like the CIE tables. The total medium is the sum of the components: β = Σβ_i, ωβ = Σω_iβ_i, "
    "ωβP = Σω_iβ_iP_i. A component whose singleScatteringAlbedo or phaseFunction is 'unknown' must not be rendered "
    "as if known.")


def build(ctx: BuildContext | None = None) -> tuple[dict, dict]:
    b = Build(ctx)
    bodies, diag = {}, {}
    for key, fn in (("399", earth), ("499", mars), ("606", titan), ("299", venus), ("999", pluto)):
        entry, d = fn(b)
        bodies[key] = entry
        diag[key] = d
    for n in GIANTS:
        bodies[str(n)] = giant(b, n)
    for e in bodies.values():
        if e.get("topAltitudeKm") is not None:
            e["topRadiusKm"] = _sig(e["referenceRadiusKm"] + e["topAltitudeKm"], 7)
    common = b.common()
    out = {"definition": DEFINITION, "wavelengthsNm": [float(x) for x in atmo.GRID_NM],
           "channels": ["X", "Y", "Z", "S"],
           "foldWeights": sourced(_sig(atmo.fold_weights(), 6), "derived", common,
                                  method="W[c][k] = ∫ E_sun(λ) cmf_c(λ) φ_k(λ) dλ / ∫ E_sun cmf_c dλ with φ_k the "
                                         "piecewise-linear interpolation basis on wavelengthsNm (TSIS-1 HSRS "
                                         "sunlight, CIE 1931 x̄ ȳ z̄ and V'); rows sum to 1. A renderer that computes a "
                                         "spectral ratio f_k (e.g. sky radiance per unit solar irradiance) at the "
                                         "samples gets channel c as Σ_k W[c][k] f_k, then × the Sun's XYZS "
                                         "(light.json) for absolute values — no solar spectrum needed. Same "
                                         "convention as the surface products' channelWeights."),
           "bodies": bodies}
    return out, diag
