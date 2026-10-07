"""Comets as they look: Haser profiles, dust colour from the measured colours, the measured band strengths against
their own fluorescence efficiencies, grain dynamics constants, the window magnitudes, and the built products."""

from __future__ import annotations

import json
import math
from pathlib import Path
from unittest.mock import Mock

import numpy as np
import pytest
from scipy import integrate

from pipeline import comet_model as cm
from pipeline import comet_sources as cs
from pipeline import comet_window as cw
from pipeline.download import RAW
from pipeline.paths import OUT
from pipeline.schema import BuildContext
from pipeline.stages import comets

HAVE_MODEL = (OUT / "comets" / "model.json").exists()
HAVE_LOWELL = (RAW / "comets" / "lowell-db" / "locdprod.tab").exists()
HAVE_MCD = (RAW / "comets" / "mcdonald" / "fluxmc.tab").exists()


# Isolate stage orchestration from downloads/physics; test products stay in tmp_path.
@pytest.fixture
def stage_env(tmp_path, monkeypatch):
    from pipeline import output

    monkeypatch.setattr(comets, "OUT", tmp_path)
    monkeypatch.setattr(output, "OUT", tmp_path)
    (tmp_path / "smallbodies").mkdir()
    (tmp_path / "smallbodies" / "photometry.json").write_text(json.dumps({
        "vSun": {"value": -26.74, "sources": ["test-sun"]},
        "sunIrradianceXYZS1AU": {"value": [1, 1, 1, 1]},
    }), encoding="utf-8")
    repo_paths = [tmp_path / name for name in ("report.json", "figure.svg", "fixture.json")]
    for attr, path in zip(("REPORT", "FIGURE", "FIXTURE"), repo_paths):
        path.write_bytes(b"previous repository file\n")
        monkeypatch.setattr(comets, attr, path)
    src_keys = ("lowell", "mcdonald", "lowellTools", "jorda-2008", "jewitt-2015-colors",
                "bhardwaj-raghuram-2012", "agarwal-2007-dust", "moreno-jehin-2025", "rousselot-2024-coplus",
                "cochran-2015-composition", "omni2-2024", "schleicher-2010-dust-phase", "opitom-2024-12p")
    tables = {"waterFromMagnitude": dict(a=1, b=1, qH2OPerQOH=1, rmsDex=1, rRangeAu=[1, 2]),
              "haserVelocity": {"kmS": 1},
              "oxygenRedDoublet": {"branching": {}, "wavelengthsNm": {}}}
    source_results = {
        "register": {k: k for k in src_keys}, "tables": tables, "read_lowell_db": {},
        "read_mcdonald": {"rows": [], "windows": {k: [1, 2] for k in
            ("C2 (delta NU = 0)", "C2 (delta NU = 1)", "CN (delta NU = 0)", "C3", "CH")}},
        "read_gfactors": {}, "read_haser": {}, "read_dust_phase": ([0, 1], [1, 1]),
        "read_omni_speed": np.array([400.0]),
    }
    model_results = {
        "lowell_ratios": {"comets": {}, "population": {}}, "mcdonald_band_ratios": {},
        "components": {"dust": {"test": {"xyzs": [1, 1, 1, 1], "v": 1, "normalizedGradientPer100nm": 0}}},
        "haser_tables": {}, "grains": {}, "oxygen_photons_per_h2o": 1, "co_plus": {},
        "cn_gfactor_table": {"C2": 1, "C3": 1, "vKmS": [0], "CN": [1]}, "dust_phase": {},
    }
    for module, results in ((cs, source_results), (cm, model_results)):
        for name, result in results.items():
            monkeypatch.setattr(module, name, lambda *args, _result=result, **kwargs: _result)
    monkeypatch.setattr(comets.cie, "register_sources", lambda ctx: [])
    monkeypatch.setattr(comets.filters, "register", lambda ctx, **kwargs: [])
    cat = {"names": ["test-spkid\t1P\tTest Comet\tP"], "rows": np.array([0]),
           "header": {"window": {"startEt": 0, "endEt": comets.DAY},
                      "forceModel": {"sun": {"gm": 1, "sources": ["test-gm"]}}}}
    peaks = [{"index": 0, "row": 0, "M1": 1, "K1": 1, "peakMag": 1, "peakEt": 0, "rAu": 1,
              "deltaAu": 1, "elongationDeg": 30, "perihelionEt": 0, "qAu": 1}]
    monkeypatch.setattr(cw, "load_comets", lambda path: cat)
    monkeypatch.setattr(cw, "window_curves", lambda *args, **kwargs: {
        "et": np.array([0, comets.DAY]), "m": np.ones((2, len(cat["names"])))})
    monkeypatch.setattr(cw, "peaks", lambda *args: peaks)
    horizons = Mock(return_value={"horizons": {"rows": []}, "ours": []})
    monkeypatch.setattr(comets, "horizons_fixture", horizons)
    ctx = BuildContext(0, comets.DAY, params={"build.writeRepoFiles": True})
    return ctx, repo_paths, cat, peaks, horizons


