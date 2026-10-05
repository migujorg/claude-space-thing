"""Neptune's rings as components (rings.json "899".components; ring_components.py for the model).

Geometry (estimated): circular, equatorial rings at the radii and widths of de Pater et al. (2019) Table 5.1 (from
Porco et al. 1995): Galle 42,000 ± 1000 km, Le Verrier 53,200 km (~100 km wide), Lassell 53,200-57,200 km with Arago
its outer edge, and the Adams ring at the arcs' semimajor axis 62,932.37 km (Porco 1991) with the 15 km width of the
arcs. The Adams ring's measured 29.6 km m = 43 radial distortion (forced by Galatea's 42:43 Lindblad resonance) and any
inclinations are not modelled.

Arcs (estimated): the normal equivalent width of Fraternité and Égalité vs longitude measured with VLT/SPHERE in 2016
(Souami et al. 2022, Fig. 3b, Ks band), placed at their measured longitude (L_Fr = 217.43° at the light-time-corrected
reference epoch) and moved with the arcs' measured mean motion n = 820.11178 ± 0.00003 °/day (Souami et al. 2022; the
longitude uncertainty grows by 0.01° per year). The arcs' shapes and brightnesses change on decadal time scales (the
leading arcs Liberté and Courage faded after 1989; Égalité's brightness relative to Fraternité changed by ~20 %
between 2002 and 2009): the 2016 profile is shown at all times.

Optical depth: the Adams ring's from the Voyager 2 PPS σ Sgr occultation (PDS VG_2801, 5 km; estimated: its measured
equivalent depth spread uniformly over the assumed 15 km band); the others from Table 5.1 (order-of-magnitude values:
estimated).

Reflectance (estimated): optically thin scattering (I/F = D(α)·τ/(4μ)) calibrated on the JWST NIRCam F210M (2.09 µm)
normal equivalent widths of the Adams ring (arcs excluded) and of the Le Verrier + Lassell + Arago rings (Hedman et
al. 2025, α = 1.79°), split between Le Verrier and Lassell in proportion to their optical depth × width, and scaled to
the visible by the arcs' measured 0.5 µm / 2.12 µm reflectivity ratio (0.055 Voyager / 0.088 Keck 2003, de Pater et
al. 2019 Table 5.3), spectrally flat in the visible. The phase dependence is not measured in an openly available
source: D(α) is taken constant over 0-15.5° (the phase range spanned by the ground-based, JWST and Voyager low-phase
data), and unknown beyond (Neptune's rings, about half dust, brighten strongly in forward scattering: Voyager images at
134°), where the renderer shows them as not measured. The Galle ring's brightness was not quantified: optical depth
only, reflectance unknown.
"""

from __future__ import annotations

import numpy as np

from ..schema import BuildContext
from . import ring_components as rc
from .common import Download, read_table_csv
from .rings_uranus import HEDMAN_JWST

SOUAMI = Download(
    id="souami-2022-arcs", url="https://arxiv.org/pdf/2110.12669v2", subdir="papers", name="arXiv-2110.12669v2.pdf",
    title="Neptune's ring arcs from VLT/SPHERE (Fig. 3b: equivalent width vs longitude; arc longitude and mean motion)",
    citation="Souami, D., Renner, S., Sicardy, B., Langlois, M., Carry, B., Delorme, P. & Golaszewska, P. (2022). "
             "Neptune's ring arcs from VLT/SPHERE-IRDIS near-infrared observations. Astronomy & Astrophysics 657, "
             "A134. DOI:10.1051/0004-6361/202141598 (manuscript arXiv:2110.12669v2).",
    notes="Fig. 3b digitized to photometry/tables/souami_2022_fig3b_arcs.csv; L_Fr = 217.43 ± 0.30° (Table 1 epoch) "
          "and n_arcs = 820.11178 ± 0.00003 °/day from Sect. 3.2.")
DE_PATER_NEPTUNE = Download(
    id="de-pater-2019-neptune-rings", url="https://arxiv.org/pdf/1906.11728v1", subdir="papers",
    name="arXiv-1906.11728v1.pdf",
    title="The rings of Neptune (review: Table 5.1 ring properties, Table 5.3 arc reflectivities, Sect. 5.5 Adams ring)",
    citation="de Pater, I., Renner, S., Showalter, M. R. & Sicardy, B. (2019). The rings of Neptune. In Tiscareno, "
             "M. S. & Murray, C. D. (eds.), Planetary Ring Systems, Cambridge University Press. "
             "DOI:10.1017/9781316286791.005 (manuscript arXiv:1906.11728v1). Table 5.1 after de Pater & Lissauer "
             "(2015) and Porco et al. (1995); Adams ring semimajor axis and distortion from Porco (1991), Science 253, "
             "995, DOI:10.1126/science.253.5023.995.",
    notes="Values used are quoted in rings_neptune.py.")

