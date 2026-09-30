"""Star designations and the names product."""

import json

import pytest

from pipeline.paths import OUT
from pipeline.stages.stars import _designation


def test_designations():
    assert _designation("alf", "CMa") == ("bayer", "α CMa")
    assert _designation("the01", "Eri") == ("bayer", "θ¹ Eri")
    assert _designation("mu.02", "Sco") == ("bayer", "μ² Sco")
    assert _designation("pi.", "Ori") == ("bayer", "π Ori")
    assert _designation("b", "Vel") == ("bayer", "b Vel")
    assert _designation("P", "Cyg") == ("bayer", "P Cyg")
    assert _designation("R", "Leo") == ("variable", "R Leo")
    assert _designation("RR", "Lyr") == ("variable", "RR Lyr")
    assert _designation("V373", "Cas") == ("variable", "V373 Cas")
    assert _designation("", "Ori") is None


@pytest.mark.skipif(not (OUT / "stars" / "names.json").exists(), reason="stars product not built")
def test_names_product():
    names = json.loads((OUT / "stars" / "names.json").read_text(encoding="utf-8"))
    stars = names["stars"]
    by_name = {v["iau"]: v for v in stars.values() if "iau" in v}
    assert by_name["Sirius"]["hip"] == 32349 and by_name["Sirius"]["bayer"] == "α CMa"
    assert by_name["Sirius"]["flamsteed"] == "9 CMa"
    assert by_name["Sirius"]["index"] == 0  # brightest star first
    assert by_name["Betelgeuse"]["bayer"] == "α Ori"
    assert len(by_name) > 300
    for v in stars.values():
        assert v["sources"]
