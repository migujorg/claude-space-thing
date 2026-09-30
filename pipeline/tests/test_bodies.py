"""bodies.json vs the NAIF kernels it was read from, and its rotation models vs SPICE pxform.

Requires `python -m pipeline build --only ephemeris,bodies`.
"""

import json
import math

import numpy as np
import pytest
import spiceypy as sp
from spiceypy.utils.exceptions import SpiceyError

from pipeline import ephem_satellites as sat
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
    return {b["id"]: b for b in json.loads(BODIES.read_text(encoding="utf-8"))}


@pytest.fixture(scope="module")
def kernels():
    paths = (pck(), gm(), *sat.nameid_fks())
    with pool(*paths):
        yield paths


def test_body_list(bodies):
    assert {i: (b["name"], b["kind"]) for i, b in bodies.items() if i in EXPECTED} == EXPECTED
    assert bodies[301]["parent"] == 399
    assert "photometry" not in bodies[399]
    manifest = json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))["products"]
    for b in bodies.values():
        assert b["ephemeris"] == b["ephemerisFiles"][0]
        for f in b["ephemerisFiles"]:
            assert f"{f}.json" in manifest and f"{f}.bin" in manifest
    for planet in (499, 599, 699, 799, 899, 999):  # placeable before the moon systems load
        assert bodies[planet]["ephemerisFiles"] == ["ephem/centers", f"ephem/{PLANETARY}"]
    assert bodies[501]["ephemerisFiles"] == ["ephem/sat-jup", f"ephem/{PLANETARY}"]
    assert bodies[65304]["ephemerisFiles"] == ["ephem/sat-sat", "ephem/centers", f"ephem/{PLANETARY}"]
    assert bodies[301]["ephemerisFiles"] == [f"ephem/{PLANETARY}"]
    assert bodies[399]["orientation"] == "orient/earth" and bodies[301]["orientation"] == "orient/moon"


def test_every_moon_in_the_satellite_products_is_a_body(bodies):
    targets = {s["target"]: (p.stem, s["center"]) for p in (OUT / "ephem").glob("sat-*.json")
               for s in json.loads(p.read_text(encoding="utf-8"))["segments"]}
    moons = {t for t in targets if t not in (499, 599, 699, 799, 899, 999)}
    assert moons == {i for i, b in bodies.items() if b["kind"] == "moon" and i != 301}
    for i in moons:
        b = bodies[i]
        product, center = targets[i]
        assert b["parent"] == (100 * center + 99 if center < 10 else center)
        assert b["ephemeris"] == f"ephem/{product}" and b["name"] and not b["name"].startswith("NAIF")
    names = {bodies[i]["name"] for i in (501, 606, 801, 901, 705, 65304, 55527)}
    assert names == {"Io", "Titan", "Triton", "Charon", "Miranda", "S/2009 S 2", "S/2011 J 4"}
    print(f"{len(moons)} moons besides the Moon")


def test_values_are_the_kernel_values(bodies, kernels):
    sources = {s["id"] for s in json.loads((OUT / "sources.json").read_text(encoding="utf-8"))}
    assert {SRC_PCK, SRC_GM} <= sources
    counts = {"radii": 0, "gm": 0, "rotation": 0}
    for i, b in bodies.items():
        radii = gd(f"BODY{i}_RADII")
        if radii and len(radii) == 3:
            assert b["radii"]["value"] == radii and b["radii"]["label"] == "measured" and b["radii"]["sources"] == [SRC_PCK]
            counts["radii"] += 1
        else:
            assert b["radii"]["label"] == "unknown" and b["radii"]["value"] is None
        g = gd(f"BODY{i}_GM")
        if g and g[0] > 0:
            assert b["gm"]["value"] == g[0] and b["gm"]["sources"] == [SRC_GM]
        elif b["gm"]["label"] != "unknown":
            assert b["gm"]["sources"][0].startswith("naif-") and b["gm"]["value"] > 0  # published in a satellite kernel
        if b["gm"]["label"] != "unknown":
            counts["gm"] += 1
        r = b["rotation"]["value"]
        if gd(f"BODY{i}_PM") is None:
            assert b["rotation"]["label"] == "unknown" and r is None  # never assumed synchronous
            continue
        counts["rotation"] += 1
        assert b["rotation"]["label"] == "measured"
        assert r["poleRa"] == gd(f"BODY{i}_POLE_RA") and r["poleDec"] == gd(f"BODY{i}_POLE_DEC")
        assert r["pm"] == gd(f"BODY{i}_PM")
        for k, s in (("nutPrecRa", "RA"), ("nutPrecDec", "DEC"), ("nutPrecPm", "PM")):
            assert r.get(k) == gd(f"BODY{i}_NUT_PREC_{s}")
        if "nutPrecAngles" in r:
            assert r["nutPrecAngles"] == gd(f"BODY{i // 100}_NUT_PREC_ANGLES")
    assert bodies[499]["rotation"]["value"]["nutPrecAnglesDegree"] == 2  # Mars: quadratic phase angles
    assert "150 arcsec" in bodies[399]["rotation"]["uncertainty"]
    print(f"known values: {counts} of {len(bodies)} bodies")


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
    epochs = rng.uniform(-3.2e9, 3.2e9, 60)  # 1900-2100
    worst, checked = {}, 0
    for i, b in bodies.items():
        if b["rotation"]["label"] == "unknown":
            continue
        frame = FRAMES.get(i) or f"IAU_{sp.bodc2n(i)}"
        try:
            sp.pxform(frame, "J2000", 0.0)
        except SpiceyError:
            continue  # SPICE has no built-in IAU frame for this body
        r = b["rotation"]["value"]
        err = max(np.abs(body_to_icrf(r, e) - np.array(sp.pxform(frame, "J2000", e))).max() for e in epochs)
        worst[frame] = err
        checked += 1
        assert err < 1e-9, (frame, err)
    print(f"{checked} IAU frames vs pxform; worst {max(worst, key=worst.get)} {max(worst.values()):.1e}")
    assert checked >= 50
