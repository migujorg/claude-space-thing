"""NAIF satellite ephemerides: remote excerpts of the moon and planet-centre segments for the build window.

The satellite SPKs total ~13.7 GB, but a type 2/3 segment's records are fixed-length and time-indexed, so the
records for a window are one contiguous byte range. naif.jpl.nasa.gov serves HTTP Range requests, and jplephem's
`write_excerpt` (the code behind `python -m jplephem excerpt`) copies exactly those records into a small SPK. The
bytes are the kernel's own; the excerpt is recorded in the download ledger with its sha256, the original URL,
the original's size and Last-Modified, the window and the targets (docs/research/m2-worlds.md §1a).

Rules enforced here:
- only moon and planet-centre targets are taken. Every satellite kernel also carries DE copies (Sun, EMB, Earth,
  the system barycentre) that must never override the planetary ephemeris product;
- each body comes from exactly one kernel: the first in KERNELS that has it (planet centres and Methone appear in
  several kernels; the order follows JPL Horizons' choice of source for them);
- a chosen segment must cover the whole window (the excerpter would otherwise silently claim coverage);
- a kernel whose moon segments are not all type 2/3 (sat480: a type 17 moonlet) is downloaded whole.
"""

from __future__ import annotations

import datetime as _dt
import io
import json
import random
import re
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import requests
from jplephem import __version__ as jplephem_version
from jplephem.daf import DAF
from jplephem.excerpter import write_excerpt

from . import download
from .download import fetch
from .ephem_spk import read_spk
from .paths import CACHE, RAW

SAT_URL = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites"
FK_URL = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites"
DE_IDS = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 199, 299, 301, 399}

# (system key, barycentre id, planet name)
SYSTEMS = {"mar": (4, "Mars"), "jup": (5, "Jupiter"), "sat": (6, "Saturn"), "ura": (7, "Uranus"),
           "nep": (8, "Neptune"), "plu": (9, "Pluto")}


@dataclass(frozen=True)
class Kernel:
    name: str      # file stem on NAIF, e.g. "jup365"
    system: str    # key into SYSTEMS
    whole: bool = False  # download the whole file (small, or has segment types the excerpter cannot copy)

    @property
    def url(self) -> str:
        return f"{SAT_URL}/{self.name}.bsp"

    @property
    def source_id(self) -> str:
        return f"naif-{self.name}"


# Priority order: for a body present in several kernels, the first kernel listed wins. Superseded or extended
# variants (nep097, nep105, mar099 (= mar099s over 1995-2050), *xl*) are not used. sat393_daphnis is not used:
# it is a 2016 type-17 conic for Daphnis, for which JPL Horizons gives no ephemeris after 2018-01-17.
KERNELS = [
    Kernel("mar099s", "mar"),
    Kernel("jup365", "jup"), Kernel("jup347", "jup"), Kernel("jup348", "jup"), Kernel("jup349", "jup"),
    Kernel("sat441", "sat"), Kernel("sat415", "sat"), Kernel("sat455", "sat"), Kernel("sat456", "sat"),
    Kernel("sat457", "sat"), Kernel("sat459", "sat"), Kernel("sat480", "sat", whole=True),
    Kernel("ura184_part-3", "ura"), Kernel("ura184_part-1", "ura"), Kernel("ura184_part-2", "ura"),
    Kernel("nep098_part-1", "nep"), Kernel("nep098_part-2", "nep"), Kernel("nep098_part-3", "nep"),
    Kernel("nep104", "nep"),
    Kernel("plu060", "plu"),
]

# Name/ID frame kernels for the moons whose names SPICE does not know (mostly 5-digit ids).
NAMEID_FKS = ["jup347_nameid.tf", "jup348_nameid.tf", "jup349_nameid.tf", "sat455_nameid.tf", "sat456_nameid.tf",
              "sat457_nameid.tf", "sat458_nameid.tf", "sat459_nameid.tf", "sat480_nameid.tf", "ura117_nameid.tf",
              "nep098_nameid.tf", "nep104_nameid.tf"]


