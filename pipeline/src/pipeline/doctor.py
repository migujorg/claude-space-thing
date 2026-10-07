"""`python -m pipeline doctor`: check that this machine can build the data and run the app, and say what to fix.

Checks Python and the compiled packages (numba's JIT, SPICE, HDF5, ...), uv, Node/npm for the app, free disk space
for the chosen profile (pipeline/config.py COSTS), Windows long-path support, write access to the data
directories, and that every data host the profile's stages download from answers over HTTPS (through the same
proxy and CA settings the build uses). Exit code 1 if anything must be fixed first.
"""

from __future__ import annotations

import concurrent.futures as cf
import importlib
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import warnings
from pathlib import Path

from . import config
from .paths import CACHE, OUT, RAW, REPO

#: Hosts each stage downloads from (from the download ledger of a full build, plus services queried directly:
#: Gaia TAP and XP bulk files, NASA GIBS, Planetary Computer).
HOSTS: dict[str, tuple[str, ...]] = {
    "time": ("naif.jpl.nasa.gov",),
    "ephemeris": ("naif.jpl.nasa.gov",),
    "light": ("naif.jpl.nasa.gov", "lasp.colorado.edu", "files.cie.co.at", "svo2.cab.inta-csic.es",
              "archives.esac.esa.int", "pds-rings.seti.org", "zenodo.org", "arxiv.org", "articles.adsabs.harvard.edu",
              "iopscience.iop.org", "sourceforge.net", "nssdc.gsfc.nasa.gov", "web.lmd.jussieu.fr",
              "www-mars.lmd.jussieu.fr", "raw.githubusercontent.com", "www.iup.uni-bremen.de", "ntrs.nasa.gov",
              "b.tellusjournals.se", "sbnarchive.psi.edu", "www.data.jma.go.jp", "pdssbn.astro.umd.edu",
              "noaa-himawari9.s3.amazonaws.com", "w.astro.berkeley.edu", "stacks.iop.org", "insu.hal.science",
              "ciclops.org", "pages.astro.umd.edu"),
    "surfaces": ("asc-pds-services.s3.us-west-2.amazonaws.com", "pds-smallbodies.astro.umd.edu",
                 "ncc.nesdis.noaa.gov", "www.ngdc.noaa.gov", "gibs.earthdata.nasa.gov",
                 "modiseuwest.blob.core.windows.net", "planetarycomputer.microsoft.com", "www.oceancolour.org",
                 "data.remss.com", "hrscteam.dlr.de", "pds-geosciences.wustl.edu", "planetarydata.jpl.nasa.gov",
                 "pds.mcp.nasa.gov", "archive.stsci.edu", "pds-rings.seti.org"),
    "shapes": ("sbnarchive.psi.edu", "spiftp.esac.esa.int", "naif.jpl.nasa.gov", "damit.cuni.cz",
               "ssd-api.jpl.nasa.gov"),
    "bodies": ("naif.jpl.nasa.gov",),
    "smallbodies": ("ssd-api.jpl.nasa.gov", "ssd.jpl.nasa.gov", "minorplanetcenter.net", "ssp.imcce.fr",
                    "minplanobs.org", "sbnarchive.psi.edu", "cdn.gea.esac.esa.int"),
    "sbphotometry": ("files.pythonhosted.org", "ssd.jpl.nasa.gov"),
    "synthetic": ("www.mv.helsinki.fi", "www.cfeps.net", "arxiv.org", "www.minorplanetcenter.net", "zenodo.org",
                  "iopscience.iop.org"),
    "comets": ("ssd.jpl.nasa.gov", "asteroid.lowell.edu", "pdssbn.astro.umd.edu", "omniweb.gsfc.nasa.gov",
               "spdf.gsfc.nasa.gov", "www.lpi.usra.edu", "arxiv.org"),
    "stars": ("gea.esac.esa.int", "archive.stsci.edu", "www.stsci.edu", "cdsarc.cds.unistra.fr", "cds.unistra.fr",
              "www.pas.rochester.edu"),
    "deepstars": ("gea.esac.esa.int",),
    "sky": ("gea.esac.esa.int", "www.stsci.edu", "arxiv.org", "scispace.com", "articles.adsabs.harvard.edu", "www.sidc.be",
            "services.swpc.noaa.gov"),
    "nightglow": ("zenodo.org", "gmd.copernicus.org", "www.spaceweather.gc.ca", "services.swpc.noaa.gov",
                  "spdf.gsfc.nasa.gov", "raw.githubusercontent.com", "www.ngdc.noaa.gov", "acd-ext.gsfc.nasa.gov",
                  "srd.nist.gov", "web.ipac.caltech.edu", "www.frontiersin.org", "angeo.copernicus.org",
                  "acp.copernicus.org", "amt.copernicus.org", "physics.nist.gov", "ntrs.nasa.gov", "files.cie.co.at",
                  "naif.jpl.nasa.gov"),
}
#: The Gaia XP spectra's host, by stars.xpSource (stars_gaia module docstring), for the stages that read them.
XP_HOSTS = {"archive": "gaia.ari.uni-heidelberg.de", "bulk": "cdn.gea.esac.esa.int"}
XP_STAGES = ("stars", "deepstars", "sky")

