"""Write docs/reports/atmospheres.md: what atmospheres.json holds and the checks against published values.

Run: `uv run python -m pipeline.photometry.atmo_report` (builds atmospheres.json in memory; no BuildContext)."""

from __future__ import annotations

import spiceypy as sp

from ..paths import REPO
from . import atmo_checks as C, atmo_mars as am, atmospheres as A

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
    w("- Every quantity is `Sourced` with a label; `unknown` quantities (Titan's haze single-scattering albedo and "
      "phase function) must not be rendered as if known.")
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
    w("## Titan")
    w("")
    w(f"- Haze column (DISR model, Tomasko et al. 2008 via Bazzon et al. 2014): τ = {t['tau_531']:.2f} at 531 nm, "
      f"{t['tau_550']:.2f} at 550 nm, {t['tau_650']:.2f} at 650 nm, {t['tau_940']:.2f} at 940 nm, "
      f"{t['tau_1080']:.2f} at 1080 nm; Vincendon & Langevin (2010) quote Tomasko et al.'s total as "
      f"{t['tau_1080_tomasko']} at 1.08 µm.")
    w(f"- N2 Rayleigh τ(550) = {t['rayleigh550']:.3f} (HASI surface {t['surface_P']:.0f} Pa, {t['surface_T']:.2f} K, "
      f"n = {t['surface_n']:.3e} m⁻³).")
    w("- **Unknown**: the haze single-scattering albedo and phase function. They are in Tomasko et al. (2008, "
      "Table 2, Fig. 48 and the tabulated phase functions) and Doose et al. (2016), which are not accessible here "
      "(Elsevier); no open transcription of the numbers was found. Titan's haze cannot be rendered physically "
      "until they are supplied (a hand copy of the paper would do, as for ROLO). The disk-integrated colour remains "
      "calibrated by `photometry.json`.")
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
    OUT.write_text("\n".join(L))
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
