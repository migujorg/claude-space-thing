"""Moon photometry: geometric-albedo spectra and disk-integrated phase curves for the major moons (milestone M2).

Per body (details in each builder's `method` text and in docs/sources/):
  Phobos           Fornasier et al. (2024) Mars Express HRSC: Hapke geometric albedos in 4 bands (reconstruction),
                   IAU H-G phase curve.
  Deimos           Wargnier et al. (2025) HRSC/SRC panchromatic geometric albedo only (grey assumption); phase unknown.
  Io..Callisto     Mayorga et al. (2020) Cassini ISS WAC disk-integrated phase curves in up to 5 filters: geometric
                   albedos (reconstruction) and the GRN phase curve.
  Mimas..Rhea      Filacchione et al. (2022) Cassini VIMS photometric model (Akimov disk function × quadratic phase
                   function) at 64 wavelengths: normal albedo spectrum and the disk-integrated phase curve (10-120°);
                   below 10° the measured opposition-surge shape of Enceladus and Rhea (Deau et al. 2009 fits).
  Titan            Karkoschka (1998) full-disk albedo at 5.7° (PDS) × 1.02 to zero phase (García Muñoz et al. 2017).
  Ariel..Oberon    DeColibus et al. (2026) disk-integrated spectra (Zenodo) scaled to Karkoschka (2001) albedos;
                   Karkoschka (2001) phase function.
  Triton           Verbiscer et al. (2022) Table 2 p_V and B-V; Buratti et al. (2011) phase coefficient (their Table 3).
  Charon           Buie et al. (2010) HST B and V photometry and Hapke fit.
  Iapetus, Miranda unknown (reasons in the entries).
  Himalia..Leda,   Irregular satellites with pck00011 radii: V absolute magnitude H and slope G compiled by Grav et al.
  Phoebe           (2015) -> visual albedo at the pck radius; colour ASSUMED grey; H-G phase curve (estimated).
Moons with no accessible disk-integrated photometry (the small inner moons of Jupiter, Saturn, Uranus and Neptune,
Hyperion, Nereid, the other irregulars) are left out: absent from photometry.json means unknown.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import re
import tarfile
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from ..download import fetch
from ..schema import BuildContext
from . import albedo, diskint, filters, phase
from .albedo import PCK, AlbedoSpectrum, _src, mean_radius, sun_mag
from .common import AU_KM, Download, read_table_csv, read_table_json
from .phase import Phase, _tabulate

MOONS = {401: "Phobos", 402: "Deimos", 501: "Io", 502: "Europa", 503: "Ganymede", 504: "Callisto", 601: "Mimas",
         602: "Enceladus", 603: "Tethys", 604: "Dione", 605: "Rhea", 606: "Titan", 608: "Iapetus", 701: "Ariel",
         702: "Umbriel", 703: "Titania", 704: "Oberon", 705: "Miranda", 801: "Triton", 901: "Charon",
         506: "Himalia", 507: "Elara", 508: "Pasiphae", 509: "Sinope", 510: "Lysithea", 511: "Carme", 512: "Ananke",
         513: "Leda", 609: "Phoebe"}
IRREGULAR = (506, 507, 508, 509, 510, 511, 512, 513, 609)


@dataclass(frozen=True)
class Unknown:
    """A photometric quantity that no accessible measurement constrains; `reason` goes into the entry's method."""
    reason: str


# ---------------------------------------------------------------------------------------------- sources
def _arxiv(id_: str, arxiv: str, title: str, citation: str, notes: str) -> Download:
    return Download(id=id_, url=f"https://arxiv.org/pdf/{arxiv}", subdir="papers", name=f"arXiv-{arxiv}.pdf",
                    title=title, citation=citation, notes=notes)


MAYORGA = _arxiv(
    "mayorga-2020", "2009.05467v1",
    "Cassini ISS disk-integrated phase curves of the Galilean satellites (Table 5 polynomials)",
    "Mayorga, L. C., Charbonneau, D. & Thorngren, D. P. (2020). Reflected light observations of the Galilean "
    "satellites from Cassini: a test bed for cold terrestrial exoplanets. Astronomical Journal 160, 238. "
    "DOI:10.3847/1538-3881/abb8df (accepted manuscript arXiv:2009.05467v1).",
    "Cassini ISS WAC (3299 images) and NAC photometry of Io, Europa, Ganymede and Callisto during the 2000-2001 "
    "Jupiter flyby, 0-135 deg phase, CISSCAL 3.9 calibration. Table 5 transcribed to "
    "photometry/tables/mayorga_2020_table5.csv (docs/sources/mayorga-2020.md).")

FILACCHIONE = _arxiv(
    "filacchione-2022", "2111.15541v1",
    "Cassini VIMS photometric parameters of Mimas, Enceladus, Tethys, Dione and Rhea (Tables .2-.6)",
    "Filacchione, G., Ciarniello, M., D'Aversa, E., Capaccioni, F., Clark, R. N., Buratti, B. J., Helfenstein, P., "
    "Stephan, K. & Plainaki, C. (2022). Saturn's icy satellites investigated by Cassini-VIMS. V. Spectrophotometry. "
    "Icarus 375, 114803. DOI:10.1016/j.icarus.2021.114803 (accepted manuscript arXiv:2111.15541v1).",
    "Akimov disk function × quadratic phase function fitted per wavelength to all VIMS pixels with i, e <= 70 deg "
    "and 10 <= g <= 120 deg. Visible-channel rows transcribed to photometry/tables/filacchione_2022_tables.csv "
    "(docs/sources/filacchione-2022.md).")

GARCIA_MUNOZ = _arxiv(
    "garcia-munoz-2017", "1704.07460v1",
    "Titan's Cassini ISS phase curves; zero-phase correction of Karkoschka's 5.7 deg albedo spectrum",
    "García Muñoz, A., Lavvas, P. & West, R. A. (2017). Titan brighter at twilight than in daylight. Nature "
    "Astronomy 1, 0114. DOI:10.1038/s41550-017-0114 (arXiv:1704.07460v1).",
    "Methods, 'Geometric albedo': Karkoschka's (1998) spectrum × 1.02 is the geometric albedo (radius 2575 km); "
    "transcribed to photometry/tables/garcia_munoz_2017_titan.json.")

FORNASIER = _arxiv(
    "fornasier-2024", "2403.12156v1",
    "Phobos disk-integrated photometry from Mars Express HRSC (Tables 1-2)",
    "Fornasier, S., Wargnier, A., Hasselmann, P. H., Tirsch, D., Matz, K.-D., Doressoundiram, A., Gautier, T. & "
    "Barucci, M. A. (2024). Phobos photometric properties from Mars Express HRSC observations. Astronomy & "
    "Astrophysics 686, A203. DOI:10.1051/0004-6361/202449220 (accepted manuscript arXiv:2403.12156v1).",
    "Transcribed to photometry/tables/fornasier_2024_phobos.json (docs/sources/fornasier-2024.md).")

