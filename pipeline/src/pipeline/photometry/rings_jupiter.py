"""Jupiter's rings as components (rings.json "599".components; ring_components.py for the model).

All four components are optically thin dust and parent-body populations (normal τ ~ 1e-8 to 5e-6), circular and
equatorial; everything is estimated.

Main ring (sheets): Throop et al. (2004) fit the main ring's radially averaged (6500 km) normal τϖ0P from Voyager,
Galileo, Cassini and Earth-based data at 0.5-178° phase with large parent bodies (τ_l = 1.3e-6, Callisto-like phase
function) plus non-spherical dust (τ_s = 4.7e-6; abstract values, also quoted by de Pater et al. 2018; their Sect. 4.3
swaps the two labels). The phase dependence of each population at 0.46 µm (their Fig. 4) and its spectrum at α ~ 75°
(their Fig. 6: the large bodies very red, the dust less so) are digitized and combined (separable in α and λ, an
assumption) into a phase-function table per population: ϖ0P_c(α) per unit τ in each CIE channel. The radial
distribution of each population is the shape of Cassini's radial profiles (their Fig. 7): the forward-scattering
(α = 120°) profile for the dust, and the backscatter (α ≈ 1°) profile minus the dust's share of it for the large
bodies (concentrated between Metis and Adrastea, as Galileo's low-phase profiles show).

Halo (torus): dust interior to the main ring, 100,000-122,800 km (Burns et al. 2004), normal τ a factor of a few below
the main ring's (taken as 1/3 of the main ring's dust τ), rising linearly outward (the shape of the Keck 2.2 µm
profiles, de Pater et al. 2018 Fig. 6.5a), with Showalter et al.'s (2001) vertical structure: density ∝ |z|^-0.6 near
the ring plane, |z|^-1.5 beyond a few thousand km (3000 km), detected beyond 20,000 km: the power law is continued to
50,000 km (7 % of the column then lies beyond 20,000 km; a cut at the detection limit would draw a hard edge that is not
observed). The halo "opens up into a torus" inward of the main ring, whose inner boundary it meets with a core ~600 km
thick: these heights hold at 100,000 km and shrink linearly to a tenth at 122,800 km. Same dust phase function as the
main ring.

Gossamer rings (tori): dust from Amalthea and Thebe evolving inward with the moons' inclinations (Burns et al. 1999),
so each ring's half-thickness is a·sin i of its moon scaled by r/a (inclined-orbits density, peaked at the edges);
Amalthea's ring τ ~ 1e-7, Thebe's 5-10 times fainter (√50 ≈ 7.1 used), the Thebe ring's outward extension about 10 %
of the Thebe ring with constant thickness (Showalter et al. 2008), to 240,000 km (the outermost region they measured).
Same dust phase function as the main ring (Showalter et al. 2008: the gossamer dust's size distribution and phase
behaviour are very similar to the main ring's).
"""

from __future__ import annotations

import math

import numpy as np

from ..schema import BuildContext
from . import ring_components as rc
from .common import Download, read_table_csv

THROOP = Download(
    id="throop-2004-jupiter-rings", url="https://ciclops.org/media/sp/2007/2687_7449_0.pdf", subdir="papers",
    name="throop-2004-icarus-172-59.pdf",
    title="The jovian rings: Cassini, Galileo, Voyager and Earth-based photometry (Figs. 4, 6, 7; optical depths)",
    citation="Throop, H. B., Porco, C. C., West, R. A., Burns, J. A., Showalter, M. R. & Nicholson, P. D. (2004). "
             "The jovian rings: new results derived from Cassini, Galileo, Voyager, and Earth-based observations. "
             "Icarus 172, 59-77. DOI:10.1016/j.icarus.2003.12.020 (copy hosted by the Cassini imaging team, "
             "CICLOPS).",
    notes="Figs. 4, 6 and 7 digitized to photometry/tables/throop_2004_fig{4_phase_curve,4_data,6_spectrum,"
          "7_profiles}.csv.")
BURNS = Download(
    id="burns-2004-jupiter-ring-moon", url="https://lasp.colorado.edu/mop/files/2015/08/jupiter_ch11-1.pdf",
    subdir="papers", name="burns-2004-jupiter-ch11.pdf",
    title="Jupiter's ring-moon system (halo and gossamer ring structure and optical depths; Table 11.1 moon orbits)",
    citation="Burns, J. A., Simonelli, D. P., Showalter, M. R., Hamilton, D. P., Porco, C. C., Throop, H. & "
             "Esposito, L. W. (2004). Jupiter's ring-moon system. In Bagenal, F., Dowling, T. E. & McKinnon, W. B. "
             "(eds.), Jupiter: The Planet, Satellites and Magnetosphere, Cambridge University Press, 241-262 (no DOI; "
             "copy hosted by LASP, University of Colorado).",
    notes="Halo extent and vertical power laws (Showalter et al. 2001), gossamer optical depths (Showalter 1989, Burns "
          "et al. 2001), Amalthea and Thebe orbits (Table 11.1), main ring radially integrated backscatter E ~ 0.4 m.")
