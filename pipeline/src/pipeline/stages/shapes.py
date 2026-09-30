"""`shapes` stage: triangle meshes of irregular bodies (ShapeModelHeader in app/src/data/schema.ts).

Writes
  shapes/<id>.json + shapes/<id>.bin      one mesh with levels of detail per spacecraft- or radar-mapped body
  shapes/damit-index.json/.bin + shapes/damit.bin   every DAMIT lightcurve-inversion model (compact)
  shapes/index.json                      id → summary

Build parameters (pipeline/config.py; `build --set key=value`, or the environment variable):
  shapes.damit=0             do not build the DAMIT collection (1.4 GB download); the index then has no `damit`
  shapes.only=eros,bennu     [SHAPES_ONLY] rebuild only these catalogue keys (plus 'damit'); others are carried over
  shapes.keepRaw=1           [SHAPES_KEEP_RAW] keep large source files (by default > 50 MB sources are deleted
                             after conversion)
  shapes.reorient=1          [SHAPES_REORIENT] only recompute the orientation blocks (and notes) of the existing
                             headers from the sources' kernels and spin files; meshes, DAMIT and the other products
                             are kept
"""

from __future__ import annotations

import json
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
    for rel, entry in json.loads(mpath.read_text(encoding="utf-8")).get("products", {}).items():
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
        h = json.loads((OUT / "shapes" / f"{by_name[src.name]}.json").read_text(encoding="utf-8"))
        headers.append(shape_build.reorient_one(ctx, src, pck11, h))
    index["bodies"].update(shape_build.summarize(headers))
    _carry_over(ctx, set())
    write_json(ctx, "shapes/index.json", index, "shapes")


def run(ctx: BuildContext) -> None:
    t0 = time.time()
    only = set(ctx.param("shapes.only"))
    keep_raw = ctx.param("shapes.keepRaw")
    damit = ctx.param("shapes.damit")
    pck11 = ephem_kernels.pck(ctx)
    radii = pck_radii()
    idx_path = OUT / "shapes" / "index.json"
    if ctx.param("shapes.reorient"):
        reorient(ctx, only, pck11, json.loads(idx_path.read_text(encoding="utf-8")))
        return
    index = json.loads(idx_path.read_text(encoding="utf-8")) if (only and idx_path.exists()) else {"bodies": {}}
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
    if damit and (not only or "damit" in only):
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
