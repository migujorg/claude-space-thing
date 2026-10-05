"""Prefetch a fixed-version raw input with verified parallel HTTP ranges."""
import concurrent.futures as cf
import datetime
import json
import shutil
import sys
import resource
from urllib.parse import urlsplit
import workstation_pipeline as network
network.install()
from pipeline import download as d
from pipeline.paths import RAW


def prepare(item):
    url, subdir, name = item["url"], item["subdir"], item["name"]
    response = d.request("HEAD", url, timeout=30)
    total = int(response.headers["Content-Length"])
    etag = response.headers.get("ETag")
    modified = response.headers.get("Last-Modified")
    response.close()
    start, stop = item.get("range", [0, total])
    headers = {"If-Match": etag} if etag and not etag.startswith("W/") else (
        {"If-Unmodified-Since": modified} if modified else {})
    chunks = {}
    bounds = [(a, min(a + (8 << 20), stop)) for a in range(start, stop, 8 << 20)]
    host = urlsplit(url).hostname

    def fetch(bound):
        a, b = bound
        path = d.fetch(url, subdir + "/ranges/" + name, str(a) + ".part",
                       byte_range=bound, headers=headers, timeout=90,
                       validate=lambda p: p.stat().st_size == b - a)
        rec = d.record(path)
        if rec.get("remoteBytes") != total or (etag and rec.get("etag") != etag):
            raise ValueError("Remote object changed across ranges")
        if d.sha256_file(path) != rec["sha256"]:
            raise ValueError("Cached range checksum mismatch")
        return path

    active, pending, exhausted = {}, iter(bounds), False
    with cf.ThreadPoolExecutor(max_workers=len(bounds)) as pool:
        while active or not exhausted:
            while len(active) < d.host_limit(host) and not exhausted:
                try:
                    bound = next(pending)
                except StopIteration:
                    exhausted = True
                    break
                active[pool.submit(fetch, bound)] = bound
            finished, _ = cf.wait(active, timeout=1, return_when=cf.FIRST_COMPLETED)
            for future in finished:
                bound = active.pop(future)
                chunks[bound[0]] = future.result()
                print(f"[ranges] {name}: {len(chunks)}/{len(bounds)} verified", flush=True)

    destination = RAW / subdir / name
    print("[ranges] READY TO PUBLISH", name, flush=True)
    with d._process_slot("file:" + str(destination.resolve()), 1):
        assembled = destination.with_suffix(destination.suffix + ".assembled")
        with assembled.open("wb") as output:
            for a, _ in bounds:
                with chunks[a].open("rb") as source:
                    shutil.copyfileobj(source, output, 1 << 20)
        if assembled.stat().st_size != stop - start:
            raise ValueError("Assembled range size mismatch")
        assembled.replace(destination)
        entry = {"url": url, "sha256": d.sha256_file(destination),
                 "retrieved": datetime.date.today().isoformat(), "bytes": stop - start}
        if "range" in item:
            entry.update(range=f"bytes={start}-{stop-1}", remoteBytes=total,
                         etag=etag, lastModified=modified)
        d.update_ledger(d.ledger_key(destination), entry)
    print("[ranges] PUBLISHED", name, flush=True)


def main():
    _, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    resource.setrlimit(resource.RLIMIT_NOFILE, (hard, hard))
    items = json.load(open(sys.argv[1]))
    with cf.ThreadPoolExecutor(max_workers=len(items)) as pool:
        list(pool.map(prepare, items))


if __name__ == "__main__":
    main()
