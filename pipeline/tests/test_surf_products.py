"""Checks on the built surface products (skipped when `surfaces` has not been built).

Texel validity (no NaN / negative / infinite values), normalization (disk average 1 per channel at every level),
header ↔ tile consistency, and georeferencing against named features.
"""

import hashlib
import json
import math

import numpy as np
import pytest

from pipeline import surf_tiles as st
from pipeline.paths import OUT

HEADERS = sorted((OUT / "surfaces").glob("*/*.json")) if (OUT / "surfaces").exists() else []


def _header(naif, layer):
    p = OUT / "surfaces" / str(naif) / f"{layer}.json"
    if not p.exists():
        pytest.skip(f"surfaces/{naif}/{layer} not built")
    return json.loads(p.read_text(encoding="utf-8"))


def _level(h, level):
    fmt = "f16" if h["format"] == "float16" else "f32"
    return st.read_level(OUT, h["body"], h["layer"], level, len(h["channels"]), fmt)


@pytest.mark.skipif(not HEADERS, reason="surfaces not built")
@pytest.mark.parametrize("path", HEADERS, ids=[f"{p.parent.name}/{p.stem}" for p in HEADERS])
def test_layer_integrity(path):
    h = json.loads(path.read_text(encoding="utf-8"))
    listing = (OUT / h["tileListing"]).read_text(encoding="utf-8").splitlines()
    assert len(listing) == h["stats"]["tiles"]
    size = st.TILE * st.TILE * h["bytesPerTexel"]
    stored = {}
    for line in listing:
        sha, rel = line.split("  ")
        stored[rel] = sha
    missing = {(int(L), tx, ty) for L, v in h["missingTiles"].items() for tx, ty in v}
    for L in range(h["minLevel"], h["maxLevel"] + 1):
        ny, nx = st.tiles_shape(L)
        for ty in range(ny):
            for tx in range(nx):
                rel = h["tilePath"].format(level=L, ty=ty, tx=tx)
                assert (rel in stored) != ((L, tx, ty) in missing), rel
                if rel in stored:
                    p = OUT / rel
                    assert p.stat().st_size == size
    # hash a sample of tiles
    for rel in list(stored)[:: max(1, len(stored) // 50)]:
        assert hashlib.sha256((OUT / rel).read_bytes()).hexdigest() == stored[rel]
    for r in h["coverage"]["regions"]:
        assert r["brightness"]["label"] in ("measured", "derived", "estimated", "unknown")
    assert h["brightness"]["label"] in ("measured", "derived", "estimated")
    if h["kind"] == "relative-reflectance":
        assert h["channels"] == ["X", "Y", "Z", "S"]
        assert h["color"]["label"] in ("derived", "estimated")


@pytest.mark.skipif(not HEADERS, reason="surfaces not built")
@pytest.mark.parametrize("path", [p for p in HEADERS if json.loads(p.read_text(encoding="utf-8"))["kind"] == "relative-reflectance"],
                         ids=lambda p: p.parent.name)
def test_albedo_texels_valid_and_normalized(path):
    h = json.loads(path.read_text(encoding="utf-8"))
    for L in range(h["minLevel"], h["maxLevel"] + 1):
        a = _level(h, L)
        assert np.isfinite(a).all(), f"level {L}: non-finite texels"
        assert (a >= 0).all(), f"level {L}: negative texels"
        known = (a != 0).any(axis=2)
        # a known texel is positive in every channel
        assert (a[known] > 0).all()
        m = st.disk_mean(a, known, L)
        assert np.allclose(m, 1.0, atol=0.01), f"level {L}: disk mean {m}"
    assert np.allclose(h["normalization"]["texelDiskMeanCheck"], 1.0, atol=1e-3)


def _ring_mean(arr, level, lat0, lon0, r_in_km, r_out_km, radius_km):
    lat = np.radians(st.lat_centers(level))[:, None]
    lon = np.radians(st.lon_centers(level))[None, :]
    p0, l0 = math.radians(lat0), math.radians(lon0)
    c = np.sin(p0) * np.sin(lat) + np.cos(p0) * np.cos(lat) * np.cos(lon - l0)
    d = radius_km * np.arccos(np.clip(c, -1, 1))
    sel = (d >= r_in_km) & (d < r_out_km) & np.isfinite(arr) & (arr != 0)
    return float(arr[sel].mean())


def test_moon_tycho_is_a_crater_in_the_height_layer():
    h = _header(301, "height")
    z = _level(h, h["maxLevel"])[..., 0]
    floor = _ring_mean(z, h["maxLevel"], -43.3, -11.2, 0, 15, 1737.4)
    rim = _ring_mean(z, h["maxLevel"], -43.3, -11.2, 38, 48, 1737.4)
    # Tycho: ~86 km diameter, floor ~4.7 km below the rim
    assert rim - floor > 3000, (floor, rim)
    # and it is the deepest point of its neighbourhood (so the map is not shifted)
    assert floor < _ring_mean(z, h["maxLevel"], -43.3, -11.2, 60, 120, 1737.4) - 1500


def test_moon_tycho_and_crisium_in_the_albedo_layer():
    h = _header(301, "albedo")
    L = 4
    y = _level(h, L)[..., 1]
    tycho = _ring_mean(y, L, -43.3, -11.2, 0, 60, 1737.4)
    around = _ring_mean(y, L, -43.3, -11.2, 200, 400, 1737.4)
    assert tycho > 1.15 * around, (tycho, around)   # fresh bright ejecta
    crisium = _ring_mean(y, L, 17.0, 59.1, 0, 150, 1737.4)
    highland = _ring_mean(y, L, 17.0, 59.1, 350, 550, 1737.4)
    assert crisium < 0.8 * highland, (crisium, highland)  # dark mare basalt


def test_jupiter_great_red_spot_latitude():
    """The GRS is the reddest large feature: max of the smoothed X/Z ratio between 10°S and 35°S must be at the
    GRS latitude, 22.2°S planetographic = 19.6°S planetocentric (Simon et al. 2018, AJ 155, 151)."""
    from scipy.ndimage import uniform_filter
    h = _header(599, "albedo")
    L = h["maxLevel"]
    a = _level(h, L)
    known = (a != 0).any(axis=2)
    r = np.where(known, a[..., 0] / np.where(known, a[..., 2], 1), 0)
    k = uniform_filter(known.astype(float), (24, 48), mode="wrap")
    s = uniform_filter(r, (24, 48), mode="wrap") / np.maximum(k, 1e-6)
    lat = st.lat_centers(L)
    band = (lat < -10) & (lat > -35)
    s[~band] = -np.inf
    s[k < 0.9] = -np.inf
    j, i = np.unravel_index(np.argmax(s), s.shape)
    assert abs(lat[j] - (-19.6)) < 1.5, lat[j]


def test_ice_giant_coverage_follows_the_seasons():
    # 2025: Uranus shows its (IAU) north pole to Earth, Neptune its south pole
    for naif, hemi in ((799, 1), (899, -1)):
        h = _header(naif, "albedo")
        a = _level(h, h["maxLevel"])
        known = (a != 0).any(axis=2)
        lat = st.lat_centers(h["maxLevel"])
        north = known[lat > 45].mean()
        south = known[lat < -45].mean()
        assert (north - south) * hemi > 0.3, (naif, north, south)


@pytest.mark.skipif(not HEADERS, reason="surfaces not built")
def test_panchromatic_maps_pass_their_feature_checks():
    pans = [json.loads(p.read_text(encoding="utf-8")) for p in HEADERS]
    pans = [h for h in pans if h.get("diagnostics", {}).get("georeferencing")]
    if not pans:
        pytest.skip("no panchromatic maps built")
    for h in pans:
        g = h["diagnostics"]["georeferencing"]
        assert g["passed"] in (True, None), (h["bodyName"], g)
        # USGS 8-bit mosaics: brightness estimated (undocumented or inverted stretch); New Horizons MVIC colour maps
        # (Pluto, Charon): documented normal albedo, brightness measured
        want = "measured" if h["body"] in (999, 901) else "estimated"
        assert h["color"]["label"] == "estimated" and h["brightness"]["label"] == want, h["bodyName"]


def test_opal_longitude_direction_from_jet_drift():
    h = _header(599, "albedo")
    c = h["diagnostics"]["longitudeDirectionCheck"]
    assert c["passed"] and 2.0 < c["eastwardShiftDeg"] < 7.0, c


def test_opal_limb_cut_recorded():
    for naif in (599, 699, 799, 899):
        h = _header(naif, "albedo")
        cut = h["diagnostics"]["limbCut"]
        lo, hi = cut["keptPlanetographicLatitudes"]
        assert hi - lo <= 2 * 72.5 + 1 and lo <= cut["subEarthLatitudeDeg"] <= hi
