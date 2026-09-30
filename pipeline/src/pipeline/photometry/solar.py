"""The Sun: measured spectral irradiance at 1 AU (TSIS-1 HSRS v2), its CIE integrals, per-channel limb darkening
(Neckel & Labs 1994), and the photospheric radius (IAU 2015 Resolution B3)."""

from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from .. import cie
from ..schema import BuildContext, SourceRecord, sourced
from .common import Download, bin_average, read_table_csv, spectral_density_to_air

HSRS = Download(
    id="tsis1-hsrs-v2",
    url="https://lasp.colorado.edu/lisird/resources/lasp/hsrs/v2/"
        "hybrid_reference_spectrum_p1nm_resolution_c2022-11-30_with_unc.nc",
    subdir="solar", name=None,
    title="TSIS-1 Hybrid Solar Reference Spectrum (HSRS), Version 2, 0.1 nm resolution, with uncertainties",
    citation="Coddington, O. M., Richard, E. C., Harber, D., Pilewskie, P., Woods, T. N., Snow, M., Chance, K., "
             "Liu, X. & Sun, K. (2023). Version 2 of the TSIS-1 Hybrid Solar Reference Spectrum and extension to the "
             "full spectrum. Earth and Space Science 10, e2022EA002637. DOI:10.1029/2022EA002637. Method: "
             "Coddington, O. M. et al. (2021), The TSIS-1 Hybrid Solar Reference Spectrum, Geophysical Research "
             "Letters 48, e2020GL091709, DOI:10.1029/2020GL091709. Distributed by LASP LISIRD.",
    version="v2, file id final-v2_hybrid_reference_spectrum_p1nm_resolution_c2022-11-30_with_unc.nc",
    notes="Spectral solar irradiance at 1 AU, 202-2730 nm, vacuum wavelengths, 0.1 nm resolution sampled every "
          "0.025 nm, normalized to TSIS-1 SIM (average of 2019 Dec 1-7, solar minimum) and scaled by 0.999061 to TIM "
          "TSI. Stated uncertainty 0.3 % (460-2365 nm), 1.3 % elsewhere. Landing page "
          "https://lasp.colorado.edu/lisird/data/tsis1_hsrs_p1nm/",
)

IAU_B3 = Download(
    id="iau-2015-b3",
    url="https://arxiv.org/pdf/1510.07674v1", subdir="papers", name="arXiv-1510.07674v1.pdf",
    title="IAU 2015 Resolution B3 on recommended nominal conversion constants for selected solar and planetary "
          "properties",
    citation="Prša, A., Harmanec, P., Torres, G., Mamajek, E., Asplund, M., Capitaine, N., Christensen-Dalsgaard, J., "
             "Depagne, É., Haberreiter, M., Hekker, S., Hilton, J., Kopp, G., Kostov, V., Kurtz, D. W., Laskar, J., "
             "Mason, B. D., Milone, E. F., Montgomery, M., Richards, M., Schmutz, W., Schou, J. & Stewart, S. G. "
             "(2016). Nominal values for selected solar and planetary quantities: IAU 2015 Resolution B3. "
             "Astronomical Journal 152, 41. DOI:10.3847/0004-6256/152/2/41 (text of the resolution: arXiv:1510.07674).",
    notes="Nominal solar radius R_sun^N = 6.957e8 m (exact by definition), chosen to match the photospheric radius "
          "(tau_Ross = 2/3) of Haberreiter, Schmutz & Kosovichev (2008, ApJ 675, L53): 695 658 +/- 140 km. Also the "
          "nominal total solar irradiance S_sun^N = 1361 W m^-2 (cycle-23 mean TSI 1361 +/- 1 W m^-2), used here "
          "only as a sanity check of the spectrum integral.",
)

