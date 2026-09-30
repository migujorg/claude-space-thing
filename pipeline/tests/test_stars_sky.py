"""Offline checks of the sky helpers: HEALPix, the transcribed zodiacal-light tables and the dust model."""

import numpy as np
import pytest

from pipeline.stages import stars as _stars  # noqa: F401  (astropy import guard, see stars._import_astropy)
from pipeline import sky_diffuse as sd
from pipeline import sky_healpix as hp
from pipeline import sky_zodi as zl


@pytest.mark.parametrize("order", [0, 1, 2, 5])
def test_healpix_roundtrip(order):
    p = np.arange(hp.npix(order))
    assert (hp.vec2pix(order, hp.pix2vec(order, p)) == p).all()


def test_healpix_known_pixels():
    # order 0: face 0 is centred at z = 2/3, phi = 45 deg; face 4 on the equator at phi = 0; face 8 at z = -2/3
    v = hp.pix2vec(0, np.array([0, 4, 8]))
    assert np.allclose(v[0], [np.sqrt(5) / 3 * np.cos(np.pi / 4), np.sqrt(5) / 3 * np.sin(np.pi / 4), 2 / 3])
    assert np.allclose(v[1], [1, 0, 0])
    assert np.isclose(v[2, 2], -2 / 3)
    # NESTED children of a pixel lie inside it: parent(order 5 pixel) == pixel >> 2 at order 4
    rng = np.random.default_rng(1)
    u = rng.normal(size=(5000, 3))
    assert (hp.vec2pix(5, u) >> 2 == hp.vec2pix(4, u)).all()


def test_healpix_equal_area():
    rng = np.random.default_rng(2)
    u = rng.normal(size=(480_000, 3))
    counts = np.bincount(hp.vec2pix(3, u), minlength=hp.npix(3))
    expect = u.shape[0] / hp.npix(3)
    chi2 = np.sum((counts - expect) ** 2 / expect)
    assert chi2 / hp.npix(3) < 1.3


def test_leinert_tables_consistent():
    lam, beta, t16 = zl.leinert_table(16)
    lam17, beta17, t17 = zl.leinert_table(17)
    assert lam.tolist() == [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180]
    assert beta.tolist() == [0, 5, 10, 15, 20, 25, 30, 45, 60, 75]
    assert (np.isnan(t16) == np.isnan(t17)).all()
    assert np.isnan(t16).sum() == 3 + 3 + 2
    ok = np.isfinite(t16)
    # Table 17 = 1.28 x Table 16, both rounded to about 3 significant digits
    assert np.max(np.abs(t17[ok] / (1.28 * t16[ok]) - 1)) < 0.012
    # brightness falls with latitude at every longitude, and the pole value (60) is below the beta = 75 column
    for row in t16:
        v = row[np.isfinite(row)]
        assert (np.diff(v) <= 0).all()
    assert (t16[:, -1] >= 56).all()


def test_fco():
    assert np.isclose(zl.fco(np.array([500.0]), 30.0)[0], 1.0)
    assert np.isclose(zl.fco(np.array([400.0]), 30.0)[0], 1 + 1.2 * np.log10(0.8))
    assert np.isclose(zl.fco(np.array([700.0]), 120.0)[0], 1 + 0.6 * np.log10(1.4))
    mid = zl.fco(np.array([700.0]), 60.0)[0]
    assert np.isclose(mid, 0.5 * (1 + 0.8 * np.log10(1.4)) + 0.5 * (1 + 0.6 * np.log10(1.4)))


def test_kelsall_density_and_phase():
    m = zl.Kelsall.load()
    n = m.smooth(np.array([1.0]), np.array([0.0]), np.array([0.0]))[0]
    assert 0.9 * 1.13e-7 < n < 1.1 * 1.13e-7
    # density falls off the midplane and outward
    assert m.smooth(np.array([1.0]), np.array([0.0]), np.array([0.3]))[0] < n
    assert m.smooth(np.array([2.0]), np.array([0.0]), np.array([0.0]))[0] < n
    for c in ((-0.942, 0.121, -0.165), (-0.1, 0.08, -2.0)):
        t = np.linspace(0, np.pi, 4001)
        integral = 2 * np.pi * np.trapezoid(zl.phase(t, *c) * np.sin(t), t)
        assert np.isclose(integral, 1.0, rtol=1e-4)


def test_two_band_power_law_roundtrip():
    wl = np.arange(300.0, 1100.0, 0.5)
    f = 1.0 + 0.3 * np.sin(wl / 37.0)          # any positive "solar" spectrum
    grid_wl = np.arange(360.0, 831.0)
    grid_f = np.interp(grid_wl, wl, f)
    tb = sd.TwoBand(wl, f, grid_f, grid_wl, lambda s: np.array([s.sum(), s[:100].sum(), s[-100:].sum(), 1.0]),
                    {"B": (437.0, 82.6), "R": (644.1, 96.8)})
    for a in (-1.5, 0.0, 0.7):
        t = (wl / 437.0) ** a
        b = sd.band_mean(wl, f * t, 437.0, 82.6) / tb.fb * 10.0
        r = sd.band_mean(wl, f * t, 644.1, 96.8) / tb.fr * 10.0
        x, alpha = tb.xyzs_from_s10(np.array([b]), np.array([r]))
        assert abs(alpha[0] - a) < 0.02


def test_smooth_preserves_constant():
    K = sd.gauss_matrix(3, 2, 20.0)
    v = np.full(hp.npix(3), 5.0)
    v[::7] = np.nan
    assert np.allclose(sd.smooth(K, v), 5.0)
    assert np.allclose(sd.to_parent(np.arange(hp.npix(2)) * 0 + 2.0, 2, 1), 2.0)
