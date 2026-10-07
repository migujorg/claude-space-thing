"""The narrative must be evidence from this run, rather than a remembered baseline."""
from copy import deepcopy
import json
import re

from pipeline.validation import report


def stub_run(offset=0, ss=4):
    expected, rendered, sigma = 113 + offset, 71 + offset, 3 + offset
    roi = {"id": "disk-centre", "expectedType": "value", "expected": [expected] * 4,
           "tolerance": [2 * sigma] * 4, "sigma": [sigma] * 4,
           "ratio": [rendered / expected] * 4, "deviationSigma": [(rendered - expected) / sigma] * 4,
           "rendered": {"mean": [rendered] * 4}, "pass": False, "failing": ["Y"]}
    ratio = {"numerator": "moon", "denominator": "earth", "expected": [0.213 + offset] * 4,
             "rendered": [0.171 + offset] * 4, "tolerance": [0.003 + offset] * 4,
             "pass": False, "failing": ["Y", "Z"]}
    return {"generatedAt": "2026-10-07T13:00:00Z", "git": "stub", "dataGeneratedAt": "data",
            "options": {"ss": ss, "reality": "best"}, "cases": [{"id": "earth-moon-epoxi-2008", "ss": ss,
            "scene": {"bodies": []}, "rois": [roi], "ratios": [ratio]}]}


def test_findings_numbers_and_verdicts_follow_two_runs():
    first, second = stub_run(), stub_run(200, ss=6)
    a = report.run_section(first, report.RUN_FINDINGS).split("**What the failures say.**")[1]
    b = report.run_section(second, report.RUN_FINDINGS).split("**What the failures say.**")[1]
    # Every measurement cell, including expected values, tolerance, relative error and sigma, must update.
    measurements = lambda section: [line for line in section.splitlines() if line.startswith("| `")]
    cells_a, cells_b = measurements(a), measurements(b)
    assert len(cells_a) == len(cells_b) == 3  # ROI Y and ratio Y/Z
    for row_a, row_b in zip(cells_a, cells_b):
        for x, y in zip(row_a.split("|")[4:-1], row_b.split("|")[4:-1]):
            assert x != y
    assert "71" in a and "271" in b
    second["cases"][0]["rois"][0]["pass"] = True
    second["cases"][0]["ratios"][0]["pass"] = True
    changed = report.run_section(second, report.RUN_FINDINGS).split("**What the failures say.**")[1]
    assert "No failing rows in valid frames." in changed
    # Old baselines, software-renderer comparisons and sampling claims must not survive in the prose.
    assert not any(s in a for s in ("152.5", "7011", "0.0981", "14 of the 47", "Lambert →"))


def test_tally_names_regions_sky_limits_and_ratio_rows():
    run = stub_run()
    c = run["cases"][0]
    c["rois"] += [{"id": "sky", "expectedType": "upper-limit", "upperLimit": [1] * 4,
                   "rendered": {"mean": [0] * 4}, "pass": True, "failing": []},
                  {"id": "unknown", "expectedType": "none", "rendered": {"mean": [0] * 4},
                   "pass": None, "failing": []}]
    text = report.run_section(run, "")
    assert "Regions: 1 pass, 1 fail, 0 not rendered, 1 not compared" in text
    assert "Brightness regions: 0 pass, 1 fail" in text
    assert "Sky upper limits: 1 pass, 0 fail" in text
    assert "Ratio rows: 0 pass, 1 fail, 0 not rendered, 0 not compared" in text
    assert "2 failing rows: 1 region and 1 ratio row" in text


def test_report_has_no_stale_sampling_without_sweep(tmp_path, monkeypatch):
    dest = tmp_path / "report.md"
    monkeypatch.setattr(report, "REPORT", dest)
    monkeypatch.setattr(report, "CONVERGENCE_REPORT", tmp_path / "absent.json")
    monkeypatch.setattr(report, "CONVERGENCE_HISTORY_REPORT", tmp_path / "absent-history.json", raising=False)
    monkeypatch.setattr(report, "findings", lambda cases: "")
    for ss in (3, 6):
        report.write(run=stub_run(ss=ss), run_interpretation=report.RUN_FINDINGS)
        text = dest.read_text()
        assert f"{ss} × {ss} samples per pixel" in text
        grids = re.findall(r"[1-6] × [1-6](?= samples per pixel| per pixel)", text)
        assert grids and set(grids) == {f"{ss} × {ss}"}
        assert "Sampling convergence" not in text and "History: sampling" not in text


def test_historical_sweep_is_dated_and_uses_finest_valid_frame(tmp_path):
    runs = []
    for ss, mean in ((1, 80), (2, 95), (3, 0), (4, 100), (6, 0)):
        r = stub_run(ss=ss)
        r["git"] = "old-commit"
        c = r["cases"][0]
        c["rois"][0]["rendered"]["mean"] = [mean] * 4
        c["ratios"] = []
        if ss in (3, 6):
            c["status"] = "not rendered"
            c["rois"][0].update(pass_=None)
            c["rois"][0]["pass"] = None
        runs.append(r)
    path = tmp_path / "history.json"
    path.write_text(json.dumps({"schema": "validation-sampling-v1", "runs": runs}))
    text = report.sampling_history_section(stub_run(ss=4), path)
    assert "History: sampling sweep" in text
    assert "old-commit" in text and "2026-10-07" in text
    assert "| 1 × 1 | 25" in text and "| 2 × 2 | 5" in text
    assert "| 3 × 3 | —" in text and "| 6 × 6 | —" in text
    assert "finest valid level is 4 × 4" in text
    assert "Current run sampling 4 × 4" in text