NECKEL_LABS = Download(
    id="neckel-labs-1994",
    url="https://articles.adsabs.harvard.edu/pdf/1994SoPh..153...91N", subdir="papers",
    name="1994SoPh..153...91N.pdf",
    title="Solar limb darkening 1986-1990 (303 to 1099 nm): Table I, fifth-order polynomial coefficients",
    citation="Neckel, H. & Labs, D. (1994). Solar limb darkening 1986-1990 (λλ303 to 1099 nm). Solar Physics 153, "
             "91-114. DOI:10.1007/BF00712494.",
    notes="Table I (p. 98), 30 continuum wavelengths, transcribed to "
          "pipeline/src/pipeline/photometry/tables/neckel_labs_1994_table1.csv from this ADS scan (see "
          "docs/sources/neckel-labs-1994.md). The printed row at 365.875 nm violates the paper's own Eq. 5 "
          "(sum A = 0.998) and Eq. 6 (F/I); A2 = 0.17682 instead of the printed 0.17482 restores both exactly and is "
          "used (a presumed typesetting error).",
)


def edlen_source() -> SourceRecord:
    return SourceRecord(
        id="edlen-1966",
        title="Dispersion formula for the refractive index of standard air",
        citation="Edlén, B. (1966). The refractive index of air. Metrologia 2, 71-80. DOI:10.1088/0026-1394/2/2/002.",
        url="https://doi.org/10.1088/0026-1394/2/2/002",
        retrieved=_dt.date.today().isoformat(),
        notes="Formula only (Eq. 1, standard air: dry, 15 degC, 101 325 Pa, 0.03 % CO2, the same 'standard air' in "
              "which the CIE tables are given); no data file is downloaded. Used to convert vacuum wavelengths "
              "(TSIS-1 HSRS) to standard-air wavelengths; the shift is about 0.15 nm at 550 nm.",
    )


# ---------------------------------------------------------------------------------------------- spectrum
@dataclass(frozen=True)
class SolarSpectrum:
    wl_vac: np.ndarray       # nm
    ssi_vac: np.ndarray      # W m^-2 nm^-1 (per vacuum nm)
    unc_vac: np.ndarray
    wl_air: np.ndarray       # nm (standard air)
    ssi_air: np.ndarray      # W m^-2 nm^-1 (per air nm)
    grid: np.ndarray         # on cie.WAVELENGTHS, 1 nm bin averages, W m^-2 nm^-1 (air)


@lru_cache(maxsize=1)
def spectrum() -> SolarSpectrum:
    import h5py
    with h5py.File(HSRS.fetch(), "r") as f:
        wl = np.asarray(f["Vacuum Wavelength"][:], float)
        ssi = np.asarray(f["SSI"][:], float)
        unc = np.asarray(f["SSI_UNC"][:], float)
        units = f["SSI"].attrs.get("units", b"").decode()
    if units.replace(" ", "") != "Wm-2nm-1":
        raise ValueError(f"unexpected HSRS units {units!r}")
    wl_air, ssi_air = spectral_density_to_air(wl, ssi)
    grid = bin_average(wl_air, ssi_air)
    return SolarSpectrum(wl, ssi, unc, wl_air, ssi_air, grid)


def irradiance_xyzs() -> np.ndarray:
    """(X, Y, Z, S) of sunlight at 1 AU: Y in lux, S in scotopic lux."""
    return cie.xyzs(spectrum().grid)


def total_irradiance() -> dict:
    """Integral of the spectrum over its whole range and over 360-830 nm (vacuum-wavelength trapezoid)."""
    s = spectrum()
    m = (s.wl_vac >= 360) & (s.wl_vac <= 830)
    return {"range_nm": [float(s.wl_vac[0]), float(s.wl_vac[-1])],
            "total_W_m2": float(np.trapezoid(s.ssi_vac, s.wl_vac)),
            "visible_360_830_W_m2": float(np.trapezoid(s.ssi_vac[m], s.wl_vac[m]))}


