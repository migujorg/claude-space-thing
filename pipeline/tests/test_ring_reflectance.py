"""Saturn ring reflectance (photometry/ring_reflectance.py): transcription checks, the model against its calibration
data, and an independent check against Saturn's system magnitude (Mallama & Hilton 2018)."""

import math

import numpy as np
import pytest

from pipeline.photometry import albedo, bodies, filters, phase, ring_check, ring_reflectance as rr, solar
from pipeline.photometry.common import read_table_csv
from pipeline.schema import LABEL_ORDER, BuildContext


@pytest.fixture(scope="module")
def model():
    return rr.build_model()


def test_salo_french_table4_reproduces_table5():
    """Each (a, b) pair gives Table 5's I/F(6°) = a ln 6 + b and OE = I(0.5°)/I(6°) to rounding."""
    rows = read_table_csv("salo_french_2010_table4.csv")
    assert len(rows) == 3 * 6 * 5
    for r in rows:
        a, b = float(r["a"]), float(r["b"])
        if6 = a * math.log(6.0) + b
        assert if6 == pytest.approx(float(r["IF6_table5"]), abs=2e-4), r
        assert (a * math.log(0.5) + b) / if6 == pytest.approx(float(r["OE_table5"]), rel=4e-3), r


def test_voyager_profiles_and_geometry(model):
    lit, unlit = model.lit, model.unlit
    assert lit.side == "lit" and unlit.side == "unlit"
    assert lit.phase == 47.0 and lit.solar_elev == pytest.approx(8.05) and lit.obs_elev == pytest.approx(23.3)
    assert unlit.phase == 46.6 and unlit.solar_elev == pytest.approx(3.87) and unlit.obs_elev == pytest.approx(-11.9)
    assert lit.radius[0] == 74000.0 and lit.radius[-1] == 138700.0 and np.allclose(np.diff(lit.radius), 10.0)
    assert unlit.radius[-1] == 140600.0
    # the B ring is brighter than the C ring on the lit face and darker on the unlit face
    b = (lit.radius > 100000) & (lit.radius < 107000)
    c = (lit.radius > 78000) & (lit.radius < 83000)
    assert np.mean(lit.iof[b]) > 3 * np.mean(lit.iof[c])
    bu = (unlit.radius > 100000) & (unlit.radius < 107000)
    cu = (unlit.radius > 78000) & (unlit.radius < 83000)
    assert np.mean(unlit.iof[bu]) < 0.2 * np.mean(unlit.iof[cu])


def test_filter_reconstruction_reproduces_hst_bands(model):
    tau = rr.region_tau(model.radius, model.tau, "B")
    wp = rr.hst_wp("B", 15.4, 2.0, tau)
    wl, p = rr.spectrum_from_filters(wp)
    for f, v in wp.items():
        assert filters.band_average(f"wfpc2.{f}", wl, p) == pytest.approx(v, rel=1e-6)


def test_power_law_exponents_are_callisto_like(model):
    """The HST (≤ 6.3°) and Voyager (47°) anchors are joined by (π − α)^n; n comes out near the published
    Callisto-like 3.09 in every region, an independent consistency check of the two data sets."""
    for reg, n in model.n.items():
        assert 3.0 < n < 4.5, (reg, n)


def test_model_reproduces_voyager_profiles(model):
    lit, unlit = model.lit, model.unlit
    mu0, mu = math.sin(math.radians(lit.solar_elev)), math.sin(math.radians(lit.obs_elev))
    ok = (model.tau[: lit.radius.size] > rr.GAP_TAU)
    for i in np.where(ok)[0][::37]:
        r = lit.radius[i]
        got = rr.model_iof(model, r, lit.phase, lit.obs_elev, lit.solar_elev, channel=None)
        assert got == pytest.approx(max(lit.iof[i], 0.0), rel=1e-3, abs=2e-5), r
    for i in np.where(model.tau > 0.02)[0][::41]:
        r = unlit.radius[i]
        if not np.isfinite(model.lit_mod[i]):
            continue
        got = rr.model_iof(model, r, unlit.phase, unlit.obs_elev, unlit.solar_elev, channel=None)
        assert got == pytest.approx(max(unlit.iof[i], 0.0), rel=2e-3, abs=1e-4), r   # edges: noise level


