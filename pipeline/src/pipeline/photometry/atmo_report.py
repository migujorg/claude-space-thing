"""Write docs/reports/atmospheres.md: what atmospheres.json holds and the checks against published values.

Run: `uv run python -m pipeline.photometry.atmo_report` (builds atmospheres.json in memory; no BuildContext)."""

from __future__ import annotations

import json
import math

import numpy as np
import spiceypy as sp

from ..paths import REPO
from . import atmo, atmo_bodies as ab, atmo_checks as C, atmo_mars as am, atmospheres as A, titan_check as TC
from . import titan_digitize as TD

OUT = REPO / "docs" / "reports" / "atmospheres.md"


def _utc(et: float) -> str:
    lsk, _, _ = am._kernels()
    sp.furnsh(str(lsk))
    try:
        return sp.et2utc(et, "ISOC", 0)
    finally:
        sp.unload(str(lsk))


def _et(utc: str) -> float:
    lsk, _, _ = am._kernels()
    sp.furnsh(str(lsk))
    try:
        return sp.str2et(utc)
    finally:
        sp.unload(str(lsk))


def _row(*cells) -> str:
    return "| " + " | ".join(str(c) for c in cells) + " |"


def main() -> None:
    out, diag = A.build(None)
    B = out["bodies"]
    L = []
    w = L.append
    w("# Atmospheres: optical properties for sky and limb rendering")
    w("")
    w("`app/public/data/atmospheres.json` (`AtmosphereFile`, light stage; built by "
      "`pipeline/src/pipeline/photometry/atmospheres.py`). Regenerate this report with "
      "`uv run python -m pipeline.photometry.atmo_report`.")
    w("")
    w("## Layout")
    w("")
    w("- Spectral samples 360–830 nm every 10 nm (48, standard-air wavelengths like the CIE tables). `foldWeights` "
      "(4 × 48) fold any spectral ratio sampled there into X, Y, Z, S (sunlight × observer, piecewise-linear basis, "
      "rows sum to 1; then × the Sun's XYZS from `light.json`).")
    w("- Per body: `referenceRadiusKm` (pck00011 mean radius, altitude 0), `topRadiusKm`, `altitudesKm`, and "
      "`components`, each with `extinctionPerKm[altitude][wavelength]`, `singleScatteringAlbedo[wavelength]`, "
      "`phaseFunction` (rayleigh with depolarization ρ, henyey-greenstein, double-henyey-greenstein, tabulated, or "
      "none for pure absorbers; mean 1 over the sphere), `channelEquivalents` (X, Y, Z, S) and "
      "`columnOpticalDepth`. Molecular components also carry `separable` = number density × cross-section.")
    w("- Every quantity is `Sourced` with a label; `unknown` quantities must not be rendered as if known. Titan also "
      "carries `surfaceReflectance` (the Lambert surface under its haze) and, on its methane component, the measured "
      "mole-fraction profile and the 1 nm absorption coefficient.")
    w("")
    w("| body | components | τ(550 nm) per component (altitude 0 to top) | grid |")
    w("|---|---|---|---|")
    for k, e in B.items():
        comps = [c["id"] for c in e["components"]]
        tau = ", ".join(f"{c['id']} {c['columnOpticalDepth'][19]:.4g}" for c in e["components"]) or "—"
        grid = (f"{e['altitudesKm'][0]:g}–{e['altitudesKm'][-1]:g} km ({len(e['altitudesKm'])})"
                if e["altitudesKm"] else "—")
        w(_row(e["name"], ", ".join(comps) or "— (scale height only)", tau, grid))
    w("")
    w("Labels per component (extinction / SSA / phase):")
    w("")
    for e in B.values():
        for c in e["components"]:
            w(f"- {e['name']} {c['id']}: {c['extinctionPerKm']['label']} / {c['singleScatteringAlbedo']['label']} / "
              f"{c['phaseFunction']['label']}")
    w("")

    # ---------------------------------------------------------------- Earth
    d = diag["399"]
    w("## Earth")
    w("")
    bs = C.bodhaine_sigma()
    w(f"**Rayleigh cross-section** (Bodhaine et al. 1999 Eq. 22 with Peck & Reeder air, 360 ppm CO2, Bates King "
      f"factor) against their Table 3 at 350–850 nm: max relative difference {bs['max_rel']:.1e}; King factor max "
      f"|Δ| {bs['king_max_abs']:.1e}.")
    w("")
    tr = C.earth_rayleigh_tau(d)
    w(f"**Rayleigh optical depth**: the US76 column (0–86 km, {tr['n_col']:.4e} m⁻²) × σ against Bodhaine's Table 3 "
      "(sea level, 1013.25 mb, 45° latitude):")
    w("")
    w("| λ (nm) | " + " | ".join(f"{x:.0f}" for x in tr["lambda_nm"]) + " |")
    w("|---|" + "---|" * len(tr["lambda_nm"]))
    w("| this product | " + " | ".join(f"{x:.5f}" for x in tr["ours"]) + " |")
    w("| Bodhaine Table 3 | " + " | ".join(f"{x:.5f}" for x in tr["table"]) + " |")
    w("")
    w(f"Ratio at 550 nm: {tr['ratio550']:.5f} (the US76 column vs Bodhaine's P A/(m_a g) with g at the mass-weighted "
      "column height; 0.06 % is within the variability of real surface pressure).")
    w("")
    rows = C.us76_rows()
    w(f"**US76 profile**: the defining equations reproduce the Standard's printed check rows (Tables I–II, "
      f"{len(rows)} values from −5 to 80.5 km) to max |Δ|/value = "
      f"{max(abs(r['rel']) for r in rows):.1e}.")
    w("")
    w(f"**Ozone**: US76 Table 18 integrates to {C.ozone_column_du(d):.1f} DU on the product grid (table: 345 DU = "
      f"0.345 atm-cm, 5 % above Dobson-network values at 45° N per the Standard itself); τ_O3 = "
      f"{B['399']['components'][1]['columnOpticalDepth'][24]:.4f} at 600 nm (Chappuis peak).")
    w("")
    w("**Aerosol**: MACv2 global annual mean, τ(550) = 0.122, ω(550) = 0.941, g(550) = 0.702 (Kinne 2019 Table 2).")
    w("")
    w("**Zenith sky colour** (check of the combined components): single-scattering zenith radiance, plane-parallel, "
      "no multiple scattering or ground reflection, integrated against the CIE observer. CCT by Hernández-Andrés et "
      "al. (1999) (colour-science); `y_D` is the CIE D-series daylight locus at that CCT (colour-science "
      "CCT_to_xy_CIE_D).")
    w("")
    w("| Sun elevation | x | y | CCT (K) | y_D (daylight locus) |")
    w("|---|---|---|---|---|")
    zs = C.zenith_sky(d)
    for z in zs:
        w(_row(f"{z['elevation']:.0f}°", f"{z['x']:.4f}", f"{z['y']:.4f}", f"{z['cct']:.0f}",
               f"{z['y_daylight_locus']:.4f}"))
    w("")
    ccts = [z["cct"] for z in zs]
    dy = max(abs(z["y"] - z["y_daylight_locus"]) for z in zs)
    w(f"The zenith sky is blue (CCT {min(ccts):.0f}–{max(ccts):.0f} K) and lies on the daylight locus within "
      f"|Δy| ≤ {dy:.4f}: the molecular, ozone and aerosol components together give a skylight colour on the CIE "
      "daylight locus.")
    w("")
    w("| Sun zenith angle | air mass | direct-sun transmittance T_Y | x | y |")
    w("|---|---|---|---|---|")
    for s in C.direct_sun(d):
        w(_row(f"{s['zenith']:.0f}°", f"{s['airmass']:.2f}", f"{s['T_Y']:.3f}", f"{s['x']:.4f}", f"{s['y']:.4f}"))
    w("")
    w("Direct sunlight reddens with air mass (plane-parallel air mass; near the horizon use a spherical path).")
    w("")

    # ---------------------------------------------------------------- Mars
    d = diag["499"]
    m = C.mars_checks(d)
    w("## Mars")
    w("")
    nxt = am.ls_zero_crossing(m["ls0_et"] + 450 * 86400)
    year_s = nxt - m["ls0_et"]
    my = 1 + round((m["ls0_et"] - _et("1955-04-11T12:00:00")) / year_s)
    w(f"- L_s = 0 epochs from DE442 + the IAU pole: {_utc(m['ls0_et'])} and {_utc(nxt)} "
      f"({year_s / am.sol_seconds():.2f} sols apart): the starts of Mars years {my} and {my + 1} in the numbering "
      "of Clancy et al. (2000) that the MCD uses (MY 1 began at L_s = 0 on 1955 April 11, MCD manual §1.2).")
    w(f"- Column dust (visible, 610 Pa), MCD climatology scenario: annual global mean {m['annual']:.3f}; minimum "
      f"{m['min']:.3f} at L_s ≈ {m['ls_min']:.0f}° (aphelion clear season), maximum {m['max']:.3f} at L_s ≈ "
      f"{m['ls_max']:.0f}° (perihelion dust season).")
    w(f"- Dust asymmetry at 650 nm: measured double-HG (Chen-Chen et al. 2019) g = {m['g_dhg']:.3f} "
      f"(text {m['g_text']}); the MCD's Wolff et al. dust {m['g650_table']:.3f}. SSA at 650 nm: MCD table "
      f"{m['ssa650_table']:.3f}; the value Chen-Chen et al. took from Wolff et al. (2009) for the MSL cameras "
      f"{m['ssa_assumed_cc']}. The asymmetry agreement is an independent check (sky-radiance fit vs T-matrix "
      "calculation); the SSA agreement supports the attribution of the LMD file to Wolff et al.")
    w(f"- CO2 Rayleigh τ(550) = {m['rayleigh550']:.4f} at 636 Pa; dust τ(550) = {m['dust550']:.3f} (annual mean) — "
      "dust dominates the sky colour.")
    cc = C.co2_refractivity_check()
    co2 = C.co2_check()
    w(f"- CO2 refractivity (Owens 1967 via Bodhaine Eq. 27, scaled 15 → 0 °C) vs Bideau-Mehu et al. (1973): max "
      f"relative difference {cc['max_rel']:.1e} at 400–830 nm. Bodhaine's Table 2 CO2 optical depths "
      f"(360 ppm, 300–370 nm) are NOT reproduced by their Section 5 recipe (ours are {co2['max_rel'] * 100:.0f} % "
      f"lower with m = 44.01 as stated); at 370 nm the table implies σ_CO2/σ_air = {co2['table_ratio370']:.2f} "
      f"(τ_CO2 / (τ_air × 360 ppm)) where Eq. 22 with the two refractivities gives {co2['our_ratio370']:.2f}. The "
      "cross-section itself is validated by the refractivity check; the table's column bookkeeping is unclear.")
    w("")

    # ---------------------------------------------------------------- Titan
    t = C.titan_checks(diag["606"])
    d6 = diag["606"]
    e6 = B["606"]
    v = TC.results()
    wl = np.array(out["wavelengthsNm"], float)
    ssa = d6["ssa"]
    ssa_top, ssa_low = atmo.sample(ssa["top"]), atmo.sample(ssa["low"])
    i400, i500, i550, i650, i800 = (int(np.argmin(np.abs(wl - x))) for x in (400, 500, 550, 650, 800))
    rows = ab._ssa_rows()
    lt, wt = rows["above_200km"]
    ll, wl_ = rows["below_80km"]
    rule_max = float(np.abs(ab.doose_rule(np.interp(ll, lt, wt)) - wl_).max())
    g_lo = ab.tab_asymmetry(d6["phase_lo"]["anglesDeg"], d6["phase_lo"]["values"])
    g_hi = ab.tab_asymmetry(d6["phase_hi"]["anglesDeg"], d6["phase_hi"]["values"])
    sr = e6["surfaceReflectance"]["value"]
    tau_h = sum(c["columnOpticalDepth"][i550] for c in e6["components"] if c["id"].startswith("haze"))
    tau_m = next(c for c in e6["components"] if c["id"] == "methane")["columnOpticalDepth"]
    w("## Titan")
    w("")
    w("Five components over a surface (`surfaceReflectance`), all from the Huygens descent (landing site, 10° S, "
      "January 2005) and used for the whole globe; Titan is drawn from them alone (docs/rendering-earth.md §8 "
      "\"Titan\"), so its disk-integrated brightness and colour are a test of these numbers (below).")
    w("")
    w(f"- **Haze extinction** (DISR model, Tomasko et al. 2008 via Bazzon et al. 2014): τ = {t['tau_531']:.2f} at "
      f"531 nm, {t['tau_550']:.2f} at 550 nm, {t['tau_650']:.2f} at 650 nm, {t['tau_940']:.2f} at 940 nm, "
      f"{t['tau_1080']:.2f} at 1080 nm; Vincendon & Langevin (2010) quote Tomasko et al.'s total as "
      f"{t['tau_1080_tomasko']} at 1.08 µm. The haze is three components sharing this extinction (below 80 km; above "
      "80 km with weights 1 − w and w, w = (z − 80 km)/120 km), so that its albedo can change with altitude as Doose "
      f"et al. (2016) prescribe; their columns add to τ(550) = {tau_h:.2f}.")
    w(f"- **Haze single-scattering albedo** (Doose et al. 2016, paywalled; digitized from the vector drawing of "
      f"Barnes et al. 2018, Fig. 4, free to read; `tables/titan_doose_2016_ssa.csv`, `titan_digitize.py`): above "
      f"200 km {ssa_top[i500]:.3f} at 500 nm, {ssa_top[i650]:.3f} at 650 nm, {ssa_top[i800]:.3f} at 800 nm; below "
      f"80 km {ssa_low[i500]:.3f}, {ssa_low[i650]:.3f}, {ssa_low[i800]:.3f}. The two curves obey Doose et al.'s "
      f"rule ω(< 80 km) = (0.565 + ω(> 200 km))/1.5 (Es-sayeh et al. 2023) to {rule_max:.4f}. Below "
      f"{ssa['first_nm']:.0f} nm Doose et al. give nothing (\"poorly constrained shortwards of 490 nm\", García Muñoz "
      f"et al. 2017): the above-200-km curve is continued linearly (the line through its 500–600 nm vertices) and "
      f"the other by the rule, giving {ssa_top[i400]:.3f} / {ssa_low[i400]:.3f} at 400 nm — an extrapolation, and "
      "the model's largest error (below).")
    w(f"- **Haze phase functions** (Tomasko et al. 2008, Table 1, from the machine-readable copy in Adamkovics et al. "
      f"2016's reference data): below and above 80 km; asymmetry g = {g_lo.min():.3f}–{g_lo.max():.3f} and "
      f"{g_hi.min():.3f}–{g_hi.max():.3f}. Resampled log-linearly in angle through the forward peak, the rows "
      f"integrate to {np.min(d6['phase_lo']['raw_norm']):.4f}–{np.max(d6['phase_hi']['raw_norm']):.4f} before "
      "renormalization.")
    w(f"- **Methane** (pure absorber): Karkoschka's (1998) cold-temperature absorption coefficients × the Huygens "
      f"GCMS mole fraction at the DTWG altitudes × the HASI density; column {d6['ch4_column_km_am']:.2f} km-amagat; "
      f"vertical τ = {max(tau_m):.2f} at the strongest sample ({wl[int(np.argmax(tau_m))]:.0f} nm, 10 nm box average "
      "of the extinction).")
    w(f"- N2 Rayleigh τ(550) = {t['rayleigh550']:.3f} (HASI surface {t['surface_P']:.0f} Pa, {t['surface_T']:.2f} K, "
      f"n = {t['surface_n']:.3e} m⁻³).")
    w(f"- **Surface**: Lambert reflectance {min(sr['reflectance']):.3f}–{max(sr['reflectance']):.3f} over 360–830 nm "
      f"(the values García Muñoz et al. 2017 adopted from Karkoschka & Schröder's 2016 DISR maps); X, Y, Z, S "
      f"equivalents {', '.join(f'{x:.3f}' for x in sr['channelEquivalents'])}.")
    w("- **Labels**: every haze quantity and the surface are `estimated` — DISR retrievals (their authors' radiative-"
      "transfer fits to the descent data), read from a figure or a secondary machine-readable copy, and one landing "
      "site used for the whole moon. The methane mole-fraction profile is `derived` (two measured products "
      "combined: the GCMS mole fraction and the DTWG altitude, by time), its absorption coefficient `estimated` "
      "(Karkoschka's own label).")
    w("")
    m = v["mc"]
    s = v["spectrum"]
    w("### The model against Titan's measured brightness")
    w("")
    w(f"The model is solved by a Monte Carlo reference (`titan_rt.py`: {m['photons']:,} photons per sample, "
      "spherical geometry, every order of scattering with the tabulated phase functions; tested against exact "
      "solutions in `pipeline/tests/test_titan_rt.py`; `docs/reports/titan-mc.json`), so this tests the data, not "
      f"the renderer. Compared with Karkoschka's (1998) full-disk albedo at {s['alpha_obs']}° (1995; absolute "
      f"calibration ±{100 * s['observed_sigma']:.0f} %, 1σ) — the model in the reference's first bin (α 0–"
      f"{s['alpha_mod_max']:.1f}°, solid-angle mean {s['alpha_mod_mean']:.1f}°), the observation box-averaged over "
      "each 10 nm sample:")
    w("")
    w("| λ (nm) | " + " | ".join(f"{x:.0f}" for x in s["wl"][::4]) + " |")
    w("|---|" + "---|" * len(s["wl"][::4]))
    w("| model | " + " | ".join(f"{x:.3f}" for x in s["model"][::4]) + " |")
    w("| observed | " + " | ".join(f"{x:.3f}" for x in s["observed"][::4]) + " |")
    w("| ratio | " + " | ".join(f"{x:.2f}" for x in s["ratio"][::4]) + " |")
    w("")
    rat = np.array(s["ratio"])
    rel = np.array(s["model_sigma"]) / np.array(s["model"])
    w(f"- 520–830 nm: model / observed {rat[wl >= 520].min():.2f}–{rat[wl >= 520].max():.2f}; 440–510 nm: "
      f"{rat[(wl >= 440) & (wl <= 510)].min():.2f}–{rat[(wl >= 440) & (wl <= 510)].max():.2f}; below 440 nm "
      f"{rat[wl < 440].min():.2f}–{rat[wl < 440].max():.2f}, where the haze albedo is extrapolated: the model is "
      f"too bright in the violet and blue. Monte Carlo noise per sample: {100 * rel.min():.1f}–{100 * rel.max():.1f} % "
      "(1σ).")
    cr, cs, sh = s["xyzs_ratio"], s["xyzs_ratio_sigma"], s["extrapolated_share"]
    w("- Folded to X, Y, Z, S: model / observed "
      + ", ".join(f"{x:.3f} ± {e:.3f}" for x, e in zip(cr, cs))
      + " (± the Monte Carlo noise, 1σ; folding 10 nm samples instead of integrating at 1 nm changes the "
      f"observation's own channels by at most {100 * max(abs(x) for x in s['fold_error']):.2f} %). The luminance "
      f"agrees with the measurement ({100 * (cr[1] - 1):+.1f} % against ±{100 * s['observed_sigma']:.0f} %); Z is "
      f"{100 * (cr[2] - 1):+.1f} %, {(cr[2] - 1) / s['observed_sigma']:.1f}σ of the absolute calibration alone, and the "
      f"colour ratio Z/Y, in which a calibration error common to all wavelengths cancels, is "
      f"{100 * (cr[2] / cr[1] - 1):+.1f} %. {100 * sh[2]:.0f} % of the model's Z (and {100 * sh[1]:.0f} % of its Y) "
      f"comes from the samples below {ssa['first_nm']:.0f} nm, where the haze albedo is extrapolated.")
    w(f"- Colour of the reflected sunlight (CIE 1931 x, y): {s['xy_model'][0]:.4f}, {s['xy_model'][1]:.4f} (model) "
      f"against {s['xy_observed'][0]:.4f}, {s['xy_observed'][1]:.4f} (observed); Δu′v′ = {s['delta_uv']:.4f} ± "
      f"{s['delta_uv_sigma']:.4f} (Monte Carlo): the model is bluer (less orange) than Titan.")
    w("- How independent the test is: Doose et al.'s (2016) model was developed against radiances measured \"inside "
      "and outside the atmosphere\" (its title), and García Muñoz et al. (2017, Methods) note that it is "
      "\"consistent with past spectroscopic measurements of the geometric albedo between 500 and 950 nm\" "
      "(Karkoschka's). Agreement above 500 nm therefore shows that the transcribed model and the radiative "
      "transfer reproduce the published one, more than it tests that model; and Karkoschka's methane coefficients "
      "were partly inferred from Titan's own spectrum (`tables/titan_disr_haze.json`), so the depths of the methane "
      "bands are not independent either. Below 500 nm the comparison is a real test, of the extrapolation, and it "
      "fails.")
    w("")
    w("Cassini ISS disk-integrated phase curves (García Muñoz et al. 2017, Fig. 1, digitized: "
      "`tables/titan_garcia_munoz_2017_iss.csv`; NAC images 2004–2015, CISSCAL calibration ~10 %), median of "
      "measured / model over the measurements in each phase-angle range, the model band-averaged with the SVO NAC "
      "system responses:")
    w("")
    hdr = ["0–30°", "30–60°", "60–90°", "90–120°", "120–150°", "150–160°", "160–170°"]
    groups = [(0, 30), (30, 60), (60, 90), (90, 120), (120, 150), (150, 160), (160, 170)]
    w("| filter | λeff (nm) | n | all | " + " | ".join(hdr) + " |")
    w("|---|---|---|---|" + "---|" * len(hdr))
    iss = v["iss"]

    def grouped(name: str, ratio_of) -> list[str]:
        al, val = TD.read_iss()[name]
        out_ = []
        for lo, hi in groups:
            sel = (al >= lo) & (al < hi)
            out_.append(f"{np.median(ratio_of(al[sel], val[sel])):.2f}" if sel.sum() else "—")
        return out_

    mcd = TC.mc()
    cells_of: dict[str, list[float]] = {}

    def ISS_BROAD(n: str) -> bool:  # noqa: N802
        return TC.ISS[n][1]

    for name, f in iss.items():
        curve = np.array([TC.filters.band_average(f["filter"], mcd["wl"], mcd["A"][:, j])
                          for j in range(mcd["alpha"].size)])
        cells = grouped(name, lambda a, x: x / np.interp(a, mcd["alpha"], curve))
        cells_of[name] = [float(c) if c != "—" else np.nan for c in cells]
        w(f"| {name}{'' if f['broad'] else ' *'} | {f['lambda_eff_nm']:.0f} | {f['n']} | {f['median_ratio']:.2f} | "
          + " | ".join(cells) + " |")
    w("")
    w("\\* Methane filters (5 nm wide): the model's 10 nm samples (box-averaged extinction) do not resolve them.")
    w("")

    def span(names, i0, i1):
        x = np.array([cells_of[n][i0:i1] for n in names], float)
        return np.nanmin(x), np.nanmax(x)

    lo_c, hi_c = span(["CL1_GRN", "CL1_CB1", "RED_CL2"], 0, 5)
    lo_2, hi_2 = span(["CL1_CB2"], 0, 5)
    lo_b, hi_b = span(["BL1_CL2"], 0, 5)
    lo_h, hi_h = span([n for n in cells_of if ISS_BROAD(n)], 5, 7)
    w(f"- Green to red continuum (GRN, CB1, RED), 0–150°: measured / model {lo_c:.2f}–{hi_c:.2f}; CB2 (750 nm) "
      f"{lo_2:.2f}–{hi_2:.2f}; BL1 (455 nm) {lo_b:.2f}–{hi_b:.2f}, the model too bright in the blue as against "
      "Karkoschka's spectrum.")
    w(f"- Beyond 150° every filter is measured below the model ({lo_h:.2f}–{hi_h:.2f}): its forward scattering "
      "through the limb is too strong. Its inputs there are the DISR phase functions at small angles and the "
      "extinction above 150 km, which DISR did not measure (the 65 km scale height extrapolated to 500 km; Titan's "
      "detached haze and season, 2004–2015, not represented).")
    w("")
    r = v["renderer"]
    if r:
        q = np.array(r["ratio_to_mc"])
        ph = r["phases"]
        w("### The renderer")
        w("")
        w("The renderer's CPU twin (`atmosphere.ts` `diskReflectanceSpectral`, the tables and march of the shaders; "
          "`app/tests/render-titan.test.ts`, `docs/reports/titan-renderer.json`) against the same reference, every "
          "sample its own bin (range over the 48 samples, and the median):")
        w("")
        w("| α | " + " | ".join(f"{a:.0f}°" for a in ph) + " |")
        w("|---|" + "---|" * len(ph))
        w("| min | " + " | ".join(f"{x:.2f}" for x in q.min(axis=1)) + " |")
        w("| median | " + " | ".join(f"{x:.2f}" for x in np.median(q, axis=1)) + " |")
        w("| max | " + " | ".join(f"{x:.2f}" for x in q.max(axis=1)) + " |")
        noise = [float(np.median(np.array([np.interp(a, mcd["alpha"], row) for row in mcd["sigma"]])
                                 / TC.mc_at(mcd, a))) for a in ph]
        w("| reference 1σ | " + " | ".join(f"{x:.2f}" for x in noise) + " |")
        w("")
        w(f"The reference's own noise per sample and phase bin (last row: its median over the samples, "
          f"{100 * min(noise):.0f}–{100 * max(noise):.0f} %) accounts for much of the spread between min and max; "
          "the median over the 48 samples is the renderer's systematic error, known to about "
          f"{100 * max(noise) / math.sqrt(48):.1f} %.")
        w("")
        ca = r["xyzs_ratio_app_bins"]
        cp = r["xyzs_ratio_per_sample"]
        tol = 2.0 * TC.K98_ABSOLUTE
        w(f"Against Karkoschka at 5.7° (pass: within 2σ = ±{100 * tol:.0f} % per channel; the renderer at "
          f"{ph[0]:.2f}°, where its light differs from that at 5.7° by about 0.1 %): with the app's 12 bins of 4 "
          f"samples X, Y, Z, S = {', '.join(f'{x:.3f}' for x in ca)} of observed "
          f"({', '.join(f'{x:.3f}' for x in cp)} with every sample its own bin), that is "
          f"{', '.join(f'{x:.3f}' for x in r['xyzs_app_bins_over_mc'])} of the reference: the renderer's own "
          f"approximation adds {100 * (min(r['xyzs_app_bins_over_mc']) - 1):.1f}–"
          f"{100 * (max(r['xyzs_app_bins_over_mc']) - 1):.1f} % at this phase. Colour x, y "
          f"{r['xy_app_bins'][0]:.4f}, {r['xy_app_bins'][1]:.4f} against {r['xy_observed'][0]:.4f}, "
          f"{r['xy_observed'][1]:.4f} (Δu′v′ {r['delta_uv_app_bins']:.4f}). "
          + ", ".join(f"{c} {'PASS' if abs(x - 1) <= tol else 'FAIL'} ({100 * (x - 1):+.1f} %)"
                      for c, x in zip("XYZS", ca)) + ".")
        w("")
        w(f"Against the ISS phase curves (pass: each range's median within 2σ = ±{200 * TC.ISS_ABSOLUTE:.0f} %; "
          "measured / renderer):")
        w("")
        w("| filter | all | " + " | ".join(hdr) + " | result |")
        w("|---|---|" + "---|" * len(hdr) + "---|")
        per = np.array(json.loads(TC.RENDERER_JSON.read_text())["perSample"]["A"])
        wl_r = np.array(json.loads(TC.RENDERER_JSON.read_text())["perSample"]["wavelengthsNm"])
        for name, f in r["iss"].items():
            key = TC.ISS[name][0]
            curve = np.array([TC.filters.band_average(key, wl_r, row) for row in per])
            cells = grouped(name, lambda a, x: x / np.interp(a, ph, curve))
            lim = 2.0 * TC.ISS_ABSOLUTE
            ok = all(c == "—" or abs(float(c) - 1) <= lim for c in cells)
            fails = [h for h, c in zip(hdr, cells) if c != "—" and abs(float(c) - 1) > lim]
            res = "PASS" if ok else "FAIL (" + ", ".join(fails) + ")"
            if not f["broad"]:
                res += " *"
            w(f"| {name} | {f['median_ratio']:.2f} | " + " | ".join(cells) + f" | {res} |")
        w("")
    w("")
    # ---------------------------------------------------------------- Venus
    vm = diag["299"]["mie"]
    i550 = 19
    w("## Venus")
    w("")
    w(f"- Cloud/haze τ = 1 at 70 km (365 nm), 4 km scale height to 80 km, 4.8 km above (Lee et al. 2021; Pere et al. "
      f"2016). Mie droplets of Hansen & Hovenier (1974): g(550) = {vm['g'][i550]:.3f}, extinction relative to 365 nm "
      f"{vm['rel_ext'][0]:.3f}–{vm['rel_ext'].max():.3f} over 360–830 nm (nearly grey).")
    w("")

    # ---------------------------------------------------------------- Pluto
    p = C.pluto_checks(diag["999"])
    w("## Pluto")
    w("")
    w(f"- Mie spheres of radius 0.2 µm, n = 1.69 + 0.018i at 607.6 nm (Gladstone et al. 2016's example): P at phase "
      f"165° (scattering angle 15°) = {p['P165']:.2f} vs their ≈ 5; Q_sca = {p['Qsca']:.2f} vs ≈ 2.7; ω = "
      f"{p['ssa']:.3f}, g = {p['g']:.3f}.")
    w(f"- Measured haze I/F ratio phase 167° / 20° at 45 km (Cheng et al. 2017 Table 4): {p['ratio_meas_45km']:.1f}; "
      f"the Mie phase-function ratio P(13°)/P(160°) = {p['ratio_mie']:.1f} (single scattering, same path): the "
      f"measured haze is {100 * (p['ratio_meas_45km'] / p['ratio_mie'] - 1):.0f} % more forward-scattering than the "
      "sphere model at that altitude (Cheng et al. note that the 45 km phase function lacks the backscatter lobe "
      "of spheres and resembles Titan's aggregate haze).")
    w(f"- Colour exponent (extinction ∝ λ^-a) from the MVIC blue/red I/F: a = {p['a'][0]:.1f} "
      f"({p['a'][1]:.1f}–{p['a'][2]:.1f}).")
    w("")

    # ---------------------------------------------------------------- giants
    w("## Giant planets")
    w("")
    w("NSSDCA scale heights near 1 bar, and kT/(μ m_u g) from the same sheets' 1 bar temperature, mean molecular "
      "weight and gravity:")
    w("")
    w("| planet | NSSDCA H (km) | kT/(μ m_u g) (km) | T (K) | μ | g (m/s²) |")
    w("|---|---|---|---|---|---|")
    for g in C.giants():
        w(_row(g["name"], f"{g['H_nssdc']:.1f}", f"{g['H_calc']:.1f}", f"{g['T']:.0f}", f"{g['mu']:.2f}",
               f"{g['g']:.2f}"))
    w("")
    diffs = ", ".join(f"{g['name']} {100 * (g['H_nssdc'] / g['H_calc'] - 1):+.0f} %" for g in C.giants())
    w(f"Sheet H relative to kT/(μ m_u g): {diffs} (the sheets do not say at what level or temperature their scale "
      "heights apply). Limb haze is `unknown` for all four.")
    w("")
    w("## Not included")
    w("")
    for e in B.values():
        if e.get("omitted"):
            w(f"- {e['name']}: {e['omitted']}")
    w("")
    OUT.write_text("\n".join(L), encoding="utf-8", newline="\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