class RemoteFile(io.RawIOBase):
    """Read-only file over HTTP Range requests, with a small block cache for the many tiny DAF reads."""

    BLOCK = 1 << 16

    def __init__(self, url: str, session: requests.Session):
        self.url, self.s, self.pos, self.requests = url, session, 0, 0
        self._blocks: dict[int, bytes] = {}
        head = self._get(0, 0, head=True)
        self.size = int(head.headers["Content-Range"].split("/")[-1])
        self.last_modified = head.headers.get("Last-Modified")

    def _get(self, a: int, b: int, head: bool = False) -> requests.Response:
        delay = 2.0
        for attempt in range(6):
            try:
                r = self.s.get(self.url, headers={"Range": f"bytes={a}-{b}"}, timeout=120)
                self.requests += 1
                download.count(len(r.content))
                if r.status_code != 206:
                    raise requests.HTTPError(f"{self.url}: expected 206 for a range request, got {r.status_code}")
                if not head and len(r.content) != b - a + 1:
                    raise requests.HTTPError(f"{self.url}: short read {len(r.content)} of {b - a + 1}")
                return r
            except requests.RequestException:
                if attempt == 5:
                    raise
                time.sleep(delay)
                delay *= 2
        raise AssertionError

    def seek(self, offset: int, whence: int = 0) -> int:
        assert whence == 0
        self.pos = offset
        return offset

    def read(self, size: int = -1) -> bytes:
        a, b = self.pos, self.pos + size - 1
        self.pos += size
        if size > self.BLOCK // 4:
            return self._get(a, b).content
        out = bytearray()
        for blk in range(a // self.BLOCK, b // self.BLOCK + 1):
            if blk not in self._blocks:
                lo = blk * self.BLOCK
                self._blocks[blk] = self._get(lo, min(lo + self.BLOCK, self.size) - 1).content
            data = self._blocks[blk]
            lo = blk * self.BLOCK
            out += data[max(a, lo) - lo: min(b + 1, lo + len(data)) - lo]
        return bytes(out)

    def readable(self) -> bool:
        return True


class _Spk:  # write_excerpt only needs `.daf`
    def __init__(self, daf: DAF):
        self.daf = daf


def _session() -> requests.Session:
    s = requests.Session()
    s.headers["User-Agent"] = "space-thing data pipeline (remote SPK excerpts; see docs/research/m2-worlds.md)"
    return s


def survey(kernel: Kernel, session: requests.Session) -> dict:
    """Segment table of a remote kernel (cached per kernel size + Last-Modified)."""
    r = session.head(kernel.url, timeout=60)
    r.raise_for_status()
    key = f"{r.headers.get('Content-Length')}_{r.headers.get('Last-Modified')}"
    cache = CACHE / "satellite-survey" / f"{kernel.name}.json"
    if cache.exists():
        c = json.loads(cache.read_text(encoding="utf-8"))
        if c.get("key") == key:
            return c
    f = RemoteFile(kernel.url, session)
    daf = DAF(f)
    segs = []
    for name, v in daf.summaries():
        start, end, target, center, frame, typ, a0, a1 = v
        segs.append({"target": int(target), "center": int(center), "frame": int(frame), "type": int(typ),
                     "start": float(start), "end": float(end), "a0": int(a0), "a1": int(a1)})
    out = {"key": key, "url": kernel.url, "bytes": f.size, "lastModified": f.last_modified, "segments": segs}
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(out), encoding="utf-8", newline="\n")
    return out


