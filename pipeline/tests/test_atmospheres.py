"""atmospheres.json (photometry/atmospheres.py): transcriptions, physics against published values, product shape."""

import json
import math

import numpy as np
import pytest

from pipeline.photometry import atmo, atmo_bodies as ab, atmo_checks as C, atmo_earth as ae, atmo_mars as am
from pipeline.photometry import atmospheres as A
from pipeline.photometry.common import read_table_json


@pytest.fixture(scope="module")
def built():
    return A.build(None)


# ---------------------------------------------------------------------------------------------- transcriptions
def test_us76_ozone_table_is_self_consistent():
    t = read_table_json("us_standard_atmosphere_1976.json")["table18_ozone"]
    assert len(t["Z_m"]) == len(t["n_O3_m3"]) == len(t["sigma_m3"]) == 37
    # the table's 0.345 atm-cm = 9.27e22 m^-2; its own profile integrates to that within the 2-74 km coverage
    z = np.array(t["Z_m"], float)
    col = np.trapezoid(np.array(t["n_O3_m3"]), z) + t["n_O3_m3"][0] * 2000.0
    assert col == pytest.approx(t["total_molecules_m2"], rel=0.02)
    assert t["total_molecules_m2"] / 2.6868e20 == pytest.approx(345, rel=0.001)


def test_us76_layers():
    assert ae.TMB[1] == pytest.approx(216.65) and ae.TMB[-1] == pytest.approx(186.946, abs=1e-3)
    assert ae.PB[1] == pytest.approx(22632.06, rel=1e-5)


def test_us76_reproduces_the_printed_tables():
    for r in C.us76_rows():
        assert abs(r["rel"]) < 2e-4, r


def test_bodhaine_sigma_and_king_factor():
    b = C.bodhaine_sigma()
    assert b["max_rel"] < 1e-4
    assert b["king_max_abs"] < 1e-5


def test_co2_refractivity_matches_bideau_mehu():
    assert C.co2_refractivity_check()["max_rel"] < 2e-3


def test_titan_haze_transcription():
    t = C.titan_checks({"ray": {"col_fine": np.zeros(atmo.FINE.size)}})
    assert t["tau_1080"] == pytest.approx(t["tau_1080_tomasko"], rel=0.01)
    # continuity of the cumulative optical depth at 30 and 80 km
    for z in (30.0, 80.0):
        a, b = ab.titan_haze_tau(np.array([z - 1e-6, z + 1e-6]), np.array([550.0]))[:, 0]
        assert a == pytest.approx(b, rel=1e-6)
    # extinction integrates to the cumulative optical depth
    zz = np.linspace(0, 1500, 150001)
    beta = ab.titan_haze_beta(zz, np.array([550.0]))[:, 0]
    assert np.trapezoid(beta, zz) == pytest.approx(ab.titan_haze_tau(np.array([0.0]), np.array([550.0]))[0, 0],
                                                   rel=1e-4)


# ---------------------------------------------------------------------------------------------- physics
def test_mie_matches_bohren_huffman_example():
    x = 2 * math.pi * 0.525 / 0.6328
    qe, qs, g, s12 = atmo.mie_single(x, 1.55 + 0j, np.array([1.0, -1.0]))
    assert qs == pytest.approx(3.1054, abs=1e-4) and qe == pytest.approx(qs)
    assert 4 / x ** 2 * s12[1] / 2 == pytest.approx(2.9253, abs=1e-4)      # Q_back


def test_phase_functions_are_normalized():
    for p in (lambda mu: atmo.rayleigh_phase(mu, 0.0279), lambda mu: atmo.hg(mu, 0.7),
              lambda mu: atmo.dhg(mu, 0.889, 0.094, 0.743)):
        assert atmo.mean_over_sphere(p) == pytest.approx(1.0, abs=1e-4)
    assert atmo.asymmetry_of(lambda mu: atmo.hg(mu, 0.7)) == pytest.approx(0.7, abs=1e-3)


