"""Earth surface layers: latitude conversion, GIBS colour-map inversion, COG range reads, download Range support,
and checks on the built Earth products (skipped when they have not been built)."""

import http.server
import json
import threading

import numpy as np
import pytest
import tifffile

from pipeline import download
from pipeline import surf_cog
from pipeline import surf_earth as se
from pipeline import surf_gibs as gb
from pipeline import surf_tiles as st
from pipeline.paths import OUT

# ------------------------------------------------------------------------------------------------ geometry


def test_geodetic_centric_round_trip_and_row_shift():
    lat = np.linspace(-89.9, 89.9, 1001)
    assert np.allclose(se.centric_from_geodetic(se.geodetic_from_centric(lat)), lat, atol=1e-9)
    # maximum difference ≈ 0.1924° at 45°
    d = se.geodetic_from_centric(lat) - lat
    assert 0.19 < d.max() < 0.195 and abs(d[np.argmin(abs(lat))]) < 1e-6
    rows = se.centric_rows(4)
    h, _ = st.level_shape(4)
    shift = rows - np.arange(h)
    # geodetic latitude is poleward of planetocentric: in the north the source row is above (smaller index)
    assert shift[: h // 2].max() <= 0 and shift[h // 2:].min() >= 0
    assert np.abs(shift).max() in (4, 5) and shift[0] == 0 and shift[-1] == 0   # 0.192° / 0.044°


def test_daylit_rows_follow_the_season():
    lat = st.lat_centers(se.LEVEL)
    june = se.daylit_rows("2026-06-21")
    dec = se.daylit_rows("2026-12-21")
    assert june[lat > 80].all() and not june[lat < -75].any()
    assert dec[lat < -80].all() and not dec[lat > 75].any()


# ------------------------------------------------------------------------------------------------ GIBS colour maps

CMAP = """<?xml version="1.0" encoding="UTF-8"?>
<ColorMaps>
  <ColorMap title="No Data"><Entries>
    <ColorMapEntry rgb="0,0,0" transparent="true" nodata="true" ref="0"/>
  </Entries></ColorMap>
  <ColorMap title="Thing" units="m"><Entries>
    <ColorMapEntry rgb="10,0,0" transparent="false" sourceValue="[0,50)" value="[0,50)" ref="1"/>
    <ColorMapEntry rgb="20,0,0" transparent="false" sourceValue="[50,100)" value="[50,100)" ref="2"/>
    <ColorMapEntry rgb="30,0,0" transparent="false" sourceValue="[100]" value="[100]" ref="3"/>
    <ColorMapEntry rgb="40,0,0" transparent="false" sourceValue="[100,+INF)" value="[100,+INF)" ref="4"/>
    <ColorMapEntry rgb="50,0,0" transparent="false" sourceValue="[38.2,999999)" value="[38.2,999999)" ref="5"/>
  </Entries></ColorMap>
</ColorMaps>
"""


def test_colormap_inversion(tmp_path):
    p = tmp_path / "map.xml"
    p.write_text(CMAP)
    cm = gb.parse_colormap("test", p)
    assert cm.units == "m" and cm.classes == ["No Data", "Thing"]
    rgba = np.array([[[10, 0, 0, 255], [20, 0, 0, 255], [30, 0, 0, 255]],
                     [[40, 0, 0, 255], [50, 0, 0, 255], [0, 0, 0, 0]],
                     [[99, 0, 0, 255], [10, 0, 0, 0], [0, 0, 0, 255]]], np.uint8)
    val, cls, cen, unmatched = gb.decode(rgba, cm)
    assert val[0].tolist() == [25.0, 75.0, 100.0]
    assert val[1, 0] == 100.0 and val[1, 1] == pytest.approx(38.2) and np.isnan(val[1, 2])
    assert cen.tolist() == [[False, False, False], [True, True, False], [False, False, False]]
    # an unknown colour is counted, transparent pixels and the no-data colour are not
    assert unmatched == 1 and np.isnan(val[2]).all() and (cls[2] == -1).all()


def test_colormap_with_duplicate_colours_is_rejected(tmp_path):
    p = tmp_path / "dup.xml"
    p.write_text(CMAP.replace('rgb="20,0,0"', 'rgb="10,0,0"'))
    with pytest.raises(ValueError, match="duplicate"):
        gb.parse_colormap("dup", p)


# ------------------------------------------------------------------------------------------------ Range reads


class _RangeHandler(http.server.BaseHTTPRequestHandler):
    blob = b""

    def log_message(self, *a):
        pass

    def do_GET(self):
        rng = self.headers.get("Range")
        data, code = self.blob, 200
        if rng:
            a, b = rng.removeprefix("bytes=").split("-")
            data, code = self.blob[int(a):int(b) + 1], 206
        self.send_response(code)
        if rng:
            self.send_header("Content-Range", f"bytes {a}-{b}/{len(self.blob)}")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("ETag", '"abc"')
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture
def server(tmp_path, monkeypatch):
    monkeypatch.setattr(download, "RAW", tmp_path / "raw")
    monkeypatch.setattr(download, "_LEDGER", tmp_path / "raw" / "_downloads.json")
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _RangeHandler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield srv
    srv.shutdown()


def test_fetch_byte_range_is_recorded(server):
    _RangeHandler.blob = bytes(range(256)) * 40
    url = f"http://127.0.0.1:{server.server_port}/blob.bin"
    p = download.fetch(url + "?token=secret", "t", "part", byte_range=(100, 612), record_url=url)
    assert p.read_bytes() == _RangeHandler.blob[100:612]
    e = json.loads(download._LEDGER.read_text())["t/part"]
    assert e["range"] == "bytes=100-611" and e["remoteBytes"] == 10240 and e["etag"] == '"abc"'
    assert e["url"] == url and "secret" not in json.dumps(e)
    # a different range is fetched again, not taken from the cache
    p2 = download.fetch(url, "t", "part", byte_range=(0, 10))
    assert p2.read_bytes() == _RangeHandler.blob[:10]


def test_cog_level_read_by_ranges(server, tmp_path):
    rng = np.random.default_rng(1)
    full = rng.integers(0, 10000, (1100, 1300)).astype(np.int16)
    full[:37, :] = 32767
    half = full[::2, ::2].copy()
    path = tmp_path / "cog.tif"
    with tifffile.TiffWriter(path) as tw:
        tw.write(full, tile=(256, 256), compression="zlib", subfiletype=0)
        tw.write(half, tile=(256, 256), compression="zlib", subfiletype=1)
    _RangeHandler.blob = path.read_bytes()
    url = f"http://127.0.0.1:{server.server_port}/cog.tif"
    img, lv, paths = surf_cog.read_level(url, None, "cog", "cog", 1, url)
    assert lv.shape == half.shape and lv.full_shape == full.shape
    assert np.array_equal(img, half)
    assert all(p.exists() for p in paths)


# ------------------------------------------------------------------------------------------------ built products


def _header(layer):
    p = OUT / "surfaces" / "399" / f"{layer}.json"
    if not p.exists():
        pytest.skip(f"surfaces/399/{layer} not built")
    return json.loads(p.read_text())


def _top(h):
    return st.read_level(OUT, 399, h["layer"], h["maxLevel"], len(h["channels"]),
                         "f16" if h["format"] == "float16" else "f32",
                         nodata="nan" if h["noData"].startswith("NaN") else "zero")


def test_earth_albedo_absolute_calibration():
    h = _header("albedo")
    n = h["normalization"]
    a = n["absoluteDiskMean"]
    # a cloud- and atmosphere-free Earth: mostly dark ocean (~0.02-0.05) and land (~0.1-0.3)
    assert 0.03 < a["Y"] < 0.2, a
    assert a["Z"] < a["Y"] * 1.5
    assert np.allclose(n["texelDiskMeanCheck"], 1.0, atol=1e-3)
    share = h["diagnostics"]["diskWeightShare"]
    assert share["ocean"] > share["land"] > 0.1
    assert h["epoch"]["start"] < h["epoch"]["end"]
    assert h["color"]["label"] == "estimated"


def test_earth_albedo_land_brighter_than_ocean():
    h = _header("albedo")
    y = _top(h)[..., 1]
    w = _top(_header("water"))[..., 0]
    known = y > 0
    land = known & (w < 0.01)
    sea = known & (w > 0.99)
    assert np.median(y[land]) > 2.5 * np.median(y[sea])
    # the Sahara (20-28°N, 0-20°E) is among the brightest snow-free land
    lat, lon = st.lat_centers(h["maxLevel"]), st.lon_centers(h["maxLevel"])
    sahara = y[(lat > 20) & (lat < 28)][:, (lon > 0) & (lon < 20)]
    assert np.median(sahara[sahara > 0]) > 1.5 * np.median(y[land])


def test_earth_clouds_channels_in_range():
    h = _header("clouds")
    a = _top(h)
    f, cot, cth, ice = (a[..., k] for k in range(4))
    ok = np.isfinite(f)
    assert 0.9 < h["coverage"]["areaFraction"] <= 1.0
    assert ((f[ok] >= 0) & (f[ok] <= 1)).all()
    fin = np.isfinite(cot)
    assert ((cot[fin] >= 0) & (cot[fin] <= 150)).all()
    fin = np.isfinite(cth)
    assert ((cth[fin] >= 0) & (cth[fin] <= 12000)).all()
    fin = np.isfinite(ice)
    assert ((ice[fin] >= 0) & (ice[fin] <= 1)).all()
    # global mean cloud fraction of one day: ~0.5-0.8
    assert 0.5 < h["diagnostics"]["meanCloudFraction"] < 0.85
    assert h["diagnostics"]["unmatchedColours"] == 0


def test_earth_night_lights():
    h = _header("night")
    a = _top(h)
    rad, cen = a[..., 0], a[..., 1]
    fin = np.isfinite(rad)
    assert (rad[fin] >= 0).all() and ((cen[fin] >= 0) & (cen[fin] <= 1)).all()
    lat, lon = st.lat_centers(h["maxLevel"]), st.lon_centers(h["maxLevel"])

    def at(la, lo):
        i, j = np.argmin(abs(lat - la)), np.argmin(abs(lon - lo))
        return np.nanmax(rad[i - 3:i + 4, j - 3:j + 4])
    # city centres far brighter than the dark Sahara
    assert at(48.86, 2.35) > 20 and at(40.71, -74.0) > 20 and at(23.0, 12.0) < 1
    f = h["constants"]["toXYZS"]
    assert 0.003 < f["HP1"][1] < 0.01 and 0.003 < f["LED-B3"][1] < 0.01


def test_earth_water_layer():
    h = _header("water")
    a = _top(h)
    w, ice = a[..., 0], a[..., 1]
    assert np.isfinite(w).all() and ((w >= 0) & (w <= 1)).all()
    assert 0.68 < h["diagnostics"]["waterAreaFraction"] < 0.74
    lat, lon = st.lat_centers(h["maxLevel"]), st.lon_centers(h["maxLevel"])
    i, j = np.argmin(abs(lat - 0)), np.argmin(abs(lon + 140))    # central Pacific
    assert w[i, j] == 1
    i, j = np.argmin(abs(lat - 15)), np.argmin(abs(lon - 20))    # Chad
    assert w[i, j] == 0
    fin = np.isfinite(ice)
    assert ((ice[fin] >= 0) & (ice[fin] <= 1)).all()
    assert h["diagnostics"]["texelsWithSeaIceOver15pc"] > 1000
