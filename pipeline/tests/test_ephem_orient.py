"""Precise orientation products (orient/earth, orient/moon) vs SPICE pxform with NAIF's PCKs.

Requires `python -m pipeline build --only ephemeris,bodies`.
"""

import json

import numpy as np
import pytest
import spiceypy as sp

from pipeline.ephem_orient import body_to_j2000
from pipeline.paths import OUT, RAW
from pipeline.stages.ephemeris import MARGIN_S

EARTH, MOON = OUT / "orient" / "earth.json", OUT / "orient" / "moon.json"
pytestmark = pytest.mark.skipif(not (EARTH.exists() and MOON.exists()), reason="orientation products not built")


def _load(p):
    h = json.loads(p.read_text(encoding="utf-8"))
    return h, np.fromfile(OUT / h["bin"], dtype="<f8")


def coverage(header) -> tuple[float, float]:
    """The product's actual coverage (its segments are contiguous; checked below)."""
    return min(s["startEt"] for s in header["segments"]), max(s["endEt"] for s in header["segments"])


@pytest.fixture(scope="module")
def kernels():
    pck = RAW / "naif" / "pck"
    ks = [sorted(pck.glob("earth_*_predict.bpc"))[-1], sorted(pck.glob("earth_000101_*.bpc"))[-1],
          pck / "moon_pa_de440_200625.bpc", RAW / "naif" / "fk-satellites" / "moon_de440_250416.tf"]
    for k in ks:  # high-precision after the predict file: it takes priority, as in orient/earth
        sp.furnsh(str(k))
    yield ks
    for k in ks:
        sp.unload(str(k))


def test_matches_pxform_over_the_window(kernels):
    for p, body, frame in ((EARTH, 399, "ITRF93"), (MOON, 301, "MOON_ME_DE440_ME421")):
        h, d = _load(p)
        ets = np.random.default_rng(9).uniform(*coverage(h), 500)
        worst = max(np.abs(body_to_j2000(h, d, body, e) - np.array(sp.pxform(frame, "J2000", e))).max() for e in ets)
        print(f"{frame}: max |M - pxform| = {worst:.2e} over {ets.size} epochs")
        assert worst < 1e-12


def test_coverage_and_labels():
    w = json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))["window"]
    h, _ = _load(EARTH)
    segs = sorted(h["segments"], key=lambda s: s["startEt"])
    assert segs[0]["startEt"] <= w["startEt"] - MARGIN_S and segs[-1]["endEt"] >= w["endEt"] + MARGIN_S
    for a, b in zip(segs, segs[1:]):
        assert abs(a["endEt"] - b["startEt"]) < 1e-3, "gap or overlap in Earth orientation coverage"
    labels = [s["label"] for s in segs]
    assert labels == sorted(labels, key=["measured", "estimated"].index), "measured must precede estimated"
    assert labels[0] == "measured" and labels[-1] == "estimated"
    assert {"naif-earth-pck-high-prec", "naif-earth-pck-predict"} == {x for s in segs for x in s["sources"]}
    m, _ = _load(MOON)
    assert all(s["label"] == "measured" for s in m["segments"])
    assert m["bodies"]["301"]["frame"] == "MOON_ME_DE440_ME421"
