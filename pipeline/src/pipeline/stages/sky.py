"""Stage `sky`: the diffuse sky beyond the star tiers, and the zodiacal-light model.

Products (docs/architecture.md §6):
* sky/diffuse.json + sky/*.bin: HEALPix NESTED (ICRS) maps of radiance in XYZS (cd/m^2, scotopic cd/m^2):
  - faintStars (order 8): all Gaia sources with G >= 14 (below the deep tier), summed per pixel server-side;
  - diffuse (order 6, ~3 deg resolution): Pioneer 10/11 IPP B/R sky (measured beyond 3 AU, i.e. without zodiacal
    light) minus every star we render or put in faintStars: the diffuse galactic light, extragalactic light and stars
    fainter than Gaia;
  - deepAggregate (order 8): the deep tier itself summed per pixel (for level-of-detail rendering; not additive).
* sky/zodiacal.json: Leinert et al. (1998) zodiacal light at 1 AU and the Kelsall et al. (1998) dust cloud with a
  visible phase function and albedo fitted to it.
"""

from __future__ import annotations

import json
import time

import numpy as np

from .. import cie
from .. import sky_diffuse as sdf
from .. import sky_healpix as hp
from .. import sky_zodi as zl
from .. import stars_catalogs as sc
from .. import stars_deep as sdp
from .. import stars_format as sf
from .. import stars_gaia as sg
from ..download import record
from ..output import write_bin, write_json
from ..paths import CACHE, OUT
from ..photometry import solar
from ..photometry.common import Download
from ..schema import BuildContext, SourceRecord, sourced
from . import stars as st

DEPENDS = ("stars", "deepstars", "light")

FAINT_ORDER = 8          # Gaia G >= 14 sums (0.23 deg pixels)
REMAINDER_ORDER = 7      # deep-tier light not loaded as points, per tile prefix level (0.46 deg)
COLOUR_ORDER = 6         # colour mix of those stars (BP-RP bins of 0.1 mag, 0.92 deg pixels)
MIN_PER_COLOUR_BIN = 30  # calibration stars needed for a BP-RP bin
DIFFUSE_ORDER = 6        # diffuse remainder (0.92 deg pixels)
WORK_ORDER = 7           # Pioneer binning / star maps before smoothing (0.46 deg)
PIONEER_FWHM = 2.0       # deg, native resolution of the IPP maps (Leinert 1998 p. 72; K. Gordon's map page)
OUT_FWHM = 3.0           # deg, common resolution of the diffuse remainder
FAINT_G_MIN = 14.0
TOLLER_BINS = (5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0)   # Hipparcos V bins for the removed-star regression (diagnostic)
#: Toller removed "individually resolved stars, typically those brighter than 6.5 mag ... on the basis of a custom
#: made catalog containing 12457 stars" (Leinert 1998 p. 69): the 12457 brightest Hipparcos stars (V < 6.81) are
#: taken as removed from the Pioneer maps.
TOLLER_N_STARS = 12457
HIGHPASS_FWHM = 10.0

SRC_PIONEER = "pioneer-ipp-maps"
SRC_SUMS = f"gaia-{sg.REL.key}-faint-sums"
SRC_LEINERT = "leinert-1998"
SRC_KELSALL = "kelsall-1998"

LEINERT = Download(
    id=SRC_LEINERT,
    url="https://scispace.com/pdf/the-1997-reference-of-diffuse-night-sky-brightness-2cwpnhnl1d.pdf",
    subdir="sky/papers", name="leinert1998_aas127_1.pdf", browser_agent=True,
    sha256="46244db7c3c9f9dd62f5944ecd6ef2ea16a39bae2d6b5ac7d4b04d95ade412c0", retrieved="2026-09-30",
    title="The 1997 reference of diffuse night sky brightness",
    citation="Leinert, Ch., Bowyer, S., Haikala, L. K., Hanner, M. S., Hauser, M. G., Levasseur-Regourd, A.-Ch., "
             "Mann, I., Mattila, K., Reach, W. T., Schlosser, W., Staude, H. J., Toller, G. N., Weiland, J. L., "
             "Weinberg, J. L. & Witt, A. N. (1998), Astronomy & Astrophysics Supplement Series 127, 1-99. "
             "DOI:10.1051/aas:1998105.",
    notes="Publisher copy (aas.aanda.org) refuses scripted clients; this is the SciSpace mirror of the published PDF "
          "(99 pages, journal pagination). Tables transcribed in pipeline/src/pipeline/sky_tables/leinert_1998*.")
KELSALL = Download(
    id=SRC_KELSALL, url="https://arxiv.org/pdf/astro-ph/9806250v1", subdir="sky/papers",
    name="kelsall1998_astro-ph9806250v1.pdf",
    title="The COBE Diffuse Infrared Background Experiment Search for the Cosmic Infrared Background. II. Model of "
          "the Interplanetary Dust Cloud",
    citation="Kelsall, T. et al. (1998), Astrophysical Journal 508, 44-73. DOI:10.1086/306380. arXiv:astro-ph/9806250.",
    notes="Model parameters (Tables 1-2) and equations transcribed in pipeline/src/pipeline/sky_tables/kelsall_1998.json.")


def log(msg: str) -> None:
    print(f"  [sky] {msg}", flush=True)


def run(ctx: BuildContext) -> None:
    t0 = time.time()
    ids = solar.register_sources(ctx)
    diag: dict = {}
    zod = build_zodiacal(ctx, ids, diag)
    write_json(ctx, "sky/zodiacal.json", zod, "sky")
    log(f"zodiacal model written ({time.time() - t0:.0f} s)")
    build_diffuse(ctx, ids, diag)
    (CACHE / "sky").mkdir(parents=True, exist_ok=True)
    (CACHE / "sky" / "diagnostics.json").write_text(json.dumps(st._jsonable(diag), indent=1))
    log(f"done in {time.time() - t0:.0f} s")


# ============================================================================================ zodiacal light

def _xyzs_of_solar(fco_fn=None) -> np.ndarray:
    """XYZS of the solar spectrum at 1 AU per sr (cd/m^2 for 1 F_sun/sr), optionally times f_co(lambda)."""
    grid = solar.spectrum().grid
    f = grid * (fco_fn(cie.WAVELENGTHS) if fco_fn else 1.0)
    return cie.xyzs(f)


