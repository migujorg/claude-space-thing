"""Binary tables (sb_table) and, when built, the small-body products themselves."""

import json

import numpy as np
import pytest

from pipeline.paths import OUT
from pipeline.sb_table import Field, layout, pack, read_table

CORE = OUT / "smallbodies" / "core.json"


def test_layout_aligns_fields_and_pads_stride():
    fields = [Field("a", "u8"), Field("pos", "f64", 3), Field("h", "f32"), Field("b", "u16"), Field("c", "u8")]
    fl, stride, dt = layout(fields)
    offs = {f["name"]: f["offset"] for f in fl}
    assert offs == {"a": 0, "pos": 8, "h": 32, "b": 36, "c": 38}
    assert stride == 40 and dt.itemsize == 40
    for f in fl:
        size = {"u8": 1, "u16": 2, "f32": 4, "f64": 8}[f["type"]]
        assert f["offset"] % size == 0


def test_round_trip_bytes(tmp_path):
    fields = [Field("pos", "f64", 3), Field("H", "f32"), Field("row", "u32"), Field("lab", "u8")]
    n = 5
    cols = {"pos": np.arange(15, dtype=float).reshape(5, 3) * 1e8 + 0.123456789, "H": np.array([1, 2, np.nan, 4, 5]),
            "row": np.array([0, 1, 0xFFFFFFFF, 3, 4]), "lab": np.array([0, 1, 4, 2, 4])}
    rec, fl, stride = pack(fields, cols, n)
    (tmp_path / "t.bin").write_bytes(rec.tobytes())
    header = {"bin": "t.bin", "count": n, "stride": stride, "fields": fl}
    (tmp_path / "t.json").write_text(json.dumps(header))
    h, data = read_table(tmp_path / "t.json")
    assert np.array_equal(data["pos"], cols["pos"])  # float64 survives bit for bit
    assert np.isnan(data["H"][2]) and data["row"][2] == 0xFFFFFFFF and list(data["lab"]) == [0, 1, 4, 2, 4]
    # little-endian on disk
    raw = (tmp_path / "t.bin").read_bytes()
    assert np.frombuffer(raw[:8], "<f8")[0] == cols["pos"][0, 0]


@pytest.mark.skipif(not CORE.exists(), reason="smallbodies products not built")
def test_built_products_are_consistent():
    header, core = read_table(CORE)
    sources = {s["id"] for s in json.loads((OUT / "sources.json").read_text())}
    assert all(s in sources for s in header["sourceTable"]), set(header["sourceTable"]) - sources
    enc = header["labelEncoding"]
    assert enc == ["measured", "derived", "estimated", "synthetic", "unknown"]
    unknown = enc.index("unknown")
    pos_nan = np.isnan(core["pos"]).any(axis=1)
    assert np.array_equal(pos_nan, core["posLabel"] == unknown), "position NaN iff label unknown"
    assert np.array_equal(np.isnan(core["H"]), core["hLabel"] == unknown)
    assert np.array_equal(np.isnan(core["diameterFromH"]), core["diameterFromHLabel"] == unknown)
    for lab, src in (("posLabel", "orbitSrc"), ("hLabel", "hSrc"), ("gLabel", "gSrc"),
                     ("diameterFromHLabel", "diameterFromHSrc")):
        known = core[lab] != unknown
        assert (core[src][known] < len(header["sourceTable"])).all(), src
    assert set(np.unique(core["posLabel"])) <= {enc.index("derived"), enc.index("estimated"), unknown}
    # never a measured diameter and a diameter-from-H for the same object
    ph_h, ph = read_table(OUT / "smallbodies" / "physical.json")
    has = core["physRow"] != 0xFFFFFFFF
    assert (ph["row"][core["physRow"][has]] == np.nonzero(has)[0]).all()
    measured_d = np.zeros(core.size, bool)
    measured_d[ph["row"]] = ph["diameterLabel"] == enc.index("measured")
    assert not (measured_d & (core["diameterFromHLabel"] != unknown)).any()
    # names sidecar: one line per record
    names = (OUT / "smallbodies" / "names.txt").read_text(encoding="utf-8").split("\n")
    assert names[-1] == "" and len(names) - 1 == core.size
    assert names[0].split("\t")[0].isdigit()
    fm = header["forceModel"]
    assert len(fm["scheme"]["drift"]) == len(fm["scheme"]["kick"]) + 1
    assert abs(sum(fm["scheme"]["drift"]) - 1) < 1e-15 and abs(sum(fm["scheme"]["kick"]) - 1) < 1e-15
