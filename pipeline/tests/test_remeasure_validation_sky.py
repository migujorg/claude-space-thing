"""Maintenance remeasurement must preserve everything outside explicitly named sky rows."""

import copy
import importlib.util
import json
from pathlib import Path
import shutil

import pytest

from pipeline.paths import REPO
from pipeline.validation import build

spec = importlib.util.spec_from_file_location("remeasure_validation_sky", REPO / "scripts/remeasure_validation_sky.py")
maintenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)


@pytest.fixture
def saved_case(tmp_path, monkeypatch):
    cid = "neptune-voyager2-1989"
    case_dir = tmp_path / "input" / "cases" / cid
    shutil.copytree(REPO / "validation" / "cases" / cid, case_dir)
    original = json.loads((case_dir / "case.json").read_text())
    row = copy.deepcopy(next(r for r in original["rois"] if r["id"] == "sky-far"))
    row["rect"] = [30, 20, 35, 25]
    row["expected"] = {"type": "upper-limit", "label": "derived", "upperLimitXYZS": [1., 2., 3., 4.]}
    for band in row["bands"]:
        band["iof"]["n"] = band["iof"]["nInRect"]
    # Inject unrelated newly measured metadata: it must never reach the output.
    monkeypatch.setattr(build, "measure", lambda prepared: {
        "json": {"generated": "replacement timestamp", "view": {"refitted": True}, "rois": [row]}})
    monkeypatch.setattr(build, "preview", lambda path, *args: path.write_bytes(b"test preview"))
    return case_dir, original, row


def test_only_named_row_changes_and_reference_bytes_survive_writer(saved_case, tmp_path):
    case_dir, before, row = saved_case
    report = maintenance.remeasure_case(case_dir, ["sky-far"], tmp_path / "output")
    dest = Path(report["output"])
    after = json.loads((dest / "case.json").read_text())
    expected = copy.deepcopy(before)
    expected["rois"] = [row if r["id"] == "sky-far" else r for r in before["rois"]]
    assert after == expected                 # includes original generated, tolerances, fits and ratios
    assert (dest / "reference.bin").read_bytes() == (case_dir / "reference.bin").read_bytes()
    assert json.loads((case_dir / "case.json").read_text()) == before
    # A repeat in place is idempotent, including the serialized JSON and reference.
    first_json = (dest / "case.json").read_bytes()
    maintenance.remeasure_case(dest, ["sky-far"], tmp_path / "output")
    assert (dest / "case.json").read_bytes() == first_json


@pytest.mark.parametrize("rows, message", [
    (["disk-integrated"], "not a sky row"), (["missing"], "unknown row"),
    (["sky-far", "sky-far"], "without duplicates"), ([], "at least one sky row"),
])
def test_invalid_selection_does_not_write(saved_case, tmp_path, rows, message):
    with pytest.raises(ValueError, match=message):
        maintenance.remeasure_case(saved_case[0], rows, tmp_path / "output")
    assert not (tmp_path / "output").exists()


@pytest.mark.parametrize("corruption", ["reference", "metadata", "unnamed-row"])
def test_preservation_failure_keeps_original_case_intact(saved_case, tmp_path, monkeypatch, corruption):
    case_dir, _, _ = saved_case
    original_files = {p.name: p.read_bytes() for p in case_dir.iterdir() if p.is_file()}
    writer = build.write_case

    def corrupt_writer(cid, built):
        dest = writer(cid, built)
        if corruption == "reference":
            (dest / "reference.bin").write_bytes(b"changed reference")
        else:
            case = json.loads((dest / "case.json").read_text())
            if corruption == "metadata":
                case["view"]["camera"]["pixelPitchRad"] *= 2
            else:
                next(r for r in case["rois"] if r["kind"] == "disk-integrated")["expected"]["tolerance"][0] *= 2
            (dest / "case.json").write_text(json.dumps(case))
        return dest

    monkeypatch.setattr(build, "write_case", corrupt_writer)
    validation_root = case_dir.parents[1]
    with pytest.raises(ValueError, match="changed"):
        maintenance.remeasure_case(case_dir, ["sky-far"], validation_root)
    assert {p.name: p.read_bytes() for p in case_dir.iterdir() if p.is_file()} == original_files


def test_missing_named_measurement_does_not_write(saved_case, tmp_path, monkeypatch):
    monkeypatch.setattr(build, "measure", lambda prepared: {"json": {"rois": []}})
    with pytest.raises(ValueError, match="exactly the named rows"):
        maintenance.remeasure_case(saved_case[0], ["sky-far"], tmp_path / "output")
    assert not (tmp_path / "output").exists()


def test_partial_upper_limit_does_not_write(saved_case, tmp_path):
    saved_case[2]["bands"][0]["iof"]["n"] -= 1
    with pytest.raises(ValueError, match="fully recorded upper limit"):
        maintenance.remeasure_case(saved_case[0], ["sky-far"], tmp_path / "output")
    assert not (tmp_path / "output").exists()
