"""photometry.json `spatialModel`: published disk-resolved photometric laws (schema SpatialPhotometricModel).

A spatial law only says how a body's light is spread over its disk; the renderer rescales it so that the disk
integral stays geometricAlbedoXYZS · Φ(α) (docs/architecture.md §4.3-4.4). Without one the renderer uses Lambert.

Sources (all published fits; none from the project's own validation images, which stay an independent test):
  * Jupiter, Saturn, Uranus, Neptune: the Minnaert exponent k per filter with which the Hubble OPAL team removed the
    limb darkening of the maps the app shows (cycle README, MAST HLSP doi:10.17909/T9G593; the same epoch as
    surf_giants.py uses), interpolated to the effective wavelength of the Y channel.
  * Europa, Ganymede, Callisto: Hapke (1993) parameters of Domingue & Verbiscer (1997), 550 nm, the mean of the
    leading and trailing hemispheres (disk-integrated Voyager and telescopic phase curves), from the open-access
    reproduction in Belgacem (2019).
  * Pluto, Charon, Triton: Hapke (2012) parameters of Verbiscer et al. (2022) Table 14 (disk-integrated phase curves
    from Earth, HST and New Horizons).
  * Saturn additionally: the measured phase dependence of its limb darkening from Pioneer 11 (Barkstrom law of Dones et
    al. 1993, via Dyudina et al. 2016), converted to a Minnaert k(α) table.
  * Io: Hapke (1981/1984) parameters of Simonelli & Veverka (1986), Voyager violet filter.
  * Mars: the mean Martian surface BRDF of Vincendon (2013) in Hapke (1993) form (OMEGA and CRISM, aerosols removed).

Label criterion. A spatial law would be 'measured' only if (i) it was fitted to disk-resolved images of that body,
(ii) it is used only within the fitted phase-angle range, and (iii) it holds per channel. No entry here meets all
three: the schema gives one law for X, Y, Z and S together, OPAL's k are applied at every phase angle (the OPAL images
reach α ≤ 11°), and the Hapke sets come from disk-integrated fits (their spatial distribution is the model's, not
observed) or are hemisphere or terrain averages. So every entry is 'estimated', with its method stating the
assumption. The phase-angle range the source data cover is stated in the method; `validPhaseDeg` is not set, so the
renderer uses the law at every phase angle rather than falling back to Lambert.

Not covered (no published fit available to scripted clients, or the law's form is not one the renderer supports):
Mercury (MESSENGER MDIS Hapke/Kaasalainen-Shkuratov fits of Domingue et al. 2016 are behind a publisher bot check
and not on arXiv; the MDIS archive SIS names the models but gives no parameter values), the Saturnian mid-sized
moons (Filacchione et al. 2022 fit an Akimov disk function, which the renderer does not implement yet), the Uranian
moons and the rest.
"""

from __future__ import annotations

import math
from functools import lru_cache

import numpy as np

from .. import cie
from ..schema import BuildContext, sourced
from .albedo import _src
from .common import Download, read_table_csv
from .moons import VERBISCER

# ---------------------------------------------------------------------------------------------- sources
BELGACEM_THESIS = Download(
    id="belgacem-2019-thesis", url="https://theses.hal.science/tel-02421378/document", subdir="papers",
    name="Belgacem2019_thesis_tel-02421378.pdf",
    title="Hapke parameters of Europa, Ganymede and Callisto from Domingue & Verbiscer (1997), reproduced in Tables "
          "2.5-2.7",
    citation="Belgacem, I. (2019). Etude photometrique des lunes glacees de Jupiter [Photometric study of Jupiter's "
             "icy moons]. PhD thesis, Universite Paris-Saclay (NNT 2019SACLS386), HAL tel-02421378. Tables 2.5-2.7 "
             "reproduce Domingue, D. & Verbiscer, A. (1997), Re-analysis of the solar phase curves of the icy "
             "Galilean satellites, Icarus 128, 49-74, DOI:10.1006/icar.1997.5730.",
    notes="Open-access thesis (HAL). Tables 2.5-2.7 transcribed to photometry/tables/"
          "domingue_verbiscer_1997_hapke.csv (docs/sources/spatial-photometry.md). The thesis' own regional fits "
          "(Chapter 5) are not used: they include the New Horizons LORRI frames of the validation set.")