def test_fold_weights():
    w = atmo.fold_weights()
    assert w.shape == (4, atmo.GRID_NM.size)
    assert np.allclose(w.sum(axis=1), 1.0)
    # folding a constant spectrum returns it; folding the true channel weights of a linear ramp is exact
    ramp = atmo.FINE / 500.0
    assert np.allclose(w @ (atmo.GRID_NM / 500.0), atmo.channel_weights() @ ramp, rtol=1e-12)


def test_earth_rayleigh_optical_depth(built):
    out, diag = built
    t = C.earth_rayleigh_tau(diag["399"])
    assert t["ratio550"] == pytest.approx(1.0, abs=2e-3)
    assert out["bodies"]["399"]["components"][0]["columnOpticalDepth"][19] == pytest.approx(0.0971, abs=2e-4)


def test_earth_ozone_column(built):
    _, diag = built
    assert C.ozone_column_du(diag["399"]) == pytest.approx(345, rel=0.01)


def test_zenith_sky_is_blue_and_on_the_daylight_locus(built):
    _, diag = built
    for z in C.zenith_sky(diag["399"]):
        assert z["cct"] > 7000
        assert abs(z["y"] - z["y_daylight_locus"]) < 0.005


def test_mars_solar_longitude():
    ls0 = am.ls_zero_crossing(796688664.0)
    nxt = am.ls_zero_crossing(ls0 + 450 * 86400)
    assert (nxt - ls0) / am.sol_seconds() == pytest.approx(668.6, abs=0.2)
    assert am.solar_longitude(np.array([ls0 + 1e5]))[0] < 1.0


def test_mars_dust_consistency(built):
    _, diag = built
    m = C.mars_checks(diag["499"])
    assert m["g_dhg"] == pytest.approx(m["g650_table"], abs=0.02)
    assert m["ssa650_table"] == pytest.approx(m["ssa_assumed_cc"], abs=0.02)
    assert 0 < m["ls_min"] < 180 < m["ls_max"] < 360           # clear aphelion season, dusty perihelion season
    assert 0.1 < m["min"] < m["annual"] < m["max"] < 1.5


def test_pluto_reproduces_gladstone(built):
    _, diag = built
    p = C.pluto_checks(diag["999"])
    assert p["P165"] == pytest.approx(5.0, rel=0.1)
    assert p["Qsca"] == pytest.approx(2.7, rel=0.1)


