import pytest

from pipeline.schema import sourced, worst, unknown


def test_worst_label():
    assert worst("measured", "derived") == "derived"
    assert worst("measured", "estimated", "derived") == "estimated"


def test_unknown_has_no_value():
    assert unknown()["value"] is None
    with pytest.raises(ValueError):
        sourced(None, "measured", [])
    with pytest.raises(ValueError):
        sourced(1.0, "unknown", [])