WARGNIER = _arxiv(
    "wargnier-2025", "2509.12804v1",
    "Deimos disk-integrated photometry from Mars Express HRSC/SRC (Table 4)",
    "Wargnier, A., Simon, P. N., Fornasier, S., El-Bez-Sebastien, N., Tirsch, D., Matz, K.-D., Gautier, T., "
    "Doressoundiram, A. & Barucci, M. A. (2025). Deimos photometric properties: analysis of 20 years of observations "
    "(2004-2024) by the Mars Express HRSC camera. Astronomy & Astrophysics 703, A289. "
    "DOI:10.1051/0004-6361/202555564 (accepted manuscript arXiv:2509.12804v1).",
    "Transcribed to photometry/tables/wargnier_2025_deimos.json (docs/sources/wargnier-2025.md).")

DECOLIBUS_DATA = Download(
    id="decolibus-2026-data",
    url="https://zenodo.org/api/records/18745327/files/VIS_Uranian_Moons_accepted.tar/content", subdir="decolibus2026",
    name="VIS_Uranian_Moons_accepted.tar",
    title="Optical spectra of the large Uranian moons (DeColibus et al. 2026, Zenodo): grand-average disk-integrated "
          "reflectance spectra, TMO B V R photometry",
    citation="DeColibus, R., Cartwright, R., Grundy, W., Buratti, B., Hicks, M. & Mishra, I. (2026). Optical Spectra "
             "of the Large Uranian Moons (v1) [Data set]. Zenodo. DOI:10.5281/zenodo.18745327.",
    version="v1 (2026-03)", license="CC BY 4.0",
    notes="Palomar 200-inch DBSP and Lowell Discovery Telescope DeVeny spectra 2002-2024, 0.35-1.0 um, normalized "
          "to unity at 0.628-0.632 um; the ReadMe recommends scaling to Karkoschka's (2001) HST F631N geometric "
          "albedos. Checked against the md5 Zenodo publishes.")
DECOLIBUS_RECORD = "https://zenodo.org/api/records/18745327"

DECOLIBUS_PAPER = Download(
    id="decolibus-2026",
    url="https://iopscience.iop.org/article/10.3847/PSJ/ae4a1b/pdf", subdir="papers", name="DeColibus2026_PSJ7_67.pdf",
    title="Optical spectroscopy of the Uranian moons (method, TMO photometry, Karkoschka 2001 phase function)",
    citation="DeColibus, R. A., Cartwright, R. J., Grundy, W. M., Buratti, B. J., Hicks, M. D. & Mishra, I. (2026). "
             "Optical spectroscopy of the Uranian moons from equinox to northern summer. The Planetary Science Journal "
             "7, 67. DOI:10.3847/PSJ/ae4a1b.",
    notes="Sec. 2.4: phase function of Karkoschka (2001), transcribed to "
          "photometry/tables/karkoschka_2001_uranian_phase.json.",
    browser_agent=True, sha256="d96a4e0ba8578e7a1d0f7d68a9720734de9fa8f2fe57ac9c8bac788df23ccdb9",
    retrieved="2026-09-30")

VERBISCER = Download(
    id="verbiscer-2022",
    url="https://iopscience.iop.org/article/10.3847/PSJ/ac63a6/pdf", subdir="papers", name="Verbiscer2022_PSJ3_95.pdf",
    title="Sizes, albedos, colours and phase coefficients of Triton and Charon (Tables 2-3)",
    citation="Verbiscer, A. J., Helfenstein, P., Porter, S. B., Benecchi, S. D., Kavelaars, J. J., Lauer, T. R., Peng, "
             "J., Protopapa, S., Spencer, J. R., Stern, S. A., Weaver, H. A., Buie, M. W., Buratti, B. J., Olkin, "
             "C. B., Parker, J., Singer, K. N. & Young, L. A. (2022). The diverse shapes of dwarf planet and large KBO "
             "phase curves observed from New Horizons. The Planetary Science Journal 3, 95. DOI:10.3847/PSJ/ac63a6.",
    notes="Transcribed to photometry/tables/verbiscer_2022.json. Triton's p_V, B-V and phase coefficient are "
          "compiled there from Buratti, B. J. et al. (2011), Icarus 212, 835, DOI:10.1016/j.icarus.2011.01.012 "
          "(Earth-based photometry of Triton 1992-2004).",
    browser_agent=True, sha256="0f3ad0518dd65fbfe8b586c05fc8a3fc5a1008c29ded3c82617a9ed424cf1352",
    retrieved="2026-09-30")

GRAV = _arxiv(
    "grav-2015", "1505.07820v1",
    "Absolute magnitudes, slope parameters, diameters and albedos of the irregular satellites (Tables 1, 3)",
    "Grav, T., Bauer, J. M., Mainzer, A. K., Masiero, J. R., Nugent, C. R., Cutri, R. M., Sonnett, S. & Kramer, E. "
    "(2015). NEOWISE: observations of the irregular satellites of Jupiter and Saturn. Astrophysical Journal 809, 3. "
    "DOI:10.1088/0004-637X/809/1/3 (arXiv:1505.07820v1).",
    "Table 1 H and G (compiled from Luu 1991, Rettig et al. 2001, Grav et al. 2003, Grav & Bauer 2007, Bauer et al. "
    "2006) and Table 3 NEOWISE diameters and albedos, transcribed to photometry/tables/grav_2015_irregulars.json.")

KARKOSCHKA_1994_TEXT = Download(
    id="karkoschka-1994-text",
    url="https://pds-atmospheres.nmsu.edu/PDS/data/gbat_0001/document/icarus94.asc", subdir="karkoschka",
    name="icarus94.asc",
    title="Karkoschka (1994) paper text in PDS volume GBAT_0001 (Table III: disk radii, incl. Titan 2575 km)",
    citation="Karkoschka, E. (1994). Spectrophotometry of the jovian planets and Titan at 300- to 1000-nm "
             "wavelength: the methane spectrum. Icarus 111, 174-192. DOI:10.1006/icar.1994.1139. ASCII text in the "
             "PDS Atmospheres Node volume GBAT_0001, document/icarus94.asc.")


# ---------------------------------------------------------------------------------------------- helpers
def _moon_dict(ctx: BuildContext | None, *dls: Download) -> list[str]:
    return [_src(ctx, d) for d in dls]


