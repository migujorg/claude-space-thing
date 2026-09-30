"""Ephemeris products vs their raw data. Requires `python -m pipeline build --only ephemeris`.

- planetary (de442s): every extracted segment is bit-identical to the kernel and reproduces SPICE spkgeo to < 1 mm.
- centers: the fitted records reproduce every raw Horizons state (fitted and hold-out epochs) to < 1 km
  (the contract), with the actual maxima printed.
"""

import json

import numpy as np
import pytest
import spiceypy as sp

from pipeline import download
from pipeline import ephem_horizons as hz
from pipeline.ephem_kernels import PLANETARY, SRC_PLANETARY, planetary
from pipeline.ephem_spk import evaluate, load_product, read_spk, restrict
from pipeline.paths import OUT, RAW
from pipeline.stages.ephemeris import CENTERS, HOLDOUT_OFFSET_MIN, HOLDOUT_STEP_MIN, MARGIN_S, STEP_MIN, center_source_id

DE, CEN = OUT / "ephem" / f"{PLANETARY}.json", OUT / "ephem" / "centers.json"
pytestmark = pytest.mark.skipif(not (DE.exists() and CEN.exists()), reason="ephemeris products not built")


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


@pytest.fixture(scope="module")
def sources():
    return {s["id"]: s for s in json.loads((OUT / "sources.json").read_text())}


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


def _raw(tgt, ctr, seg, suffix):
    jd_a = hz.et_to_jd(seg.init)
    jd_b = hz.et_to_jd(seg.end)
    return RAW / "horizons" / "centers" / f"{tgt}_wrt_{ctr}_JD{jd_a:.1f}-{jd_b:.1f}_{suffix}.txt"


@pytest.mark.parametrize("tgt,ctr,name", CENTERS)
def test_center_fit_reproduces_horizons(tgt, ctr, name, window, sources):
    seg = {s.target: s for s in load_product(CEN)}[tgt]
    assert seg.center == ctr and seg.type == 2 and seg.label == "derived"
    assert seg.start <= window[0] and seg.end >= window[1]
    assert seg.sources == [center_source_id(tgt)] and "hold-out" in seg.uncertainty
    rec = sources[center_source_id(tgt)]
    fit_path = _raw(tgt, ctr, seg, f"{STEP_MIN}m")
    ho_path = _raw(tgt, ctr, seg, f"{HOLDOUT_STEP_MIN}m+{HOLDOUT_OFFSET_MIN}")
    assert rec["sha256"] == download.sha256_file(fit_path)
    for path, kind in ((fit_path, "fitted"), (ho_path, "hold-out")):
        t = hz.parse_vectors(path.read_text())
        et = seg.init + np.round((t.et - seg.init) / 60.0) * 60.0
        pos, vel = evaluate(seg, et)
        dp = np.linalg.norm(pos - t.states[:, :3], axis=1).max()
        dv = np.linalg.norm(vel - t.states[:, 3:], axis=1).max()
        print(f"{tgt} wrt {ctr} {kind}: {et.size} epochs, max |dpos| {dp:.3e} km, max |dvel| {dv:.3e} km/s")
        assert dp < 1.0          # contract: < 1 km
        assert dv < 1e-3


def test_chain_reaches_ssb():
    targets = {s.target: s.center for s in load_product(DE) + load_product(CEN)}
    for body in (10, 199, 299, 399, 301, 499, 599, 699, 799, 899, 999):
        node, hops = body, 0
        while node != 0:
            node = targets[node]
            hops += 1
            assert hops < 5