def test_region_mean_modulation_is_one(model):
    for reg, (_, lo, hi) in rr.REGIONS.items():
        m = (model.radius >= lo) & (model.radius <= hi)
        geo = rr.lit_geometry(model.tau[m], math.sin(math.radians(23.3)), math.sin(math.radians(8.05)))
        # A(r) is defined per bin; weighted by the geometric factor its region mean reproduces the Voyager mean
        assert np.sum(model.lit_mod[m] * geo) / np.sum(geo) == pytest.approx(1.0, rel=0.02), reg


@pytest.mark.parametrize("elev", [15.0, 20.0, 26.0])
@pytest.mark.parametrize("alpha", [1.0, 3.0])
def test_system_brightness_vs_mallama_hilton(model, elev, alpha):
    """Independent check: the net light the rings add to Saturn (rings seen, minus globe light they block) against
    Mallama & Hilton's (2018) Eq. 10 (with rings) minus Eq. 11 (globe) — ground photometry, not used in the model.
    Agreement within 15 % for β = 15-26° (at lower β the two M&H equations do not separate the rings reliably)."""
    sat = bodies.build_body(699)
    py = sat.xyzs[1] / solar.irradiance_xyzs()[1]
    dm = phase.delta_mag(sat.entry["phaseFunction"]["value"], alpha)
    ours = ring_check.ring_net_flux(model, alpha, elev, py, dm)["net"]
    mh = ring_check.mallama_net_flux(alpha, elev, albedo.mean_radius(699), albedo.sun_mag("V"))["net"]
    assert ours == pytest.approx(mh, rel=0.15)


def test_rings_json_reflectance_shape():
    from pipeline.photometry import rings
    ctx = BuildContext(0.0, 1.0)
    out, _ = rings.rings_json(ctx)
    s = out["699"]
    refl = s["reflectance"]
    assert refl["label"] == "estimated" and refl["method"] and all(x in ctx.sources for x in refl["sources"])
    v = refl["value"]
    n = v["count"]
    assert all(len(v[k]) == n for k in ("normalTau", "litModulation", "unlitTau", "unlitGain"))
    assert v["minPhaseDeg"] == 0.25 and v["maxPhaseDeg"] == 47.0 and v["phaseDeg"][-1] == 47.0
    for reg in v["regions"]:
        t = np.array(reg["amplitudeXYZS"], float)
        assert t.shape == (len(v["elevationEffDeg"]), len(v["phaseDeg"]), 4) and np.all(t > 0)
        # opposition brightening: ϖP falls with phase angle at every elevation and channel
        assert np.all(np.diff(t, axis=1) < 0)
    meas = s["reflectanceMeasurements"]
    for key in ("radialProfiles", "regionalPhaseCurves"):
        assert meas[key]["label"] == "measured" and meas[key]["label"] in LABEL_ORDER
    for prof in meas["radialProfiles"]["value"]:
        assert len(prof["iOverF"]) == prof["count"]


def test_reflectance_keeps_estimated_cleaned_tau(model):
    from pipeline.photometry import rings
    _, _, cleaned = rings.saturn_profile(None)
    ok = np.isfinite(cleaned.tau)
    expected = np.interp(model.radius, cleaned.radius[ok], np.clip(cleaned.tau[ok], 0, None))
    np.testing.assert_array_equal(model.tau, expected)
    refl, _ = rr.model_json(None)
    assert refl["reflectance"]["label"] == "estimated"
    assert "opticalDepthEstimate" in refl["reflectance"]["method"]


@pytest.mark.parametrize("with_context", [False, True])
def test_reflectance_names_every_input_source(with_context):
    """The produced record must retain the pedigree of the tau and photometry it inverts."""
    from pipeline import cie
    from pipeline.photometry import rings
    ctx = BuildContext(0.0, 1.0) if with_context else None
    out, _ = rings.rings_json(ctx)
    saturn = out["699"]
    inputs = [saturn["opticalDepthEstimate"], *saturn["reflectanceMeasurements"].values()]
    expected = {sid for record in inputs for sid in record["sources"]}
    expected.update([solar.HSRS.id, cie.SOURCE_CMF, cie.SOURCE_SCOTOPIC])
    sources = set(saturn["reflectance"]["sources"])
    assert expected <= sources, f"reflectance missing input sources: {sorted(expected - sources)}"
    if ctx is not None:
        assert sources <= ctx.sources.keys()