def _tab(fn, amax: float, amin: float = 0.0, step: float = 0.5, extra: tuple[float, ...] = ()) -> dict:
    grid = sorted(set(np.round(np.arange(amin, amax + 1e-9, step), 6).tolist()) | {amin, amax} | set(extra))
    return {"kind": "tabulated", "alphaDeg": [float(a) for a in grid],
            "deltaMag": [round(float(fn(a)), 5) for a in grid]}


# ---------------------------------------------------------------------------------------------- Galilean moons
WAC = {"VIO": "cassini.wac.VIO", "GRN": "cassini.wac.GRN", "RED": "cassini.wac.RED", "CB2": "cassini.wac.CB2",
       "CB3": "cassini.wac.CB3"}


@lru_cache(maxsize=None)
def mayorga_polys(naif: int) -> dict[str, tuple[float, ...]]:
    out = {}
    for r in read_table_csv("mayorga_2020_table5.csv"):
        if int(r["naif"]) == naif:
            out[r["filter"]] = tuple(float(r[f"c{i}"]) for i in range(6) if r[f"c{i}"])
    return out


def _poly(c, a):
    return sum(ci * a ** i for i, ci in enumerate(c))


def _filter_spread(naif: int) -> float:
    """Largest |Δm_filter(α) - Δm_GRN(α)| over 0-130° for the VIO and RED normalized curves."""
    polys = mayorga_polys(naif)
    g = polys["GRN"]
    worst = 0.0
    for f in ("VIO", "RED"):
        c = polys[f]
        for a in np.arange(0.0, 130.01, 1.0):
            d = -2.5 * math.log10(_poly(c, a) / c[0]) + 2.5 * math.log10(_poly(g, a) / g[0])
            worst = max(worst, abs(d))
    return worst


def galilean_spectrum(naif: int, ctx: BuildContext | None = None) -> AlbedoSpectrum:
    polys = mayorga_polys(naif)
    bands = {WAC[f]: c[0] for f, c in polys.items()}
    wl, p, nodes = albedo.broadband_reconstruction(bands)
    r = mean_radius(naif)
    sources = [_src(ctx, MAYORGA), *filters.register(ctx, tuple(bands)), _src(ctx, PCK)]
    listing = ", ".join(f"{f} {c[0]:.3f}" for f, c in polys.items())
    ends = {501: "", 502: " Europa has no CB3 (939 nm) fit, so p is held constant beyond 752 nm.",
            503: "", 504: " Callisto has only VIO, GRN and RED fits, so p is held constant beyond 647 nm."}[naif]
    return AlbedoSpectrum(
        naif, wl, p, "estimated", sources,
        f"Reconstructed from spacecraft broadband photometry: the zero-phase terms of Mayorga et al.'s (2020) "
        f"Cassini ISS WAC disk-integrated phase-curve fits (Table 5: {listing}) are the geometric albedos in those "
        f"filters. A piecewise-linear p(λ) with nodes at the filters' solar-weighted effective wavelengths "
        f"({', '.join(f'{n:.0f}' for n in nodes)} nm; photon-counting responses from SVO, which reproduce the paper's "
        f"Table 2 effective wavelengths to 1 nm) is solved so that every band average equals the published albedo, "
        f"and held constant beyond the end nodes (below 420 nm this probably overestimates the blue/violet albedo of "
        f"Io, whose reflectance falls steeply there).{ends} The disk radius is taken to be the pck00011 mean radius "
        f"{r:.1f} km (the paper used SPICE shapes). The fits start at the smallest observed phase angles and do not "
        "resolve a narrow opposition surge.",
        "absolute calibration: CISSCAL 3.9 radiometric correction factors (Knowles 2016), not re-scaled to any "
        "reference spectrum; rotational variation up to 16 % peak to peak (Io, GRN, low phase; paper Sec. 5); shape "
        "between nodes unconstrained",
        notes={"nodes_nm": nodes.tolist(), "band_albedos": {f: c[0] for f, c in polys.items()}})


def galilean_phase(naif: int, ctx: BuildContext | None = None) -> Phase:
    c = mayorga_polys(naif)["GRN"]
    f0 = c[0]
    return Phase(
        _tab(lambda a: -2.5 * math.log10(_poly(c, a) / f0), 130.0),
        "measured", [_src(ctx, MAYORGA)],
        "Mayorga et al. (2020) Table 5 CL1GRN (568 nm) disk-integrated phase curve from Cassini ISS WAC photometry, "
        "f(α)/f(0), tabulated every 0.5° over 0-130° (the paper's stated validity; no data 30-60° and beyond 135°). "
        f"The same curve is applied at all wavelengths (the paper's VIO and RED curves differ from GRN by up to "
        f"{_filter_spread(naif):.2f} mag within 0-130°). Rotational (orbital-longitude) variations, fitted "
        "separately in the paper (Table 4), are not represented: the curve is their longitude average.",
        "rotational variation up to 16 % peak to peak at low phase and 38 % at high phase (Io, GRN; paper Sec. 5)")


# ---------------------------------------------------------------------------------------------- mid-sized Saturnian moons
@lru_cache(maxsize=None)
def filacchione_rows(naif: int) -> dict[str, np.ndarray]:
    rows = [r for r in read_table_csv("filacchione_2022_tables.csv") if int(r["naif"]) == naif]
    return {k: np.array([float(r[c]) for r in rows]) for k, c in
            (("wl", "wavelength_nm"), ("a0", "a0"), ("a0_err", "a0_err"), ("a1", "a1_per_deg"), ("a2", "a2_per_deg2"))}


PHASE_ROW_NM = 549.0  # the tabulated wavelength nearest the V band


def saturnian_spectrum(naif: int, ctx: BuildContext | None = None) -> AlbedoSpectrum:
    t = filacchione_rows(naif)
    return AlbedoSpectrum(
        naif, t["wl"], t["a0"], "derived", [_src(ctx, FILACCHIONE)],
        "Filacchione et al. (2022) Cassini VIMS photometric model: at each of 14 visible wavelengths (350-1010 nm, "
        "~50 nm apart) the Akimov disk function × F(g) = a0 + a1 g + a2 g² was fitted to all VIMS pixels with "
        "i, e ≤ 70°, 10° ≤ g ≤ 120°. Because the Akimov disk function is 1 everywhere at g = 0, a0 is the geometric "
        "albedo of the model, independent of the disk radius; linear interpolation between the tabulated wavelengths "
        "(the icy satellites' visible spectra are smooth). By construction the extrapolation to g = 0 EXCLUDES the "
        "opposition surge (paper Sec. 4); the phase curve adds it (Φ(0) > 1). Integrated per "
        "docs/architecture.md §4.3.",
        f"a0 fit errors ±{np.median(t['a0_err'] / t['a0']) * 100:.0f} % (median); VIMS visible-channel calibration "
        "residuals ('faint peaks'); leading/trailing hemisphere albedo differences of tens of percent (paper Sec. 5) "
        "averaged; the opposition surge (brighter by tens of percent below a few degrees) is excluded here and "
        "carried by the phase function",
        notes={"wavelengths_nm": t["wl"].tolist()})


