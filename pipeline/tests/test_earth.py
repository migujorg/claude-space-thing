"""Earth's disk-integrated photometry from Himawari-9 and EPOXI (photometry/earth.py): format, geometry, calibration
and the product against its own inputs and an independent data set."""

import math

import numpy as np
import pytest

from pipeline.photometry import albedo, earth as E, earth_data as ed, filters


@pytest.fixture(scope="module")
def disk():
    return E.himawari_disk()


def test_mean_radius_is_pck():
    assert E.R_MEAN_KM == pytest.approx(albedo.mean_radius(399), abs=0.001)


def test_hsd_header_and_calibration():
    seg = E.read_segment(ed.himawari_files()[0])
    assert (seg.band, seg.cols, seg.lines, seg.first_line) == (1, 11000, 1100, 1)
    assert seg.sub_lon == 140.7 and seg.h_km == 42164.0 and seg.cfac == 40932549
    # JMA's radiance-to-albedo coefficient is π/E_sun(1 AU); ours from TSIS-1 HSRS and the AHI-09 response agrees
    for b, path in ((1, 0), (2, 10), (3, 20), (4, 30)):
        s = E.read_segment(ed.himawari_files()[path])
        assert math.pi / s.c_prime == pytest.approx(E.ahi_band_irradiance(b), rel=0.03), b


def test_ahi_passbands():
    eff = [filters.effective_wavelength(f"ahi9.B{b:02d}") for b in (1, 2, 3, 4)]
    assert eff == pytest.approx([470.5, 509.7, 638.4, 856.3], abs=1.0)


def test_geometry_weights_cover_the_visible_cap():
    """Σ dA·μ∞/(πR²) over the pixels equals the projected area of the cap the satellite sees (sphere: 1 − (R/h)²)."""
    seg = E.read_segment(ed.himawari_files()[0])
    sun, _ = E.sun_direction(0.5 * (seg.t_start_mjd + seg.t_end_mjd), seg.sub_lon)
    tot = 0.0
    for s in range(10):
        for r0 in range(0, 1100, 275):
            g = E.geometry(seg, sun, s * 1100 + 1 + r0, 275)
            tot += float(np.nansum(g["w"]))
    assert tot == pytest.approx(1 - (6371.0 / 42164.0) ** 2, abs=0.003)


def test_disk_reflectance(disk):
    assert 1.5 < disk["alpha_deg"] < 3.5 and disk["phase_max"] < 13
    a = [disk["bands"][str(b)]["A"] for b in (1, 2, 3, 4)]
    assert 0.25 < a[0] < 0.35 and a[0] > a[1] > a[2]          # Rayleigh-blue Earth
    for b in (1, 2, 3, 4):
        d = disk["bands"][str(b)]
        assert d["missing_px"] == 0 and d["annulus_fraction_of_A"] < 0.03


def test_spectrum_reproduces_bands_and_is_blue(disk):
    spec = albedo.spectrum_for(399)
    for b in (1, 2, 3, 4):
        assert filters.band_average(f"ahi9.B{b:02d}", spec.wl, spec.p) == pytest.approx(disk["bands"][str(b)]["A"],
                                                                                        rel=1e-6)
    assert 0.2 < filters.band_average("V", spec.wl, spec.p) < 0.3
    assert spec.label == "estimated"


def test_epoxi_independent_check():
    """EPOXI (2008-2009, 57-86° phase, 24-hour means) against the product's p·Φ: within ±20 % where the aperture
    fits the frame; the violet/green colour ratio agrees with the product's blue extension within 10 %."""
    chk = {c["epoch"]: c for c in E.epoxi_check()}
    for ep in ("2008-03", "2008-06"):
        assert chk[ep]["aperture_inside_frame"] and 0.8 < chk[ep]["ratio"] < 1.2, chk[ep]
    ep = E.epoxi_disk()
    spec = albedo.spectrum_for(399)
    ours = (filters.band_average("hriv.Violet", spec.wl, spec.p) / filters.band_average("hriv.Green", spec.wl, spec.p))
    theirs = ep["2008-03|VIOLET"]["A_mean"] / ep["2008-03|GREEN"]["A_mean"]
    assert theirs == pytest.approx(ours, rel=0.10)
