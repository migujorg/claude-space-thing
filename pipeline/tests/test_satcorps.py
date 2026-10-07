"""SatCORPS Global Cloud Composite reducer (pipeline/satcorps.py): classes, strips, range reader, aggregation.

Every file here is a TEST FIXTURE written by the test itself with the product's variable names, packing and
chunking; no value of it reaches a data product."""
from __future__ import annotations

import http.server
import json
import threading

import h5py
import numpy as np
import pytest

from pipeline import download
from pipeline import satcorps as sc

GEO, LEO = 287, 321                    # Himawari-9, NOAA-20 VIIRS
PACK = {  # name: (dtype, scale, fill, valid range)
    "satellite_ID": ("u2", 1.0, 0, (1, 399)),
    "cloud_phase": ("u1", 1.0, 127, (0, 13)),
    "relative_time": ("i2", 1.0, -32768, (-32767, 32767)),
    "solar_zenith": ("i2", 0.01, -32768, (-18000, 18000)),
    "view_zenith": ("i2", 0.01, -32768, (-18000, 18000)),
    "relative_azimuth": ("i2", 0.01, -32768, (-18000, 18000)),
    "cloud_optical_depth": ("u2", 0.01, 65535, (1, 15000)),
    "cloud_top_height": ("u2", 0.001, 65535, (1, 25000)),
    "surface_type": ("u1", 1.0, 255, (1, 20)),
}


def attrs():
    return {n: {"scale": s, "fill": f, "valid": v} for n, (_, s, f, v) in PACK.items()}


def cells(**kw):
    """One row of cells: a daytime water cloud of thickness 5 seen by a geostationary imager far from the glint,
    over land, unless a keyword changes a field (scalars are broadcast)."""
    n = max((np.size(v) for v in kw.values()), default=1)
    base = {"satellite_ID": GEO, "cloud_phase": 1, "relative_time": 300, "solar_zenith": 3000, "view_zenith": 3000,
            "relative_azimuth": 9000, "cloud_optical_depth": 500, "cloud_top_height": 2000, "surface_type": 1}
    base.update(kw)
    return {k: np.broadcast_to(np.asarray(v, PACK[k][0]), (1, n)).copy() for k, v in base.items()}


# ------------------------------------------------------------------------------------------------ the class table


@pytest.mark.parametrize("change, expected", [
    ({}, sc.MEASURED),                                                    # daytime solar retrieval
    ({"cloud_phase": 2}, sc.MEASURED),                                    # ice
    ({"cloud_phase": 0}, sc.CLEAR),
    ({"cloud_phase": 4}, sc.CLEAR),
    ({"cloud_phase": 3}, sc.NO_THICKNESS),                                # cloudy, neither model fits
    ({"cloud_phase": 6}, sc.POSSIBLE),
    ({"cloud_phase": 7}, sc.POSSIBLE),
    ({"cloud_phase": 5}, sc.UNOBSERVED),                                  # bad input
    ({"cloud_phase": 13}, sc.UNOBSERVED),                                 # cleaned
    ({"cloud_phase": 127}, sc.UNOBSERVED),                                # fill inside coverage
    ({"satellite_ID": 0}, sc.UNOBSERVED),                                 # no source
    ({"cloud_optical_depth": 65535}, sc.NO_THICKNESS),                    # cloud class, no value
    ({"cloud_optical_depth": 0}, sc.NO_THICKNESS),                        # below the valid range
    ({"cloud_optical_depth": 15001}, sc.NO_THICKNESS),                    # above it
    ({"solar_zenith": 8200}, sc.ESTIMATED),                               # the documented night algorithm
    ({"solar_zenith": 8199, "satellite_ID": LEO}, sc.MEASURED),           # polar orbiter: day up to 82°
    ({"solar_zenith": 8200, "satellite_ID": LEO}, sc.ESTIMATED),
    ({"solar_zenith": 7525}, sc.ESTIMATED),                               # geostationary: qualified classes stop here
    ({"solar_zenith": 7524}, sc.MEASURED),
    ({"solar_zenith": 7525, "satellite_ID": LEO}, sc.MEASURED),
    ({"solar_zenith": -32768}, sc.ESTIMATED),                             # a value whose lighting is not stated
    # sun glint: view 30° from the vertical opposite the Sun at 30° is the mirror direction (Θ = 0 at φ = 0)
    ({"surface_type": 17, "relative_azimuth": 0}, sc.ESTIMATED),
    ({"surface_type": 17, "relative_azimuth": 0, "satellite_ID": LEO}, sc.MEASURED),   # only where it was seen
    ({"surface_type": 1, "relative_azimuth": 0}, sc.MEASURED),            # over land
    ({"surface_type": 17, "relative_azimuth": 9000}, sc.MEASURED),        # over water, 41° from the mirror direction
    ({"surface_type": 17, "relative_azimuth": 0, "cloud_phase": 6}, sc.POSSIBLE),
    ({"surface_type": 17, "relative_azimuth": 0, "cloud_phase": 4}, sc.CLEAR),
])
def test_class_table(change, expected):
    assert sc.classify(cells(**change), attrs())[0, 0] == expected