DEAU = _arxiv(
    "deau-2009", "0902.0345v1",
    "Morphological fits to the opposition phase curves of satellites and rings (Tables 2-3)",
    "Deau, E., Dones, L., Rodriguez, S., Charnoz, S. & Brahic, A. (2009). The opposition effect in the outer Solar "
    "system: a comparative study of the phase function morphology. Planetary and Space Science 57, 1282-1301. "
    "DOI:10.1016/j.pss.2009.05.005 (accepted manuscript arXiv:0902.0345v1).",
    "Linear-exponential fits of Enceladus (Verbiscer et al. 2005, HST, 439 nm) and Rhea (Domingue et al. 1995; "
    "Verbiscer & Veverka 1989, ~500 nm) disk-integrated opposition phase curves transcribed to "
    "photometry/tables/saturnian_opposition.json (docs/sources/deau-2009.md). A 2018 corrigendum (PSS 161, 137) "
    "could not be accessed.")
SURGE_JOIN_DEG = 10.0      # where the VIMS fit (10-120°) starts


@lru_cache(maxsize=None)
def _opposition_tables() -> dict:
    return read_table_json("saturnian_opposition.json")


def opposition_shape(key: str, a: float) -> float:
    """Deau et al.'s linear-exponential fit I = Ib − |Is|·α + Ip·exp(−α/2w) of a measured opposition phase curve."""
    q = _opposition_tables()["deau_2009"]["linear_exponential"][key]
    return q["Ib"] - q["slope_abs"] * a + q["Ip"] * math.exp(-a / (2.0 * q["w_deg"]))


def surge_factor(naif: int, a: float) -> float:
    """R(α)/R(10°): the measured opposition curve relative to its value at the join, own curve for Enceladus and
    Rhea, the mean of the two for Mimas, Tethys and Dione."""
    keys = [str(naif)] if str(naif) in ("602", "605") else ["602", "605"]
    return float(np.mean([opposition_shape(k, a) / opposition_shape(k, SURGE_JOIN_DEG) for k in keys]))


def saturnian_phase(naif: int, ctx: BuildContext | None = None) -> Phase:
    t = filacchione_rows(naif)
    i = int(np.argmin(np.abs(t["wl"] - PHASE_ROW_NM)))
    a0, a1, a2 = float(t["a0"][i]), float(t["a1"][i]), float(t["a2"][i])

    def phi_vims(a):
        return (a0 + a1 * a + a2 * a * a) / a0 * diskint.akimov_integral(a)

    def dm(a):
        if a < SURGE_JOIN_DEG:
            return -2.5 * math.log10(phi_vims(SURGE_JOIN_DEG) * surge_factor(naif, a))
        return -2.5 * math.log10(phi_vims(a))

    own = naif in (602, 605)
    name = {602: "Enceladus", 605: "Rhea"}.get(naif)
    shape = (f"{name}'s own measured opposition curve" if own else
             "the mean of Enceladus's and Rhea's measured opposition curves (assumption: no accessible measured "
             "curve for this moon; Deau et al. find similar surge widths for the Saturnian satellites)")
    phi0 = phi_vims(SURGE_JOIN_DEG) * surge_factor(naif, 0.0)
    pv = filters.band_average("V", t["wl"], t["a0"])
    p_hst = _opposition_tables()["verbiscer_2007"]["geometric_albedo"][str(naif)]
    fn = _tab(dm, 120.0, extra=(0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.6, 0.8, 1.25, 1.75, 2.25, 2.75, 3.5))
    return Phase(
        fn, "estimated", [_src(ctx, FILACCHIONE), _src(ctx, DEAU)],
        f"10-120°: disk integral of Filacchione et al.'s (2022) fitted photometric model at {t['wl'][i]:.0f} nm "
        f"(a0 = {a0}, a1 = {a1} /deg, a2 = {a2} /deg²), Φ(α) = F(α)/a0 · J(α) with J the closed-form disk integral "
        "of the Akimov disk function (pipeline.photometry.diskint; derived from measurements). 0-10°, the "
        "opposition surge: Φ(α) = Φ(10°) · R(α)/R(10°) with R the linear-exponential fit (Deau et al. 2009, "
        f"Table 3) to {shape}; Enceladus's data (Verbiscer et al. 2005, HST) span about 0.25-20°, Rhea's (Domingue "
        "et al. 1995; Verbiscer & Veverka 1989) a similar range. The zero-phase reference is the surge-free VIMS a0 "
        f"used for the albedo, so Φ(0) = {phi0:.3f} > 1. The shape is measured but transferred to the VIMS level "
        "(and, for Mimas, Tethys and Dione, from other moons) — hence 'estimated'. The HST geometric albedo at true "
        f"opposition (Verbiscer et al. 2007, as quoted by Filacchione et al. 2022: {p_hst}) is {p_hst / (pv * phi0):.2f}× "
        f"this curve's p_V·Φ(0) = {pv * phi0:.3f}: the HST and VIMS absolute levels differ at all small phase "
        "angles, not only in the surge (see docs/reports/planet-colors.md).",
        "fit uncertainties of a1, a2 (paper Tables .2-.6); surge shape from the published fit (the fit quality is "
        "shown in Deau et al.'s Fig. 1-2); HST vs VIMS absolute level: the HST value is 1.2-1.4× higher")