SHOWALTER_2008 = Download(
    id="showalter-2008-gossamer", url="https://pages.astro.umd.edu/~dphamil/research/reprints/ShoPatVer08.pdf",
    subdir="papers", name="showalter-2008-icarus-195-361.pdf",
    title="Properties and dynamics of Jupiter's gossamer rings (Thebe ring extension; vertical structure)",
    citation="Showalter, M. R., de Pater, I., Verbanac, G., Hamilton, D. P. & Burns, J. A. (2008). Properties and "
             "dynamics of Jupiter's gossamer rings from Galileo, Voyager, Hubble and Keck images. Icarus 195, "
             "361-377. DOI:10.1016/j.icarus.2007.12.012 (author-hosted copy, D. P. Hamilton, University of Maryland).",
    notes="Thebe ring extension ~10 % as bright, constant thickness, measured to 235,000-240,000 km (Sect. 4).")
DE_PATER_JUPITER = Download(
    id="de-pater-2018-jupiter-rings", url="https://arxiv.org/pdf/1707.00806v2", subdir="papers",
    name="arXiv-1707.00806v2.pdf",
    title="The rings of Jupiter (review: Figs. 6.3, 6.5 radial profiles; quotes Throop et al. 2004 optical depths)",
    citation="de Pater, I., Hamilton, D. P., Showalter, M. R., Throop, H. B. & Burns, J. A. (2018). The rings of "
             "Jupiter. In Tiscareno, M. S. & Murray, C. D. (eds.), Planetary Ring Systems, Cambridge University "
             "Press, 125-134. DOI:10.1017/9781316286791.006 (manuscript arXiv:1707.00806v2).",
    notes="Shape of the halo's radial profile (Fig. 6.5a); Galileo low-phase main-ring profile (Fig. 6.5c) as a check.")

RJ_KM = 71492.0                    # Throop et al. (2004): 1.79 R_J = 127,970 km
TAU_LARGE, TAU_DUST = 1.3e-6, 4.7e-6
LAMBDA_FIG4_UM = 0.46
WINDOW_RJ = (1.72, 1.72 + 6500.0 / RJ_KM)  # the 6500 km width over which Throop et al. average
N_CALLISTO = 3.09                  # Callisto-like power law (Porco et al. 2003 via Throop et al. 2004)
PHASE_MAX = 179.2                  # where Throop et al.'s Fig. 4 model curve leaves the plot (1e-3)
HALO = (100000.0, 122800.0)
HALO_TAU_FRACTION = 1.0 / 3.0      # "a factor of a few less than that of the main ring" (Burns et al. 2004)
HALO_VERTICAL = {"law": "broken-power-law", "zBreakKm": 3000.0, "zMaxKm": 50000.0, "innerSlope": 0.6,
                 "outerSlope": 1.5, "outerScale": 0.1}
MAIN_OUTER_KM = 129200.0
AMALTHEA = (181400.0, 0.388)       # Burns et al. (2004) Table 11.1: a (km), i (deg)
THEBE = (221900.0, 1.070)
TAU_AMALTHEA = 1e-7
TAU_THEBE = TAU_AMALTHEA / math.sqrt(50.0)
THEBE_EXT_OUTER_KM = 240000.0
THEBE_EXT_FRACTION = 0.1


