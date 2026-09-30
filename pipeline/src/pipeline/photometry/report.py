"""Generate docs/reports/planet-colors.md (planets, moons, rings) from the same code the `light` stage runs.

  cd pipeline && uv run python -m pipeline.photometry.report
"""

from __future__ import annotations

import datetime as _dt
import math
import warnings

import numpy as np

from ..paths import REPO
from . import bodies, filters, horizons, moons, rings, solar
from .. import cie
from .common import bin_average, read_table_csv

OUT = REPO / "docs" / "reports" / "planet-colors.md"

NOTES = {
    199: "Spectral shape: MESSENGER/MASCS global-mean reflectance (Izenberg et al. 2014) as composited and scaled by "
         "Payne et al. (2026) to Mallama et al.'s (2017) broadband albedos. It is a disk-resolved, photometrically "
         "standardized spectrum, not a zero-phase disk integral, so phase reddening is not removed; the colour is "
         "probably slightly too red, the level is good to ~3 %. Phase curve: SOHO/LASCO + ground (measured).",
    299: "Spectral shape: MESSENGER/VIRS equatorial-cloud I/F (Pérez-Hoyos et al. 2018) scaled to p_V = 0.689. This "
         "is WEAK in the blue: below ~480 nm it is 20 % below Mallama's photometric B albedo, but Mallama's own "
         "synthetic B agrees with it. Venus's hue (how yellow) is therefore uncertain; its brightness is not. (Older disk-integrated data, Irvine 1968 "
         "and Barker 1975, lie between the two in Payne et al.'s compilation, their Fig. 3.) Phase curve: SOHO + "
         "ground (measured).",
    399: "Albedo (M3 follow-up): MEASURED — the whole sunlit Earth from Himawari-9 at its local noon one day "
         "before the 2025 March equinox (α ≈ 2.4°), disk-integrated in four bands (0.47-0.86 µm); the spectrum is "
         "piecewise-linear through them, with the EPIC-validated PSG model's shape below 0.47 µm (estimated). "
         "p_V = 0.24, confirming the low value of the PSG model (0.22) against Mallama et al.'s 0.434. One "
         "hemisphere, one instant: real Earth varies by ~10-20 % with clouds. Phase curve: model shape (Tinetti et "
         "al. via Mallama & Hilton), checked against EPOXI at 58-86° (M3 follow-up below).",
    301: "Albedo (M3): the ROLO model (Kieffer & Stone 2005) whole-disk reflectance in 32 bands at α = 1.55°, the "
         "model's smallest phase angle (a reference albedo, not a zero-phase one: below 1.55° unknown). Phase curve: "
         "ROLO for 1.55-97° (Φ(1.55°) = 1), with the opposition surge; Lane & Irvine's shape joined to it for "
         "97-120° (estimated). Libration and waxing/waning are in diskReflectanceModel. Lane & Irvine's (1973) "
         "narrow-band albedos, used until M3, are a cross-check (M3 below): redder, with a 13 % internal V "
         "inconsistency.",
    499: "Reconstructed from Mallama et al. (2017) photometric Johnson UBVRI albedos (rotation/season averaged): a "
         "piecewise-linear spectrum through five band averages. Brightness and B-V are measured; the shape between "
         "bands is assumed (no 530 nm shoulder). A PSG model composite (Payne et al.) was rejected: its B albedo is "
         "45 % below the photometry. Phase curve: measured to 50°, assumed beyond (estimated).",
    599: "Karkoschka (1998) ESO spectrophotometry at 6.8° phase, scaled to 0° with Mallama & Hilton's V phase law "
         "(assumption: same at all λ, +2.4 %). Agrees with Mallama et al. (2017) B, V, Rc to ≤ 2 % and with Horizons "
         "to 0.02 mag. Strong data. Phase curve: ground + Cassini (measured).",
    699: "Karkoschka (1998) at the 1995 ring-plane crossing, i.e. the GLOBE without rings (what the renderer draws; "
         "rings are separate, see Rings). Scaled from 5.7° to 0° with an assumed phase law (+1.7 %). 5 % fainter in V than Mallama & "
         "Pavlov's synthetic globe magnitude from the same data, but consistent with Karkoschka's own V. Saturn's "
         "globe colour changes with season (hemisphere in view, ring shadow). Phase curve: assumed/modelled "
         "(estimated).",
    799: "Karkoschka (1998) 1995 geometric albedo. Uranus's colour changes with season (Irwin et al. 2024): the red "
         "albedo in 1995 is 28 % above Mallama et al.'s 2000s photometry, and the 2026 view (near northern solstice) "
         "differs from 1995's. Irwin et al.'s calibrated spectra are available only on request, so they could not be "
         "used. Phase curve: Voyager (measured).",
    899: "Karkoschka (1998) 1995 geometric albedo; Neptune brightened until ~2000 (3 % in V since 1995 per Mallama "
         "& Hilton), red albedo 15 % above Mallama's 2000s photometry. The computed colour is a pale blue close to "
         "Uranus's, as Irwin et al. (2024) find, not the deep blue of enhanced Voyager images. Phase curve: Voyager "
         "(measured).",
    999: "No machine-usable spectrum of Pluto alone was found (Lorenzi et al. 2016 spectra are figures only; New "
         "Horizons disk-integrated colours not tabulated). Reconstructed from HST B and V only (Buie et al. 2010): "
         "p linear in λ, extrapolated to 360-830 nm, so the red end is likely too high and the colour too red. "
         "Phase curve: 0-1.74° only (HST); unknown beyond, i.e. from any viewpoint far from the Earth-Sun line.",
}


MOON_NOTES = {
    401: "Four Mars Express HRSC colour albedos (Hapke disk-integrated fits, surge-inclusive) joined piecewise "
         "linearly; H-G phase curve over 0-100°. Irregular body: the sphere of mean radius is an approximation.",
    402: "Only a panchromatic albedo (0.080) exists in usable form: colour ASSUMED grey (placeholder), phase unknown.",
    501: "Cassini ISS WAC albedos in 5 filters, joined piecewise linearly; below 420 nm held constant, which "
         "overstates Io's violet (its reflectance drops steeply there), so Io may render slightly less yellow than it "
         "is. Rotational variation up to 16 % (not represented).",
    502: "Cassini ISS WAC albedos in 4 filters (no 939 nm); constant beyond 752 nm.",
    503: "Cassini ISS WAC albedos in 5 filters.",
    504: "Cassini ISS WAC albedos in 3 filters only (VIO, GRN, RED): constant beyond 647 nm, so the red end is "
         "unconstrained.",
    601: "Cassini VIMS model albedo a0 at 14 wavelengths (surge excluded). Phase curve: disk integral of the fitted "
         "model, 10-120° derived; 0-10° (M3) the measured opposition-surge shape of Enceladus and Rhea (mean) joined "
         "at 10°, so Φ(0) > 1.",
    602: "As Mimas, with Enceladus's own measured surge shape. Enceladus is the brightest body in the solar system; "
         "its albedo here excludes the surge, which the phase function adds (Φ(0) = 1.25).",
    603: "As Mimas.",
    604: "As Mimas.",
    605: "As Mimas.",
    606: "Karkoschka's 1995 full-disk spectrum × 1.02 to zero phase (model-based factor). Phase curve known only "
         "0-5.7° (linear assumption); Titan's strongly forward-scattering Cassini phase curve is published only as "
         "figures.",
    608: "UNKNOWN: its leading and trailing hemispheres differ hugely in albedo, so any single value misleads; no "
         "machine-readable orbital lightcurve was accessible.",
    701: "Ground-based disk-integrated spectrum (DeColibus et al. 2026) scaled to Karkoschka's (2001) HST 0.63 µm "
         "albedo. Phase curve: Titania/Oberon's (assumed).",
    702: "As Ariel.",
    703: "As Ariel; phase curve is Karkoschka's own for Titania/Oberon (strong narrow surge). TMO photometry in the "
         "same dataset agrees within 7 %.",
    704: "As Titania.",
    705: "UNKNOWN: no accessible disk-integrated photometry.",
    801: "Two broadband points (p_V, B-V): linear spectrum, extrapolated (estimated). Phase coefficient over "
         "0-1.26° only.",
    901: "Buie et al. (2010) HST V and B-V: linear spectrum (estimated). Phase curve from their Hapke fit, 0-1.74°, "
         "reproducing their 0.25 mag 1°→0° surge.",
    **{n: "Irregular satellite: brightness from the absolute magnitude H (Grav et al. 2015 compilation), colour "
          "ASSUMED grey, H-G phase curve with G assumed by the source (0.10) over Earth-based phase angles. p_V is "
          "referenced to the (rough, round-number) pck00011 radius, so it differs from the NEOWISE albedo while the "
          "brightness is the same." for n in (506, 507, 508, 509, 510, 511, 512, 513)},
    609: "Irregular satellite: brightness from H = 6.59 (Grav et al. 2015 compilation), colour ASSUMED grey, H-G phase "
         "curve with G = 0.02 over 0-6.5°. Cassini measured Phoebe in detail, but no disk-integrated table was "
         "accessible.",
}


