"""Broadband passbands (SVO Filter Profile Service) and solar-weighted band-averaged albedos.

Passbands are used to (a) define the visual geometric albedo p_V reported as `geometricAlbedoV` (Bessell V),
(b) reconstruct spectral shapes from broadband photometry where no spectrum exists (labelled 'estimated'), and
(c) compare our spectra with published broadband albedos. They never enter geometricAlbedoXYZS directly.
Spacecraft camera responses (Cassini ISS WAC, Mars Express HRSC) serve (b) for moons measured with those cameras.
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


def _cassini_wac(band: str) -> Download:
    return Download(
        id=f"svo-cassini-iss-wac-{band.lower()}", url=_SVO.format(id=f"Cassini/ISS_WAC.{band}"), subdir="filters",
        name=f"Cassini_ISS_WAC.{band}.dat",
        title=f"Cassini ISS wide-angle camera {band} system response, SVO Cassini/ISS_WAC.{band}",
        citation="Porco, C. C. et al. (2004). Cassini Imaging Science: instrument characteristics and anticipated "
                 "scientific investigations at Saturn. Space Science Reviews 115, 363-497. "
                 "DOI:10.1007/s11214-004-1456-7. Curve as distributed by the SVO Filter Profile Service (profile "
                 "reference: Cassini ISS Data User's Guide, 2016-09-29). " + _SVO_CITE,
        notes="Full system response (filter + CCD + optics), photon counter (SVO DetectorType 1): band averages "
              "weight by T(λ)·E(λ)·λ. The WAC filter combination is CL1/<band> for VIO, GRN, RED and <band>/CL2 "
              "for CB2, CB3.")


def _hrsc(band: str) -> Download:
    return Download(
        id=f"svo-mex-hrsc-{band.lower()}", url=_SVO.format(id=f"MEX/HRSC.{band}"), subdir="filters",
        name=f"MEX_HRSC.{band}.dat",
        title=f"Mars Express HRSC {band} channel response, SVO MEX/HRSC.{band}",
        citation="Jaumann, R. et al. (2007). The high-resolution stereo camera (HRSC) experiment on Mars Express: "
                 "instrument aspects and experiment conduct from interplanetary cruise through the nominal mission. "
                 "Planetary and Space Science 55, 928-952. DOI:10.1016/j.pss.2006.12.003. Curve as distributed by "
                 "the SVO Filter Profile Service. " + _SVO_CITE,
        notes="Filter + CCD + instrument response, photon counter (SVO DetectorType 1).")


def _wfpc2(band: str) -> Download:
    return Download(
        id=f"svo-hst-wfpc2-pc-{band.lower()}", url=_SVO.format(id=f"HST/WFPC2-PC.{band}"), subdir="filters",
        name=f"HST_WFPC2-PC.{band}.dat",
        title=f"HST WFPC2 planetary camera {band} system throughput, SVO HST/WFPC2-PC.{band}",
        citation="HST WFPC2 system throughput as tabulated by STScI synthetic photometry (stsynphot/synphot "
                 "throughput tables; profile reference https://stsynphot.readthedocs.io/en/latest/stsynphot/"
                 "appendixb.html), distributed by the SVO Filter Profile Service. " + _SVO_CITE,
        notes="Filter + CCD + instrument, photon counter (SVO DetectorType 1). The PC and WF curves differ by < 1 nm "
              "in effective wavelength.")


def _voyager_nac(band: str) -> Download:
    return Download(
        id=f"svo-voyager-iss-nac-{band.lower()}", url=_SVO.format(id=f"Voyager/ISS-NAC.{band}"), subdir="filters",
        name=f"Voyager_ISS-NAC.{band}.dat",
        title=f"Voyager ISS narrow-angle camera {band} relative spectral response, SVO Voyager/ISS-NAC.{band}",
        citation="Smith, B. A. et al. (1977). Voyager imaging experiment. Space Science Reviews 21, 103-127. "
                 "DOI:10.1007/BF00200847. Curve as distributed by the SVO Filter Profile Service. " + _SVO_CITE,
        notes="Filter + instrument (vidicon) relative response; SVO lists it as an energy counter (DetectorType 0).")


def _hriv(band: str) -> Download:
    return Download(
        id=f"svo-deepimpact-hriv-{band.lower()}", url=_SVO.format(id=f"DeepImpact/HRI-VIS.{band}"), subdir="filters",
        name=f"DeepImpact_HRI-VIS.{band}.dat",
        title=f"Deep Impact HRI-VIS {band} filter system response, SVO DeepImpact/HRI-VIS.{band}",
        citation="Hampton, D. L. et al. (2005). An overview of the instrument suite for the Deep Impact mission. "
                 "Space Science Reviews 117, 43-93. DOI:10.1007/s11214-005-3390-8. Curve as distributed by the SVO "
                 "Filter Profile Service (profile reference: PDS DIF-C-HRIV-3/4-9P-ENCOUNTER-V3.0 calib). " + _SVO_CITE,
        notes="Filter + CCD system response, photon counter (SVO DetectorType 1).")


def _lorri() -> Download:
    return Download(
        id="svo-newhorizons-lorri-pan", url=_SVO.format(id="NewHorizons/LORRI.Pan"), subdir="filters",
        name="NewHorizons_LORRI.Pan.dat",
        title="New Horizons LORRI panchromatic system QE, SVO NewHorizons/LORRI.Pan",
        citation="Cheng, A. F. et al. (2008). Long-Range Reconnaissance Imager on New Horizons. Space Science "
                 "Reviews 140, 189-215. DOI:10.1007/s11214-007-9271-6. Curve as distributed by the SVO Filter "
                 "Profile Service (profile reference: PDS nh-x-lorri-3-launch-v3.0, calib/). " + _SVO_CITE,
        notes="System quantum efficiency (filter + CCD), photon counter (SVO DetectorType 1); pivot wavelength "
              "607.6 nm, as used by the LORRI calibration keywords.")


def _ahi9_download() -> Download:
    from .earth_data import AHI_SRF
    return AHI_SRF


FILTERS = {**{f"bessell.{b}": _bessell(b) for b in "UBVRI"}, **{f"johnson.{b}": _johnson(b) for b in "UBVRI"},
           **{f"hriv.{b}": _hriv(b) for b in ("Violet", "Blue", "Green", "Orange", "Red", "NIR", "IR")},
           **{f"ahi9.B{b:02d}": _ahi9_download() for b in (1, 2, 3, 4)},
           **{f"wfpc2.{b}": _wfpc2(b) for b in ("F336W", "F439W", "F555W", "F675W", "F814W")},
           **{f"voyager.nac.{b}": _voyager_nac(b) for b in ("Clear", "Violet", "Blue", "Green", "Orange")},
           "lorri.Pan": _lorri(),
           **{f"cassini.wac.{b}": _cassini_wac(b) for b in ("VIO", "BL1", "GRN", "RED", "CB2", "CB3")},
           **{f"hrsc.{b}": _hrsc(b) for b in ("Blue", "Green", "Red", "NIR")}}
# Short aliases: plain letters are Bessell (1990).
FILTERS.update({b: FILTERS[f"bessell.{b}"] for b in "UBVRI"})

# Photon-counting responses (SVO DetectorType 1): the detected signal is ∫ E T λ dλ / (hc), so band averages of an
# albedo weight by E·T·λ. Johnson/Bessell curves are tabulated as energy responses (DetectorType 0): weight E·T.
PHOTON_COUNTERS = {k for k in FILTERS if k.startswith(("cassini.", "hrsc.", "wfpc2.", "hriv.", "lorri."))}
# AHI-09 responses (JMA workbook, not SVO) weight radiance per unit wavelength: energy weighting.


@lru_cache(maxsize=None)
def passband(key: str) -> tuple[np.ndarray, np.ndarray]:
    if key.startswith("ahi9."):
        from .earth import ahi_passband
        return ahi_passband(int(key[-2:]))
    d = np.loadtxt(FILTERS[key].fetch())
    return d[:, 0] / 10.0, d[:, 1]  # nm, transmission


def register(ctx: BuildContext | None, keys=("V",)) -> list[str]:
    return [FILTERS[k].register(ctx) if ctx else FILTERS[k].id for k in keys]


@lru_cache(maxsize=None)
def solar_weights(key: str) -> tuple[np.ndarray, np.ndarray]:
    """(λ, E(λ)·T(λ)) on the HSRS air grid within the tabulated passband, times λ for photon counters."""
    fw, ft = passband(key)
    s = solar.spectrum()
    m = (s.wl_air >= fw.min()) & (s.wl_air <= fw.max())
    lam = s.wl_air[m]
    w = s.ssi_air[m] * np.interp(lam, fw, ft, left=0.0, right=0.0)
    return lam, (w * lam if key in PHOTON_COUNTERS else w)


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
