"""`surfaces` stage: tiled surface-map pyramids (docs/architecture.md §4.4).

Writes, per body with a usable visible-light map,
  surfaces/<naifId>/<layer>.json      SurfaceLayerHeader (app/src/data/schema.ts)
  surfaces/<naifId>/<layer>.sha256    sha256 of every tile
  surfaces/<naifId>/<layer>/<L>/<ty>/<tx>.bin   tiles
and surfaces/index.json (bodies → layers, plus the bodies deliberately without a visible surface map and why).

Build parameters (pipeline/config.py; `build --set key=value`, or the environment variable):
  surfaces.maxLevel=3                 write pyramid levels up to 3 only (identical to a full build's levels 0-3; the
                                      header's levelCap records it). Default: every level the source supports.
  surfaces.bodies=301,599             [SURFACES_BODIES] rebuild only these bodies (others' products are kept)
  surfaces.keepCache=1                [SURFACES_KEEP_CACHE] keep data/cache/surfaces (reduced intermediates) for fast
                                      re-runs; by default it is deleted when the stage finishes (large raw mosaics
                                      are deleted right after reduction).
  surfaces.earthLayers=clouds,night   [SURFACES_EARTH_LAYERS] rebuild only these Earth layers
"""

from __future__ import annotations

import gc
import importlib
import json
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
    ("surf_pan", (501, 502, 503, 504)),
    ("surf_nh", (999, 901)),
    ("surf_earth", (399,)),
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
_DLR = ("The DLR Cassini ISS cartographic atlas maps archived in PDS (COISS_3001-3007, Roatsch et al.; 8-bit "
        "simple-cylindrical mosaics with a Hapke/Henyey-Greenstein photometric correction but no documented DN "
        "scaling) were tested too and give the same ratios: they are the source of the USGS mosaics.")
REJECTED = {
    608: "Iapetus: the USGS/CICLOPS Cassini-Voyager global mosaic (783 m) and the DLR atlas map SI_3M_0_0_SIMP "
         "(COISS_3005) both imply a leading/trailing brightness ratio of only 0.84 (0.18 mag) at zero phase, against "
         "the ~2 mag asymmetry observed since Cassini (1671): their large-scale contrast is compressed, so they are "
         "not reflectance maps. " + _DLR,
    604: "Dione: the USGS/CICLOPS global mosaic (154 m) implies a leading/trailing ratio of 1.04 and the bright ray "
         "crater Creusa does not stand out; same map series as Iapetus, brightness scaling unverified. " + _DLR,
    603: "Tethys: USGS/CICLOPS global mosaic (293 m) and DLR map ST_1M_0_0_SIMP (COISS_3004), same series as "
         "Iapetus; brightness scaling unverified (implied leading/trailing ratio 1.08-1.09).",
    605: "Rhea: USGS/CICLOPS global mosaic (417 m) and DLR map SR_1500K_0_0_SIMP (COISS_3007), same series; "
         "brightness scaling unverified (implied leading/trailing ratio 1.17).",
    602: "Enceladus: the 110 m mosaic (Bland et al. 2018; non-HPF version) and DLR map SE_400K_0_0_SIMP (COISS_3002) "
         "derive from the same map series; brightness scaling unverified.",
    601: "Mimas: DLR map SM_1M_0_0_SIMP (COISS_3006), same series as Iapetus; brightness scaling unverified (implied "
         "leading/trailing ratio 0.93).",
    609: "Phoebe: DLR map SP_1M_0_0_SIMP (COISS_3001), same series (8-bit, undocumented DN scaling; 20 % of the map "
         "has no data).",
    801: "Triton: the USGS global and orthographic colour mosaics are the 1989 Voyager 2 display composite PIA00317 "
         "(orange, violet and ultraviolet images shown as red, green, blue; the GlobalFill version adds synthetic "
         "fill), and the orthographic clear-channel mosaic is an 8-bit product without documented scaling; no "
         "calibrated Triton map was found in PDS.",
}


def run(ctx: BuildContext) -> None:
    t0 = time.time()
    only = set(ctx.param("surfaces.bodies"))
    keep_cache = ctx.param("surfaces.keepCache")
    work_root = CACHE / "surfaces"
    index_path = OUT / "surfaces" / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if (only and index_path.exists()) else {"bodies": {}}
    built: set[tuple[int, str]] = set()
    for modname, ids in BUILDERS:
        if only and not (set(ids) & only):
            continue
        mod = importlib.import_module(f"..{modname}", __package__)
        t = time.time()
        headers = mod.build(ctx, work_root / modname.removeprefix("surf_"))
        for h in headers:
            b = index["bodies"].setdefault(str(h["body"]), {"name": h["bodyName"], "layers": {}})
            b["layers"][h["layer"]] = f"surfaces/{h['body']}/{h['layer']}.json"
            built.add((h["body"], h["layer"]))
        print(f"[surfaces] {modname}: {time.time() - t:.0f} s")
        if not (modname == "surf_earth" and ctx.param("surfaces.earthLayers")):
            index.setdefault("buildSeconds", {})[modname] = round(time.time() - t, 1)   # whole-module runs only
    if only:
        _carry_over(ctx, built)
    index["excluded"] = {str(k): v for k, v in EXCLUDED.items()}
    index["rejected"] = {str(k): v for k, v in REJECTED.items()}
    index["notes"] = ("Tiles hold relative reflectance (albedo layers), heights or photometric parameters; see each "
                      "layer header. Bodies not listed have no surface map yet (rendered from photometry.json only).")
    write_json(ctx, "surfaces/index.json", index, "surfaces")
    if not keep_cache and work_root.exists():
        _rmtree(work_root)
    print(f"[surfaces] stage time {time.time() - t0:.0f} s")


def _rmtree(path) -> None:
    """Delete the reduced intermediates. On Windows a file still memory-mapped cannot be deleted: drop forgotten
    memmaps and retry once; the cache is safe to delete later, so a leftover is reported, never fatal."""
    try:
        shutil.rmtree(path)
    except OSError:
        gc.collect()
        shutil.rmtree(path, ignore_errors=True)
        if path.exists():
            print(f"[surfaces] could not delete all of {path} (files still open); it is safe to delete by hand")


def _carry_over(ctx: BuildContext, rebuilt: set[tuple[int, str]]) -> None:
    """Keep the manifest entries of layers not rebuilt in a partial run (write_manifest drops a stage's old
    products whenever the stage runs)."""
    mpath = OUT / "manifest.json"
    if not mpath.exists():
        return
    for rel, entry in json.loads(mpath.read_text(encoding="utf-8")).get("products", {}).items():
        if entry.get("stage") != "surfaces" or rel == "surfaces/index.json":
            continue
        parts = rel.split("/")
        if len(parts) < 3 or not parts[1].isdigit():
            continue
        layer = parts[2].removesuffix(".json").removesuffix(".sha256")
        if (int(parts[1]), layer) not in rebuilt and (OUT / rel).exists():
            ctx.products.setdefault(rel, entry)
