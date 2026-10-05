"""Download independent full-profile inputs concurrently, without writing any app products or manifest."""
import concurrent.futures as cf
import itertools
import json
from pathlib import Path
import time

import workstation_pipeline as network
network.install()

from pipeline import download, shape_catalog, surf_moon, surf_mars, surf_nh

ROOT = Path(__file__).resolve().parents[1]
STATUS = ROOT / "data/cache/prefetch-status.json"

moon = [(surf_moon.PARAM_URL, surf_moon.SUBDIR, None, {})]
moon += [(surf_moon.wac_url(b, t), surf_moon.SUBDIR, None, {}) for b in surf_moon.BANDS for t in surf_moon.WAC_TILES]
moon += [(surf_moon.emp_url(b, p), surf_moon.SUBDIR, None, {}) for b in surf_moon.BANDS for p in ("N", "S")]
moon += [(surf_moon.LDEM + "ldem_64." + ext, surf_moon.SUBDIR, None, {}) for ext in ("lbl", "img")]
shapes = []
for src in shape_catalog.ALL:
    shapes.append((src.url, f"shapes/{src.key}", None, {}))
    shapes += [(u, f"shapes/{src.key}/kernels", None, {}) for u in src.kernels]
mars = [(f"{surf_mars.HRSC}{stem}-eqc.tif", surf_mars.SUBDIR, None, {}) for stem, _, _ in surf_mars.HRSC_BANDS]
mars += [(surf_mars.MEGDR + "megr90n000fb." + e, surf_mars.SUBDIR, None, {}) for e in ("lbl", "img")]
nh = []
for m in surf_nh.MAPS:
    subdir = f"surfaces/{m.name.lower()}"
    nh.append((surf_nh.SBN + m.file + ".lblx", subdir, None, {}))
    n = m.lines * m.samples * 4
    nh += [(surf_nh.SBN + m.file + ".img", subdir, f"{m.file}.band{b}.f32", {"byte_range": (b*n, (b+1)*n)})
           for b, _, _ in surf_nh.BANDS.values()]
# Interleave hosts so waiting on one archive cannot occupy the whole pool.
jobs = [job for row in itertools.zip_longest(moon, shapes, mars, nh) for job in row if job is not None]
jobs = list({(u, sub, name): (u, sub, name, options) for u, sub, name, options in jobs}.values())
state = {"total": len(jobs), "done": 0, "failed": [], "started": time.time()}

def fetch(job):
    url, subdir, name, options = job
    return download.fetch(url, subdir, name, timeout=900, **options)

print(f"[prefetch] {len(jobs)} independent inputs; 24 workers, shared per-host limits", flush=True)
with cf.ThreadPoolExecutor(24) as pool:
    futures = {pool.submit(fetch, job): job for job in jobs}
    for future in cf.as_completed(futures):
        job = futures[future]
        try:
            path = future.result()
            print(f"[prefetch] ready {path.relative_to(ROOT)}", flush=True)
        except Exception as exc:
            state["failed"].append({"url": job[0], "error": str(exc)[:300]})
            print(f"[prefetch] failed {job[0]}: {exc}", flush=True)
        state["done"] += 1
        state["downloadedBytes"] = download.stats()["bytes"]
        STATUS.write_text(json.dumps(state, indent=2))
print(f"[prefetch] complete: {state['done']}/{state['total']}, failures={len(state['failed'])}", flush=True)
