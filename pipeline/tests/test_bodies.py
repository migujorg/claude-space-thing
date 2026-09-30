"""bodies.json vs the NAIF kernels it was read from, and its rotation models vs SPICE pxform.

Requires `python -m pipeline build --only ephemeris,bodies`.
"""

import json
import math

import numpy as np
import pytest
import spiceypy as sp

from pipeline.ephem_kernels import PLANETARY, SRC_GM, SRC_PCK, gd, gm, pck, pool
from pipeline.paths import OUT

BODIES = OUT / "bodies.json"
pytestmark = pytest.mark.skipif(not BODIES.exists(), reason="bodies.json not built")

EXPECTED = {10: ("Sun", "star"), 199: ("Mercury", "planet"), 299: ("Venus", "planet"), 399: ("Earth", "planet"),
            301: ("Moon", "moon"), 499: ("Mars", "planet"), 599: ("Jupiter", "planet"), 699: ("Saturn", "planet"),
            799: ("Uranus", "planet"), 899: ("Neptune", "planet"), 999: ("Pluto", "dwarf-planet")}
FRAMES = {10: "IAU_SUN", 199: "IAU_MERCURY", 299: "IAU_VENUS", 399: "IAU_EARTH", 301: "IAU_MOON", 499: "IAU_MARS",
          599: "IAU_JUPITER", 699: "IAU_SATURN", 799: "IAU_URANUS", 899: "IAU_NEPTUNE", 999: "IAU_PLUTO"}


@pytest.fixture(scope="module")
def bodies():
    return {b["id"]: b for b in json.loads(BODIES.read_text())}


@pytest.fixture(scope="module")
def kernels():
    paths = (pck(), gm())
    with pool(*paths):
        yield paths


def test_body_list(bodies):
    assert {i: (b["name"], b["kind"]) for i, b in bodies.items()} == EXPECTED
    assert bodies[301]["parent"] == 399
    assert "photometry" not in bodies[399]
    manifest = json.loads((OUT / "manifest.json").read_text())["products"]
    for b in bodies.values():
        assert b["ephemeris"] == b["ephemerisFiles"][0]
        for f in b["ephemerisFiles"]:
            assert f"{f}.json" in manifest and f"{f}.bin" in manifest
    assert bodies[599]["ephemerisFiles"] == ["ephem/centers", f"ephem/{PLANETARY}"]
    assert bodies[301]["ephemerisFiles"] == [f"ephem/{PLANETARY}"]


def test_values_are_the_kernel_values(bodies, kernels):
    sources = {s["id"] for s in json.loads((OUT / "sources.json").read_text())}
    assert {SRC_PCK, SRC_GM} <= sources
    for i, b in bodies.items():
        assert b["radii"] == {**b["radii"], "value": gd(f"BODY{i}_RADII"), "label": "measured", "sources": [SRC_PCK]}
        assert b["gm"]["value"] == gd(f"BODY{i}_GM")[0] and b["gm"]["sources"] == [SRC_GM]
        r = b["rotation"]["value"]
        assert b["rotation"]["label"] == "measured"
        assert r["poleRa"] == gd(f"BODY{i}_POLE_RA") and r["poleDec"] == gd(f"BODY{i}_POLE_DEC")
        assert r["pm"] == gd(f"BODY{i}_PM")
        for k, s in (("nutPrecRa", "RA"), ("nutPrecDec", "DEC"), ("nutPrecPm", "PM")):
            assert r.get(k) == gd(f"BODY{i}_NUT_PREC_{s}")
        if "nutPrecAngles" in r:
            assert r["nutPrecAngles"] == gd(f"BODY{i // 100}_NUT_PREC_ANGLES")
    assert bodies[499]["rotation"]["value"]["nutPrecAnglesDegree"] == 2  # Mars: quadratic phase angles
    assert "150 arcsec" in bodies[399]["rotation"]["uncertainty"]


def body_to_icrf(r: dict, et: float) -> np.ndarray:
    """Independent Python statement of the model documented in bodies.json `rotation.method`."""
    d = et / 86400.0
    t = d / 36525.0
    ra = sum(c * t**k for k, c in enumerate(r["poleRa"]))
    dec = sum(c * t**k for k, c in enumerate(r["poleDec"]))
    w = sum(c * d**k for k, c in enumerate(r["pm"]))
    stride = r.get("nutPrecAnglesDegree", 1) + 1
    ang = r.get("nutPrecAngles", [])
    for key, fn in (("nutPrecRa", "ra"), ("nutPrecDec", "dec"), ("nutPrecPm", "w")):
        for i, c in enumerate(r.get(key, [])):
            th = math.radians(sum(ang[i * stride + k] * t**k for k in range(stride)))
            if fn == "ra":
                ra += c * math.sin(th)
            elif fn == "dec":
                dec += c * math.cos(th)
            else:
                w += c * math.sin(th)
    m = sp.eul2m(math.radians(w % 360.0), math.pi / 2 - math.radians(dec), math.pi / 2 + math.radians(ra), 3, 1, 3)
    return np.array(m).T


def test_rotation_matches_pxform(bodies, kernels):
    rng = np.random.default_rng(11)
    epochs = rng.uniform(-3.2e9, 3.2e9, 150)  # 1900-2100
    worst = {}
    for i, b in bodies.items():
        r = b["rotation"]["value"]
        err = max(np.abs(body_to_icrf(r, e) - np.array(sp.pxform(FRAMES[i], "J2000", e))).max() for e in epochs)
        worst[FRAMES[i]] = err
        assert err < 1e-9, (FRAMES[i], err)
    print("max |M - pxform|: " + ", ".join(f"{k} {v:.1e}" for k, v in worst.items()))
