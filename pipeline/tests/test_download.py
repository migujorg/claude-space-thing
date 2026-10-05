"""download.fetch robustness against a local HTTP server: resume with Range/If-Range, retries on flaky answers,
fail-fast on permanent errors, per-host concurrency, Windows-portable names. Offline (loopback only)."""

from __future__ import annotations

import hashlib
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

import pytest
import requests

from pipeline import download


@pytest.fixture(autouse=True)
def metrics_off(monkeypatch):
    monkeypatch.delenv("PIPELINE_NETWORK_METRICS", raising=False)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    blob = b""
    etag: str | None = '"v1"'
    cut_after: int | None = None     # first full response: close the connection after this many bytes
    errors: list[int] = []           # status codes to answer first, one per request
    log: list[dict] = []
    active = 0
    max_active = 0
    lock = threading.Lock()
    delay = 0.0

    def log_message(self, *a):
        pass

    def do_GET(self):
        cls = type(self)
        with cls.lock:
            cls.log.append({"path": self.path, "range": self.headers.get("Range"), "ifRange": self.headers.get("If-Range")})
            cls.active += 1
            cls.max_active = max(cls.max_active, cls.active)
            err = cls.errors.pop(0) if cls.errors else None
        try:
            if cls.delay:
                time.sleep(cls.delay)
            if err:
                body = b"try later"
                self.send_response(err)
                if err == 503:
                    self.send_header("Retry-After", "0")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            data, code, rng = cls.blob, 200, self.headers.get("Range")
            if rng and (self.headers.get("If-Range") in (None, cls.etag)):
                a, b = rng.removeprefix("bytes=").split("-")
                a, b = int(a), (int(b) if b else len(cls.blob) - 1)
                data, code = cls.blob[a:b + 1], 206
            self.send_response(code)
            if code == 206:
                self.send_header("Content-Range", f"bytes {a}-{b}/{len(cls.blob)}")
            self.send_header("Content-Length", str(len(data)))
            if cls.etag:
                self.send_header("ETag", cls.etag)
            self.end_headers()
            if code == 200 and cls.cut_after is not None:
                n, cls.cut_after = cls.cut_after, None
                self.wfile.write(data[:n])
                self.wfile.flush()
                self.close_connection = True
                return
            self.wfile.write(data)
        finally:
            with cls.lock:
                cls.active -= 1


@pytest.fixture
def server(tmp_path, monkeypatch):
    monkeypatch.setattr(download, "RAW", tmp_path / "raw")
    monkeypatch.setattr(download, "_LEDGER", tmp_path / "raw" / "_downloads.json")
    monkeypatch.setattr(download, "backoff", lambda attempt, base=3.0, retry_after=None: 0.0)
    monkeypatch.setattr(download, "_HOST_SEMS", {})
    Handler.blob = bytes(range(256)) * 12000   # 3 MB: several of fetch's 1 MiB chunks
    Handler.etag, Handler.cut_after, Handler.errors, Handler.log = '"v1"', None, [], []
    Handler.active = Handler.max_active = 0
    Handler.delay = 0.0
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


def _entry(path):
    return json.loads(download._LEDGER.read_text(encoding="utf-8"))[download.ledger_key(path)]


def test_interrupted_transfer_resumes_with_range(server):
    Handler.cut_after = 2_500_000          # the connection drops after 2.5 MB: the two whole chunks are on disk
    p = download.fetch(server + "/big.bin", "t")
    assert p.read_bytes() == Handler.blob
    assert [r["range"] for r in Handler.log] == [None, f"bytes={2 << 20}-"]
    assert Handler.log[1]["ifRange"] == '"v1"'
    e = _entry(p)
    assert e["sha256"] == hashlib.sha256(Handler.blob).hexdigest() and e["bytes"] == len(Handler.blob)
    assert "range" not in e                        # recorded exactly as an uninterrupted download
    assert not list(p.parent.glob("*.partial*"))


def test_resume_after_a_crash_in_an_earlier_build(server):
    d = download.RAW / "t"
    d.mkdir(parents=True)
    (d / "big.bin.partial").write_bytes(Handler.blob[:123_456])
    (d / "big.bin.partial.json").write_text(json.dumps(
        {"url": server + "/big.bin", "range": None, "validator": '"v1"'}), encoding="utf-8")
    p = download.fetch(server + "/big.bin", "t")
    assert p.read_bytes() == Handler.blob and [r["range"] for r in Handler.log] == ["bytes=123456-"]