# Compiled or native packages: a missing wheel shows up here first.
PACKAGES = ("numpy", "scipy", "numba", "llvmlite", "h5py", "spiceypy", "pyarrow", "fast_simplification", "astropy",
            "colour", "PIL", "tifffile", "jplephem", "requests")
MIN_NODE = ((20, 19), (22, 12))   # Vite 7: Node 20.19+ or 22.12+


class Report:
    def __init__(self):
        self.fails = 0
        self.warns = 0

    def ok(self, msg: str) -> None:
        print(f"  [ok]    {msg}")

    def info(self, msg: str) -> None:
        print(f"  [info]  {msg}")

    def warn(self, msg: str, fix: str = "") -> None:
        self.warns += 1
        print(f"  [warn]  {msg}" + (f"\n          -> {fix}" if fix else ""))

    def fail(self, msg: str, fix: str = "") -> None:
        self.fails += 1
        print(f"  [FAIL]  {msg}" + (f"\n          -> {fix}" if fix else ""))


def _version(cmd: list[str]) -> str | None:
    exe = shutil.which(cmd[0])
    if not exe:
        return None
    try:
        out = subprocess.run([exe, *cmd[1:]], capture_output=True, text=True, timeout=30)
        return (out.stdout or out.stderr).strip().splitlines()[0] if (out.stdout or out.stderr) else ""
    except (OSError, subprocess.SubprocessError):
        return None


def check_python(r: Report) -> None:
    v = sys.version_info
    where = "" if sys.prefix != sys.base_prefix else " (not in a virtual environment: use `uv run`)"
    if v < (3, 11):
        r.fail(f"Python {platform.python_version()}", "Python 3.11 or newer is required (uv installs one: "
                                                      "`uv python install 3.12`)")
    else:
        r.ok(f"Python {platform.python_version()} ({sys.executable}){where}")
    if os.name == "nt" and not sys.flags.utf8_mode:
        r.warn("Python is not in UTF-8 mode", "`python -m pipeline` switches itself; for other commands (pytest) set "
                                              "PYTHONUTF8=1")
    uv = _version(["uv", "--version"])
    if uv:
        r.ok(uv)
    else:
        r.warn("uv not found on PATH", "install it: https://docs.astral.sh/uv/getting-started/installation/")


def check_packages(r: Report) -> None:
    missing, got = [], []
    for name in PACKAGES:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")      # e.g. colour-science's note about optional matplotlib
                m = importlib.import_module(name)
            got.append(f"{name} {getattr(m, '__version__', '')}".strip())
        except Exception as e:  # noqa: BLE001 - a broken native wheel raises anything
            missing.append(f"{name} ({type(e).__name__}: {e})")
    if missing:
        r.fail("cannot import " + "; ".join(missing), "run `uv sync` in pipeline/ (wheels exist for Windows, macOS and "
                                                      "Linux on Python 3.11-3.14)")
    else:
        r.ok("packages: " + ", ".join(got))
    try:
        import numba
        numba.njit(lambda x: x + 1)(1)
        r.ok("numba compiles (LLVM works)")
    except Exception as e:  # noqa: BLE001
        r.fail(f"numba cannot compile: {e}", "reinstall with `uv sync --reinstall-package numba --reinstall-package "
                                             "llvmlite`")
    try:
        import spiceypy
        r.ok(f"SPICE {spiceypy.tkvrsn('TOOLKIT')}")
    except Exception as e:  # noqa: BLE001
        r.fail(f"SPICE unavailable: {e}")


