"""ROLO lunar model (photometry/rolo.py): transcription, units and signs against the paper's own Table 5, physical
sanity checks, and the channel refit and phase table used in photometry.json."""

import math

import numpy as np
import pytest

from pipeline.photometry import phase, rolo
from pipeline.photometry.common import read_table_json

T = read_table_json("kieffer_stone_2005_rolo.json")


def test_table4_shape_and_signs():
    t = rolo.TABLE
    assert t.shape == (32, 11) and np.all(np.diff(t[:, 0]) > 0) and t[0, 0] == 350.0 and t[-1, 0] == 2383.6
    a0, a1, d1 = t[:, 1], t[:, 2], t[:, 8]
    assert np.all(a0 < 0) and np.all(a1 < 0) and np.all(d1 > 0)
    assert rolo.C == (0.00034115, -0.0013425, 0.00095906, 0.00066229)
    assert rolo.P == (4.06054, 12.8802, -30.5858, 16.7498)


def test_table5_signs_and_effects_confirm_units():
    """Table 5 gives example values (close to band averages) and each term's 'Effect', the change in ln A over the full
    range of its variables. The effects are reproduced with g and Φ in radians up to 99° (polynomials) and g in
    degrees from 1.55° (exponentials): a check of the units used here."""
    t5 = T["table5"]
    mean = rolo.COEF.mean(axis=0)
    names = ("a0", "a1", "a2", "a3", "b1", "b2", "b3", "d1", "d2", "d3")
    for k, name in enumerate(names):
        if name != "d3":      # the smallest term; its example value and band average differ in sign
            assert math.copysign(1, t5[name][0]) == math.copysign(1, mean[k]), name
    gmax = math.radians(99.0)
    for i, name in enumerate(("a1", "a2", "a3"), start=1):
        assert abs(t5[name][0]) * gmax ** i == pytest.approx(t5[name][1], rel=0.01), name
    for j, name in enumerate(("b1", "b2"), start=1):
        assert abs(t5[name][0]) * 2 * gmax ** (2 * j - 1) == pytest.approx(t5[name][1], rel=0.01), name
    for name, p in (("d1", rolo.P[0]), ("d2", rolo.P[1])):
        eff = abs(t5[name][0]) * (math.exp(-1.55 / p) - math.exp(-99.0 / p))
        assert eff == pytest.approx(t5[name][1], rel=0.02), name


def test_physical_behaviour():
    g = np.array([30.0, 60.0, 90.0])
    wax = rolo.channel_reflectance(g, g)[:, 1]
    wan = rolo.channel_reflectance(g, -g)[:, 1]
    # before full Moon (Sun east, Φ > 0) the Moon is brighter: the western, maria-rich hemisphere is lit after full
    # Moon (Lane & Irvine 1973: 0.01-0.09 mag between quadrature and full, Rougier 1934)
    assert np.all(wax > wan) and np.all(wax / wan < 1.25)
    # opposition surge: the logarithmic slope steepens towards zero phase
    g = np.array([1.55, 3.0, 6.0, 12.0])
    slope = -np.diff(np.log(rolo.mean_phase_y(g))) / np.diff(g)
    assert np.all(np.diff(slope) < 0) and slope[0] > 1.3 * slope[2]
    # the Moon reddens with phase angle
    a = rolo.channel_reflectance(np.array([5.0, 60.0]), np.array([5.0, 60.0]))
    assert a[1, 0] / a[1, 2] > a[0, 0] / a[0, 2]


def test_channel_refit_reproduces_band_integration():
    m = rolo.channel_model()
    assert m.max_residual < 1e-4
    for g, s, th, ph in ((1.6, 1.0, 3.0, -2.0), (30.0, 25.0, 5.0, -6.0), (60.0, -65.0, -6.0, 7.0), (96.0, 90.0, 0, 0)):
        assert np.allclose(np.exp(m.ln_a(g, s, th, ph)), rolo.channel_reflectance(g, s, th, ph), rtol=2e-4)


def test_disk_radius_matches_eq8():
    assert rolo.RADIUS_KM == pytest.approx(1737.4, abs=0.05)


def test_reference_albedo_is_rolo_at_min_phase():
    """The Moon's albedo spectrum is ROLO at 1.55°: its Y channel equals the channel model there, and the phase
    table is 1 at that angle."""
    from pipeline.photometry import albedo
    spec = albedo.spectrum_for(301)
    assert spec.label == "derived" and spec.wl[0] == 350.0 and spec.wl.size == 32
    assert rolo.reference_py() == pytest.approx(float(rolo.mean_phase_y(rolo.MIN_PHASE)), rel=2e-4)
    # Lane & Irvine (the cross-check) is redder: its red/blue albedo ratio exceeds ROLO's
    li = albedo.moon_lane_irvine()
    r_li = np.interp(700, li.wl, li.p) / np.interp(450, li.wl, li.p)
    r_rolo = np.interp(700, spec.wl, spec.p) / np.interp(450, spec.wl, spec.p)
    assert r_li > r_rolo > 1.0


def test_phase_table():
    p_y = rolo.reference_py()
    li_a, li_dm = phase._lane_irvine_phase()
    t = rolo.phase_table(p_y, li_a, li_dm)
    pf = t["function"]
    a, dm = np.array(pf["alphaDeg"]), np.array(pf["deltaMag"])
    assert a[0] == 1.55 and a[-1] == 120.0 and np.all(np.diff(a) > 0) and np.all(np.diff(dm) > 0)
    dense = np.arange(1.55, 97.0, 0.05)
    exact = -2.5 * np.log10(rolo.mean_phase_y(dense) / p_y)
    assert np.max(np.abs(np.interp(dense, a, dm) - exact)) < 0.002
    # Lane & Irvine's shape beyond 97°, continuous at the join
    k = list(a).index(97.0)
    li = np.interp(a[k:], li_a, li_dm)
    assert np.allclose(dm[k:] - li, dm[k] - li[0], atol=1e-4)
    assert phase.delta_mag(pf, 1.0) is None and phase.delta_mag(pf, 121.0) is None