def _srgb(xyz: np.ndarray, sun_xy: tuple[float, float] | None) -> tuple[str, bool]:
    import colour
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        cs = colour.RGB_COLOURSPACES["sRGB"]
        if sun_xy is None:
            rgb = colour.XYZ_to_RGB(xyz, cs, illuminant=cs.whitepoint, chromatic_adaptation_transform=None)
        else:
            rgb = colour.XYZ_to_RGB(xyz, cs, illuminant=np.array(sun_xy), chromatic_adaptation_transform="Bradford")
        clipped = bool(np.any(rgb < 0) or np.any(rgb > 1))
        enc = cs.cctf_encoding(np.clip(rgb, 0, 1))
    return "#" + "".join(f"{int(round(255 * c)):02X}" for c in enc), clipped


def _hue_swatch(xyz: np.ndarray, sun_xy) -> str:
    import colour
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        cs = colour.RGB_COLOURSPACES["sRGB"]
        rgb = colour.XYZ_to_RGB(xyz, cs, illuminant=np.array(sun_xy), chromatic_adaptation_transform="Bradford")
        rgb = np.clip(rgb, 0, None)
        enc = cs.cctf_encoding(rgb / rgb.max())
    return "#" + "".join(f"{int(round(255 * c)):02X}" for c in enc)


def _fmt(v, f="{:+.3f}"):
    return "n/a" if v is None else f.format(v)


