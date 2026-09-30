"""Binary star-table format: writer/reader round trip and the app's float32 view."""

import json

import numpy as np
import pytest

from pipeline import stars_format as sf
from pipeline.paths import OUT
from pipeline.schema import LABEL_ORDER


def _sample(n=5):
    rng = np.random.default_rng(1)
    rec = np.zeros(n, dtype=sf.dtype())
    d = rng.normal(size=(n, 3))
    rec["dir"] = (d / np.linalg.norm(d, axis=1, keepdims=True)).astype(np.float32)
    rec["xyzs"] = rng.uniform(1e-10, 1e-5, size=(n, 4)).astype(np.float32)
    rec["labelPos"] = [0, 1, 1, 2, 4]
    rec["labelFlux"] = [1, 1, 2, 2, 4]
    rec["labelColor"] = [1, 2, 2, 2, 4]
    rec["src"] = [0, 1, 2, 0, 1]
    rec["posRoute"] = [0, 1, 2, 3, 4]
    rec["lightRoute"] = [5, 4, 3, 2, 1]
    rec["flags"] = [0, 1, 2, 4, 31]
    rec["catId"] = sf.split_id(np.array([4295806720, 6914582340775478656, 2, 3, 2**62 + 12345]))
    rec["hip"] = [0, 32349, 71683, 0, 120416]
    return rec


def test_layout_is_app_compatible():
    dt = sf.dtype()
    assert dt.itemsize == sf.STRIDE and sf.STRIDE % 4 == 0
    assert [f[3] for f in sf.FIELDS[:2]] == [0, 12]  # [ux,uy,uz,X,Y,Z,S] = bytes 0..27
    # no overlapping fields
    spans = sorted((o, o + {"f32": 4, "u32": 4, "u8": 1}[t] * c) for _, t, c, o in sf.FIELDS)
    for (a0, a1), (b0, b1) in zip(spans, spans[1:]):
        assert a1 <= b0
    assert spans[-1][1] <= sf.STRIDE


def test_round_trip(tmp_path):
    rec = _sample()
    (tmp_path / "t.bin").write_bytes(sf.encode(rec))
    header = {"bin": "t.bin", "count": len(rec), "stride": sf.STRIDE, "fields": sf.header_fields(),
              "labelEncoding": list(LABEL_ORDER), "sourceTable": ["a", "b", "c"]}
    (tmp_path / "t.json").write_text(json.dumps(header))
    h, cols = sf.read_table(tmp_path / "t.json")
    for name in rec.dtype.names:
        np.testing.assert_array_equal(cols[name], rec[name])
    assert (sf.gaia_id(cols["catId"]) == np.array([4295806720, 6914582340775478656, 2, 3, 2**62 + 12345])).all()
    # The app's StarCatalog view: Float32Array with stride 12 floats, first 7 are ux,uy,uz,X,Y,Z,S.
    f = np.frombuffer((tmp_path / "t.bin").read_bytes(), dtype="<f4").reshape(len(rec), sf.STRIDE // 4)
    np.testing.assert_array_equal(f[:, 0:3], rec["dir"])
    np.testing.assert_array_equal(f[:, 3:7], rec["xyzs"])


def test_tycho_packing():
    tid = sf.tycho_id([9537, 1, 4660], [12121, 1, 870], [4, 1, 1])
    assert (tid >> 17).tolist() == [9537, 1, 4660]
    assert ((tid >> 3) & 0x3FFF).tolist() == [12121, 1, 870]
    assert (tid & 7).tolist() == [4, 1, 1]


@pytest.mark.skipif(not (OUT / "stars" / "bright.json").exists(), reason="stars product not built")
def test_built_product_is_consistent():
    h, cols = sf.read_table(OUT / "stars" / "bright.json")
    assert h["stride"] == sf.STRIDE and h["fields"] == sf.header_fields()
    assert h["labelEncoding"] == list(LABEL_ORDER)
    n = h["count"]
    assert n > 100_000
    norm = np.linalg.norm(cols["dir"].astype(np.float64), axis=1)
    assert np.abs(norm - 1).max() < 1e-6
    unknown = LABEL_ORDER.index("unknown")
    known = cols["labelFlux"] != unknown
    # values present exactly when the label is not unknown
    assert np.isfinite(cols["xyzs"][known]).all() and np.isnan(cols["xyzs"][~known]).all()
    assert (cols["xyzs"][known] > 0).all()
    assert (cols["src"] < len(h["sourceTable"])).all()
    assert (cols["posRoute"] < len(h["routes"]["pos"])).all()
    assert (cols["lightRoute"] < len(h["routes"]["light"])).all()
    # labels agree with the routes they came from
    lp = np.array([LABEL_ORDER.index(r["label"]) for r in h["routes"]["pos"]])[cols["posRoute"]]
    ll = np.array([LABEL_ORDER.index(r["label"]) for r in h["routes"]["light"]])[cols["lightRoute"]]
    assert (lp == cols["labelPos"]).all() and (ll == cols["labelFlux"]).all()
    # sorted brightest first
    y = np.nan_to_num(cols["xyzs"][:, 1], nan=-1)
    assert (np.diff(y) <= 0).all()
    size = (OUT / "stars" / "bright.bin").stat().st_size + (OUT / "stars" / "bright.json").stat().st_size + \
        (OUT / "stars" / "names.json").stat().st_size
    assert size < 30e6
