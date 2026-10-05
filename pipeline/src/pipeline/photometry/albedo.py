"""Geometric-albedo spectra p(λ) per body, each with provenance.

Every spectrum is returned referenced to the body's own "source" disk area (whatever radius the source used to turn
flux into albedo) plus the factor that re-references it to the pck00011 volumetric mean radius used everywhere in
photometry.json (flux ∝ p·R², so p_ref = p_src·(R_src/R_ref)²).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from functools import lru_cache

import numpy as np

from ..schema import BuildContext, Label
from .common import AU_KM, Download, read_table_csv, read_table_json
from . import filters, phase

# ---------------------------------------------------------------------------------------------- datasets
KARKOSCHKA = Download(
    id="karkoschka-1998-pds",
    url="https://raw.githubusercontent.com/OrbitalCommons/starfield/"
        "c9fb9df048e6e275e4f0b3e19e631762474b2f3c/crates/surfaces/data/planet-spectra/1995low.tab", subdir="karkoschka",
    name="1995low.tab",
    title="Full-disk albedo spectra of Jupiter, Saturn, Uranus, Neptune and Titan, 300-1050 nm, July 1995 "
          "(PDS ESO-J/S/N/U-SPECTROPHOTOMETER-4-V2.0, file 1995LOW.TAB)",
    citation="Karkoschka, E. (1998). Methane, ammonia, and temperature measurements of the jovian planets and Titan "
             "from CCD-spectrophotometry. Icarus 133, 134-146. DOI:10.1006/icar.1998.5913. Data: Karkoschka, E., "
             "ESO-J/S/N/U-SPECTROPHOTOMETER-4-V2.0, NASA Planetary Data System Atmospheres Node, volume GBAT_0001, "
             "DOI:10.17189/2bp8-k793. Method: Karkoschka, E. (1994), Icarus 111, 174-192, "
             "DOI:10.1006/icar.1994.1139.",
    version="PDS3 GBAT_0001 (1999-02-18), product 1995LOW.TAB created 1998-12-17",
    notes="Retrieved from the Starfield redistribution of PDS GBAT_0001 product 1995LOW.TAB, pinned to commit "
          "c9fb9df048e6e275e4f0b3e19e631762474b2f3c because the NMSU archive resets connections. The accompanying "
          "PDS label identifies the same V2.0 product: 1875 fixed-length records of 54 bytes. Original URL: "
          "https://pds-atmospheres.nmsu.edu/PDS/data/gbat_0001/data/1995low.tab. "
          "ESO 1.52 m + Boller & Chivens spectrograph, 1995 July 6-10; 1 nm resolution sampled every 0.4 nm; air and "
          "vacuum wavelength columns (air used). Jupiter: full-disk albedo at phase 6.8°; Saturn: full-disk albedo "
          "at 5.7° for zero ring tilt (rings edge-on; the 3 % of the disk they hid was filled in); Uranus and "
          "Neptune: geometric albedo (phase 0.7° and 0.3°). Absolute calibration 4 % (relative 2 %), with an "
          "assumed solar V = -26.74 and solar analog HD 105590.",
)

PAYNE_BASE = "https://zenodo.org/api/records/17470005/files/{name}/content"
PAYNE_CITATION = ("Payne, A., Villanueva, G. L., Kofman, V., Fauchez, T. J., Faggi, S., Mandell, A. M., Roberge, A. & "
                  "Alei, E. (2026). A comprehensive spectroscopic reference of the solar system and its application "
                  "to exoplanet direct imaging. The Planetary Science Journal 7, 51. DOI:10.3847/PSJ/ae2feb. "
                  "Supplementary data: Zenodo, DOI:10.5281/zenodo.17470005 (2025-10-29).")


def _payne(body: str, what: str) -> Download:
    return Download(
        id=f"payne-2026-{body}",
        url=PAYNE_BASE.format(name=f"{body}_albedo.csv"), subdir="payne2026", name=f"{body}_albedo.csv",
        title=f"Composite geometric albedo spectrum of {body.capitalize()} (Payne et al. 2026, Zenodo)",
        citation=PAYNE_CITATION, license="CC BY 4.0", version="Zenodo record 17470005",
        notes=what,
    )


PAYNE = {
    199: _payne("mercury", "360-830 nm segment: MESSENGER/MASCS global mean reflectance spectrum (Izenberg et al. "
                           "2014, Icarus 228, 364), a spatially resolved photometrically standardized reflectance, "
                           "multiplied by an empirical factor 2 to match the broadband geometric albedos of Mallama "
                           "et al. (2017). Payne et al. Sec. 3, Table 1."),
    299: _payne("venus", "360-830 nm segment: MESSENGER/MASCS VIRS I/F of the equatorial region from the second "
                         "Venus flyby (Pérez-Hoyos et al. 2018, JGR Planets 123, 145; a NEMESIS best fit, smoothed), "
                         "multiplied by 1.13 to match Venus's V geometric albedo 0.689 (Mallama et al. 2017). Payne "
                         "et al. Sec. 4, Table 2."),
    399: _payne("earth", "Whole segment: Planetary Spectrum Generator simulation of the full disk driven by MERRA-2 "
                         "reanalysis and MODIS surface types for 2022 June 21 (24 h average of 9 time steps; Kofman "
                         "et al. 2024), validated against DSCOVR/EPIC narrow-band disk-integrated albedos of the same "
                         "day. Payne et al. Sec. 5, Table 3."),
}

PCK = Download(
    id="naif-pck00011",
    url="https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc", subdir="naif", name="pck00011.tpc",
    title="NAIF generic text PCK pck00011.tpc (IAU WGCCRE 2015 body shapes and rotation)",
    citation="Acton, C. H. (1996). Ancillary data services of NASA's Navigation and Ancillary Information Facility. "
             "Planetary and Space Science 44, 65-70. Kernel content: Archinal, B. A. et al. (2018). Report of the "
             "IAU Working Group on Cartographic Coordinates and Rotational Elements: 2015. Celestial Mechanics and "
             "Dynamical Astronomy 130, 22. DOI:10.1007/s10569-017-9805-5.",
    version="pck00011",
)

WILLMER = Download(
    id="willmer-2018",
    url="https://arxiv.org/pdf/1804.07788v1", subdir="papers", name="arXiv-1804.07788v1.pdf",
    title="Apparent magnitudes of the Sun in the Johnson B and V filters (Table 3)",
    citation="Willmer, C. N. A. (2018). The absolute magnitude of the Sun in several filters. Astrophysical Journal "
             "Supplement Series 236, 47. DOI:10.3847/1538-4365/aabfdf.",
    notes="V_sun = -26.76, B_sun = -26.13 (Vega system), transcribed to photometry/tables/willmer_2018_sun.json. "
          "Used to convert between magnitudes and albedos (Pluto; V(1,0) consistency checks).",
)


@lru_cache(maxsize=1)
def pck_radii() -> dict[int, tuple[float, float, float]]:
    """BODYnnn_RADII from the data sections of pck00011.tpc."""
    import re
    text = PCK.fetch().read_text(encoding="utf-8")
    data = "".join(re.findall(r"\\begindata(.*?)(?:\\begintext|\Z)", text, flags=re.S))
    out = {}
    for m in re.finditer(r"BODY(\d+)_RADII\s*=\s*\(([^)]*)\)", data):
        vals = [float(v.replace("D", "E")) for v in m.group(2).split()]
        out[int(m.group(1))] = tuple(vals)
    return out


def mean_radius(naif: int) -> float:
    a, b, c = pck_radii()[naif]
    return (a * b * c) ** (1.0 / 3.0)


def sun_mag(band: str) -> float:
    return float(read_table_json("willmer_2018_sun.json")["apparent_mag_vega"][band])


# ---------------------------------------------------------------------------------------------- spectra
@dataclass
class AlbedoSpectrum:
    naif: int
    wl: np.ndarray                  # nm (air where the source distinguishes)
    p: np.ndarray                   # geometric albedo at zero phase, referenced to the pck volumetric mean radius
    label: Label
    sources: list[str]
    method: str
    uncertainty: str
    p_v_label: Label | None = None      # when p_V is better grounded than the spectral shape (default: same label)
    p_v_method: str | None = None
    notes: dict = field(default_factory=dict)


def _karkoschka_table() -> dict[str, np.ndarray]:
    d = np.loadtxt(KARKOSCHKA.fetch())
    return {"vac": d[:, 0], "air": d[:, 1], "599": d[:, 3], "699": d[:, 4], "799": d[:, 5], "899": d[:, 6]}


def _src(ctx: BuildContext | None, dl: Download) -> str:
    return dl.register(ctx) if ctx else dl.id


def karkoschka(naif: int, ctx: BuildContext | None = None) -> AlbedoSpectrum:
    t = _karkoschka_table()
    k = read_table_json("karkoschka_disk_radii.json")
    r_ref = mean_radius(naif)
    if naif == 699:
        a = k["saturn_equatorial_km"]
        r_src = math.sqrt(a * a * (1.0 - k["saturn_oblateness"]))
    else:
        r_src = k["radius_km"][str(naif)]
    area = (r_src / r_ref) ** 2
    alpha = k["phase_angle_deg_1995"][str(naif)]
    p = t[str(naif)] * area
    sources = [_src(ctx, KARKOSCHKA), _src(ctx, PCK)]
    notes = {"source_radius_km": r_src, "ref_radius_km": r_ref, "area_factor": area, "phase_deg": alpha}
    common = (f"Karkoschka (1998) 1995 July ESO spectrophotometry (PDS 1995LOW.TAB, air wavelengths, 1 nm "
              f"resolution), rescaled from his equal-area disk radius {r_src:.0f} km to the pck00011 volumetric mean "
              f"radius {r_ref:.0f} km (×{area:.4f}).")
    unc = ("absolute calibration ±4 % (Karkoschka 1994/1998); the 1995 epoch is assumed to represent the present")
    if naif in (599, 699):
        dm = phase.mh_reduced_mag(naif, alpha) - phase.mh_reduced_mag(naif, 0.0)
        corr = 10 ** (0.4 * dm)
        p = p * corr
        sources.append(_src(ctx, phase.APMAG_CODE))
        notes["phase_correction"] = corr
        what = "full-disk albedo of Jupiter" if naif == 599 else "full-disk albedo of Saturn's globe (rings edge-on)"
        return AlbedoSpectrum(
            naif, t["air"], p, "estimated", sources,
            f"{common} The source is the {what} at phase {alpha}°; it is scaled to zero phase by ×{corr:.4f}, the "
            f"Mallama & Hilton (2018) V-band phase law ({'Eq. 8' if naif == 599 else 'Eq. 11'}) evaluated at "
            f"{alpha}°, assuming the same small-angle phase dependence at all wavelengths (Karkoschka estimated "
            f"'some 5 percent'). Integrated per docs/architecture.md §4.3.",
            unc + ("; Jupiter's belts vary by a few percent" if naif == 599 else
                   "; Saturn's globe brightness varies with season and ring shadow (not included)"),
            notes=notes)
    return AlbedoSpectrum(
        naif, t["air"], p, "derived", sources,
        f"{common} Geometric albedo as published (observed at phase {alpha}°, taken as zero phase). Integrated per "
        f"docs/architecture.md §4.3.",
        unc + ("; Uranus's disk-integrated brightness varies with season, more in the red/near-IR than in V "
               "(Schmude et al. 2015; Irwin et al. 2024); Mallama & Hilton's V term -8.4e-4·φ′ alone spans 0.07 "
               "mag. 1995 viewed the southern hemisphere, the 2026 view is of the northern"
               if naif == 799 else
               "; Neptune has brightened since 1995 (V1(0) -6.97 in 1995 vs -7.00 after 2000, Mallama & Hilton "
               "2018 Eq. 16)"),
        notes=notes)


PAYNE_RECORD = "https://zenodo.org/api/records/17470005"


def _check_zenodo_md5(dl: Download) -> None:
    """Compare the downloaded file with the md5 Zenodo publishes for it."""
    import hashlib
    import json
    from ..download import fetch
    meta = json.loads(fetch(PAYNE_RECORD, "payne2026", "zenodo-record-17470005.json").read_text(encoding="utf-8"))
    want = {f["key"]: f["checksum"] for f in meta["files"]}[dl.name]
    got = "md5:" + hashlib.md5(dl.fetch().read_bytes()).hexdigest()
    if got != want:
        raise ValueError(f"{dl.name}: {got} does not match Zenodo's {want}")


def payne(naif: int, ctx: BuildContext | None = None) -> AlbedoSpectrum:
    dl = PAYNE[naif]
    _check_zenodo_md5(dl)
    d = np.loadtxt(dl.fetch(), delimiter=",", skiprows=1)
    wl, p = d[:, 0] * 1000.0, d[:, 1]
    order = np.argsort(wl)
    wl, p = wl[order], p[order]
    sources = [_src(ctx, dl), _src(ctx, PCK)]
    what = {
        199: ("Mercury", "The spectral shape is a spatially resolved, photometrically standardized MESSENGER/MASCS "
                         "global mean (not a zero-phase disk integral; phase reddening is not removed); the absolute "
                         "level is set by an empirical factor to Mallama et al. (2017) broadband geometric albedos "
                         "(opposition-surge inclusive).",
              "shape: MASCS calibration and phase reddening; level: Mallama et al. 2017 p_V = 0.142 ± ~3 %"),
        299: ("Venus", "The spectral shape is the MESSENGER/VIRS I/F of the equatorial clouds (not a disk integral; "
                       "limb darkening and UV-absorber contrast differ over the disk), scaled by 1.13 to Venus's "
                       "V geometric albedo 0.689 (Mallama et al. 2017). Below ~480 nm this is lower than "
                       "ground-based disk-integrated albedos (Irvine 1968, Barker 1975; Payne et al. Fig. 3), so the "
                       "blue end and hence Venus's hue are uncertain.",
              "tens of percent below 480 nm (spread between datasets in Payne et al. Fig. 3), a few percent at V"),
        399: ("Earth", "This is a radiative-transfer MODEL of one day's disk (2022 June 21, MERRA-2 clouds), "
                       "validated against DSCOVR/EPIC narrow bands; Earth's real disk-integrated albedo varies with "
                       "clouds, season and the hemisphere in view by tens of percent. No machine-readable measured "
                       "zero-phase visible spectrum of the whole Earth was available to this pipeline (the calibrated "
                       "DSCOVR/EPIC L1B granules are in NASA Earthdata Cloud and require an Earthdata Login).",
              "tens of percent (cloud cover); in the blue the model lies up to ~10 % above the EPIC points "
              "(Payne et al. Fig. 4)"),
    }[naif]
    return AlbedoSpectrum(
        naif, wl, p, "estimated", sources,
        f"Composite geometric-albedo spectrum of {what[0]} from Payne et al. (2026) (Zenodo CSV, wavelength taken as "
        f"air; the ≤0.2 nm vacuum/air ambiguity is negligible for these smooth spectra), referenced to the pck00011 "
        f"mean radius (the source does not state its disk radius; flattening ≤ 0.6 % makes the choice ≤ 1.2 % in "
        f"p). {what[1]} Integrated per docs/architecture.md §4.3.",
        what[2])


def moon(ctx: BuildContext | None = None) -> AlbedoSpectrum:
    """The Moon's albedo spectrum from the ROLO model (photometry/rolo.py) at its smallest phase angle."""
    from . import rolo
    wl, a = rolo.reference_spectrum()
    r_ref = mean_radius(301)
    area = (rolo.RADIUS_KM / r_ref) ** 2
    sources = [_src(ctx, rolo.ROLO), _src(ctx, PCK)]
    return AlbedoSpectrum(
        301, wl, a * area, "derived", sources,
        f"ROLO lunar model (Kieffer & Stone 2005, version 311g; Eq. 10 with Table 4 and Eq. 11): the disk-equivalent "
        f"reflectance A_k of the whole Moon in its 32 bands (350-2384 nm), evaluated at the model's smallest phase "
        f"angle, g = {rolo.MIN_PHASE}°, at zero libration, geometric mean of the waxing and waning Moon (they differ "
        f"by 0.2 % there), linearly interpolated in wavelength between band centres (5-60 nm apart in the visible). "
        f"This REFERENCE ALBEDO is at α = {rolo.MIN_PHASE}°, not 0°: the phase function is 1 there and unknown "
        "below (from Earth, α < 1.55° means the Moon is at the edge of Earth's shadow; the surge probably continues "
        "to rise). A = p·Φ is referenced to the disk radius of the paper's Eq. 8 (Ω_M = 6.4177e-5 sr at 384 400 km: "
        f"{rolo.RADIUS_KM:.1f} km = the pck00011 mean radius, ×{area:.4f}). The band-to-band scale of version 311g "
        "was adjusted to a fitted Apollo 16 soil/breccia laboratory spectrum (paper Sec. 4.2; average adjustment "
        "3.5 %), so the fine spectral shape partly follows that spectrum. Lane & Irvine's (1973) whole-disk "
        "narrow-band albedos, used until M3, are kept as a cross-check (docs/reports/planet-colors.md).",
        "absolute scale uncertain by several percent (paper Sec. 5; Vega-based, 1.5 % at 555.6 nm per Hayes 1985); "
        "band-to-band: mean absolute fit residual 0.0096 in ln A per band; the choice of the Apollo adjustment "
        "reference could change 440-700 nm by up to 4 % (Sec. 4.2)",
        p_v_method="Bessell V band average of the ROLO spectrum above (at α = 1.55°, so that it matches "
                   "geometricAlbedoXYZS).",
        notes={"reference_phase_deg": rolo.MIN_PHASE, "area_factor": area})


