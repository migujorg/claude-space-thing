"""Fetch the pinned DAMIT snapshot in resumable byte ranges, then validate its gzip CRC."""
import concurrent.futures as cf
import datetime
import gzip
import shutil
from pathlib import Path

import workstation_pipeline as network
network.install()
from pipeline import download as d
from pipeline import shape_damit as damit
from pipeline.paths import RAW


def main():
    url = damit.EXPORT
    response = d.request("HEAD", url, timeout=30)
    size = int(response.headers["Content-Length"])
    response.close()
    name = url.rsplit("/", 1)[-1]
    destination = RAW / damit.SUBDIR / name
    block = 8 << 20
    ranges = [(start, min(start + block, size)) for start in range(0, size, block)]
    chunks = {}

    def fetch(bounds):
        start, stop = bounds
        path = d.fetch(url, damit.SUBDIR + "/ranges/" + name, str(start) + ".part",
                       byte_range=bounds, timeout=120,
                       validate=lambda p: p.stat().st_size == stop - start)
        rec = d.record(path)
        if rec.get("remoteBytes") != size or d.sha256_file(path) != rec["sha256"]:
            raise ValueError("DAMIT range size or cache checksum changed")
        return path

    pending = iter(ranges)
    active = {}
    exhausted = False
    with cf.ThreadPoolExecutor(max_workers=len(ranges)) as pool:
        while active or not exhausted:
            limit = d.host_limit("damit.cuni.cz")
            while len(active) < limit and not exhausted:
                try:
                    bounds = next(pending)
                except StopIteration:
                    exhausted = True
                    break
                active[pool.submit(fetch, bounds)] = bounds
            finished, _ = cf.wait(active, timeout=1, return_when=cf.FIRST_COMPLETED)
            for future in finished:
                bounds = active.pop(future)
                chunks[bounds[0]] = future.result()
                print(f"[DAMIT ranges] {len(chunks)}/{len(ranges)} verified", flush=True)

    with d._process_slot("file:" + str(destination.resolve()), 1):
        assembled = destination.with_suffix(".assembled")
        with assembled.open("wb") as output:
            for start, _ in ranges:
                with chunks[start].open("rb") as source:
                    shutil.copyfileobj(source, output, 1 << 20)
        if assembled.stat().st_size != size:
            raise ValueError("DAMIT assembled size mismatch")
        with gzip.open(assembled, "rb") as archive:
            while archive.read(1 << 20):
                pass
        assembled.replace(destination)
        d.update_ledger(d.ledger_key(destination), {
            "url": url, "sha256": d.sha256_file(destination),
            "retrieved": datetime.date.today().isoformat(), "bytes": size})
    data, _ = damit.load()
    print("[DAMIT] extracted", len(data["models"]), "models", flush=True)


if __name__ == "__main__":
    main()