def generate() -> str:
    res = bodies.build_all(None, list(bodies.PLANETS))
    mres = bodies.build_all(None, list(moons.MOONS))
    sun = solar.irradiance_xyzs()
    sx, sy = sun[0] / sun[:3].sum(), sun[1] / sun[:3].sum()
    tsi = solar.total_irradiance()
    ld = solar.limb_darkening()
    comps = horizons.compare(res, horizons.load_fixtures(list(bodies.PLANETS)))
    mtexts = horizons.load_fixtures(list(moons.MOONS))
    mcomps = horizons.compare(mres, mtexts)
    mallama = {int(r["planet"]): r for r in read_table_csv("mallama_2017_table7.csv")}
    L = []
    w = L.append
    w("# Planet, moon and ring photometry: review report\n")
    w(f"Generated {_dt.date.today().isoformat()} by `cd pipeline && uv run python -m pipeline.photometry.report`, "
      "from the same code as the `light` stage (`app/public/data/light.json`, `photometry.json`, `rings.json`). All numbers "
      "below are computed, not typed; the prose is written by hand. Sources are listed in `sources.json` and "
      "`docs/sources/`.\n")
    w("## How to read the colours\n")
    w("- **Chromaticity (x, y)**: CIE 1931 2° chromaticity of sunlight reflected by the body at zero phase, i.e. of "
      "K∫p(λ)E☉(λ)cmf(λ)dλ (docs/architecture.md §4.3).\n"
      "- **Display colours are renderings for human review, not what the app shows** (the app's eye model does "
      "adaptation). *Equal exposure*: XYZ is divided by the Sun's Y, so a perfectly white Lambertian disk facing the "
      "Sun would be display white; the display luminance is then the photopic geometric albedo p_Y and the bodies "
      "keep their relative brightness. XYZ → linear sRGB with the IEC 61966-2-1 matrix (colour-science "
      f"{__import__('colour').__version__}); **gamut mapping: per-channel clip of linear RGB to [0, 1]**, then the "
      "sRGB transfer function. \"*\" marks a colour that needed clipping.\n"
      "  - *no adaptation*: display white is D65, so sunlight itself renders slightly warm.\n"
      "  - *sun-adapted*: Bradford chromatic adaptation from sunlight's white point to D65, i.e. an observer adapted "
      "to sunlight (sunlight renders neutral grey-white). This is closer to what an eye in space would report.\n"
      "  - *hue swatch*: the sun-adapted colour scaled so its largest channel is 1 (brightness removed; judge hue "
      "only).\n")
    hex_sun, _ = _srgb(sun[:3] / sun[1], None)
    w("## Sunlight at 1 AU (TSIS-1 HSRS v2)\n")
    w("| quantity | value |\n|---|---|")
    w(f"| X, Y, Z | {sun[0]:.0f}, **{sun[1]:.0f} lux**, {sun[2]:.0f} |")
    w(f"| scotopic S | {sun[3]:.0f} scotopic lux (S/P = {sun[3] / sun[1]:.3f}) |")
    w(f"| chromaticity x, y | {sx:.4f}, {sy:.4f} |")
    w(f"| spectrum integral {tsi['range_nm'][0]:.0f}-{tsi['range_nm'][1]:.0f} nm | {tsi['total_W_m2']:.2f} W/m² "
      f"= {100 * tsi['total_W_m2'] / 1361:.1f} % of TSI 1361 W/m² (IAU 2015 B3); the rest is outside the "
      "covered range |")
    w(f"| 360-830 nm integral | {tsi['visible_360_830_W_m2']:.2f} W/m² |")
    w(f"| display (no adaptation, Y=1) | `{hex_sun}` |")
    w("| independent check | WHI 2008 reference spectrum (Woods et al. 2009; SORCE SIM) gives Y = 133 001 lux, "
      "(0.3212, 0.3321): HSRS is 1.2 % higher in Y, same chromaticity to 0.0004 (tests/test_light_solar.py) |\n")
    w("Y = 1.346e5 lux is slightly above the often-quoted 1.2-1.3e5 lux; it is what the TSIS-1 absolute scale gives "
      "(older SORCE-era spectra give 1.33e5). Not tuned.\n")
    w("## Solar limb darkening per channel (Neckel & Labs 1994)\n")
    w("I(μ)/I(1) = Σ c_k μ^k. Continuum coefficients (30 wavelengths) weighted by the disk-centre spectrum and each "
      "observer function; see `light.json` method for assumptions.\n")
    w("| channel | c0 | c1 | c2 | c3 | c4 | c5 | F/I (disk mean / centre) |\n|---|---|---|---|---|---|---|---|")
    for name, c, fi in zip("XYZS", ld.coeffs, ld.flux_to_center):
        w(f"| {name} | " + " | ".join(f"{v:.5f}" for v in c) + f" | {fi:.4f} |")
    w(f"\nRefit of the channel-integrated profiles with a 5th-order polynomial on 201 μ samples: max residual "
      f"{ld.fit_residual_max:.1e} (a weighted mean of quintics is a quintic). Value at μ = 1: "
      + ", ".join(f"{v:.6f}" for v in ld.at_mu1) + " (Table I is rounded to 5 decimals).\n")

    w("## Bodies\n")
    w("| body | x | y | p_V | p_Y | display, no adaptation | display, sun-adapted | hue swatch | albedo label | "
      "phase label | spectrum from |\n|---|---|---|---|---|---|---|---|---|---|---|")
    src_short = {199: "Payne+2026 (MASCS)", 299: "Payne+2026 (VIRS)", 399: "Himawari-9 AHI (4 bands)",
                 301: "ROLO (Kieffer & Stone 2005)", 499: "Mallama+2017 UBVRI", 599: "Karkoschka 1998",
                 699: "Karkoschka 1998", 799: "Karkoschka 1998", 899: "Karkoschka 1998",
                 999: "Buie+2010 B, V"}
    for n, r in res.items():
        xyz = r.xyzs[:3] / sun[1]
        x, y = r.xyzs[0] / r.xyzs[:3].sum(), r.xyzs[1] / r.xyzs[:3].sum()
        h0, c0 = _srgb(xyz, None)
        h1, c1 = _srgb(xyz, (sx, sy))
        hue = _hue_swatch(xyz, (sx, sy))
        e = r.entry
        w(f"| {r.name} | {x:.4f} | {y:.4f} | {r.p_v:.3f} | {r.xyzs[1] / sun[1]:.3f} | `{h0}`{'*' if c0 else ''} | "
          f"`{h1}`{'*' if c1 else ''} | `{hue}` | {e['geometricAlbedoXYZS']['label']} | "
          f"{e['phaseFunction']['label']} | {src_short[n]} |")
    w("\np_V: Bessell V band average of p(λ) (reported as `geometricAlbedoV`); p_Y: photopic (ȳ-weighted) "
      "geometric albedo = Y/Y☉. All albedos referenced to the pck00011 volumetric mean radius.\n")
    w("### Per-body data and weaknesses\n")
    for n, r in res.items():
        w(f"- **{r.name}** ({n}). {NOTES[n]} Sources: " + ", ".join(
            f"`{s}`" for s in dict.fromkeys(r.entry['geometricAlbedoXYZS']['sources'] +
                                            r.entry['phaseFunction']['sources'])) + ".")
    w("")
    w("## Consistency: albedo, radius and zero-phase magnitude\n")
    w("V(1,0) implied by our p_V and the pck00011 volumetric mean radius R, with V☉ = -26.76 (Willmer 2018): "
      "V(1,0) = V☉ − 2.5 log10(p_V (R/AU)²). Compared with the zero-phase magnitude the phase curve is normalized "
      "to (Mallama & Hilton 2018; for Mercury the surge-inclusive value). Not adjusted to agree.\n")
    w("| body | R (km) | p_V | V(1,0) ours | V(1,0) published | ours − published | note |\n"
      "|---|---|---|---|---|---|---|")
    pub_note = {199: "-0.694 (surge-inclusive model; the polynomial's own constant is -0.613)",
                299: "Eq. 3", 399: "Mallama et al. 2017 (EPOXI + model phase curve)", 499: "Eq. 6, mean over L(λe), L(Ls)",
                599: "Eq. 8", 699: "Eq. 11, globe (Mallama & Pavlov synthetic from Karkoschka 1998)",
                799: "-7.110 − 8.4e-4 φ′ (φ′ ≈ 75° now → -7.173)", 899: "Eq. 16, t > 2000",
                301: "Lane & Irvine broadband m_V(1,0) = -12.72 at the mean lunar distance (also Horizons' 0.23)",
                999: "self-consistent (p_V derived from Buie et al. V(1,0))"}
    li_v = next(float(r["m10"]) for r in read_table_csv("lane_irvine_1973.csv") if r["band"] == "V")
    moon_v10 = li_v - 5.0 * math.log10(384400.0 / 149597870.7)
    for n, r in res.items():
        pub = {799: -7.110 - 8.4e-4 * 75.0, 301: moon_v10}.get(n, r.v10_published)
        w(f"| {r.name} | {r.radius_km:.1f} | {r.p_v:.4f} | {r.v10:+.3f} | {_fmt(pub)} | "
          f"{_fmt(None if pub is None else r.v10 - pub)} | {pub_note[n]} |")
    w("")
    w("## Band albedos vs Mallama et al. (2017) Table 7\n")
    w("Solar-weighted band averages of our p(λ) through Bessell (1990) B, V and Cousins R, I, vs Mallama et al.'s "
      "published albedos (several of theirs are *synthetic*, i.e. from other spectra; see "
      "`tables/mallama_2017_table7.csv`). Mars is not an independent comparison (built from Mallama's Johnson "
      "bands).\n")
    w("| body | B ours / M17 | V ours / M17 | Rc ours / M17 | Ic ours / M17 |\n|---|---|---|---|---|")
    for n in (199, 299, 399, 499, 599, 699, 799, 899):
        s = res[n].spectrum
        cells = []
        for band, col in (("B", "B"), ("V", "V"), ("R", "Rc"), ("I", "Ic")):
            o = filters.band_average(band, s.wl, s.p)
            m = float(mallama[n][col])
            cells.append("n/a" if o is None else f"{o:.3f} / {m:.3f} ({100 * (o / m - 1):+.0f} %)")
        w(f"| {res[n].name} | " + " | ".join(cells) + " |")
    w("")
    w("## Cross-check with JPL Horizons APmag\n")
    w("Apparent V at three epochs in the window, using Horizons' own r, Δ, phase angle α and sub-latitudes "
      "(fixtures in `pipeline/tests/fixtures/horizons/`). *M&H* is our reimplementation of Mallama & Hilton (2018) "
      "as coded in Ap_Mag_V3 (it reproduces Horizons to ≤ 0.001 mag except Mars, where Horizons adds the rotation "
      "and season terms). *ours* = our V(1,0) + 5 log10(rΔ) + our phase function. Earth is seen from Mars.\n")
    w("| body | date (UT) | α (°) | Horizons | M&H | ours | ours − Horizons | note |\n"
      "|---|---|---|---|---|---|---|---|")
    for c in comps:
        d = None if (c.ours is None or c.horizons is None) else c.ours - c.horizons
        w(f"| {c.name} | {c.row.date[:11]} | {c.row.phase_deg:.2f} | {_fmt(c.horizons)} | {_fmt(c.mh)} | "
          f"{_fmt(c.ours)} | **{_fmt(d)}** | {c.note} |")
    w("")
    w("What the differences mean:\n")
    w("- **Mercury +0.03, Venus +0.00, Jupiter −0.02, Uranus −0.01…−0.03, Neptune +0.03…+0.04**: agreement at the "
      "level of the absolute calibrations (±3-4 %) and of the source epochs (Karkoschka 1995 vs 2000s).\n"
      "- **Mars +0.01…+0.08**: Horizons includes the rotational and seasonal terms L(λe), L(Ls) (±0.06); our "
      "photometry is the rotation/season mean.\n"
      "- **Earth +0.64**: our Earth (Himawari-9 measurement, p_V = 0.24) is 0.55× as bright as Mallama & Hilton's "
      "V(1,0) = −3.99 (p_V = 0.434, from EPOXI at 58-77° extrapolated to 0° with a model phase curve). EPOXI's own "
      "images, integrated here, agree with our albedo × the same model curve within 4-16 % at 58-77° (M3 follow-up "
      "below), so the factor of ~1.8 is in the extrapolation or its normalization, not in the data.\n"
      "- **Saturn +0.13…+0.30**: Horizons includes the rings for α < 6.5° (Eq. 10); our entry is the globe alone. "
      "Against the globe-only Eq. 11 we are +0.05 (see the consistency table).\n"
      "- **Moon +0.09 (α = 43°), +0.06 (α = 100°), n/a at 130°**: Horizons uses V(1,α) = 0.23 + 0.026α + "
      "4×10⁻⁹α⁴ (Allen's law; our fixtures reproduce it to 0.0002 mag), whose 0.23 equals Lane & Irvine's broadband "
      "V. Ours is the ROLO level (to 97°; Lane & Irvine's shape joined to it beyond), averaged over waxing and "
      "waning at zero libration; the fixture epochs' libration and waxing/waning (≈ ±5 % at 43°) are not applied "
      "in this table. Valid to 120° only.\n"
      "- **Pluto +0.16…+0.19**: Horizons' Pluto includes Charon, V(1,α) ≈ −1.00 + 0.041α (inferred from the "
      "fixtures; the manual does not cite a source); we add Charon from the same HST paper for this comparison. "
      "Buie et al.'s 2002-2003 Pluto + Charon is 0.16 mag fainter than Horizons' system magnitude (the radius "
      "does not enter this comparison).\n")
    _moons_section(w, mres, mtexts, mcomps, sun, sx, sy)
    _rings_section(w)
    _fixups_section(w)
    _m3_section(w)
    w("## Weak data, in order of concern\n")
    w("1. **Earth**: one measured snapshot (one hemisphere, one day) sets the albedo; the phase curve is a model "
      "(EPOXI agrees within 4-16 % at 58-77°, 34 % at 86°); 0.64 mag fainter than the magnitude Horizons uses.\n"
      "2. **Pluto**: colour from two broadband points; phase curve only to 1.74°.\n"
      "3. **Venus blue end**: ±20 % between datasets below 480 nm, which sets how yellow Venus looks.\n"
      "4. **Moon below 1.55° and beyond 120°**: unknown; the albedo is ROLO's at 1.55° (a reference, not zero "
      "phase). Colour and brightness now follow ROLO (M3).\n"
      "5. **Uranus/Neptune epoch**: 1995 spectra; both have changed since (Uranus seasonally, strongly in the red).\n"
      "6. **Mars and Mercury shapes**: Mars between broadband nodes; Mercury from disk-resolved spectra.\n"
      "7. **Phase corrections for Jupiter/Saturn** to zero phase (+2.4 %, +1.7 %) assume a grey phase law.\n"
      "8. **Opposition surges of the moons**: included for the Moon (ROLO, to 1.55°), Mimas-Rhea (measured shape "
      "of Enceladus/Rhea at the VIMS level; HST is 1.2-1.4× brighter), Uranian moons, Triton, Charon, Phobos.\n"
      "9. **Iapetus and Miranda** unknown; **Deimos** grey placeholder; **Titan** and **Triton**/**Charon** phase "
      "curves only near opposition.\n"
      "10. **Ring brightness**: Saturn's is a calibrated model (unlit face and radii away from the three HST "
      "regions least certain; low ring elevations only partly checked); Jupiter's, Uranus's and Neptune's unknown.\n"
      "11. **Irregular satellites**: brightness from compiled H only; grey placeholder colour; rough pck00011 radii "
      "(if bodies.json uses a different radius for them, the rendered brightness scales by (R_bodies/R_pck)²).\n")
    return "\n".join(L) + "\n"


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(generate())
    print(f"wrote {OUT}")




