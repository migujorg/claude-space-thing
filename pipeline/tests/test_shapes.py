"""Shape models: mesh utilities, and checks on the built products (skipped when `shapes` has not been built)."""

import json
import math

import numpy as np
import pytest

from pipeline import shape_mesh as sm
from pipeline.paths import OUT

# ------------------------------------------------------------------------------------------------ utilities


def _cube():
    v = np.array([[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)], float)
    f = np.array([[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1],
                  [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]])
    return sm.Mesh(v, f)


def test_cube_integrity_and_orientation():
    m = sm.orient_outward(_cube())
    assert sm.signed_volume(m) == pytest.approx(8.0)
    assert sm.area(m) == pytest.approx(24.0)
    r = sm.edge_report(m)
    assert r["watertight"] and r["eulerCharacteristic"] == 2
    flipped = sm.Mesh(m.v, m.f[:, ::-1])
    assert sm.signed_volume(sm.orient_outward(flipped)) == pytest.approx(8.0)
    broken = sm.Mesh(m.v, m.f[:-1])
    assert not sm.edge_report(broken)["watertight"] and sm.edge_report(broken)["boundaryEdges"] == 3


def test_weld_merges_seam_duplicates():
    m = _cube()
    v = np.vstack([m.v, m.v[:4]])                   # duplicate four vertices and use them in two faces
    f = m.f.copy()
    f[0] = [8, 9, 11]
    w = sm.weld(sm.Mesh(v, f))
    assert w.nv == 8 and w.nf == 12 and sm.edge_report(sm.orient_outward(w))["watertight"]


def test_radius_grid_sphere():
    lat, lon = np.meshgrid(np.arange(-90, 91, 2.0), np.arange(0, 360, 2.0), indexing="ij")
    m = sm.orient_outward(sm.from_radius_grid(lat.ravel(), lon.ravel(), np.full(lat.size, 10.0)))
    assert sm.edge_report(m)["watertight"]
    assert sm.signed_volume(m) == pytest.approx(4 / 3 * math.pi * 1000, rel=2e-3)
    # east longitude: the vertex at lat 0, lon 90 lies on +y
    i = np.argmin(np.linalg.norm(m.v - [0, 10, 0], axis=1))
    assert np.linalg.norm(m.v[i] - [0, 10, 0]) < 1e-9


