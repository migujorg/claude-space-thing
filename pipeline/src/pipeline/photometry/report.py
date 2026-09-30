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
from .common import read_table_csv

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
    399: "Spectral shape and level: a radiative-transfer MODEL (PSG with MERRA-2 clouds for 2022 June 21) validated "
         "against DSCOVR/EPIC; no machine-readable measured whole-disk zero-phase visible spectrum was reachable (the "
         "EPIC L1B granules are in NASA Earthdata Cloud behind Earthdata Login; see 'Fix-ups' below). Its p_V = 0.22 "
         "is half of "
         "Mallama et al.'s 0.434 (used by Mallama & Hilton and Horizons). A simple check favours the low value: for a "
         "disk of mean reflectance factor ⟨R⟩ seen at zero phase p ≈ ⅔⟨R⟩, and Earth's ⟨R⟩ ≈ Bond albedo ≈ 0.3 "
         "gives p ≈ 0.2. The high value comes from EPOXI photometry at 58-77° phase extrapolated to 0° with a model "
         "phase curve. Real Earth varies by tens of percent with clouds. Phase curve: model (estimated).",
    301: "Lane & Irvine (1973) whole-disk narrow-band geometric albedos, interpolated linearly between 9 bands. "
         "Opposition surge EXCLUDED from both albedo and phase curve (the real full Moon is tens of percent brighter "
         "at α < 5°). The narrow-band data give a V-band albedo 13 % above the authors' own broadband V (they "
         "suspected their broadband transformation) and they flag a possible ~10 % excess at 600-850 nm in the 1965 "
         "data; the Moon may therefore render slightly too red and too bright. Phase curve: measured 6-120°.",
    499: "Reconstructed from Mallama et al. (2017) photometric Johnson UBVRI albedos (rotation/season averaged): a "
         "piecewise-linear spectrum through five band averages. Brightness and B-V are measured; the shape between "
         "bands is assumed (no 530 nm shoulder). A PSG model composite (Payne et al.) was rejected: its B albedo is "
         "45 % below the photometry. Phase curve: measured to 50°, assumed beyond (estimated).",
    599: "Karkoschka (1998) ESO spectrophotometry at 6.8° phase, scaled to 0° with Mallama & Hilton's V phase law "
         "(assumption: same at all λ, +2.4 %). Agrees with Mallama et al. (2017) B, V, Rc to ≤ 2 % and with Horizons "
         "to 0.02 mag. Strong data. Phase curve: ground + Cassini (measured).",
    699: "Karkoschka (1998) at the 1995 ring-plane crossing, i.e. the GLOBE without rings (what the renderer draws; "
         "rings are M2). Scaled from 5.7° to 0° with an assumed phase law (+1.7 %). 5 % fainter in V than Mallama & "
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
         "model, 10-120° derived, 0-10° extrapolated without the surge.",
    602: "As Mimas. Enceladus is the brightest body in the solar system; its known strong opposition surge is NOT in "
         "these numbers.",
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
    src_short = {199: "Payne+2026 (MASCS)", 299: "Payne+2026 (VIRS)", 399: "Payne+2026 (PSG model)",
                 301: "Lane & Irvine 1973", 499: "Mallama+2017 UBVRI", 599: "Karkoschka 1998",
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
      "- **Earth +0.75**: our Earth is half as bright as Mallama & Hilton's (see the Earth note above). This is the "
      "largest open discrepancy; we believe the DSCOVR-validated value, but neither is a clean measurement.\n"
      "- **Saturn +0.13…+0.30**: Horizons includes the rings for α < 6.5° (Eq. 10); our entry is the globe alone. "
      "Against the globe-only Eq. 11 we are +0.05 (see the consistency table).\n"
      "- **Moon −0.07 (α = 43°), −0.21 (α = 100°), n/a at 130°**: Horizons uses V(1,α) = 0.23 + 0.026α + "
      "4×10⁻⁹α⁴ (Allen's law; our fixtures reproduce it to 0.0002 mag), whose 0.23 equals Lane & Irvine's broadband "
      "V. Ours is 0.08 mag brighter at zero phase (we use their narrow-band albedos, see the Moon note) and follows "
      "their measured V phase curve, which dims less than Allen's law at large α; valid to 120° only.\n"
      "- **Pluto +0.16…+0.19**: Horizons' Pluto includes Charon, V(1,α) ≈ −1.00 + 0.041α (inferred from the "
      "fixtures; the manual does not cite a source); we add Charon from the same HST paper for this comparison. "
      "Buie et al.'s 2002-2003 Pluto + Charon is 0.16 mag fainter than Horizons' system magnitude (the radius "
      "does not enter this comparison).\n")
    _moons_section(w, mres, mtexts, mcomps, sun, sx, sy)
    _rings_section(w)
    _fixups_section(w)
    w("## Weak data, in order of concern\n")
    w("1. **Earth**: model spectrum; factor-2 disagreement with the magnitude used by Horizons.\n"
      "2. **Pluto**: colour from two broadband points; phase curve only to 1.74°.\n"
      "3. **Venus blue end**: ±20 % between datasets below 480 nm, which sets how yellow Venus looks.\n"
      "4. **Moon**: 1964-65 photometry with a known internal 13 % V inconsistency; opposition surge excluded.\n"
      "5. **Uranus/Neptune epoch**: 1995 spectra; both have changed since (Uranus seasonally, strongly in the red).\n"
      "6. **Mars and Mercury shapes**: Mars between broadband nodes; Mercury from disk-resolved spectra.\n"
      "7. **Phase corrections for Jupiter/Saturn** to zero phase (+2.4 %, +1.7 %) assume a grey phase law.\n"
      "8. **Opposition surges of the moons**: excluded for the Moon and Mimas-Rhea (Earth views too faint by tens of "
      "percent); included for Uranian moons, Triton, Charon, Phobos.\n"
      "9. **Iapetus and Miranda** unknown; **Deimos** grey placeholder; **Titan** and **Triton**/**Charon** phase "
      "curves only near opposition.\n"
      "10. **Ring brightness** unknown for every ring system (only optical depth is measured here).\n"
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
      "surge; JPL's values are older compilations (e.g. Enceladus p = 1.04). Earth-based magnitudes of these moons "
      "near opposition are brighter than both by the surge.\n"
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
      "(≤ 0.1 mag at Earth-based α for Saturn's moons; up to 0.45 mag for the Uranian moons' surge).\n")


