"""Satellite products (ephem/sat-*.json) vs the NAIF satellite kernels.

Requires `python -m pipeline build --only ephemeris`; the excerpt-vs-original checks also need the whole originals
that `python -m pipeline.ephem_fixtures` downloads (VERIFY_ORIGINALS), and are skipped without them.
- every product segment is bit-identical to its kernel excerpt, with the declared coverage carried through;
- SPICE spkgeo on each excerpt equals our evaluator (types 2/3 exactly; type 17 to < 1 mm);
- for the kernels downloaded whole, spkgeo on the original equals spkgeo on the excerpt, exactly;
- no DE copy from a satellite kernel leaks into the products; every excerpt was byte-checked against its original.
"""

import json

import numpy as np
import pytest
import spiceypy as sp

from pipeline import download
from pipeline import ephem_satellites as sat
from pipeline.ephem_fixtures import VERIFY_ORIGINALS
from pipeline.ephem_spk import evaluate, load_product, read_spk, restrict
from pipeline.paths import OUT, RAW
from pipeline.stages.ephemeris import MARGIN_S

PRODUCTS = sorted((OUT / "ephem").glob("sat-*.json"))
pytestmark = pytest.mark.skipif(len(PRODUCTS) != len(sat.SYSTEMS), reason="satellite products not built")


@pytest.fixture(scope="module")
def window():
    w = json.loads((OUT / "manifest.json").read_text())["window"]
    return w["startEt"] - MARGIN_S, w["endEt"] + MARGIN_S


@pytest.fixture(scope="module")
def segments():
    """kernel name -> [(product, Segment)]"""
    out: dict[str, list] = {}
    for p in PRODUCTS:
        for s in load_product(p):
            out.setdefault(s.sources[0].removeprefix("naif-"), []).append((p.stem, s))
    return out


def test_products_cover_every_kernel_and_system(segments, window):
    assert set(segments) == {k.name for k in sat.KERNELS}
    for p in PRODUCTS:
        key = p.stem.removeprefix("sat-")
        bary = sat.SYSTEMS[key][0]
        segs = load_product(p)
        assert segs[0].target == 100 * bary + 99  # the planet centre first
        for s in segs:
            assert s.target not in sat.DE_IDS, f"DE copy {s.target} leaked into {p.name}"
            assert s.center in (bary, 100 * bary + 99)
            assert s.label == "measured" and s.uncertainty and s.frame == 1
            assert s.start <= window[0] + 1e-3 and s.end >= window[1] - 1e-3
    n = sum(len(v) for v in segments.values())
    print(f"{n} satellite segments ({n - 6} moons + 6 planet centres) from {len(segments)} kernels")
    assert n >= 465


@pytest.mark.parametrize("kernel", sat.KERNELS, ids=lambda k: k.name)
def test_product_is_bit_identical_to_excerpt_and_matches_spice(kernel, segments, window):
    path = sat.kernel_path(kernel, *window)
    ours = {s.target: s for _, s in segments[kernel.name]}
    theirs = {s.target: s for s in read_spk(path, set(ours))}
    assert set(theirs) == set(ours)
    rng = np.random.default_rng(17)
    worst = 0.0
    sp.furnsh(str(path))
    try:
        for t, s in ours.items():
            ref = restrict(theirs[t], *window)
            assert (s.type, s.init, s.intlen, s.rsize, s.n) == (ref.type, ref.init, ref.intlen, ref.rsize, ref.n)
            assert (s.start, s.end) == (ref.start, ref.end)
            assert np.array_equal(s.records, ref.records), t
            ets = rng.uniform(max(s.start, window[0]), min(s.end, window[1]), 20)
            pos, vel = evaluate(s, ets)
            spice = np.array([sp.spkgeo(t, e, "J2000", s.center)[0] for e in ets])
            dp = np.abs(pos - spice[:, :3]).max()
            dv = np.abs(vel - spice[:, 3:]).max()
            if s.type in (2, 3):
                assert dp == 0.0 and dv == 0.0, (t, dp, dv)  # same operation order as SPICE
            else:
                assert dp < 1e-6 and dv < 1e-9, (t, dp, dv)
            worst = max(worst, dp)
    finally:
        sp.unload(str(path))
    print(f"{kernel.name}: {len(ours)} bodies, max |ours - spkgeo| {worst:.3e} km")


@pytest.mark.parametrize("name", VERIFY_ORIGINALS)
def test_excerpt_equals_original_in_spice(name, window):
    original = RAW / "naif" / "spk-satellites-full" / f"{name}.bsp"
    if not original.exists():
        pytest.skip(f"{original.name} not downloaded (run python -m pipeline.ephem_fixtures)")
    kernel = next(k for k in sat.KERNELS if k.name == name)
    excerpt = sat.kernel_path(kernel, *window)
    targets = {s.target for s in read_spk(excerpt)}
    rng = np.random.default_rng(3)
    ets = rng.uniform(window[0], window[1], 300)
    states = {}
    for path in (original, excerpt):
        sp.furnsh(str(path))
        try:
            states[path] = np.array([[sp.spkgeo(t, e, "J2000", c)[0] for e in ets]
                                     for t, c in sorted({(s.target, s.center) for s in read_spk(excerpt)})])
        finally:
            sp.unload(str(path))
    assert np.array_equal(states[original], states[excerpt]), name
    print(f"{name}: {len(targets)} bodies x {ets.size} epochs, spkgeo(original) == spkgeo(excerpt) exactly")


def test_every_excerpt_was_checked_against_its_original(window):
    ledger = download._load_ledger()
    for k in sat.KERNELS:
        rec = ledger[str(sat.kernel_path(k, *window).relative_to(RAW))]
        assert rec["url"] == k.url
        if not k.whole:
            ex = rec["excerpt"]
            assert ex["verifiedRecords"] >= 1 and ex["originalBytes"] > rec["bytes"]
            assert ex["startEt"] <= window[0] and ex["endEt"] >= window[1]
        assert rec["sha256"] == download.sha256_file(sat.kernel_path(k, *window))


def test_sources_cite_each_kernel():
    sources = {s["id"]: s for s in json.loads((OUT / "sources.json").read_text())}
    for k in sat.KERNELS:
        s = sources[k.source_id]
        assert s["url"] == k.url and s["sha256"] and s["version"] == k.name
        assert "satellite ephemeris" in s["citation"]
