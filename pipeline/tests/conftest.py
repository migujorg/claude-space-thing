"""Test configuration.

Offline runs (PIPELINE_OFFLINE=1, set in CI): no network beyond this machine. A test that would download a raw
input into data/raw (or query an online service) is SKIPPED at its first connection attempt, naming the URL or
host it wanted, instead of downloading: CI has no data (.github/workflows/ci.yml). Loopback stays open, so tests
that serve fixtures from a local HTTP server still run. Tests that need built products skip themselves as before
(skipif on the product path). Shared raw inputs, intermediates and products are read only even in an online run:
tests which exercise writers must redirect their paths to temporary directories.
"""

from __future__ import annotations

import os
import socket
import shutil
import sys
import tempfile
from functools import wraps
from pathlib import Path
from urllib.parse import urlsplit

import pytest

OFFLINE = os.environ.get("PIPELINE_OFFLINE") == "1"
LOOPBACK = {"localhost", "127.0.0.1", "::1"}


class SharedDataWriteError(AssertionError):
    """A test tried to mutate an input shared with builds or another lane."""


class DataWriteGuard:
    """Audit Python filesystem mutations, including numpy file opens and symlink aliases.

    Read opens have no path-resolution overhead. Existing-directory mkdir calls are harmless (paths.py
    uses them on import); creation below those directories is forbidden. Roots are captured once, so a
    test may redirect environment variables/module aliases without weakening protection of shared data.
    """

    def __init__(self, roots):
        self.roots = tuple({q for p in roots for q in (Path(p).absolute(), Path(p).resolve())})
        self.violations = []

    def install(self):
        sys.addaudithook(self)
        # CPython's open audit event omits dir_fd; check it before resolving the relative path.
        original = os.open

        @wraps(original)
        def guarded_open(path, flags, mode=0o777, *, dir_fd=None):
            if dir_fd is not None and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
                self.check(path, dir_fd)
            return original(path, flags, mode, dir_fd=dir_fd)

        os.open = guarded_open

    def check(self, path, dir_fd=None, *, follow_leaf=True):
        if isinstance(path, int):  # open/truncate may receive an already-open file descriptor
            path = os.readlink(f"/proc/self/fd/{path}")
        path = Path(os.fsdecode(path))
        if not path.is_absolute() and dir_fd not in (None, -1):
            path = Path(os.readlink(f"/proc/self/fd/{dir_fd}")) / path
        path = path.resolve() if follow_leaf else path.parent.resolve() / path.name
        if any(path == root or root in path.parents for root in self.roots):
            message = f"test attempted to write shared pipeline data: {path}; redirect the writer to tmp_path"
            self.violations.append(message)
            raise SharedDataWriteError(message)

    def __call__(self, event, args):
        if event == "open":
            path, mode, flags = args
            if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
                self.check(path)
        elif event == "os.mkdir":
            path, mode, dir_fd = args
            if dir_fd == -1 and Path(os.fsdecode(path)).is_dir():
                return
            self.check(path, dir_fd, follow_leaf=False)
        elif event in {"os.remove", "os.rmdir"}:
            self.check(args[0], args[1], follow_leaf=False)
        elif event in {"os.rename", "os.link"}:
            self.check(args[0], args[2], follow_leaf=event == "os.link")
            self.check(args[1], args[3], follow_leaf=False)
        elif event == "os.symlink":
            self.check(args[1], args[2], follow_leaf=False)
        elif event in {"os.chmod", "os.utime"}:
            self.check(args[0], args[-1])
        elif event == "os.truncate":
            self.check(args[0])


def pytest_configure(config):
    config.addinivalue_line("markers", "skip_group(group): skip accounting: missing-input or opt-in")
    repo = Path(__file__).resolve().parents[2]
    defaults = (repo / "data/raw", repo / "data/cache", repo / "app/public/data")
    roots = [os.environ.get(key) or default for key, default in zip(
        ("PIPELINE_RAW", "PIPELINE_CACHE", "PIPELINE_OUT"), defaults)]
    # paths.py creates its roots on import. On a data-free CI checkout, redirect missing roots before
    # collection so importing the pipeline cannot create shared directories just to discover absent inputs.
    config._test_data_env = {}
    config._test_data_tmp = None
    for key, root in zip(("PIPELINE_RAW", "PIPELINE_CACHE", "PIPELINE_OUT"), roots):
        if not Path(root).expanduser().is_dir():
            if config._test_data_tmp is None:
                config._test_data_tmp = tempfile.TemporaryDirectory(prefix="pipeline-test-data-")
            private = Path(config._test_data_tmp.name) / key.lower()
            private.mkdir()
            config._test_data_env[key] = os.environ.get(key)
            os.environ[key] = str(private)
    config._data_write_guard = DataWriteGuard([*roots, *defaults])
    config._data_write_guard.install()


