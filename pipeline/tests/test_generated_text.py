"""Generated prose follows the implemented data, without changing scientific values."""
import copy
import json
import shutil
import sys

from pipeline.paths import OUT, REPO


def test_tno_completeness_discloses_separate_discovery_thinning():
    from pipeline.stages import synthetic as syn
    result = syn._order({"populations": {"tno": {
        "limit": {}, "extra": {"surveyVeto": {"method": "test discovery residual"}}}}})
    text = result["populations"]["tno"]["limit"]["uncertainty"]
    assert "proxy, not a detection probability" in text
    assert "CFEPS" in text and "published pointings" in text
    assert "without replacement" in text
    assert "Other surveys' histories" in text
    assert "No pointing history" not in text


def test_surface_report_describes_built_three_layer_cloud_admission():
    from pipeline import surf_report
    for name, label in (("clouds", "derived"), ("cloudTau", "derived"), ("cloudTauEstimated", "estimated")):
        h = json.loads((OUT / f"surfaces/399/{name}.json").read_text())
        assert h["sources"] == ["satcorps-gcc-geoleo"]
        assert h["brightness"]["label"] == label
    text = surf_report.generate()
    assert "SatCORPS" in text
    assert "Strict admits retrieved thickness" in text
    assert "Best/Complete also admit provider estimates" in text
    assert "cloud layer is unknown in polar night" not in text
    assert "Clouds are VIIRS NOAA-20" not in text
    assert "at that day's overpass" not in text


def test_photometry_report_distinguishes_classic_and_component_reflectance():
    from pipeline.photometry import report
    rings = json.loads((OUT / "rings.json").read_text())
    for key in ("599", "799", "899"):
        assert rings[key]["reflectance"]["label"] == "unknown"
        assert rings[key]["components"]["label"] == "estimated"
    text = report.generate()
    assert "classic profiles retain **unknown** reflectance" in text
    assert "**estimated** component models" in text
    assert "Uranus lambda and Neptune Galle remain unknown" in text
    assert "Jupiter's, Uranus's and Neptune's unknown" not in text
    assert "Jupiter's, Uranus's and Neptune's are **unknown**" not in text


def test_himawari_pinned_text_rebuild_preserves_science_and_artifact_bytes(tmp_path, monkeypatch):
    from pipeline import paths
    from pipeline.validation import build, reproducibility as repro
    from pipeline.validation.himawari import HIMAWARI
    old_dir = REPO / "validation/cases" / HIMAWARI.id
    old = json.loads((old_dir / "case.json").read_text())
    missing = [key for key in old["reproducibility"]["inputs"] if not repro.input_path(key).is_file()]
    if missing:
        raise FileNotFoundError("pinned validation inputs absent (no refetch): " + ", ".join(missing))
    cache = tmp_path / "cache"
    cache.mkdir()
    if (paths.CACHE / "validation").is_dir():
        shutil.copytree(paths.CACHE / "validation", cache / "validation")
    monkeypatch.setattr(paths, "CACHE", cache)
    monkeypatch.setattr(build, "CACHE", cache)
    # colour-science can leave a mock matplotlib module; astropy probes its spec.
    if "matplotlib" in sys.modules and getattr(sys.modules["matplotlib"], "__spec__", None) is None:
        monkeypatch.delitem(sys.modules, "matplotlib")
    built = build.build_case(HIMAWARI, expected=old, renew=True)
    new = built["json"]
    assert "SatCORPS" in new["notes"][0]
    assert "not a guarantee of identical clouds" in new["notes"][0]
    assert "existing budget has no cloud-variation term" in new["notes"][0]
    amended = copy.deepcopy(old)
    amended["notes"] = new["notes"]
    for before, after in zip(amended["rois"], new["rois"], strict=True):
        if before["id"].startswith("near-centre-"):
            assert "SatCORPS" in after["note"]
            assert "retrieval and actual strip time differ" in after["note"]
            before["note"] = after["note"]
    amended_dir = tmp_path / "amended"
    amended_dir.mkdir()
    (amended_dir / "case.json").write_text(json.dumps(amended))
    for name in ("reference.bin", "preview.png"):
        (amended_dir / name).write_bytes((old_dir / name).read_bytes())
    monkeypatch.setattr(build, "VALIDATION", tmp_path / "candidate")
    candidate = build.write_case(HIMAWARI.id, built)
    # Whole recursive JSON, including geometry, regions, values and tolerances,
    # is compared outside the deliberate notes and lock; artifact bytes are exact.
    repro.assert_renewal(amended_dir, candidate)