def _moons_section(w, mres, mtexts, mcomps, sun, sx, sy) -> None:
    w("## Moons\n")
    w("Same conventions as the planets. Unknown entries carry their reason in photometry.json.\n")
    w("| moon | x | y | p_V | p_Y | display, sun-adapted | hue swatch | albedo label | phase label | phase domain |"
      "\n|---|---|---|---|---|---|---|---|---|---|")
    for n, r in mres.items():
        e = r.entry
        pf = e["phaseFunction"]["value"]
        dom = "unknown" if pf is None else (
            f"{pf['minDeg']:g}-{pf['maxDeg']:g}°" if pf["kind"] == "poly-mag" else
            f"{pf['alphaDeg'][0]:g}-{pf['alphaDeg'][-1]:g}°")
        if r.xyzs is None:
            w(f"| {r.name} | | | unknown | | | | unknown | {e['phaseFunction']['label']} | {dom} |")
            continue
        xyz = r.xyzs[:3] / sun[1]
        x, y = r.xyzs[0] / r.xyzs[:3].sum(), r.xyzs[1] / r.xyzs[:3].sum()
        h1, c1 = _srgb(xyz, (sx, sy))
        w(f"| {r.name} | {x:.4f} | {y:.4f} | {r.p_v:.3f} | {r.xyzs[1] / sun[1]:.3f} | `{h1}`{'*' if c1 else ''} | "
          f"`{_hue_swatch(xyz, (sx, sy))}` | {e['geometricAlbedoXYZS']['label']} | {e['phaseFunction']['label']} | "
          f"{dom} |")
    w("")
    for n, r in mres.items():
        srcs = dict.fromkeys(r.entry["geometricAlbedoXYZS"]["sources"] + r.entry["phaseFunction"]["sources"])
        w(f"- **{r.name}** ({n}). {MOON_NOTES[n]}" + (" Sources: " + ", ".join(f"`{s}`" for s in srcs) + "."
                                                    if srcs else ""))
    w("")
    w("### Moons: zero-phase magnitude vs JPL Horizons\n")
    w("Our V(1,0) (from p_V and the pck00011 radius) against the V(1,0) and geometric albedo printed in each Horizons "
      "satellite header (JPL's compiled physical parameters; references are not given there). Horizons' APmag for "
      "the regular moons is that V(1,0) + 5 log10(rΔ), with no phase term (checked to 0.002 mag at all epochs), "
      "except Io and Ganymede (below); for the irregular satellites it includes a phase term.\n")
    w("| moon | R (km) | p_V ours | Horizons albedo | V(1,0) ours | V(1,0) Horizons | ours − Horizons |\n"
      "|---|---|---|---|---|---|---|")
    for n, r in mres.items():
        hv = horizons.header_values(mtexts[n])
        hvv = hv.get("V(1,0)")
        h = float(hvv.split()[0]) if hvv else None
        if h is None:   # Charon: header has no V(1,0); APmag - 5 log10(rΔ) is constant
            row = horizons.parse(mtexts[n])[0]
            h = row.apmag - 5 * math.log10(row.r_au * row.delta_au)
            hvv = f"{h:+.2f} (from APmag)"
        w(f"| {r.name} | {r.radius_km:.1f} | {_fmt(r.p_v, '{:.3f}')} | {hv.get('Geometric Albedo', 'n/a')} | "
          f"{_fmt(r.v10)} | {hvv} | {_fmt(None if r.v10 is None else r.v10 - h)} |")
    w("")
    w("Reading the differences:\n")
    w("- **Galilean moons, Titan, Deimos, Dione**: within 0.12 mag. (For Callisto, JPL's own V(1,0) = -1.05 and "
      "albedo 0.17 are not consistent with each other at the pck00011 radius: -1.05 implies p ≈ 0.20.)\n"
      "- **Mimas −0.20, Enceladus +0.13, Tethys +0.21, Rhea +0.16**: Filacchione's albedos exclude the opposition "
      "surge; JPL's values are older compilations (e.g. Enceladus p = 1.04). Since M3 the phase function adds the surge "
      "(Φ(0) = 1.15-1.25; see M3 below); HST at true opposition is brighter still.\n"
      "- **Ariel −0.47, Umbriel −0.35, Titania −0.24, Oberon −0.25**: HST albedos (Karkoschka 2001) include the "
      "narrow opposition surge. Horizons' albedos are much lower (Ariel 0.34), like the Voyager-based albedos that "
      "DeColibus et al. (2026) note fall below Karkoschka's because Voyager lacked small-phase data.\n"
      "- **Phobos −0.19**: Hapke albedos with a strong surge (B0 = 2.3) vs JPL's p = 0.06.\n"
      "- **Triton −0.14**: p_V = 0.86 (Buratti et al. 2011) vs JPL's 0.7.\n"
      "- **Irregular satellites −0.1…−0.9**: Grav et al.'s (2015) compiled H values are brighter than the V(1,0) in "
      "Horizons' headers (Leda by 0.87 mag). Our V(1,0) equals H by construction. Their Horizons APmag includes a "
      "phase law, so the apparent-magnitude differences below mix the two.\n")
    w("### Moons: apparent magnitude vs Horizons APmag\n")
    w("*ours* = our V(1,0) + 5 log10(rΔ) + our phase function, at Horizons' r, Δ, α (from Earth). n/a: α outside "
      "our phase function's domain, or photometry unknown.\n")
    w("| moon | date | α (°) | Horizons | ours | ours − Horizons |\n|---|---|---|---|---|---|")
    for c in mcomps:
        d = None if (c.ours is None or c.horizons is None) else c.ours - c.horizons
        w(f"| {c.name} | {c.row.date[:11]} | {c.row.phase_deg:.2f} | {_fmt(c.horizons)} | {_fmt(c.ours)} | "
          f"**{_fmt(d)}** |")
    io_rows = horizons.parse(mtexts[501])
    ga_rows = horizons.parse(mtexts[503])

    def implied(rows, n):
        h = float(horizons.header_values(mtexts[n])["V(1,0)"])
        return [(rw.apmag - 5 * math.log10(rw.r_au * rw.delta_au) - h) / rw.phase_deg for rw in rows]

    w("")
    w("- **Io and Ganymede: Horizons appears to be wrong.** Their APmag implies linear phase coefficients of "
      f"{np.mean(implied(io_rows, 501)):.3f} and {np.mean(implied(ga_rows, 503)):.3f} mag/deg (the same at all three "
      "epochs, so not eclipses), about ten times Mayorga et al.'s measured curves (Io GRN: "
      f"{-2.5 * math.log10(moons._poly(moons.mayorga_polys(501)['GRN'], 8.0) / moons.mayorga_polys(501)['GRN'][0]) / 8.0:.3f}"
      " mag/deg over 0-8°) and than Europa's and Callisto's own Horizons coefficients "
      f"({np.mean(implied(horizons.parse(mtexts[502]), 502)):.3f}, {np.mean(implied(horizons.parse(mtexts[504]), 504)):.3f}"
      " mag/deg). At α = 8° Horizons makes Io 3.4 mag too faint. Worth reporting to JPL.\n"
      "- **Phobos +1.2…+1.6 at α = 25-38°**: Horizons applies no phase term; the H-G curve dims Phobos by that much.\n"
      "- **Saturnian and Uranian moons**: the differences equal the V(1,0) differences above plus our phase term "
      "(−0.09…+0.11 mag at these epochs for Saturn's moons, including their surge since M3; up to 0.45 mag for "
      "the Uranian moons' surge).\n")