VINCENDON = Download(
    id="vincendon-2013", url="https://arxiv.org/pdf/1208.4518v3", subdir="papers", name="arXiv-1208.4518v3.pdf",
    title="Mean Martian surface BRDF in Hapke form (OMEGA and CRISM, aerosols removed)",
    citation="Vincendon, M. (2013). Mars surface phase function constrained by orbital observations. Planetary and "
             "Space Science 76, 87-95 (accepted manuscript arXiv:1208.4518v3).",
    notes="Abstract and Sec. 3: omega = 0.85, theta = 17 deg, c = 0.6, b = 0.12, B0 = 1, h = 0.05, with c the "
          "backward fraction (1 + c_Hapke)/2 of Johnson et al. (2006a).")


DYUDINA_2016 = Download(
    id="dyudina-2016", url="https://arxiv.org/pdf/1511.04415v3", subdir="papers", name="arXiv-1511.04415v3.pdf",
    title="Saturn's Barkstrom-law coefficients A(α), B(α) from Pioneer 11 (Dones et al. 1993), Table 3",
    citation="Dyudina, U., Zhang, X., Li, L., Kopparla, P., Ingersoll, A. P., Dones, L., Verbiscer, A. & Yung, Y. L. "
             "(2016). Reflected light curves, spherical and Bond albedos of Jupiter- and Saturn-like exoplanets. "
             "Astrophysical Journal (accepted manuscript arXiv:1511.04415v3). Table 3 reproduces Dones, L., Cuzzi, "
             "J. N. & Showalter, M. R. (1993), Icarus 105, 184, Table V (fits to the Pioneer 11 reflectance tables "
             "of Tomasko, M. G. & Doose, L. R. (1984), Icarus 58, 1).",
    notes="Transcribed to photometry/tables/dones_1993_saturn_barkstrom.csv (docs/sources/spatial-photometry.md).")

SIMONELLI_1987 = Download(
    id="simonelli-veverka-1987", url="https://ntrs.nasa.gov/api/citations/19870014003/downloads/19870014003.pdf",
    subdir="papers", name="NTRS-19870014003.pdf",
    title="Io's Hapke parameters (Voyager violet filter) of Simonelli & Veverka (1986), quoted in Fig. 1",
    citation="Simonelli, D. P. & Veverka, J. (1987). Io: comparison of photometric scans produced by the Minnaert and "
             "Hapke functions. In: Reports of Planetary Geology and Geophysics Program 1986, NASA (NTRS 19870014003). "
             "The parameters are those of Simonelli, D. P. & Veverka, J. (1986), Phase curves of materials on Io: "
             "interpretation in terms of Hapke's function, Icarus 68.",
    notes="Transcribed to photometry/tables/simonelli_veverka_io_hapke.csv. The report also states that Minnaert k "
          "'generally increases toward higher phase angles' (citing Harris 1961; Goguen 1981; McEwen & Soderblom "
          "1984).")


def opal_readme_download(naif: int) -> Download:
    """The OPAL cycle README of the epoch the surface maps use (surf_giants.PLANETS)."""
    from ..surf_giants import PLANETS, planet_dir
    p = next(x for x in PLANETS if x.naif == naif)
    return Download(
        id=f"opal-readme-{p.name.lower()}-{p.epoch}", url=planet_dir(p) + p.readme,
        subdir=f"surfaces/opal/{p.name.lower()}", name=p.readme,
        title=f"Hubble OPAL {p.name} cycle {p.cycle} README: Minnaert k and I/F scale per filter",
        citation="Simon, A. A., Wong, M. H. & Orton, G. S. (2015). First results from the Hubble OPAL program: "
                 "Jupiter in 2015. ApJ 812, 55. doi:10.1088/0004-637X/812/1/55. Data: Outer Planet Atmospheres "
                 "Legacy (OPAL) High Level Science Product, MAST, doi:10.17909/T9G593 (PI A. A. Simon).",
        notes="The table of the Minnaert correction applied to remove limb darkening, per WFC3/UVIS filter, for the "
              f"{p.epoch} maps; the app's {p.name} albedo map comes from the same maps (surf_giants.py).",
        license="CC BY 4.0")


# ---------------------------------------------------------------------------------------------- giant planets
GIANTS = (599, 699, 799, 899)


def y_effective_wavelength(p_grid: np.ndarray) -> float:
    """Mean wavelength of the Y-channel signal, ∫λ ȳ E☉ p dλ / ∫ȳ E☉ p dλ (nm), for the body's albedo spectrum."""
    from . import solar
    w = cie.cmfs()[:, 1] * solar.spectrum().grid * p_grid
    return float((cie.WAVELENGTHS * w).sum() / w.sum())


