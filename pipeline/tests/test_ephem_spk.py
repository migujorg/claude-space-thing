"""Regressions for satellite verification against multi-segment original kernels."""

from dataclasses import replace

import numpy as np
import pytest
import spiceypy as sp

from pipeline.ephem_spk import read_spk, restrict
from test_ephem_satellites import source_segment


@pytest.fixture
def two_segments(tmp_path):
    """A test-only kernel: forward segment first, backward segment last, as in jup348/plu060."""
    path = tmp_path / "two-segments.bsp"
    handle = sp.spkopn(str(path), "selection regression", 0)
    try:
        for start in (0.0, -4.0):
            # Four constant type-2 records, distinct across the two segments.
            coefficients = np.full((4, 3), start + 1.0)
            sp.spkw02(handle, 901, 9, "J2000", start, start + 4.0, str(start),
                      1.0, 4, 0, coefficients.ravel(), start)
    finally:
        sp.spkcls(handle)
    return read_spk(path)


@pytest.mark.parametrize("reverse", [False, True])
def test_source_selection_uses_coverage_with_two_segments_for_one_body(two_segments, reverse):
    forward, backward = two_segments
    product = restrict(forward, 1.25, 2.75)
    sources = [backward, forward] if reverse else [forward, backward]
    selected = source_segment(product, sources)
    assert selected is forward
    assert np.array_equal(product.records.view(np.uint64), forward.records[1:3].view(np.uint64))


@pytest.mark.parametrize("interval", [(-1.0, 1.0), (5.0, 6.0)])
def test_source_selection_requires_one_segment_containing_all_product_coverage(two_segments, interval):
    product = replace(two_segments[0], init=interval[0], declared=interval)
    with pytest.raises(AssertionError, match="no single source segment contains"):
        source_segment(product, two_segments)


def test_source_selection_rejects_ambiguous_coverage(two_segments):
    forward = two_segments[0]
    product = restrict(forward, 1.25, 2.75)
    with pytest.raises(AssertionError, match="multiple source segments contain"):
        source_segment(product, [forward, replace(forward)])


def test_verification_originals_command_only_fetches_originals(monkeypatch):
    from pipeline import ephem_fixtures as fixtures

    fetched = []
    monkeypatch.setattr(fixtures, "fetch", lambda url, dest: fetched.append((url, dest)))

    def unexpected():
        pytest.fail("download-only command entered fixture generation")

    monkeypatch.setattr(fixtures, "main", unexpected)
    monkeypatch.setattr(fixtures, "orientation", unexpected)
    fixtures.cli(["verification-originals"])
    assert fetched == [(f"{fixtures.sat.SAT_URL}/{name}.bsp", "naif/spk-satellites-full")
                       for name in fixtures.VERIFY_ORIGINALS]
