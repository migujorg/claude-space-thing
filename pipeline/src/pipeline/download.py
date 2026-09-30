"""Cached, hash-recorded downloads into data/raw/.

Every raw file is fetched once, stored under data/raw/<subdir>/<name>, and its sha256 and retrieval
date are recorded in data/raw/_downloads.json so SourceRecords can cite exactly what was used.
"""

from __future__ import annotations

import contextlib
import datetime as _dt
import hashlib
import json
import os
import threading
import time
from pathlib import Path
from typing import Callable

import requests

from .paths import RAW

_LEDGER = RAW / "_downloads.json"
_LEDGER_LOCK = threading.Lock()  # fetch may be called from worker threads; ledger updates are read-modify-write


def _load_ledger() -> dict:
    if _LEDGER.exists():
        return json.loads(_LEDGER.read_text())
    return {}


def _save_ledger(ledger: dict) -> None:
    # write-then-rename, so a concurrent reader never sees a half-written ledger
    tmp = _LEDGER.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(ledger, indent=2, sort_keys=True))
    tmp.replace(_LEDGER)


@contextlib.contextmanager
def _ledger_locked():
    """Exclusive access to the ledger across threads and processes (stages may run concurrently)."""
    with _LEDGER_LOCK, (RAW / "_downloads.lock").open("a+") as f:
        try:
            import fcntl
            fcntl.flock(f, fcntl.LOCK_EX)
        except ImportError:  # Windows
            import msvcrt
            f.seek(0)
            while True:
                try:
                    msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)
                    break
                except OSError:
                    time.sleep(0.05)
        yield


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(url: str, subdir: str, name: str | None = None, *, params: dict | None = None,
          retries: int = 4, timeout: float = 120.0, headers: dict | None = None,
          validate: Callable[[Path], bool] | None = None, byte_range: tuple[int, int] | None = None,
          record_url: str | None = None) -> Path:
    """Download url to data/raw/<subdir>/<name> unless already present. Returns the local path.

    `headers` are extra request headers (some publishers reject the default client). `validate(path)` checks the
    content (e.g. that a .pdf really is a PDF and not a bot-check page): a cached file that fails it is fetched
    again, and a fresh download that fails it is retried, then raises ValueError instead of being recorded.
    `byte_range=(start, stop)` downloads only bytes [start, stop) with an HTTP Range request (the server must answer
    206); the ledger then also records the range and the remote file's size, ETag and Last-Modified, and a cached
    file is reused only for the same range. `record_url` is the URL written to the ledger instead of `url` (e.g.
    without a temporary access token)."""
    name = name or url.rstrip("/").split("/")[-1]
    dest = RAW / subdir / name
    ledger = _load_ledger()
    key = str(dest.relative_to(RAW))
    rng = f"bytes={byte_range[0]}-{byte_range[1] - 1}" if byte_range else None
    if (dest.exists() and key in ledger and ledger[key].get("range") == rng
            and (validate is None or validate(dest))):
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + f".{os.getpid()}.{threading.get_ident()}.part")
    hdrs = dict(headers or {})
    if rng:
        hdrs["Range"] = rng
    extra: dict = {}
    delay = 2.0
    for attempt in range(retries + 1):
        try:
            with requests.get(url, params=params, headers=hdrs or None, stream=True, timeout=timeout) as r:
                r.raise_for_status()
                if rng:
                    if r.status_code != 206:
                        raise requests.RequestException(f"{url}: server ignored the Range header "
                                                        f"(HTTP {r.status_code})")
                    total = r.headers.get("Content-Range", "").split("/")[-1]
                    extra = {"range": rng, "remoteBytes": int(total) if total.isdigit() else None,
                             "etag": r.headers.get("ETag"), "lastModified": r.headers.get("Last-Modified")}
                with tmp.open("wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
            if rng and tmp.stat().st_size != byte_range[1] - byte_range[0]:
                raise requests.RequestException(f"{url}: short range read")
            if validate is not None and not validate(tmp):
                tmp.unlink()
                raise ValueError(f"{url}: downloaded content failed validation (not saved)")
            break
        except (requests.RequestException, ValueError):
            if attempt == retries:
                raise
            time.sleep(delay)
            delay *= 2
    tmp.replace(dest)
    shown = record_url or url
    entry = {
        "url": shown if not params or record_url else f"{url}?{requests.compat.urlencode(params)}",
        "sha256": sha256_file(dest),
        "retrieved": _dt.date.today().isoformat(),
        "bytes": dest.stat().st_size,
        **extra,
    }
    # Re-read under the lock: other threads/processes may have recorded downloads during the transfer.
    with _ledger_locked():
        ledger = _load_ledger()
        ledger[key] = entry
        _save_ledger(ledger)
    return dest


def record(path: Path) -> dict:
    """Ledger entry (url, sha256, retrieved, bytes) for a downloaded file."""
    return _load_ledger()[str(path.relative_to(RAW))]
