"""Sunlight: spectrum integrals, CIE quantities, limb darkening, wavelength conversion."""

import numpy as np
import pytest

from pipeline import cie
from pipeline.photometry import solar
from pipeline.photometry.common import air_index_edlen1966, bin_average, vacuum_to_air


def test_edlen_standard_air_index():
    # Edlén (1966) standard air at 633 nm vacuum: (n - 1) = 2.7653e-4 (a textbook He-Ne value for 15 degC).
    assert (air_index_edlen1966(np.array([632.99]))[0] - 1.0) == pytest.approx(2.765e-4, rel=2e-3)
    assert 550.0 - vacuum_to_air(np.array([550.0]))[0] == pytest.approx(0.1528, abs=0.001)


def test_bin_average_is_exact_for_piecewise_linear():
    wl = np.linspace(300, 900, 2401)
    v = 2.0 + 0.01 * wl
    out = bin_average(wl, v)
    assert np.allclose(out, 2.0 + 0.01 * cie.WAVELENGTHS, atol=1e-12)
    assert np.isnan(bin_average(np.array([400.0, 800.0]), np.array([1.0, 1.0]))[0])


def test_spectrum_integral_vs_tsi():
    """HSRS covers 202-2730 nm only; its integral must be a large, plausible fraction of TSI = 1361 W/m^2
    (IAU 2015 B3 nominal S_sun, ±1). Measured: 1325.76 W/m^2 = 97.4 %."""
    t = solar.total_irradiance()
    assert t["range_nm"][0] == pytest.approx(202.0) and t["range_nm"][1] == pytest.approx(2729.975)
    assert 0.96 * 1361 < t["total_W_m2"] < 0.99 * 1361
    assert 700 < t["visible_360_830_W_m2"] < 780


def test_energy_conserved_by_air_conversion():
    s = solar.spectrum()
    m = (s.wl_vac > 400) & (s.wl_vac < 800)
    assert np.trapezoid(s.ssi_air[m], s.wl_air[m]) == pytest.approx(np.trapezoid(s.ssi_vac[m], s.wl_vac[m]),
                                                                    rel=1e-6)


def test_sunlight_xyzs():
    X, Y, Z, S = solar.irradiance_xyzs()
    # Solar illuminance at 1 AU: expected ~1.2-1.35e5 lux; measured 134 647 lux from the HSRS.
    assert 1.2e5 < Y < 1.36e5
    x, y = X / (X + Y + Z), Y / (X + Y + Z)
    assert x == pytest.approx(0.3216, abs=0.002) and y == pytest.approx(0.332, abs=0.002)
    # Scotopic/photopic ratio of sunlight (S/P ~ 2.3-2.5 for daylight spectra)
    assert 2.2 < S / Y < 2.6


def test_limb_darkening_channels():
    ld = solar.limb_darkening()
    assert ld.coeffs.shape == (4, 6)
    assert np.allclose(ld.at_mu1, 1.0, atol=5e-5)            # I(1)/I(1) = 1 up to Table I rounding
    assert ld.fit_residual_max < 1e-9                          # weighted mean of quintics is a quintic
    mu = np.linspace(0, 1, 101)
    prof = np.array([np.polynomial.polynomial.polyval(mu, c) for c in ld.coeffs])
    assert np.all(np.diff(prof, axis=1) > 0)                   # darker towards the limb in every channel
    # Blue (Z) darkens more than red (X): Z has the smallest disk-average/centre ratio.
    x_fi, y_fi, z_fi, s_fi = ld.flux_to_center
    assert z_fi < s_fi < y_fi < x_fi
    # Neckel & Labs' F/I rises from 0.73 (400 nm) to 0.85 (750 nm); the channel values sit inside that range.
    assert 0.74 < z_fi and x_fi < 0.83
