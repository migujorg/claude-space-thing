"""Cached, hash-recorded downloads into data/raw/.

Every raw file is fetched once, stored under data/raw/<subdir>/<name>, and its sha256 and retrieval
date are recorded in data/raw/_downloads.json so SourceRecords can cite exactly what was used.

Built for long unattended builds:
- **Resume.** A transfer in progress lives in `<name>.partial`, with `<name>.partial.json` holding the URL and the
  server's validator (ETag or Last-Modified). A retry, or the next build after a crash, asks only for the missing
  bytes (`Range` + `If-Range`); the server answers 206 if the file is unchanged, otherwise sends it whole and the
  transfer starts over. Responses without a validator, or with a Content-Encoding, are never resumed. The sha256 is
  always computed over the complete file, so a resumed download is recorded exactly as an uninterrupted one.
- **Retries** with exponential backoff and jitter on connection errors, timeouts, HTTP 408/425/429/5xx and failed
  `validate` checks; `Retry-After` is honoured. Other HTTP errors (404, 403, ...) fail at once.
- **Politeness.** At most HOST_LIMITS[host] (default DEFAULT_HOST_LIMIT) transfers per host at a time, however many
  threads call `fetch`; `fetch_many` runs a list of downloads in parallel within those limits.
- **Progress.** Transfers taking longer than PROGRESS_EVERY_S print bytes, rate and ETA; `stats()` counts bytes and
  files downloaded (the build summary uses it).
"""

from __future__ import annotations

import concurrent.futures as cf
import contextlib
import datetime as _dt
import email.utils
import gc
import hashlib
import http.cookiejar
import json
import os
import random
import re
import threading
import time
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

import requests

from .paths import RAW

_LEDGER = RAW / "_downloads.json"
_LEDGER_LOCK = threading.Lock()  # fetch may be called from worker threads; ledger updates are read-modify-write

#: Concurrent transfers per host. JPL's APIs ask for one request at a time; ESA's TAP service runs queries. ARI's
#: TAP service answers the XP queries (stars.xpSource=archive) `gaia.xpWorkers` at a time (default 4), up to 8.
HOST_LIMITS = {"ssd-api.jpl.nasa.gov": 1, "ssd.jpl.nasa.gov": 1, "gea.esac.esa.int": 2, "gaia.ari.uni-heidelberg.de": 8}
DEFAULT_HOST_LIMIT = 4
RETRY_STATUS = {408, 425, 429, 500, 502, 503, 504}
PROGRESS_EVERY_S = 15.0
MAX_BACKOFF_S = 300.0

# ------------------------------------------------------------------------------------------------ ledger


def ledger_key(path: Path) -> str:
    """Ledger key of a file under data/raw: its relative path with '/' on every platform."""
    return path.relative_to(RAW).as_posix()


def _retry_io(fn, attempts: int = 50):
    """Run fn, retrying PermissionError: on Windows a file another thread or process has open cannot be replaced
    (or, briefly, opened) while it is being replaced."""
    for i in range(attempts):
        try:
            return fn()
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(0.1)


def _load_ledger() -> dict:
    if _LEDGER.exists():
        return _retry_io(lambda: json.loads(_LEDGER.read_text(encoding="utf-8")))
    return {}


def _save_ledger(ledger: dict) -> None:
    # write-then-rename, so a concurrent reader never sees a half-written ledger
    tmp = _LEDGER.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(ledger, indent=2, sort_keys=True), encoding="utf-8", newline="\n")
    _retry_io(lambda: tmp.replace(_LEDGER))


@contextlib.contextmanager
def _ledger_locked():
    """Exclusive access to the ledger across threads and processes (stages may run concurrently)."""
    _LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with _LEDGER_LOCK, (_LEDGER.parent / "_downloads.lock").open("a+b") as f:
        try:
            import fcntl
        except ImportError:  # Windows: lock byte 0 (allowed beyond the end of an empty file)
            import msvcrt
            f.seek(0)
            while True:
                try:
                    msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    time.sleep(0.05)
            try:
                yield
            finally:
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(f, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)


def update_ledger(key: str, entry: dict | None) -> None:
    """Set (or, with None, remove) one ledger entry under the lock."""
    with _ledger_locked():
        ledger = _load_ledger()
        if entry is None:
            ledger.pop(key, None)
        else:
            ledger[key] = entry
        _save_ledger(ledger)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def record(path: Path) -> dict:
    """Ledger entry (url, sha256, retrieved, bytes) for a downloaded file."""
    return _load_ledger()[ledger_key(path)]


def remove(path: Path) -> None:
    """Delete a file, tolerating Windows' refusal to delete a file that is still memory-mapped or open: collect
    garbage (dropping forgotten numpy memmaps) and retry; warn instead of failing if it still cannot be deleted."""
    for i in range(20):
        try:
            path.unlink(missing_ok=True)
            return
        except PermissionError:
            gc.collect()
            time.sleep(0.25)
    print(f"[download] WARNING could not delete {path} (still open); delete it by hand", flush=True)