def pytest_unconfigure(config):
    for key, original in config._test_data_env.items():
        if original is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = original
    if config._test_data_tmp is not None:
        config._test_data_tmp.cleanup()


def pytest_runtest_setup(item):
    item.config._data_write_guard.violations.clear()


@pytest.fixture(scope="session", autouse=True)
def private_earth_cache(tmp_path_factory):
    """Earth photometry can populate its disk-integral cache even in a reader test.

    Seed the small JSON cache to keep warm runs fast, but direct cold computations to temporary storage.
    This also covers indirect spectrum/phase calls in other photometry tests.
    """
    from pipeline.photometry import earth

    original = earth.CACHE
    private = tmp_path_factory.mktemp("earth-cache")
    if (original / "earth").is_dir():
        shutil.copytree(original / "earth", private / "earth")
    earth.CACHE = private
    try:
        yield
    finally:
        earth.CACHE = original


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    report = (yield).get_result()
    # Even a writer that catches AssertionError must not turn an attempted mutation into a passing test.
    violations = item.config._data_write_guard.violations
    if not report.failed and violations:
        report.outcome = "failed"
        report.longrepr = "\n".join(violations)
    violations.clear()
    if report.skipped:
        marker = item.get_closest_marker("skip_group")
        offline_missing = "raw input not present and the network is off" in str(report.longrepr)
        report.skip_group = marker.args[0] if marker else "missing-input" if offline_missing else "unaccounted"


def pytest_terminal_summary(terminalreporter):
    counts = {"missing-input": 0, "opt-in": 0, "unaccounted": 0}
    for report in terminalreporter.stats.get("skipped", []):
        group = getattr(report, "skip_group", "unaccounted")
        counts[group if group in counts else "unaccounted"] += 1
    terminalreporter.write_line("pipeline skip groups: " + ", ".join(f"{k}={v}" for k, v in counts.items()))


def _skip(what) -> None:
    # pytest's Skipped outcome derives from BaseException: download retry loops (`except RequestException`,
    # `except Exception`) do not catch and retry it, and pytest reports a skip, also from module-scoped fixtures
    # and module-level code.
    raise pytest.skip.Exception(f"raw input not present and the network is off (PIPELINE_OFFLINE=1): wanted {what}", allow_module_level=True)


if OFFLINE:
    _getaddrinfo = socket.getaddrinfo
    _connect = socket.socket.connect
    _connect_ex = socket.socket.connect_ex

    def _block_getaddrinfo(host, *args, **kwargs):
        if host in LOOPBACK or host is None:
            return _getaddrinfo(host, *args, **kwargs)
        _skip(host)

    def _loopback(address) -> bool:
        return isinstance(address, tuple) and address[0] in LOOPBACK or isinstance(address, (str, bytes))  # AF_UNIX paths

    def _block_connect(self, address, *args, **kwargs):
        if _loopback(address):
            return _connect(self, address, *args, **kwargs)
        _skip(address)

    def _block_connect_ex(self, address, *args, **kwargs):
        if _loopback(address):
            return _connect_ex(self, address, *args, **kwargs)
        _skip(address)

    socket.getaddrinfo = _block_getaddrinfo
    socket.socket.connect = _block_connect
    socket.socket.connect_ex = _block_connect_ex
    try:  # name the URL (and bypass any proxy) when requests is used, as the stages' downloads do
        import requests.sessions

        _request = requests.sessions.Session.request

        def _block_request(self, method, url, *args, **kwargs):
            if (urlsplit(url).hostname or "") in LOOPBACK:
                return _request(self, method, url, *args, **kwargs)
            _skip(url)

        requests.sessions.Session.request = _block_request
    except ImportError:
        pass
