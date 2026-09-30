"""CIE observers on the common 1 nm grid, and spectrum -> (X, Y, Z, scotopic) integration.

Every stage that turns a spectrum into something the renderer can show goes through this module, so
all colors in the app share one set of observer tables (docs/architecture.md §4.2).

Current tables come from the `colour-science` package's machine-readable transcription of the CIE
standards. TODO(light stage): fetch the official CIE CSV datasets, verify they match, and cite those.
"""

from __future__ import annotations

import datetime as _dt
from functools import lru_cache

import numpy as np

from .schema import BuildContext, SourceRecord

WAVELENGTHS = np.arange(360.0, 831.0, 1.0)  # nm
KM_PHOTOPIC = 683.002   # lm/W, CIE 015:2018
KM_SCOTOPIC = 1700.06   # lm/W, CIE 015:2018

SOURCE_CMF = "cie-1931-2deg-cmf"
SOURCE_SCOTOPIC = "cie-1951-scotopic"


@lru_cache(maxsize=1)
def cmfs() -> np.ndarray:
    """(N, 3) array of x̄, ȳ, z̄ on WAVELENGTHS."""
    import colour
    sd = colour.MSDS_CMFS["CIE 1931 2 Degree Standard Observer"].copy().align(
        colour.SpectralShape(WAVELENGTHS[0], WAVELENGTHS[-1], 1.0))
    return np.asarray(sd.values)


@lru_cache(maxsize=1)
def scotopic() -> np.ndarray:
    """(N,) array of V′(λ) on WAVELENGTHS."""
    import colour
    sd = colour.SDS_LEFS["CIE 1951 Scotopic Standard Observer"].copy().align(
        colour.SpectralShape(WAVELENGTHS[0], WAVELENGTHS[-1], 1.0))
    return np.asarray(sd.values)


def resample(wl_nm: np.ndarray, values: np.ndarray) -> np.ndarray:
    """Linear interpolation onto WAVELENGTHS. Outside the input range the result is NaN (caller decides)."""
    out = np.interp(WAVELENGTHS, wl_nm, values, left=np.nan, right=np.nan)
    return out


def xyzs(spectrum_on_grid: np.ndarray) -> np.ndarray:
    """Integrate a spectral quantity (per nm, on WAVELENGTHS) against the observers.

    For spectral irradiance in W m^-2 nm^-1 the result is (X, Y, Z, S) with Y = illuminance in lux and
    S = scotopic illuminance in scotopic lux. Same for radiance -> cd/m^2.
    """
    if np.isnan(spectrum_on_grid).any():
        raise ValueError("spectrum does not cover 360–830 nm; extend or document a cutoff explicitly")
    dl = 1.0
    xyz = KM_PHOTOPIC * (spectrum_on_grid[:, None] * cmfs()).sum(axis=0) * dl
    s = KM_SCOTOPIC * (spectrum_on_grid * scotopic()).sum() * dl
    return np.array([xyz[0], xyz[1], xyz[2], s])


def register_sources(ctx: BuildContext) -> list[str]:
    import colour
    today = _dt.date.today().isoformat()
    ctx.add_source(SourceRecord(
        id=SOURCE_CMF,
        title="CIE 1931 2° standard colorimetric observer (colour-matching functions)",
        citation="CIE 015:2018 Colorimetry, 4th ed. CIE, Vienna. DOI:10.25039/TR.015.2018; tables via colour-science "
                 f"{colour.__version__} (colour.MSDS_CMFS['CIE 1931 2 Degree Standard Observer']).",
        url="https://cie.co.at/datatable/cie-1931-colour-matching-functions-2-degree-observer",
        retrieved=today, version=f"colour-science {colour.__version__}",
    ))
    ctx.add_source(SourceRecord(
        id=SOURCE_SCOTOPIC,
        title="CIE 1951 scotopic luminous efficiency function V′(λ)",
        citation="CIE 015:2018 Colorimetry; CIE 1951 scotopic observer. Tables via colour-science "
                 f"{colour.__version__} (colour.SDS_LEFS).",
        url="https://cie.co.at/datatable/cie-scotopic-luminous-efficiency-function",
        retrieved=today, version=f"colour-science {colour.__version__}",
    ))
    return [SOURCE_CMF, SOURCE_SCOTOPIC]
