"""Cached, hash-recorded downloads into data/raw/.

Every raw file is fetched once, stored under data/raw/<subdir>/<name>, and its sha256 and retrieval
date are recorded in data/raw/_downloads.json so SourceRecords can cite exactly what was used.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import time
from pathlib import Path

import requests

from .paths import RAW

_LEDGER = RAW / "_downloads.json"


def _load_ledger() -> dict:
    if _LEDGER.exists():
        return json.loads(_LEDGER.read_text())
    return {}


def _save_ledger(ledger: dict) -> None:
    _LEDGER.write_text(json.dumps(ledger, indent=2, sort_keys=True))


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(url: str, subdir: str, name: str | None = None, *, params: dict | None = None,
          retries: int = 4, timeout: float = 120.0, headers: dict | None = None) -> Path:
    """Download url to data/raw/<subdir>/<name> unless already present. Returns the local path.

    `headers` (e.g. a User-Agent some APIs ask for) are sent but not recorded: they do not change the content."""
    name = name or url.rstrip("/").split("/")[-1]
    dest = RAW / subdir / name
    ledger = _load_ledger()
    key = str(dest.relative_to(RAW))
    if dest.exists() and key in ledger:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    delay = 2.0
    for attempt in range(retries + 1):
        try:
            with requests.get(url, params=params, stream=True, timeout=timeout, headers=headers) as r:
                r.raise_for_status()
                with tmp.open("wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
            break
        except requests.RequestException:
            if attempt == retries:
                raise
            time.sleep(delay)
            delay *= 2
    tmp.replace(dest)
    ledger[key] = {
        "url": url if not params else f"{url}?{requests.compat.urlencode(params)}",
        "sha256": sha256_file(dest),
        "retrieved": _dt.date.today().isoformat(),
        "bytes": dest.stat().st_size,
    }
    _save_ledger(ledger)
    return dest


def record(path: Path) -> dict:
    """Ledger entry (url, sha256, retrieved, bytes) for a downloaded file."""
    return _load_ledger()[str(path.relative_to(RAW))]