def opal_k(naif: int, lam_nm: float, ctx: BuildContext | None = None) -> tuple[float, dict, str]:
    """Minnaert k at lam_nm, linearly interpolated between the OPAL continuum filters that carry a k (held flat
    outside); the per-filter table and the README's source id."""
    from ..surf_giants import METHANE_BANDS, centre_nm, parse_readme
    dl = opal_readme_download(naif)
    readme = parse_readme(dl.fetch().read_text(encoding="latin-1"))
    table = {f: v["minnaertK"] for f, v in readme["filters"].items()
             if v["minnaertK"] is not None and f not in METHANE_BANDS and 360 <= centre_nm(f) <= 830}
    if len(table) < 2:
        raise ValueError(f"{naif}: fewer than two OPAL continuum filters with a Minnaert k")
    fs = sorted(table, key=centre_nm)
    return k_at(table, lam_nm), {f: table[f] for f in fs}, _src(ctx, dl)


def k_at(table: dict[str, float], lam_nm: float) -> float:
    """Minnaert k at lam_nm from {filter: k}, linear in the filters' nominal wavelengths, flat outside."""
    from ..surf_giants import centre_nm
    fs = sorted(table, key=centre_nm)
    return float(np.interp(lam_nm, [centre_nm(f) for f in fs], [table[f] for f in fs]))


def minnaert_equivalent_k(B: float, alpha_deg: float, n: int = 400) -> tuple[float, float]:
    """The Minnaert k closest to the Barkstrom law r ∝ (μμ0/(μ+μ0))^B / μ over the lit, visible disk at phase α:
    weighted least squares of ln r = c + k ln μ0 + (k−1) ln μ with the Barkstrom radiance × projected area as the
    weight (so the fit follows where the light is). Returns (k, flux-weighted rms of the ln-residual)."""
    a = math.radians(alpha_deg)
    xs = (np.arange(n) + 0.5) / n * 2 - 1
    X, Y = np.meshgrid(xs, xs)
    inside = X ** 2 + Y ** 2 < 1
    X, Y = X[inside], Y[inside]
    mu = np.sqrt(1 - X ** 2 - Y ** 2)                     # observer along +z
    mu0 = X * math.sin(a) + mu * math.cos(a)              # Sun in the x-z plane at phase α
    lit = mu0 > 1e-4
    mu, mu0 = mu[lit], mu0[lit]
    r = (mu * mu0 / (mu + mu0)) ** B / mu
    y, x, w = np.log(r * mu), np.log(mu0 * mu), r        # ln(r μ) = c + k ln(μ0 μ)
    xm, ym = np.average(x, weights=w), np.average(y, weights=w)
    k = float(np.sum(w * (x - xm) * (y - ym)) / np.sum(w * (x - xm) ** 2))
    res = y - ym - k * (x - xm)
    return k, float(np.sqrt(np.average(res ** 2, weights=w)))


@lru_cache(maxsize=None)
def _barkstrom() -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for r in read_table_csv("dones_1993_saturn_barkstrom.csv"):
        if r["measured"] == "1":
            out.setdefault(r["band"], []).append(r)
    return out


def saturn_k_table(lam_nm: float) -> tuple[list[float], list[float], list[float], list[float]]:
    """Pioneer 11 phase dependence for Saturn: B(α) interpolated linearly in wavelength between the blue (440 nm) and
    red (640 nm) passbands to lam_nm, and its Minnaert-equivalent k at each tabulated α (0-150°)."""
    t = _barkstrom()
    red, blue = t["red"], t["blue"]
    lr, lb = 1e3 * float(red[0]["wavelength_um"]), 1e3 * float(blue[0]["wavelength_um"])
    u = min(1.0, max(0.0, (lam_nm - lb) / (lr - lb)))
    alphas, Bs, ks, rms = [], [], [], []
    for rr, rb in zip(red, blue):
        assert rr["alpha_deg"] == rb["alpha_deg"]
        B = float(rb["B"]) + u * (float(rr["B"]) - float(rb["B"]))
        k, e = minnaert_equivalent_k(B, float(rr["alpha_deg"]))
        alphas.append(float(rr["alpha_deg"]))
        Bs.append(B)
        ks.append(k)
        rms.append(e)
    return alphas, Bs, ks, rms