def _rings_section(w) -> None:
    rj, diag = rings.rings_json(None)
    w("## Rings (`rings.json`)\n")
    w("Normal optical depth τ⊥ from one occultation per system (label **measured**). Reflectance: Saturn's is a "
      "single-scattering model calibrated on Voyager and HST measurements (label **estimated**; the measurements "
      "themselves are also in the product, **measured**); Jupiter's, Uranus's and Neptune's are **unknown**. Values "
      "below are summaries of the product.\n")
    w("| planet | profile | radius range (km) | bins | observation | reflectance |\n|---|---|---|---|---|---|")
    names = {"599": "Jupiter", "699": "Saturn", "799": "Uranus", "899": "Neptune"}
    for key, s in rj.items():
        od = s["opticalDepth"]["value"]
        if od is None:
            w(f"| {names[key]} | unknown | | | | {s['reflectance']['label']} |")
            continue
        for prof in od:
            ob = prof["observation"]
            w(f"| {names[key]} | {prof['name']} | {prof['radiusKm'][0]:.0f}-{prof['radiusKm'][-1]:.0f} | "
              f"{len(prof['radiusKm'])} | {ob['instrument']}, {ob['star']} {ob['direction']} {ob['start'][:16]}, "
              f"B = {ob['ringElevationDeg']:.1f}° | {s['reflectance']['label']} |")
    w("")
    p = diag["699"]
    w("Saturn, median τ⊥ by region (region limits are round numbers for this summary, not a product):\n")
    w("| region | radii (km) | median τ⊥ | max τ⊥ | bins at/above max detectable |\n|---|---|---|---|---|")
    prof = rj["699"]["opticalDepth"]["value"][0]
    tmax = np.array([np.nan if v is None else v for v in prof["maxTau"]])
    for name, lo, hi in (("C ring", 74500, 92000), ("B ring", 92000, 117500), ("Cassini Division", 117600, 122000),
                         ("A ring", 122100, 136770), ("Encke Gap", 133450, 133750)):
        m = (p.radius >= lo) & (p.radius <= hi)
        tt = p.tau[m]
        sat = np.nansum(tt >= tmax[m])
        w(f"| {name} | {lo}-{hi} | {np.nanmedian(tt):.3f} | {np.nanmax(tt):.2f} | {int(sat)} |")
    w("")
    w("Transmission of a ray crossing the ring plane at elevation B is exp(−τ⊥/|sin B|) to first order; in the A and "
      "B rings self-gravity wakes change the slant optical depth with viewing azimuth by tens of percent. Saturn's "
      "equinox was in May 2025, so the Sun stays low over the rings throughout the window.\n")
    _ring_reflectance_section(w, rj, diag)