def build_zodiacal(ctx: BuildContext, ids: dict, diag: dict) -> dict:
    src_l = LEINERT.register(ctx)
    src_k = KELSALL.register(ctx)
    cie_ids = ids["cie"]
    lam, beta, tab = zl.leinert_table(16)
    lc = zl.leinert_constants()
    model = zl.Kelsall.load()
    fit, det = zl.fit_visible_scattering(model)
    diag["zodiFit"] = {"albedo": fit.albedo, "C0": fit.c0, "C1": fit.c1, "C2": fit.c2, "rmsLog": fit.rms_log,
                       "maxAbsLog": fit.max_abs_log, "cells": fit.n_cells, "chi2red": fit.chi2_red,
                       "cellsDetail": {k: np.asarray(v).tolist() for k, v in det.items()}}
    # radial dependence and poles from the fitted model, for the report
    radial = {}
    for R in (0.3, 0.5, 0.72, 1.0, 1.52, 2.0, 3.3, 5.2):
        obs = np.array([-R, 0.0, 0.0])
        d = zl.helio_dirs(np.array([90.0, 180.0, 0.0]), np.array([0.0, 0.0, 90.0]), 0.0)
        radial[str(R)] = dict(zip(("eps90_ecliptic", "antisolar", "eclipticPole"),
                                  [float(x) for x in zl.brightness_s10(model, fit, obs, d, np.pi)]))
    diag["zodiRadial"] = radial
    xyz_30 = _xyzs_of_solar(lambda w: zl.fco(w, 30.0))
    xyz_90 = _xyzs_of_solar(lambda w: zl.fco(w, 90.0))
    xyz_sun = _xyzs_of_solar()
    k = zl.S10_PER_SOLAR_FLUX_SR
    s10 = [[None if not np.isfinite(v) else float(v) for v in row] for row in tab]
    hel = lc["heliocentric_dependence"]
    exps = {}
    for a, b in ((0.3, 1.0), (1.0, 3.3)):
        ra, rb = radial[str(a)], radial[str(b)]
        exps[f"{a}-{b}AU"] = {key: float(np.log(ra[key] / rb[key]) / np.log(a / b)) for key in ra}
    diag["zodiRadialExponents"] = exps
    kp = model.p
    return {
        "kind": "zodiacalLightModel",
        "version": 1,
        "frame": "heliocentric ecliptic (J2000 mean ecliptic and equinox), X towards the vernal equinox, AU",
        "at1AU": sourced(
            {"dlamDeg": lam.tolist(), "betaDeg": beta.tolist(), "s10": s10,
             "axes": "s10[i][j]: lambda - lambda_sun = dlamDeg[i] (helioecliptic longitude from the Sun, 0-180, "
                     "symmetric), |beta| = betaDeg[j]; null = no value (too close to the Sun)",
             "eclipticPoleS10": lc["ecliptic_pole_500nm"]["I_S10sun"]},
            "measured", [src_l], unit="S10sun at 500 nm",
            method="Leinert et al. 1998 Table 16 (p. 36): annually averaged zodiacal light seen from the Earth, "
                   "smoothed ground-based and space photometry (Levasseur-Regourd & Dumont 1980, updated; Helios and "
                   "rocket data within 30 deg of the Sun). Interpolate smoothly between cells.",
            uncertainty="10-15 S10sun for low values, 5-10 % for the higher brightnesses (p. 38); pole 60 +- 3"),
        "s10ToXYZS": sourced(
            {"eps30": (xyz_30 * k).tolist(), "eps90": (xyz_90 * k).tolist(), "solarColour": (xyz_sun * k).tolist(),
             "use": "radiance XYZS = S10 value x vector; interpolate eps30 -> eps90 linearly in solar elongation "
                    "(eps30 below 30 deg, eps90 beyond 90 deg)"},
            "derived", [src_l, ids["hsrs"], ids["edlen"], *cie_ids], unit="cd/m^2 (X, Y, Z) and scotopic cd/m^2 (S) "
                                                                        "per S10sun",
            method="1 S10sun = 6.61e-12 F_sun/sr (Leinert 1998 p. 4) with F_sun the TSIS-1 HSRS spectrum at 1 AU "
                   "(air wavelengths, 1 nm bins, as the light stage), times Leinert's adopted zodiacal reddening "
                   "f_co(lambda) = 1 + s log10(lambda / 500 nm) (Eq. 22, p. 41; s = 1.2 / 0.8 below / above 500 nm at "
                   "30 deg elongation, 0.9 / 0.6 at 90 deg), integrated with the CIE 1931 2° and 1951 scotopic "
                   "functions.",
            uncertainty="f_co is Leinert's fit to scattered colour measurements (< 20 % from solar 350-800 nm); "
                        "the S10sun definition assumes V_sun = -26.74 (2 % vs other solar V values)"),
        "cloud": sourced(
            {"model": "Kelsall et al. 1998 (COBE/DIRBE) interplanetary dust model",
             "components": {"smoothCloud": {k2: v["value"] for k2, v in kp["smooth_cloud"].items()},
                            "dustBands": [{k2: (v["value"] if isinstance(v, dict) else v) for k2, v in b.items()}
                                          for b in kp["dust_bands"]],
                            "ring": {k2: v["value"] for k2, v in kp["ring"].items()},
                            "trailingBlob": {k2: v["value"] for k2, v in kp["trailing_blob"].items()
                                             if isinstance(v, dict)}},
             "equations": kp["equations"], "rOutAU": zl.R_OUT_AU,
             "densityUnit": "cross-section density, AU^-1 (optical depth per AU of path)"},
            "derived", [src_k],
            method="Published density model fitted by Kelsall et al. to 10 months of DIRBE 1.25-240 um sky maps "
                   "seen from the Earth (Tables 1-2, Eqs. 3-9). The trailing blob is tied to the Earth's mean "
                   "heliocentric longitude (theta measured from it).",
            uncertainty="Table 1 68 % joint confidence intervals; constrained by lines of sight from 1 AU, so the "
                        "density far from the Earth's orbit is an extrapolation of the fitted forms"),
        "scattering": sourced(
            {"phaseFunction": "Phi(Theta) = N (C0 + C1 Theta + exp(C2 Theta)), Theta in rad, Theta = 0 forward",
             "C0": fit.c0, "C1": fit.c1, "C2": fit.c2, "N": zl.phase_norm(fit.c0, fit.c1, fit.c2),
             "albedo": fit.albedo,
             "brightness": "I = albedo * integral over s from the observer to R = rOutAU of n(x) Phi(Theta) / R^2 "
                           "ds, in units of the solar flux at 1 AU per sr (n in AU^-1, s and R in AU); "
                           "radiance XYZS = I x perSolarFluxPerSr (eps30 / eps90 as in s10ToXYZS)",
             "perSolarFluxPerSr": {"eps30": xyz_30.tolist(), "eps90": xyz_90.tolist()}},
            "estimated", [src_l, src_k, ids["hsrs"], *cie_ids],
            method="The Kelsall phase-function form (Eq. 2; chosen by Kelsall et al. because it reproduces Hong's "
                   "1985 visible phase function) with C0, C1, C2 and one albedo for all components fitted to Leinert "
                   "Table 16 (%d cells, elongation >= 15 deg) by weighted least squares (sigma = sqrt(12.5^2 + "
                   "(0.075 I)^2) S10sun, the table's stated errors), the geometry fixed at Kelsall's values and the "
                   "model averaged over the Earth's orbit (12 positions, +-beta, +-(lambda - lambda_sun)). "
                   "Reproduces the table to %.0f %% rms (max %.0f %%), reduced chi^2 %.2f. Away from 1 AU this is an "
                   "estimate: its radial dependence (exponent %.2f for 0.3-1 AU, %.2f for 1-3.3 AU at 90 deg "
                   "elongation) is to be compared with Helios' R^%.1f and Pioneer 10's R^%.1f (Leinert Eqs. 15, 17)."
                   % (fit.n_cells, 100 * fit.rms_log, 100 * fit.max_abs_log, fit.chi2_red,
                      -exps["0.3-1.0AU"]["eps90_ecliptic"], -exps["1.0-3.3AU"]["eps90_ecliptic"],
                      hel["helios_0.3_1AU"]["exponent"], hel["pioneer10_1_3.3AU"]["exponent"]),
            uncertainty="fit residuals above; the scattering properties are assumed uniform through the cloud"),
        "notes": "At the Earth use at1AU (measured). Elsewhere integrate cloud x scattering along the line of sight. "
                 "Leinert's tables are annual averages; the model's seasonal effects (cloud offset/tilt, ring, "
                 "trailing blob) are included in `cloud`.",
    }