def giant_minnaert(naif: int, p_grid: np.ndarray, ctx: BuildContext | None = None) -> dict:
    lam = y_effective_wavelength(p_grid)
    k, table, sid = opal_k(naif, lam, ctx)
    listing = ", ".join(f"{f} {v:g}" for f, v in table.items())
    opal = (f"the k the Hubble OPAL team used to remove the limb darkening of the maps the app shows (cycle README, "
            f"per WFC3/UVIS filter: {listing}; methane-band filters and filters without a correction left out), "
            f"interpolated linearly in wavelength to {lam:.0f} nm, the mean wavelength of the Y-channel signal "
            "(sunlight × ȳ × the body's albedo spectrum)")
    if naif == 699:
        # Measured phase dependence (Pioneer 11) where it exists; OPAL at small phase; held beyond 150°.
        alphas, Bs, ks, rms = saturn_k_table(lam)
        nodes = [0.0] + alphas[1:] + [180.0]
        values = [k] + ks[1:] + [ks[-1]]
        pio = ", ".join(f"{a:.0f}° B {b:.3f} → k {kk:.3f}" for a, b, kk in zip(alphas, Bs, ks))
        return sourced(
            {"kind": "minnaert", "k": {"alphaDeg": nodes, "values": [round(v, 4) for v in values]}},
            "estimated", [sid, _src(ctx, DYUDINA_2016)],
            method=(f"Minnaert law r ∝ μ0^k μ^(k−1) with a phase-dependent k. At 0° (the Earth-based OPAL images, "
                    f"small phase): {opal}, k = {k:.3f}. From 30° to 150°: the measured phase dependence of Saturn's "
                    "disk-resolved reflectance from Pioneer 11 (Tomasko & Doose 1984), as the Barkstrom law "
                    "I/F = (A/μ)(μμ0/(μ+μ0))^B of Dones et al. (1993, Table V; reproduced in Dyudina et al. 2016, "
                    f"Table 3), B interpolated linearly in wavelength from the blue (440 nm) and red (640 nm) "
                    f"passbands to {lam:.0f} nm and converted to the closest Minnaert k over the lit, visible disk "
                    f"(flux-weighted least squares in ln I/F; rms {min(rms[1:]):.2f}-{max(rms[1:]):.2f} in ln): {pio}. "
                    "Between 0° and 30° k is interpolated linearly; beyond 150° (no Pioneer data) it is held at the "
                    "150° value."),
            uncertainty=("k varies with wavelength (the OPAL table; Pioneer blue vs red) and between belts and zones; "
                         "the Minnaert form approximates the Barkstrom law to the rms quoted; OPAL (2025) and Pioneer "
                         "(1979) are different epochs, both near equinox."))
    if naif == 599:
        # Pioneer 10/11 disk-resolved photometry supports a phase-independent law close to k = 1 (Dyudina et al. 2016).
        phase_note = ("The OPAL images are taken from Earth (phase ≤ 11°). Beyond that, k is assumed independent of "
                      "phase angle: Dyudina et al. (2016, Sec. 2.1.1, Fig. 1) found that I/F ∝ μ0 (Minnaert k = 1 at "
                      "every phase) fits the Pioneer 10 and 11 red-filter belt and zone reflectances of Tomasko et al. "
                      "(1978) and Smith & Tomasko (1984) reasonably well up to 150° phase (their Cassini near-infrared "
                      "images show limb brightening at slanted geometry that this form misses). No quantitative "
                      "phase-dependent limb-darkening law of Jupiter was found.")
        srcs = [sid, _src(ctx, DYUDINA_2016)]
    else:
        phase_note = ("The OPAL images are taken from Earth (small phase angles); no measured phase dependence of "
                      "the limb darkening was found for this planet, so k is assumed independent of phase angle "
                      "elsewhere.")
        srcs = [sid]
    return sourced(
        {"kind": "minnaert", "k": round(k, 4)}, "estimated", srcs,
        method=f"Minnaert law r ∝ μ0^k μ^(k−1) with {opal}. One k serves all four channels. {phase_note}",
        uncertainty=("k varies with wavelength across the visible (the table above) and with season and latitude "
                     "(each OPAL epoch has its own); the renderer's single k is exact only near the Y-channel "
                     "wavelength and near the OPAL phase angles."))