def test_an_unlisted_phase_code_is_an_error():
    with pytest.raises(ValueError, match="cloud_phase"):
        sc.classify(cells(cloud_phase=9), attrs())


def test_glint_angle_is_zero_in_the_mirror_direction_and_follows_the_files_azimuth_convention():
    # φ = 0 is the forward (mirror) side in the file: found by comparison with positions (docs/sources/satcorps-gcc.md)
    assert sc.glint_angle_deg(30.0, 30.0, 0.0) == pytest.approx(0.0, abs=1e-5)
    assert sc.glint_angle_deg(30.0, 30.0, 180.0) == pytest.approx(60.0)
    assert sc.glint_angle_deg(20.0, 50.0, 0.0) == pytest.approx(30.0)
    assert sc.glint_angle_deg(30.0, 30.0, 90.0) == pytest.approx(np.degrees(np.arccos(0.75)))   # 41.41°, outside the cone
    assert sc.glint_angle_deg(30.0, 30.0, -90.0) == pytest.approx(sc.glint_angle_deg(30.0, 30.0, 90.0))


# ------------------------------------------------------------------------------------------------ strips


def test_each_longitude_comes_from_the_hour_nearest_1330_local():
    s = sc.strips("2026-09-28")
    assert [x.hour for x in s] == list(range(24))
    lon = np.arange(-180 + 1 / 72, 180, 1 / 36)
    owner = np.full(lon.size, -1)
    for x in s:
        c = sc.columns(lon, x)
        assert (owner[c] == -1).all()                       # no longitude twice
        owner[c] = x.hour
        mid = 0.5 * (x.lon_west + x.lon_east)
        local = (x.hour + mid / 15.0) % 24.0
        assert local == pytest.approx(13.5)                 # the strip's centre is at 13:30 local at the file's hour
        assert x.lon_east - x.lon_west == 15.0
        assert "2026/09/28" in x.url and f"2026271.{x.hour:02d}00." in x.url
    assert (owner >= 0).all()                               # every longitude once
    # each cell's local solar time at its file's nominal hour is within half an hour of 13:30
    assert np.abs((owner + lon / 15.0) % 24.0 - 13.5).max() <= 0.5
    # the 24-hour cut: 23 UTC serves up to 150° W, 00 UTC serves from there westwards
    assert (s[23].lon_west, s[23].lon_east) == (-150.0, -135.0)
    assert (s[0].lon_west, s[0].lon_east) == (-165.0, -150.0)
    assert owner[np.searchsorted(lon, -150.0) - 1] == 0 and owner[np.searchsorted(lon, -150.0)] == 23
    assert (s[4].lon_west, s[4].lon_east) == (135.0, 150.0)   # 140.7° E at 04 UTC