# ---------------------------------------------------------------------------------------------- product
def test_product_shape_and_labels(built):
    out, _ = built
    json.dumps(out, allow_nan=False)
    nw = len(out["wavelengthsNm"])
    assert nw == 48 and out["wavelengthsNm"][0] == 360 and out["wavelengthsNm"][-1] == 830
    for key, e in out["bodies"].items():
        assert e["naifId"] == int(key)
        assert "topRadiusKm" in e and "topAltitudeKm" in e and e["scaleHeightKm"]["label"]
        if e["altitudesKm"]:
            assert e["topRadiusKm"] == pytest.approx(e["referenceRadiusKm"] + e["topAltitudeKm"])
        na = len(e["altitudesKm"])
        for c in e["components"]:
            ext = c["extinctionPerKm"]["value"]
            assert len(ext) == na and all(len(r) == nw for r in ext)
            assert all(v >= 0 for r in ext for v in r)
            assert len(c["columnOpticalDepth"]) == nw
            ssa = c["singleScatteringAlbedo"]
            assert (ssa["value"] is None) == (ssa["label"] == "unknown")
            if ssa["value"] is not None:
                assert len(ssa["value"]) == nw and all(0 <= v <= 1 for v in ssa["value"])
            ph = c["phaseFunction"]
            if ph["value"] is not None and ph["value"]["kind"] == "tabulated":
                v = np.array(ph["value"]["values"])
                assert v.shape == (nw, len(ph["value"]["anglesDeg"]))
            ch = c["channelEquivalents"]["value"]["extinctionPerKm"]
            assert len(ch) == na and all(len(r) == 4 for r in ch)
            for q in (c["extinctionPerKm"], ssa, ph, c["channelEquivalents"]):
                assert q["label"] in ("measured", "derived", "estimated", "unknown")
                assert q["label"] == "unknown" or q["sources"]
    titan = out["bodies"]["606"]
    assert [c["id"] for c in titan["components"]] == ["rayleigh", "haze-below-80km", "haze-above-80km-a",
                                                      "haze-above-80km-b", "methane"]
    for c in titan["components"][1:4]:
        # DISR model values (retrieved by their authors' radiative-transfer fits; ours digitized) → estimated
        assert c["singleScatteringAlbedo"]["label"] == "estimated" and c["phaseFunction"]["label"] == "estimated"
    sr = titan["surfaceReflectance"]
    assert sr["label"] == "estimated" and len(sr["value"]["reflectance"]) == nw and sr["sources"]
    assert all(0 < v < 0.2 for v in sr["value"]["reflectance"]) and len(sr["value"]["channelEquivalents"]) == 4
    mars = out["bodies"]["499"]
    d = mars["dustColumn"]["value"]
    assert np.array(d["opticalDepth610Pa"]).shape == (len(d["lsDeg"]), len(d["latitudeDeg"]))
    assert len(mars["solarLongitude"]["value"]["et"]) == len(mars["solarLongitude"]["value"]["lsDeg"])


def test_tabulated_phase_functions_are_normalized(built):
    out, _ = built
    for key, i in (("299", 0), ("999", 0), ("606", 1), ("606", 2)):
        ph = out["bodies"][key]["components"][i]["phaseFunction"]["value"]
        ang = np.radians(ph["anglesDeg"])
        for row in ph["values"][::12]:
            mean = np.trapezoid(np.array(row) * np.sin(ang), ang) / 2
            assert mean == pytest.approx(1.0, rel=0.03), key


def test_titan_doose_rule_on_the_digitized_albedos():
    # Doose et al. (2016): ω(< 80 km) = (0.565 + ω(> 200 km)) / 1.5 (Es-sayeh et al. 2023). The two curves digitized
    # from Barnes et al.'s (2018) Fig. 4 obey it to the digitization's precision.
    rows = ab._ssa_rows()
    lt, wt = rows["above_200km"]
    ll, wl = rows["below_80km"]
    assert np.abs(ab.doose_rule(np.interp(ll, lt, wt)) - wl).max() <= 6e-4
    s = ab.titan_ssa(np.array([500.0, 600.0, 860.0]))
    assert np.all(s["low"] >= s["top"]) and np.all(s["low"] <= 1.0) and np.all(s["top"] > 0.8)


def test_titan_phase_functions_and_methane(built):
    out, diag = built
    d = diag["606"]
    # Tomasko et al.'s Table 1 functions resampled log-linearly in angle keep their normalization to within 1.2 %
    for key in ("phase_lo", "phase_hi"):
        assert np.all(np.abs(np.asarray(d[key]["raw_norm"]) - 1) < 0.012), key
    meth = next(c for c in out["bodies"]["606"]["components"] if c["id"] == "methane")
    assert meth["singleScatteringAlbedo"]["value"] == [0.0] * 48 and meth["phaseFunction"]["value"]["kind"] == "none"
    # the extinction encodes the measured column: τ_k = column × k (10 nm box average) at every sample
    col = d["ch4_column_km_am"]
    assert 1.0 < col < 5.0
    k_box = atmo.sample_box(ab.methane_k_fine(atmo.FINE))
    tau = np.array(meth["columnOpticalDepth"])
    assert np.allclose(tau, col * k_box, rtol=0.02, atol=1e-5)