@pytest.mark.parametrize("existing", [False, True])
def test_stage_never_writes_committed_reference(stage_env, existing):
    ctx, paths, _, peaks, _ = stage_env
    if not existing:
        paths[2].unlink()
    comets.run(ctx)
    # A different build's showcase/epoch must not replace a committed reference.
    peaks[0]["peakEt"] += comets.DAY
    comets.run(ctx)
    if existing:
        assert paths[2].read_bytes() == b"previous repository file\n"
    else:
        assert not paths[2].exists()


def test_stage_preserves_repo_files_when_disabled(stage_env, tmp_path, capsys):
    ctx, paths, _, _, horizons = stage_env
    ctx.params["build.writeRepoFiles"] = False
    comets.run(ctx)
    assert all(p.read_bytes() == b"previous repository file\n" for p in paths)
    horizons.assert_not_called()
    assert set(ctx.products) == {"comets/model.json", "comets/list.json"}
    before = {key: (tmp_path / key).read_bytes() for key in ctx.products}
    assert "build.writeRepoFiles is off" in capsys.readouterr().out
    ctx.params["build.writeRepoFiles"] = True
    comets.run(ctx)
    assert all((tmp_path / key).read_bytes() == data for key, data in before.items())
    horizons.assert_called_once()


def test_stage_repo_writes_use_utf8_and_lf(stage_env, monkeypatch):
    ctx, paths, _, _, _ = stage_env
    write_text = Path.write_text
    writes = {}

    def checked_write(path, text, *args, **kwargs):
        if path in paths:
            writes[path] = kwargs
        return write_text(path, text, *args, **kwargs)

    monkeypatch.setattr(Path, "write_text", checked_write)
    comets.run(ctx)
    assert set(writes) == set(paths)
    for kwargs in writes.values():
        assert kwargs.get("encoding") == "utf-8"
        assert kwargs.get("newline") == "\n"
    assert "Δ" in paths[1].read_text(encoding="utf-8")


@pytest.mark.parametrize("reason", ["empty", "elongation", "fragment", "faint"])
@pytest.mark.parametrize("write_repo", [False, True])
def test_stage_without_qualifying_showcase(stage_env, tmp_path, capsys, reason, write_repo):
    ctx, paths, cat, peaks, horizons = stage_env
    ctx.params["build.writeRepoFiles"] = write_repo
    if reason == "empty":
        peaks.clear()
    elif reason == "elongation":
        peaks[0]["elongationDeg"] = 29.9
    elif reason == "fragment":
        cat["names"][0] = "test-spkid\t1P-A\tTest Fragment\tP"
    else:
        peaks[0]["peakMag"] = 12.1
    comets.run(ctx)
    assert set(ctx.products) == {"comets/model.json", "comets/list.json"}
    lst = json.loads((tmp_path / "comets/list.json").read_text(encoding="utf-8"))
    assert lst["showcase"] is None
    assert len(lst["notable"]) == (1 if reason in ("elongation", "fragment") else 0)
    horizons.assert_not_called()
    assert paths[2].read_bytes() == b"previous repository file\n"
    out = capsys.readouterr().out
    assert "no showcase" in out
    if write_repo:
        report = json.loads(paths[0].read_text(encoding="utf-8"))
        assert report["showcase"] is None and report["horizonsCheck"] == []
        assert paths[1].read_text(encoding="utf-8").startswith("<svg")
        assert "fixture.json not refreshed" in out
    else:
        assert all(p.read_bytes() == b"previous repository file\n" for p in paths)