def _rings_section(w) -> None:
    rj, diag = rings.rings_json(None)
    w("## Rings (`rings.json`)\n")
    w("Normal optical depth τ⊥ from one occultation per system (label **measured**); lit-face reflectance **unknown** "
      "for every system. Values below are summaries of the product.\n")
    w("| planet | profile | radius range (km) | bins | observation | reflectance |\n|---|---|---|---|---|---|")
    names = {"599": "Jupiter", "699": "Saturn", "799": "Uranus", "899": "Neptune"}
    for key, s in rj.items():
        od = s["opticalDepth"]["value"]
        if od is None:
            w(f"| {names[key]} | unknown | | | | unknown |")
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
      "equinox was in May 2025, so the Sun stays low over the rings throughout the window. Their reflectance is "
      "unknown here: the renderer must mark ring brightness as not measured.\n")


def _fixups_section(w) -> None:
    w("## M1 follow-ups (M2)\n")
    w("- **DSCOVR/EPIC (Earth)**: not usable without credentials. `https://asdc.larc.nasa.gov/data/DSCOVR/EPIC/L1B/` "
      "now answers 301 → `https://cmr.earthdata.nasa.gov/search/site/collections/directory/LARC_CLOUD/...`, i.e. "
      "the archive moved to NASA Earthdata Cloud (collection DSCOVR_EPIC_L1B v4, C4025357058-LARC_CLOUD). Granule "
      "URLs (`https://data.asdc.earthdata.nasa.gov/asdc-prod-protected/DSCOVR/DSCOVR_EPIC_L1B_4/...h5`, ~300 MB "
      "each) and the OPeNDAP service both answer 302 → `urs.earthdata.nasa.gov/oauth/authorize`: **Earthdata Login "
      "is required**. (Separately, TLS handshakes to asdc.larc.nasa.gov through this environment's proxy are reset "
      "about one time in three.) Only the browse PNGs, and the colour images of epic.gsfc.nasa.gov, are public; "
      "neither is calibrated. Earth's spectrum therefore remains the "
      "EPIC-validated model; with an Earthdata account (a token in the environment) the pipeline could fetch a few "
      "granules and integrate the 10 calibrated EPIC bands over the disk.\n"
      "- **Moon beyond 120°**: no accessible measured whole-disk phase curve beyond 120° was found (Lane & Irvine "
      "stop at 120°; the ROLO model of Kieffer & Stone 2005, AJ 129, 2887, covers 1.55-97°). Still unknown.\n"
      "- **Opposition surge, Moon and Mercury**: not changed. The best candidate for the Moon is the ROLO model "
      "(32 bands 350-2450 nm, libration terms, two exponential opposition terms down to 1.55°); its Table 4 "
      "(320 coefficients) loses its minus signs in text extraction and needs a careful visual transcription. "
      "Mercury's M&H curve stays defined from 2° (from Earth, α < 2° happens only within ~0.6° of the Sun).\n"
      "- **Buie et al. (2010) source record**: the M1 download ledger held the sha256 of a bot-check page served "
      "in place of the PDF. Fixed (PDF validation; hand-retrieved copy with recorded sha256); transcribed numbers "
      "re-checked against the real PDF.\n")


if __name__ == "__main__":
    main()