def moon_lane_irvine(ctx: BuildContext | None = None) -> AlbedoSpectrum:
    """Lane & Irvine (1973) whole-disk albedos: the Moon's spectrum until M3, now a cross-check of ROLO."""
    rows = read_table_csv("lane_irvine_1973.csv")
    narrow = [r for r in rows if r["band"] not in ("U", "B", "V")]
    wl = np.array([float(r["lambda_eff_A"]) / 10.0 for r in narrow])
    p = np.array([float(r["p"]) for r in narrow])
    sigma, dist_km = 0.0045216, 384400.0  # paper Eq. (2): angular radius at the mean distance (60.2665 R_E)
    r_src = math.sin(sigma) * dist_km
    r_ref = mean_radius(301)
    area = (r_src / r_ref) ** 2
    v = next(r for r in rows if r["band"] == "V")
    sources = [_src(ctx, phase.LANE_IRVINE), _src(ctx, PCK)]
    return AlbedoSpectrum(
        301, wl, p * area, "estimated", sources,
        "Lane & Irvine (1973) Table VIII geometric albedos of the whole lunar disk in 9 narrow bands (359-1064 nm), "
        "linearly interpolated in wavelength between band centres (the lunar spectrum is smooth, but 100+ nm gaps "
        f"are an interpolation assumption), rescaled from their disk (sin σ × 384 400 km = {r_src:.1f} km) to the "
        f"pck00011 radius {r_ref:.1f} km (×{area:.4f}). These albedos are linear extrapolations of 6-120° phase "
        "data to zero phase and EXCLUDE the opposition surge, consistently with the tabulated phase curve used for "
        "this body.",
        "±3-4 % per band (standard errors of m(1,0)); the authors note possibly ~10 % systematic excess at "
        "600-850 nm in their 1965 data",
        p_v_method=f"Bessell V band average of the narrow-band spectrum above (so that it matches "
                   f"geometricAlbedoXYZS). Lane & Irvine's own broadband V albedo is {v['p']} (m_V(1,0) = {v['m10']} "
                   f"± {v['m10_err']}), {float(v['p']) * area:.3f} at the pck radius, i.e. ~12 % lower; the authors "
                   "note their broadband V 'appears slightly faint with respect to the narrow band data, perhaps "
                   "because of transformation problems associated with large filter band width' (p. 273).",
        notes={"source_radius_km": r_src, "ref_radius_km": r_ref, "area_factor": area})