def test_changed_file_is_downloaded_whole(server):
    d = download.RAW / "t"
    d.mkdir(parents=True)
    (d / "big.bin.partial").write_bytes(b"x" * 1000)
    (d / "big.bin.partial.json").write_text(json.dumps(
        {"url": server + "/big.bin", "range": None, "validator": '"old"'}), encoding="utf-8")
    p = download.fetch(server + "/big.bin", "t")
    assert p.read_bytes() == Handler.blob             # If-Range did not match: the server sent it whole


def test_no_validator_no_resume(server):
    Handler.etag = None
    Handler.cut_after = 2_500_000
    p = download.fetch(server + "/big.bin", "t")
    assert p.read_bytes() == Handler.blob and [r["range"] for r in Handler.log] == [None, None]


def test_byte_range_fetch_resumes_within_its_range(server):
    Handler.cut_after = None
    d = download.RAW / "t"
    d.mkdir(parents=True)
    (d / "part").with_name("part.partial").write_bytes(Handler.blob[1000:1500])
    (d / "part.partial.json").write_text(json.dumps(
        {"url": server + "/big.bin", "range": [1000, 5000], "validator": '"v1"'}), encoding="utf-8")
    p = download.fetch(server + "/big.bin", "t", "part", byte_range=(1000, 5000))
    assert p.read_bytes() == Handler.blob[1000:5000]
    assert Handler.log[0]["range"] == "bytes=1500-4999"
    assert _entry(p)["range"] == "bytes=1000-4999" and _entry(p)["remoteBytes"] == len(Handler.blob)


def test_retries_transient_errors_and_fails_fast_on_permanent_ones(server):
    Handler.errors = [503, 502]
    p = download.fetch(server + "/a.bin", "t")
    assert p.read_bytes() == Handler.blob and len(Handler.log) == 3
    Handler.log.clear()
    Handler.errors = [404]
    with pytest.raises(requests.HTTPError) as e:
        download.fetch(server + "/missing.bin", "t")
    assert e.value.status == 404 and len(Handler.log) == 1
    Handler.log.clear()
    Handler.errors = [503] * 3
    with pytest.raises(requests.HTTPError):
        download.fetch(server + "/b.bin", "t", retries=2)
    assert len(Handler.log) == 3


def test_small_requests_retry_too(server):
    Handler.errors = [503, 500]
    r = download.request("GET", server + "/listing")
    assert r.status_code == 200 and len(Handler.log) == 3
    Handler.log.clear()
    Handler.errors = [403]
    with pytest.raises(requests.HTTPError):
        download.request("GET", server + "/listing")
    assert len(Handler.log) == 1


def test_cached_file_is_not_fetched_again(server):
    p = download.fetch(server + "/a.bin", "t")
    Handler.log.clear()
    assert download.fetch(server + "/a.bin", "t") == p and Handler.log == []


@pytest.mark.parametrize("byte_range", [None, (1, 4)])
def test_cache_hit_needs_no_locks_or_writes(tmp_path, monkeypatch, byte_range):
    raw = tmp_path / "raw"
    dest = raw / "t" / "cached.bin"
    dest.parent.mkdir(parents=True)
    dest.write_bytes(b"cached")
    ledger = raw / "_downloads.json"
    entry = {"sha256": hashlib.sha256(b"cached").hexdigest(), "bytes": 6}
    if byte_range:
        entry["range"] = "bytes=1-3"
    ledger.write_text(json.dumps({"t/cached.bin": entry}))
    monkeypatch.setattr(download, "RAW", raw)
    monkeypatch.setattr(download, "_LEDGER", ledger)

    def forbidden(*args, **kwargs):
        raise AssertionError("a cache hit must not lock or write")

    class NoLock:
        __enter__ = forbidden
        __exit__ = forbidden

    original_open = Path.open
    def read_only_open(path, mode="r", *args, **kwargs):
        if any(flag in mode for flag in "wax+"):
            raise PermissionError("raw is read only")
        return original_open(path, mode, *args, **kwargs)

    monkeypatch.setattr(download, "_STATS_LOCK", NoLock())
    monkeypatch.setattr(download, "_process_slot", forbidden)
    monkeypatch.setattr(Path, "mkdir", forbidden)
    monkeypatch.setattr(Path, "open", read_only_open)
    assert download.fetch("https://unused.example/cached.bin", "t", byte_range=byte_range,
                          validate=lambda path: path.read_bytes() == b"cached") == dest
    assert not (raw / ".locks").exists()


