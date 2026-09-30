"""Broadband passbands (SVO Filter Profile Service) and solar-weighted band-averaged albedos.

Passbands are used to (a) define the visual geometric albedo p_V reported as `geometricAlbedoV` (Bessell V),
(b) reconstruct spectral shapes from broadband photometry where no spectrum exists (labelled 'estimated'), and
(c) compare our spectra with published broadband albedos. They never enter geometricAlbedoXYZS directly.
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np

from ..schema import BuildContext
from .common import Download
from . import solar

_SVO = "https://svo2.cab.inta-csic.es/theory/fps/getdata.php?format=ascii&id={id}"
_SVO_CITE = ("Machine-readable curve from the SVO Filter Profile Service (Rodrigo, C., Solano, E. & Bayo, A. 2012, "
             "SVO Filter Profile Service Version 1.0, IVOA Working Draft, ADS 2012ivoa.rept.1015R; Rodrigo, C. & "
             "Solano, E. 2020, XIV.0 Scientific Meeting of the Spanish Astronomical Society, 182).")


def _bessell(band: str) -> Download:
    return Download(
        id=f"bessell-1990-{band.lower()}", url=_SVO.format(id=f"Generic/Bessell.{band}"), subdir="filters",
        name=f"Generic_Bessell.{band}.dat",
        title=f"Johnson-Cousins {band} passband (Bessell 1990), SVO Generic/Bessell.{band}",
        citation="Bessell, M. S. (1990). UBVRI passbands. Publications of the Astronomical Society of the Pacific "
                 "102, 1181-1199. DOI:10.1086/132749. " + _SVO_CITE,
        notes="Wavelength in Angstrom; SVO lists the curve as an energy-counter response (DetectorType 0), so band "
              "averages weight by T(λ)·E(λ). R and I are the Cousins bands.")


def _johnson(band: str) -> Download:
    return Download(
        id=f"svo-johnson-{band.lower()}", url=_SVO.format(id=f"Generic/Johnson.{band}"), subdir="filters",
        name=f"Generic_Johnson.{band}.dat",
        title=f"Johnson {band} passband, SVO Generic/Johnson.{band}",
        citation="Johnson UBVRI photometric system passband as distributed by the SVO Filter Profile Service "
                 f"(filter id Generic/Johnson.{band}). " + _SVO_CITE,
        notes="Energy-counter response (DetectorType 0). The SVO entry does not document which publication the "
              "curve was digitized from; used only where a planet's published albedo is on Johnson R or I.")


FILTERS = {**{f"bessell.{b}": _bessell(b) for b in "UBVRI"}, **{f"johnson.{b}": _johnson(b) for b in "UBVRI"}}
# Short aliases: plain letters are Bessell (1990).
FILTERS.update({b: FILTERS[f"bessell.{b}"] for b in "UBVRI"})


@lru_cache(maxsize=None)
def passband(key: str) -> tuple[np.ndarray, np.ndarray]:
    d = np.loadtxt(FILTERS[key].fetch())
    return d[:, 0] / 10.0, d[:, 1]  # nm, transmission


def register(ctx: BuildContext | None, keys=("V",)) -> list[str]:
    return [FILTERS[k].register(ctx) if ctx else FILTERS[k].id for k in keys]


@lru_cache(maxsize=None)
def solar_weights(key: str) -> tuple[np.ndarray, np.ndarray]:
    """(λ, E(λ)·T(λ)) on the HSRS air grid within the tabulated passband."""
    fw, ft = passband(key)
    s = solar.spectrum()
    m = (s.wl_air >= fw.min()) & (s.wl_air <= fw.max())
    lam = s.wl_air[m]
    return lam, s.ssi_air[m] * np.interp(lam, fw, ft, left=0.0, right=0.0)


def covers(key: str, wl_nm: np.ndarray) -> bool:
    fw, ft = passband(key)
    nz = fw[ft > 0]
    wl = np.asarray(wl_nm, float)
    return bool(wl.min() <= nz.min() and wl.max() >= nz.max())


def band_average(key: str, wl_nm: np.ndarray, p: np.ndarray) -> float | None:
    """Solar-weighted band average ∫ p E T dλ / ∫ E T dλ (HSRS air grid); None if p does not cover the passband."""
    if not covers(key, wl_nm):
        return None
    lam, w = solar_weights(key)
    return float(np.sum(np.interp(lam, np.asarray(wl_nm, float), p) * w) / np.sum(w))


def effective_wavelength(key: str) -> float:
    lam, w = solar_weights(key)
    return float(np.sum(lam * w) / np.sum(w))
