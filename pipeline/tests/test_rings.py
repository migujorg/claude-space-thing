"""rings.json (photometry/rings.py): schema shape, provenance, and the profiles' well-known structure."""

import numpy as np
import pytest

from pipeline.photometry import rings
from pipeline.schema import LABEL_ORDER, BuildContext


@pytest.fixture(scope="module")
def built():
    ctx = BuildContext(0.0, 1.0)
    out, diag = rings.rings_json(ctx)
    return ctx, out, diag


def test_schema_shape(built):
    ctx, out, _ = built
    assert set(out) == {"599", "699", "799", "899"}
    for key, sysm in out.items():
        assert set(sysm) == {"planet", "opticalDepth", "reflectance"} and sysm["planet"] == int(key)
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


def test_uranus_and_neptune(built):
    _, _, d = built
    assert np.max(_tau(d, "799", 51400, 51700)) > 0.5                  # the ε ring (near apoapse in this cut)
    assert np.median(_tau(d, "799", 38000, 41000)) < 0.05              # inside ring 6
    assert np.max(np.abs(_tau(d, "899", 42500, 76000))) < 0.2          # Neptune's faint rings
