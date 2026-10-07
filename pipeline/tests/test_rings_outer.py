"""Ring components of Jupiter, Uranus and Neptune (photometry/rings_{jupiter,uranus,neptune}.py): structure,
transcriptions, and checks against measurements the model was not fitted to (docs/reports/rings.md). Checks that the
model fails are kept as tests of the documented discrepancy, not loosened to pass."""

import math

import numpy as np
import pytest

from pipeline.photometry import ring_components as rc
from pipeline.photometry import rings, rings_jupiter, rings_neptune, rings_uranus
from pipeline.photometry.common import read_table_csv
from pipeline.schema import LABEL_ORDER, BuildContext


@pytest.fixture(scope="module")
def built():
    ctx = BuildContext(0.0, 1.0)
    out, diag = rings.rings_json(ctx)
    return ctx, out, diag


def _model(out, key):
    return out[key]["components"]["value"]


# ---------------------------------------------------------------------------------------------- structure
@pytest.mark.parametrize("key", ["599", "799", "899"])
def test_component_models_are_complete_and_labelled(built, key):
    ctx, out, _ = built
    c = out[key]["components"]
    assert c["label"] == "estimated" and c["value"]["kind"] == "ring-components-v1"
    assert all(s in ctx.sources for s in c["sources"])
    m = c["value"]
    assert m["poleSense"] == (-1 if key == "799" else 1)
    for t in m["phaseFunctions"].values():
        v = np.array(t["valuesXYZS"])
        assert v.shape == (len(t["phaseDeg"]), 4) and np.all(v >= 0) and np.all(np.diff(t["phaseDeg"]) > 0)
        assert t["label"] in LABEL_ORDER and t["method"] and all(s in ctx.sources for s in t["sources"])
    for comp in m["components"]:
        for asp in ("geometry", "opticalDepth", "reflectance"):
            p = comp["provenance"][asp]
            assert p["label"] in LABEL_ORDER and p["method"]
            assert all(s in ctx.sources for s in p["sources"])
        prof = comp["profile"]
        assert len(prof["values"]) >= 2 and min(prof["values"]) >= 0
        lit = comp["layer"] or comp["thin"]
        assert (lit is None) == (comp["provenance"]["reflectance"]["label"] == "unknown")
        for term in (comp["layer"], comp["thin"]):
            if term:
                assert term["phaseFunction"] in m["phaseFunctions"] and term["scale"] > 0
        if comp["kind"] == "torus":
            assert comp["vertical"]["law"] in ("inclined-orbits", "broken-power-law")
        # the band never inverts
        lam = np.arange(0.0, 360.0, 1.0)
        for t_days in (0.0, 3650.0, -3650.0):
            w = rc.edge_radius(comp["outer"], lam, t_days) - rc.edge_radius(comp["inner"], lam, t_days)
            assert np.all(w > 0), comp["id"]


@pytest.mark.parametrize("key", ["799", "899"])
def test_moving_geometry_has_sourced_support_span(built, key):
    model = _model(built[1], key)
    moving = [c for c in model["components"] if c["id"] in
              {f"uranus-{r}" for r in rings_uranus.RINGS} or "arcs" in c]
    assert len(moving) == (10 if key == "799" else 1)
    for c in moving:
        validity = c["geometryValidity"]
        assert validity["startEt"] < validity["endEt"] and validity["basis"]
        assert c["provenance"]["geometry"]["value"]["geometryValidity"] == validity


def test_uranus_support_is_independent_of_actual_manifest_window(built):
    import json
    import os
    from pathlib import Path
    manifest = Path(os.environ["PIPELINE_OUT"]) / "manifest.json"
    if not manifest.exists():
        pytest.skip("manifest not built: actual time window unavailable")
    window = json.loads(manifest.read_text())["window"]
    model = _model(built[1], "799")
    for c in model["components"][:10]:
        span = c["geometryValidity"]
        # The build window must not redefine the source's support. Runtime width/draw gating is tested by
        # app/tests/render-ring-components.test.ts against this actual manifest, including zero light/extinction.
        assert span != window
        assert span["startEt"] == rings_uranus.GEOMETRY_VALIDITY["startEt"]
        assert span["endEt"] == rings_uranus.GEOMETRY_VALIDITY["endEt"]