# ---------------------------------------------------------------------------------------------- Titan
def titan_spectrum(ctx: BuildContext | None = None) -> AlbedoSpectrum:
    d = np.loadtxt(albedo.KARKOSCHKA.fetch())
    k = read_table_json("karkoschka_disk_radii.json")
    g = read_table_json("garcia_munoz_2017_titan.json")
    r_src, r_ref = k["radius_km"]["606"], mean_radius(606)
    area = (r_src / r_ref) ** 2
    fac = g["zero_phase_factor"]
    return AlbedoSpectrum(
        606, d[:, 1], d[:, 7] * fac * area, "estimated",
        [_src(ctx, albedo.KARKOSCHKA), _src(ctx, KARKOSCHKA_1994_TEXT), _src(ctx, GARCIA_MUNOZ), _src(ctx, PCK)],
        f"Karkoschka (1998) full-disk albedo of Titan at phase {k['phase_angle_deg_1995']['606']}° (PDS 1995LOW.TAB "
        f"column 8, 1995 July, air wavelengths, 1 nm resolution; disk radius {r_src:.0f} km per Karkoschka 1994 "
        f"Table III, = pck00011 radius, factor {area:.4f}), multiplied by {fac} to reach zero phase: the factor "
        "García Muñoz et al. (2017) adopted from their radiative-transfer model of Titan's phase curve (a model "
        "estimate, consistent with ground-based photometry). Titan's haze makes the disk nearly featureless in the "
        "visible; its brightness varies seasonally by a few percent (Karkoschka 1998, 2-year variation). Integrated "
        "per docs/architecture.md §4.3.",
        "±4 % absolute (Karkoschka), ±5 % (García Muñoz et al.); seasonal and rotational changes of a few percent",
        notes={"zero_phase_factor": fac})


def titan_phase(ctx: BuildContext | None = None) -> Phase:
    g = read_table_json("garcia_munoz_2017_titan.json")
    a1, fac = g["from_phase_deg"], g["zero_phase_factor"]
    slope = 2.5 * math.log10(fac) / a1
    return Phase(
        {"kind": "poly-mag", "coeffs": [0.0, round(slope, 6)], "minDeg": 0.0, "maxDeg": a1}, "estimated",
        [_src(ctx, GARCIA_MUNOZ)],
        f"Only the zero-phase correction is available in machine-usable form: García Muñoz et al. (2017) scale the "
        f"{a1}° albedo by {fac} to zero phase (Δm = {2.5 * math.log10(fac):.4f} mag), here spread linearly over "
        f"0-{a1}° (the linear shape is an assumption). Their Cassini ISS disk-integrated phase curves (0-166°, "
        "strongly forward scattering; Titan is brighter at large phase than at small) are published only as figures; "
        f"beyond {a1}° the phase behaviour is left unknown.",
        "±0.02 mag")


# ---------------------------------------------------------------------------------------------- Uranian moons
URANIAN = {701: "Ariel", 702: "Umbriel", 703: "Titania", 704: "Oberon"}


@lru_cache(maxsize=None)
def _decolibus_members() -> dict[str, bytes]:
    path = DECOLIBUS_DATA.fetch()
    meta = json.loads(fetch(DECOLIBUS_RECORD, "decolibus2026", "zenodo-record-18745327.json").read_text())
    want = {f["key"]: f["checksum"] for f in meta["files"]}[DECOLIBUS_DATA.name]
    got = "md5:" + hashlib.md5(path.read_bytes()).hexdigest()
    if got != want:
        raise ValueError(f"{path}: {got} does not match Zenodo's {want}")
    out = {}
    with tarfile.open(path) as tf:
        for m in tf.getmembers():
            if m.isfile() and m.name.endswith((".txt", ".dat", ".csv")):
                out[m.name] = tf.extractfile(m).read()
    return out


def decolibus_file(name: str) -> str:
    return _decolibus_members()[f"FINAL_ASCII/{name}"].decode()


@lru_cache(maxsize=None)
def decolibus_scaling() -> dict[str, float]:
    """The ReadMe's recommended geometric albedos at 0.628-0.632 um (digitized from Karkoschka 2001, Fig. 7)."""
    text = decolibus_file("Uranian_Spectra_ReadMe.dat")
    block = text.split("we suggest scaling the spectra to the following values", 1)[1][:300]
    return {m.group(1): float(m.group(2)) for m in re.finditer(r"(Ariel|Umbriel|Titania|Oberon):\s*([0-9.]+)", block)}


def decolibus_spectrum_raw(name: str, which: str = "All") -> tuple[np.ndarray, np.ndarray]:
    text = decolibus_file(f"spectra/GAvg/{name}_{which}_BothTel_GAvg.txt")
    rows = [ln.split() for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith(("#", "wl"))]
    d = np.array(rows, float)
    return d[:, 0] * 1000.0, d[:, 1]


def uranian_spectrum(naif: int, ctx: BuildContext | None = None) -> AlbedoSpectrum:
    name = URANIAN[naif]
    wl, refl = decolibus_spectrum_raw(name)
    norm = float(np.mean(refl[(wl >= 628.0) & (wl <= 632.2)]))
    p63 = decolibus_scaling()[name]
    r = mean_radius(naif)
    return AlbedoSpectrum(
        naif, wl, refl / norm * p63, "derived",
        [_src(ctx, DECOLIBUS_DATA), _src(ctx, DECOLIBUS_PAPER), _src(ctx, PCK)],
        f"DeColibus et al. (2026) 'All' grand-average disk-integrated reflectance spectrum of {name} (Palomar DBSP + "
        "LDT DeVeny, 2002-2024, all sub-observer longitudes; Zenodo, md5-checked), normalized to unity at "
        f"0.628-0.632 um and scaled to the geometric albedo {p63} there that the dataset's ReadMe recommends (HST "
        "F631N, digitized by the dataset authors from Karkoschka 2001, Fig. 7; surge-inclusive). Wavelengths taken as "
        f"given; the disk radius is taken to be the pck00011 mean radius {r:.1f} km (Thomas 1988, as in the paper). "
        "Integrated per docs/architecture.md §4.3 (1 nm bin averages smooth the spectral noise).",
        "albedo level ±~5 % (digitized from a figure; TMO photometry in the same dataset gives 2-4 % lower R-band "
        "albedos for Titania and Oberon); spectral slopes trusted only over 0.4-0.9 um (ReadMe); leading/trailing "
        "hemisphere differences of ~0.15-0.2 mag in V for Oberon (paper Sec. 3.1) averaged",
        notes={"p_0.63um": p63})


def uranian_phase(naif: int, ctx: BuildContext | None = None) -> Phase:
    k = read_table_json("karkoschka_2001_uranian_phase.json")
    a0, beta, amax = k["alpha0_deg"], k["beta_mag_per_deg"], k["earth_phase_limit_deg"]

    def dm(a):
        return beta * a + 0.5 * a / (a0 + a)

    grid = sorted(set(np.round(np.arange(0.0, 1.0, 0.05), 3).tolist()) | set(np.round(np.arange(1.0, amax + 1e-9, 0.1),
                                                                                      3).tolist()) | {amax})
    fn = {"kind": "tabulated", "alphaDeg": [float(a) for a in grid], "deltaMag": [round(dm(a), 5) for a in grid]}
    measured = str(naif) in k["applies_to"]
    what = (f"Karkoschka's (2001) HST phase function for Titania and Oberon, Δm = {beta}α + 0.5α/({a0} + α) (α in "
            "degrees), as quoted and applied by DeColibus et al. (2026, Sec. 2.4)")
    return Phase(
        fn, "measured" if measured else "estimated", [_src(ctx, DECOLIBUS_PAPER)],
        (what if measured else what + f"; ASSUMED to hold for {URANIAN[naif]} as well (Karkoschka's parameters for "
                                      f"{URANIAN[naif]} were not available)")
        + f". The strong, narrow opposition surge (0.4 mag between 0° and 1.5°) is part of the curve. Tabulated to "
          f"{amax}°, the largest phase angle seen from Earth; larger phase angles (Voyager 2 only) are unknown here.",
        "not stated by the sources")


