"""Satellite products (ephem/sat-*.json) vs the NAIF satellite kernels.

Requires `python -m pipeline build --only ephemeris`; the excerpt-vs-original checks also need the whole originals
that `python -m pipeline.ephem_fixtures verification-originals` downloads (VERIFY_ORIGINALS), and are skipped
without them. That command only fetches originals; it does not regenerate app test fixtures.
- every product segment is bit-identical to its kernel excerpt, with the declared coverage carried through;
- SPICE spkgeo equals our evaluator at type 2/3 starts and interior epochs, and at endpoints where it uses the
  same record; a trimmed final boundary matches the retained source record exactly and SPICE to <= 10 ulps;
- type 17 agrees to < 1 mm inside the build window;
- for the kernels downloaded whole, spkgeo on the original equals spkgeo on the excerpt, exactly;
- no DE copy from a satellite kernel leaks into the products; every excerpt was byte-checked against its original.
Epochs come from the products' own coverage and each excerpt is found through its ledger entry, so the tests do not
depend on when the window was made.
"""

import json

import numpy as np
import pytest
import spiceypy as sp

from pipeline import download
from pipeline import ephem_satellites as sat
from pipeline.ephem_fixtures import VERIFY_ORIGINALS
from pipeline.ephem_spk import evaluate, load_product, read_spk
from pipeline.paths import OUT, RAW
from pipeline.stages.ephemeris import MARGIN_S
from test_ephem_types import compare_spice

PRODUCTS = sorted((OUT / "ephem").glob("sat-*.json"))
pytestmark = pytest.mark.skipif(len(PRODUCTS) != len(sat.SYSTEMS), reason="satellite products not built")


@pytest.fixture(scope="module")
def segments():
    """kernel name -> [(product, Segment)]"""
    out: dict[str, list] = {}
    for p in PRODUCTS:
        for s in load_product(p):
            out.setdefault(s.sources[0].removeprefix("naif-"), []).append((p.stem, s))
    return out


def coverage(segs) -> tuple[float, float]:
    return max(s.start for s in segs), min(s.end for s in segs)


def source_segment(product, sources):
    """The source segment containing this product's coverage (not the last segment for its body)."""
    body = [s for s in sources if (s.target, s.center) == (product.target, product.center)]
    matches = [s for s in body if s.start <= product.start and s.end >= product.end]
    context = (f"body {product.target} wrt {product.center}, product [{product.start}, {product.end}], "
               f"source intervals {[(s.start, s.end) for s in body]}")
    assert matches, f"no single source segment contains the product: {context}"
    assert len(matches) == 1, f"multiple source segments contain the product: {context}"
    return matches[0]


def build_window(segments) -> tuple[float, float]:
    """The window the products were built for: the coverage of every type 2/3 satellite segment. (A type 17
    segment is a conic valid 1950-2050; the < 1 mm agreement with SPICE is required inside the window, where the
    mean longitude stays below ~1e5 rad.)"""
    return coverage([s for v in segments.values() for _, s in v if s.type != 17])


def excerpt_path(kernel, segs):
    """The local file a kernel's product segments came from: the whole file, or the ledger's matching excerpt."""
    if kernel.whole:
        return sat.kernel_path(kernel, 0.0, 0.0)
    lo, hi = coverage(segs)
    targets = sorted(s.target for s in segs)
    for key, rec in download._load_ledger().items():
        ex = rec.get("excerpt")
        if key.startswith(f"naif/spk-excerpts/{kernel.name}_JD") and ex and ex["targets"] == targets \
                and ex["startEt"] <= lo + 1e-3 and ex["endEt"] >= hi - 1e-3 and (RAW / key).exists():
            return RAW / key
    raise AssertionError(f"no excerpt of {kernel.name} in the ledger matches the product")


def test_products_cover_every_kernel_and_system(segments):
    assert set(segments) == {k.name for k in sat.KERNELS}
    w = json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))["window"]
    for p in PRODUCTS:
        key = p.stem.removeprefix("sat-")
        bary = sat.SYSTEMS[key][0]
        segs = load_product(p)
        assert segs[0].target == 100 * bary + 99  # the planet centre first
        for s in segs:
            assert s.target not in sat.DE_IDS, f"DE copy {s.target} leaked into {p.name}"
            assert s.center in (bary, 100 * bary + 99)
            assert s.label == "measured" and s.uncertainty and s.frame == 1
            assert s.start <= w["startEt"] - MARGIN_S + 1e-3 and s.end >= w["endEt"] + MARGIN_S - 1e-3
    n = sum(len(v) for v in segments.values())
    print(f"{n} satellite segments ({n - 6} moons + 6 planet centres) from {len(segments)} kernels")
    assert n >= 465


