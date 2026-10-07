"""Remeasure named sky rows from a case's saved reference and view, without refitting.

From the repository root, using the existing pipeline environment:

    PIPELINE_OFFLINE=1 pipeline/.venv/bin/python scripts/remeasure_validation_sky.py \
        --case neptune-voyager2-1989:sky-far --output /tmp/sky-review

Use --write instead of --output to update the original case directories. Repeat
--case CASE:ROW[,ROW] for multiple cases. This is a maintenance operation, NOT a
fresh stock case build: only named sky rows and the annotated preview can change.
All other rows (including disk tolerances), metadata, fits, view and reference
bytes are checked for exact preservation in staged write_case output before it
is copied to the destination. The generated timestamp and index stay unchanged.
Existing pipeline raw inputs/products needed by measure must be available; this
command never prepares native frames, resamples references or fits pointing.

Only sky rows are supported: surface rows need spectral shapes and case-specific
annotations that cannot in general be reconstructed from the saved case alone.
"""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import tempfile

import numpy as np

from pipeline.schema import BuildContext, SourceRecord
from pipeline.validation import build, geometry as g, photometry as vp, roi
from pipeline.validation.cases import CASES


def prepared_from_case(case: dict, refs: list[np.ndarray], specs: list[roi.RoiSpec]) -> build.Prepared:
    """Restore the measured camera/body geometry; use FLAT only for sky rows."""
    cam = case["view"]["camera"]
    view = g.Camera(np.array(cam["orient"]).reshape(3, 3), cam["width"], cam["height"], cam["pixelPitchRad"])
    targets = [g.Target(b["naifId"], b["name"], np.array(b["pos"]), np.array(b["orient"]).reshape(3, 3),
                        np.array(b["toSun"]), np.array(b["radii"]),
                        rings=build._rings(b["naifId"]) if b["rings"] else None)
               for b in case["view"]["bodies"]]
    ctx = BuildContext(0., 0.)
    for source in case["sources"]:
        ctx.add_source(SourceRecord(**source))
    obs = case["observation"]
    return build.Prepared(
        id=case["id"], title=case["title"], summary=case["summary"], instrument=obs["instrument"],
        observer_name=obs["observer"], observer_id=obs["observerHorizonsId"], targets=targets, view=view,
        refs=refs, bands=case["reference"]["bands"], img_meta=obs["images"], ctx=ctx,
        calibration_sigma=obs["calibration"]["sigmaRel1"], calibration_note=obs["calibration"]["note"],
        calibration_sources=obs["calibration"]["sources"], roi_specs=specs, shape=vp.FLAT,
        pixel=obs["pixel"], notes=case["notes"], reference_image=obs["referenceImage"],
        epoch_utc=case["view"]["epochUtc"], et=case["view"]["et"])


def verify_preservation(before: dict, after: dict, rows: set[str], reference: bytes, written: bytes) -> None:
    """Reject any write_case change outside the explicitly named rows."""
    if reference != written:
        raise ValueError("reference bytes changed")
    untouched_before = copy.deepcopy(before)
    untouched_after = copy.deepcopy(after)
    for case in (untouched_before, untouched_after):
        case["rois"] = [r if r["id"] not in rows else {"id": r["id"]} for r in case["rois"]]
    if untouched_before != untouched_after:
        raise ValueError("unnamed rows or case metadata changed")


def remeasure_case(case_dir: Path, row_ids: list[str], output_root: Path) -> dict:
    case = json.loads((case_dir / "case.json").read_text(encoding="utf-8"))
    cid = case["id"]
    rows = set(row_ids)
    if not rows or len(rows) != len(row_ids):
        raise ValueError("name at least one sky row, without duplicates")
    specs = {s.id: s for s in CASES[cid].rois}
    saved = {r["id"]: r for r in case["rois"]}
    for name in rows:
        if name not in saved or name not in specs:
            raise ValueError(f"{cid}: unknown row {name}")
        if specs[name].kind not in ("sky-near", "sky-far") or saved[name]["kind"] != specs[name].kind:
            raise ValueError(f"{cid}: {name} is not a sky row")
    reference = (case_dir / "reference.bin").read_bytes()
    refs = list(np.frombuffer(reference, dtype="<f4").reshape(case["reference"]["shape"]))
    selected_specs = [s for s in specs.values() if s.id in rows]
    measured = build.measure(prepared_from_case(case, refs, selected_specs))
    selected = {r["id"]: r for r in measured["json"]["rois"]}
    if selected.keys() != rows:
        raise ValueError(f"{cid}: measure did not return exactly the named rows")
    for r in selected.values():
        if r["expected"]["type"] != "upper-limit" or any(
                b["iof"]["n"] != b["iof"]["nInRect"] for b in r["bands"]):
            raise ValueError(f"{cid}: {r['id']} is not a fully recorded upper limit")
    updated = copy.deepcopy(case)
    updated["rois"] = [selected.get(r["id"], r) for r in updated["rois"]]
    rects = [roi.Roi(specs[r["id"]], tuple(r["rect"])) for r in updated["rois"]]
    # Let the project's writer round numbers and draw the preview, then verify
    # its actual serialized output before overwriting any original artifact.
    with tempfile.TemporaryDirectory(prefix="remeasure-validation-sky-") as tmp:
        original_root = build.VALIDATION
        try:
            build.VALIDATION = Path(tmp)
            staged = build.write_case(cid, {"json": updated, "refs": refs, "rois": rects})
        finally:
            build.VALIDATION = original_root
        actual = json.loads((staged / "case.json").read_text(encoding="utf-8"))
        verify_preservation(case, actual, rows, reference, (staged / "reference.bin").read_bytes())
        destination = output_root / "cases" / cid
        destination.mkdir(parents=True, exist_ok=True)
        for filename in ("case.json", "reference.bin", "preview.png"):
            (destination / filename).write_bytes((staged / filename).read_bytes())
    return {"case": cid, "rows": row_ids, "output": str(destination),
            "changes": [{"row": r["id"], "oldRect": saved[r["id"]]["rect"], "newRect": r["rect"],
                         "upperLimitXYZS": r["expected"]["upperLimitXYZS"]}
                        for r in actual["rois"] if r["id"] in rows],
            "unnamedRowsAndMetadataIdentical": True, "referenceBytesIdentical": True}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--case", action="append", required=True, metavar="CASE:ROW[,ROW]")
    parser.add_argument("--validation", type=Path, default=build.VALIDATION, help="input validation root")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--output", type=Path, help="write review artifacts to this validation root")
    mode.add_argument("--write", action="store_true", help="update input cases after preservation checks")
    args = parser.parse_args()
    results = []
    for selection in args.case:
        cid, sep, names = selection.partition(":")
        if not sep or cid not in CASES:
            parser.error(f"expected a known CASE:ROW[,ROW], got {selection!r}")
        results.append(remeasure_case(args.validation / "cases" / cid, names.split(","),
                                      args.validation if args.write else args.output))
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
