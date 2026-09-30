import numpy as np
import pytest

from pipeline import cie


def test_equal_energy_is_white():
    X, Y, Z, _ = cie.xyzs(np.ones_like(cie.WAVELENGTHS))
    # Equal-energy spectrum has chromaticity (1/3, 1/3) by construction of the CIE 1931 CMFs.
    s = X + Y + Z
    assert abs(X / s - 1 / 3) < 2e-3 and abs(Y / s - 1 / 3) < 2e-3


def test_555nm_monochromatic_is_683_lm_per_w():
    spec = np.where(cie.WAVELENGTHS == 555.0, 1.0, 0.0)
    assert abs(cie.xyzs(spec)[1] - 683.0) < 1.0


def test_official_tables_match_colour_science():
    """The official CIE CSVs agree with colour-science's transcription (which cie.py used before)."""
    colour = pytest.importorskip("colour")
    shape = colour.SpectralShape(360, 830, 1)
    ref = colour.MSDS_CMFS["CIE 1931 2 Degree Standard Observer"].copy().align(shape).values
    assert np.max(np.abs(cie.cmfs() - ref)) < 1e-9
    ref_s = colour.SDS_LEFS["CIE 1951 Scotopic Standard Observer"].copy().align(shape).values
    inside = (cie.WAVELENGTHS >= 380) & (cie.WAVELENGTHS <= 780)
    assert np.max(np.abs(cie.scotopic()[inside] - ref_s[inside])) < 1e-9
    # Outside 380–780 nm the CIE table has no rows. The CIE metadata says extrapolationMethod = "zero";
    # colour-science's align() holds the edge values instead (5.89e-4 below 380 nm), which the previous
    # cie.py inherited. The difference is < 0.02 % of the scotopic integral of sunlight.
    assert np.all(cie.scotopic()[~inside] == 0.0)
    assert np.max(ref_s[~inside]) == pytest.approx(5.89e-4)


def test_table_landmarks():
    """Spot values printed in CIE 018:2019 / ISO/CIE 11664-1 (and the CIE metadata's sample rows)."""
    i = int(479 - 360)
    assert cie.cmfs()[i].tolist() == pytest.approx([0.1042979, 0.1334528, 0.8566193], abs=1e-12)
    assert cie.scotopic()[int(507 - 360)] == pytest.approx(1.0, abs=1e-12)  # V'(507 nm) = 1
    assert cie.cmfs()[int(555 - 360), 1] == pytest.approx(1.0, abs=1e-12)   # ȳ(555 nm) = 1
    assert cie.scotopic()[0] == 0.0 and cie.scotopic()[-1] == 0.0          # zero extrapolation per CIE metadata


def test_scotopic_555_is_1700_times_vprime():
    spec = np.where(cie.WAVELENGTHS == 507.0, 1.0, 0.0)
    assert cie.xyzs(spec)[3] == pytest.approx(1700.06, rel=1e-9)