def _ring_reflectance_section(w, rj, diag) -> None:
    from . import albedo, phase as ph, ring_check, ring_reflectance as rr
    m = diag["699-model"]
    refl = rj["699"]["reflectance"]["value"]
    w("### Saturn's ring reflectance\n")
    w("Measured inputs: the Voyager 2 lit-face and Voyager 1 unlit-face ISS clear-filter I/F profiles (PDS VG_2810, "
      "10 km bins) and Salo & French's (2010) HST WFPC2 phase curves of the C, B and A rings (5 filters 336-814 nm, "
      "α = 0.25-6.3°, six effective elevations 4.5-26.1°, their Table 4). The model is the classical "
      "single-scattering many-particle-thick ring (Chandrasekhar 1960; Salo & French Eq. 6) with the particle "
      "term ϖP taken from the HST curves (≤ 6.3°), joined to Voyager at 47° by a power-law particle phase function "
      "(π − α)^n, and with radial structure and the unlit face fitted to the Voyager profiles. Formula and "
      "assumptions: docs/architecture.md §6.\n")
    lit = m.lit
    b_l = math.degrees(math.asin(rr.mu_eff(math.sin(math.radians(lit.obs_elev)), math.sin(math.radians(lit.solar_elev)))))
    w(f"**Two independent anchors agree with a Callisto-like particle phase function.** Joining the HST ϖP at 6.3° "
      f"(at the Voyager 2 effective elevation, {b_l:.1f}°) to the Voyager 2 mean at 47° needs n per region below; "
      f"Salo & French use n = {rr.POWER_LAW_PUBLISHED} (Callisto, Dones et al. 1993) for the same rings. Particle "
      "ϖP for the Y channel and the chromaticity of the light the rings reflect (x, y of sunlight × ϖP) at "
      f"Beff = {m.beff[3]:.1f}°:\n")
    sun = solar.irradiance_xyzs()
    ks = [list(rr.PHASE_GRID).index(a) for a in (0.25, 6.3, 47.0)]
    w("| region | radii (km) | mean τ⊥ (UVIS) | n | ϖP_Y 0.25° | ϖP_Y 6.3° | ϖP_Y 47° | x, y at 0.25° | x, y at ≥ 6.3° |"
      "\n|---|---|---|---|---|---|---|---|---|")
    for reg, (name, lo, hi) in rr.REGIONS.items():
        tab = m.w_xyzs[reg][3]
        xy = []
        for k in (ks[0], ks[1]):
            c = tab[k, :3] * sun[:3]
            xy.append(f"{c[0] / c.sum():.4f}, {c[1] / c.sum():.4f}")
        w(f"| {name} | {lo:.0f}-{hi:.0f} | {m.region_check[reg]['mean_tau']:.3f} | {m.n[reg]:.2f} | "
          f"{tab[ks[0], 1]:.3f} | {tab[ks[1], 1]:.3f} | {tab[ks[2], 1]:.3f} | {xy[0]} | {xy[1]} |")
    sat = bodies.build_body(699)
    gc = sat.xyzs[:3] / sat.xyzs[:3].sum()
    w(f"\nFor comparison Saturn's globe: x, y = {gc[0]:.4f}, {gc[1]:.4f}. The rings are a paler tan than the "
      "globe, the B and A rings slightly redder than the C ring, and all redden with phase angle up to 6.3° "
      "(beyond, the colour is held at its 6.3° value: an assumption). ϖP ≫ 1 near opposition is the particles' "
      "backscattering phase function times their albedo, not an albedo above 1.\n")
    b = (m.radius >= 100000) & (m.radius <= 107000)
    w(f"Unlit face: in the B ring core (100 000-107 000 km, median τ⊥ = {np.median(m.tau[b]):.2f}) the Voyager 1 "
      f"unlit profile needs an effective optical depth of median {np.median(m.unlit_tau[b]):.2f}: light reaches the "
      "unlit side by multiple scattering and through gaps between self-gravity wakes, which single scattering at "
      "τ⊥ cannot produce. The fitted unlitTau/unlitGain reproduce that one geometry; at others the unlit face is the "
      "least certain part of the model.\n")
    w("**Independent check: Saturn's system brightness.** Mallama & Hilton (2018) fitted Saturn's V magnitude with "
      "rings (Eq. 10) and of the globe alone (Eq. 11) to ground photometry (α ≤ 6.5°, β ≤ 27°); their difference is "
      "the net light the rings add (ring light seen minus globe light the rings block). The model gives the same "
      "quantity by integrating over the ring plane with Saturn as an oblate spheroid that hides and shadows the "
      "rings and with the rings blocking globe light by 1 − exp(−τ⊥/μ) (Y channel ≈ V; Sun and observer at the same "
      "elevation β; the rings' shadow on the globe is ignored, small at these phase angles). Ratio model / M&H:\n")
    alphas = (1.0, 3.0, 6.0)
    w("| β | " + " | ".join(f"α = {a:.0f}°" for a in alphas) + " |\n|---|" + "---|" * len(alphas))
    py = sat.xyzs[1] / sun[1]
    for elev in (5.0, 10.0, 15.0, 20.0, 26.0):
        row = []
        for a in alphas:
            dm = ph.delta_mag(sat.entry["phaseFunction"]["value"], a)
            ours = ring_check.ring_net_flux(m, a, elev, py, dm)["net"]
            mh = ring_check.mallama_net_flux(a, elev, albedo.mean_radius(699), albedo.sun_mag("V"))["net"]
            row.append(f"{ours / mh:.2f}" if mh > 0 else "M&H < 0")
        w(f"| {elev:.0f}° | " + " | ".join(row) + " |")
    e10 = ph.mh_reduced_mag(699, 0.0, rings_beta=0.0) - ph.mh_reduced_mag(699, 0.0)
    e10b = ph.mh_reduced_mag(699, 6.0, rings_beta=0.0) - ph.mh_reduced_mag(699, 6.0)
    w(f"\nAt β = 15-26° the model agrees with ground photometry within 10 % at α = 1-3° (5-22 % at 6°). At β ≤ 10° it "
      "is brighter than the M&H difference, but there the difference is not a clean measure of the rings: M&H's "
      f"Eq. 10 at β = 0 is {e10:+.2f} mag (α = 0°) to {e10b:+.2f} mag (α = 6°) off their globe-only Eq. 11, "
      "comparable to the whole ring term at low β, and the difference turns negative at β = 5°, α = 6° (rings "
      "dimming Saturn). The comparison is inconclusive there. The model's own low-β behaviour rests on the HST data "
      "down to Beff = 4.5°, below which the particle term is held constant.\n")
    w("Domain: 0.25° ≤ α ≤ 47° (brightness unknown outside: the true-opposition spike below 0.25° and the forward "
      f"scattering by dust at large α are not in the data used); radii {refl['radiusStartKm']:.0f}-"
      f"{refl['radiusStartKm'] + refl['radiusStepKm'] * (refl['count'] - 1):.0f} km. Not modelled: the A ring's "
      "azimuthal (wake) asymmetry, spokes, the F ring.\n")
    w("Jupiter, Uranus, Neptune: no calibrated machine-readable reflectance profile was found (the PDS Ring-Moon "
      "Systems Node's Voyager ring-profile series VG_28xx has imaging (ISS) I/F profiles for Saturn only; other "
      "published photometry of these rings is in figures), so their reflectance stays unknown.\n")