def test_tiled_bins_cover_the_band_exactly():
    u0, du, centres = rc.tiled_bins(20)
    assert u0 - 0.5 * du == 0.0 and centres[-1] + 0.5 * du == pytest.approx(1.0)


@pytest.mark.parametrize("key,cid,aspect", [
    ("899", "neptune-adams", "opticalDepth"),
    ("799", "uranus-lambda", "geometry"),
    ("799", "uranus-zeta", "geometry"),
])
def test_assumed_component_values_are_estimated(built, key, cid, aspect):
    # Redistributing a measured integral or choosing circular geometry/width introduces an assumption.
    comp = next(c for c in _model(built[1], key)["components"] if c["id"] == cid)
    assert comp["provenance"][aspect]["label"] == "estimated"


def test_figure_inputs_remain_estimated_in_the_product(built):
    for c in _model(built[1], "599")["components"]:
        assert all(p["label"] == "estimated" for p in c["provenance"].values())
    for t in _model(built[1], "599")["phaseFunctions"].values():
        assert t["label"] == "estimated"
    arcs = next(c for c in _model(built[1], "899")["components"] if "arcs" in c)
    assert arcs["provenance"]["reflectance"]["label"] == "estimated"


@pytest.mark.parametrize("key", ["599", "799", "899"])
def test_component_metadata_has_sourced_values_and_matching_aliases(built, key):
    m = _model(built[1], key)
    for t in m["phaseFunctions"].values():
        assert t["value"] is not None
        assert all(t["value"][k] == t[k] for k in ("name", "phaseDeg", "valuesXYZS", "minPhaseDeg", "maxPhaseDeg"))
    for c in m["components"]:
        p = c["provenance"]
        for aspect in p.values():
            assert (aspect["value"] is None) == (aspect["label"] == "unknown")
        assert p["geometry"]["value"]["inner"] == c["inner"]
        assert p["geometry"]["value"]["outer"] == c["outer"]
        if c["profile"]["opticalDepthKnown"]:
            assert p["opticalDepth"]["value"]["profile"] == c["profile"]
        else:
            assert p["opticalDepth"]["value"] is None
            assert p["reflectance"]["value"]["profile"] == c["profile"]
        if p["reflectance"]["value"] is not None:
            assert p["reflectance"]["value"]["layer"] == c["layer"]
            assert p["reflectance"]["value"]["thin"] == c["thin"]


# ---------------------------------------------------------------------------------------------- transcriptions
def test_transcribed_tables():
    orb = rings_uranus.orbits()
    assert set(orb) == {"6", "5", "4", "alpha", "beta", "eta", "gamma", "delta", "lambda", "epsilon"}
    eps = orb["epsilon"]["COR"]
    assert eps["a"] == pytest.approx(51149.3, abs=0.5) and eps["ae"] / eps["a"] == pytest.approx(0.0079, abs=3e-4)
    new = {(r["planet"], r["filter"], r["feature"]): float(r["new_m"]) for r in
           read_table_csv("hedman_2025_jwst_ring_new.csv")}
    assert new[("uranus", "F140M", "epsilon")] == 1117.6 and new[("neptune", "F210M", "adams")] == 18.22
    lon, ew = rings_neptune.arcs_profile()
    assert np.allclose(np.diff(lon), 0.5) and ew.max() == pytest.approx(84, abs=2)    # Souami et al.: E_Fr = 84 m
    spec = read_table_csv("throop_2004_fig6_spectrum.csv")
    for r in spec:                                       # total = large + dust within the digitization
        assert float(r["total_tau_w0_p"]) == pytest.approx(float(r["large_tau_w0_p"]) + float(r["dust_tau_w0_p"]),
                                                          rel=0.03)
    grid, large, dust = rings_jupiter.phase_curves()
    assert np.all(dust > 0) and np.all(large > 0)