# ---------------------------------------------------------------------------------------------- limb darkening
# The one printed row that fails the paper's own identities (see NECKEL_LABS.notes and docs/sources).
NL94_ERRATA = {365.875: ("A2", 0.17482, 0.17682)}


def neckel_labs_table(apply_errata: bool = True) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(wavelength_nm, A[n, 6], printed F/I) from Table I."""
    rows = read_table_csv("neckel_labs_1994_table1.csv")
    wl = np.array([float(r["wavelength_nm"]) for r in rows])
    a = np.array([[float(r[f"A{k}"]) for k in range(6)] for r in rows])
    fi = np.array([float(r["F_over_I"]) for r in rows])
    if apply_errata:
        for lam, (col, printed, fixed) in NL94_ERRATA.items():
            i = int(np.argmin(np.abs(wl - lam)))
            k = int(col[1:])
            if abs(wl[i] - lam) > 1e-6 or a[i, k] != printed:
                raise ValueError("Neckel & Labs erratum no longer matches the transcription")
            a[i, k] = fixed
    return wl, a, fi


@dataclass(frozen=True)
class LimbDarkening:
    coeffs: np.ndarray          # (4, 6): X, Y, Z, S channels; I(mu)/I(1) = sum_k c_k mu^k
    fit_residual_max: float     # max |channel-integrated profile - refit 5th-order polynomial| over mu in [0, 1]
    at_mu1: np.ndarray          # polynomial value at mu = 1 per channel (1 up to the 5-decimal rounding of Table I)
    flux_to_center: np.ndarray  # F/I per channel = 2 * sum c_k / (k + 2)


def limb_darkening() -> LimbDarkening:
    wl_t, a_t, _ = neckel_labs_table()
    lam = cie.WAVELENGTHS
    if lam[0] < wl_t[0] or lam[-1] > wl_t[-1]:
        raise ValueError("Neckel & Labs table does not cover the CIE grid")
    # Coefficients vs wavelength: linear interpolation between the 30 measured continuum wavelengths.
    a = np.stack([np.interp(lam, wl_t, a_t[:, k]) for k in range(6)], axis=1)          # (N, 6)
    f_over_i = 2.0 * (a / np.arange(2, 8)).sum(axis=1)                                 # flux / (pi * I_center)
    i_center = spectrum().grid / f_over_i                                              # ∝ disk-centre intensity
    obs = np.column_stack([cie.cmfs(), cie.scotopic()])                                # (N, 4)
    w = i_center[:, None] * obs                                                        # (N, 4)
    coeffs = (w.T @ a) / w.sum(axis=0)[:, None]                                        # (4, 6)
    # Independent check: integrate the profile channel by channel on a mu grid and refit a 5th-order polynomial.
    mu = np.linspace(0.0, 1.0, 201)
    prof_lambda = a @ np.vander(mu, 6, increasing=True).T                              # (N, M)
    prof = (w.T @ prof_lambda) / w.sum(axis=0)[:, None]                                # (4, M)
    resid = 0.0
    for c in range(4):
        fit = np.polynomial.polynomial.polyfit(mu, prof[c], 5)
        resid = max(resid, float(np.max(np.abs(np.polynomial.polynomial.polyval(mu, fit) - prof[c]))))
        resid = max(resid, float(np.max(np.abs(fit - coeffs[c]))))
    return LimbDarkening(coeffs=coeffs, fit_residual_max=resid, at_mu1=coeffs.sum(axis=1),
                         flux_to_center=2.0 * (coeffs / np.arange(2, 8)).sum(axis=1))


SOLAR_RADIUS_KM = 695700.0  # IAU 2015 Resolution B3: R_sun^N = 6.957e8 m


# ---------------------------------------------------------------------------------------------- light.json
def register_sources(ctx: BuildContext) -> dict[str, str]:
    ids = {"cie": cie.register_sources(ctx)}
    ids["hsrs"] = HSRS.register(ctx)
    ids["b3"] = IAU_B3.register(ctx)
    ids["nl94"] = NECKEL_LABS.register(ctx)
    ids["edlen"] = ctx.add_source(edlen_source())
    return ids


def light_json(ctx: BuildContext) -> tuple[dict, dict]:
    """(light.json content, diagnostics for the build log / report)."""
    ids = register_sources(ctx)
    cie_ids = ids["cie"]
    e = irradiance_xyzs()
    tsi = total_irradiance()
    ld = limb_darkening()
    X, Y, Z, S = e
    diag = {"xyzs": e.tolist(), "xy": [X / (X + Y + Z), Y / (X + Y + Z)], "tsi": tsi,
            "limb": {"coeffs": ld.coeffs.tolist(), "fit_residual_max": ld.fit_residual_max,
                     "at_mu1": ld.at_mu1.tolist(), "F_over_I": ld.flux_to_center.tolist()}}
    sun = {
        "irradianceXYZS_1AU": sourced(
            [float(v) for v in e], "derived", [ids["hsrs"], *cie_ids, ids["edlen"]], unit="lux",
            method="TSIS-1 HSRS v2 spectral irradiance, converted from vacuum to standard-air wavelengths (Edlén 1966) "
                   "with the per-nm density transformed accordingly, averaged over 1 nm bins centred on the "
                   "360-830 nm CIE grid, then summed against the CIE 1931 2° CMFs (K_m = 683.002 lm/W) and the "
                   "CIE scotopic V′(λ) (K′_m = 1700.06 lm/W). X, Z share Y's scaling; S is scotopic lux.",
            uncertainty="±0.3 % (HSRS absolute uncertainty 460-2365 nm; 1.3 % below 460 nm); spectrum is the "
                        "2019 December solar-minimum reference (visible variability over a cycle ~0.1 %)."),
        "radius": sourced(
            SOLAR_RADIUS_KM, "measured", [ids["b3"]], unit="km",
            method="IAU 2015 Resolution B3 nominal solar radius, adopted to equal the measured photospheric radius "
                   "(tau_Rosseland = 2/3) of Haberreiter et al. (2008).",
            uncertainty="nominal value is exact by definition; the underlying measurement is 695 658 ± 140 km"),
        "limbDarkening": sourced(
            {"kind": "poly-mu", "coeffsXYZS": [[float(c) for c in row] for row in ld.coeffs]},
            "estimated", [ids["nl94"], ids["hsrs"], *cie_ids],
            method="I(μ)/I(1) = Σ c_k μ^k (k = 0..5) per channel X, Y, Z, S. Neckel & Labs (1994) Table I "
                   "continuum coefficients A_k(λ) (30 wavelengths, 303-1099 nm; A2 at 365.875 nm corrected to "
                   "0.17682 so the row satisfies the paper's Eqs. 5-6) are interpolated linearly in λ onto the 1 nm "
                   "grid and averaged with weights I_λ(1)·cmf(λ), where the disk-centre intensity I_λ(1) ∝ E_λ / "
                   "(F/I)_λ from the HSRS irradiance and Eq. 6. Assumes the measured continuum centre-to-limb "
                   "variation applies to all wavelengths, including inside Fraunhofer lines, and across the Balmer "
                   "jump (360-366 nm is interpolated between 349.9 and 365.9 nm). A weighted mean of 5th-order "
                   f"polynomials is exactly 5th order; refitting the channel profiles on 201 μ samples reproduces "
                   f"the coefficients to {ld.fit_residual_max:.1e}.",
            uncertainty="Neckel & Labs: seasonal-mean profiles vary by < 1 % of disk-centre intensity (occasionally "
                        "2-3 %); the polynomials were fitted with the outermost 7″ excluded (μ ≲ 0.12 is an "
                        "extrapolation of the fit)."),
    }
    light = {"sun": sun, "cie": {"photopicKm": cie.KM_PHOTOPIC, "scotopicKm": cie.KM_SCOTOPIC, "sources": cie_ids}}
    return light, diag