EPOCH_ET = 0.0                     # the circular rings do not move; the arcs carry their own epoch
LIGHT_S_PER_AU = 499.004784
# Souami et al. (2022) Table 1: reference frame 2016-08-23T05:33:51.9581 UT at geocentric distance 28.959 AU; their
# L_Fr refers to the time at Neptune (propagating Porco et al.'s 1989 Voyager longitude 251.88° with their n gives
# 217.85° at the light-time-corrected epoch, 137° away at the uncorrected one). TT − UTC = 68.184 s in 2016.
ARC_EPOCH_ET = rc.et_of_tdb_calendar(2016, 8, 23, 5.0 + 33.0 / 60.0 + (51.9581 + 68.184) / 3600.0) \
    - 28.959 * LIGHT_S_PER_AU
ARC_L0_DEG = 217.43
ARC_N_DEG_D = 820.11178
VOYAGER_FR_DEG = 251.88            # Porco et al. (1995) via Souami et al.: Fraternité's centre at JD 2447757.0 (TDB)
VOYAGER_FR_ET = rc.et_of_jd_tdb(2447757.0)

ADAMS_A_KM = 62932.37              # Porco (1991): semimajor axis from the arcs' mean motion (de Pater et al. 2019)
ADAMS_W_KM = 15.0                  # Table 5.1: radial width (in arcs)
ADAMS_PPS_WINDOW = (62880.0, 62950.0)
RINGS = {
    # id: (name, inner and outer radius (km), normal τ (Table 5.1))
    "galle": ("Galle ring", 41000.0, 43000.0, 1e-4),
    "le-verrier": ("Le Verrier ring", 53150.0, 53250.0, 0.003),
    "lassell": ("Lassell ring (with Arago at its outer edge)", 53250.0, 57200.0, 1e-4),
}
VIS_OVER_K = 0.055 / 0.088         # de Pater et al. (2019) Table 5.3: arcs (F+E) I/F, Voyager 0.5 µm / Keck 2003 2.12 µm
PHASE_MAX = 15.5                   # Voyager's low-phase ring images (de Pater et al. 2019 Fig. 5.1a)


def pps_adams(prof) -> tuple[float, float]:
    """Equivalent depth ∫τ dr (km) of the Adams ring in the PPS σ Sgr cut and its 1σ noise."""
    r, tau = prof.radius, prof.tau
    m = (r >= ADAMS_PPS_WINDOW[0]) & (r <= ADAMS_PPS_WINDOW[1])
    step = float(np.median(np.diff(r)))
    return float(np.nansum(tau[m]) * step), float(prof.noise * np.sqrt(m.sum()) * step)


def pps_le_verrier(prof) -> tuple[float, float]:
    r, tau = prof.radius, prof.tau
    m = (r >= 53100.0) & (r <= 53300.0)
    step = float(np.median(np.diff(r)))
    return float(np.nansum(tau[m]) * step), float(prof.noise * np.sqrt(m.sum()) * step)


def jwst_new(feature: str, filt: str = "F210M") -> float:
    for row in read_table_csv("hedman_2025_jwst_ring_new.csv"):
        if row["planet"] == "neptune" and row["feature"] == feature and row["filter"] == filt:
            return float(row["new_m"])
    raise KeyError(feature)


def arcs_profile() -> tuple[np.ndarray, np.ndarray]:
    rows = read_table_csv("souami_2022_fig3b_arcs.csv")
    return (np.array([float(r["longitude_deg"]) for r in rows]), np.array([float(r["new_m"]) for r in rows]))


def arc_longitude(et: float) -> float:
    return (ARC_L0_DEG + ARC_N_DEG_D * (et - ARC_EPOCH_ET) / rc.DAY) % 360.0