def assign_targets(surveys: dict[str, dict], t0: float, t1: float) -> dict[str, set[int]]:
    """kernel name -> targets it provides (moons and planet centres; first kernel in KERNELS wins)."""
    taken: dict[int, str] = {}
    for k in KERNELS:
        for s in surveys[k.name]["segments"]:
            t = s["target"]
            if t in DE_IDS or t in taken:
                continue
            if s["start"] < t1 and s["end"] > t0:
                if not (s["start"] <= t0 and s["end"] >= t1):
                    raise ValueError(f"{k.name}: segment for {t} [{s['start']}, {s['end']}] ends inside the window")
                if s["frame"] != 1:
                    raise ValueError(f"{k.name}: segment for {t} is in frame {s['frame']}, expected J2000")
                taken[t] = k.name
    out: dict[str, set[int]] = {k.name: set() for k in KERNELS}
    for t, name in taken.items():
        out[name].add(t)
    return out


def excerpt(kernel: Kernel, targets: set[int], t0: float, t1: float, session: requests.Session) -> Path:
    """Local SPK holding the kernel's records for `targets` over [t0, t1] (cached in data/raw, ledger-recorded)."""
    if kernel.whole:
        return fetch(kernel.url, "naif/spk-satellites")
    jd0, jd1 = 2451545.0 + t0 / 86400.0, 2451545.0 + t1 / 86400.0
    dest = RAW / "naif" / "spk-excerpts" / f"{kernel.name}_JD{jd0:.3f}-{jd1:.3f}.bsp"
    key = download.ledger_key(dest)
    ledger = download._load_ledger()
    if dest.exists() and key in ledger and ledger[key].get("excerpt", {}).get("targets") == sorted(targets):
        return dest
    f = RemoteFile(kernel.url, session)
    daf = DAF(f)
    summaries = [(n, v) for n, v in daf.summaries() if int(v[2]) in targets and v[0] < t1 and v[1] > t0]
    got = {int(v[2]) for _, v in summaries}
    if got != targets:
        raise ValueError(f"{kernel.name}: targets {sorted(targets - got)} not found")
    for _, v in summaries:
        if int(v[5]) not in (2, 3):
            raise ValueError(f"{kernel.name}: segment {int(v[2])} has type {int(v[5])}; mark the kernel whole=True")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".part")
    with tmp.open("w+b") as out:
        write_excerpt(_Spk(daf), out, jd0, jd1, summaries)
        # jplephem stops at the last double; SPICE reads whole 1024-byte DAF records, so pad the final record.
        out.seek(0, 2)
        out.write(b"\0" * (-out.tell() % 1024))
    tmp.replace(dest)
    checked = verify_against_original(kernel, dest, session)
    download.update_ledger(key, {
        "url": kernel.url,
        "sha256": download.sha256_file(dest),
        "retrieved": _dt.date.today().isoformat(),
        "bytes": dest.stat().st_size,
        "excerpt": {"of": kernel.url, "originalBytes": f.size, "originalLastModified": f.last_modified,
                    "startEt": t0, "endEt": t1, "targets": sorted(targets), "rangeRequests": f.requests,
                    "verifiedRecords": checked, "tool": f"jplephem {jplephem_version} write_excerpt"},
    })
    return dest


def verify_against_original(kernel: Kernel, path: Path, session: requests.Session, per_kernel: int = 4,
                            seed: int = 0) -> int:
    """Re-read random records straight from the original (independent Range requests) and compare bytes.

    Returns the number of records compared; raises on any difference.
    """
    if kernel.whole:
        return 0
    rng = random.Random(seed)
    sv = survey(kernel, session)
    segs = read_spk(path)
    checked = 0
    for seg in rng.sample(segs, min(per_kernel, len(segs))):
        # The original segment this excerpt came from (bodies often have a backward and a forward segment).
        o = next(s for s in sv["segments"] if (s["target"], s["center"]) == (seg.target, seg.center)
                 and s["start"] <= seg.start and s["end"] >= seg.end)
        # Original directory: INIT, INTLEN, RSIZE, N are the last four doubles of the segment.
        d = _range_doubles(kernel.url, o["a1"] - 3, o["a1"], session)
        o_init, o_intlen, o_rsize = d[0], d[1], int(d[2])
        assert (o_intlen, o_rsize) == (seg.intlen, seg.rsize), kernel.name
        i = rng.randrange(seg.n)
        k = int(round((seg.init - o_init) / o_intlen)) + i
        orig_rec = _range_doubles(kernel.url, o["a0"] + k * o_rsize, o["a0"] + (k + 1) * o_rsize - 1, session)
        if orig_rec.tobytes() != np.ascontiguousarray(seg.records[i], dtype="<f8").tobytes():
            raise ValueError(f"{kernel.name}: record {i} of {seg.target} differs from the original")
        checked += 1
    return checked


