"""`shapes` stage: triangle meshes of irregular bodies (ShapeModelHeader in app/src/data/schema.ts).

Writes
  shapes/<id>.json + shapes/<id>.bin      one mesh with levels of detail per spacecraft- or radar-mapped body
  shapes/damit-index.json/.bin + shapes/damit.bin   every DAMIT lightcurve-inversion model (compact)
  shapes/index.json                      id → summary

Environment:
  SHAPES_ONLY=eros,bennu     rebuild only these catalogue keys (plus 'damit'); others' products are carried over
  SHAPES_KEEP_RAW=1          keep large source files (by default > 50 MB sources are deleted after conversion)
  SHAPES_REORIENT=1          only recompute the orientation blocks (and notes) of the existing headers from the
                             sources' kernels and spin files; meshes, DAMIT and the other products are kept
"""

from __future__ import annotations

import json
import os
import time

from .. import ephem_kernels, shape_build, shape_catalog, shape_damit
from ..output import write_json
from ..paths import OUT
from ..photometry.albedo import pck_radii
from ..schema import BuildContext

DEPENDS: tuple[str, ...] = ()


def _carry_over(ctx: BuildContext, rebuilt: set[str]) -> None:
    mpath = OUT / "manifest.json"
    if not mpath.exists():
        return
    for rel, entry in json.loads(mpath.read_text()).get("products", {}).items():
        if entry.get("stage") != "shapes" or rel == "shapes/index.json":
            continue
        stem = rel.split("/", 1)[1].split(".")[0]
        if stem not in rebuilt and (OUT / rel).exists():
            ctx.products.setdefault(rel, entry)


def reorient(ctx: BuildContext, only: set[str], pck11, index: dict) -> None:
    by_name = {b["name"]: k for k, b in index["bodies"].items()}
    headers = []
    for src in shape_catalog.ALL:
        if (only and src.key not in only) or src.name not in by_name:
            continue
        h = json.loads((OUT / "shapes" / f"{by_name[src.name]}.json").read_text())
        headers.append(shape_build.reorient_one(ctx, src, pck11, h))
    index["bodies"].update(shape_build.summarize(headers))
    _carry_over(ctx, set())
    write_json(ctx, "shapes/index.json", index, "shapes")


def run(ctx: BuildContext) -> None:
    t0 = time.time()
    only = {x.strip() for x in os.environ.get("SHAPES_ONLY", "").split(",") if x.strip()}
    keep_raw = os.environ.get("SHAPES_KEEP_RAW", "") == "1"
    pck11 = ephem_kernels.pck(ctx)
    radii = pck_radii()
    idx_path = OUT / "shapes" / "index.json"
    if os.environ.get("SHAPES_REORIENT", "") == "1":
        reorient(ctx, only, pck11, json.loads(idx_path.read_text()))
        return
    index = json.loads(idx_path.read_text()) if (only and idx_path.exists()) else {"bodies": {}}
    headers, rebuilt, timing = [], set(), {}
    for src in shape_catalog.ALL:
        if only and src.key not in only:
            continue
        t = time.time()
        h = shape_build.build_one(ctx, src, radii, pck11, keep_raw)
        headers.append(h)
        rebuilt.add(str(h["id"]))
        timing[src.key] = round(time.time() - t, 1)
    index["bodies"].update(shape_build.summarize(headers))
    if not only or "damit" in only:
        t = time.time()
        dh = shape_damit.build(ctx)
        rebuilt |= {"damit", "damit-index"}
        index["damit"] = {"file": "shapes/damit-index.json", "models": dh["count"], **dh["stats"],
                          "label": dh["provenance"]["label"]}
        timing["damit"] = round(time.time() - t, 1)
    if only:
        _carry_over(ctx, rebuilt)
    index["buildSeconds"] = {**index.get("buildSeconds", {}), **timing}
    index["notes"] = ("Meshes are in each body's own body-fixed frame (km); `orientation` in each header says which "
                      "rotation model that frame assumes and how far it is from the app's IAU/pck00011 frame. "
                      "DAMIT models are dimensionless unless size-calibrated: scale them by a measured diameter.")
    write_json(ctx, "shapes/index.json", index, "shapes")
    print(f"[shapes] stage time {time.time() - t0:.0f} s")