def _fixups_section(w) -> None:
    w("## M1 follow-ups (M2)\n")
    w("- **DSCOVR/EPIC (Earth)**: not usable without credentials. `https://asdc.larc.nasa.gov/data/DSCOVR/EPIC/L1B/` "
      "now answers 301 → `https://cmr.earthdata.nasa.gov/search/site/collections/directory/LARC_CLOUD/...`, i.e. "
      "the archive moved to NASA Earthdata Cloud (collection DSCOVR_EPIC_L1B v4, C4025357058-LARC_CLOUD). Granule "
      "URLs (`https://data.asdc.earthdata.nasa.gov/asdc-prod-protected/DSCOVR/DSCOVR_EPIC_L1B_4/...h5`, ~300 MB "
      "each) and the OPeNDAP service both answer 302 → `urs.earthdata.nasa.gov/oauth/authorize`: **Earthdata Login "
      "is required**. (Separately, TLS handshakes to asdc.larc.nasa.gov through this environment's proxy are reset "
      "about one time in three.) Only the browse PNGs, and the colour images of epic.gsfc.nasa.gov, are public; "
      "neither is calibrated. (Resolved in the M3 follow-up with Himawari-9 and EPOXI instead; with an Earthdata "
      "account the pipeline could also integrate the 10 calibrated EPIC bands over the disk.)\n"
      "- **Moon beyond 120°**: no accessible measured whole-disk phase curve beyond 120° was found (Lane & Irvine "
      "stop at 120°). Still unknown.\n"
      "- **Opposition surge, Moon and Mercury**: the Moon now uses the ROLO model (M3 below). Mercury's M&H curve "
      "stays defined from 2° (from Earth, α < 2° happens only within ~0.6° of the Sun).\n"
      "- **Buie et al. (2010) source record**: the M1 download ledger held the sha256 of a bot-check page served "
      "in place of the PDF. Fixed (PDF validation; hand-retrieved copy with recorded sha256); transcribed numbers "
      "re-checked against the real PDF.\n")


def _m3_section(w) -> None:
    from . import phase as ph, rolo
    w("## M3: the Moon from ROLO\n")
    m = rolo.channel_model()
    p_y = rolo.lane_irvine_py()
    sun = solar.irradiance_xyzs()
    li_a, li_dm = ph._lane_irvine_phase()
    w("The ROLO lunar model (Kieffer & Stone 2005, AJ 129, 2887; version 311g) is an empirical fit of whole-Moon "
      "irradiance in 32 bands (350-2384 nm) from the USGS Robotic Lunar Observatory over 1.55° < g < 97°, with "
      "terms for the opposition effect, for which hemisphere is lit (waxing vs waning), and for libration. Table 4 "
      "and Eq. 11 were extracted from the PDF text with their minus signs (the PDF's minus glyph comes out as a "
      "control character) and checked against a rendering of the page, against an independent transcription of "
      "Table 4 (identical) and an independent implementation's constants (identical); Table 5's 'Effect' column "
      "confirms the units (g and Φ in radians in the polynomials, degrees in the exponentials). Converted to the "
      f"CIE channels and refitted per channel (max |Δ ln A| = {m.max_residual:.1e}).\n")
    w("Brightness of the Moon (Y channel, disk-equivalent reflectance A = p·Φ at zero libration, mean of waxing and "
      f"waning) from ROLO and from Lane & Irvine (p_Y = {p_y:.4f} times their V phase curve), and the waxing/waning "
      "ratio from ROLO:\n")
    w("| α | A_Y ROLO | A_Y Lane & Irvine | ROLO / L&I | waxing / waning | x, y (ROLO) |\n|---|---|---|---|---|---|")
    for g in (1.55, 2.0, 3.0, 5.0, 7.0, 10.0, 20.0, 30.0, 45.0, 60.0, 90.0, 97.0):
        ay = float(rolo.mean_phase_y(g))
        li = p_y * 10 ** (-0.4 * float(np.interp(g, li_a, li_dm)))
        a2 = np.exp(m.ln_a(g, np.array([g, -g])))
        c = np.sqrt(a2[0] * a2[1])[:3] * sun[:3]
        w(f"| {g:g}° | {ay:.4f} | {li:.4f} | {ay / li:.3f} | {a2[0, 1] / a2[1, 1]:.3f} | "
          f"{c[0] / c.sum():.4f}, {c[1] / c.sum():.4f} |")
    res = bodies.build_body(301)
    cl = res.xyzs[:3]
    from . import albedo as alb
    li_spec = alb.moon_lane_irvine()
    li_x = cie.xyzs(bin_average(li_spec.wl, li_spec.p) * solar.spectrum().grid)[:3]
    w(f"\nColour of the product (ROLO at 1.55°, geometricAlbedoXYZS): x, y = {cl[0] / cl.sum():.4f}, "
      f"{cl[1] / cl.sum():.4f}; Lane & Irvine's (1973) spectrum, the cross-check: x, y = "
      f"{li_x[0] / li_x.sum():.4f}, {li_x[1] / li_x.sum():.4f} (redder; they flagged a possible ~10 % excess at "
      "600-850 nm in their 1965 data). Albedo ratio to 450 nm at the Lane & Irvine band centres (ROLO at 1.55°, "
      "L&I surge-free at 0°; the ratio compares colour only):\n")
    wl_li = li_spec.wl
    wr, ar = rolo.reference_spectrum()
    w("| λ (nm) | " + " | ".join(f"{x:.0f}" for x in wl_li) + " |\n|---|" + "---|" * len(wl_li))
    w("| ROLO | " + " | ".join(f"{np.interp(x, wr, ar) / np.interp(450, wr, ar):.3f}" for x in wl_li) + " |")
    w("| Lane & Irvine | " + " | ".join(f"{np.interp(x, wl_li, li_spec.p) / np.interp(450, wl_li, li_spec.p):.3f}"
                                      for x in wl_li) + " |")
    w("\nBelow 2° ROLO is brighter than Lane & Irvine's surge-free "
      "extrapolation (the surge); from 5° on it is 6-22 % fainter, i.e. close to Lane & Irvine's own broadband V "
      "(13 % below their narrow bands) up to 45° and steeper beyond. The waxing Moon is brighter, as Lane & Irvine "
      "and Rougier (1934) observed (0.01-0.09 mag between quadrature and full). The product's phase function is "
      "ROLO's A_Y divided by ROLO's reference A_Y(1.55°) for 1.55-97°, Lane & Irvine's curve "
      "shifted to join it for 97-120° (label estimated because of the join); diskReflectanceModel carries the full "
      "ROLO geometry per channel (derived).\n")
    _m3_surges(w)
    _m3_earth(w)


