"""Planetary ephemeris product vs the kernel. Requires `python -m pipeline build --only ephemeris`.

Every extracted segment of the planetary kernel (de442s) is bit-identical to the kernel; type 2/3 evaluation
reproduces SPICE spkgeo bit for bit. Epochs are drawn from the products' own coverage, so the tests do not depend
on when the window was made.
Satellite products: test_ephem_satellites.py.
"""

import json

import numpy as np
import pytest
import spiceypy as sp

from pipeline.ephem_kernels import PLANETARY, SRC_PLANETARY, planetary
from pipeline.ephem_spk import evaluate, load_product, read_spk
from pipeline.paths import OUT
from pipeline.stages.ephemeris import MARGIN_S

DE = OUT / "ephem" / f"{PLANETARY}.json"
pytestmark = pytest.mark.skipif(not DE.exists(), reason="ephemeris products not built")


def coverage(segs) -> tuple[float, float]:
    """Interval every segment covers (the products' actual coverage)."""
    return max(s.start for s in segs), min(s.end for s in segs)


def same_records(s, ref) -> None:
    """s holds a contiguous run of ref's records, bit for bit, with the declared coverage clipped accordingly."""
    assert (s.type, s.intlen, s.rsize) == (ref.type, ref.intlen, ref.rsize)
    i0 = (s.init - ref.init) / s.intlen
    assert i0 == int(i0) and 0 <= i0 and int(i0) + s.n <= ref.n
    assert np.array_equal(s.records, ref.records[int(i0): int(i0) + s.n]), s.target
    assert s.start >= ref.start - 1e-3 and s.end <= ref.end + 1e-3


@pytest.fixture(scope="module")
def kernel():
    path = planetary()
    sp.furnsh(str(path))
    yield path
    sp.unload(str(path))


def test_all_segments_extracted_bit_identical(kernel):
    ours = {(s.target, s.center): s for s in load_product(DE)}
    theirs = {(s.target, s.center): s for s in read_spk(kernel)}
    assert set(ours) == set(theirs) and len(ours) == 14
    for k, s in ours.items():
        same_records(s, theirs[k])
        assert s.label == "measured" and s.sources == [SRC_PLANETARY]
    # The products cover the manifest window with the light-time margin.
    w = json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))["window"]
    lo, hi = coverage(ours.values())
    assert lo <= w["startEt"] - MARGIN_S + 1e-3 and hi >= w["endEt"] + MARGIN_S - 1e-3


def test_every_segment_matches_spkgeo(kernel):
    rng = np.random.default_rng(440)
    worst_p, worst_v = 0.0, 0.0
    segs = load_product(DE)
    lo, hi = coverage(segs)
    for s in segs:
        et = rng.uniform(lo, hi, 400)
        # record boundaries inside the coverage (where SPICE switches records)
        b = s.init + s.intlen * np.arange(s.n + 1)
        et = np.concatenate([et, b[(b >= lo) & (b <= hi)], [max(s.start, lo), min(s.end, hi)]])
        pos, vel = evaluate(s, et)
        ref = np.array([sp.spkgeo(s.target, e, "J2000", s.center)[0] for e in et])
        dp = np.linalg.norm(pos - ref[:, :3], axis=1).max()
        dv = np.linalg.norm(vel - ref[:, 3:], axis=1).max()
        worst_p, worst_v = max(worst_p, dp), max(worst_v, dv)
        assert dp < 1e-6, (s.target, s.center, dp)   # 1 mm
        assert dv < 1e-9, (s.target, s.center, dv)   # 1 um/s
        if s.type in (2, 3):
            for quantity, actual, expected in (("pos", pos, ref[:, :3]), ("vel", vel, ref[:, 3:])):
                actual_bits, expected_bits = actual.view(np.uint64), expected.view(np.uint64)
                for i, j in np.argwhere(actual_bits != expected_bits):
                    assert actual_bits[i, j] == expected_bits[i, j], (
                        f"body {s.target} wrt {s.center}, type {s.type}, et {et[i]!r}, {quantity}[{j}]: "
                        f"ours 0x{actual_bits[i, j]:016x}, SPICE 0x{expected_bits[i, j]:016x}"
                    )
    print(f"{PLANETARY} vs spkgeo: max |dpos| = {worst_p:.3e} km, max |dvel| = {worst_v:.3e} km/s")


def test_chain_reaches_ssb_and_centers_duplicates_are_identical():
    targets, seen = {}, {}
    for p in [DE, OUT / "ephem" / "centers.json", *sorted((OUT / "ephem").glob("sat-*.json"))]:
        for s in load_product(p):
            if s.target in seen:
                # Only the planet centres appear twice (ephem/centers and their sat-* file), bit-identically,
                # so whichever copy EphemerisSet serves (the last added) gives the same answer.
                d = seen[s.target]
                assert s.target in (499, 599, 699, 799, 899, 999), f"{s.target} served twice"
                assert (s.center, s.type, s.init, s.intlen, s.rsize, s.start, s.end, s.sources) == \
                       (d.center, d.type, d.init, d.intlen, d.rsize, d.start, d.end, d.sources)
                assert np.array_equal(s.records, d.records)
                continue
            seen[s.target] = s
            targets[s.target] = s.center
    assert sorted(t for t in seen if t % 100 == 99 and t < 1000) == [199, 299, 399, 499, 599, 699, 799, 899, 999]
    for body in [10, 199, 299, 399, 301, 499, 599, 699, 799, 899, 999] + [t for t in targets if t > 400]:
        node, hops = body, 0
        while node != 0:
            node = targets[node]
            hops += 1
            assert hops < 5