def _range_doubles(url: str, first: int, last: int, session: requests.Session) -> np.ndarray:
    a, b = 8 * (first - 1), 8 * last - 1
    r = session.get(url, headers={"Range": f"bytes={a}-{b}"}, timeout=120)
    r.raise_for_status()
    download.count(len(r.content))
    if r.status_code != 206 or len(r.content) != b - a + 1:
        raise ValueError(f"{url}: bad range response")
    return np.frombuffer(r.content, dtype="<f8")


def comment_text(path: Path) -> str:
    """Comment area of an SPK (for an excerpt: jplephem's preface followed by the original's comments)."""
    with path.open("rb") as f:
        return DAF(f).comments()


def nameid_fks() -> list[Path]:
    return [fetch(f"{FK_URL}/{n}", "naif/fk-satellites") for n in NAMEID_FKS]


def kernel_path(kernel: Kernel, t0: float, t1: float) -> Path:
    """Where excerpt()/fetch() put this kernel's data for the window [t0, t1]."""
    if kernel.whole:
        return RAW / "naif" / "spk-satellites" / f"{kernel.name}.bsp"
    jd0, jd1 = 2451545.0 + t0 / 86400.0, 2451545.0 + t1 / 86400.0
    return RAW / "naif" / "spk-excerpts" / f"{kernel.name}_JD{jd0:.3f}-{jd1:.3f}.bsp"


def kernel_tables(path: Path) -> tuple[dict[int, str], dict[int, float]]:
    """Body names and GMs published in a satellite kernel's comments ("Satellite Ephemeris File Summary").

    Names come from the "Bodies on the File" tables; GMs from those tables and from the "<id>GM" entries of
    "Additional Constants on the File". Only GM > 0 is returned: 0 there means the body was integrated as massless,
    which is not a measurement of its mass.
    """
    names: dict[int, str] = {}
    gms: dict[int, float] = {}
    num = r"[-+]?\d+\.\d+[EeDd][-+]?\d+"
    in_table = in_constants = False
    for ln in comment_text(path).splitlines():
        s = ln.strip()
        if s.startswith("Bodies on the File"):
            in_table, in_constants = True, False
            continue
        if s.startswith("Additional Constants on the File"):
            in_table, in_constants = False, True
            continue
        if not s or s.startswith("*") or s.startswith("Satellite Ephemeris"):
            in_table = in_constants = False
            continue
        if in_table and (m := re.match(rf"(\S+)\s+(\d+)\s+({num})\s", s + " ")):
            i, g = int(m.group(2)), float(m.group(3).replace("D", "E").replace("d", "e"))
            names.setdefault(i, m.group(1))
            if g > 0:
                gms.setdefault(i, g)
        elif in_constants:
            for m in re.finditer(rf"\b(\d{{3,}})GM\s+({num})", s):
                g = float(m.group(2).replace("D", "E").replace("d", "e"))
                if g > 0:
                    gms.setdefault(int(m.group(1)), g)
    return names, gms


@dataclass
class KernelInfo:
    header: str                   # the kernel's own description paragraph (may be empty)
    ephemerides: list[str]        # "Satellite Ephemeris:" names in the comments
    planetary: list[str]          # "Planetary Ephemeris Number:" values
    interp_error: dict[str, str]  # satellite ephemeris name -> stated Chebyshev interpolation error
    uncertainty: str


# Papers the research notes verified for specific kernels (docs/research/m2-worlds.md §1a).
PAPERS = {"ura184": "Jacobson, R. A., Park, R. S. (2025). The Astronomical Journal 169, 65. "
                    "DOI:10.3847/1538-3881/ad99d1"}


