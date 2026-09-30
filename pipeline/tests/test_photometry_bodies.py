"""photometry.json entries: schema shape, provenance rules, internal consistency, published comparisons."""

import math

import pytest

from pipeline.photometry import bodies, filters, phase, solar
from pipeline.photometry.common import read_table_csv
from pipeline.schema import BuildContext, LABEL_ORDER

NAIF = tuple(bodies.BODIES)     # planets, the Moon, Pluto and the major moons (moons: see test_photometry_moons.py)


@pytest.fixture(scope="module")
def built():
    ctx = BuildContext(0.0, 1.0)
    return ctx, bodies.build_all(ctx)


def _check_sourced(s, ctx):
    assert s["label"] in LABEL_ORDER
    assert (s["value"] is None) == (s["label"] == "unknown")
    if s["label"] != "unknown":
        assert s["sources"] and all(sid in ctx.sources for sid in s["sources"])
    assert s.get("method")      # unknown entries say why


def test_entries_match_schema(built):
    ctx, res = built
    out = bodies.photometry_json(res)
    assert sorted(out) == sorted(str(n) for n in NAIF)
    for key, e in out.items():
        assert set(e) == {"geometricAlbedoXYZS", "geometricAlbedoV", "phaseFunction"}
        for s in e.values():
            _check_sourced(s, ctx)
        v = e["geometricAlbedoXYZS"]["value"]
        if v is not None:
            assert len(v) == 4 and all(isinstance(x, float) and x > 0 for x in v)
            assert isinstance(e["geometricAlbedoV"]["value"], float)
        else:
            assert e["geometricAlbedoV"]["value"] is None
        pf = e["phaseFunction"]["value"]
        if pf is None:
            continue
        assert pf["kind"] in ("poly-mag", "tabulated", "lambert")
        if pf["kind"] == "poly-mag":
            assert set(pf) == {"kind", "coeffs", "minDeg", "maxDeg"} and pf["minDeg"] < pf["maxDeg"]
        if pf["kind"] == "tabulated":
            a = pf["alphaDeg"]
            assert set(pf) == {"kind", "alphaDeg", "deltaMag"} and len(a) == len(pf["deltaMag"])
            assert a[0] == 0.0 and all(y > x for x, y in zip(a, a[1:]))


def test_every_source_record_is_complete(built):
    ctx, _ = built
    for rec in ctx.sources.values():
        j = rec.to_json()
        assert j["citation"] and j["url"] and j["retrieved"]
        if rec.id != "edlen-1966":          # formula-only reference, nothing downloaded
            assert len(j.get("sha256", "")) == 64, rec.id


def test_labels_follow_propagation(built):
    _, res = built
    for r in res.values():
        e = r.entry
        # Computed values are never 'measured'.
        assert e["geometricAlbedoXYZS"]["label"] != "measured"
        assert e["geometricAlbedoV"]["label"] != "measured"
    assert res[799].entry["geometricAlbedoXYZS"]["label"] == "derived"
    assert res[599].entry["geometricAlbedoXYZS"]["label"] == "estimated"   # phase correction is an assumption
    assert res[399].entry["phaseFunction"]["label"] == "estimated"         # model-based curve


def test_phase_functions_start_at_zero(built):
    _, res = built
    for n, r in res.items():
        pf = r.entry["phaseFunction"]["value"]
        if pf is None:
            continue
        if n == 199:
            # Mercury: surge-exclusive polynomial referenced to the surge-inclusive V(1,0); valid from 2 deg.
            assert pf["minDeg"] == 2.0 and pf["coeffs"][0] == pytest.approx(0.081)
            assert phase.delta_mag(pf, 1.0) is None
            continue
        assert phase.delta_mag(pf, 0.0) == pytest.approx(0.0, abs=1e-9), n


def test_y_channel_matches_visual_albedo(built):
    """geometricAlbedoXYZS Y / sunlight Y is the photopic albedo; it must track p_V (same spectrum)."""
    _, res = built
    ey = solar.irradiance_xyzs()[1]
    for n, r in res.items():
        if r.xyzs is None:
            continue
        py = r.xyzs[1] / ey
        assert py == pytest.approx(r.p_v, rel=0.06), n


def test_consistency_with_published_v10(built):
    """V(1,0) implied by p_V and the pck radius vs Mallama & Hilton (2018). Reported, not tuned; the bounds only
    catch regressions. Earth's published value (-3.99, EPOXI + a model phase curve) disagrees by 0.75 mag with the
    DSCOVR-validated spectrum; see docs/reports/planet-colors.md."""
    _, res = built
    expected = {199: (-0.694, 0.05), 299: (-4.384, 0.03), 499: (-1.601, 0.03), 599: (-9.395, 0.04),
                699: (-8.95, 0.08), 899: (-7.00, 0.05), 399: (-3.99, 0.80)}
    for n, (pub, tol) in expected.items():
        assert abs(res[n].v10 - pub) < tol, (n, res[n].v10, pub)


def test_band_albedos_vs_mallama_2017(built):
    """Band-averaged albedos from our spectra vs Mallama et al. (2017) Table 7 (B, V, Rc) where our spectra are not
    themselves built from those numbers. Tolerances are regression bounds just above the measured disagreements,
    which are discussed in docs/reports/planet-colors.md: Venus B -20 % (Mallama's photometric B disagrees with
    his own synthetic B); Saturn Rc -20 % (globe at ring-plane crossing vs Mallama's system); Uranus/Neptune Rc
    +28/+15 % (1995 spectra vs 2000s photometry; strong seasonal/secular change in the red)."""
    _, res = built
    t = {int(r["planet"]): r for r in read_table_csv("mallama_2017_table7.csv")}
    tol = {199: 0.05, 599: 0.03, 299: 0.22, 699: 0.22, 799: 0.32, 899: 0.18}
    for n, rel in tol.items():
        s = res[n].spectrum
        for band, col in (("B", "B"), ("V", "V"), ("R", "Rc")):
            ours = filters.band_average(band, s.wl, s.p)
            assert ours == pytest.approx(float(t[n][col]), rel=rel), (n, band, ours, t[n][col])


def test_mars_reconstruction_reproduces_its_bands(built):
    _, res = built
    s = res[499].spectrum
    t = next(r for r in read_table_csv("mallama_2017_table7.csv") if r["planet"] == "499")
    for b in "UBVRI":
        assert filters.band_average(f"johnson.{b}", s.wl, s.p) == pytest.approx(float(t[b]), rel=1e-6)
    assert min(s.p) > 0


def test_pluto_reconstruction(built):
    _, res = built
    s = res[999].spectrum
    assert filters.band_average("V", s.wl, s.p) == pytest.approx(s.notes["p_V"], rel=1e-9)
    assert filters.band_average("B", s.wl, s.p) == pytest.approx(s.notes["p_B"], rel=1e-9)
    # Pluto alone, V(1,0) from Buie et al. (2010) and the NH-era radius
    assert res[999].v10 == pytest.approx(-0.620, abs=0.002)
    assert math.isclose(res[999].p_v, 0.555, abs_tol=0.005)