# ============================================================================================ diffuse sky

def build_diffuse(ctx: BuildContext, ids: dict, diag: dict) -> None:
    st._import_astropy()
    cie_ids = ids["cie"]
    spec = solar.spectrum()
    bands = sdp.PIONEER_BANDS
    fsun = {b: sdf.band_mean(spec.wl_air, spec.ssi_air, c, w) for b, (c, w) in bands.items()}
    diag["fSunBand"] = fsun
    two = sdf.TwoBand(spec.wl_air, spec.ssi_air, spec.grid, cie.WAVELENGTHS, cie.xyzs, bands)

    # --------------------------------------------------------------- calibration: XP stars per BP-RP bin
    cz = np.load(CACHE / "stars" / "deep_calib.npz")
    cols = list(cz["columns"])
    red = cz["red"].astype(np.float64)
    fg = 10 ** (-0.4 * cz["g"])
    ratio = red / fg[:, None]                      # (XYZS, B, R) per 10^(-0.4 G)
    kbins, kcal = colour_bin_ratios(cz["bp"] - cz["rp"], ratio)
    gonly = np.median(ratio, axis=0)
    # hold-out check: calibrate on G < 13, apply per bin to the Sigma 10^(-0.4 G) of the 13 <= G < 14 stars
    lo_g = cz["g"] < 13.0
    kb2, kc2 = colour_bin_ratios(cz["bp"][lo_g] - cz["rp"][lo_g], ratio[lo_g])
    hi_g = ~lo_g
    cb_hi = np.floor(10 * (cz["bp"][hi_g] - cz["rp"][hi_g]))
    pred = fg[hi_g, None] * kc2[np.clip(np.searchsorted(kb2, cb_hi), 0, kb2.size - 1)]
    hold = (pred.sum(0) / red[hi_g].sum(0) - 1).tolist()
    diag["colourBinCalibration"] = {"bins": int(kbins.size), "range": [float(kbins[0]) / 10, float(kbins[-1] + 1) / 10],
                                    "holdOutBias_G13to14": dict(zip(cols, hold)),
                                    "gOnlyRatio": dict(zip(cols, gonly.tolist()))}
    xyz = red[:, :3]
    br_from_xyz = {}
    for j, c in ((4, "pioneerB"), (5, "pioneerR")):
        w = 1.0 / red[:, j]
        coef, *_ = np.linalg.lstsq(xyz * w[:, None], np.ones_like(w), rcond=None)
        br_from_xyz[c] = {"coef": coef.tolist(), "rms": float(np.sqrt(np.mean(((xyz @ coef) / red[:, j] - 1) ** 2)))}
    diag["bandFromXYZ"] = br_from_xyz

    # --------------------------------------------------------------- stars we render: dir, Y, B, R, HIP V
    xp_paths, xp_ledger = sdp.stream_deep_xp(log=log)
    xsid, xred = sg.load_xp_reduced(xp_paths)

    def band_fluxes(xp_lit, cat, xyzs_):
        """IPP-band fluxes from the star's XP spectrum where its light comes from XP, else from its XYZ."""
        gid = sf.gaia_id(cat)
        out = np.full((cat.shape[0], 2), np.nan)
        k = np.clip(np.searchsorted(xsid, gid), 0, xsid.size - 1)
        hit = xp_lit & (xsid[k] == gid)
        out[hit] = xred[k[hit]][:, 4:6]
        bad = ~np.isfinite(out).all(1) | (out <= 0).any(1)
        for j, c in enumerate(("pioneerB", "pioneerR")):
            out[bad, j] = xyzs_[bad, :3] @ np.array(br_from_xyz[c]["coef"])
        return out, hit & ~bad

    bh, br = sf.read_table(OUT / "stars" / "bright.json")
    b_gaia = br["src"] == bh["sourceTable"].index(st.SRC_GAIA)
    xp_routes = [i for i, r in enumerate(bh["routes"]["light"]) if "XP externally calibrated" in r["method"]]
    b_xyzs = br["xyzs"].astype(np.float64)
    b_br, b_hit = band_fluxes(b_gaia & np.isin(br["lightRoute"], xp_routes), br["catId"], b_xyzs)
    hm = sc.load_hip_main()
    vmap = dict(zip(hm.hip.astype(int).tolist(), hm.vmag.tolist()))
    b_v = np.array([vmap.get(int(h), np.nan) if h else np.nan for h in br["hip"]])
    dh = json.loads((OUT / "stars" / "deep.json").read_text())
    d_dir, d_xyzs, d_cat, d_route = [], [], [], []
    for t in dh["tiles"]:
        raw = np.frombuffer((OUT / "stars" / t["bin"]).read_bytes(), dtype=sf.dtype())
        d_dir.append(raw["dir"])
        d_xyzs.append(raw["xyzs"])
        d_cat.append(raw["catId"])
        d_route.append(raw["lightRoute"])
    d_dir = np.concatenate(d_dir).astype(np.float64)
    d_xyzs = np.concatenate(d_xyzs).astype(np.float64)
    d_cat = np.concatenate(d_cat)
    d_route = np.concatenate(d_route)
    d_br, d_hit = band_fluxes(d_route == 0, d_cat, d_xyzs)
    diag["deepYFractionDerived"] = float(np.nansum(d_xyzs[d_route == 0, 1]) / np.nansum(d_xyzs[:, 1]))
    xred = None  # free memory
    diag["bandFluxFromXP"] = {"bright": [int(b_hit.sum()), int(b_hit.size)], "deep": [int(d_hit.sum()), int(d_hit.size)]}

    # --------------------------------------------------------------- faint Gaia sums (G >= 14)
    sums = _load_sums(sg.fetch_faint_sums(FAINT_G_MIN, FAINT_ORDER))
    npx8 = hp.npix(FAINT_ORDER)
    om8 = 4 * np.pi / npx8
    csum = _load_colour_sums(sg.fetch_faint_colour_sums(FAINT_G_MIN, COLOUR_ORDER))
    # effective (XYZS, B, R) per 10^(-0.4 G) of the faint stars in each order-6 pixel: colour-bin mix
    npx6c = hp.npix(COLOUR_ORDER)
    num = np.zeros((npx6c, len(cols)))
    den = np.zeros(npx6c)
    col = np.isfinite(csum["cbin"])
    kk = kcal[np.clip(np.searchsorted(kbins, csum["cbin"][col]), 0, kbins.size - 1)]
    outside = (csum["cbin"][col] < kbins[0]) | (csum["cbin"][col] > kbins[-1])
    np.add.at(num, csum["hpx"][col], kk * csum["fg"][col, None])
    np.add.at(num, csum["hpx"][~col], gonly[None, :] * csum["fg"][~col, None])
    np.add.at(den, csum["hpx"], csum["fg"])
    k_eff = num / np.where(den > 0, den, 1.0)[:, None]
    parent = np.arange(npx8) >> (2 * (FAINT_ORDER - COLOUR_ORDER))
    fs = {c: sums["fg"] * k_eff[parent, j] / om8 for j, c in enumerate(cols)}          # per sr
    fg6 = np.bincount(parent, weights=sums["fg"], minlength=npx6c)
    diag["faintSums"] = {"sources": int(sums["n"].sum()), "withColour": int(sums["n_c"].sum()),
                         "gFluxFractionNoColour": float(csum["fg"][~col].sum() / csum["fg"].sum()),
                         "gFluxFractionColourOutsideCalibration": float(csum["fg"][col][outside].sum() /
                                                                        csum["fg"].sum()),
                         "colourSumsVsPixelSums": float(np.max(np.abs(den / np.where(fg6 > 0, fg6, 1) - 1)[fg6 > 0]))}
    faint_xyzs = np.stack([fs[c] for c in ("X", "Y", "Z", "S")], 1)

    # --------------------------------------------------------------- Pioneer maps -> order 7 (ICRS)
    sdf.fetch_pioneer()
    rot = sdf.galactic_to_icrs()
    P, cov = {}, None
    for b in ("B", "R"):
        d, lon, lat = sdf.load_pioneer(b)
        P[b], cov = sdf.bin_grid_to_healpix(d, lon, lat, WORK_ORDER, rot)
    npx7 = hp.npix(WORK_ORDER)
    om7 = 4 * np.pi / npx7
    pix_b = hp.vec2pix(WORK_ORDER, br["dir"].astype(np.float64))
    pix_d = hp.vec2pix(WORK_ORDER, d_dir)

    def s10_map(pix, flux_band, band, weight=None):
        w = flux_band if weight is None else flux_band * weight
        return np.bincount(pix, weights=w, minlength=npx7) / om7 / (sdf.S10_PER_SOLAR_FLUX_SR * fsun[band])

    faint7 = {b: sdf.to_parent(fs["pioneer" + b], FAINT_ORDER, WORK_ORDER) / (sdf.S10_PER_SOLAR_FLUX_SR * fsun[b])
              for b in ("B", "R")}

    # --------------------------------------------------------------- which bright stars are in the Pioneer maps?
    K_beam = sdf.gauss_matrix(WORK_ORDER, DIFFUSE_ORDER, PIONEER_FWHM)
    K_bg = sdf.gauss_matrix(DIFFUSE_ORDER, DIFFUSE_ORDER, HIGHPASS_FWHM)
    ones7 = np.ones(npx7)
    kn = K_beam @ ones7
    cov6 = sdf.to_parent(cov, WORK_ORDER, DIFFUSE_ORDER)
    edges = list(TOLLER_BINS)
    reg = {}
    incl_w = {}
    for b, j in (("B", 0), ("R", 1)):
        P6 = sdf.to_parent(P[b], WORK_ORDER, DIFFUSE_ORDER, cov)
        valid = np.isfinite(P6) & (cov6 > 0.9)
        comps = []
        names = []
        groups = [b_v < edges[0]] + [(b_v >= lo) & (b_v < hi) for lo, hi in zip(edges[:-1], edges[1:])]
        for gi, m in enumerate(groups):
            comps.append(K_beam @ s10_map(pix_b[m], b_br[m, j], b) / kn)
            names.append(f"V<{edges[0]}" if gi == 0 else f"{edges[gi - 1]}-{edges[gi]}")
        rest = ~(b_v < edges[-1])
        comps.append(K_beam @ (s10_map(pix_b[rest], b_br[rest, j], b) + s10_map(pix_d, d_br[:, j], b) + faint7[b]) / kn)
        names.append(f"rest (V>={edges[-1]} or no HIP V) + deep + faint")
        wv = valid.astype(float)
        y = P6 - sdf.smooth(K_bg, P6, wv)
        X = np.stack([c - sdf.smooth(K_bg, c, wv) for c in comps], 1)
        ok = valid & np.isfinite(y) & np.isfinite(X).all(1)
        coef, *_ = np.linalg.lstsq(X[ok], y[ok], rcond=None)
        # bootstrap over sky halves for a rough error: fit on 8 disjoint pixel sets
        parts = [np.linalg.lstsq(X[ok][i::8], y[ok][i::8], rcond=None)[0] for i in range(8)]
        err = np.std(parts, axis=0) / np.sqrt(8)
        reg[b] = {"groups": names, "coef": coef.tolist(), "err": err.tolist(),
                  "rms": float(np.sqrt(np.mean((X[ok] @ coef - y[ok]) ** 2))), "pixels": int(ok.sum())}
        incl_w[b] = (coef[:-1] / coef[-1]).tolist()
    diag["pioneerStarRegression"] = reg
    vs = np.sort(hm.vmag[np.isfinite(hm.vmag)])
    v_cut = float(vs[TOLLER_N_STARS - 1]) + 1e-6
    removed = b_v < v_cut
    diag["tollerCut"] = {"V": v_cut, "hipparcosStarsBrighter": int((vs < v_cut).sum()),
                         "recordsRemoved": int(removed.sum())}
    log("Pioneer star-inclusion regression: " + "; ".join(
        f"{b}: " + ", ".join(f"{n}={c:.2f}" for n, c in zip(reg[b]["groups"], reg[b]["coef"])) for b in reg))

    # --------------------------------------------------------------- remainder = Pioneer - stars in the maps
    K_p = sdf.gauss_matrix(WORK_ORDER, DIFFUSE_ORDER, float(np.sqrt(OUT_FWHM ** 2 - PIONEER_FWHM ** 2)))
    K_s = sdf.gauss_matrix(WORK_ORDER, DIFFUSE_ORDER, OUT_FWHM)
    ks = K_s @ ones7
    remainder, stars_in = {}, {}
    sens = {}
    for b, j in (("B", 0), ("R", 1)):
        s = s10_map(pix_b[~removed], b_br[~removed, j], b) + s10_map(pix_d, d_br[:, j], b) + faint7[b]
        stars_in[b] = K_s @ s / ks
        remainder[b] = sdf.smooth(K_p, P[b], cov) - stars_in[b]
        # sensitivity to the cut: light of the stars between V = 6.5 and the cut, and between the cut and 7.0
        lo_m = (b_v >= 6.5) & (b_v < v_cut)
        hi_m = (b_v >= v_cut) & (b_v < 7.0)
        sens[b] = {"medianS10_6.5_to_cut": float(np.median(K_s @ s10_map(pix_b[lo_m], b_br[lo_m, j], b) / ks)),
                   "medianS10_cut_to_7.0": float(np.median(K_s @ s10_map(pix_b[hi_m], b_br[hi_m, j], b) / ks))}
    diag["tollerCut"]["sensitivity"] = sens
    measured = np.isfinite(remainder["B"]) & np.isfinite(remainder["R"]) & (sdf.smooth(K_p, cov) > 0.5)
    # gaps: median remainder of covered pixels in the same galactic-latitude band (2 deg, per hemisphere)
    v6 = hp.pix2vec(DIFFUSE_ORDER, np.arange(hp.npix(DIFFUSE_ORDER)))
    gal_b = np.degrees(np.arcsin(np.clip(v6 @ rot[:, 2], -1, 1)))    # z_gal = (M^T v)_z = v . M[:, 2]
    bb = np.clip(np.floor((gal_b + 90) / 2).astype(int), 0, 89)
    filled = {}
    for b in ("B", "R"):
        f = remainder[b].copy()
        med = np.full(90, np.nan)
        for i in range(90):
            m = measured & (bb == i)
            if m.sum() >= 10:
                med[i] = np.median(remainder[b][m])
        idx = np.arange(90)
        good = np.isfinite(med)
        med = np.interp(idx, idx[good], med[good])
        f[~measured] = med[bb[~measured]]
        filled[b] = f
    diag["diffuseCoverage"] = {"measuredFraction": float(measured.mean())}
    xyzs6, alpha = two.xyzs_from_s10(filled["B"], filled["R"])
    nonpos = ~np.isfinite(xyzs6).all(1)
    xyzs6[nonpos] = 0.0
    diag["diffuse"] = {
        "nonPositivePixels": int(nonpos.sum()),
        "remainderS10": {b: {"median": float(np.median(filled[b])), "p5": float(np.percentile(filled[b], 5)),
                             "p95": float(np.percentile(filled[b], 95))} for b in filled},
        "alphaMedian": float(np.nanmedian(alpha)),
        "pioneerVsStars": {b: {"pioneerMedian": float(np.nanmedian(sdf.smooth(K_p, P[b], cov))),
                               "starsMedian": float(np.median(stars_in[b]))} for b in P},
    }
    label6 = np.where(measured & ~nonpos, 0, np.where(nonpos, 2, 1)).astype(np.uint8)

    # --------------------------------------------------------------- deep-tier aggregate (level of detail)
    agg = np.zeros((npx8, 4))
    p8 = hp.vec2pix(FAINT_ORDER, d_dir)
    for c in range(4):
        agg[:, c] = np.bincount(p8, weights=np.nan_to_num(d_xyzs[:, c]), minlength=npx8) / om8
    # deep-tier light NOT loaded when a tile is read to its prefix k (stars/deep.json tiling.prefixY): slice 0 =
    # the whole tier (tile not loaded), slice k = records with Y < prefixY[k-1] (k = 1..3); fully loaded = 0.
    thr = [np.inf] + list(dh["tiling"]["prefixY"])
    npx_r = hp.npix(REMAINDER_ORDER)
    p_r = hp.vec2pix(REMAINDER_ORDER, d_dir)
    rem = np.zeros((len(thr), npx_r, 4))
    y_deep = np.nan_to_num(d_xyzs[:, 1])
    for k, t_k in enumerate(thr):
        m = y_deep < t_k
        for c in range(4):
            rem[k, :, c] = np.bincount(p_r[m], weights=np.nan_to_num(d_xyzs[m, c]), minlength=npx_r) / (4 * np.pi / npx_r)
    diag["deepRemainder"] = {"yBelow": [None if not np.isfinite(t) else float(t) for t in thr],
                             "tileOrder": int(dh["tiling"]["order"]),
                             "totalY_lux": [float(rem[k, :, 1].sum() * 4 * np.pi / npx_r) for k in range(len(thr))]}

    _register_sources(ctx)
    _write_diffuse(ctx, ids, diag, faint_xyzs, xyzs6, label6, agg, filled, reg, incl_w, br_from_xyz,
                   cie_ids, two, rem)
    _verification(diag, br, b_v, b_br, b_xyzs, d_dir, d_xyzs, d_br, faint_xyzs, xyzs6, filled, P, cov, rot, fsun, fs)


