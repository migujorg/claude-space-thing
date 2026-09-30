"""Download helpers for large surface mosaics, on top of pipeline.download (same sha256 ledger).

- `fetch_transient`: download.fetch a large file, let the caller reduce it, then delete it. The ledger keeps the
  url, sha256, size and date, so the SourceRecord still pins exactly what was used; a rebuild downloads it again
  and `fetch_transient` reports if the upstream bytes changed.
- `fetch_range`: an HTTP Range read of one contiguous byte range of a remote file (e.g. a few bands of a
  band-sequential cube). download.fetch has no Range support, so this writes the same ledger itself; the entry
  records the range and the remote file's size, ETag and Last-Modified next to the sha256 of the bytes kept.
- `Prefetcher`: overlaps the next download with processing of the current file. It runs one download at a time
  in a single worker thread, so ledger writes never race.
"""

from __future__ import annotations

import concurrent.futures as cf
import datetime as _dt
import hashlib
import time
from collections.abc import Callable, Iterable
from pathlib import Path

import requests

from . import download
from .paths import RAW


def ledger_entry(path: Path) -> dict | None:
    return download._load_ledger().get(str(path.relative_to(RAW)))


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
    path.unlink(missing_ok=True)


def fetch_range(url: str, subdir: str, name: str, start: int, length: int, *, retries: int = 4,
                timeout: float = 180.0) -> tuple[Path, dict]:
    """Download bytes [start, start+length) of `url` to data/raw/<subdir>/<name> (cached, ledger-recorded)."""
    dest = RAW / subdir / name
    key = str(dest.relative_to(RAW))
    led = download._load_ledger()
    if dest.exists() and key in led and led[key].get("range") == f"bytes={start}-{start + length - 1}":
        return dest, led[key]
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    delay = 2.0
    for attempt in range(retries + 1):
        try:
            h = hashlib.sha256()
            with requests.get(url, headers={"Range": f"bytes={start}-{start + length - 1}"}, stream=True,
                              timeout=timeout) as r:
                r.raise_for_status()
                if r.status_code != 206:
                    raise requests.RequestException(f"server ignored Range (HTTP {r.status_code})")
                total = r.headers.get("Content-Range", "").split("/")[-1]
                etag = r.headers.get("ETag")
                lastmod = r.headers.get("Last-Modified")
                with tmp.open("wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
                        h.update(chunk)
            if tmp.stat().st_size != length:
                raise requests.RequestException(f"short read {tmp.stat().st_size} != {length}")
            break
        except requests.RequestException:
            if attempt == retries:
                raise
            time.sleep(delay)
            delay *= 2
    tmp.replace(dest)
    led = download._load_ledger()
    led[key] = {"url": url, "range": f"bytes={start}-{start + length - 1}", "sha256": h.hexdigest(),
                "retrieved": _dt.date.today().isoformat(), "bytes": length,
                "remoteBytes": int(total) if total.isdigit() else None, "etag": etag, "lastModified": lastmod}
    download._save_ledger(led)
    return dest, led[key]


def remote_size(url: str) -> int:
    r = requests.head(url, allow_redirects=True, timeout=60)
    r.raise_for_status()
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
