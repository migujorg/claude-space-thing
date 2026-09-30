"""`surfaces` stage: tiled surface-map pyramids (docs/architecture.md §4.4).

Writes, per body with a usable visible-light map,
  surfaces/<naifId>/<layer>.json      SurfaceLayerHeader (app/src/data/schema.ts)
  surfaces/<naifId>/<layer>.sha256    sha256 of every tile
  surfaces/<naifId>/<layer>/<L>/<ty>/<tx>.bin   tiles
and surfaces/index.json (bodies → layers, plus the bodies deliberately without a visible surface map and why).

Environment:
  SURFACES_BODIES=301,599   rebuild only these bodies (others' products are kept in the manifest)
  SURFACES_KEEP_CACHE=1     keep data/cache/surfaces (reduced intermediates) for fast re-runs; by default it is
                            deleted when the stage finishes (large raw mosaics are deleted right after reduction).
"""

from __future__ import annotations

import importlib
import json
import os
import shutil
import time

from ..output import write_json
from ..paths import CACHE, OUT
from ..schema import BuildContext

DEPENDS: tuple[str, ...] = ("light",)

# (module, naif ids it builds)
BUILDERS: list[tuple[str, tuple[int, ...]]] = [
    ("surf_moon", (301,)),
    ("surf_giants", (599, 699, 799, 899)),
    ("surf_mars", (499,)),
    ("surf_mercury", (199,)),
    ("surf_pan", (501, 502, 503, 504, 999, 901)),
]

# Bodies whose surface the naked eye cannot see: no visible-light surface map is produced for them.
EXCLUDED = {
    299: "Venus: the eye sees only the cloud deck (a few percent contrast in the visible; the famous markings are "
         "ultraviolet). Magellan radar maps show the surface, which is invisible to the eye; they belong in an "
         "overlay, never in naked-eye rendering.",
    606: "Titan: the eye sees an orange haze ball; the surface is visible only in near-infrared methane windows "
         "(Cassini ISS 938 nm, VIMS), so the ISS/VIMS surface mosaics are not visible-light maps and are not used.",
}

# Bodies with a candidate map that failed a check (so they are rendered from photometry only for now).
REJECTED = {
    608: "Iapetus: the USGS/CICLOPS Cassini-Voyager global mosaic (783 m) implies a leading/trailing brightness ratio "
         "of only 0.84 (0.18 mag) at zero phase, against the ~2 mag asymmetry observed since Cassini (1671): its "
         "large-scale contrast is compressed, so it is not a reflectance map.",
    604: "Dione: the USGS/CICLOPS global mosaic (154 m) implies a leading/trailing ratio of 1.04 and the bright ray "
         "crater Creusa does not stand out; same map series as Iapetus, brightness scaling unverified.",
    603: "Tethys: USGS/CICLOPS global mosaic (293 m) from the same map series as Iapetus and Dione; brightness scaling "
         "unverified (implied leading/trailing ratio 1.09).",
    605: "Rhea: USGS/CICLOPS global mosaic (417 m), same map series; brightness scaling unverified (implied "
         "leading/trailing ratio 1.17).",
    602: "Enceladus: the 110 m mosaic (Bland et al. 2018; non-HPF version) derives from the same CICLOPS map series; "
         "brightness scaling unverified.",
}


def run(ctx: BuildContext) -> None:
    t0 = time.time()
    only = {int(x) for x in os.environ.get("SURFACES_BODIES", "").split(",") if x.strip()}
    keep_cache = os.environ.get("SURFACES_KEEP_CACHE", "") == "1"
    work_root = CACHE / "surfaces"
    index_path = OUT / "surfaces" / "index.json"
    index = json.loads(index_path.read_text()) if (only and index_path.exists()) else {"bodies": {}}
    built: set[int] = set()
    for modname, ids in BUILDERS:
        if only and not (set(ids) & only):
            continue
        mod = importlib.import_module(f"..{modname}", __package__)
        t = time.time()
        headers = mod.build(ctx, work_root / modname.removeprefix("surf_"))
        for h in headers:
            b = index["bodies"].setdefault(str(h["body"]), {"name": h["bodyName"], "layers": {}})
            b["layers"][h["layer"]] = f"surfaces/{h['body']}/{h['layer']}.json"
            built.add(h["body"])
        print(f"[surfaces] {modname}: {time.time() - t:.0f} s")
        index.setdefault("buildSeconds", {})[modname] = round(time.time() - t, 1)
    if only:
        _carry_over(ctx, built)
    index["excluded"] = {str(k): v for k, v in EXCLUDED.items()}
    index["rejected"] = {str(k): v for k, v in REJECTED.items()}
    index["notes"] = ("Tiles hold relative reflectance (albedo layers), heights or photometric parameters; see each "
                      "layer header. Bodies not listed have no surface map yet (rendered from photometry.json only).")
    write_json(ctx, "surfaces/index.json", index, "surfaces")
    if not keep_cache and work_root.exists():
        shutil.rmtree(work_root)
    print(f"[surfaces] stage time {time.time() - t0:.0f} s")


def _carry_over(ctx: BuildContext, rebuilt: set[int]) -> None:
    """Keep the manifest entries of bodies not rebuilt in a partial run (write_manifest drops a stage's old
    products whenever the stage runs)."""
    mpath = OUT / "manifest.json"
    if not mpath.exists():
        return
    for rel, entry in json.loads(mpath.read_text()).get("products", {}).items():
        if entry.get("stage") != "surfaces" or rel == "surfaces/index.json":
            continue
        parts = rel.split("/")
        if len(parts) >= 2 and parts[1].isdigit() and int(parts[1]) not in rebuilt and (OUT / rel).exists():
            ctx.products.setdefault(rel, entry)
