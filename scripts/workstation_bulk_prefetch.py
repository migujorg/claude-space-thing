"""Bandwidth-controlled bulk-download queue, independent of decompression/reduction throughput."""
import concurrent.futures as cf
import hashlib
import json
from pathlib import Path
import time
import resource
import os
import subprocess
import sys
import workstation_pipeline as network
network.install()
from pipeline import download, stars_gaia as sg
from pipeline.paths import CACHE

def worker(index, shards):
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    resource.setrlimit(resource.RLIMIT_NOFILE, (hard, hard))
    items = sg.xp_index()[index::shards]
    pending = iter(items)
    active = {}
    done = 0
    failures = []
    status = CACHE / f"bulk-prefetch-worker-{index}.json"
    def fetch(item):
        name, expected = item
        def valid(path):
            h = hashlib.md5()
            with path.open("rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            return h.hexdigest() == expected
        return download.fetch(sg.XP_BASE + name, sg.XP_SUBDIR + "_bulk", name,
                              timeout=1800, validate=valid)
    # Threads are created only for the feedback controller's current demand, not for every queued file.
    with cf.ThreadPoolExecutor(max_workers=len(items)) as pool:
        exhausted = False
        while active or not exhausted:
            limit = min(download.host_limit("cdn.gea.esac.esa.int"), max(1,(hard-64)//8))
            while len(active) < limit and not exhausted:
                try:
                    item = next(pending)
                except StopIteration:
                    exhausted = True
                    break
                active[pool.submit(fetch, item)] = item
            finished, _ = cf.wait(active, timeout=1, return_when=cf.FIRST_COMPLETED)
            for future in finished:
                item = active.pop(future)
                try:
                    future.result()
                except Exception as exc:
                    failures.append({"file": item[0], "error": str(exc)[:200]})
                done += 1
                if done % 25 == 0:
                    print(f"[bulk-prefetch] {done}/{len(items)} verified files; {len(active)} active", flush=True)
            status.write_text(json.dumps({"total":len(items),"done":done,"active":len(active),
                                          "failed":failures,"updatedAt":time.time()},indent=2))
def main():
    if len(sys.argv) > 1:
        worker(int(sys.argv[1]), int(sys.argv[2]))
        return
    # Compare normal routing and the working Mullvad route on disjoint files.
    # Both queues use the same bandwidth-driven host leases; no downloads overlap.
    routes = [None, "socks5h://10.64.0.1:1080"]
    processes = []
    for index, route in enumerate(routes):
        path = CACHE / f"bulk-prefetch-worker-{index}.json"
        path.unlink(missing_ok=True)
        env = os.environ.copy()
        if route:
            env["SPACE_THING_CDN_ROUTE"] = route
        else:
            env.pop("SPACE_THING_CDN_ROUTE", None)
        processes.append(subprocess.Popen([sys.executable, "-u", __file__, str(index), str(len(routes))], env=env))
    while True:
        states = []
        for index in range(len(routes)):
            try:
                states.append(json.loads((CACHE / f"bulk-prefetch-worker-{index}.json").read_text()))
            except (OSError, ValueError):
                states.append({"total":len(sg.xp_index()[index::len(routes)]),"done":0,"active":0,"failed":[]})
        state = {key:sum(s.get(key,0) for s in states) for key in ("total","done","active")}
        state.update(failed=[error for s in states for error in s.get("failed",[])], updatedAt=time.time())
        (CACHE / "bulk-prefetch-status.json").write_text(json.dumps(state,indent=2))
        if all(p.poll() is not None for p in processes):
            if any(p.returncode for p in processes):
                raise RuntimeError("Bulk route worker failed")
            break
        time.sleep(1)

if __name__ == "__main__":
    main()
