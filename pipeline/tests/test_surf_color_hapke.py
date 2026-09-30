"""Band → XYZS weights, the colour-label criterion, and the Hapke model used for the lunar maps."""

import numpy as np
import pytest

from pipeline import cie, surf_color as sc, surf_hapke as hk

FLAT = np.ones(cie.WAVELENGTHS.size)


def _sun_like():
    # smooth positive stand-in for p·E: the weights' algebra does not depend on the actual spectra
    wl = cie.WAVELENGTHS
    return 1.0 + 0.3 * np.sin(wl / 60.0)


def test_weights_sum_to_one_and_preserve_the_disk_mean():
    bands = [321, 360, 415, 566, 604, 643, 689]
    W = sc.channel_weights(bands, _sun_like(), FLAT)
    assert W.shape == (4, 7)
    assert np.allclose(W.sum(axis=1), 1.0)
    # all ratios 1 → texel 1 in every channel
    assert np.allclose(W @ np.ones(7), 1.0)
    # disk means of ratios are 1 → disk mean of texels is 1 (linearity)
    rng = np.random.default_rng(0)
    rho = rng.uniform(0.5, 1.5, (1000, 7))
    rho /= rho.mean(axis=0)
    assert np.allclose((rho @ W.T).mean(axis=0), 1.0)


def test_single_band_gives_equal_channels():
    W = sc.channel_weights([550], _sun_like(), FLAT)
    assert np.allclose(W, 1.0)


def test_hat_basis_is_flat_outside():
    phi = sc.hat_basis([450, 600])
    wl = cie.WAVELENGTHS
    assert np.allclose(phi[0][wl <= 450], 1) and np.allclose(phi[1][wl >= 600], 1)
    assert np.allclose(phi.sum(axis=0), 1)


def test_color_label_criterion():
    moon = sc.diagnostics([321, 360, 415, 566, 604, 643, 689], _sun_like(), FLAT)
    assert moon.label == "estimated" and moon.max_gap_nm == pytest.approx(151)
    dense = sc.diagnostics(list(range(350, 841, 20)), _sun_like(), FLAT)
    assert dense.label == "derived"
    # nyquist spacing is derived from the CIE tables: half of the narrowest FWHM (z̄ or the x̄ main lobe)
    assert 20 < sc.nyquist_spacing_nm() < 40


def test_interpolation_spread_zero_for_linear_ratios():
    bands = [400, 500, 600, 700]
    rho = np.array([[1.0, 1.0, 1.0, 1.0], [0.8, 0.9, 1.0, 1.1]])
    s = sc.interpolation_spread(rho, bands, _sun_like(), FLAT)
    assert all(v["max"] < 1e-9 for v in s.values())


# ------------------------------------------------------------------------------------------------ Hapke


def test_h_function_matches_chandrasekhar():
    # Chandrasekhar (1960) isotropic H function: H(1) = 2.9078 for w = 1; Hapke's approximation is within ~1 %
    assert hk.h_function(1.0, 1.0) == pytest.approx(2.9078, rel=0.01)
    assert hk.h_function(0.0, 0.7) == pytest.approx(1.0)


def test_roughness_is_neutral_at_normal_geometry():
    _, _, S = hk._roughness(np.array(0.0), np.array(0.0), np.array(0.0), np.radians(23.657))
    assert S == pytest.approx(1.0)
    # with e = 0 the result does not depend on the (undefined) azimuth
    a = hk._roughness(np.radians(60.0), np.array(0.0), np.array(0.0), np.radians(23.657))
    b = hk._roughness(np.radians(60.0), np.array(0.0), np.array(np.pi / 2), np.radians(23.657))
    assert np.allclose(a, b)


def test_smooth_surface_reduces_to_textbook_form():
    w, b, c, bs0, hs = 0.3, 0.25, 0.4, 1.5, 0.06
    i, e, g = 30.0, 20.0, 50.0
    got = hk.radf(i, e, g, w, b, c, bs0, hs, theta_bar_deg=1e-6)
    mu0, mu = np.cos(np.radians(i)), np.cos(np.radians(e))
    p = hk.phase_dhg(np.radians(g), b, c)
    B = 1 / (1 + np.tan(np.radians(g) / 2) / hs)
    exp = np.pi * w / (4 * np.pi) * mu0 / (mu0 + mu) * (p * (1 + bs0 * B) + hk.h_function(mu0, w) * hk.h_function(mu, w) - 1)
    assert got == pytest.approx(exp, rel=1e-6)


def test_lunar_like_parameters_give_lunar_reflectances():
    # median 643 nm parameters of the LROC map (w 0.396, b 0.228, c 0.424, Bs0 1.66, hs 0.051):
    # I/F at i = g = 60°, e = 0 of a mid-albedo lunar surface is ~0.05
    r60 = hk.radf(60, 0, 60, 0.3955, 0.2279, 0.4242, 1.6595, 0.0505)
    assert 0.03 < r60 < 0.07
    f = hk.normal_over_standard(0.3955, 0.2279, 0.4242, 0.0, 0.0505)
    assert 1.5 < f < 3.0