# ------------------------------------------------------------------------------------------------ range reader


class _Handler(http.server.BaseHTTPRequestHandler):
    blob = b""
    by_name: dict[str, bytes] = {}
    requests: list[str] = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        rng = self.headers.get("Range")
        type(self).requests.append(rng or "")
        a, b = rng.removeprefix("bytes=").split("-")
        blob = self.by_name.get(self.path.rsplit("/", 1)[-1], self.blob)
        data = blob[int(a):int(b) + 1]
        self.send_response(206)
        self.send_header("Content-Range", f"bytes {a}-{int(a) + len(data) - 1}/{len(blob)}")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("ETag", '"fixture"')
        self.send_header("Last-Modified", "Wed, 30 Sep 2026 16:50:36 GMT")
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture
def server(tmp_path, monkeypatch):
    monkeypatch.setattr(download, "RAW", tmp_path / "raw")
    monkeypatch.setattr(download, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(download, "_LEDGER", tmp_path / "raw" / "_downloads.json")
    _Handler.requests = []
    _Handler.by_name = {}
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv
    srv.shutdown()


def write_file(path, fields: dict[str, np.ndarray], nlat=180, nlon=360, without=()):
    """A file with the product's layout: (1, lat, lon) packed variables, gzip + shuffle chunks, the same attributes."""
    with h5py.File(path, "w") as f:
        f.attrs["reference_time"] = "2026-09-28T04:00:00Z"
        f.attrs["version"] = "TEST FIXTURE"
        f.attrs["satellite_sources"] = "TEST FIXTURE"
        f.create_dataset("lat", data=(90.0 - (np.arange(nlat) + 0.5) * 180.0 / nlat).astype("f4"))
        f.create_dataset("lon", data=((np.arange(nlon) + 0.5) * 360.0 / nlon - 180.0).astype("f4"))
        f.create_dataset("granule_name_list", data=np.array([b"TEST.FIXTURE.GRANULE"], dtype="S32"))
        for name, (dt, scale, fill, valid) in PACK.items():
            if name in without:
                continue
            ds = f.create_dataset(name, data=fields[name].astype(dt)[None], chunks=(1, nlat // 2, nlon // 4),
                                  compression="gzip", compression_opts=5, shuffle=True)
            ds.attrs["scale_factor"] = np.array([scale], "f4")
            ds.attrs["_FillValue"] = np.array([fill], dt)
            ds.attrs["valid_range"] = np.array(valid, dt)


def test_a_strip_is_read_by_ranges_recorded_and_reused(server, tmp_path, monkeypatch):
    monkeypatch.setattr(sc, "META_BLOCK", 4096)             # the fixture file is small: small metadata blocks
    rng = np.random.default_rng(3)
    fields = {n: rng.integers(0, 120, (180, 360)).astype(dt) for n, (dt, *_r) in PACK.items()}
    src = tmp_path / "fixture.nc"
    write_file(src, fields)
    _Handler.blob = src.read_bytes()
    strip = sc.Strip(4, f"http://127.0.0.1:{server.server_port}/fixture.2026271.0400.nc", 135.0, 150.0)
    d = sc.read_strip(strip, pin=None)
    cols = slice(315, 330)                                    # 135° E … 150° E on a 1° grid
    for n in PACK:
        assert np.array_equal(d.arrays[n], fields[n][:, cols]), n
    assert d.lon.tolist() == pytest.approx(np.arange(135.5, 150, 1.0).tolist())
    assert d.attrs["cloud_optical_depth"] == {"scale": pytest.approx(0.01), "fill": 65535, "valid": (1, 15000)}
    assert d.remote == {"bytes": len(_Handler.blob), "etag": '"fixture"', "lastModified": "Wed, 30 Sep 2026 16:50:36 GMT"}
    assert d.granules == ["TEST.FIXTURE.GRANULE"] and d.reference_time == "2026-09-28T04:00:00Z"
    # every byte range is a raw file with a ledger entry naming its range and the remote file's validators
    ledger = json.loads(download._LEDGER.read_text(encoding="utf-8"))
    assert len(d.paths) == len(ledger) > 0
    for p in d.paths:
        e = ledger[download.ledger_key(p)]
        assert e["range"].startswith("bytes=") and e["remoteBytes"] == len(_Handler.blob) and e["etag"] == '"fixture"'
        a, b = (int(x) for x in e["range"].removeprefix("bytes=").split("-"))
        assert p.read_bytes() == _Handler.blob[a:b + 1]
    # not the whole file: the strip is a sixth of the longitudes of one chunk column
    assert sum(p.stat().st_size for p in d.paths) < 0.6 * len(_Handler.blob)
    # a second read asks the server for nothing and gives the same content
    n_requests = len(_Handler.requests)
    d2 = sc.read_strip(strip, pin=None)
    assert len(_Handler.requests) == n_requests and d2.digest == d.digest
    # a pin of another content, or of another remote file, is an error
    with pytest.raises(ValueError, match="pin"):
        sc.read_strip(strip, pin={**d.remote, "sha256": "0" * 64})
    with pytest.raises(ValueError, match="pin"):
        sc.read_strip(strip, pin={**d.remote, "etag": '"other"', "sha256": d.digest})
    assert sc.read_strip(strip, pin={**d.remote, "sha256": d.digest}).digest == d.digest


def test_the_mosaic_takes_each_strip_from_its_own_hours_file(server, tmp_path, monkeypatch):
    """24 fixture files, one per hour, each marking every cell with its hour: the mosaic's columns must carry the
    hour whose strip they lie in, with the counts and pins the header is written from."""
    monkeypatch.setattr(sc, "META_BLOCK", 4096)
    monkeypatch.setattr(sc, "PRODUCT_DIR", f"http://127.0.0.1:{server.server_port}/")
    base = {n: np.broadcast_to(v, (180, 360)).copy() for n, v in cells().items()}
    base["cloud_phase"][:100] = 4                              # clear in the north, measured cloud in the south
    base["satellite_ID"][100:110, :] = 0                       # a band with no source
    for h in range(24):
        f = dict(base)
        f["cloud_top_height"] = np.full((180, 360), 1000 + h, "u2")     # packed: (1000 + h) m
        f["relative_time"] = np.full((180, 360), 60 * h, "i2")
        path = tmp_path / f"h{h}.nc"
        write_file(path, f)
        _Handler.by_name[sc.file_url("2026-09-28", h).rsplit("/", 1)[-1]] = path.read_bytes()
    m = sc.mosaic("2026-09-28", None)
    assert m.cls.shape == (180, 360) and m.lon[0] == pytest.approx(-179.5) and m.lat[0] == pytest.approx(89.5)
    hour_of = (13 - np.floor(m.lon / 15.0).astype(int)) % 24              # h + λ/15 = 13.5 at the strip's centre
    assert np.array_equal(np.round(m.top_m[150] - 1000).astype(int), hour_of)
    assert (m.cls[:100] == sc.CLEAR).all() and (m.cls[110:] == sc.MEASURED).all() and (m.cls[100:110] == sc.UNOBSERVED).all()
    assert np.isnan(m.ln_tau[:110]).all() and np.allclose(m.ln_tau[110:], np.log(5.0), rtol=1e-6)
    info = m.info
    assert [s["fileHourUtc"] for s in info["strips"]] == list(range(24))
    assert all(s["sources"] == {"Himawari-9": {"cells": 170 * 15, "secondsFromNominal": [60 * s["fileHourUtc"]] * 2}}
               for s in info["strips"])
    assert info["cells"] == {"notObserved": 10 * 360, "clear": 100 * 360, "cloudMeasuredThickness": 70 * 360,
                             "cloudEstimatedThickness": 0, "possibleCloud": 0, "cloudWithoutThickness": 0}
    assert sum(s["cells"]["cloudMeasuredThickness"] for s in info["strips"]) == 70 * 360
    assert set(info["pins"]) == set(range(24)) and all(len(v["sha256"]) == 64 for v in info["pins"].values())
    assert len(info["files"]) == sum(s["rangesRead"] for s in info["strips"])
    # the pins it reports are the pins it accepts; a strip without one is an error
    assert np.array_equal(sc.mosaic("2026-09-28", info["pins"]).cls, m.cls)
    with pytest.raises(ValueError, match="no pin"):
        sc.mosaic("2026-09-28", {h: v for h, v in info["pins"].items() if h != 7})


def test_a_file_without_the_surface_type_takes_it_from_the_nearest_hour_that_has_one(server, tmp_path, monkeypatch):
    """One hour's file is of another processing run and holds no `surface_type` (2026-09-28, 20 UTC): the same
    columns of the next hour's file are read, recorded and pinned; any other missing variable is an error."""
    monkeypatch.setattr(sc, "META_BLOCK", 4096)
    monkeypatch.setattr(sc, "PRODUCT_DIR", f"http://127.0.0.1:{server.server_port}/")
    base = {n: np.broadcast_to(v, (180, 360)).copy() for n, v in cells(relative_azimuth=0).items()}   # in the mirror direction
    base["surface_type"][:, ::2] = 17                           # water in every other column: estimated there
    for h in range(24):
        path = tmp_path / f"h{h}.nc"
        write_file(path, base, without=("surface_type",) if h == 20 else ())
        _Handler.by_name[sc.file_url("2026-09-28", h).rsplit("/", 1)[-1]] = path.read_bytes()
    m = sc.mosaic("2026-09-28", None)
    assert (m.cls[:, ::2] == sc.ESTIMATED).all() and (m.cls[:, 1::2] == sc.MEASURED).all()   # also in the 20 UTC strip
    s20 = m.info["strips"][20]
    assert s20["surfaceTypeFrom"]["fileHourUtc"] == 21 and "2026271.2100." in s20["surfaceTypeFrom"]["url"]
    assert all("surfaceTypeFrom" not in s for i, s in enumerate(m.info["strips"]) if i != 20)
    pin = m.info["pins"][20]
    assert pin["surfaceType"]["fileHourUtc"] == 21 and len(pin["surfaceType"]["sha256"]) == 64
    assert np.array_equal(sc.mosaic("2026-09-28", m.info["pins"]).cls, m.cls)
    bad = {**m.info["pins"], 20: {k: v for k, v in pin.items() if k != "surfaceType"}}
    with pytest.raises(ValueError, match="surface_type"):
        sc.mosaic("2026-09-28", bad)
    write_file(tmp_path / "x.nc", base, without=("cloud_top_height",))
    _Handler.by_name[sc.file_url("2026-09-28", 5).rsplit("/", 1)[-1]] = (tmp_path / "x.nc").read_bytes()
    monkeypatch.setattr(download, "RAW", tmp_path / "raw2")
    monkeypatch.setattr(download, "_LEDGER", tmp_path / "raw2" / "_downloads.json")
    with pytest.raises(ValueError, match="cloud_top_height"):
        sc.mosaic("2026-09-28", None)


# ------------------------------------------------------------------------------------------------ aggregation


def _mosaic(cls, ln_tau=None, ice=None, top=None, nlat=36, nlon=72):
    cls = np.asarray(cls, np.uint8)
    lat = 90.0 - (np.arange(nlat) + 0.5) * 180.0 / nlat
    lon = (np.arange(nlon) + 0.5) * 360.0 / nlon - 180.0
    has = np.isin(cls, [sc.MEASURED, sc.ESTIMATED])
    return sc.Mosaic(lat=lat, lon=lon, cls=cls,
                     ln_tau=np.where(has, 1.0 if ln_tau is None else ln_tau, np.nan).astype(np.float32),
                     ice=np.zeros(cls.shape, bool) if ice is None else ice,
                     top_m=np.where(has, 2000.0 if top is None else top, np.nan).astype(np.float32))


def _edges(n_lat, n_lon):
    return 90.0 - np.arange(n_lat + 1) * 180.0 / n_lat, np.arange(n_lon + 1) * 360.0 / n_lon - 180.0


def test_area_overlap_conserves_every_class_share():
    rng = np.random.default_rng(5)
    cls = rng.integers(1, 6, (36, 72))                         # every observed class, no hole
    m = _mosaic(cls, ln_tau=rng.normal(1.0, 1.0, cls.shape), ice=rng.random(cls.shape) < 0.3,
                top=rng.uniform(500, 12000, cls.shape))
    lat_e, lon_e = _edges(20, 50)                              # a grid that does not nest in the source grid
    a = sc.aggregate(m, lat_e, lon_e)
    w_src = np.diff(np.sin(np.radians(_edges(36, 72)[0])))[:, None] * -1 * np.ones((1, 72)) / 72
    w_dst = np.diff(np.sin(np.radians(lat_e)))[:, None] * -1 * np.ones((1, 50)) / 50
    assert a["observed"] == pytest.approx(1.0, abs=1e-6)
    for name, code in (("clear", sc.CLEAR), ("measured", sc.MEASURED), ("estimated", sc.ESTIMATED),
                       ("possible", sc.POSSIBLE), ("noThickness", sc.NO_THICKNESS)):
        assert (w_dst * a[name]).sum() == pytest.approx((w_src * (cls == code)).sum(), rel=1e-6), name
    meas = cls == sc.MEASURED
    assert (w_dst * a["measuredLnTau"]).sum() == pytest.approx((w_src * np.where(meas, m.ln_tau, 0)).sum(), rel=1e-5)
    assert (w_dst * a["measuredLnTau2"]).sum() == pytest.approx((w_src * np.where(meas, m.ln_tau ** 2, 0)).sum(), rel=1e-5)
    both = np.isin(cls, [sc.MEASURED, sc.ESTIMATED])
    assert (w_dst * a["thicknessLnTau"]).sum() == pytest.approx((w_src * np.where(both, m.ln_tau, 0)).sum(), rel=1e-5)
    assert (w_dst * a["thicknessIce"]).sum() == pytest.approx((w_src * (both & m.ice)).sum(), rel=1e-6)
    assert (w_dst * a["topSum"]).sum() == pytest.approx((w_src * np.where(both, m.top_m, 0)).sum(), rel=1e-5)


def test_edges_that_coincide_leave_no_sliver():
    # 1/3 + 1/3 + 1/3 is not 1 in floating point: the cell beyond a shared edge must get no weight at all.
    src = np.cumsum(np.full(9, 1 / 3)) - 1 / 3            # edges 0, 1/3, …, 8/3 with rounding
    w = sc.overlap(src, np.array([0.0, 1.0, 2.0])).toarray()
    assert (w[0, 3:] == 0).all() and (w[1, :3] == 0).all() and (w[1, 6:] == 0).all()
    assert w.sum(axis=1) == pytest.approx(1.0, abs=1e-9)


def test_every_channel_is_exact_under_two_by_two_means():
    rng = np.random.default_rng(6)
    cls = rng.integers(1, 6, (36, 72))
    m = _mosaic(cls, ln_tau=rng.normal(1.0, 1.0, cls.shape))
    fine = sc.aggregate(m, *_edges(16, 32))
    coarse = sc.aggregate(m, *_edges(8, 16))
    lat_e = _edges(16, 32)[0]
    w = (np.diff(np.sin(np.radians(lat_e))) * -1)[:, None] * np.ones((1, 32))
    for k in ("measured", "estimated", "possible", "noThickness", "measuredLnTau", "measuredLnTau2", "thicknessLnTau2", "topSum"):
        pooled = (w * fine[k]).reshape(8, 2, 16, 2).sum(axis=(1, 3)) / w.reshape(8, 2, 16, 2).sum(axis=(1, 3))
        assert pooled == pytest.approx(coarse[k], rel=1e-5, abs=1e-7), k


def test_nothing_is_interpolated_across_a_hole():
    cls = np.full((36, 72), sc.MEASURED, np.uint8)
    cls[10:20, 20:40] = sc.UNOBSERVED                          # a hole 50° × 100°, cloud all round it
    cls[:, 60:] = sc.CLEAR
    m = _mosaic(cls)
    lat_e, lon_e = _edges(18, 36)                              # texels of two source cells: they nest
    a = sc.aggregate(m, lat_e, lon_e)
    hole = np.zeros((18, 36), bool)
    hole[5:10, 10:20] = True
    assert (a["observed"][hole] == 0).all() and a["observed"][~hole] == pytest.approx(1.0)
    layers = sc.layers(a)
    for name in ("clouds", "cloudTau", "cloudTauEstimated"):
        assert np.isnan(layers[name][hole]).all(), name       # unknown, not a value carried in from the rim
        assert np.isfinite(layers[name][~hole]).all(), name
    assert not layers["known"][hole].any() and layers["known"][~hole].all()
    # a texel half in the hole: its shares are of its observed half; a texel with less than half observed is unknown
    a2 = sc.aggregate(m, *_edges(18, 24))                      # 15° texels straddle the hole's edges at 20 and 40
    lay2 = sc.layers(a2)
    col = np.flatnonzero((a2["observed"][7] > 0) & (a2["observed"][7] < 1))
    assert col.size > 0
    for c in col:
        if a2["observed"][7, c] >= 0.5:
            assert lay2["clouds"][7, c, 0] == pytest.approx(1.0)        # all of what was seen is cloud
        else:
            assert np.isnan(lay2["clouds"][7, c]).all()


def test_layers_keep_the_groups_apart():
    cls = np.array([[sc.MEASURED, sc.ESTIMATED, sc.POSSIBLE, sc.NO_THICKNESS, sc.CLEAR, sc.UNOBSERVED]] * 2, np.uint8)
    ln = np.array([[np.log(4.0), np.log(9.0), 0, 0, 0, 0]] * 2)
    top = np.array([[1000.0, 9000.0, 0, 0, 0, 0]] * 2)
    ice = np.array([[False, True, False, False, False, False]] * 2)
    m = _mosaic(cls, ln_tau=ln, ice=ice, top=top, nlat=2, nlon=6)
    lay = sc.layers(sc.aggregate(m, *_edges(2, 6)))            # one texel per cell
    clouds, strict, best = lay["clouds"][0], lay["cloudTau"][0], lay["cloudTauEstimated"][0]
    assert clouds[:5, 0].tolist() == [1, 1, 1, 1, 0]           # every cloud class counts as cloud; clear is clear
    assert np.isnan(clouds[5]).all() and np.isnan(strict[5]).all() and np.isnan(best[5]).all()
    # Strict: a thickness only where it was retrieved from sunlight
    assert strict[:5, 0].tolist() == [1, 0, 0, 0, 0]
    assert strict[0, 1] == pytest.approx(np.log(4.0)) and strict[0, 2] == pytest.approx(np.log(4.0) ** 2) and strict[0, 3] == 0
    # Best adds the provider's estimated values, never the possible class or the cloud without a value
    assert best[:5, 0].tolist() == [1, 1, 0, 0, 0]
    assert best[1, 1] == pytest.approx(np.log(9.0)) and best[1, 3] == 1
    # the clouds layer's thickness and phase are those of the measured cells; its top is of every cell with a thickness
    assert clouds[0, 1] == pytest.approx(4.0) and np.isnan(clouds[1, 1]) and np.isnan(clouds[2, 1]) and clouds[4, 1] == 0
    assert clouds[0, 2] == pytest.approx(1000.0) and clouds[1, 2] == pytest.approx(9000.0) and np.isnan(clouds[3, 2])
    assert clouds[4, 2] == 0 and clouds[0, 3] == 0
