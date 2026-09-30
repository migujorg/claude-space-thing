"""Epoch propagation: against astropy's independent implementation, and the built catalogue against SIMBAD."""

import json
from pathlib import Path

import numpy as np
import pytest

from pipeline.stages import stars as _stage  # noqa: F401  (imports astropy safely; see stars._import_astropy)
from pipeline import stars_astrometry as sa
from pipeline import stars_format as sf
from pipeline.paths import OUT

FIX = json.loads((Path(__file__).parent / "fixtures" / "simbad_stars.json").read_text(encoding="utf-8"))


def _astropy_propagate(ra, dec, pmra, pmdec, plx, rv, ep0, ep1):
    import astropy.units as u
    from astropy.coordinates import SkyCoord, Distance
    from astropy.time import Time
    c = SkyCoord(ra=ra * u.deg, dec=dec * u.deg, distance=Distance(parallax=plx * u.mas),
                 pm_ra_cosdec=pmra * u.mas / u.yr, pm_dec=pmdec * u.mas / u.yr, radial_velocity=rv * u.km / u.s,
                 obstime=Time(ep0, format="jyear", scale="tdb"), frame="icrs")
    c1 = c.apply_space_motion(new_obstime=Time(ep1, format="jyear", scale="tdb"))
    return sa.radec_to_unit(c1.ra.deg, c1.dec.deg)


def test_matches_astropy_for_fast_nearby_stars():
    # Barnard's star and 61 Cyg A (SIMBAD values): largest proper motions and perspective acceleration.
    for s in FIX["stars"]:
        if s["main_id"] not in ("NAME Barnard's star", "*  61 Cyg A", "* alf Cen A"):
            continue
        for ep1, tol_mas in ((1991.25, 0.1), (2016.0, 0.1), (2026.75, 0.1), (2100.0, 2.0)):
            ours = sa.propagate(s["ra"], s["dec"], s["pmra"], s["pmdec"], 2000.0, ep1, s["plx_value"], s["rvz_radvel"])
            ref = _astropy_propagate(s["ra"], s["dec"], s["pmra"], s["pmdec"], s["plx_value"], s["rvz_radvel"],
                                     2000.0, ep1)
            assert sa.separation_arcsec(ours, ref) * 1e3 < tol_mas, (s["main_id"], ep1)


def test_identity_and_units():
    u = sa.propagate(10.0, 20.0, 0.0, 0.0, 2016.0, 2030.0)
    assert sa.separation_arcsec(u, sa.radec_to_unit(10.0, 20.0)) < 1e-9
    # 1000 mas/yr in dec for 10 yr moves the star 10 arcsec
    u = sa.propagate(10.0, 20.0, 0.0, 1000.0, 2016.0, 2026.0)
    assert abs(sa.separation_arcsec(u, sa.radec_to_unit(10.0, 20.0)) - 10.0) < 1e-6
    assert abs(sa.et_to_jyear(0.0) - 2000.0) < 1e-12


@pytest.mark.skipif(not (OUT / "stars" / "bright.json").exists(), reason="stars product not built")
def test_catalogue_positions_vs_simbad():
    h, cols = sf.read_table(OUT / "stars" / "bright.json")
    epoch = sa.et_to_jyear(h["epochEt"])
    hip = cols["hip"]
    checked = 0
    for s in FIX["stars"]:
        if not s["hip"]:
            continue
        k = np.nonzero(hip == int(s["hip"].split()[1]))[0]
        assert k.size == 1, s["main_id"]
        ref = _astropy_propagate(s["ra"], s["dec"], s["pmra"], s["pmdec"], s["plx_value"] or 1e-3,
                                 s["rvz_radvel"] or 0.0, 2000.0, epoch)
        sep = sa.separation_arcsec(cols["dir"][k[0]].astype(np.float64), ref)
        assert sep < 1.0, (s["main_id"], sep)
        checked += 1
    assert checked >= 12
