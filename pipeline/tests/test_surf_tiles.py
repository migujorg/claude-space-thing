"""Surface pyramid math, resampling, normalization and tile/header round trips (synthetic data)."""

import json
import math

import numpy as np
import pytest

from pipeline import output, surf_grid as sg, surf_layers as sl, surf_tiles as st
from pipeline.schema import BuildContext


def test_level_geometry():
    assert st.level_shape(0) == (256, 512)
    assert st.level_shape(5) == (8192, 16384)
    assert st.tiles_shape(5) == (32, 64)
    e = st.lat_edges(3)
    assert e[0] == 90 and e[-1] == -90 and e.size == st.level_shape(3)[0] + 1
    lon = st.lon_edges(3)
    assert lon[0] == -180 and lon[-1] == 180


def test_tycho_lands_in_the_right_texel():
    # Tycho crater centre 43.3°S 11.2°W (IAU/USGS Gazetteer: 43.31°S, 348.78°E)
    ty, tx, py, px = st.tile_of(5, -43.3, -11.2)
    j, i = st.texel_of(5, -43.3, -11.2)
    assert (j, i) == (int((90 + 43.3) / 180 * 8192), int((180 - 11.2) / 360 * 16384))
    assert (ty, tx, py, px) == (j // 256, i // 256, j % 256, i % 256) == (23, 30, 178, 2)
    # east longitude given as 348.8 is the same place
    assert st.texel_of(5, -43.3, 348.8) == st.texel_of(5, -43.3, -11.2)
    # texel centre is within half a texel of the requested point
    lat_c, lon_c = st.lat_centers(5)[j], st.lon_centers(5)[i]
    assert abs(lat_c + 43.3) <= 180 / 8192 / 2 + 1e-12 and abs(lon_c + 11.2) <= 360 / 16384 / 2 + 1e-12


def test_row_weights_integrate_cos2():
    for L in (0, 3):
        assert st.row_weights(L).sum() == pytest.approx(math.pi / 2, rel=1e-12)


def test_disk_mean_and_fractions():
    L = 1
    h, w = st.level_shape(L)
    lat = np.radians(st.lat_centers(L))
    field = np.repeat((1 + np.sin(lat))[:, None], w, axis=1).astype(np.float32)  # antisymmetric part averages out
    known = np.ones((h, w), bool)
    assert st.disk_mean(field, known, L)[0] == pytest.approx(1.0, abs=1e-6)
    known[: h // 2] = False
    assert st.area_fraction(known, L) == pytest.approx(0.5)
    assert st.known_weight_fraction(known, L) == pytest.approx(0.5)


def test_downsample_ignores_unknown():
    a = np.array([[1, 3, 5, 5], [1, 3, 5, 5]], np.float32)
    k = np.array([[1, 1, 0, 0], [1, 0, 0, 0]], bool)
    d, kd = st.downsample2(a, k)
    assert kd.tolist() == [[True, False]]
    assert d[0, 0] == pytest.approx((1 + 3 + 1) / 3)


def _synthetic(L, channels=4, seed=0):
    h, w = st.level_shape(L)
    rng = np.random.default_rng(seed)
    top = rng.uniform(0.2, 2.0, (h, w, channels)).astype(np.float32)
    known = np.ones((h, w), bool)
    known[:10, :] = False           # a polar cap without data
    known[:, : st.TILE] &= False    # one whole tile column unknown at the top level
    return top, known


def test_pyramid_roundtrip(tmp_path):
    L = 2
    top, known = _synthetic(L)
    ts = st.write_pyramid(tmp_path, 999, "albedo", top, known, L, "f16")
    back = st.read_level(tmp_path, 999, "albedo", L, 4, "f16")
    kb = (back != 0).any(axis=2)
    assert (kb == known).all()
    assert np.allclose(back[known], top[known], rtol=1e-3)
    assert not np.isnan(back).any() and (back >= 0).all()
    # missing tiles are exactly the all-unknown ones and are not on disk
    assert [0, 0] in ts.missing[L] and [0, 3] in ts.missing[L]
    assert not (tmp_path / st.tile_rel_path(999, "albedo", L, 0, 0)).exists()
    # every tile is 512 KiB for RGBA float16
    for rel in ts.files:
        assert (tmp_path / rel).stat().st_size == 256 * 256 * 4 * 2
    # lower levels are known-texel means
    l1 = st.read_level(tmp_path, 999, "albedo", L - 1, 4, "f16")
    exp, ke = st.downsample2(top, known)
    assert np.allclose(l1[ke], exp[ke], rtol=2e-3)


def test_height_roundtrip_uses_nan(tmp_path):
    L = 0
    h, w = st.level_shape(L)
    top = np.linspace(-9000, 10000, h * w, dtype=np.float32).reshape(h, w)
    known = np.ones((h, w), bool)
    known[5, 5] = False
    st.write_pyramid(tmp_path, 998, "height", top, known, L, "f32")
    back = st.read_level(tmp_path, 998, "height", L, 1, "f32")[..., 0]
    assert np.isnan(back[5, 5]) and np.array_equal(back[known], top[known])


def test_layer_header_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(sl, "OUT", tmp_path)
    monkeypatch.setattr(output, "OUT", tmp_path)
    ctx = BuildContext(0.0, 1.0)
    L = 1
    top, known = _synthetic(L, seed=1)
    spec = sl.LayerSpec(naif=997, body="Test", layer="albedo", kind="relative-reflectance", fmt="f16",
                        channels=["X", "Y", "Z", "S"], frame={"name": "IAU_TEST"}, sources=["src-a"],
                        brightness=sl.Provenance("measured", ["src-a"], "test"),
                        color=sl.Provenance("estimated", ["src-a"], "test colour"),
                        regions=[sl.Region(-90, 90, -180, 180, sl.Provenance("measured", ["src-a"], "all"))],
                        epoch={"observed": "2025-12-11T16:49:03Z/2025-12-12T01:05:03Z"},
                        normalization={"texelDiskMeanCheck": [1, 1, 1, 1]})
    hdr = sl.write_layer(ctx, spec, top, known, L)
    disk = json.loads((tmp_path / "surfaces/997/albedo.json").read_text(encoding="utf-8"))
    assert disk == json.loads(json.dumps(hdr))
    assert disk["maxLevel"] == L and disk["minLevel"] == 0 and disk["bytesPerTexel"] == 8
    assert disk["tilePath"] == "surfaces/997/albedo/{level}/{ty}/{tx}.bin"
    assert disk["color"]["label"] == "estimated" and disk["brightness"]["label"] == "measured"
    assert [lv["width"] for lv in disk["levels"]] == [512, 1024]
    # listing file hashes every stored tile; the aggregate manifest entry points to it
    listing = (tmp_path / disk["tileListing"]).read_text(encoding="utf-8").splitlines()
    assert len(listing) == disk["stats"]["tiles"] == ctx.products["surfaces/997/albedo/"]["files"]
    for line in listing:
        sha, rel = line.split("  ")
        import hashlib
        assert hashlib.sha256((tmp_path / rel).read_bytes()).hexdigest() == sha
    assert "levelCap" not in disk


def test_level_cap_writes_the_same_lower_levels(tmp_path, monkeypatch):
    """surfaces.maxLevel (build profiles) leaves out the top levels; the levels written are the uncapped ones."""
    L = 2
    top, known = _synthetic(L, seed=3)
    full = st.write_pyramid(tmp_path / "full", 999, "albedo", top, known, L, "f16")
    capped = st.write_pyramid(tmp_path / "cap", 999, "albedo", top, known, L, "f16", max_level=1)
    assert capped.files == {k: v for k, v in full.files.items() if int(k.split("/")[3]) <= 1}
    assert not (tmp_path / "cap/surfaces/999/albedo/2").exists() and 2 not in capped.missing
    # the layer header says what was written and what the source has
    monkeypatch.setattr(sl, "OUT", tmp_path / "out")
    monkeypatch.setattr(output, "OUT", tmp_path / "out")
    ctx = BuildContext(0.0, 1.0, params={"surfaces.maxLevel": 1})
    spec = sl.LayerSpec(naif=996, body="Test", layer="albedo", kind="relative-reflectance", fmt="f16",
                        channels=["X", "Y", "Z", "S"], frame={"name": "IAU_TEST"}, sources=["s"],
                        brightness=sl.Provenance("measured", ["s"], "test"))
    hdr = sl.write_layer(ctx, spec, top, known, L)
    assert hdr["maxLevel"] == 1 and [lv["level"] for lv in hdr["levels"]] == [0, 1]
    assert hdr["levelCap"]["sourceMaxLevel"] == 2
    assert hdr["coverage"]["areaFraction"] == round(st.area_fraction(known, L), 5)   # coverage of the source


# ------------------------------------------------------------------------------------------ resampling


def _analytic(lat, lon):
    return 2.0 + np.sin(np.radians(lat)) + 0.5 * np.cos(np.radians(lon - 40.0))


def test_equirect_downsample_matches_cell_means():
    # source: global 0..360 E, 0.25° pixels; target level 0 (0.703°) → box filter
    res = 0.25
    g = sg.EquirectGrid(lat0=90 - res / 2, lon0=res / 2, dlat=res, dlon=res, lines=720, samples=1440)
    lat = g.lat0 - np.arange(g.lines) * g.dlat
    lon = g.lon0 + np.arange(g.samples) * g.dlon
    src = _analytic(lat[:, None], lon[None, :]).astype(np.float32)
    h, w = st.level_shape(0)
    num = np.zeros((h, w), np.float32)
    den = np.zeros((h, w), np.float32)
    sg.accumulate(num, den, src, np.ones_like(src, bool), g, 0)
    out, known = sg.finish(num, den)
    assert known.all() and np.allclose(den, 1.0, atol=1e-5)
    exp = _analytic(st.lat_centers(0)[:, None], st.lon_centers(0)[None, :])
    assert np.abs(out - exp).max() < 2e-3   # cell mean vs centre value of a smooth field


def test_equirect_regional_tile_and_wrap():
    # a regional tile covering 270..360 E, 0..30 N with a bright pixel at 350.1 E, 10.1 N
    res = 0.2
    g = sg.EquirectGrid(lat0=30 - res / 2, lon0=270 + res / 2, dlat=res, dlon=res, lines=150, samples=450)
    src = np.ones((150, 450), np.float32)
    li, si = int((30 - 10.1) / res), int((350.1 - 270) / res)
    src[li, si] = 100.0
    L = 3
    h, w = st.level_shape(L)
    num = np.zeros((h, w), np.float32)
    den = np.zeros((h, w), np.float32)
    sg.accumulate(num, den, src, np.ones_like(src, bool), g, L)
    out, known = sg.finish(num, den)
    j, i = np.unravel_index(np.argmax(out), out.shape)
    assert (j, i) == st.texel_of(L, 10.1, 350.1 - 360)
    # only the tile's footprint is known
    assert known[st.texel_of(L, 15, -45)] and not known[st.texel_of(L, 15, 45)]
    assert not known[st.texel_of(L, -5, -45)]


def test_upsampling_is_linear_and_nodata_is_not_extended():
    g = sg.EquirectGrid(lat0=89.5, lon0=0.5, dlat=1, dlon=1, lines=180, samples=360)
    lat = g.lat0 - np.arange(180)
    src = np.repeat(lat[:, None], 360, axis=1).astype(np.float32)
    valid = np.ones_like(src, bool)
    valid[:, 100:110] = False
    L = 2  # 0.35° texels: upsampling
    h, w = st.level_shape(L)
    num = np.zeros((h, w), np.float32)
    den = np.zeros((h, w), np.float32)
    sg.accumulate(num, den, src, valid, g, L)
    out, known = sg.finish(num, den)
    rows = (np.abs(st.lat_centers(L)) < 89)
    assert np.allclose(out[rows][:, 10], st.lat_centers(L)[rows], atol=1e-4)
    assert not known[st.texel_of(L, 0, 105)]
    assert known[st.texel_of(L, 0, 95)]


def test_bilinear_and_block_mean():
    src = np.arange(16, dtype=np.float32).reshape(4, 4)
    v, wgt = sg.bilinear(src, np.ones_like(src, bool), np.array([1.5]), np.array([2.25]))
    assert v[0] == pytest.approx(1.5 * 4 + 2.25) and wgt[0] == pytest.approx(1)
    m, f = sg.block_mean(src, src != 5, 2)
    assert m[0, 0] == pytest.approx((0 + 1 + 4) / 3) and f[0, 0] == pytest.approx(0.75)