def check_node(r: Report) -> None:
    v = _version(["node", "--version"])
    if v is None:
        r.fail("Node.js not found", "install Node 22 LTS from https://nodejs.org (the app's dev server needs it)")
        return
    m = re.match(r"v(\d+)\.(\d+)", v)
    ver = (int(m.group(1)), int(m.group(2))) if m else (0, 0)
    if not any(ver[0] == a and ver[1] >= b for a, b in MIN_NODE) and ver[0] <= 22:
        r.fail(f"Node {v}", "Vite 7 needs Node 20.19+ or 22.12+: install Node 22 LTS from https://nodejs.org")
    else:
        r.ok(f"Node {v}")
    npm = _version(["npm", "--version"])
    if npm is None:
        r.fail("npm not found", "it comes with Node.js; reinstall Node")
    else:
        r.ok(f"npm {npm}")
    if not (REPO / "app" / "node_modules").is_dir():
        r.info("app dependencies not installed yet (run.sh / run.ps1 runs `npm install` in app/)")


def _existing(p: Path) -> Path:
    """p, or its nearest existing parent (a data directory may not exist before the first build)."""
    p = p.resolve()
    while not p.exists() and p.parent != p:
        p = p.parent
    return p


def _drive(p: Path) -> str:
    p = _existing(p)
    return os.path.splitdrive(str(p))[0] or str(os.stat(p).st_dev)


def check_disk(r: Report, profile: str) -> None:
    t = config.profile_totals(profile)
    need = {"raw": t["raw_gb"], "cache": config.CACHE_GB, "out": t["product_gb"]}
    transient = t["disk_gb"] - sum(need.values())
    need["raw"] += transient          # large sources land in data/raw before they are reduced and deleted
    by_drive: dict[str, list] = {}
    for key, path in (("raw", RAW), ("cache", CACHE), ("out", OUT)):
        by_drive.setdefault(_drive(path), []).append((key, path))
    for _, items in by_drive.items():
        path = items[0][1]
        free = shutil.disk_usage(_existing(path)).free / 1e9
        gb = sum(need[k] for k, _ in items)
        what = ", ".join(str(p) for _, p in items)
        msg = (f"{free:.0f} GB free for {what}; profile {profile} needs ~{gb:.0f} GB there "
               f"(cold download ~{t['download_gb']:.0f} GB, most of it streamed, not stored)")
        if free < gb:
            r.fail(msg, "free space, choose a smaller profile, or move downloads with PIPELINE_RAW / PIPELINE_CACHE "
                        "(absolute paths on a larger drive)")
        elif free < 1.5 * gb:
            r.warn(msg, "tight: leave room for rebuilds")
        else:
            r.ok(msg)


def _long_paths_enabled() -> bool | None:
    if os.name != "nt":
        return None
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\FileSystem") as k:
            return winreg.QueryValueEx(k, "LongPathsEnabled")[0] == 1
    except OSError:
        return False


