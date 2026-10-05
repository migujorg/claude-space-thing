"""Keep future full-profile download inputs ready without waiting for their build stage."""
import concurrent.futures as cf
import json
import os
from pathlib import Path
import time
os.environ["PIPELINE_NETWORK_METRICS"] = "1"
import workstation_pipeline as network
network.install()
from pipeline import download, shape_damit, surf_mercury, surf_pan, surf_giants, sb_physical_sources

ROOT = Path(__file__).resolve().parents[1]
jobs = []
def raw(url, subdir, name=None):
    return lambda: download.fetch(url, subdir, name, timeout=1800)
jobs.append(("DAMIT export", raw(shape_damit.EXPORT, shape_damit.SUBDIR)))
jobs.append(("Mercury DEM", raw(surf_mercury.DEM, surf_mercury.SUBDIR)))
for m in surf_pan.MAPS:
    jobs.append((m.name, raw(surf_pan.USGS+m.file, f"surfaces/{m.name.lower()}")))
for p in surf_giants.PLANETS:
    sub=f"surfaces/{p.name.lower()}"
    jobs.append((p.name+" OPAL readme", raw(surf_giants.planet_dir(p)+p.readme, sub)))
    for band in surf_giants.FILTERS[p.naif]:
        jobs.append((p.name+" "+band, raw(surf_giants.planet_dir(p)+surf_giants.map_name(p,band),sub)))
# Tile names are discovered from archive directory listings, then submitted individually.
for stem in surf_mercury.mdr_tiles():
    jobs.append((stem, lambda stem=stem: surf_mercury.fetch_tile(stem)))
state={"total":len(jobs),"done":0,"failed":[],"startedAt":time.time()}
print(f"[prefetch-extra] {len(jobs)} ready inputs; concurrency controlled by measured bandwidth and host leases",flush=True)
with cf.ThreadPoolExecutor(max_workers=max(1,len(jobs))) as pool:
    futures={pool.submit(fn):name for name,fn in jobs}
    for future in cf.as_completed(futures):
        name=futures[future]
        try:
            future.result();print(f"[prefetch-extra] ready {name}",flush=True)
        except Exception as exc:
            state["failed"].append({"name":name,"error":str(exc)[:300]})
            print(f"[prefetch-extra] failed {name}: {exc}",flush=True)
        state["done"]+=1
        (ROOT/"data/cache/prefetch-extra-status.json").write_text(json.dumps(state,indent=2))
