"""Download helpers for large surface mosaics, on top of pipeline.download (same sha256 ledger).

- `fetch_transient`: download.fetch a large file, let the caller reduce it, then delete it. The ledger keeps the
  url, sha256, size and date, so the SourceRecord still pins exactly what was used; a rebuild downloads it again
  and `fetch_transient` reports if the upstream bytes changed.
- `fetch_range`: an HTTP Range read of one contiguous byte range of a remote file (e.g. a few bands of a
  band-sequential cube), via download.fetch(byte_range=...); the ledger entry records the range and the remote
  file's size, ETag and Last-Modified next to the sha256 of the bytes kept.
- `Prefetcher`: overlaps the next download with processing of the current file. It runs one download at a time
  in a single worker thread, so ledger writes never race.
"""

from __future__ import annotations

import concurrent.futures as cf
import hashlib
from collections.abc import Callable, Iterable
from pathlib import Path


from . import download
from .paths import RAW


def ledger_entry(path: Path) -> dict | None:
    return download._load_ledger().get(download.ledger_key(path))


def fetch_transient(url: str, subdir: str, name: str | None = None) -> tuple[Path, dict]:
    """download.fetch the file; returns (path, ledger entry). The caller deletes it with `discard` when done."""
    name = name or url.rstrip("/").split("/")[-1]
    dest = RAW / subdir / name
    before = ledger_entry(dest) if not dest.exists() else None
    path = download.fetch(url, subdir, name)
    rec = download.record(path)
    if before is not None and before.get("sha256") != rec["sha256"]:
        print(f"[surfaces] NOTE upstream file changed since last build: {url} "
              f"(sha256 {before.get('sha256', '?')[:12]}… -> {rec['sha256'][:12]}…)")
    return path, rec


def discard(path: Path) -> None:
    """Delete a large raw file after reduction (its ledger entry stays)."""
    download.remove(path)


def fetch_range(url: str, subdir: str, name: str, start: int, length: int) -> tuple[Path, dict]:
    """Download bytes [start, start+length) of `url` to data/raw/<subdir>/<name> through download.fetch's Range
    support (cached per range, ledger entry with the range and the remote file's size/ETag/Last-Modified)."""
    path = download.fetch(url, subdir, name, byte_range=(start, start + length), timeout=180.0)
    return path, download.record(path)


def remote_size(url: str) -> int:
    r = download.request("HEAD", url, allow_redirects=True, timeout=60)
    return int(r.headers["Content-Length"])


class Prefetcher:
    """Iterate over `items`, downloading each with `get(item) -> result` one step ahead of the consumer."""

    def __init__(self, items: Iterable, get: Callable):
        self.items = list(items)
        self.get = get

    def __iter__(self):
        if not self.items:
            return
        with cf.ThreadPoolExecutor(1) as ex:
            fut = ex.submit(self.get, self.items[0])
            for k, item in enumerate(self.items):
                res = fut.result()
                if k + 1 < len(self.items):
                    fut = ex.submit(self.get, self.items[k + 1])
                yield item, res


def combined_digest(records: Iterable[tuple[str, str]]) -> str:
    """sha256 over sorted 'sha256  name' lines: one fingerprint for a multi-file dataset."""
    h = hashlib.sha256()
    for name, sha in sorted(records):
        h.update(f"{sha}  {name}\n".encode())
    return h.hexdigest()
