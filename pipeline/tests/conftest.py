"""Test configuration.

Offline runs (PIPELINE_OFFLINE=1, set in CI): no network at all. A test that would download a raw input into
data/raw (or query an online service) is SKIPPED at its first connection attempt, naming the host it wanted,
instead of downloading: CI has no data (.github/workflows/ci.yml). Tests that need built products skip themselves
as before (skipif on the product path). Without the variable, tests fetch missing raw inputs as the stages do
(cached in data/raw).
"""

from __future__ import annotations

import os
import socket

import pytest

OFFLINE = os.environ.get("PIPELINE_OFFLINE") == "1"


def _skip(what) -> None:
    # pytest's Skipped outcome derives from BaseException: download retry loops (`except RequestException`,
    # `except Exception`) do not catch and retry it, and pytest reports a skip, also from module-scoped fixtures
    # and module-level code.
    raise pytest.skip.Exception(f"raw input not present and the network is off (PIPELINE_OFFLINE=1): wanted {what}", allow_module_level=True)


def _block_getaddrinfo(host, *args, **kwargs):
    _skip(host)


def _block_connect(self, address, *args, **kwargs):
    _skip(address)


if OFFLINE:
    socket.getaddrinfo = _block_getaddrinfo
    socket.socket.connect = _block_connect
    socket.socket.connect_ex = _block_connect
    try:  # name the URL rather than a proxy's address when requests is used (the stages' downloads)
        import requests.sessions

        def _block_request(self, method, url, *args, **kwargs):
            _skip(url)

        requests.sessions.Session.request = _block_request
    except ImportError:
        pass