def pluto(ctx: BuildContext | None = None) -> AlbedoSpectrum:
    t = read_table_json("buie_2010a_pluto.json")
    pl = t["pluto"]
    geo = 5.0 * math.log10(t["mean_opposition_r_au"] * t["mean_opposition_delta_au"])
    v10 = pl["V_a0_1deg"] + pl["V_to_zero_phase"] - geo
    b10 = pl["B_a0_1deg"] + pl["B_to_zero_phase"] - geo
    r_ref = mean_radius(999)
    area = (r_ref / AU_KM) ** 2
    p_v = 10 ** (-0.4 * (v10 - sun_mag("V"))) / area
    p_b = 10 ** (-0.4 * (b10 - sun_mag("B"))) / area
    # p(λ) = a + b (λ - 550 nm) such that the Bessell B and V band averages equal p_B and p_V (2x2 linear system).
    wl = np.arange(300.0, 1101.0, 1.0)
    m = np.array([[filters.band_average(bd, wl, np.ones_like(wl)), filters.band_average(bd, wl, wl - 550.0)]
                  for bd in ("B", "V")])
    a, b = np.linalg.solve(m, np.array([p_b, p_v]))
    p = a + b * (wl - 550.0)
    sources = [_src(ctx, phase.BUIE), _src(ctx, WILLMER), _src(ctx, PCK), *filters.register(ctx, ("B", "V"))]
    return AlbedoSpectrum(
        999, wl, p, "estimated", sources,
        f"Reconstructed from broadband photometry only: Pluto-alone B(1,0) = {b10:.3f} and V(1,0) = {v10:.3f} "
        f"(Buie et al. 2010, HST 2002-2003, Hapke-extrapolated to zero phase), solar B = {sun_mag('B')}, V = "
        f"{sun_mag('V')} (Willmer 2018) and the pck00011 radius {r_ref:.1f} km give p_B = {p_b:.3f}, p_V = "
        f"{p_v:.3f}. ASSUMED spectral shape: p linear in wavelength, fixed by the Bessell B and V band averages "
        f"(p = {a:.4f} + {b:.3e}·(λ - 550 nm)), extrapolated to 360-830 nm. Pluto's real spectrum flattens and has "
        "CH4 bands beyond ~600 nm, so the red end (and X) is probably too high. Excludes Charon.",
        "p_V ±~3 % (photometry, radius); colour only constrained by B-V = "
        f"{b10 - v10:.3f}; red end is an extrapolation (could be tens of percent off beyond 650 nm); Pluto's colour "
        "changed measurably between 1992 and 2003",
        p_v_label="derived",
        p_v_method=f"Equal by construction to the Bessell V band average of the reconstruction. From Buie et al. (2010) Pluto-alone V(1,0) = {v10:.3f} (Table 8 a0 = {pl['V_a0_1deg']} at 1°, "
                   f"minus {-pl['V_to_zero_phase']} to 0°, at r = {t['mean_opposition_r_au']}, Δ = "
                   f"{t['mean_opposition_delta_au']} AU), V_sun = {sun_mag('V')} (Willmer 2018) and R = "
                   f"{r_ref:.1f} km (pck00011): p_V = 10^(-0.4 (V(1,0) - V_sun)) / (R/AU)^2.",
        notes={"V10": v10, "B10": b10, "p_B": p_b, "p_V": p_v, "slope_per_nm": b})


