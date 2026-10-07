"""Earth surface layers: latitude conversion, GIBS colour-map inversion, COG range reads, download Range support,
and checks on the built Earth products (skipped when they have not been built)."""

import http.server
import datetime as dt
import hashlib
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


def _clock(monkeypatch, day):
    class Clock(dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return cls.fromisoformat(day).replace(tzinfo=tz)
    monkeypatch.setattr(dt, "datetime", Clock)


@pytest.mark.parametrize("build_day", ["2026-10-04", "2027-01-15"])
def test_capabilities_reuses_the_pinned_snapshot(tmp_path, monkeypatch, build_day):
    _clock(monkeypatch, build_day)
    p = tmp_path / "caps.xml"
    p.write_text("cached capabilities")
    monkeypatch.setattr(gb, "CAPS_SHA256", hashlib.sha256(p.read_bytes()).hexdigest(), raising=False)
    calls = []
    def fetch(url, subdir, name, **kwargs):
        calls.append((url, subdir, name))
        return p
    monkeypatch.setattr(gb, "fetch", fetch)
    assert gb.capabilities() == p
    assert calls == [(gb.CAPS, gb.SUBDIR, "WMTSCapabilities-2026-10-04.xml")]
    p.write_text("a different remote capabilities document")
    with pytest.raises(ValueError, match="snapshot pin.*sha256 mismatch"):
        gb.capabilities()


@pytest.mark.parametrize("build_day", ["2026-10-04", "2027-01-15"])
def test_mcd43_search_uses_the_pinned_day_and_granules(tmp_path, monkeypatch, build_day):
    _clock(monkeypatch, build_day)
    items = [{"id": f"MCD43A4.A2026257.h{i:03d}.061.processing",
              "properties": {"datetime": "2026-09-14T00:00:00Z"},
              "assets": {b: {"href": f"https://example.org/{i}-{b}.tif"} for b, _ in se.MCD_BANDS}}
             for i in range(250)]
    identity = [(f["id"], [f["assets"][b]["href"] for b, _ in se.MCD_BANDS]) for f in items]
    digest = hashlib.sha256(json.dumps(identity, separators=(",", ":")).encode()).hexdigest()
    monkeypatch.setattr(se, "MCD_GRANULES_SHA256", digest, raising=False)
    p = tmp_path / "items.json"
    p.write_text(json.dumps({"features": items, "links": []}))
    calls = []
    def fetch(url, subdir, name, **kwargs):
        calls.append((name, kwargs.get("params")))
        return p
    monkeypatch.setattr(se, "fetch", fetch)
    doy, selected, paths = se.mcd43_items()
    assert doy == "A2026257" and selected == items and paths == [p]
    assert calls == [("stac-A2026257-0.json", {"collections": se.MCD_COLLECTION,
                     "datetime": "2026-09-14T00:00:00Z", "limit": "1000"})]
    # A reprocessed granule of the same day must not silently change the input.
    items[0]["id"] += "-reprocessed"
    p.write_text(json.dumps({"features": items, "links": []}))
    with pytest.raises(ValueError, match="granule pin"):
        se.mcd43_items()


@pytest.mark.parametrize("build_day", ["2026-10-04", "2027-01-15"])
def test_night_and_water_ignore_service_defaults(tmp_path, monkeypatch, build_day):
    _clock(monkeypatch, build_day)
    p = tmp_path / "raw"
    monkeypatch.setattr(gb, "capabilities", lambda: p)
    monkeypatch.setattr(gb, "layer_info", lambda caps, layer: {
        "layer": layer, "default": "2027-01-14", "colormap": "test",
        "periods": ["2000-01-01/2027-01-14/P1D"]})
    monkeypatch.setattr(gb, "colormap", lambda url: gb.parse_colormap(url, _cmap_file(tmp_path)))
    monkeypatch.setattr(st, "level_shape", lambda level: (4, 8))
    monkeypatch.setattr(se, "centric_rows", lambda level: np.arange(4))
    calls = []
    def blocks(layer, day):
        calls.append((layer, day))
        return []
    monkeypatch.setattr(se, "_fetch_blocks", blocks)
    monkeypatch.setattr(se, "etopo_south", lambda: (np.zeros((1, 1)), p))
    monkeypatch.setattr(se, "dnb_rsr", lambda: (np.ones(1), p))
    monkeypatch.setattr(se, "cie_lamp", lambda *args: (np.ones(1), p))
    monkeypatch.setattr(se, "luminance_factors", lambda *args: [1.0] * 4)
    monkeypatch.setattr(se, "record", lambda path: {})
    monkeypatch.setattr(se, "_register_gibs", lambda ctx: se.SRC_GIBS)
    monkeypatch.setattr(se.sl, "register_dataset", lambda ctx, sid, *args, **kwargs: sid)
    monkeypatch.setattr(se.sl, "write_layer", lambda ctx, spec, *args: spec)
    night = se.build_night(None)
    mask = se.WaterMask()
    assert calls == [(se.L_DNB, "2026-10-02"), (se.L_WATER, "2015-01-01"),
                     (se.L_SEAICE, "2026-10-02")]
    assert night.constants["sourceDate"] == "2026-10-02"
    water = se.build_water(None, mask)
    assert water.constants["seaIceDate"] == "2026-10-02"
    assert water.constants["waterMaskYear"] == "2015"


def _cmap_file(tmp_path):
    p = tmp_path / "map.xml"
    p.write_text(CMAP)
    return p

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


def test_coverage_weighted_coarse_levels():
    # a bright known strip next to unknown texels: the 'any' rule lets it grow, 'half' keeps the known area
    a = np.zeros((4, 8, 1), np.float32)
    known = np.zeros((4, 8), bool)
    a[:, :3], known[:, :3] = 2.0, True           # 3 of 8 columns known
    a[:, 3:5], known[:, 3:5] = 1.0, True         # and 2 more darker ones
    out, cover = st.downsample2_cover(a, known.astype(np.float32))
    assert cover[0].tolist() == [1.0, 1.0, 0.5, 0.0]
    assert out[0, :, 0].tolist() == [2.0, 1.5, 1.0, 0.0]
    out2, cover2 = st.downsample2_cover(out, cover)
    # the second level is the mean over the known top-level texels inside it: 12 at 2.0 and 4 at 1.0
    assert cover2[0].tolist() == [1.0, 0.25] and out2[0, 0, 0] == pytest.approx((2 * 6 + 1 * 2) / 8)
    assert out2[0, 1, 0] == pytest.approx(1.0)


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
    p.write_text(CMAP, encoding="utf-8", newline="\n")
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
    p.write_text(CMAP.replace('rgb="20,0,0"', 'rgb="10,0,0"'), encoding="utf-8", newline="\n")
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
    e = json.loads(download._LEDGER.read_text(encoding="utf-8"))["t/part"]
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
    return json.loads(p.read_text(encoding="utf-8"))


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


def test_earth_wind_layer():
    h = _header("wind")
    a = _top(h)
    asc, mean, n = a[..., 0], a[..., 1], a[..., 2]
    fin = np.isfinite(mean)
    assert 0.4 < h["coverage"]["areaFraction"] < 0.72          # ocean only; gaps between swaths and in rain
    assert ((mean[fin] >= 0) & (mean[fin] < 50)).all() and 5 < np.nanmean(mean) < 10
    assert np.isfinite(asc).sum() <= fin.sum() and ((n[fin] >= 1) & (n[fin] <= 4)).all()
    wh = _header("water")
    w = _top(wh)[..., 0]
    step = 2 ** (wh["maxLevel"] - h["maxLevel"])
    wl = w.reshape(w.shape[0] // step, step, w.shape[1] // step, step).mean(axis=(1, 3))
    assert (wl[fin] > 0.5).mean() > 0.97                       # the winds are over water
    assert "12.5 m" in h["constants"]["coxMunk"]["height"]


# ------------------------------------------------------------------------------------------------ cloud τ moments


def test_ln_tau_at_the_geometric_bin_centre():
    lo, hi = np.array([0.01, 1.0, 100.001]), np.array([1.0, 1.038, 150.0])
    cm = gb.Colormap("t", np.array([1, 2, 3]), lo, hi, 0.5 * (lo + hi), np.zeros(3, bool), np.zeros(3, int), ["x"],
                     np.array([], np.int64), None)
    vs, lns = se._ln_bin_centres(cm)
    cot = np.array([0.5 * (0.01 + 1.0), np.nan, 0.5 * (100.001 + 150.0)], np.float32)
    ln = se._ln_of(cot, vs, lns)
    assert ln[0] == pytest.approx(np.log(0.1), abs=1e-6) and np.isnan(ln[1])
    assert ln[2] == pytest.approx(0.5 * (np.log(100.001) + np.log(150.0)), abs=1e-5)
    with pytest.raises(ValueError, match="bin centre"):
        se._ln_of(np.array([7.0], np.float32), vs, lns)


def test_tau_moments_are_exact_under_the_pyramid_means():
    rng = np.random.default_rng(1)
    ln = rng.normal(2.0, 0.8, (4, 4, 16)).astype(np.float32)
    ln[rng.random((4, 4, 16)) < 0.4] = np.nan              # samples without a retrieval
    ice = rng.random((4, 4, 16)) < 0.3
    m = se.tau_moments(ln, ice)
    f, m1, m2, fi = (m[..., k] for k in range(4))
    np.testing.assert_allclose(f, np.isfinite(ln).mean(-1))
    np.testing.assert_allclose(m1 / f, np.nanmean(ln, -1), rtol=1e-5)
    np.testing.assert_allclose(m2 / f - (m1 / f) ** 2, np.nanvar(ln, -1), atol=1e-4)
    assert (fi <= f).all()
    # the 2×2 mean of four texels' moments is the moments of their pooled samples (what a coarser level holds)
    pooled = se.tau_moments(ln[:2, :2].reshape(1, 1, 64), ice[:2, :2].reshape(1, 1, 64))[0, 0]
    np.testing.assert_allclose(m[:2, :2].mean(axis=(0, 1)), pooled, rtol=1e-5)


def test_plane_albedo_from_the_moments():
    mu0, one = 0.7, np.ones(1)
    tau = np.array([2.0, 8.0, 30.0, 0.5])
    ipa = se.cloud_plane_albedo(tau, se.G_LIQUID, mu0).mean()
    ln = np.log(tau)
    a = se._TauDiagnostics.approximations(one, one * ln.mean(), one * (ln ** 2).mean(), one * tau.mean(), 0 * one, mu0)
    assert a["linearMeanTau"][0] > ipa                     # the plane-parallel bias (R is concave in τ)
    assert abs(a["logNormal3"][0] - ipa) < abs(a["logMeanTau"][0] - ipa) < abs(a["linearMeanTau"][0] - ipa)
    # a single thickness: all three are the plane albedo itself, scaled by the retrieved fraction
    b = se._TauDiagnostics.approximations(0.5 * one, 0.5 * one * np.log(8), 0.5 * one * np.log(8) ** 2, 4 * one,
                                          0 * one, mu0)
    for v in b.values():
        assert v[0] == pytest.approx(0.5 * se.cloud_plane_albedo(8.0, se.G_LIQUID, mu0), rel=1e-6)


def test_plane_albedo_check_sums_and_report():
    rng = np.random.default_rng(2)
    h, w = 32, 64
    ln = rng.normal(1.5, 1.0, (h, w, 16)).astype(np.float32)
    ln[rng.random((h, w, 16)) < 0.5] = np.nan
    ice = rng.random((h, w, 16)) < 0.2
    m = se.tau_moments(ln, ice)
    has = np.isfinite(ln)
    tau = np.where(has, np.exp(np.where(has, ln, 0)), 0)
    mu0 = np.linspace(0.2, 0.9, h).astype(np.float32)
    g = np.where(ice, se.G_ICE, se.G_LIQUID)
    ipa = np.where(has, se.cloud_plane_albedo(tau, g, mu0[:, None, None]), 0).sum(-1) / 16
    lat, lon = np.linspace(-20, 20, h), np.linspace(120, 170, w)
    d = se._TauDiagnostics()
    d.add_block(lat, lon, np.minimum(m[..., 0] + 0.2, 1), m[..., 0], m[..., 1], m[..., 2], tau.sum(-1) / 16, m[..., 3],
                ipa, mu0)
    r = d.report()
    assert set(r) == {"global", "swath", "global.level0", "swath.level0"}
    assert 0 < r["global"]["cloudyShareWithoutTau"] < 1
    for key in r:
        assert r[key]["linearMeanTau"]["ratioToIpa"] > 1
        assert abs(r[key]["logNormal3"]["ratioToIpa"] - 1) < abs(r[key]["linearMeanTau"]["ratioToIpa"] - 1)


def test_cloud_day_is_checked_against_the_advertised_periods():
    info = {"periods": ["2023-12-06/2024-04-15/P1D", "2024-09-23/2026-09-28/P1D"]}
    assert se._serves(info, "2026-09-28") and se._serves(info, "2024-01-01")
    assert not se._serves(info, "2024-06-01") and not se._serves(info, "2026-09-29")


def test_earth_cloud_tau_layer():
    h, c = _header("cloudTau"), _header("clouds")
    assert h["constants"]["sourceDate"] == c["constants"]["sourceDate"] == se.CLOUD_DAY
    a, cl = _top(h), _top(c)
    f, m1, m2, fi = (a[..., k] for k in range(4))
    ok = np.isfinite(f)
    assert (ok == np.isfinite(cl[..., 0])).all()           # same coverage (the daylit band)
    assert (f[ok] <= cl[..., 0][ok] + 1e-3).all() and (fi[ok] <= f[ok] + 1e-3).all()
    # cloudy with no retrieval at all (opticalThickness NaN) is exactly where the retrieved fraction is 0
    no_tau = ok & np.isnan(cl[..., 1])
    assert (f[no_tau] == 0).all() and (cl[..., 0][no_tau] > 0).all()
    pos = ok & (f > 0.2)
    mean_ln = m1[pos] / f[pos]
    assert (mean_ln > np.log(0.1) - 0.01).all() and (mean_ln < np.log(150) + 0.01).all()
    assert (m2[pos] / f[pos] - mean_ln ** 2 > -0.05).all()   # variance ≥ 0 up to float16 rounding
    d = h["diagnostics"]["planeAlbedoCheck"]
    assert 0 < d["swath"]["cloudyShareWithoutTau"] < 1
    # the population statistic for the share without a retrieval (cloud_pcl.py), estimated, with its sources
    u = h["constants"]["unmeasuredTau"]
    assert u["label"] == "estimated" and "pincus2023-modis-cosp" in u["sources"] and "pincus2023-modis-cosp" in h["sources"]
    u = u["value"]
    p = u["statistics"]["floorCellsZero"]["partlyCloudyAllHeights"]
    assert sum(p["binProbability"]) == pytest.approx(1, abs=1e-3) and len(p["binProbability"]) == len(u["tauBinEdges"]) - 1
    rows = u["planeAlbedoLiquid"]["rows"]
    assert all(0 < r["binSum"] < 0.5 for r in rows) and rows[0]["binSum"] > rows[-1]["binSum"]
    for key in ("global", "swath", "global.level0", "swath.level0"):
        assert d[key]["linearMeanTau"]["ratioToIpa"] >= 1  # plane-parallel bias