# ---------------------------------------------------------------------------------------------- B/V reconstructions
def _bv_linear(p_b: float, p_v: float) -> tuple[np.ndarray, np.ndarray, float, float]:
    wl = np.arange(300.0, 1101.0, 1.0)
    m = np.array([[filters.band_average(bd, wl, np.ones_like(wl)), filters.band_average(bd, wl, wl - 550.0)]
                  for bd in ("B", "V")])
    a, b = np.linalg.solve(m, np.array([p_b, p_v]))
    return wl, a + b * (wl - 550.0), a, b


def triton_spectrum(ctx: BuildContext | None = None) -> AlbedoSpectrum:
    t = read_table_json("verbiscer_2022.json")["table2"]["801"]
    r_src, r_ref = t["diameter_km"] / 2.0, mean_radius(801)
    area = (r_src / r_ref) ** 2
    p_v = t["p_V"] * area
    bv_sun = sun_mag("B") - sun_mag("V")
    p_b = p_v * 10 ** (-0.4 * (t["B_minus_V"] - bv_sun))
    wl, p, a, b = _bv_linear(p_b, p_v)
    return AlbedoSpectrum(
        801, wl, p, "estimated", [_src(ctx, VERBISCER), _src(ctx, albedo.WILLMER), *filters.register(ctx, ("B", "V")),
                                  _src(ctx, PCK)],
        f"Reconstructed from broadband photometry only: p_V = {t['p_V']} ± {t['p_V_err']} and B-V = {t['B_minus_V']} "
        f"(Verbiscer et al. 2022 Table 2, from Buratti et al. 2011 and Cruikshank et al. 1993; diameter "
        f"{t['diameter_km']} km, rescaled to the pck00011 radius {r_ref:.1f} km, ×{area:.4f}), solar B-V = "
        f"{bv_sun:.2f} (Willmer 2018) give p_B = {p_b:.3f}. ASSUMED spectral shape: p linear in wavelength, fixed by "
        f"the Bessell B and V band averages (p = {a:.4f} + {b:.3e}·(λ - 550 nm)), extrapolated to 360-830 nm. "
        f"(Table 2's V-R = {t['V_minus_R']} is not used: its photometric system is not stated.)",
        f"p_V ±{t['p_V_err'] / t['p_V'] * 100:.1f} % as tabulated; colour only constrained by B-V; red end is an "
        "extrapolation",
        p_v_label="derived",
        p_v_method=f"Verbiscer et al. (2022) Table 2 p_V = {t['p_V']} (Buratti et al. 2011), referenced to R = "
                   f"{r_ref:.1f} km; equal by construction to the Bessell V band average of the reconstruction.",
        notes={"p_B": p_b, "p_V": p_v})


def charon_values() -> dict:
    t = read_table_json("buie_2010a_pluto.json")
    ch = t["charon"]
    geo = 5.0 * math.log10(t["mean_opposition_r_au"] * t["mean_opposition_delta_au"])
    v10 = ch["V_a0_1deg"] + ch["V_to_zero_phase"] - geo
    r = mean_radius(901)
    p_v = 10 ** (-0.4 * (v10 - sun_mag("V"))) / (r / AU_KM) ** 2
    bv = ch["B_minus_V_weighted_mean"]
    p_b = p_v * 10 ** (-0.4 * (bv - (sun_mag("B") - sun_mag("V"))))
    return {"V10": v10, "p_V": p_v, "p_B": p_b, "B_minus_V": bv, "radius": r}


def charon_spectrum(ctx: BuildContext | None = None) -> AlbedoSpectrum:
    v = charon_values()
    ch = read_table_json("buie_2010a_pluto.json")["charon"]
    wl, p, a, b = _bv_linear(v["p_B"], v["p_V"])
    return AlbedoSpectrum(
        901, wl, p, "estimated", [_src(ctx, phase.BUIE), _src(ctx, albedo.WILLMER), *filters.register(ctx, ("B", "V")),
                                  _src(ctx, PCK)],
        f"Reconstructed from broadband photometry only: Charon V(1,0) = {v['V10']:.3f} (Buie et al. 2010 Table 12 "
        f"mean V {ch['V_a0_1deg']} at 1° and mean opposition distance, minus {-ch['V_to_zero_phase']} mag to zero "
        f"phase from their Hapke fit) and B-V = {v['B_minus_V']} (Table 10 weighted mean), with solar V = "
        f"{sun_mag('V')}, B = {sun_mag('B')} (Willmer 2018) and the pck00011 radius {v['radius']:.1f} km, give p_V = "
        f"{v['p_V']:.3f}, p_B = {v['p_B']:.3f}. ASSUMED spectral shape: p linear in wavelength fixed by the Bessell "
        f"B and V band averages (p = {a:.4f} + {b:.3e}·(λ - 550 nm)). Charon's spectrum is nearly neutral (water "
        "ice), so the extrapolation is milder than Pluto's.",
        "p_V ±~5 % (the 0.25 mag zero-phase step rests on a narrow Hapke surge fitted to α ≥ 0.36°); Verbiscer et al. "
        "(2022) Table 2 lists p_V = 0.41 (Stern et al. 2015), 20 % lower, which corresponds to a smaller surge; "
        "colour only constrained by B-V",
        p_v_label="derived",
        p_v_method=f"From Buie et al. (2010): V(1,0) = {v['V10']:.3f}, V_sun = {sun_mag('V')} (Willmer 2018), R = "
                   f"{v['radius']:.1f} km (pck00011): p_V = 10^(-0.4 (V(1,0) - V_sun)) / (R/AU)². Equal by "
                   "construction to the Bessell V band average of the reconstruction.",
        notes=v)