MALLAMA_2017 = Download(
    id="mallama-2017",
    url="https://arxiv.org/pdf/1609.05048v1", subdir="papers", name="arXiv-1609.05048v1.pdf",
    title="Broadband (Johnson-Cousins and Sloan) magnitudes and geometric albedos of the planets (Tables 3, 5, 7)",
    citation="Mallama, A., Krobusek, B. & Pavlov, H. (2017). Comprehensive wide-band magnitudes and albedos for the "
             "planets, with applications to exo-planets and Planet Nine. Icarus 282, 19-33. "
             "DOI:10.1016/j.icarus.2016.09.023.",
    notes="Table 7 transcribed to photometry/tables/mallama_2017_table7.csv. Mars U B V R I albedos derive from "
          "photometric (observed) magnitudes reduced to zero phase (Mallama 2007); several other entries are "
          "synthetic (see the CSV header).",
)


def broadband_reconstruction(bands: dict[str, float], wl_min: float = 300.0,
                             blue_shape=None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Piecewise-linear p(λ) with one node at each band's solar-weighted effective wavelength (constant beyond the
    end nodes), solved exactly so that every band average ∫pET/∫ET equals the given albedo. Returns
    (λ grid, p, node wavelengths). `blue_shape(λ)`, if given, replaces the constant extension below the first node
    by that relative shape (p(λ) = p(λ₀)·shape(λ)/shape(λ₀))."""
    keys = list(bands)
    nodes = np.array([filters.effective_wavelength(k) for k in keys])
    order = np.argsort(nodes)
    keys, nodes = [keys[i] for i in order], nodes[order]
    wl = np.arange(wl_min, 1200.01, 0.5)

    blue = np.ones_like(wl)
    if blue_shape is not None:
        below = wl < nodes[0]
        blue[below] = blue_shape(wl[below]) / float(blue_shape(np.array([nodes[0]]))[0])

    def hat(k):
        y = np.zeros_like(nodes)
        y[k] = 1.0
        return np.interp(wl, nodes, y) * (blue if k == 0 else 1.0)  # constant (or shaped) beyond end nodes

    m = np.array([[filters.band_average(b, wl, hat(k)) for k in range(nodes.size)] for b in keys])
    x = np.linalg.solve(m, np.array([bands[b] for b in keys]))
    return wl, sum(x[k] * hat(k) for k in range(nodes.size)), nodes


def mars(ctx: BuildContext | None = None) -> AlbedoSpectrum:
    row = next(r for r in read_table_csv("mallama_2017_table7.csv") if r["planet"] == "499")
    bands = {f"johnson.{b}": float(row[b]) for b in "UBVRI"}
    wl, p, nodes = broadband_reconstruction(bands)
    sources = [_src(ctx, MALLAMA_2017), *filters.register(ctx, tuple(bands)), _src(ctx, PCK)]
    return AlbedoSpectrum(
        499, wl, p, "estimated", sources,
        "Reconstructed from broadband photometry: the Johnson U, B, V, R, I geometric albedos of Mars "
        f"({', '.join(row[b] for b in 'UBVRI')}; Mallama et al. 2017 Table 7, from photometric magnitudes of "
        "Mallama 2007 reduced to zero phase and averaged over rotation and season) are matched exactly by a "
        "piecewise-linear p(λ) with nodes at the bands' solar-weighted effective wavelengths ("
        f"{', '.join(f'{n:.0f}' for n in nodes)} nm) and constant beyond the end nodes. The piecewise-linear shape "
        "between nodes is an assumption (it cannot reproduce narrow features such as the ~530 nm ferric-oxide "
        "shoulder), hence 'estimated'. (The Payne et al. 2026 composite for Mars was not used: it is a "
        "radiative-transfer model whose B-band albedo is ~45 % below Mallama et al.'s photometry.)",
        "band albedos ±1 % (0.01 mag, Mallama et al. 2017 Table 3); rotational variability ±0.035 mag rms, global "
        "dust storms -0.12 mag (Mallama & Hilton 2018); shape between nodes unconstrained",
        p_v_method="Bessell V band average of the reconstruction; Mallama et al. (2017) give Johnson V p = 0.170 "
                   "(V1(0) = -1.60 ± 0.01, Mallama 2007), which the reconstruction matches exactly in the Johnson V "
                   "passband.",
        notes={"nodes_nm": nodes.tolist()})


def spectrum_for(naif: int, ctx: BuildContext | None = None) -> AlbedoSpectrum:
    if naif in (599, 699, 799, 899):
        return karkoschka(naif, ctx)
    if naif == 499:
        return mars(ctx)
    if naif == 399:
        from . import earth
        return earth.earth_spectrum(ctx)
    if naif in PAYNE:
        return payne(naif, ctx)
    if naif == 301:
        return moon(ctx)
    if naif == 999:
        return pluto(ctx)
    raise KeyError(naif)
