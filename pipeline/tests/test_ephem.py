"""Planetary ephemeris product vs the kernel. Requires `python -m pipeline build --only ephemeris`.

Every extracted segment of the planetary kernel (de442s) is bit-identical to the kernel and reproduces SPICE spkgeo
to < 1 mm. Satellite products: test_ephem_satellites.py.
"""

import json

import numpy as np
import pytest
import spiceypy as sp

from pipeline.ephem_kernels import PLANETARY, SRC_PLANETARY, planetary
from pipeline.ephem_spk import evaluate, load_product, read_spk, restrict
from pipeline.paths import OUT
from pipeline.stages.ephemeris import MARGIN_S

DE = OUT / "ephem" / f"{PLANETARY}.json"
pytestmark = pytest.mark.skipif(not DE.exists(), reason="ephemeris products not built")


@pytest.fixture(scope="module")
def window():
    w = json.loads((OUT / "manifest.json").read_text())["window"]
    return w["startEt"] - MARGIN_S, w["endEt"] + MARGIN_S


@pytest.fixture(scope="module")
def kernel():
    path = planetary()
    sp.furnsh(str(path))
    yield path
    sp.unload(str(path))


def test_all_segments_extracted_bit_identical(kernel, window):
    ours = {(s.target, s.center): s for s in load_product(DE)}
    theirs = {(s.target, s.center): s for s in read_spk(kernel)}
    assert set(ours) == set(theirs) and len(ours) == 14
    for k, s in ours.items():
        ref = restrict(theirs[k], *window)
        assert (s.init, s.intlen, s.rsize, s.n) == (ref.init, ref.intlen, ref.rsize, ref.n)
        assert (s.start, s.end) == (ref.start, ref.end)  # declared coverage carried through
        assert np.array_equal(s.records, ref.records), k
        assert s.start <= window[0] and s.end >= window[1], f"{k} does not cover the window + margin"
        assert s.label == "measured" and s.sources == [SRC_PLANETARY]


def test_every_segment_matches_spkgeo(kernel, window):
    rng = np.random.default_rng(440)
    worst_p, worst_v = 0.0, 0.0
    for s in load_product(DE):
        et = rng.uniform(*window, 400)
        # record boundaries inside the window (where SPICE switches records)
        b = s.init + s.intlen * np.arange(s.n + 1)
        et = np.concatenate([et, b[(b >= window[0]) & (b <= window[1])], [s.start, s.end]])
        pos, vel = evaluate(s, et)
        ref = np.array([sp.spkgeo(s.target, e, "J2000", s.center)[0] for e in et])
        dp = np.linalg.norm(pos - ref[:, :3], axis=1).max()
        dv = np.linalg.norm(vel - ref[:, 3:], axis=1).max()
        worst_p, worst_v = max(worst_p, dp), max(worst_v, dv)
        assert dp < 1e-6, (s.target, s.center, dp)   # 1 mm
        assert dv < 1e-9, (s.target, s.center, dv)   # 1 um/s
    print(f"{PLANETARY} vs spkgeo: max |dpos| = {worst_p:.3e} km, max |dvel| = {worst_v:.3e} km/s")


def test_chain_reaches_ssb():
    targets = {}
    for p in [DE, *sorted((OUT / "ephem").glob("sat-*.json"))]:
        for s in load_product(p):
            assert s.target not in targets, f"{s.target} served twice"
            targets[s.target] = s.center
    for body in [10, 199, 299, 399, 301, 499, 599, 699, 799, 899, 999] + [t for t in targets if t > 400]:
        node, hops = body, 0
        while node != 0:
            node = targets[node]
            hops += 1
            assert hops < 5
