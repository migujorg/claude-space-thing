"""Spectrum -> XYZS through cie, and the photometric relation."""

import numpy as np
import pytest

from pipeline import cie
from pipeline import stars_format as sf
from pipeline import stars_light as sl
from pipeline.paths import OUT
from pipeline.stars_gaia import XP_WAVELENGTHS


def test_linear_operator_equals_direct_cie():
    W = sl.linear_operator(XP_WAVELENGTHS)
    rng = np.random.default_rng(0)
    for _ in range(3):
        f = np.abs(rng.normal(1e-12, 3e-13, XP_WAVELENGTHS.size))
        direct = cie.xyzs(cie.resample(XP_WAVELENGTHS, f))
        np.testing.assert_allclose(f @ W, direct, rtol=1e-12)


def test_coverage_rules():
    wl = np.arange(320.0, 1081.0, 2.5)
    ok = np.ones(wl.size, bool)
    assert sl.covers_cie(wl, ok)
    gap = ok.copy()
    gap[(wl > 500) & (wl < 506)] = False
    assert not sl.covers_cie(wl, gap)
    short = wl <= 735
    assert not sl.covers_cie(wl, short)
    edge = ok & (wl >= 330)  # missing samples outside 360-830 are fine
    assert sl.covers_cie(wl, edge)
    with pytest.raises(ValueError):
        sl.spectrum_xyzs(wl, np.where(gap, 1e-12, np.nan))


def test_relation_recovers_exact_law():
    rng = np.random.default_rng(3)
    c = rng.uniform(-0.3, 2.0, 5000)
    m = rng.uniform(5, 9, 5000)
    k = np.stack([1e-6 * (1 + c), 2e-6 * np.ones_like(c), 3e-6 * np.exp(-c), 5e-6 / (1 + c * c)], axis=1)
    xyzs = 10 ** (-0.4 * m)[:, None] * k
    rel = sl.fit_relation("test", m, c, xyzs, per_bin=100, max_width=0.05)
    pred, ex = rel.predict(np.array([6.0, 7.0]), np.array([0.5, 1.2]))
    truth = 10 ** (-0.4 * np.array([6.0, 7.0]))[:, None] * np.stack(
        [1e-6 * (1 + np.array([0.5, 1.2])), [2e-6, 2e-6], 3e-6 * np.exp(-np.array([0.5, 1.2])),
         5e-6 / (1 + np.array([0.5, 1.2]) ** 2)], axis=1)
    np.testing.assert_allclose(pred, truth, rtol=0.01)
    assert not ex.any()


@pytest.mark.skipif(not (OUT / "stars" / "bright.json").exists(), reason="stars product not built")
def test_named_stars_brightness_sanity():
    """Y vs the rough V-band relation E_V = 2.54e-6 * 10^(-0.4 V) lux (sanity check only, not a data source)."""
    h, cols = sf.read_table(OUT / "stars" / "bright.json")
    V = {32349: -1.46, 30438: -0.74, 69673: -0.05, 91262: 0.03, 24436: 0.13, 80763: 1.09, 27989: 0.5}
    for hip, v in V.items():
        k = np.nonzero(cols["hip"] == hip)[0]
        assert k.size == 1
        y = float(cols["xyzs"][k[0], 1])
        dm = -2.5 * np.log10(y / (2.54e-6 * 10 ** (-0.4 * v)))
        assert abs(dm) < 0.4, (hip, dm)  # Betelgeuse/Antares vary and are very red: generous bound