def test_jupiter_large_bodies_follow_the_callisto_power_law():
    """Throop et al.'s large-body curve (digitized) is the Callisto-like power law it was modelled with."""
    rows = [r for r in read_table_csv("throop_2004_fig4_phase_curve.csv") if r["large_tau_w0_p"]]
    a = np.array([float(r["phase_deg"]) for r in rows])
    v = np.array([float(r["large_tau_w0_p"]) for r in rows])
    model = v[0] * rc.power_law(a, rings_jupiter.N_CALLISTO)
    assert np.max(np.abs(v / model - 1)) < 0.15


def test_souami_transcription_matches_both_text_peaks():
    """Souami et al. (2022), Sect. 3.1: Fraternité 84 m, Égalité 76 m (both ±18 m observational error).
    Use the ~1.5 m digitization error, not the much larger observation error, for a transcription check.
    """
    lon, ew = rings_neptune.arcs_profile()
    assert ew[lon < 7.5].max() == pytest.approx(84.0, abs=2.0)
    assert ew[lon >= 7.5].max() == pytest.approx(76.0, abs=2.0)


def test_throop_profile_peak_matches_the_text_radius():
    """Throop et al. (2004), Sect. 2.1.2: α=1° peak at Metis, 1.79 R_J, radius error ±0.02 R_J."""
    p = rings_jupiter.profiles()
    assert p["r"][np.nanargmax(p["p1"])] == pytest.approx(1.79, abs=0.02)


# ---------------------------------------------------------------------------------------------- Uranus checks
def test_uranus_epsilon_widths_vs_karkoschka():
    """ε ring width at periapse and apoapse: 19.7 and 96.4 km (Karkoschka 2001, via Molter et al. 2019)."""
    i, o = rings_uranus.edges("epsilon")
    peri = o["varpi0Deg"]
    w = lambda lam: float(rc.edge_radius(o, lam, 0.0) - rc.edge_radius(i, lam, 0.0))    # noqa: E731
    assert w(peri) == pytest.approx(19.7, abs=1.0)
    assert w(peri + 180.0) == pytest.approx(96.4, abs=1.5)


def test_uranus_particle_albedo_vs_karkoschka(built):
    """Particle geometric albedo implied by the JWST calibration vs 0.061 ± 0.006 (Karkoschka 1997): within 1σ."""
    cal = built[2]["799-components"]["calibration"]
    assert abs(cal.p - 0.061) < 0.006


def test_uranus_epsilon_apoapse_optical_depth_vs_svitek(built):
    """Mean normal τ of the ε ring at apoapse vs 0.40 ± 0.05 (Svitek & Danielson 1987): within 2σ."""
    prof = built[2]["799-components"]["profiles"]["epsilon"]
    i, o = rings_uranus.edges("epsilon")
    w_apo = float(rc.edge_radius(o, o["varpi0Deg"] + 180.0, 0.0) - rc.edge_radius(i, o["varpi0Deg"] + 180.0, 0.0))
    inside = (prof.u >= 0) & (prof.u <= 1)
    tau_apo = float(np.mean(prof.tau_ref[inside])) * prof.w_ref / w_apo
    assert abs(tau_apo - 0.40) < 2 * 0.05


def test_uranus_inner_rings_vs_jwst_fails_as_documented(built):
    """FAILS (documented): the 6-δ rings' JWST F140M NEW predicted with the ε-calibrated particle albedo is ~45 %
    above the measured 376.5 m: the inner rings' particles are darker than ε's, or their PPS optical depths too high."""
    cal = built[2]["799-components"]["calibration"]
    ratio = cal.new_6_delta_model / cal.new_6_delta_measured
    assert 1.3 < ratio < 1.6