@pytest.mark.parametrize("kernel", sat.KERNELS, ids=lambda k: k.name)
def test_product_is_bit_identical_to_excerpt_and_matches_spice(kernel, segments):
    segs = [s for _, s in segments[kernel.name]]
    path = excerpt_path(kernel, segs)
    ours = {s.target: s for s in segs}
    theirs = {s.target: s for s in read_spk(path, set(ours))}
    assert set(theirs) == set(ours)
    rng = np.random.default_rng(17)
    worst = 0.0
    failures = []
    sp.furnsh(str(path))
    try:
        for t, s in ours.items():
            ref = theirs[t]
            try:
                assert (s.type, s.intlen, s.rsize) == (ref.type, ref.intlen, ref.rsize)
                i0 = (s.init - ref.init) / s.intlen if s.type != 17 else 0.0
                assert i0 == int(i0) and int(i0) + s.n <= ref.n
                assert np.array_equal(s.records.view(np.uint64),
                                      ref.records[int(i0): int(i0) + s.n].view(np.uint64)), t
                assert (s.start, s.end) == (ref.start, ref.end)
            except AssertionError as error:
                failures.append(f"{kernel.name}, body {t}: source record/coverage mismatch: {error}")
                continue
            if s.type in (2, 3):
                b = s.init + s.intlen * np.arange(s.n + 1)
                ets = np.unique(np.concatenate([rng.uniform(s.start, s.end, 20),
                                               b[(b >= s.start) & (b < s.end)],
                                               [s.start, s.end]]))
            else:
                ets = rng.uniform(*build_window(segments), 20)
            spice = np.array([sp.spkgeo(t, e, "J2000", s.center)[0] for e in ets])
            dp, dv = compare_spice(s, ref, ets, spice,
                                   f"{kernel.name}, body {t} wrt {s.center}, type {s.type}", failures)
            worst = max(worst, dp)
    finally:
        sp.unload(str(path))
    print(f"{kernel.name}: {len(ours)} bodies, max |ours - spkgeo| {worst:.3e} km")
    assert not failures, "\n".join(failures)


@pytest.mark.parametrize("name", VERIFY_ORIGINALS)
@pytest.mark.skip_group("missing-input")
def test_excerpt_equals_original_in_spice(name, segments):
    original = RAW / "naif" / "spk-satellites-full" / f"{name}.bsp"
    if not original.exists():
        pytest.skip(f"{original.name} not downloaded (run python -m pipeline.ephem_fixtures "
                    "verification-originals; downloads only, no fixture rewrites)")
    kernel = next(k for k in sat.KERNELS if k.name == name)
    segs = [s for _, s in segments[name]]
    excerpt = excerpt_path(kernel, segs)
    pairs = sorted({(s.target, s.center) for s in read_spk(excerpt)})
    ets = np.random.default_rng(3).uniform(*build_window(segments), 300)
    states = {}
    for path in (original, excerpt):
        sp.furnsh(str(path))
        try:
            states[path] = np.array([[sp.spkgeo(t, e, "J2000", c)[0] for e in ets] for t, c in pairs])
        finally:
            sp.unload(str(path))
    assert np.array_equal(states[original], states[excerpt]), name
    print(f"{name}: {len(pairs)} bodies x {ets.size} epochs, spkgeo(original) == spkgeo(excerpt) exactly")
    sources = read_spk(original, {s.target for s in segs})
    failures = []
    sp.furnsh(str(original))
    try:
        for s in segs:
            try:
                source = source_segment(s, sources)
                assert (s.type, s.frame, s.intlen, s.rsize) == (source.type, source.frame, source.intlen, source.rsize)
                i0 = (s.init - source.init) / s.intlen
                assert i0 == int(i0) and 0 <= i0 and int(i0) + s.n <= source.n
                assert np.array_equal(s.records.view(np.uint64),
                                      source.records[int(i0):int(i0) + s.n].view(np.uint64)), "record bits differ"
            except AssertionError as error:
                failures.append(f"{name} full kernel, body {s.target} wrt {s.center}: {error}")
                continue
            b = s.init + s.intlen * np.arange(s.n + 1)
            epochs = np.unique(np.concatenate([ets, b[(b >= s.start) & (b < s.end)],
                                               [s.start, s.end]]))
            spice = np.array([sp.spkgeo(s.target, e, "J2000", s.center)[0] for e in epochs])
            compare_spice(s, source, epochs, spice,
                          f"{name} full kernel, body {s.target} wrt {s.center}, type {s.type}", failures)
    finally:
        sp.unload(str(original))
    assert not failures, "\n".join(failures)


def test_every_excerpt_was_checked_against_its_original(segments):
    ledger = download._load_ledger()
    for k in sat.KERNELS:
        path = excerpt_path(k, [s for _, s in segments[k.name]])
        rec = ledger[download.ledger_key(path)]
        assert rec["url"] == k.url
        if not k.whole:
            ex = rec["excerpt"]
            assert ex["verifiedRecords"] >= 1 and ex["originalBytes"] > rec["bytes"]
        assert rec["sha256"] == download.sha256_file(path)


def test_sources_cite_each_kernel():
    sources = {s["id"]: s for s in json.loads((OUT / "sources.json").read_text(encoding="utf-8"))}
    for k in sat.KERNELS:
        s = sources[k.source_id]
        assert s["url"] == k.url and s["sha256"] and s["version"] == k.name
        assert "satellite ephemeris" in s["citation"]