def build(ctx: BuildContext | None, pps) -> tuple[dict, dict]:
    """pps: the PPS σ Sgr profile (rings.Profile) and its source ids, as (profile, sources)."""
    prof, pps_srcs = pps
    reg = lambda d: d.register(ctx) if ctx else d.id      # noqa: E731
    s_sou, s_dp, s_jwst = reg(SOUAMI), reg(DE_PATER_NEPTUNE), reg(HEDMAN_JWST)
    flat = rc.phase_table(
        "Neptune's rings at low phase (constant, spectrally flat; not measured beyond 15.5°)",
        np.ones(len(rc.PHASE_GRID)), "estimated", [s_dp, s_jwst],
        "Constant over 0-15.5° (JWST 1.8°, ground-based ~0.4-2°, Voyager's low-phase images at 15.5°): no openly "
        "available measurement separates the phase dependence over this range. Spectrally flat in the visible (one "
        "visible reflectivity, at 0.5 µm). Beyond 15.5° not measured: Neptune's dusty rings brighten strongly toward "
        "forward scattering (Voyager, 134°).", domain=(0.0, PHASE_MAX))
    tables = {"neptune-low-phase": flat}
    adams_ed, adams_sig = pps_adams(prof)
    lv_ed, lv_sig = pps_le_verrier(prof)
    new_adams = VIS_OVER_K * jwst_new("adams")
    new_lla = VIS_OVER_K * jwst_new("le verrier+lassell+arago")
    ed = {k: tau * (o - i) / 1000.0 for k, (_, i, o, tau) in RINGS.items()}       # km
    share = {k: ed[k] / (ed["le-verrier"] + ed["lassell"]) for k in ("le-verrier", "lassell")}
    color = (f"× {VIS_OVER_K:.3f} to the visible (arcs' I/F 0.055 at 0.5 µm, Voyager, over 0.088 at 2.12 µm, Keck "
             "2003; de Pater et al. 2019 Table 5.3; the two also differ in phase angle, which this ratio absorbs)")
    comps: list[rc.Component] = []
    geo_src = [s_dp]
    u0, du, centres = rc.tiled_bins()
    nb = centres.size
    for k, (name, r_in, r_out, tau) in RINGS.items():
        w = r_out - r_in
        if k == "galle":
            refl = rc.Prov("unknown", [], "The Galle ring's brightness was not quantified in an openly available "
                           "source (JWST: 'requires more in-depth analysis'): optical depth only.")
            thin = None
        else:
            new = new_lla * share[k]
            refl = rc.Prov("estimated", [s_jwst, s_dp],
                           f"Thin scattering, normal equivalent width {new:.2f} m at α ≤ 15.5° in the visible: "
                           f"{share[k] * 100:.0f} % (optical depth × width, Table 5.1) of the JWST F210M NEW of the "
                           f"Le Verrier + Lassell + Arago rings (41.04 m, Hedman et al. 2025, α = 1.79°) {color}.")
            thin = {"phaseFunction": "neptune-low-phase", "scale": float(f"{4.0 * new / (tau * w * 1000.0):.6g}")}
        comps.append(rc.Component(
            id=f"neptune-{k}", name=name, inner=rc.edge(r_in), outer=rc.edge(r_out), u_start=u0, u_step=du,
            profile=np.full(nb, tau), width_ref_km=w, width_scaling=False, optical_depth_known=True,
            geometry=rc.Prov("estimated", geo_src, f"Circular and equatorial, {r_in:.0f}-{r_out:.0f} km (de Pater et "
                             "al. 2019 Table 5.1, from Porco et al. 1995)."),
            optical_depth=rc.Prov("estimated", geo_src + (pps_srcs if k == "le-verrier" else []),
                                  f"Uniform normal τ = {tau:g} (Table 5.1, order of magnitude)." +
                                  (f" The Voyager PPS σ Sgr cut (5 km) gives ∫τ dr = {lv_ed:.2f} ± {lv_sig:.2f} km "
                                   "over 53,100-53,300 km, consistent with it within the noise." if k == "le-verrier"
                                   else "")),
            reflectance=refl, thin=thin))
    w = ADAMS_W_KM
    tau_adams = adams_ed / w
    comps.append(rc.Component(
        id="neptune-adams", name="Adams ring", inner=rc.edge(ADAMS_A_KM - w / 2), outer=rc.edge(ADAMS_A_KM + w / 2),
        u_start=u0, u_step=du, profile=np.full(nb, tau_adams), width_ref_km=w, width_scaling=False,
        optical_depth_known=True,
        geometry=rc.Prov("estimated", geo_src, f"Circular and equatorial at a = {ADAMS_A_KM} km (Porco 1991, from the "
                         f"arcs' mean motion), {w:.0f} km wide (Table 5.1, in the arcs); the measured 29.6 km m = 43 "
                         "distortion is not modelled."),
        optical_depth=rc.Prov("estimated", pps_srcs + geo_src,
                              f"Voyager 2 PPS σ Sgr ingress (1989, 5 km bins): equivalent depth ∫τ dr = {adams_ed:.3f} "
                              f"± {adams_sig:.3f} km over {ADAMS_PPS_WINDOW[0]:.0f}-{ADAMS_PPS_WINDOW[1]:.0f} km, "
                              f"spread uniformly over the {w:.0f} km band (τ = {tau_adams:.4f}); one cut, outside the "
                              "arcs."),
        reflectance=rc.Prov("estimated", [s_jwst, s_dp],
                            f"Thin scattering, normal equivalent width {new_adams:.2f} m at α ≤ 15.5° in the visible: "
                            f"the JWST F210M NEW of the Adams ring outside the arcs (18.22 m, Hedman et al. 2025, α = "
                            f"1.79°) {color}."),
        thin={"phaseFunction": "neptune-low-phase", "scale": float(f"{4.0 * new_adams / (adams_ed * 1000.0):.6g}")}))
    lon, ew = arcs_profile()
    step = float(lon[1] - lon[0])
    if not np.allclose(np.diff(lon), step):
        raise ValueError("souami_2022_fig3b_arcs.csv: longitudes not evenly spaced")
    factor = np.clip(ew, 0.0, None) * VIS_OVER_K           # visible NEW (m) along the arcs
    ref = 1.0                                              # profile normalized to NEW = 1 m at factor 1
    comps.append(rc.Component(
        id="neptune-adams-arcs", name="Adams ring arcs (Fraternité, Égalité)",
        inner=rc.edge(ADAMS_A_KM - w / 2), outer=rc.edge(ADAMS_A_KM + w / 2), u_start=u0, u_step=du,
        profile=np.full(nb, ref / (w * 1000.0)), width_ref_km=w, width_scaling=False, optical_depth_known=False,
        geometry=rc.Prov("estimated", [s_sou, s_dp],
                         f"In the Adams ring band; longitudes from Fraternité's centre at {ARC_L0_DEG}° (Souami et al. "
                         "2022, 2016-08-23 at Neptune) moving at the measured n = 820.11178 °/day (± 0.00003 °/day: "
                         "± 0.01° per year from 2016)."),
        optical_depth=rc.Prov("unknown", [], "Arc optical depth ~0.1 (Porco et al. 1995) not modelled: brightness "
                              "only (no extinction or shadow)."),
        reflectance=rc.Prov("estimated", [s_sou, s_dp],
                            "Normal equivalent width vs longitude of Fraternité and Égalité in 2016 (Souami et al. "
                            f"2022 Fig. 3b, Ks band, α = 0.35°; ± 18 m) {color}; the 2016 profile is shown at all "
                            "times (the arcs evolve on decadal scales; in 1989 two more arcs, Liberté and Courage, "
                            "were bright)."),
        thin={"phaseFunction": "neptune-low-phase", "scale": 4.0},
        arcs={"lambda0Deg": ARC_L0_DEG, "epochEt": ARC_EPOCH_ET, "meanMotionDegPerDay": ARC_N_DEG_D,
              "phiStartDeg": float(lon[0]), "phiStepDeg": step, "factor": [float(f"{x:.4g}") for x in factor]}))
    diag = {
        "adams_pps_ed_km": (adams_ed, adams_sig), "le_verrier_pps_ed_km": (lv_ed, lv_sig),
        "new_vis": {"adams": new_adams, "le-verrier": new_lla * share["le-verrier"],
                    "lassell": new_lla * share["lassell"]},
        "arc_peak_ks_m": float(ew.max()),
        "arc_voyager_propagated_deg": (VOYAGER_FR_DEG + ARC_N_DEG_D * (ARC_EPOCH_ET - VOYAGER_FR_ET) / rc.DAY) % 360.0,
    }
    notes = (f"Visible normal equivalent widths at α ≤ 15.5°: Adams {new_adams:.1f} m, Le Verrier "
             f"{diag['new_vis']['le-verrier']:.1f} m, Lassell {diag['new_vis']['lassell']:.1f} m, arcs up to "
             f"{factor.max():.0f} m (2016 profile). Checks: docs/reports/rings.md.")
    model = rc.model_json(comps, tables, EPOCH_ET, notes, pole_sense=1)
    srcs = sorted({s for c in comps for s in c.geometry.sources + c.optical_depth.sources + c.reflectance.sources})
    return {"model": model, "label": rc.components_label(comps, tables), "sources": srcs}, diag