def colour_bin_ratios(bprp: np.ndarray, ratio: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Median of `ratio` rows in BP-RP bins cbin = floor(10 BP-RP) with >= MIN_PER_COLOUR_BIN stars: (bins, medians).
    Bins outside the populated range take the nearest end bin (the callers count that light)."""
    cb = np.floor(10 * np.asarray(bprp, float))
    ok = np.isfinite(cb) & np.isfinite(ratio).all(1)
    cb, r = cb[ok], ratio[ok]
    o = np.argsort(cb, kind="stable")
    cb, r = cb[o], r[o]
    u, start, cnt = np.unique(cb, return_index=True, return_counts=True)
    keep = cnt >= MIN_PER_COLOUR_BIN
    meds = np.array([np.median(r[s0:s0 + n], axis=0) for s0, n in zip(start[keep], cnt[keep])])
    return u[keep], meds


def _load_colour_sums(paths) -> dict[str, np.ndarray]:
    hpx, cbin, fg, n = [], [], [], []
    for p in paths:
        t = st.load_table(p)
        hpx.append(np.asarray(t["hpx"], np.int64))
        cbin.append(np.asarray(t["cbin"], float))
        fg.append(np.nan_to_num(np.asarray(t["fg"], float)))
        n.append(np.asarray(t["n"], float))
    return {"hpx": np.concatenate(hpx), "cbin": np.concatenate(cbin), "fg": np.concatenate(fg),
            "n": np.concatenate(n)}


def _load_sums(paths) -> dict[str, np.ndarray]:
    npx = hp.npix(FAINT_ORDER)
    out = {k: np.zeros(npx) for k in ("n", "fg", "n_c", "fg_c", "fbp_c", "frp_c")}
    for p in paths:
        t = st.load_table(p)
        h = np.asarray(t["hpx"], np.int64)
        for k in out:
            out[k][h] += np.nan_to_num(np.asarray(t[k], float))
    return out


def _register_sources(ctx: BuildContext) -> None:
    paths = sdf.fetch_pioneer()
    r = record(paths["P_all_1_B.fits"])
    ctx.add_source(SourceRecord(
        id=SRC_PIONEER, title="Pioneer 10/11 Imaging Photopolarimeter all-sky maps, blue and red (1st iteration, "
                              "straight co-add)",
        citation="Gordon, K. D., Witt, A. N. & Friedmann, B. C. (1998), Detection of Extended Red Emission in the "
                 "Diffuse Interstellar Medium, ApJ 498, 522, DOI:10.1086/305571 (maps); data: Weinberg, J. L. & "
                 "Toller, G. N. (Pioneer 10/11 IPP background sky, NSSDC); Toller, G. N. (1983), ApJ 266, L79, "
                 "DOI:10.1086/183982; description: Leinert et al. 1998 Sect. 10.4.",
        url=sdf.PIONEER_BASE, retrieved=r["retrieved"],
        sha256=st._digest([paths["P_all_1_B.fits"], paths["P_all_1_R.fits"]]), version="P_all_1_{B,R}.fits (2008-11-18)",
        license="Copyright (c) 1997-2014 Karl D. Gordon, All Rights Reserved (personal use; ask the author before any "
                "redistribution of the maps themselves)",
        notes=("1440 x 720 float32, 0.25 deg pixels in galactic longitude/latitude, units S10(G2V) = S10sun; "
               "0 = no data. B: 437.0 nm (826 A wide), R: 644.1 nm (968 A). Measurements from beyond 3.3 AU (no "
               "zodiacal light); stars 'typically brighter than 6.5 mag' removed by Toller from a 12457-star catalog "
               "(Leinert 1998 p. 69). Files: " + st._files_note(list(paths.values())))))
    sums = sg.fetch_faint_sums(FAINT_G_MIN, FAINT_ORDER)
    csums = sg.fetch_faint_colour_sums(FAINT_G_MIN, COLOUR_ORDER)
    ctx.add_source(SourceRecord(
        id=SRC_SUMS, title=f"{sg.REL.label} gaia_source: per-HEALPix sums of G, BP, RP fluxes for G >= {FAINT_G_MIN:g}",
        citation=sg.REL.citation + f", DOI:{sg.REL.doi}; photometry: Riello M. et al. 2021, A&A 649, A3, "
                 "DOI:10.1051/0004-6361/202039587.",
        url=sg.TAP_URL, retrieved=record(sums[0])["retrieved"], sha256=st._digest(sums + csums),
        version=sg.REL.label, license="ESA/Gaia/DPAC, CC BY-SA 3.0 IGO",
        notes=f"2 x {len(sums)} synchronous TAP queries (one per HEALPix level-{sg.SUM_LEVEL} source_id range; "
              "sha256 over all result files). Per level-8 pixel: "
              + sums[0].with_name(sums[0].name + ".adql").read_text() + " || per level-6 pixel and BP-RP bin: "
              + csums[0].with_name(csums[0].name + ".adql").read_text()))


def _write_diffuse(ctx, ids, diag, faint_xyzs, xyzs6, label6, agg, filled, reg, incl_w, br_from_xyz,
                   cie_ids, two, rem) -> None:
    unit = "cd/m^2 (X, Y, Z) and scotopic cd/m^2 (S); radiance of the sky, no atmosphere, no zodiacal light"
    write_bin(ctx, f"sky/faint-stars-o{FAINT_ORDER}.bin", faint_xyzs.astype("<f4"), "sky")
    write_bin(ctx, f"sky/diffuse-o{DIFFUSE_ORDER}.bin", xyzs6.astype("<f4"), "sky")
    write_bin(ctx, f"sky/diffuse-o{DIFFUSE_ORDER}-label.bin", label6, "sky")
    write_bin(ctx, f"sky/deep-aggregate-o{FAINT_ORDER}.bin", agg.astype("<f4"), "sky")
    write_bin(ctx, f"sky/deep-remainder-o{REMAINDER_ORDER}.bin", rem.astype("<f4"), "sky")
    bands = sdp.PIONEER_BANDS

    def layer(bin_name, order, label, srcs, method, fwhm, uncertainty, extra=None):
        d = {"bin": bin_name, "scheme": "HEALPix", "ordering": "NESTED", "order": order, "nside": 1 << order,
             "npix": hp.npix(order), "frame": "ICRS", "channels": ["X", "Y", "Z", "S"], "dtype": "f32",
             "layout": "pixel-major: value[pix * 4 + channel]", "unit": unit, "label": label, "sources": srcs,
             "method": method, "resolutionFwhmDeg": fwhm, "uncertainty": uncertainty}
        d.update(extra or {})
        return d

    cal = diag["colourBinCalibration"]
    faint = layer(
        f"faint-stars-o{FAINT_ORDER}.bin", FAINT_ORDER, "estimated", [SRC_SUMS, f"gaia-{sg.REL.key}-deep",
                                                                     f"gaia-{sg.REL.key}-xp-sampled-all", *cie_ids],
        f"Every {sg.REL.label} source with G >= {FAINT_G_MIN:g} (the stars below the deep tier): the archive's sum of "
        f"10^(-0.4 G) per order-{FAINT_ORDER} pixel, times the XYZS per 10^(-0.4 G) of the faint stars' colour mix "
        f"in the parent order-{COLOUR_ORDER} pixel (archive sums of 10^(-0.4 G) per BP-RP bin of 0.1 mag), each bin "
        "converted with the median XYZS 10^(0.4 G) of the deep-tier stars of that colour whose XYZS comes from their "
        "XP spectra (%d bins, BP-RP %.1f to %.1f; sources without BP/RP use the median over all colours). "
        "Divided by the pixel solid angle. A hold-out test (bins from G < 13, applied to the summed light of the "
        "13 <= G < 14 stars) reproduces their X, Y, Z, S to %s." % (
            cal["bins"], cal["range"][0], cal["range"][1],
            ", ".join(f"{100 * cal['holdOutBias_G13to14'][c]:+.1f} %" for c in "XYZS")),
        None, "colour mix at 0.9 deg; assumes the faint stars of a colour have the spectra of the brighter ones "
              "(interstellar reddening at a given BP-RP is similar); sums are exact archive counts",
        {"pixelSolidAngleSr": 4 * np.pi / hp.npix(FAINT_ORDER),
         "stats": {"sources": diag["faintSums"]["sources"], "gFluxFractionWithoutColour":
                   diag["faintSums"]["gFluxFractionNoColour"], "gFluxFractionColourOutsideCalibration":
                   diag["faintSums"]["gFluxFractionColourOutsideCalibration"],
                   "holdOutBias_G13to14": cal["holdOutBias_G13to14"]}})
    rg = reg
    diffuse = layer(
        f"diffuse-o{DIFFUSE_ORDER}.bin", DIFFUSE_ORDER, "estimated",
        [SRC_PIONEER, SRC_LEINERT, SRC_SUMS, f"gaia-{sg.REL.key}-deep", f"gaia-{sg.REL.key}-xp-sampled-all",
         ids["hsrs"], ids["edlen"], *cie_ids],
        ("Pioneer 10/11 IPP blue and red sky brightness (S10sun, from beyond 3.3 AU) binned to HEALPix order %d and "
         "smoothed from its native ~%g deg to %g deg FWHM, minus every star we render (bright + deep tiers) and the "
         "faintStars layer, each star's IPP-band flux taken from its XP spectrum (top-hat bands %s) or from its "
         "XYZ, smoothed with a %g deg Gaussian. Stars Toller removed from the Pioneer data are not subtracted: "
         "'typically those brighter than 6.5 mag ... a custom made catalog containing 12457 stars' (Leinert 1998 p. "
         "69), taken as the 12457 brightest Hipparcos stars (V < %.2f; stats.tollerCut gives the light between V = "
         "6.5 and 7.0 as the uncertainty of this choice). A regression of the high-passed (%g deg) Pioneer maps on "
         "star maps per V bin (stats.starInclusion) confirms that stars brighter than V = 6.5 are absent (their "
         "coefficients are 0 or negative). The remainder in B and R "
         "is converted to XYZS with a spectrum = solar spectrum x (lambda / 437 nm)^alpha, alpha fixed by the R/B "
         "ratio (1 S10sun = 6.61e-12 F_sun/sr in each band, F_sun from TSIS-1 HSRS). It contains the diffuse "
         "galactic light, the extragalactic background and stars fainter than Gaia."
         % (WORK_ORDER, PIONEER_FWHM, OUT_FWHM,
            ", ".join(f"{b} {c:g} +- {w / 2:g} nm" for b, (c, w) in bands.items()), OUT_FWHM,
            diag["tollerCut"]["V"], HIGHPASS_FWHM)),
        OUT_FWHM,
        "Pioneer random error 2-3 S10sun (5 in the Milky Way; Leinert 1998 p. 72) plus absolute calibration; the "
        "remainder is a difference of two large numbers in the Milky Way; two-band colour only",
        {"labelBin": f"diffuse-o{DIFFUSE_ORDER}-label.bin",
         "labelCodes": {"0": "Pioneer-covered pixel (method above)",
                        "1": "no Pioneer coverage: median remainder of covered pixels at the same galactic latitude "
                             "(2 deg bands), then the same conversion",
                        "2": "remainder not positive in B or R: set to 0"},
         "stats": {"starInclusion": {b: {"groups": rg[b]["groups"], "coef": rg[b]["coef"], "err": rg[b]["err"],
                                         "coefRelativeToRest": incl_w[b]} for b in rg},
                   "tollerCut": diag["tollerCut"],
                   "remainderS10": diag["diffuse"]["remainderS10"], "measuredFraction":
                   diag["diffuseCoverage"]["measuredFraction"], "nonPositivePixels": diag["diffuse"]["nonPositivePixels"]}})
    deep_agg = layer(
        f"deep-aggregate-o{FAINT_ORDER}.bin", FAINT_ORDER, "estimated",
        [f"gaia-{sg.REL.key}-deep", f"gaia-{sg.REL.key}-xp-sampled-all", *cie_ids],
        "The stars/deep tier summed per pixel (XYZS / pixel solid angle): a stand-in for tiles that are not loaded. "
        "Not additive to the tiers (it is the same light). Label = the worst of its records' labels; %.1f %% of its "
        "Y comes from XP-derived records (stars/deep.json routes)." % (100 * diag["deepYFractionDerived"]),
        None, "as the deep-tier records", {"stats": {"yFractionDerived": diag["deepYFractionDerived"]}})
    yb = diag["deepRemainder"]["yBelow"]
    deep_rem = layer(
        f"deep-remainder-o{REMAINDER_ORDER}.bin", REMAINDER_ORDER, "estimated",
        [f"gaia-{sg.REL.key}-deep", f"gaia-{sg.REL.key}-xp-sampled-all", *cie_ids],
        "The deep tier's light that is NOT loaded as points when its tiles are read to a prefix (stars/deep.json "
        "tiling.prefixY / tiles[].prefixCounts): slice k sums, per pixel, the records with Y below yBelow[k] "
        "(slice 0: every record, i.e. tile not loaded). A renderer that loads a tile's first prefixCounts[k-1] "
        "records draws them as points and adds slice k for that tile's pixels (a fully loaded tile adds "
        "nothing), so no deep star is counted twice or lost.", None, "as the deep-tier records",
        {"slices": {"count": len(yb), "yBelow": yb, "layout": "slice-major: value[(slice * npix + pix) * 4 + channel]",
                    "tileOrder": diag["deepRemainder"]["tileOrder"]},
         "stats": {"totalY_lux": diag["deepRemainder"]["totalY_lux"]}})
    header = {
        "kind": "skyMaps",
        "version": 1,
        "layers": {"faintStars": faint, "diffuse": diffuse, "deepAggregate": deep_agg, "deepRemainder": deep_rem},
        "composition": "sky radiance = stars/bright + stars/deep (or deepAggregate) + faintStars + diffuse "
                       "(+ zodiacal light from sky/zodiacal.json when inside the dust cloud)",
        "bands": {b: {"centerNm": c, "widthNm": w} for b, (c, w) in bands.items()},
    }
    write_json(ctx, "sky/diffuse.json", header, "sky")


def _verification(diag, br, b_v, b_br, b_xyzs, d_dir, d_xyzs, d_br, faint_xyzs, xyzs6, filled, P, cov, rot, fsun,
                  fs):
    """Numbers for docs/reports/sky.md: pole brightness vs Leinert Table 34, all-sky totals."""
    lc = zl.leinert_constants()
    poles_gal = {"NGP": (0.0, 90.0), "SGP": (0.0, -90.0)}
    poles_eq = {"NCP": np.array([0, 0, 1.0]), "SCP": np.array([0, 0, -1.0])}
    eps = np.radians(23.4392911)
    poles_ecl = {"NEP": np.array([0, -np.sin(eps), np.cos(eps)]), "SEP": np.array([0, np.sin(eps), -np.cos(eps)])}
    vecs = dict(poles_eq)
    vecs.update(poles_ecl)
    for k, (lo, la) in poles_gal.items():
        vecs[k] = rot @ hp.ang_to_vec(np.array([lo]), np.array([la]))[0]
    v7 = hp.pix2vec(WORK_ORDER, np.arange(hp.npix(WORK_ORDER)))
    v8 = hp.pix2vec(FAINT_ORDER, np.arange(hp.npix(FAINT_ORDER)))
    v6 = hp.pix2vec(DIFFUSE_ORDER, np.arange(hp.npix(DIFFUSE_ORDER)))
    out = {}
    removed = b_v < 6.5
    bdir = br["dir"].astype(np.float64)
    for name, v in vecs.items():
        r = np.radians(5.0)
        cap_px = (v7 @ v) > np.cos(r)
        area = 2 * np.pi * (1 - np.cos(r))
        row = {"pioneer": {}, "starsVge6.5": {}, "faintG14": {}, "remainder": {}, "table34": {}}
        cap8 = (v8 @ v) > np.cos(r)
        cap6 = (v6 @ v) > np.cos(r)
        for b, j in (("B", 0), ("R", 1)):
            conv = sdf.S10_PER_SOLAR_FLUX_SR * fsun[b]
            row["pioneer"][b] = float(np.nanmean(P[b][cap_px]))
            sel_b = ((bdir @ v) > np.cos(r)) & ~removed
            sel_d = (d_dir @ v) > np.cos(r)
            row["starsVge6.5"][b] = float((b_br[sel_b, j].sum() + d_br[sel_d, j].sum()) / area / conv)
            row["faintG14"][b] = float(np.mean(fs["pioneer" + b][cap8]) / conv)
            row["remainder"][b] = float(np.mean(filled[b][cap6]))
        t = lc["pioneer10_poles_table34"]
        row["table34"] = {"B": t["blue_4407A"][name], "R": t["red_6419A"][name]}
        out[name] = row
    diag["poles"] = out
    # all-sky totals (Y): illuminance from the whole sphere = integral of radiance over 4 pi (a sphere, not a plane)
    om8 = 4 * np.pi / hp.npix(FAINT_ORDER)
    om6 = 4 * np.pi / hp.npix(DIFFUSE_ORDER)
    diag["allSkyY"] = {"bright": float(np.nansum(b_xyzs[:, 1])), "deep": float(np.nansum(d_xyzs[:, 1])),
                       "faint": float(faint_xyzs[:, 1].sum() * om8), "diffuse": float(xyzs6[:, 1].sum() * om6),
                       "unit": "lux on a sphere (sum of illuminances, all directions)"}