def test_stage_keeps_showcase_criteria_and_brightest_selection(stage_env, tmp_path):
    ctx, _, cat, peaks, horizons = stage_env
    # Brighter low-elongation and fragment comets must not displace the eligible comet at the boundary.
    cat["names"][:] = ["id\t1P\tNear Sun\tP", "id\t2P-A\tFragment\tP", "id\t3P\tEligible\tP"]
    p = peaks.pop()
    peaks.extend([{**p, "index": 0, "row": 0, "peakMag": -1, "elongationDeg": 29.9},
                  {**p, "index": 1, "row": 1, "peakMag": 0},
                  {**p, "index": 2, "row": 2, "peakMag": 12}])
    ctx.params["build.writeRepoFiles"] = False
    comets.run(ctx)
    lst = json.loads((tmp_path / "comets/list.json").read_text(encoding="utf-8"))
    assert lst["showcase"] == {"row": 2, "designation": "3P", "name": "Eligible",
                               "rule": "brightest notable comet with solar elongation >= 30 deg at peak, not a fragment"}
    assert len(lst["notable"]) == 3
    horizons.assert_not_called()


# ---------------------------------------------------------------------------------------------- Haser
def test_haser_enclosed_limits_and_monotone():
    x = np.logspace(-4, 2, 61)
    f = cm.haser_enclosed(22000 / 66000, x)
    assert f[0] < 1e-3 and f[-1] > 0.999
    assert np.all(np.diff(f) >= -1e-9)


def test_haser_enclosed_matches_column_density_integral():
    """Enclosed fraction = int_0^rho 2 pi rho' N(rho') d rho' / N_tot with N the line-of-sight column of the Haser
    daughter density (independent computation by direct integration)."""
    k = 13000 / 210000
    ld = 1.0

    def n(r):
        return (math.exp(-r / ld) - math.exp(-r / (k * ld))) / (4 * math.pi * r * r)

    def column(rho):
        return 2 * integrate.quad(lambda z: n(math.hypot(rho, z)), 0, np.inf, limit=200)[0]

    ntot = (1 - k) * ld          # int n 4 pi r^2 dr
    for x in (0.05, 0.3, 1.0, 3.0):
        direct = integrate.quad(lambda r: 2 * math.pi * r * column(r), 0, x, limit=200)[0] / ntot
        assert cm.haser_enclosed(k, np.array([x]))[0] == pytest.approx(direct, rel=2e-3, abs=2e-4)


# ---------------------------------------------------------------------------------------------- dust colour
def test_dust_reflectance_reproduces_colour_excess():
    """Sunlight x R(lambda) through the Bessell passbands gives the measured comet-minus-Sun colours (the reflectance
    is built from them; checks the construction, not the data)."""
    from pipeline.photometry import filters, solar
    col = {"BV": 0.78, "VR": 0.47, "RI": 0.42}
    sun = {"BV": 0.64, "VR": 0.35, "RI": 0.33}
    refl, _ = cm.dust_reflectance(col, sun)
    e = solar.spectrum().grid

    def band(b, spec):
        fw, ft = filters.passband(b)
        t = np.interp(cm.GRID, fw, ft, left=0.0, right=0.0)
        return (spec * t).sum()

    def colour(b1, b2):
        return -2.5 * math.log10(band(b1, e * refl) / band(b2, e * refl)) + 2.5 * math.log10(band(b1, e) / band(b2, e))

    assert colour("B", "V") == pytest.approx(0.14, abs=0.02)
    assert colour("V", "R") == pytest.approx(0.12, abs=0.02)


# ---------------------------------------------------------------------------------------------- data consistency
@pytest.mark.skipif(not HAVE_MCD, reason="McDonald survey not downloaded (run the comets stage)")
def test_mcdonald_c2_sequence_ratio_matches_efficiencies():
    """The measured flux ratio C2 (Delta v = +1) / (Delta v = 0) equals the ratio of the dataset's own fluorescence
    efficiencies (10^-12.62 / 10^-12.35) within 10 %: both bands see the same molecules."""
    m = cs.read_mcdonald()
    r = cm.mcdonald_band_ratios(m["rows"])["C2(1)"]["median"]
    g = 10 ** (-m["logLN"]["C2 (delta NU = 1)"]) / 10 ** (-m["logLN"]["C2 (delta NU = 0)"])
    assert r == pytest.approx(g, rel=0.1)