@pytest.mark.parametrize("miss", ["file", "ledger", "range", "validation"])
def test_cache_miss_still_transfers(server, miss):
    dest = download.fetch(server + "/a.bin", "t")
    Handler.log.clear()
    options = {}
    if miss == "file":
        dest.unlink()
    elif miss == "ledger":
        download.update_ledger(download.ledger_key(dest), None)
    elif miss == "range":
        options["byte_range"] = (1, 4)
    else:
        dest.write_bytes(b"invalid")
        options["validate"] = lambda path: path.read_bytes() == Handler.blob
    assert download.fetch(server + "/a.bin", "t", **options) == dest
    assert len(Handler.log) == 1
    assert dest.read_bytes() == (Handler.blob[1:4] if miss == "range" else Handler.blob)


def test_processes_recheck_cache_after_waiting_for_destination(server, tmp_path):
    # Hold the lease until both independent processes have observed a miss.
    code = '''
import contextlib, json, sys
from pathlib import Path
from pipeline import download
slot = download._process_slot
@contextlib.contextmanager
def ready_slot(label, limit, start_slot=0):
    if label.startswith("file:"):
        Path(sys.argv[2]).touch()
    with slot(label, limit, start_slot):
        yield
download._process_slot = ready_slot
path = download.fetch(sys.argv[1] + "/shared.bin", "t")
print(json.dumps({"sha256": download.sha256_file(path), **download.stats()}))
'''
    env = {**os.environ, "PIPELINE_RAW": str(download.RAW), "PIPELINE_CACHE": str(tmp_path / "cache")}
    dest = download.RAW / "t" / "shared.bin"
    processes = []
    ready = [tmp_path / f"ready-{i}" for i in range(2)]
    try:
        with download._process_slot("file:" + str(dest.resolve()), 1):
            for marker in ready:
                processes.append(subprocess.Popen([sys.executable, "-c", code, server, str(marker)],
                                                  env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
            deadline = time.monotonic() + 10
            while not all(marker.exists() for marker in ready) and time.monotonic() < deadline:
                time.sleep(0.01)
            assert all(marker.exists() for marker in ready), "both processes must observe the initial miss"
        results = []
        for process in processes:
            stdout, stderr = process.communicate(timeout=20)
            assert process.returncode == 0, stderr
            results.append(json.loads(stdout))
        assert len(Handler.log) == 1
        assert [result["sha256"] for result in results] == [hashlib.sha256(Handler.blob).hexdigest()] * 2
        assert sorted(result["files"] for result in results) == [0, 1]
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
            process.communicate()


@pytest.mark.parametrize("first_call", ["count", "host_slot"])
@pytest.mark.parametrize("switch", [None, "0", "1"])
def test_network_metrics_require_explicit_opt_in(tmp_path, switch, first_call):
    # Each child exits with its daemon, so no writer outlives a temporary cache.
    code = '''
import json, os, sys, threading, time
from pipeline import download
folder = download.CACHE / "network-metrics"
enabled = os.environ.get("PIPELINE_NETWORK_METRICS") == "1"
threads = threading.active_count()
def add_counts():
    download.count(7, files=1)
    download.count(5, network=False)
if sys.argv[1] == "count":
    add_counts()
    if not enabled:
        assert not download._METRICS_STARTED
        assert threading.active_count() == threads
        assert not folder.exists()
def wait_for(active):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            metric = json.loads((folder / f"{os.getpid()}.json").read_text())
            if (metric["bytes"], metric["files"], metric["receivedBytes"], metric["active"], metric["waiting"]) == (12, 1, 7, active, 0):
                assert metric["genericActive"] == active and metric["genericWaiting"] == 0
                return
        except (OSError, ValueError):
            pass
        time.sleep(0.01)
    raise AssertionError("metrics did not publish current counters")
with download.host_slot("https://generic.example/file"):
    if sys.argv[1] == "host_slot":
        if not enabled:
            assert not download._METRICS_STARTED
            assert threading.active_count() == threads
            assert not folder.exists()
        add_counts()
    if enabled:
        wait_for(1)
    else:
        assert not download._METRICS_STARTED
        assert threading.active_count() == threads
        assert not folder.exists()
if enabled:
    wait_for(0)
    assert threading.active_count() == threads + 1
else:
    assert not folder.exists()
assert download.stats() == {"bytes": 12, "files": 1}
'''
    env = {**os.environ, "PIPELINE_RAW": str(tmp_path / "raw"), "PIPELINE_CACHE": str(tmp_path / "cache")}
    if switch is not None:
        env["PIPELINE_NETWORK_METRICS"] = switch
    result = subprocess.run([sys.executable, "-c", code, first_call], env=env,
                            capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr


def test_processes_share_controlled_host_limit_without_metrics(tmp_path, monkeypatch):
    raw, cache = tmp_path / "raw", tmp_path / "cache"
    cache.mkdir()
    (cache / "network-control.json").write_text(json.dumps({"genericPerHost": 1}))
    monkeypatch.setattr(download, "RAW", raw)
    monkeypatch.setattr(download, "CACHE", cache)
    code = '''
import sys, time
from pathlib import Path
from pipeline import download
Path(sys.argv[1]).touch()
with download.host_slot("https://controlled.example/file"):
    with Path(sys.argv[2]).open("a") as events:
        events.write("enter\\n")
    time.sleep(0.1)
    with Path(sys.argv[2]).open("a") as events:
        events.write("exit\\n")
assert not download._METRICS_STARTED
'''
    env = {**os.environ, "PIPELINE_RAW": str(raw), "PIPELINE_CACHE": str(cache)}
    events = tmp_path / "events"
    ready = [tmp_path / f"ready-{i}" for i in range(2)]
    processes = []
    try:
        with download.host_slot("https://controlled.example/file"):
            for marker in ready:
                processes.append(subprocess.Popen([sys.executable, "-c", code, str(marker), str(events)],
                                                  env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
            deadline = time.monotonic() + 10
            while not all(marker.exists() for marker in ready) and time.monotonic() < deadline:
                time.sleep(0.01)
            assert all(marker.exists() for marker in ready)
            assert not events.exists(), "the parent's host lease must block both children"
        for process in processes:
            stdout, stderr = process.communicate(timeout=20)
            assert process.returncode == 0, stderr
        assert events.read_text().splitlines() == ["enter", "exit", "enter", "exit"]
        assert not (cache / "network-metrics").exists()
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
            process.communicate()


def test_fetch_many_keeps_order_and_host_limit(server, monkeypatch):
    monkeypatch.setitem(download.HOST_LIMITS, "127.0.0.1", 2)
    Handler.delay = 0.1
    before = download.stats()
    calls = [((server + f"/f{i}.bin", "t"), {}) for i in range(6)]
    paths = download.fetch_many(calls, workers=6)
    assert [p.name for p in paths] == [f"f{i}.bin" for i in range(6)]
    assert Handler.max_active == 2
    after = download.stats()
    assert after["files"] - before["files"] == 6 and after["bytes"] - before["bytes"] == 6 * len(Handler.blob)


def test_backoff_honours_retry_after():
    assert download.backoff(0, retry_after=7.0) == 7.0
    assert download.backoff(0, retry_after=1e6) == download.MAX_BACKOFF_S
    assert 1.5 <= download.backoff(0) <= 4.5 and download.backoff(20) <= download.MAX_BACKOFF_S * 1.5


@pytest.mark.parametrize("bad", ["a:b.txt", "x/con.txt", "ok/trailing.", "q?x=1", "back\\slash", "t/" + "n" * 200])
def test_names_must_be_portable(bad):
    with pytest.raises(ValueError):
        download.check_portable(bad)


def test_portable_names_pass():
    download.check_portable("surfaces/earth/gibs/VIIRS_2026-09-28_-90_-180_-45_-90_8192x4096.png")
    download.check_portable("naif/spk-excerpts/sat441_JD2460763.876-2461863.876.bsp")


def test_reserved_host_slots_leave_foreground_slots_free(tmp_path, monkeypatch):
    import fcntl
    import hashlib
    host = "reserved.example"
    monkeypatch.setattr(download, "RAW", tmp_path)
    monkeypatch.setitem(download.HOST_LIMITS, host, 16)
    label = "host:" + host
    folder = tmp_path / ".locks" / hashlib.sha256(label.encode()).hexdigest()
    with download._process_slot(label, 16, start_slot=8):
        assert (folder / "8.lock").exists()
        assert not (folder / "0.lock").exists()
        with (folder / "8.lock").open("a+b") as occupied:
            with pytest.raises(BlockingIOError):
                fcntl.flock(occupied, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with (folder / "0.lock").open("a+b") as foreground:
            fcntl.flock(foreground, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(foreground, fcntl.LOCK_UN)