def triton_phase(ctx: BuildContext | None = None) -> Phase:
    t = read_table_json("verbiscer_2022.json")["table3"]["801"]
    lo, hi = t["phase_range_deg"]
    return Phase(
        {"kind": "poly-mag", "coeffs": [0.0, t["beta_V_mag_per_deg"]], "minDeg": 0.0, "maxDeg": hi}, "measured",
        [_src(ctx, VERBISCER)],
        f"Linear V phase coefficient β = {t['beta_V_mag_per_deg']} ± {t['beta_err']} mag/deg from Earth-based "
        f"photometry {t['dates']} over {lo}-{hi}° (Buratti et al. 2011, as tabulated by Verbiscer et al. 2022 Table 3; "
        "Triton's very narrow coherent-backscatter spike below ~0.01° is not represented). Larger phase angles "
        "(Voyager 2, New Horizons) are covered only by the Hapke model of Verbiscer et al. (2022), which is not "
        "evaluated here: unknown beyond "
        f"{hi}°. The zero-phase reference is the published p_V.",
        f"±{t['beta_err']} mag/deg")


def charon_phase(ctx: BuildContext | None = None) -> Phase:
    t = read_table_json("buie_2010a_pluto.json")
    hp = t["hapke_table9"]["901"]["V"]
    lo, hi = t["charon"]["phase_range_deg"]

    def dm(a):
        return diskint.hapke1986_delta_mag(hp["w"], hp["P"], hp["B0"], hp["h"], a)

    grid = sorted(set(np.round(np.arange(0.0, 0.3, 0.02), 3).tolist()) | set(np.round(np.arange(0.3, hi + 1e-9, 0.1),
                                                                                       3).tolist()) | {hi})
    fn = {"kind": "tabulated", "alphaDeg": [float(a) for a in grid], "deltaMag": [round(dm(a), 5) for a in grid]}
    return Phase(
        fn, "derived", [_src(ctx, phase.BUIE)],
        f"Buie et al. (2010) global Hapke fit to Charon's HST V photometry (Table 9: w = {hp['w']}, P = {hp['P']}, "
        f"B0 = {hp['B0']}, h = {hp['h']}), integrated over the disk (pipeline.photometry.diskint; Hapke 1986 without "
        f"the roughness term, which is nearly phase-independent at these angles) and tabulated over 0-{hi}°. The "
        f"integral reproduces the paper's own 1°→0° correction (0.2549 mag) to 0.002 mag. Data cover {lo}-{hi}°; "
        f"0-{lo}° is the Hapke model's opposition surge (the same extrapolation that sets p_V). Beyond {hi}° unknown "
        "(New Horizons phase curves are available only as a Hapke model not evaluated here).",
        "±0.01 mag within the observed range")


# ---------------------------------------------------------------------------------------------- Mars' moons
HRSC = {"Blue": "hrsc.Blue", "Green": "hrsc.Green", "Red": "hrsc.Red", "NIR": "hrsc.NIR"}


def phobos_spectrum(ctx: BuildContext | None = None) -> AlbedoSpectrum:
    t = read_table_json("fornasier_2024_phobos.json")
    bands = {HRSC[k]: v for k, v in t["hapke_geometric_albedo"].items()}
    wl, p, nodes = albedo.broadband_reconstruction(bands)
    return AlbedoSpectrum(
        401, wl, p, "estimated", [_src(ctx, FORNASIER), *filters.register(ctx, tuple(bands))],
        "Reconstructed from spacecraft broadband photometry: Fornasier et al.'s (2024) disk-integrated Hapke-model "
        f"geometric albedos of Phobos in the four Mars Express HRSC colour channels (Table 1: "
        f"{', '.join(f'{k} {v}' for k, v in t['hapke_geometric_albedo'].items())}; opposition-surge inclusive, "
        "with the surge measured by the SRC channel) are matched exactly by a piecewise-linear p(λ) with nodes at the "
        f"channels' solar-weighted effective wavelengths ({', '.join(f'{n:.0f}' for n in nodes)} nm; photon-counting "
        "responses from SVO) and constant below the Blue node. A Hapke geometric albedo is a surface property "
        "(independent of the radius), applied here to the pck00011 mean radius of this irregular body.",
        "Hapke-model albedos: fit and calibration a few percent; Phobos' red and blue units differ by tens of percent "
        "(the 'blue unit' up to 65 % brighter, paper Sec. 5); irregular shape: brightness varies with viewing "
        "geometry beyond what a sphere of the mean radius gives",
        notes={"nodes_nm": nodes.tolist()})


def hg_delta_mag(alpha_deg: float, g: float) -> float:
    """IAU H-G system (Bowell et al. 1989): V(α) - H = -2.5 log10[(1-G) Φ1 + G Φ2], Φi = exp(-Ai tan(α/2)^Bi)."""
    t = math.tan(math.radians(alpha_deg) / 2.0)
    phi1 = math.exp(-3.33 * t ** 0.63)
    phi2 = math.exp(-1.87 * t ** 1.22)
    return -2.5 * math.log10((1.0 - g) * phi1 + g * phi2)


def phobos_phase(ctx: BuildContext | None = None) -> Phase:
    t = read_table_json("fornasier_2024_phobos.json")
    gr = t["hg"]["Green"]
    lo, hi = t["hrsc_phase_range_deg"]
    return Phase(
        _tab(lambda a: hg_delta_mag(a, gr["G"]), float(hi)), "measured", [_src(ctx, FORNASIER)],
        f"IAU H-G phase function (Bowell et al. 1989) with G = {gr['G']} fitted by Fornasier et al. (2024, Table 2) to "
        f"Phobos' disk-integrated HRSC green-channel ({gr['lambda_c_nm']} nm) reduced magnitudes (G = 0.024-0.029 in "
        f"the four channels). Their colour data cover mostly {lo}-{hi}°; tabulated over 0-{hi}°. The H-G shape "
        "near opposition is milder than the SRC-measured Hapke surge (B0 = 2.28, h = 0.057).",
        "not stated (G is given without an error bar)")


def deimos_spectrum(ctx: BuildContext | None = None) -> AlbedoSpectrum:
    t = read_table_json("wargnier_2025_deimos.json")["src_panchromatic"]
    wl = np.array([300.0, 1100.0])
    return AlbedoSpectrum(
        402, wl, np.full(2, t["A_p"]), "estimated", [_src(ctx, WARGNIER)],
        f"Only a panchromatic value exists: Deimos' geometric albedo A_p = {t['A_p']} ± {t['A_p_err']} from Wargnier et "
        "al.'s (2025) disk-integrated Hapke fit to Mars Express SRC data (Table 4, H2012-1THG; opposition-surge "
        "inclusive). ASSUMED grey: p(λ) = A_p at all wavelengths, so the colour is a placeholder, not a measurement "
        "(Deimos is known to be reddish, like Phobos, but no disk-integrated colour was available in machine-usable "
        "form).",
        f"±{t['A_p_err']} (fit) plus the SRC absolute calibration (±8 %, paper Eq. 13); colour unmeasured",
        notes={"A_p": t["A_p"]})


