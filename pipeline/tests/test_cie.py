import numpy as np

from pipeline import cie


def test_equal_energy_is_white():
    X, Y, Z, _ = cie.xyzs(np.ones_like(cie.WAVELENGTHS))
    # Equal-energy spectrum has chromaticity (1/3, 1/3) by construction of the CIE 1931 CMFs.
    s = X + Y + Z
    assert abs(X / s - 1 / 3) < 2e-3 and abs(Y / s - 1 / 3) < 2e-3


def test_555nm_monochromatic_is_683_lm_per_w():
    spec = np.where(cie.WAVELENGTHS == 555.0, 1.0, 0.0)
    assert abs(cie.xyzs(spec)[1] - 683.0) < 1.0