def check_paths(r: Report) -> None:
    longest = 160   # longest path the build creates under the repository (data/raw/surfaces/earth/gibs/...)
    total = len(str(REPO)) + longest
    lp = _long_paths_enabled()
    if lp is False and total > 250:
        r.fail(f"the repository path is {len(str(REPO))} characters, so some data files would pass Windows' 260-"
               "character limit", "enable long paths (PowerShell as administrator: New-ItemProperty -Path "
               "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem -Name LongPathsEnabled -Value 1 -PropertyType "
               "DWORD -Force), or clone to a shorter path such as C:\\src\\space-thing")
    elif lp is False:
        r.ok(f"paths fit Windows' 260-character limit ({total} at most; long paths are off)")
    else:
        r.ok(f"repository at {REPO}")
    for name, p in (("data/raw", RAW), ("data/cache", CACHE), ("app/public/data", OUT)):
        try:
            p.mkdir(parents=True, exist_ok=True)
            probe = p / f".doctor-{os.getpid()}"
            probe.write_bytes(b"ok")
            probe.unlink()
        except OSError as e:
            r.fail(f"cannot write to {p} ({name}): {e}")
    for env in ("PIPELINE_RAW", "PIPELINE_CACHE", "PIPELINE_OUT"):
        if os.environ.get(env):
            r.info(f"{env}={os.environ[env]}")
    sh = REPO / "run.sh"
    if sh.exists() and b"\r\n" in sh.read_bytes():
        r.warn("run.sh has Windows line endings (git core.autocrlf)", "use run.ps1 on Windows, or re-checkout: "
               "git rm --cached -r . && git reset --hard (the repository's .gitattributes keeps *.sh LF)")


def _probe(host: str) -> tuple[str, str | None, float]:
    """(host, error or None, seconds): any HTTP answer means the host is reachable through the proxy with TLS."""
    import requests
    t0 = time.time()
    try:
        with requests.get(f"https://{host}/", timeout=(10, 15), stream=True, allow_redirects=False):
            pass
        return host, None, time.time() - t0
    except requests.exceptions.SSLError as e:
        return host, f"TLS failed ({str(e)[:120]})", time.time() - t0
    except requests.RequestException as e:
        return host, f"{type(e).__name__}: {str(e)[:120]}", time.time() - t0


def check_network(r: Report, profile: str) -> None:
    stages = config.PROFILES[profile].stages
    hosts: dict[str, list[str]] = {}
    xp_host = XP_HOSTS[config.resolve(profile).get("stars.xpSource", "archive")]
    for s in stages:
        for h in HOSTS.get(s, ()) + ((xp_host,) if s in XP_STAGES else ()):
            hosts.setdefault(h, []).append(s)
    if config.PROFILES[profile].params.get("shapes.damit") is False:
        hosts.pop("damit.cuni.cz", None)
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    r.info(f"{len(hosts)} data hosts for profile {profile}" + (f" (via proxy {proxy})" if proxy else ""))
    with cf.ThreadPoolExecutor(16) as ex:
        results = list(ex.map(_probe, sorted(hosts)))
    tls = False
    for host, err, secs in results:
        used = ", ".join(hosts[host])
        if err is None:
            r.ok(f"{host} ({used}) {secs:.1f} s")
        else:
            tls |= err.startswith("TLS")
            r.fail(f"{host} ({used}): {err}", "retry later if the host is down (a build resumes where it stopped), "
                                              "or leave out the stages that need it (--skip)")
    if tls:
        r.info("TLS failures behind a company proxy: point REQUESTS_CA_BUNDLE (and SSL_CERT_FILE) at its CA "
               "certificate bundle. Never disable certificate verification.")


def main(profile: str = "standard", offline: bool = False) -> int:
    if profile not in config.PROFILES:
        print(f"unknown profile {profile!r}; known: {', '.join(config.PROFILES)}", file=sys.stderr)
        return 2
    r = Report()
    print(f"Space Thing doctor (profile {profile}; {platform.system()} {platform.release()}, "
          f"{platform.machine()})\n\nPython")
    check_python(r)
    check_packages(r)
    print("\nApp")
    check_node(r)
    r.info("the app needs WebGPU: a current Chrome or Edge with hardware acceleration on")
    print("\nDisk and paths")
    check_disk(r, profile)
    check_paths(r)
    if not offline:
        print("\nNetwork")
        check_network(r, profile)
    print()
    if r.fails:
        print(f"{r.fails} problem(s) to fix first" + (f", {r.warns} warning(s)" if r.warns else "") + ".")
        return 1
    print("Ready" + (f" ({r.warns} warning(s))" if r.warns else "") + f": `python -m pipeline build --profile {profile}`.")
    return 0