# ---------------------------------------------------------------------------------------------- irregulars
def irregular_spectrum(naif: int, ctx: BuildContext | None = None) -> AlbedoSpectrum:
    s = read_table_json("grav_2015_irregulars.json")["satellites"][str(naif)]
    r = mean_radius(naif)
    p_v = 10 ** (-0.4 * (s["H"] - sun_mag("V"))) / (r / AU_KM) ** 2
    wl = np.array([300.0, 1100.0])
    return AlbedoSpectrum(
        naif, wl, np.full(2, p_v), "estimated", [_src(ctx, GRAV), _src(ctx, albedo.WILLMER), _src(ctx, PCK)],
        f"Brightness only: the V absolute magnitude H = {s['H']} ± {s['H_err']} compiled by Grav et al. (2015, Table 1) "
        f"with V_sun = {sun_mag('V')} (Willmer 2018) and the pck00011 radius {r:.1f} km gives p = {p_v:.4f}. ASSUMED "
        "grey: p(λ) is that value at all wavelengths, so the colour is a placeholder (these irregular satellites are "
        "grey to reddish; their measured broadband colours were not available in machine-usable form). NEOWISE "
        f"measured D = {s['D_km']} ± {s['D_err']} km and p_V = {s['pV_pct'] / 100:.3f} (Table 3): same brightness, "
        "different size; the pck radius is kept so that R here matches bodies.json.",
        f"H ±{s['H_err']} mag; the pck00011 radius is a rough value for this body (NEOWISE diameter {s['D_km']} km); "
        "rotational lightcurves of ~0.2 mag (Himalia, Phoebe) not represented",
        p_v_label="derived",
        p_v_method=f"From H = {s['H']} (Grav et al. 2015 Table 1), V_sun = {sun_mag('V')} and R = {r:.1f} km (pck00011): "
                   "p_V = 10^(-0.4 (H - V_sun)) / (R/AU)². Referenced to the pck radius, not to the NEOWISE diameter "
                   f"(for which the same H gives p_V = {s['pV_pct'] / 100:.3f}).",
        notes={"H": s["H"], "p_V": p_v})


def irregular_phase(naif: int, ctx: BuildContext | None = None) -> Phase:
    t = read_table_json("grav_2015_irregulars.json")
    s = t["satellites"][str(naif)]
    amax = t["earth_phase_limit_deg"][str(naif)[0]]
    how = ("the value the authors ASSUMED for all Jovian irregulars" if s["G_assumed"] else
           "as compiled from the literature (Table 1)")
    return Phase(
        _tab(lambda a: hg_delta_mag(a, s["G"]), amax, step=0.25), "estimated", [_src(ctx, GRAV)],
        f"IAU H-G phase function (Bowell et al. 1989) with G = {s['G']} ± {s['G_err']}, {how}; it is the function "
        f"that defines H. Tabulated over 0-{amax}°, the phase range seen from Earth; unknown beyond.",
        f"G ±{s['G_err']}")


# ---------------------------------------------------------------------------------------------- dispatch
UNKNOWN_SPECTRUM = {
    608: Unknown(
        "Iapetus' disk-integrated brightness depends strongly on which hemisphere is in view: its leading hemisphere "
        "is coated with dark material and its trailing hemisphere is bright, so the disk-integrated brightness varies "
        "strongly with orbital longitude. No machine-readable orbital-longitude lightcurve or disk-integrated spectrum "
        "was accessible to this pipeline (e.g. Millis 1977, Icarus 31, 81; Squyres et al. 1984, Icarus 59, 426; "
        "Buratti & Mosher 1995, Icarus 115, 219; Cassini VIMS leading/trailing phase curves, Icarus 209, 738, 2010, "
        "are not openly accessible here; a further search in M3 of arXiv and of VizieR, whose Iapetus tables are "
        "astrometric only, found none; Deau et al. 2009 give only fit parameters of a trailing-side opposition curve), "
        "and a single albedo would misrepresent it, so albedo and colour are left unknown."),
    705: Unknown(
        "No disk-integrated photometry of Miranda was accessible to this pipeline in machine-usable form (Karkoschka "
        "2001, Icarus 151, 51, and the Voyager 2 photometry are not openly accessible; the DeColibus et al. 2026 "
        "spectra cover only the four large moons)."),
}
UNKNOWN_PHASE = {
    402: Unknown("Wargnier et al. (2025) describe Deimos' phase curve only by Hapke 2012 parameters (with porosity "
                 "and roughness), which this pipeline does not evaluate; no tabulated phase curve was available."),
    608: Unknown("No accessible disk-integrated phase curve; Iapetus' brightness is dominated by its orbital-longitude "
                 "(hemispheric) variation."),
    705: Unknown("No accessible disk-integrated phase curve of Miranda."),
}


def spectrum_for(naif: int, ctx: BuildContext | None = None) -> AlbedoSpectrum | Unknown:
    if naif in UNKNOWN_SPECTRUM:
        return UNKNOWN_SPECTRUM[naif]
    if naif in (501, 502, 503, 504):
        return galilean_spectrum(naif, ctx)
    if naif in (601, 602, 603, 604, 605):
        return saturnian_spectrum(naif, ctx)
    if naif == 606:
        return titan_spectrum(ctx)
    if naif in URANIAN:
        return uranian_spectrum(naif, ctx)
    if naif == 801:
        return triton_spectrum(ctx)
    if naif == 901:
        return charon_spectrum(ctx)
    if naif == 401:
        return phobos_spectrum(ctx)
    if naif == 402:
        return deimos_spectrum(ctx)
    if naif in IRREGULAR:
        return irregular_spectrum(naif, ctx)
    raise KeyError(naif)


def phase_for(naif: int, ctx: BuildContext | None = None) -> Phase | Unknown:
    if naif in UNKNOWN_PHASE:
        return UNKNOWN_PHASE[naif]
    if naif in (501, 502, 503, 504):
        return galilean_phase(naif, ctx)
    if naif in (601, 602, 603, 604, 605):
        return saturnian_phase(naif, ctx)
    if naif == 606:
        return titan_phase(ctx)
    if naif in URANIAN:
        return uranian_phase(naif, ctx)
    if naif == 801:
        return triton_phase(ctx)
    if naif == 901:
        return charon_phase(ctx)
    if naif == 401:
        return phobos_phase(ctx)
    if naif in IRREGULAR:
        return irregular_phase(naif, ctx)
    raise KeyError(naif)
