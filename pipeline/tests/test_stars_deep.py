"""Offline checks of the deep-tier helpers: release parameter, source_id HEALPix ranges, FITS validation, band
operators and the Sternberg parser."""

from pathlib import Path

import numpy as np

from pipeline.stages import stars as _stars  # noqa: F401  (astropy import guard)
from pipeline import sky_healpix as hp
from pipeline import stars_catalogs as sc
from pipeline import stars_deep as sd
from pipeline import stars_gaia as sg
from pipeline import stars_light as sl

FIX = Path(__file__).parent / "fixtures"


def test_release_parameter_default():
    assert sg.REL.key == "dr3" and sg.REL.schema == "gaiadr3"
    assert sg.XP_WAVELENGTHS.size == 343 and sg.XP_WAVELENGTHS[0] == 336.0 and sg.XP_WAVELENGTHS[-1] == 1020.0
    assert sg.SUBDIR == "stars/gaia_dr3" and sg.XP_SUBDIR == "stars/gaia_dr3_xp_sampled"
    assert "/gdr3/" in sg.XP_BASE


def test_source_id_ranges_nest():
    lo, hi = sg.healpix_source_id_range(2, 100)
    assert lo >> 35 == 100 * 4 ** 10 and (hi - 1) >> 35 == 101 * 4 ** 10 - 1
    lo1, hi1 = sg.healpix_source_id_range(1, 25)
    assert lo1 <= lo and hi <= hi1                     # level-2 pixel 100 is a child of level-1 pixel 25
    # the deep tiles use source_id >> 53 = level-3 pixel
    assert (lo >> 53) == 100 * 4 and ((hi - 1) >> 53) == 100 * 4 + 3


def test_fits_validation(tmp_path):
    from astropy.io import fits
    t = fits.BinTableHDU.from_columns([fits.Column(name="source_id", format="K", array=np.arange(1000)),
                                       fits.Column(name="g", format="E", array=np.ones(1000))])
    p = tmp_path / "ok.fits"
    fits.HDUList([fits.PrimaryHDU(), t]).writeto(p)
    assert sg._fits_table_ok(p)
    cut = tmp_path / "cut.fits"
    cut.write_bytes(p.read_bytes()[:-3000])
    assert not sg._fits_table_ok(cut)
    bad = tmp_path / "err.fits"
    bad.write_text("<?xml version='1.0'?><VOTABLE><INFO name='QUERY_STATUS' value='ERROR'/></VOTABLE>")
    assert not sg._fits_table_ok(bad)


def test_band_operator_linear_function():
    wl = sg.XP_WAVELENGTHS
    w = sl.band_operator(wl, 395.7, 478.3)
    assert np.isclose(w.sum(), 1.0)
    f = 2.0 + 0.01 * wl
    assert np.isclose(f @ w, 2.0 + 0.01 * 437.0, rtol=1e-6)


def test_xp_operator_shape():
    W, cover = sd.xp_operator()
    assert W.shape == (343, 6) and cover.sum() == (830 - 360) // 2 + 1
    # a flat spectrum of 1 W m^-2 nm^-1 has band means of 1
    assert np.allclose(np.ones(343) @ W[:, 4:], 1.0)


def test_sternberg_parser_aldebaran():
    blue = sc.parse_sternberg_fluxes((FIX / "sternberg_iii208_aldebaran.txt").read_text().splitlines(), 89)[0]
    red = sc.parse_sternberg_fluxes((FIX / "sternberg_iii207_aldebaran.txt").read_text().splitlines(), 98)[0]
    # III/208: the first two (322.5, 327.5 nm) and last two (757.5, 762.5 nm) samples are written with exponent
    # E-12 = no flux
    assert np.isnan(blue[:2]).all() and np.isnan(blue[-2:]).all() and np.isfinite(blue[2:-2]).all()
    # III/207: 0.E+00 for the first seven samples (597.5-627.5 nm)
    assert np.isnan(red[:7]).all() and np.isfinite(red[7:47]).all()    # 632.5-832.5 nm present
    # both in W m^-2 nm^-1; Aldebaran (V = 0.85) near 550 nm ~ 2e-11 W m^-2 nm^-1
    i550 = int((547.5 - 322.5) / 5)
    assert 1e-11 < blue[i550] < 3e-11
    q = red[7:34] / blue[62:89]
    assert abs(np.nanmedian(q) - 1) < 0.1


def test_tile_pixel_of_source_id_matches_position():
    # a source_id built from the level-12 pixel of a position must land in the tile of that position
    rng = np.random.default_rng(3)
    u = rng.normal(size=(1000, 3))
    p12 = hp.vec2pix(12, u)
    sid = (p12.astype(np.int64) << 35) + 12345
    assert ((sid >> 53) == hp.vec2pix(3, u)).all()