def phase_curves() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(α, large-body τϖ0P, dust τϖ0P) at 0.46 µm on rc.PHASE_GRID; large bodies beyond the digitized range follow
    the Callisto-like power law matched at its last point."""
    rows = read_table_csv("throop_2004_fig4_phase_curve.csv")
    a = np.array([float(r["phase_deg"]) for r in rows])
    tot = np.array([float(r["total_tau_w0_p"]) for r in rows])
    lg = np.array([float(r["large_tau_w0_p"]) if r["large_tau_w0_p"] else np.nan for r in rows])
    ok = np.isfinite(lg)
    a_last, l_last = a[ok][-1], lg[ok][-1]
    grid = np.asarray(rc.PHASE_GRID)

    def large(x):
        x = np.asarray(x, float)
        inside = np.exp(np.interp(x, a[ok], np.log(lg[ok])))
        beyond = l_last * (np.clip(180.0 - x, 1e-6, None) / (180.0 - a_last)) ** N_CALLISTO
        return np.where(x <= a_last, inside, beyond)

    # total: log-linear in α, extrapolated beyond the last point with the last slope (outside the domain)
    lt = np.log(tot)
    slope = (lt[-1] - lt[-2]) / (a[-1] - a[-2])
    total = np.where(grid <= a[-1], np.exp(np.interp(grid, a, lt)), np.exp(lt[-1] + slope * (grid - a[-1])))
    lg_g = large(grid)
    dust = total - lg_g
    if np.any(dust <= 0):
        raise ValueError("Throop Fig. 4: large-body curve above the total")
    return grid, lg_g, dust


def spectra() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rows = read_table_csv("throop_2004_fig6_spectrum.csv")
    wl = np.array([float(r["wavelength_um"]) for r in rows]) * 1000.0
    return wl, np.array([float(r["large_tau_w0_p"]) for r in rows]), np.array([float(r["dust_tau_w0_p"]) for r in rows])


def channel_factors(wl_nm: np.ndarray, spec: np.ndarray) -> np.ndarray:
    """XYZS solar-weighted channel averages of the spectrum normalized at 0.46 µm (held flat below its first point)."""
    from .ring_reflectance import channels
    s = spec / np.interp(LAMBDA_FIG4_UM * 1000.0, wl_nm, spec)
    w = np.concatenate([[355.0], wl_nm])
    v = np.concatenate([[s[0]], s])
    return channels(w, v)


def profiles() -> dict:
    rows = read_table_csv("throop_2004_fig7_profiles.csv")
    r = np.array([float(x["radius_rj"]) for x in rows])
    p1 = np.array([float(x["iof_1deg_1e6"]) if x["iof_1deg_1e6"] else np.nan for x in rows])
    p120 = np.array([float(x["iof_120deg_1e6"]) if x["iof_120deg_1e6"] else np.nan for x in rows])
    return {"r": r, "p1": p1, "p120": p120}


def window_mean(r: np.ndarray, v: np.ndarray) -> float:
    m = (r >= WINDOW_RJ[0] - 1e-9) & (r <= WINDOW_RJ[1] + 1e-9)
    return float(np.nanmean(v[m]))


def main_ring_shapes(dust_fraction_1deg: float) -> dict:
    """Radial shapes (normalized to mean 1 over the 6500 km window) of the dust and the large bodies."""
    p = profiles()
    r = p["r"]
    d = np.clip(np.nan_to_num(p["p120"], nan=0.0), 0.0, None)
    p1 = np.clip(np.nan_to_num(p["p1"], nan=0.0), 0.0, None)
    k = dust_fraction_1deg * window_mean(r, p1) / window_mean(r, d)
    lg = np.clip(p1 - k * d, 0.0, None)
    keep_d = np.flatnonzero(d > 0)
    keep_l = np.flatnonzero(lg > 0)
    sl = lambda v, idx: (r[idx[0] - 1:idx[-1] + 2], v[idx[0] - 1:idx[-1] + 2])       # noqa: E731  one zero each side
    rd, dd = sl(d, keep_d)
    rl, ll = sl(lg, keep_l)
    return {"dust": (rd, dd / window_mean(r, d)), "large": (rl, ll / window_mean(r, lg)), "k": k}


def build(ctx: BuildContext | None) -> tuple[dict, dict]:
    reg = lambda d: d.register(ctx) if ctx else d.id      # noqa: E731
    s_thr, s_burns, s_sho, s_dp = reg(THROOP), reg(BURNS), reg(SHOWALTER_2008), reg(DE_PATER_JUPITER)
    grid, large, dust = phase_curves()
    wl, sp_l, sp_d = spectra()
    f_l, f_d = channel_factors(wl, sp_l), channel_factors(wl, sp_d)
    sep = ("separable in phase and wavelength: the phase curve at 0.46 µm (Throop et al. 2004 Fig. 4) times the "
           "spectrum at α ~ 75° normalized at 0.46 µm (Fig. 6), through the CIE observer under sunlight; held flat "
           "below 0.42 µm")
    tables = {
        "jupiter-large": rc.phase_table(
            "Jupiter main ring parent bodies (ϖ0P per unit τ)", np.outer(large / TAU_LARGE, f_l), "estimated",
            [s_thr],
            f"ϖ0P(α) = τϖ0P(α)/τ_l, τ_l = {TAU_LARGE:g}: the large-body component of Throop et al.'s best fit (dashed "
            "line, digitized to 125°; beyond, the Callisto-like power law ((180°−α)/180°)^3.09 it follows), " + sep +
            f". Channel factors X, Y, Z, S = {', '.join(f'{x:.3f}' for x in f_l)}.", domain=(0.0, PHASE_MAX)),
        "jupiter-dust": rc.phase_table(
            "Jupiter ring dust (ϖ0P per unit τ)", np.outer(dust / TAU_DUST, f_d), "estimated", [s_thr],
            f"ϖ0P(α) = τϖ0P(α)/τ_s, τ_s = {TAU_DUST:g}: Throop et al.'s total model minus its large-body part "
            "(non-spherical dust, power-law size distribution q = 2 to 15 µm, 5 beyond), " + sep +
            f". Channel factors X, Y, Z, S = {', '.join(f'{x:.3f}' for x in f_d)}. Not measured beyond "
            f"{PHASE_MAX}° (the model curve leaves the published plot).", domain=(0.0, PHASE_MAX)),
    }
    a1 = 1.0
    tot1 = float(np.interp(a1, grid, large + dust))
    dust_frac_1 = float(np.interp(a1, grid, dust)) / tot1
    shapes = main_ring_shapes(dust_frac_1)
    comps: list[rc.Component] = []
    geo_main = rc.Prov("estimated", [s_thr], "Circular and equatorial; the radial extent of Cassini's profile (±0.02 "
                       "R_J = ±1400 km radius uncertainty, Throop et al. 2004).")
    for key, tau, table, name in (("large", TAU_LARGE, "jupiter-large", "main ring (parent bodies)"),
                                  ("dust", TAU_DUST, "jupiter-dust", "main ring (dust)")):
        rr, shape = shapes[key]
        rk = rr * RJ_KM
        w = float(rk[-1] - rk[0])
        how = ("the α = 120° (forward-scattering, dust) radial profile" if key == "dust" else
               f"the α ≈ 1° radial profile minus {shapes['k']:.2f} × the α = 120° profile (the dust's "
               f"{dust_frac_1 * 100:.0f} % share of the α = 1° brightness in Throop et al.'s fit; negative values "
               "clipped)")
        comps.append(rc.Component(
            id=f"jupiter-main-{key}", name=f"Jupiter {name}", inner=rc.edge(float(rk[0])), outer=rc.edge(float(rk[-1])),
            u_start=0.0, u_step=float((rk[1] - rk[0]) / w), profile=tau * shape, width_ref_km=w, width_scaling=False,
            optical_depth_known=True, geometry=geo_main,
            optical_depth=rc.Prov("estimated", [s_thr],
                                  f"Normal τ averaged over the main ring's 6500 km = {tau:g} (Throop et al. 2004 "
                                  f"best-fit {('parent bodies' if key == 'large' else 'dust')}), distributed in radius "
                                  f"as {how} (Cassini ISS, their Fig. 7, digitized; background below zero clipped)."),
            reflectance=rc.Prov("estimated", [s_thr], f"Phase-function table '{table}' (thin: I/F = ϖ0P τ/(4μ))."),
            layer={"phaseFunction": table, "scale": 1.0} if key == "large" else None,
            thin={"phaseFunction": table, "scale": 1.0} if key == "dust" else None))
    # Halo: linear ramp in τ from 0 at its inner edge, mean = HALO_TAU_FRACTION · τ_s.
    u0, du, u = rc.tiled_bins()
    tau_h = HALO_TAU_FRACTION * TAU_DUST * 2.0 * u
    comps.append(rc.Component(
        id="jupiter-halo", name="Jupiter halo ring", kind="torus", inner=rc.edge(HALO[0]), outer=rc.edge(HALO[1]),
        u_start=u0, u_step=du, profile=tau_h, width_ref_km=HALO[1] - HALO[0], width_scaling=False,
        optical_depth_known=True,
        geometry=rc.Prov("estimated", [s_burns],
                         f"Torus from {HALO[0]:.0f} km (where it fades from view, ~1.40 R_J) to the main ring's inner "
                         "edge at 122,800 km (Burns et al. 2004); vertical density ∝ |z|^-0.6 within 3000 km of the "
                         "ring plane, ∝ |z|^-1.5 beyond (Showalter et al. 2001 via Burns et al. 2004: 'a few thousand "
                         "km'; detected to 'more than 20 000 km'), continued to 50,000 km. These heights apply at the "
                         "inner edge and shrink linearly to a tenth at the main ring: the halo 'opens up into a torus' "
                         "inward, its core and the 'halo bloom' being ~600 km thick at the main ring's inner boundary "
                         "(Burns et al. 2004, after Showalter et al. 1987 and Ockert-Bell et al. 1999)."),
        optical_depth=rc.Prov("estimated", [s_burns, s_dp, s_thr],
                              f"Mean normal τ = {HALO_TAU_FRACTION:.2f} × the main ring's dust τ (Burns et al. 2004, "
                              "from Showalter et al. 1987: 'a factor of a few less than that of the main ring'), rising "
                              "linearly outward (the shape of the Keck 2.2 µm profiles, de Pater et al. 2018 Fig. "
                              "6.5a)."),
        reflectance=rc.Prov("estimated", [s_thr], "The main ring's dust phase function ('jupiter-dust'): the halo is "
                            "dust of similar size (Burns et al. 2004; its colour is less red than the main ring's, "
                            "which this does not capture)."),
        thin={"phaseFunction": "jupiter-dust", "scale": 1.0}, vertical=dict(HALO_VERTICAL)))
    for cid, name, r_in, r_out, tau, moon, cap, extra in (
            ("jupiter-gossamer-amalthea", "Amalthea gossamer ring", MAIN_OUTER_KM, AMALTHEA[0], TAU_AMALTHEA,
             AMALTHEA, False, "τ ~ 1e-7 (Burns et al. 2004, from Showalter 1989 and Burns et al. 2001)"),
            ("jupiter-gossamer-thebe", "Thebe gossamer ring", MAIN_OUTER_KM, THEBE[0], TAU_THEBE, THEBE, False,
             "5-10 times fainter than the Amalthea ring (Burns et al. 2004): τ = 1e-7/√50"),
            ("jupiter-gossamer-thebe-extension", "Thebe ring extension", THEBE[0], THEBE_EXT_OUTER_KM,
             TAU_THEBE * THEBE_EXT_FRACTION, THEBE, True,
             "about 10 % of the Thebe ring's brightness (Showalter et al. 2008)")):
        a, inc = moon
        z0 = a * math.sin(math.radians(inc))
        vert = {"law": "inclined-orbits", "r0Km": a, "z0Km": round(z0, 1)}
        if cap:
            vert["zMaxCapKm"] = round(z0, 1)
        comps.append(rc.Component(
            id=cid, name=name, kind="torus", inner=rc.edge(r_in), outer=rc.edge(r_out), u_start=u0, u_step=du,
            profile=np.full(u.size, tau), width_ref_km=r_out - r_in, width_scaling=False, optical_depth_known=True,
            geometry=rc.Prov("estimated", [s_burns, s_sho],
                             f"{r_in:.0f}-{r_out:.0f} km; dust on orbits with the source moon's inclination ({inc}°, "
                             f"Table 11.1 of Burns et al. 2004): density 1/(π√(h²−z²)) with h = {z0:.0f} km" +
                             (" at all radii (the extension keeps the Thebe ring's thickness, Showalter et al. 2008)"
                              if cap else f" × r/{a:.0f} km (Burns et al. 1999; Showalter et al. 2008)") + "."),
            optical_depth=rc.Prov("estimated", [s_burns, s_sho], f"Uniform normal τ = {tau:.3g}: {extra}."),
            reflectance=rc.Prov("estimated", [s_thr, s_sho],
                                "The main ring's dust phase function ('jupiter-dust'; Showalter et al. 2008 find the "
                                "gossamer dust's size distribution like the main ring's)."),
            thin={"phaseFunction": "jupiter-dust", "scale": 1.0}, vertical=vert))
    diag = {"dust_fraction_1deg": dust_frac_1, "k": shapes["k"], "f_large": f_l.tolist(), "f_dust": f_d.tolist(),
            "large": large, "dust": dust, "grid": grid}
    notes = ("Main ring radially averaged normal I/F (Y) = (τ_l ϖ0P_l + τ_s ϖ0P_s)/4: "
             f"{(large[0] * f_l[1] + dust[0] * f_d[1]) / 4:.2e} at α = 0°, "
             f"{float(np.interp(90.0, grid, large * f_l[1] + dust * f_d[1])) / 4:.2e} at 90°, "
             f"{float(np.interp(178.0, grid, large * f_l[1] + dust * f_d[1])) / 4:.2e} at 178°. Checks: "
             "docs/reports/rings.md.")
    model = rc.model_json(comps, tables, 0.0, notes, pole_sense=1)
    srcs = sorted({s for c in comps for s in c.geometry.sources + c.optical_depth.sources + c.reflectance.sources})
    return {"model": model, "label": rc.components_label(comps, tables), "sources": srcs}, diag