# ---------------------------------------------------------------------------------------------- Hapke sets
def porosity_k_from_hs(hs: float) -> tuple[float, float]:
    """Hapke's (2008) porosity factor K and filling factor f from the SHOE width, via hS = -0.3102 f^(1/3)
    ln(1 - 1.209 f^(2/3)) (Verbiscer et al. 2022 Table 16 note b) and K = -ln(1 - 1.209 f^(2/3)) / (1.209 f^(2/3))."""
    def hs_of(f):
        return -0.3102 * f ** (1 / 3) * math.log(1 - 1.209 * f ** (2 / 3))
    lo, hi = 1e-9, (1 / 1.209) ** 1.5 * (1 - 1e-12)
    if not hs_of(lo) < hs < hs_of(hi):
        raise ValueError(f"hS = {hs} outside the porosity relation's range")
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        lo, hi = (mid, hi) if hs_of(mid) < hs else (lo, mid)
    f = 0.5 * (lo + hi)
    x = 1.209 * f ** (2 / 3)
    return -math.log(1 - x) / x, f


@lru_cache(maxsize=None)
def _dv1997() -> dict[int, list[dict]]:
    out: dict[int, list[dict]] = {}
    for r in read_table_csv("domingue_verbiscer_1997_hapke.csv"):
        out.setdefault(int(r["naif"]), []).append(r)
    return out


def dv1997_hapke(naif: int, ctx: BuildContext | None = None) -> dict:
    rows = [r for r in _dv1997()[naif] if r["wavelength_nm"] == "550"]
    keys = ("w", "b", "c", "theta_deg", "h", "B0")
    mean = {k: float(np.mean([float(r[k]) for r in rows])) for k in keys}
    per = "; ".join(f"{r['hemisphere']} w {r['w']}, b {r['b']}, c {r['c']}, θ̄ {r['theta_deg']}°, h {r['h']}, "
                    f"B0 {r['B0']}" for r in rows)
    value = {"kind": "hapke", "w": round(mean["w"], 4), "b": round(mean["b"], 4), "c": round(mean["c"], 4),
             "bs0": round(mean["B0"], 4), "hs": round(mean["h"], 5), "thetaBarDeg": round(mean["theta_deg"], 2),
             "K": 1.0, "hFunction": "hapke1981"}
    return sourced(
        value, "estimated", [_src(ctx, BELGACEM_THESIS)],
        method=("Hapke (1993) law of Domingue & Verbiscer (1997, Icarus 128, 49; DOI:10.1006/icar.1997.5730), "
                "fitted to the disk-integrated 550 nm solar phase curves of each hemisphere from Voyager and "
                f"telescopic photometry ({per}); as reproduced in Belgacem (2019) Tables 2.5-2.7. The law is the "
                "mean of the two hemispheres' parameters. c in Hapke's (1993) convention (backward lobe (1+c)/2). "
                "H function: Hapke's (1981/1993) approximation; no porosity factor (K = 1) and no coherent "
                "backscatter term, as in the fit. The spatial distribution is the model's: the fit is to "
                "disk-integrated brightness."),
        uncertainty=("hemisphere-averaged parameters (they differ by up to 0.13 in w, 0.5 in c and 6° in θ̄); a "
                     "disk-integrated fit constrains the disk-resolved distribution only through the model; printed "
                     "errors w 0.01, b and c 0.005, θ̄ 2°."))


@lru_cache(maxsize=None)
def _verbiscer_t14() -> dict[int, dict]:
    return {int(r["naif"]): r for r in read_table_csv("verbiscer_2022_table14.csv") if r["naif"]}


def verbiscer_hapke(naif: int, ctx: BuildContext | None = None) -> dict:
    r = _verbiscer_t14()[naif]
    hs = float(r["hS"])
    K, f = porosity_k_from_hs(hs)
    value = {"kind": "hapke", "w": float(r["w"]), "b": float(r["b"]), "c": float(r["c"]),
             "bs0": float(r["BoS"]), "hs": hs, "bc0": float(r["BoC"]), "hc": float(r["hC"]),
             "thetaBarDeg": float(r["theta_p_deg"]), "K": round(K, 4), "hFunction": "hapke2002"}
    coverage = {999: "Earth-based and HST near-opposition data and New Horizons LORRI/MVIC to 115° (Hillier et al. "
                     "2021), beyond which Pluto's haze contributes",
                801: "Earth-based near-opposition, Voyager 2 and New Horizons LORRI data to 94°",
                901: "the Charon phase curve of Howett et al. (2021)"}[naif]
    return sourced(
        value, "estimated", [_src(ctx, VERBISCER)],
        method=(f"Hapke (2012) law of Verbiscer et al. (2022) Table 14 for {r['object']}: w {r['w']}, b {r['b']}, "
                f"c {r['c']} (backward lobe (1+c)/2), SHOE hS {r['hS']}, BoS {r['BoS']}, CBOE hC {r['hC']}, "
                f"BoC {r['BoC']}, photometric roughness θ̄p {r['theta_p_deg']}°, fitted to the disk-integrated phase "
                f"curve ({coverage}). K = {K:.3f} from hS through the porosity relation of their Table 16 note b "
                f"(filling factor {f:.3f}). The renderer evaluates Hapke's isotropic multiple-scattering "
                "approximation with the Hapke (2002) H function, whereas the fit used the anisotropic one; the "
                "spatial distribution is the model's, since the fit is to disk-integrated brightness."),
        uncertainty=("parameters strongly coupled (paper Sec. 3.1.1; Table 15 lists the uncertainties); isotropic "
                     "instead of anisotropic multiple scattering; θ̄p is the photometrically detectable roughness."))