# ------------------------------------------------------------------------------------------------ names

_BAD_CHARS = re.compile(r'[<>:"|?*\\\x00-\x1f]')
_RESERVED = re.compile(r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$", re.I)


def check_portable(rel: str) -> None:
    """Raise ValueError if a data/raw path would be invalid on Windows (checked on every platform, so a name that
    would break a Windows build fails on the developer's machine first)."""
    for part in rel.split("/"):
        if not part or _BAD_CHARS.search(part) or _RESERVED.match(part) or part.endswith((".", " ")):
            raise ValueError(f"raw file path {rel!r} is not portable (Windows forbids <>:\"|?* \\, control "
                             "characters, reserved names and trailing dots/spaces)")
    if len(rel) > 180:
        raise ValueError(f"raw file path {rel!r} is {len(rel)} characters; keep it under 180 for Windows paths")


# ------------------------------------------------------------------------------------------------ transfer

_STATS = {"bytes": 0, "files": 0}
_STATS_LOCK = threading.Lock()
_HOST_SEMS: dict[str, threading.BoundedSemaphore] = {}
_DEST_LOCKS: dict[Path, threading.Lock] = {}
_LOCAL = threading.local()


def stats() -> dict:
    """Bytes and files downloaded by this process so far (all hosts, including streamed files)."""
    with _STATS_LOCK:
        return dict(_STATS)


def count(nbytes: int, files: int = 0) -> None:
    """Add bytes received outside `fetch` (e.g. streamed and reduced on the fly) to `stats()`."""
    with _STATS_LOCK:
        _STATS["bytes"] += int(nbytes)
        _STATS["files"] += int(files)


def host_slot(url: str) -> threading.BoundedSemaphore:
    """Semaphore limiting concurrent transfers to url's host."""
    host = (urlsplit(url).hostname or "").lower()
    with _STATS_LOCK:
        if host not in _HOST_SEMS:
            _HOST_SEMS[host] = threading.BoundedSemaphore(HOST_LIMITS.get(host, DEFAULT_HOST_LIMIT))
        return _HOST_SEMS[host]


def session() -> requests.Session:
    """A per-thread session (connection reuse) that, like requests.get, keeps no cookies between requests."""
    s = getattr(_LOCAL, "session", None)
    if s is None:
        s = requests.Session()
        s.cookies.set_policy(http.cookiejar.DefaultCookiePolicy(allowed_domains=[]))
        _LOCAL.session = s
    return s


class HTTPStatusError(requests.HTTPError):
    """An HTTP error response; `retryable` says whether trying again can help."""

    def __init__(self, msg: str, status: int, retry_after: float | None, response=None):
        super().__init__(msg, response=response)
        self.status = status
        self.retry_after = retry_after
        self.retryable = status in RETRY_STATUS


def _retry_after(r: requests.Response) -> float | None:
    v = r.headers.get("Retry-After")
    if not v:
        return None
    if v.strip().isdigit():
        return float(v)
    with contextlib.suppress(TypeError, ValueError):
        return max(0.0, email.utils.parsedate_to_datetime(v).timestamp() - time.time())
    return None


def backoff(attempt: int, base: float = 3.0, retry_after: float | None = None) -> float:
    """Seconds to wait before retry `attempt` (0-based): exponential with +-50 % jitter, or the server's
    Retry-After (capped at MAX_BACKOFF_S)."""
    if retry_after is not None:
        return min(retry_after, MAX_BACKOFF_S)
    return min(base * 2 ** attempt, MAX_BACKOFF_S) * random.uniform(0.5, 1.5)


def _fmt_bytes(n: float) -> str:
    for unit in ("B", "kB", "MB", "GB", "TB"):
        if abs(n) < 1000 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1000.0
    return f"{n:.1f} TB"


def _fmt_s(s: float) -> str:
    s = int(s)
    return f"{s // 3600}h{s % 3600 // 60:02d}m" if s >= 3600 else f"{s // 60}m{s % 60:02d}s" if s >= 60 else f"{s}s"


class Progress:
    """Periodic 'label  got/total  rate  ETA' lines for long transfers (plain lines: readable in logs too)."""

    def __init__(self, label: str, total: int | None, done: int = 0):
        self.label, self.total, self.start_done, self.done = label, total, done, done
        self.t0 = self.last = time.monotonic()

    def update(self, n: int) -> None:
        self.done += n
        now = time.monotonic()
        if now - self.last >= PROGRESS_EVERY_S:
            self.last = now
            rate = (self.done - self.start_done) / max(now - self.t0, 1e-9)
            tot = f"/{_fmt_bytes(self.total)}" if self.total else ""
            eta = f"  ETA {_fmt_s((self.total - self.done) / rate)}" if self.total and rate > 0 else ""
            print(f"  [download] {self.label}  {_fmt_bytes(self.done)}{tot}  {_fmt_bytes(rate)}/s{eta}", flush=True)


def _full_url(url: str, params: dict | None) -> str:
    return f"{url}?{requests.compat.urlencode(params)}" if params else url


def post_digest(data: dict) -> str:
    """sha256 of a POST body as sent (form-encoded): recorded in the ledger for POSTed queries."""
    return hashlib.sha256(requests.compat.urlencode(data).encode()).hexdigest()


def _transfer(url: str, params: dict | None, headers: dict, part: Path, meta_path: Path,
              byte_range: tuple[int, int] | None, timeout: float, label: str, data: dict | None = None) -> dict:
    """One attempt: download into `part`, resuming it if possible. Returns the range metadata for the ledger.
    With `data` the request is a form POST (e.g. a TAP query too long for a URL); a POST is never resumed."""
    ident = {"url": _full_url(url, params), "range": list(byte_range) if byte_range else None}
    if data is not None:
        part.unlink(missing_ok=True)
        meta_path.unlink(missing_ok=True)
    have = part.stat().st_size if part.exists() else 0
    meta = {}
    if have and meta_path.exists():
        with contextlib.suppress(ValueError, OSError):
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
    validator = meta.get("validator") if all(meta.get(k) == v for k, v in ident.items()) else None
    first = byte_range[0] if byte_range else 0
    last = byte_range[1] - 1 if byte_range else None
    hdrs = dict(headers)
    resuming = bool(have and validator)
    if resuming:
        hdrs["Range"] = f"bytes={first + have}-{'' if last is None else last}"
        hdrs["If-Range"] = validator
    elif byte_range:
        hdrs["Range"] = f"bytes={first}-{last}"
    def send() -> requests.Response:   # called inside the host slot
        if data is not None:
            return session().post(url, params=params, data=data, headers=hdrs or None, stream=True, timeout=timeout)
        return session().get(url, params=params, headers=hdrs or None, stream=True, timeout=timeout)

    with host_slot(url), send() as r:
        if r.status_code >= 400:
            raise HTTPStatusError(f"{r.status_code} {r.reason} for {r.url}", r.status_code, _retry_after(r), r)
        cr = r.headers.get("Content-Range", "")
        total_s = cr.split("/")[-1]
        append = resuming and r.status_code == 206 and cr.startswith(f"bytes {first + have}-")
        if not append:
            have = 0
            # A partial response must start exactly where we asked; anything else starts over next attempt.
            if r.status_code == 206 and not (byte_range and cr.startswith(f"bytes {first}-")):
                part.unlink(missing_ok=True)
                meta_path.unlink(missing_ok=True)
                raise requests.RequestException(f"{url}: unexpected partial response ({cr or 'no Content-Range'})")
        extra: dict = {}
        if byte_range:
            if r.status_code != 206:
                part.unlink(missing_ok=True)
                meta_path.unlink(missing_ok=True)
                raise requests.RequestException(f"{url}: server ignored the Range header (HTTP {r.status_code})")
            extra = {"range": f"bytes={first}-{last}", "remoteBytes": int(total_s) if total_s.isdigit() else None,
                     "etag": r.headers.get("ETag"), "lastModified": r.headers.get("Last-Modified")}
        encoded = r.headers.get("Content-Encoding", "identity").lower() not in ("", "identity")
        etag = r.headers.get("ETag")
        new_validator = etag if etag and not etag.startswith("W/") else r.headers.get("Last-Modified")
        if not append:
            if new_validator and not encoded and data is None:
                meta_path.write_text(json.dumps({**ident, "validator": new_validator}), encoding="utf-8", newline="\n")
            else:
                meta_path.unlink(missing_ok=True)
        size = r.headers.get("Content-Length")
        expected = (have + int(size)) if size and size.isdigit() and not encoded else None
        prog = Progress(label, expected, have)
        with part.open("ab" if append else "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
                count(len(chunk))
                prog.update(len(chunk))
        got = part.stat().st_size
        if expected is not None and got != expected:
            raise requests.RequestException(f"{url}: short read ({got} of {expected} bytes)")
        if byte_range and got != byte_range[1] - byte_range[0]:
            raise requests.RequestException(f"{url}: short range read")
        return extra


def fetch(url: str, subdir: str, name: str | None = None, *, params: dict | None = None,
          retries: int = 6, timeout: float = 120.0, headers: dict | None = None,
          validate: Callable[[Path], bool] | None = None, byte_range: tuple[int, int] | None = None,
          record_url: str | None = None, data: dict | None = None) -> Path:
    """Download url to data/raw/<subdir>/<name> unless already present. Returns the local path.

    `headers` are extra request headers (some publishers reject the default client). `validate(path)` checks the
    content (e.g. that a .pdf really is a PDF and not a bot-check page): a cached file that fails it is fetched
    again, and a fresh download that fails it is retried, then raises ValueError instead of being recorded.
    `byte_range=(start, stop)` downloads only bytes [start, stop) with an HTTP Range request (the server must answer
    206); the ledger then also records the range and the remote file's size, ETag and Last-Modified, and a cached
    file is reused only for the same range. `record_url` is the URL written to the ledger instead of `url` (e.g.
    without a temporary access token). `data` makes the request a form POST (for queries too long for a URL; the
    caller names the file after the query, since the URL alone no longer identifies it); the ledger then records
    the sha256 and length of the POST body. Interrupted GET transfers resume (module docstring)."""
    name = name or url.rstrip("/").split("/")[-1]
    check_portable(f"{subdir}/{name}")
    dest = RAW / subdir / name
    key = ledger_key(dest)
    rng = f"bytes={byte_range[0]}-{byte_range[1] - 1}" if byte_range else None
    with _STATS_LOCK:
        dest_lock = _DEST_LOCKS.setdefault(dest, threading.Lock())
    with dest_lock:
        ledger = _load_ledger()
        if (dest.exists() and key in ledger and ledger[key].get("range") == rng
                and (validate is None or validate(dest))):
            return dest
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.name + ".partial")
        meta_path = dest.with_name(dest.name + ".partial.json")
        hdrs = dict(headers or {})
        extra: dict = {}
        for attempt in range(retries + 1):
            try:
                extra = _transfer(url, params, hdrs, part, meta_path, byte_range, timeout, key, data)
                if validate is not None and not validate(part):
                    part.unlink()
                    meta_path.unlink(missing_ok=True)
                    raise ValueError(f"{url}: downloaded content failed validation (not saved)")
                break
            except (requests.RequestException, ValueError) as e:
                retry_after = getattr(e, "retry_after", None)
                if attempt == retries or getattr(e, "retryable", True) is False:
                    raise
                wait = backoff(attempt, retry_after=retry_after)
                print(f"  [download] {key}: {type(e).__name__}: {str(e)[:200]}; retry {attempt + 1}/{retries} in "
                      f"{wait:.0f} s", flush=True)
                time.sleep(wait)
        _retry_io(lambda: part.replace(dest))
        meta_path.unlink(missing_ok=True)
        count(0, files=1)
        shown = record_url or url
        entry = {
            "url": shown if not params or record_url else _full_url(url, params),
            "sha256": sha256_file(dest),
            "retrieved": _dt.date.today().isoformat(),
            "bytes": dest.stat().st_size,
            **extra,
        }
        if data is not None:
            entry["method"] = "POST"
            entry["postSha256"] = post_digest(data)
            entry["postBytes"] = len(requests.compat.urlencode(data).encode())
        # Re-read under the lock: other threads/processes may have recorded downloads during the transfer.
        update_ledger(key, entry)
        return dest


def request(method: str, url: str, *, retries: int = 6, **kwargs) -> requests.Response:
    """One small, uncached HTTP request (a directory listing, an API token) with fetch's retry policy and host
    limit; raises for HTTP errors. Anything that becomes a raw input goes through `fetch` instead."""
    kwargs.setdefault("timeout", 60)
    for attempt in range(retries + 1):
        try:
            with host_slot(url):
                r = session().request(method, url, **kwargs)
            if r.status_code >= 400:
                raise HTTPStatusError(f"{r.status_code} {r.reason} for {r.url}", r.status_code, _retry_after(r), r)
            return r
        except requests.RequestException as e:
            if attempt == retries or getattr(e, "retryable", True) is False:
                raise
            wait = backoff(attempt, retry_after=getattr(e, "retry_after", None))
            print(f"  [download] {method} {url}: {type(e).__name__}; retry {attempt + 1}/{retries} in {wait:.0f} s",
                  flush=True)
            time.sleep(wait)
    raise AssertionError("unreachable")


def fetch_many(calls: list[tuple[tuple, dict]], workers: int = DEFAULT_HOST_LIMIT) -> list[Path]:
    """Run fetch(*args, **kwargs) for each (args, kwargs) with up to `workers` threads (per-host limits still
    apply). Returns the paths in the order given; the first error is raised after the others finish."""
    if workers <= 1 or len(calls) <= 1:
        return [fetch(*a, **kw) for a, kw in calls]
    with cf.ThreadPoolExecutor(workers) as ex:
        futs = [ex.submit(fetch, *a, **kw) for a, kw in calls]
        cf.wait(futs)
    return [f.result() for f in futs]