@pytest.mark.skipif(not HAVE_LOWELL, reason="Lowell database not downloaded (run the comets stage)")
def test_lowell_population_ratios_match_ahearn():
    """Population medians of the per-comet ratios are within the ranges A'Hearn et al. (1995) report for the
    'typical' class (log C2/OH ~ -2.4, CN/OH ~ -2.5, C3/OH ~ -3.6, Afrho/Q(OH) ~ -25.8 +- 0.5)."""
    p = cm.lowell_ratios(cs.read_lowell_db())["population"]
    assert -3.1 < p["C2"]["median"] < -2.2
    assert -2.9 < p["CN"]["median"] < -2.3
    assert -4.1 < p["C3"]["median"] < -3.3
    assert -26.3 < p["afrho"]["median"] < -24.8


def test_beta_constant_matches_cpr():
    """beta from L_sun, GM_sun and c (Agarwal et al. 2007, Eq. 9) against Moreno & Jehin's C_pr = 1.191e-3 kg m^-2:
    the same physics with an older solar luminosity (4 %)."""
    b = cm.beta_of_radius(np.array([1e-6]), 132712440041.279, 1000.0, 1.0)[0]
    assert b == pytest.approx(1.191e-3 / (2 * 1000.0 * 1e-6), rel=0.05)


def test_magnitudes_geometry():
    helio = np.array([[1.5 * cw.AU_KM, 0.0, 0.0]])
    earth = np.array([cw.AU_KM, 0.0, 0.0])
    m, r, d, el = cw.magnitudes(np.array([8.0]), np.array([10.0]), helio, earth)
    assert r[0] == pytest.approx(1.5)
    assert d[0] == pytest.approx(0.5)
    assert m[0] == pytest.approx(8.0 + 5 * math.log10(0.5) + 10 * math.log10(1.5))
    assert el[0] == pytest.approx(180.0)


# ---------------------------------------------------------------------------------------------- products
@pytest.mark.skipif(not HAVE_MODEL, reason="comets products not built")
def test_model_product():
    m = json.loads((OUT / "comets" / "model.json").read_text())
    for k in ("C2(0)", "C2(1)", "CN(0)", "C3", "CH", "OI6300", "OI6364", "COplus(2,0)", "COplus(3,0)"):
        b = m["components"]["bands"][k]
        assert b["xyzs"][1] >= 0 and b["v"] >= 0
    for name in ("waterFromMagnitude", "composition", "gFactors", "bandRatiosToC2", "haser",
                 "oxygen", "coPlus", "solarWind", "grains"):
        assert isinstance(m[name]["value"], dict)
        assert m[name]["label"] in ("measured", "estimated") and m[name]["sources"]
    # C2 Swan emission is green: y chromaticity above the Sun's
    xyz = m["components"]["bands"]["C2(0)"]["xyzs"]
    sun = m["components"]["sunV"]["xyzs1Au"]
    assert xyz[1] / sum(xyz[:3]) > sun[1] / sum(sun[:3])
    # dust redder than the Sun (x chromaticity)
    d = m["components"]["dust"]["longPeriod"]["xyzs"]
    assert d[0] / sum(d[:3]) > sun[0] / sum(sun[:3])
    assert m["oxygen"]["value"]["photonsPerH2O"] == pytest.approx(0.064 + 0.81 * 0.357)
    assert sum(m["coPlus"]["value"]["share"].values()) == pytest.approx(1.0)
    assert 300 < m["solarWind"]["value"]["medianKmS"] < 500


@pytest.mark.skipif(not HAVE_MODEL, reason="comets products not built")
def test_list_product():
    lst = json.loads((OUT / "comets" / "list.json").read_text())
    for activity in lst["measured"].values():
        assert activity["label"] == "derived" and activity["sources"]
        assert activity["value"]["key"] and all(n > 0 for n in activity["value"]["n"].values())
    mags = [n["peakMag"] for n in lst["notable"]]
    assert mags == sorted(mags) and all(m <= lst["notableMag"] for m in mags)
    best = next((n for n in lst["notable"] if n["elongationDeg"] >= comets.SHOWCASE_MIN_ELONGATION
                 and "-" not in n["designation"]), None)
    if best is None:
        assert lst["showcase"] is None
    else:
        assert lst["showcase"]["row"] == best["row"]
        assert lst["showcase"]["designation"] == best["designation"]
