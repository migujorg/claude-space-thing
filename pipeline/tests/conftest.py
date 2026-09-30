"""Test configuration.

Offline runs (PIPELINE_OFFLINE=1, set in CI): no network beyond this machine. A test that would download a raw
input into data/raw (or query an online service) is SKIPPED at its first connection attempt, naming the URL or
host it wanted, instead of downloading: CI has no data (.github/workflows/ci.yml). Loopback stays open, so tests
that serve fixtures from a local HTTP server still run. Tests that need built products skip themselves as before
(skipif on the product path). Without the variable, tests fetch missing raw inputs as the stages do (cached in
data/raw).
"""

from __future__ import annotations

import os
import socket
from urllib.parse import urlsplit

import pytest

OFFLINE = os.environ.get("PIPELINE_OFFLINE") == "1"
LOOPBACK = {"localhost", "127.0.0.1", "::1"}


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
