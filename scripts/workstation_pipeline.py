"""Run the pipeline with process-local Mullvad SOCKS fallback for Requests downloads."""
from __future__ import annotations

import json
import os
import faulthandler
from pathlib import Path
import runpy
import signal
import fcntl
import subprocess
import threading
import time
from functools import lru_cache
from urllib.parse import urlsplit

import requests
from requests.adapters import HTTPAdapter

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / "data/cache/workstation-proxies.json"
LOCK = threading.Lock()
COOLDOWNS = {}
try:
    ROUTES = json.loads(STATE.read_text())
except (OSError, ValueError):
    ROUTES = {}


def save_routes(host=None):
    """Caller holds LOCK."""
    STATE.parent.mkdir(parents=True, exist_ok=True)
    with STATE.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            saved = json.loads(STATE.read_text())
        except (OSError, ValueError):
            saved = {}
        if host is None:
            saved.update(ROUTES)
        elif host in ROUTES:
            saved[host] = ROUTES[host]
        else:
            saved.pop(host, None)
        tmp = STATE.with_suffix(".tmp")
        tmp.write_text(json.dumps(saved, indent=2))
        tmp.replace(STATE)


def candidates():
    values = ["socks5h://10.64.0.1:1080"]
    try:
        last = json.loads((Path.home() / ".cache/discord-mullvad-proxy/last-good.json").read_text())
        values.append(f"socks5h://{last['host']}:{last['port']}")
    except (OSError, ValueError, KeyError):
        pass
    values.extend(os.environ.get("SPACE_THING_PROXIES", "").replace(",", " ").split())
    return list(dict.fromkeys(values))


@lru_cache(maxsize=1)
def relay_candidates():
    """Like Equibop, discover relay SOCKS IPs using the cached Mullvad catalogue and tunnel DNS."""
    try:
        relays = json.loads((Path.home() / ".cache/discord-mullvad-proxy/relays.json").read_text())
    except (OSError, ValueError):
        return []
    result = []
    for country in ("ca", "gb", "nl", "se", "de", "fr", "ch", "jp"):
        relay = next((r for r in relays if r.get("country_code") == country and
                      r.get("type") == "wireguard" and r.get("active") and r.get("socks_name")), None)
        if not relay:
            continue
        try:
            dns = subprocess.run(["dig", "@10.64.0.1", "+time=1", "+tries=1", "+short",
                                  relay["socks_name"], "A"], capture_output=True, text=True, timeout=2)
        except (OSError, subprocess.SubprocessError):
            continue
        for address in dns.stdout.splitlines():
            if address.startswith("10.124."):
                result.append(f"socks5h://{address}:1080")
                break
    return result