def _m3_surges(w) -> None:
    from . import diskint, phase as ph
    from .common import read_table_json
    w("## M3: opposition surges of Mimas-Rhea, Mercury; Iapetus\n")
    tab = read_table_json("saturnian_opposition.json")
    hst = tab["verbiscer_2007"]["geometric_albedo"]
    w("**Mimas-Rhea.** The VIMS phase curves (Filacchione et al. 2022) are fitted over 10-120° and their albedos are "
      "surge-free. Below 10° the phase function now follows measured opposition curves: Enceladus's (Verbiscer et "
      "al. 2005, HST, data ~0.25-20°) and Rhea's (Domingue et al. 1995; Verbiscer & Veverka 1989), as fitted by Deau "
      "et al. (2009, Table 3, linear-exponential), joined to the VIMS curve at 10°. Mimas, Tethys and Dione use the "
      "mean of the two shapes (no accessible curve of their own). Verbiscer et al.'s (2007) HST true-opposition paper "
      "and supplement were not accessible (science.org 403). Their geometric albedos, as quoted by Filacchione et al. "
      "(2022), are used only for comparison:\n")
    w("| moon | p_V (VIMS, surge-free) | Φ(0) | p_V·Φ(0) | HST p (Verbiscer 2007) | HST / ours | Δm 1° old → new | "
      "Δm 3° old → new | Δm 6° old → new |\n|---|---|---|---|---|---|---|---|---|")
    res = bodies.build_all(None, [601, 602, 603, 604, 605])
    for n, r in res.items():
        pf = r.entry["phaseFunction"]["value"]
        t_ = moons.filacchione_rows(n)
        i = int(np.argmin(np.abs(t_["wl"] - moons.PHASE_ROW_NM)))
        a0, a1, a2 = float(t_["a0"][i]), float(t_["a1"][i]), float(t_["a2"][i])

        def old(a):
            return -2.5 * math.log10((a0 + a1 * a + a2 * a * a) / a0 * diskint.akimov_integral(a))
        phi0 = 10 ** (-0.4 * ph.delta_mag(pf, 0.0))
        cells = " | ".join(f"{old(a):+.2f} → {ph.delta_mag(pf, a):+.2f}" for a in (1.0, 3.0, 6.0))
        w(f"| {r.name} | {r.p_v:.3f} | {phi0:.3f} | {r.p_v * phi0:.3f} | {hst[str(n)]:.2f} | "
          f"{hst[str(n)] / (r.p_v * phi0):.2f} | {cells} |")
    w("\nThe surge brightens these moons by 0.15-0.24 mag at zero phase and 0.01-0.06 mag at 1° relative to the "
      "surge-free extrapolation (Mimas, whose VIMS curve is steep, comes out 0.01-0.02 mag fainter than before at "
      "3-6°). Even so, the HST true-opposition albedos are 1.2-1.4× higher. The measured opposition "
      "curve of Enceladus puts its level at 10° at 1.38 × R(10°)/R(0) ≈ 1.00, vs VIMS 0.81, so the difference is a "
      "difference of absolute level between the HST and VIMS data sets at all small phase angles, not a missing part "
      "of the surge. We keep the VIMS level (the albedo) and report the difference. Label: estimated. A 2018 "
      "corrigendum to Deau et al. (2009) exists and could not be accessed.\n")
    w("**Mercury.** Mallama & Hilton's curve is measured from 2° and includes the rising surge down to 2°. Its "
      "zero-phase reference is surge-inclusive (V(1,0) = −0.694 from Mallama et al. 2002's physical model), so views "
      "at α ≥ 2° are not too faint. Below 2° the curve stays unknown rather than interpolated. From Earth, α < 2° "
      "occurs only within ~0.6° of the Sun. Mallama et al. (2002, Icarus 155, 253), whose model would cover 0-2°, was "
      "not accessible.\n")
    w("**Iapetus.** Still unknown. No machine-readable orbital-longitude lightcurve was found: the arXiv papers on "
      "Iapetus are not photometric time series, and VizieR's Iapetus tables are astrometric only. The classical "
      "lightcurves (Millis 1977; Squyres et al. 1984; Buratti & Mosher 1995) and the Cassini-era ones are not openly "
      "accessible. Deau et al. (2009) give only morphological fit parameters of a trailing-side opposition curve "
      "(Franklin & Cook 1974), which fixes neither the albedo nor the longitude dependence.\n")


def _m3_earth(w) -> None:
    from . import albedo as alb, earth
    w("## M3 follow-up: the Earth from Himawari-9 and EPOXI\n")
    hd = earth.himawari_disk()
    w("**Himawari-9 (JMA; NOAA Open Data on AWS).** One full-disk AHI scan, 2025-03-20 02:30-02:39 UTC: the "
      "satellite's local noon at 140.7°E one day before the equinox, so the Sun is almost behind the satellite "
      f"(α = {hd['alpha_deg']:.2f}° from the Earth's centre; {hd['phase_min']:.1f}-{hd['phase_max']:.1f}° per pixel "
      "because the satellite is only 6.6 Earth radii away). 92.6 million 1 km pixels per band (band 3 averaged from "
      "0.5 km); I/F from the calibrated radiance and the TSIS-1 solar spectrum over each band's response; "
      "integrated over the disk as seen from far away. The satellite does not see the outer 2.3 % of the "
      "projected disk; that annulus takes the mean I/F of the 70-80° view-zenith ring (≤ 2.3 % of A).\n")
    w("| band | λ_eff (nm) | disk reflectance A = p·Φ(2.4°) | annulus share | E_band (W m⁻² µm⁻¹) | JMA π/c′ |"
      "\n|---|---|---|---|---|---|")
    import math as _m
    for b in (1, 2, 3, 4):
        d = hd["bands"][str(b)]
        w(f"| B{b:02d} | {filters.effective_wavelength(f'ahi9.B{b:02d}'):.1f} | {d['A']:.4f} | "
          f"{100 * d['annulus_fraction_of_A']:.1f} % | {d['E_band']:.0f} | {_m.pi / d['c_prime']:.0f} |")
    r = bodies.build_body(399)
    psg = alb.payne(399, None)
    e = solar.spectrum()
    from .. import cie as _cie
    pc = _cie.xyzs(bin_average(psg.wl, psg.p) * e.grid)
    sun = solar.irradiance_xyzs()
    w(f"\nProduct: p_V = {r.p_v:.3f} (V(1,0) = {r.v10:+.3f} at R = {r.radius_km:.1f} km), x, y = "
      f"{r.xyzs[0] / r.xyzs[:3].sum():.4f}, {r.xyzs[1] / r.xyzs[:3].sum():.4f} (the pale blue dot). For comparison: "
      f"the PSG model used until now (Payne et al. 2026, EPIC-validated) p_V = "
      f"{filters.band_average('V', psg.wl, psg.p):.3f}, x, y = {pc[0] / pc[:3].sum():.4f}, "
      f"{pc[1] / pc[:3].sum():.4f}; Mallama et al. (2017) / Mallama & Hilton (2018) p_V = 0.434 (V(1,0) = −3.99). "
      "The measurement confirms the low value.\n")
    w("**EPOXI (Deep Impact HRIV, PDS SBN).** 84 calibrated images (7 filters × 4 times × 3 days) of the whole "
      "Earth from 0.11-0.34 AU, aperture photometry with the archive's own I/F conversion, 24-hour means. They are "
      "an independent check (different instrument, years and phase angles). Measured A against the product's "
      "p(λ)·Φ(α), green filter:\n")
    w("| day | α | measured A (24-h mean; range) | product p·Φ | ratio |\n|---|---|---|---|---|")
    for c in earth.epoxi_check():
        note = "" if c["aperture_inside_frame"] else " (the Earth nearly fills the frame: aperture clipped)"
        w(f"| {c['epoch']} | {c['phase']:.1f}° | {c['measured']:.4f} ({c['day_range'][0]:.4f}-"
          f"{c['day_range'][1]:.4f}){note} | {c['predicted']:.4f} | {c['ratio']:.2f} |")
    ep = earth.epoxi_disk()
    vg = ep["2008-03|VIOLET"]["A_mean"] / ep["2008-03|GREEN"]["A_mean"]
    ours = (filters.band_average("hriv.Violet", r.spectrum.wl, r.spectrum.p) /
            filters.band_average("hriv.Green", r.spectrum.wl, r.spectrum.p))
    w(f"\nColour check: EPOXI violet/green (350/550 nm filters) = {vg:.2f} at 57.7°, the product's (whose "
      f"spectrum below 0.47 µm follows the PSG model's shape) {ours:.2f}. Mallama & Hilton's p = 0.434 × the same "
      "model curve would predict about twice the EPOXI brightness at 58-77°. The phase curve stays the model shape "
      "(estimated): the three EPOXI days scatter ±20-30 % about it, as much as the Earth varies between days.\n")


if __name__ == "__main__":
    main()
