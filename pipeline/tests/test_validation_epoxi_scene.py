"""EPOXI regional weather is diagnostic; the whole disk still tests brightness."""
import copy
import json
import shutil

from pipeline.paths import REPO
from pipeline.validation import build, report, reproducibility
from pipeline.validation.cases import EARTH_MOON


def test_epoxi_scene_annotation_rebuild_changes_only_two_fields_and_lock(tmp_path, monkeypatch):
    from pipeline import paths
    cache = tmp_path / "cache"
    cache.mkdir()
    if (paths.CACHE / "validation").is_dir():
        shutil.copytree(paths.CACHE / "validation", cache / "validation")
    monkeypatch.setattr(paths, "CACHE", cache)
    monkeypatch.setattr(build, "CACHE", cache)
    old_dir = REPO / "validation/cases/earth-moon-epoxi-2008"
    old = json.loads((old_dir / "case.json").read_text())
    built = build.build_case(EARTH_MOON, expected=old, renew=True)
    centre = next(q for q in built["json"]["rois"] if q["id"] == "earth-centre")
    dependence = centre["sceneDependence"]
    assert dependence["sources"]
    for text in ("2008-05-29", "2026-09-28", "one region", "weather", "19:30 PDT",
                 "two to eight times too bright", "pass to fail", "not on either verdict"):
        assert text in dependence["reason"]
    disk = next(q for q in built["json"]["rois"] if q["id"] == "earth-disk-integrated")
    assert "sceneDependence" not in disk
    ratio = next(q for q in built["json"]["ratios"] if q["numerator"] == "earth-centre")
    assert ratio["sceneDependence"] == dependence
    # The recursive renewal comparison rejects any other JSON or artifact byte change.
    expected = copy.deepcopy(old)
    next(q for q in expected["rois"] if q["id"] == "earth-centre")["sceneDependence"] = dependence
    next(q for q in expected["ratios"] if q["numerator"] == "earth-centre")["sceneDependence"] = dependence
    amended = tmp_path / "amended"
    amended.mkdir()
    (amended / "case.json").write_text(json.dumps(expected))
    for name in ("reference.bin", "preview.png"):
        (amended / name).write_bytes((old_dir / name).read_bytes())
    monkeypatch.setattr(build, "VALIDATION", tmp_path / "candidate")
    candidate = build.write_case(EARTH_MOON.id, built)
    reproducibility.assert_renewal(amended, candidate)


def test_committed_epoxi_rows_are_listed_and_excluded_from_brightness_and_ratios():
    case = json.loads((REPO / "validation/cases/earth-moon-epoxi-2008/case.json").read_text())
    rois = [{"id": q["id"], "expectedType": q["expected"]["type"], "pass": True,
             **({"sceneDependence": q["sceneDependence"]} if "sceneDependence" in q else {})}
            for q in case["rois"]]
    ratios = [{"numerator": q["numerator"], "denominator": q["denominator"], "pass": True,
               **({"sceneDependence": q["sceneDependence"]} if "sceneDependence" in q else {})}
              for q in case["ratios"]]
    run = {"cases": [{"id": case["id"], "rois": rois, "ratios": ratios}]}
    assert "Brightness regions: 2 pass, 0 fail" in report.tally_lines(run)
    assert "Ratio rows: 0 pass, 0 fail" in report.tally_lines(run)
    assert "Scene-dependent rows: 3 pass, 0 fail" in report.tally_lines(run)