def kernel_info(kernel: Kernel, path: Path) -> KernelInfo:
    text = comment_text(path)
    orig = text.split("; " + "-" * 70, 1)[-1]  # drop jplephem's preface
    # The kernel's own description paragraph, if the comments start with one (some start with the SPKMERGE log).
    head: list[str] = []
    for ln in orig.splitlines():
        s = ln.strip()
        if not s:
            if head:
                break
            continue
        if s.startswith("---") or s.startswith(";") or s.startswith("*"):
            break
        head.append(s)
    names: list[str] = []
    planetary: list[str] = []
    errors: dict[str, str] = {}
    current = None
    for ln in orig.splitlines():
        if m := re.match(r"\s*Satellite Ephemeris:\s*(\S+)", ln):
            current = m.group(1)
            if current not in names:
                names.append(current)
        elif m := re.match(r"\s*Planetary Ephemeris Number:\s*(\S+)", ln):
            if m.group(1) not in planetary:
                planetary.append(m.group(1))
        elif (m := re.match(r"\s*Chebyshev interpolation error:\s*([\d.]+\s*\w+)", ln)) and current:
            errors[current] = " ".join(m.group(1).split())
    stated = "; ".join(f"{n}: {e}" for n, e in errors.items())
    unc = ((f"Chebyshev interpolation error stated in the kernel comments: {stated}. " if stated else
            "No interpolation error is stated in the kernel comments. ") +
           "The orbit-determination uncertainty is not published in the kernel (see the satellite ephemeris "
           "documentation); for recently discovered irregular moons expect it to be far above 1 km.")
    return KernelInfo(" ".join(head), names, planetary, errors, unc)


def register_source(ctx, kernel: Kernel, path: Path, sv: dict) -> str:
    from .schema import SourceRecord
    info = kernel_info(kernel, path)
    rec = download.record(path)
    ex = rec.get("excerpt", {})
    paper = next((p for k, p in PAPERS.items() if kernel.name.startswith(k)), None)
    citation = (f"JPL Solar System Dynamics Group satellite ephemeris "
                f"{', '.join(info.ephemerides) or kernel.name.upper()} (planetary ephemeris "
                f"{', '.join(info.planetary) or 'not stated'}), NAIF SPK {kernel.name}.bsp"
                + (f": \"{info.header}\"" if info.header else "") + ". "
                + (paper + ". " if paper else "")
                + "Satellite ephemerides: https://ssd.jpl.nasa.gov/sats/ephem/. Acton, C. H. (1996), Planetary and "
                  "Space Science 44(1), 65-70, DOI:10.1016/0032-0633(95)00107-7.")
    if kernel.whole:
        notes = (f"Whole file ({rec['bytes']} bytes, {sv['lastModified']}); only its moon segments are used, the "
                 "DE copies embedded in it are not.")
    else:
        notes = (f"Range-request excerpt of {kernel.url} ({ex.get('originalBytes')} bytes, Last-Modified "
                 f"{ex.get('originalLastModified')}): records for {len(ex.get('targets', []))} bodies over ET "
                 f"{ex.get('startEt')}..{ex.get('endEt')} by {ex.get('tool')}; sha256 is of the excerpt. "
                 f"{ex.get('verifiedRecords')} records re-read from the original and compared byte-for-byte. "
                 "The DE copies embedded in the kernel (Sun, EMB, Earth, barycentre) are not used.")
    ctx.add_source(SourceRecord(
        id=kernel.source_id,
        title=f"JPL satellite ephemeris {kernel.name} (NAIF SPK{'' if kernel.whole else ', excerpt'})",
        citation=citation, url=kernel.url, retrieved=rec["retrieved"], sha256=rec["sha256"], version=kernel.name,
        license="NAIF/JPL public data (U.S. Government work); see https://naif.jpl.nasa.gov/naif/rules.html",
        notes=notes))
    return kernel.source_id
