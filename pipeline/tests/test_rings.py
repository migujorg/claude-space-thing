"""rings.json (photometry/rings.py): schema shape, provenance, and the profiles' well-known structure."""

import numpy as np
import pytest

from pipeline.photometry import rings
from pipeline.schema import LABEL_ORDER, BuildContext
from pipeline.paths import RAW


def _archived(pair):
    paths = [RAW / dl.subdir / dl.name for dl in pair]
    for path in paths:
        if not path.is_file():
            pytest.skip(f"archived ring input absent: {path}; offline comparison needs the raw file")
    return np.loadtxt(paths[1], delimiter=",")


@pytest.fixture
def profile_product(monkeypatch):
    # Isolate the occultation products from unrelated component-table downloads.
    from pipeline.photometry import rings_jupiter, rings_neptune, rings_uranus
    for module in (rings_jupiter, rings_neptune, rings_uranus):
        monkeypatch.setattr(module, "build", lambda *args: ({"model": {}, "label": "estimated", "sources": []}, {}))
    return rings.rings_json(None)[0]


def test_saturn_measured_product_is_archive_bin_for_bin(profile_product):
    d = _archived(rings.UVIS)
    measured = profile_product["699"]["opticalDepth"]
    missing = (d[:, 4] == -1) | ((d[:, 11].astype(int) & 64) != 0)
    expected = [None if m else float(t) for t, m in zip(d[:, 4], missing)]
    assert measured["label"] == "measured"
    assert measured["value"][0]["normalTau"] == expected


def test_saturn_estimate_product_is_cleaner_output(profile_product):
    d = _archived(rings.UVIS)
    meta = rings._label(rings.UVIS[0])
    mu = abs(np.sin(np.deg2rad(float(meta["OBSERVED_RING_ELEVATION"]))))
    sigma = rings.photon_sigma(d[:, 3], d[:, 9], d[:, 8], d[:, 10], mu)
    missing = (d[:, 4] == -1) | ((d[:, 11].astype(int) & 64) != 0)
    cleaned, _ = rings.clean_saturn_tau(d[:, 0], np.where(missing, np.nan, d[:, 4]), sigma)
    estimate = profile_product["699"]["opticalDepthEstimate"]
    assert estimate["label"] == "estimated"
    assert estimate["sources"] == profile_product["699"]["opticalDepth"]["sources"]
    assert estimate["value"][0]["normalTau"] == [None if m else round(float(t), 4) for t, m in zip(cleaned, missing)]


def test_neptune_unconstrained_product_bins_are_null(profile_product):
    d = _archived(rings.VG_NEPTUNE)
    missing = (d[:, 1] == 0) | (d[:, 4] == -9)
    assert missing.sum() == 40
    assert d[missing, 0][[0, -1]].tolist() == [51200.0, 51395.0]
    tau = profile_product["899"]["opticalDepth"]["value"][0]["normalTau"]
    assert tau == [None if m else float(t) for t, m in zip(d[:, 3], missing)]


def test_uranus_product_remains_archive_bin_for_bin(profile_product):
    d = _archived(rings.VG_URANUS)
    measured = profile_product["799"]["opticalDepth"]
    assert measured["label"] == "measured"
    assert measured["value"][0]["normalTau"] == d[:, 3].tolist()


@pytest.fixture(scope="module")
def built():
    ctx = BuildContext(0.0, 1.0)
    out, diag = rings.rings_json(ctx)
    return ctx, out, diag


def test_schema_shape(built):
    ctx, out, _ = built
    assert set(out) == {"599", "699", "799", "899"}
    for key, sysm in out.items():
        assert {"planet", "opticalDepth", "reflectance"} <= set(sysm) and sysm["planet"] == int(key)
        for s in (sysm["opticalDepth"], sysm["reflectance"]):
            assert s["label"] in LABEL_ORDER and (s["value"] is None) == (s["label"] == "unknown") and s["method"]
            assert all(sid in ctx.sources for sid in s["sources"])
        if sysm["opticalDepth"]["value"] is None:
            continue
        for prof in sysm["opticalDepth"]["value"]:
            r = np.array(prof["radiusKm"])
            assert len(prof["normalTau"]) == r.size > 1000 and np.all(np.diff(r) > 0)
            if "maxTau" in prof:
                assert len(prof["maxTau"]) == r.size
            ob = prof["observation"]
            assert {"instrument", "star", "direction", "start", "stop", "wavelengthNm", "ringElevationDeg"} <= set(ob)
    for rec in ctx.sources.values():
        assert len(rec.sha256 or "") == 64, rec.id


def _tau(diag, planet, lo, hi):
    p = diag[planet]
    m = (p.radius >= lo) & (p.radius <= hi)
    return p.tau[m]


def test_saturn_structure(built):
    """Broad features every occultation shows (regression bounds, not a calibration): an
    optically thin C ring, a thick B ring, a nearly empty Cassini Division and Encke Gap, an A ring of τ ~ 0.5."""
    _, _, d = built
    assert np.nanmedian(_tau(d, "699", 75000, 90000)) < 0.3            # C ring
    assert np.nanmedian(_tau(d, "699", 100000, 117000)) > 1.5          # B ring core
    assert np.nanmedian(_tau(d, "699", 118500, 119800)) < 0.3          # Cassini Division
    assert 0.3 < np.nanmedian(_tau(d, "699", 123000, 133000)) < 1.2     # A ring
    assert np.nanmin(_tau(d, "699", 133450, 133750)) < 0.05            # Encke Gap
    assert np.nanmax(_tau(d, "699", 145000, 151000)) < 0.1             # beyond the F ring


def test_saturn_bins_consistent_with_zero_are_zero():
    """Regression of the existing estimated reconstruction, not proof that the removed ramp is instrumental."""
    js, _, prof = rings.saturn_profile(None)
    r = np.array(js["radiusKm"])
    tau = np.array([np.nan if v is None else v for v in js["normalTau"]])
    assert np.all(tau[np.isfinite(tau)] >= 0)
    assert np.all(tau[r < 74400] == 0) and np.all(tau[r > 141000] == 0)
    f = (r > 139800) & (r < 140600)
    assert np.nanmax(tau[f]) > 0.2                                     # F ring core kept
    c = prof.cleaning
    assert 74400 < c["main_rings_km"][0] < 74600 and 136700 < c["main_rings_km"][1] < 136800
    assert c["outer_baseline_max"] > 0.05 and c["outer_residual_rms_sigma"] < 1.5 and c["inner_residual_rms_sigma"] < 1.5
    assert 0.0005 < c["outer_sigma_median"] < 0.002


def test_uranus_and_neptune(built):
    _, _, d = built
    assert np.max(_tau(d, "799", 51400, 51700)) > 0.5                  # the ε ring (near apoapse in this cut)
    assert np.median(_tau(d, "799", 38000, 41000)) < 0.05              # inside ring 6
    assert np.nanmax(np.abs(_tau(d, "899", 42500, 76000))) < 0.2       # Neptune's faint rings; unconstrained = NaN
