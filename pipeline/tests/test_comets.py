"""Comets as they look: Haser profiles, dust colour from the measured colours, the measured band strengths against
their own fluorescence efficiencies, grain dynamics constants, the window magnitudes, and the built products."""

from __future__ import annotations

import json
import math

import numpy as np
import pytest
from scipy import integrate

from pipeline import comet_model as cm
from pipeline import comet_sources as cs
from pipeline import comet_window as cw
from pipeline.download import RAW
from pipeline.paths import OUT

HAVE_MODEL = (OUT / "comets" / "model.json").exists()
HAVE_LOWELL = (RAW / "comets" / "lowell-db" / "locdprod.tab").exists()
HAVE_MCD = (RAW / "comets" / "mcdonald" / "fluxmc.tab").exists()


# ---------------------------------------------------------------------------------------------- Haser
def test_haser_enclosed_limits_and_monotone():
    x = np.logspace(-4, 2, 61)
    f = cm.haser_enclosed(22000 / 66000, x)
    assert f[0] < 1e-3 and f[-1] > 0.999
    assert np.all(np.diff(f) >= -1e-9)


def test_haser_enclosed_matches_column_density_integral():
    """Enclosed fraction = int_0^rho 2 pi rho' N(rho') d rho' / N_tot with N the line-of-sight column of the Haser
    daughter density (independent computation by direct integration)."""
    k = 13000 / 210000
    ld = 1.0

    def n(r):
        return (math.exp(-r / ld) - math.exp(-r / (k * ld))) / (4 * math.pi * r * r)

    def column(rho):
        return 2 * integrate.quad(lambda z: n(math.hypot(rho, z)), 0, np.inf, limit=200)[0]

    ntot = (1 - k) * ld          # int n 4 pi r^2 dr
    for x in (0.05, 0.3, 1.0, 3.0):
        direct = integrate.quad(lambda r: 2 * math.pi * r * column(r), 0, x, limit=200)[0] / ntot
        assert cm.haser_enclosed(k, np.array([x]))[0] == pytest.approx(direct, rel=2e-3, abs=2e-4)


# ---------------------------------------------------------------------------------------------- dust colour
def test_dust_reflectance_reproduces_colour_excess():
    """Sunlight x R(lambda) through the Bessell passbands gives the measured comet-minus-Sun colours (the reflectance
    is built from them; checks the construction, not the data)."""
    from pipeline.photometry import filters, solar
    col = {"BV": 0.78, "VR": 0.47, "RI": 0.42}
    sun = {"BV": 0.64, "VR": 0.35, "RI": 0.33}
    refl, _ = cm.dust_reflectance(col, sun)
    e = solar.spectrum().grid

    def band(b, spec):
        fw, ft = filters.passband(b)
        t = np.interp(cm.GRID, fw, ft, left=0.0, right=0.0)
        return (spec * t).sum()

    def colour(b1, b2):
        return -2.5 * math.log10(band(b1, e * refl) / band(b2, e * refl)) + 2.5 * math.log10(band(b1, e) / band(b2, e))

    assert colour("B", "V") == pytest.approx(0.14, abs=0.02)
    assert colour("V", "R") == pytest.approx(0.12, abs=0.02)


# ---------------------------------------------------------------------------------------------- data consistency
@pytest.mark.skipif(not HAVE_MCD, reason="McDonald survey not downloaded (run the comets stage)")
def test_mcdonald_c2_sequence_ratio_matches_efficiencies():
    """The measured flux ratio C2 (Delta v = +1) / (Delta v = 0) equals the ratio of the dataset's own fluorescence
    efficiencies (10^-12.62 / 10^-12.35) within 10 %: both bands see the same molecules."""
    m = cs.read_mcdonald()
    r = cm.mcdonald_band_ratios(m["rows"])["C2(1)"]["median"]
    g = 10 ** (-m["logLN"]["C2 (delta NU = 1)"]) / 10 ** (-m["logLN"]["C2 (delta NU = 0)"])
    assert r == pytest.approx(g, rel=0.1)


@pytest.mark.skipif(not HAVE_LOWELL, reason="Lowell database not downloaded (run the comets stage)")
def test_lowell_population_ratios_match_ahearn():
    """Population medians of the per-comet ratios are within the ranges A'Hearn et al. (1995) report for the
    'typical' class (log C2/OH ~ -2.4, CN/OH ~ -2.5, C3/OH ~ -3.6, Afrho/Q(OH) ~ -25.8 +- 0.5)."""
    p = cm.lowell_ratios(cs.read_lowell_db())["population"]
    assert -3.1 < p["C2"]["median"] < -2.2
    assert -2.9 < p["CN"]["median"] < -2.3
    assert -4.1 < p["C3"]["median"] < -3.3
    assert -26.3 < p["afrho"]["median"] < -24.8


def test_beta_constant_matches_cpr():
    """beta from L_sun, GM_sun and c (Agarwal et al. 2007, Eq. 9) against Moreno & Jehin's C_pr = 1.191e-3 kg m^-2:
    the same physics with an older solar luminosity (4 %)."""
    b = cm.beta_of_radius(np.array([1e-6]), 132712440041.279, 1000.0, 1.0)[0]
    assert b == pytest.approx(1.191e-3 / (2 * 1000.0 * 1e-6), rel=0.05)


def test_magnitudes_geometry():
    helio = np.array([[1.5 * cw.AU_KM, 0.0, 0.0]])
    earth = np.array([cw.AU_KM, 0.0, 0.0])
    m, r, d, el = cw.magnitudes(np.array([8.0]), np.array([10.0]), helio, earth)
    assert r[0] == pytest.approx(1.5)
    assert d[0] == pytest.approx(0.5)
    assert m[0] == pytest.approx(8.0 + 5 * math.log10(0.5) + 10 * math.log10(1.5))
    assert el[0] == pytest.approx(180.0)


# ---------------------------------------------------------------------------------------------- products
@pytest.mark.skipif(not HAVE_MODEL, reason="comets products not built")
def test_model_product():
    m = json.loads((OUT / "comets" / "model.json").read_text())
    for k in ("C2(0)", "C2(1)", "CN(0)", "C3", "CH", "OI6300", "OI6364", "COplus(2,0)", "COplus(3,0)"):
        b = m["components"]["bands"][k]
        assert b["xyzs"][1] >= 0 and b["v"] >= 0
    # C2 Swan emission is green: y chromaticity above the Sun's
    xyz = m["components"]["bands"]["C2(0)"]["xyzs"]
    sun = m["components"]["sunV"]["xyzs1Au"]
    assert xyz[1] / sum(xyz[:3]) > sun[1] / sum(sun[:3])
    # dust redder than the Sun (x chromaticity)
    d = m["components"]["dust"]["longPeriod"]["xyzs"]
    assert d[0] / sum(d[:3]) > sun[0] / sum(sun[:3])
    assert m["oxygen"]["photonsPerH2O"] == pytest.approx(0.064 + 0.81 * 0.357)
    assert sum(m["coPlus"]["share"].values()) == pytest.approx(1.0)
    assert 300 < m["solarWind"]["medianKmS"] < 500


@pytest.mark.skipif(not HAVE_MODEL, reason="comets products not built")
def test_list_product():
    lst = json.loads((OUT / "comets" / "list.json").read_text())
    mags = [n["peakMag"] for n in lst["notable"]]
    assert mags == sorted(mags) and all(m <= lst["notableMag"] for m in mags)
    assert lst["showcase"]["designation"] in [n["designation"] for n in lst["notable"]]