class FallbackAdapter(HTTPAdapter):
    def send(self, request, **kwargs):
        host = urlsplit(request.url).hostname
        preferred = ROUTES.get(host)
        if host == "damit.cuni.cz":
            preferred = "socks5h://10.64.0.1:1080"
        # This bulk CDN is much faster directly on the workstation. A proxy
        # selected after one interrupted transfer must not pin the whole queue
        # to that slower route; retain the same fallback and cooldown handling.
        if host == "cdn.gea.esac.esa.int":
            preferred = os.environ.get("SPACE_THING_CDN_ROUTE") or None
        primary = list(dict.fromkeys([preferred, None, *candidates()])) if preferred else [None, *candidates()]
        cooldown_key = request.url if host == "cdn.gea.esac.esa.int" else host
        available = lambda route: COOLDOWNS.get((cooldown_key, route), 0) <= time.monotonic()
        routes = [route for route in primary if available(route)] or primary
        error = None
        expanded = False

        def expand():
            nonlocal expanded
            if not expanded:
                expanded = True
                routes.extend(p for p in relay_candidates() if p not in routes and available(p))

        for route in routes:
            options = dict(kwargs)
            if route:
                options["proxies"] = {"http": route, "https": route}
            # Keep a dead proxy from consuming the pipeline's 180-second read timeout.
            timeout = options.get("timeout")
            if isinstance(timeout, (int, float)):
                options["timeout"] = (5 if route else 10, timeout)
            elif isinstance(timeout, tuple):
                connect, read = timeout
                options["timeout"] = (min(connect or 10, 5 if route else 10), read)
            if host in {"articles.adsabs.harvard.edu", "atmos.nmsu.edu", "pds-atmospheres.nmsu.edu"}:
                connect, read = options.get("timeout") or (10, 30)
                options["timeout"] = (connect, min(read or 30, 30))
            try:
                response = super().send(request, **options)
            except (requests.ConnectionError, requests.Timeout) as exc:
                error = exc
                print(f"[network] {host}: {route or 'normal route'} failed ({type(exc).__name__}); trying fallback", flush=True)
                if route == routes[-1]:
                    expand()
                continue
            # Do not rotate around rate limits or retry missing files. The pipeline handles those.
            path = urlsplit(request.url).path.lower()
            expects_file = path.endswith((".pdf", ".tab", ".csv", ".bsp", ".fits", ".bz2", ".zip", "/pdf")) or "/pdf/" in path
            bad_content = expects_file and "text/html" in response.headers.get("Content-Type", "").lower()
            retry_route = response.status_code in {403, 502, 503, 504} or (response.status_code == 200 and bad_content)
            if response.headers.get("Retry-After") is not None or response.status_code == 429:
                retry_route = False
            if retry_route and route == routes[-1]:
                expand()
            if retry_route and route != routes[-1]:
                print(f"[network] {host}: {route or 'normal route'} returned HTTP {response.status_code}; trying fallback", flush=True)
                response.close()
                continue
            if response.status_code < 400 and not bad_content and route != preferred:
                with LOCK:
                    if route:
                        ROUTES[host] = route
                    else:
                        ROUTES.pop(host, None)
                    save_routes(host)
                if route:
                    print(f"[network] {host}: using {route}", flush=True)
            if response.status_code < 400 and not bad_content:
                original_content = response.iter_content

                def monitored_content(*args, _original=original_content, _route=route, **content_kwargs):
                    try:
                        yield from _original(*args, **content_kwargs)
                    except (requests.ConnectionError, requests.Timeout, requests.exceptions.ChunkedEncodingError):
                        with LOCK:
                            # A truncated CDN object should retry another route;
                            # unrelated files can still use the faster direct route.
                            COOLDOWNS[(cooldown_key, _route)] = time.monotonic() + 60
                            if ROUTES.get(host) == _route:
                                ROUTES.pop(host, None)
                                save_routes(host)
                        print(f"[network] {host}: interrupted stream; next retry uses another route", flush=True)
                        raise

                response.iter_content = monitored_content
            return response
        assert error is not None
        raise error


def reserve_tap_prefetch():
    """Keep the first eight shared archive slots available to the foreground build."""
    from pipeline import download
    if getattr(download, "_workstation_prefetch_reserved", False):
        return
    download._workstation_prefetch_reserved = True
    download.HOST_LIMITS["gaia.ari.uni-heidelberg.de"] = 16
    original = download._process_slot

    def slot(label, limit, **kwargs):
        if label == "host:gaia.ari.uni-heidelberg.de":
            kwargs.setdefault("start_slot", 8)
        return original(label, limit, **kwargs)

    download._process_slot = slot


def install():
    original = requests.Session.__init__

    def initialize(self):
        original(self)
        self.mount("https://", FallbackAdapter())
        self.mount("http://", FallbackAdapter())

    requests.Session.__init__ = initialize


if __name__ == "__main__":
    os.chdir(ROOT / "pipeline")
    faulthandler.register(signal.SIGUSR1)
    install()
    # All stages still run; put the usable core ahead of the large optional catalogues.
    from pipeline import config
    core = ["time", "ephemeris", "bodies", "light", "stars"]
    config.STAGES[:] = core + [stage for stage in config.STAGES if stage not in core]
    runpy.run_module("pipeline", run_name="__main__")