def io_hapke(ctx: BuildContext | None = None) -> dict:
    r = read_table_csv("simonelli_veverka_io_hapke.csv")[0]
    w, h, g, th = (float(r[k]) for k in ("w0", "h", "g", "theta_deg"))
    bs0 = math.exp(-w * w / 2)
    return sourced(
        {"kind": "hapke", "w": w, "b": abs(g), "c": 1.0 if g <= 0 else -1.0, "bs0": round(bs0, 4), "hs": h,
         "thetaBarDeg": th, "K": 1.0, "hFunction": "hapke1981"},
        "estimated", [_src(ctx, SIMONELLI_1987)],
        method=(f"Hapke (1981, 1984) law of Simonelli & Veverka (1986, Icarus 68) for Io from disk-integrated Voyager "
                f"photometry in the violet filter (~0.42 µm), as quoted by Simonelli & Veverka (1987, NTRS "
                f"19870014003): w = {w}, h = {h}, single-term Henyey–Greenstein asymmetry g = {g} (written here as the "
                f"backward lobe alone, b = {abs(g)}, c = 1), θ̄ = {th}°, and the Hapke (1981) opposition amplitude "
                f"B0 = exp(−w²/2) = {bs0:.3f}. The renderer's SHOE form 1/(1 + tan(g/2)/h) approximates Hapke's (1981) "
                "function of the same width; the H function is Hapke's (1981). The violet-filter fit is applied at all "
                "wavelengths (the orange-filter values are not printed in the available source)."),
        uncertainty=("Io's reflectance is much higher in the visible than at 0.42 µm, so its multiple scattering and "
                     "thus its limb brightening are probably underestimated; a disk-integrated fit constrains the "
                     "disk-resolved distribution only through the model."))


def vincendon_mars(ctx: BuildContext | None = None) -> dict:
    return sourced(
        {"kind": "hapke", "w": 0.85, "b": 0.12, "c": 0.2, "bs0": 1.0, "hs": 0.05, "thetaBarDeg": 17.0, "K": 1.0,
         "hFunction": "hapke1981"},
        "estimated", [_src(ctx, VINCENDON)],
        method=("Mean Martian surface BRDF of Vincendon (2013): Hapke (1993) with ω = 0.85, θ̄ = 17°, b = 0.12, "
                "c = 0.6 as the backward fraction of Johnson et al. (2006a), i.e. c = 2·0.6 − 1 = 0.2 in Hapke's "
                "convention, B0 = 1, h = 0.05, adjusted to OMEGA nadir time series and CRISM emission phase "
                "functions of typical terrains after removing the aerosols. It describes the surface under the "
                "atmosphere, which the renderer adds on top (docs/rendering-earth.md §8)."),
        uncertainty=("a mean over widespread bright and dark terrains, adjusted by eye (paper Sec. 3); several "
                     "parameter sets give similar phase functions; not the dust-storm season."))


# ---------------------------------------------------------------------------------------------- dispatch
GALILEAN_ICY = (502, 503, 504)
VERBISCER_BODIES = (801, 901, 999)


def spatial_model_for(naif: int, p_grid: np.ndarray | None, ctx: BuildContext | None = None) -> dict | None:
    """The body's spatialModel entry, or None (Lambert) where no published fit is used."""
    if naif in GIANTS and p_grid is not None:
        return giant_minnaert(naif, p_grid, ctx)
    if naif in GALILEAN_ICY:
        return dv1997_hapke(naif, ctx)
    if naif == 501:
        return io_hapke(ctx)
    if naif in VERBISCER_BODIES:
        return verbiscer_hapke(naif, ctx)
    if naif == 499:
        return vincendon_mars(ctx)
    return None
