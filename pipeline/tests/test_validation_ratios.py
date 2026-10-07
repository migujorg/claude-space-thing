"""Same-frame spatial tests cancel shared conversion terms, never choose the model."""
from types import SimpleNamespace
import numpy as np
from pipeline.validation import build


def row(id, kind, mean, noise, registration, target=599):
    return {"id": id, "kind": kind, "target": target,
            "expected": {"type": "value", "label": "estimated", "XYZS": [mean]*4,
                         "budget": {"noiseAndRegistration": [np.hypot(noise, registration)]*4,
                                    "spectralModel": [mean*.17]*4}},
            "bands": [{"filter": "test", "iof": {"mean": mean},
                       "sigmaRel": {"calibration": .1, "noise": noise/mean, "registration": registration/mean}}]}


def test_spatial_pairs_and_known_noise_budget_keep_additive_background():
    rows = [row("centre", "disk-centre", 100., 3., 4.), row("limb", "limb", 50., 1.5, 2.),
            row("term", "terminator", 25., .75, 1.), row("disk", "disk-integrated", 20., 2., 0.)]
    ratios = build._ratios(SimpleNamespace(ratios=[]), rows)
    assert [(q["numerator"], q["denominator"]) for q in ratios] == [
        ("limb", "centre"), ("term", "centre"), ("centre", "disk"), ("limb", "disk"), ("term", "disk")]
    np.testing.assert_allclose(ratios[0]["sigma"], .5*np.hypot(.05, .05))
    # disk noise includes the measured additive sky/background uncertainty; it cannot cancel.
    np.testing.assert_allclose(ratios[2]["sigma"], 5*np.hypot(.05, .1))
    assert "spectral" in ratios[0]["method"]
    assert ratios[0]["label"] == "estimated"


def test_unavailable_regions_are_not_fabricated_and_bodies_are_not_mixed():
    rows = [row("a", "disk-centre", 1., .1, 0., 399), row("b", "disk-integrated", 1., .1, 0., 301)]
    assert build._ratios(SimpleNamespace(ratios=[]), rows) == []


def test_scene_dependence_propagates_to_ratios():
    rows = [row("centre", "disk-centre", 1., .1, 0.), row("limb", "limb", 1., .1, 0.)]
    rows[0]["sceneDependence"] = {"reason": "different epoch", "sources": ["test-source"]}
    assert build._ratios(SimpleNamespace(ratios=[]), rows)[0]["sceneDependence"] == rows[0]["sceneDependence"]


def test_cross_body_ratio_keeps_its_distinct_spectral_terms():
    rows = [row("moon", "disk-integrated", 10., 1., 0., 301),
            row("earth", "disk-integrated", 100., 2., 0., 399)]
    ratio = build._ratios(SimpleNamespace(ratios=[("moon", "earth")]), rows)[0]
    np.testing.assert_allclose(ratio["sigma"], .1*np.hypot(np.hypot(.1, .17), np.hypot(.02, .17)))


def test_unknown_region_stays_unknown_and_produces_no_ratio():
    rows = [row("centre", "disk-centre", 100., 3., 4.), row("limb", "limb", 50., 1.5, 2.)]
    rows[1]["expected"] = {"type": "none", "label": "unknown"}
    assert build._ratios(SimpleNamespace(ratios=[]), rows) == []


def test_multiband_spectral_term_cancels_only_for_proportional_spectra():
    from pipeline.validation import photometry as vp
    centers = np.array([400., 550., 700.])
    a = np.array([.2, .5, .1])
    np.testing.assert_allclose(vp.ratio_spectral_spread(a, 2*a, centers, vp.FLAT), 0., atol=1e-14)
    assert np.any(vp.ratio_spectral_spread(a, np.array([.2, .3, .3]), centers, vp.FLAT) > 0)