def test_decimation_and_binary_round_trip():
    lat, lon = np.meshgrid(np.arange(-90, 91, 2.0), np.arange(0, 360, 2.0), indexing="ij")
    r = 10 + np.sin(np.radians(lon.ravel())) * np.cos(np.radians(lat.ravel()))
    m = sm.orient_outward(sm.from_radius_grid(lat.ravel(), lon.ravel(), r))
    d = sm.orient_outward(sm.decimate(m, m.nf // 4))
    assert abs(d.nf - m.nf // 4) < 0.05 * m.nf and sm.edge_report(d)["watertight"]
    assert sm.signed_volume(d) == pytest.approx(sm.signed_volume(m), rel=5e-3)
    buf, desc = sm.pack_lod(d)
    back = sm.unpack_lod(buf, {"offset": 0, **desc})
    assert np.array_equal(back.f, d.f) and np.allclose(back.v, d.v, atol=1e-5)
    n = np.frombuffer(buf, "<i2", desc["normals"]["count"] * 3, desc["normals"]["offset"]).reshape(-1, 3) / 32767
    assert np.allclose(np.linalg.norm(n, axis=1), 1, atol=1e-3)
    # normals point outward (positive dot product with the radius vector on a star-shaped body)
    assert (np.einsum("ij,ij->i", n, d.v) > 0).mean() > 0.99


def test_fin_cancellation():
    m = sm.orient_outward(_cube())
    v = np.vstack([m.v, [[0.0, 0.0, 3.0]]])
    # a back-to-back pair of triangles hanging off edge 0-1 (as an edge collapse can leave) and a repeated face
    f = np.vstack([m.f, [[0, 1, 8], [0, 8, 1]], m.f[:1]])
    assert not sm.edge_report(sm.Mesh(v, f))["watertight"]
    c = sm.weld(sm.Mesh(v, sm.cancel_fins(f)))
    assert c.nv == 8 and c.nf == 12 and sm.edge_report(c)["watertight"]
    assert sm.signed_volume(c) == pytest.approx(8.0)


def test_plate_and_obj_readers(tmp_path):
    m = _cube()
    p = tmp_path / "cube.tab"
    p.write_text(f"{m.nv} {m.nf}\n" + "".join(f"{i + 1} {x} {y} {z}\n" for i, (x, y, z) in enumerate(m.v))
                 + "".join(f"{i + 1} {a + 1} {b + 1} {c + 1}\n" for i, (a, b, c) in enumerate(m.f)), encoding="utf-8", newline="\n")
    assert np.array_equal(sm.read_plate_table(p).f, m.f)
    o = tmp_path / "cube.obj"
    o.write_text("".join(f"v {x} {y} {z}\n" for x, y, z in m.v) + "".join(f"f {a + 1} {b + 1} {c + 1}\n"
                                                                           for a, b, c in m.f), encoding="utf-8", newline="\n")
    assert np.allclose(sm.read_obj(o).v, m.v)


# ------------------------------------------------------------------------------------------------ products

INDEX = OUT / "shapes" / "index.json"
HEADERS = sorted((OUT / "shapes").glob("[0-9]*.json")) if (OUT / "shapes").exists() else []

# measured shapes whose volume-equivalent radius differs from the reference by more than 10 %, with the reason
SCALE_EXCEPTIONS = {
    20000243: "pck00011's Ida radii (26.8 × 12.0 × 7.6 km) give a smaller volume than the Thomas et al. (1996) "
              "shape itself (16 100 km³)",
    20000216: "the Ostro et al. (2000) radar model is ~10 % smaller than the adaptive-optics size in SBDB",
    50012415: "SBDB now gives 11 m for 1998 KY26 (Santana-Ros et al. 2025); the 1999 radar model is ~30 m",
    20002063: "SBDB's Bacchus diameter is NEOWISE's thermal-model 1.02 km; the radar model is 1.11 × 0.53 × 0.51 km",
    20004179: "SBDB's 5.4 km for Toutatis is a 1994 pre-radar compilation value; the model matches Hudson & Ostro 1995",
    20004769: "SBDB's 1.4 km for Castalia is a 1994 pre-radar compilation value",
    20052246: "SBDB's Donaldjohanson diameter is NEOWISE's thermal-model 3.9 km (Masiero et al. 2011); the Lucy shape "
              "spans 8.8 × 4.4 × 3.1 km, as the flyby images show (~8 km × 3.5 km)",
}


def _load(p):
    h = json.loads(p.read_text(encoding="utf-8"))
    return h, (OUT / h["bin"]).read_bytes()


@pytest.mark.skipif(not HEADERS, reason="shapes not built")
@pytest.mark.parametrize("path", HEADERS, ids=[p.stem for p in HEADERS])
def test_mesh_products(path):
    h, buf = _load(path)
    assert len(buf) == sum(lod["bytes"] for lod in h["lods"])
    prev = None
    for lod in h["lods"]:
        m = sm.unpack_lod(buf, lod)
        assert m.nf == lod["triangles"] and m.nv == lod["vertices"]
        assert m.f.min() >= 0 and m.f.max() < m.nv
        assert np.isfinite(m.v).all()
        assert lod["triangles"] <= 2_000_000
        if prev is not None:
            assert lod["triangles"] < prev
        prev = lod["triangles"]
        rep = sm.edge_report(m)
        assert rep["watertight"] == lod["watertight"], (h["name"], lod["level"])
        src = h["source"]["integrity"]
        if src["watertight"]:
            if src["genus"] == 0:
                assert lod["watertight"], (h["name"], lod["level"])
            elif not lod["watertight"]:
                # decimating below the size of a source's handles merges surfaces: allowed, flagged, and small
                assert sum(lod["defectEdges"].values()) < 20, (h["name"], lod["level"], lod["defectEdges"])
                assert any(f"LOD {lod['level']}" in n for n in h["notes"])
            assert sm.signed_volume(m) > 0
            assert abs(lod["volumeRatioToSource"] - 1) < 0.02
    assert h["provenance"]["label"] in ("measured", "derived", "estimated")
    assert h["orientation"]["label"] in ("measured", "derived", "estimated", "unknown")
    sc = h["scaleCheck"]
    if sc and h["provenance"]["label"] == "measured" and h["id"] not in SCALE_EXCEPTIONS:
        assert abs(sc["ratio"] - 1) < 0.1, (h["name"], sc)


def _header(obj_id):
    p = OUT / "shapes" / f"{obj_id}.json"
    if not p.exists():
        pytest.skip(f"shapes/{obj_id} not built")
    h, buf = _load(p)
    return h, sm.unpack_lod(buf, h["lods"][0])


def _latlon(v):
    r = np.linalg.norm(v, axis=1)
    return np.degrees(np.arcsin(v[:, 2] / r)), np.degrees(np.arctan2(v[:, 1], v[:, 0])), r


def _axis_angles(m):
    w, vec = sm.principal_axes(m)
    return (math.degrees(math.acos(min(1.0, abs(vec[0, 0])))), math.degrees(math.acos(min(1.0, abs(vec[2, 2])))))


def test_principal_axes_of_a_box():
    v = np.array([[x, y, z] for x in (-3, 3) for y in (-2, 2) for z in (-1, 1)], float) + [5, -1, 2]
    f = _cube().f
    w, vec = sm.principal_axes(sm.orient_outward(sm.Mesh(v, f)))
    vol = 6 * 4 * 2
    assert np.allclose(w, [vol * 9 / 3, vol * 4 / 3, vol * 1 / 3])      # ∫x² dV = V a²/3 for a box of half-size a
    assert np.allclose(abs(vec), np.eye(3))


def test_phobos_frame():
    h, m = _header(401)
    lat, lon, r = _latlon(m.v)
    # the long axis points at Mars (IAU longitude 0° is the sub-Mars point) and the short axis is the spin axis
    long_x, short_z = _axis_angles(m)
    assert long_x < 5 and short_z < 5, (long_x, short_z)
    # Stickney (IAU Gazetteer 1.0°S, 49.0°W = 311°E, diameter ~9 km) is a depression ~1-2 km below its rim
    c = np.radians([-1.0, -49.0])
    u = np.array([math.cos(c[0]) * math.cos(c[1]), math.cos(c[0]) * math.sin(c[1]), math.sin(c[0])])
    ang = np.degrees(np.arccos(np.clip(m.v @ u / r, -1, 1)))
    centre = r[ang < 5].mean()
    rim = r[(ang > 22) & (ang < 30)].mean()
    assert rim - centre > 0.5, (centre, rim)


def test_bennu_equatorial_ridge_on_the_equator():
    h, m = _header(20101955)
    lat, lon, r = _latlon(m.v)
    bins = np.arange(-60, 61, 5)
    mean_r = [r[(lat >= a) & (lat < a + 5)].mean() for a in bins[:-1]]
    peak = bins[int(np.argmax(mean_r))] + 2.5
    assert abs(peak) <= 7.5, (peak, mean_r)


def test_eros_long_axis_along_x():
    h, m = _header(20000433)
    ext = m.v.max(axis=0) - m.v.min(axis=0)
    assert np.argmax(ext) == 0 and ext[0] > 2 * ext[2]


# principal-axis rotators with well-separated moments: the short axis of the shape must be the frame's +z (spin) axis
@pytest.mark.parametrize("obj_id", [401, 20000433, 20025143, 20000243, 20486958, 1000012, 20002867, 20000004,
                                    20101955, 20162173, 20000021, 615, 610])
def test_short_axis_is_the_spin_axis(obj_id):
    h, m = _header(obj_id)
    w, vec = sm.principal_axes(m)
    assert w[1] / w[2] > 1.1, "moments too similar for this check"
    assert _axis_angles(m)[1] < 6, (h["name"], _axis_angles(m))


@pytest.mark.skipif(not (OUT / "shapes" / "damit-index.json").exists(), reason="DAMIT not built")
def test_damit_table():
    from pipeline.sb_table import read_table
    h, rec = read_table(OUT / "shapes" / "damit-index.json")
    assert h["count"] > 15000 and h["provenance"]["label"] == "derived"
    ids, counts = np.unique(rec["spkid"], return_counts=True)
    pref = rec["preferred"] == 1
    assert np.array_equal(np.unique(rec["spkid"][pref]), ids) and pref.sum() == ids.size
    assert (rec["spkid"] == 20000000 + rec["number"]).all()
    assert int((rec["closed"] == 0).sum()) == h["stats"]["notWatertight"] < 10
    blob = (OUT / h["meshBin"]).read_bytes()
    # Pallas (2 Pallas → SPK-ID 20000002): a size-calibrated convex model of ~500 km
    row = rec[(rec["spkid"] == 20000002) & pref][0]
    nv, nf, off = int(row["vertexCount"]), int(row["triangleCount"]), int(row["dataOffset"])
    v = np.frombuffer(blob, "<i2", nv * 3, off).reshape(-1, 3) / 32767 * row["scale"]
    ioff = off + (nv * 6 + 3) // 4 * 4
    f = np.frombuffer(blob, "<u2", nf * 3, ioff).reshape(-1, 3).astype(np.int64)
    m = sm.Mesh(v.astype(float), f)
    assert sm.edge_report(m)["watertight"] and sm.signed_volume(m) > 0
    req = sm.equivalent_radius(sm.signed_volume(m))
    assert req == pytest.approx(row["equivalentRadius"], rel=1e-3)
    if row["sizeCalibrated"]:
        assert 230 < req < 290


@pytest.mark.skipif(not (OUT / "shapes" / "damit-index.json").exists(), reason="DAMIT not built")
@pytest.mark.parametrize("spkid, pole_ra, pole_dec", [
    (20000433, 11.35, 17.22),      # Eros (pck00011, from NEAR)
    (20000004, 309.031, 42.235),   # Vesta (pck00011, from Dawn)
    (20000021, 52.0, 12.0),        # Lutetia (pck00011, from Rosetta)
])
def test_damit_pole_convention(spkid, pole_ra, pole_dec):
    """DAMIT's (λ, β) are ecliptic J2000 pole coordinates: rotated to the equator, the closest of an asteroid's
    models must land within a few degrees of the spacecraft-measured pole."""
    from pipeline.sb_table import read_table
    h, rec = read_table(OUT / "shapes" / "damit-index.json")
    rows = rec[rec["spkid"] == spkid]
    if rows.size == 0:
        pytest.skip(f"no DAMIT model for {spkid}")
    eps = math.radians(23.4392911)
    ra, de = math.radians(pole_ra), math.radians(pole_dec)
    p_eq = np.array([math.cos(de) * math.cos(ra), math.cos(de) * math.sin(ra), math.sin(de)])
    best = 180.0
    for row in rows:
        la, be = math.radians(float(row["lambdaDeg"])), math.radians(float(row["betaDeg"]))
        x, y, z = math.cos(be) * math.cos(la), math.cos(be) * math.sin(la), math.sin(be)
        q = np.array([x, math.cos(eps) * y - math.sin(eps) * z, math.sin(eps) * y + math.cos(eps) * z])
        best = min(best, math.degrees(math.acos(float(np.clip(q @ p_eq, -1, 1)))))
    assert best < 10.0, best


def test_equivalent_constants_reproduce_a_pck_frame():
    from pipeline import shape_orient as so
    from pipeline.paths import RAW
    pck = RAW / "naif" / "pck00011.tpc"
    if not pck.exists():
        pytest.skip("pck00011 not downloaded")
    eq = so.equivalent_constants([pck], "IAU_EROS")
    assert eq["POLE_RA"][0] == pytest.approx(11.35, abs=1e-6)
    assert eq["POLE_DEC"][0] == pytest.approx(17.22, abs=1e-6)
    assert eq["PM"][0] == pytest.approx(326.07, abs=1e-5)
    assert eq["PM"][1] == pytest.approx(1639.38864745, abs=1e-7)