def test_uranus_bond_albedo_vs_ockert_fails_as_documented(built):
    """FAILS (documented): Bond albedo with the Callisto-like phase integral ~0.045 vs Ockert et al.'s 0.014 ± 0.004
    (Voyager); Svitek & Danielson's Lambert single-scattering albedo 0.039 ± 0.006 is closer."""
    cal = built[2]["799-components"]["calibration"]
    assert cal.bond > 0.014 + 3 * 0.004 and abs(cal.bond - 0.039) < 0.012


def test_uranus_zeta_ring_phase_scaling(built):
    """ζ ring peak normal I/F scaled from α ≈ 146.5° with the G-ring phase function, vs Voyager at 90° (1.7 ± 0.1e-6)
    and low phase (2.8 ± 0.6e-6) (Hedman et al. 2023): within a factor of 2 (dusty-ring phase functions scatter)."""
    z = built[2]["799-components"]["zeta"]
    for alpha, meas in ((90.0, 1.7e-6), (16.0, 2.8e-6)):
        model = z["peak"] * float(rings_uranus.g_spf(alpha) / rings_uranus.g_spf(z["alpha"]))
        assert 0.5 < model / meas < 2.0, (alpha, model)


# ---------------------------------------------------------------------------------------------- Neptune checks
def test_neptune_arc_drift_from_voyager(built):
    """Fraternité's 1989 Voyager longitude moved at the measured mean motion lands within 1° of its 2016 position."""
    d = built[2]["899-components"]
    diff = (d["arc_voyager_propagated_deg"] - rings_neptune.ARC_L0_DEG + 180.0) % 360.0 - 180.0
    assert abs(diff) < 1.0


def test_neptune_arc_brightness_vs_earlier_epochs(built):
    """Fraternité's 2016 profile (estimated at other supported dates) vs 71 ± 10 m in 2007: within 2σ."""
    peak = built[2]["899-components"]["arc_peak_ks_m"]
    assert abs(peak - 71.0) < 2 * math.hypot(10.0, 18.0)


def test_neptune_pps_equivalent_depths(built):
    """Le Verrier: PPS ∫τ dr consistent with Table 5.1's τ × width (0.3 km) within 2σ. Adams (outside the arcs): the PPS
    cut gives ~0.76 km, far above Table 5.1's 0.003 × 15 km (documented; the measured value is used)."""
    d = built[2]["899-components"]
    lv, lv_sig = d["le_verrier_pps_ed_km"]
    assert abs(lv - 0.3) < 2 * lv_sig
    ad, ad_sig = d["adams_pps_ed_km"]
    assert ad > 0.003 * 15.0 + 3 * ad_sig


# ---------------------------------------------------------------------------------------------- Jupiter checks
def test_jupiter_main_ring_vs_measured_phase_curve(built):
    """Model normal τϖ0P (Y channel) vs Galileo SSI points (Throop et al. 2004 Fig. 4): within 35 % at 5.8° and 50°;
    FAILS (documented) near 175-176°, where the model is about half the measured forward-scattering peak."""
    d = built[2]["599-components"]
    g, lg, du = d["grid"], d["large"], d["dust"]
    fy_l, fy_d = d["f_large"][1], d["f_dust"][1]

    def model(a):
        return float(np.exp(np.interp(a, g, np.log(lg * fy_l + du * fy_d))))

    pts = [(float(r["phase_deg"]), float(r["tau_w0_p"])) for r in read_table_csv("throop_2004_fig4_data.csv")
           if r["instrument"] == "galileo-ssi"]
    for a, v in pts:
        ratio = model(a) / v
        if a < 90:
            assert abs(ratio - 1) < 0.35, (a, ratio)
        else:
            assert 0.35 < ratio < 0.7, (a, ratio)
