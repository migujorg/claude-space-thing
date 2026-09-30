"""Gaia DR3 access for the stars stage: TAP queries and the bulk XP sampled-spectra files.

Two access paths, both recorded for provenance:

* ADQL queries on the ESA Gaia archive's synchronous TAP endpoint, downloaded with `download.fetch` (so the
  query URL and the result's sha256 land in the ledger); the ADQL text is also stored as `<name>.adql`.
  (During development the asynchronous service sat in "WRITING_RESULT" for > 20 min on 1e5-row results, while
  synchronous CSV returned 2e5 rows in ~2 min.)
* XP sampled mean spectra are not in the TAP service. DataLink serves them at ~2 s per source, far too slow for
  ~0.5 M stars, so we stream ESA's bulk ECSV files (3386 files, ~114 GB gzip) from the Gaia CDN, verify each
  file's MD5 against ESA's `_MD5SUM.txt`, compute its sha256 while streaming, and keep only the rows of the
  sources we need. The kept rows are stored as `<file>.npz` under data/raw/ (the full files would not fit the
  disk budget); `_streamed.json` records url, md5, sha256, size and retrieval date of every streamed file.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import time
import zlib
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import requests

from .download import fetch, sha256_file
from .paths import CACHE, RAW

TAP_URL = "https://gea.esac.esa.int/tap-server/tap"


@dataclass(frozen=True)
class GaiaRelease:
    """Everything release-specific. Select with the environment variable PIPELINE_GAIA_RELEASE (default dr3)."""
    key: str
    label: str            # "Gaia DR3"
    schema: str           # archive TAP schema, "gaiadr3"
    cdn: str              # bulk-file directory on cdn.gea.esac.esa.int, "gdr3"
    citation: str
    doi: str
    xp_first_nm: float    # XP sampled grid
    xp_last_nm: float
    xp_step_nm: float


RELEASES = {
    "dr3": GaiaRelease(
        key="dr3", label="Gaia DR3", schema="gaiadr3", cdn="gdr3",
        citation="Gaia Collaboration, Vallenari A. et al. 2023, Gaia Data Release 3: Summary of the content and "
                 "survey properties, A&A 674, A1",
        doi="10.1051/0004-6361/202243940", xp_first_nm=336.0, xp_last_nm=1020.0, xp_step_nm=2.0),
    # Gaia DR4 (scheduled 2 Dec 2026): add its entry here once the archive schema, bulk layout and XP sampling are
    # published; the queries below only use the schema name and column names that DR3 and the DR4 draft data model
    # share, but every entry must be checked against the released data model, not assumed.
}
_REL_KEY = os.environ.get("PIPELINE_GAIA_RELEASE", "dr3").lower()
if _REL_KEY not in RELEASES:
    raise RuntimeError(f"PIPELINE_GAIA_RELEASE={_REL_KEY!r} is not configured in stars_gaia.RELEASES "
                       f"(known: {sorted(RELEASES)})")
REL = RELEASES[_REL_KEY]

XP_BASE = f"https://cdn.gea.esac.esa.int/Gaia/{REL.cdn}/Spectroscopy/xp_sampled_mean_spectrum/"
XP_SUBDIR = f"stars/gaia_{REL.key}_xp_sampled"
#: Sampling of the Gaia DR3 XP sampled mean spectra: 343 points, 336..1020 nm in 2 nm steps
#: (Gaia DR3 documentation, xp_sampled_mean_spectrum; Montegriffo et al. 2023).
XP_WAVELENGTHS = np.arange(REL.xp_first_nm, REL.xp_last_nm + 1e-9, REL.xp_step_nm)


# --------------------------------------------------------------------------------------------- TAP

def _sync(query: str, timeout: float = 300.0) -> str:
    delay = 5.0
    for attempt in range(5):
        try:
            r = requests.get(TAP_URL + "/sync", params={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv",
                                                        "QUERY": query}, timeout=timeout)
            r.raise_for_status()
            return r.text
        except requests.RequestException:
            if attempt == 4:
                raise
            time.sleep(delay)
            delay *= 2
    raise RuntimeError("unreachable")


def tap_query(select: str, table: str, where: str, subdir: str, base: str, expect: str,
              retries: int = 3, count_query: str | None = None) -> Path:
    """Run `SELECT <select> FROM <table> [WHERE <where>]` on the Gaia archive's synchronous TAP endpoint (CSV).

    Downloaded with `download.fetch` as a GET, so the ledger records the full query URL; the ADQL text is also
    saved next to the result as `<name>.adql`. The file name carries a hash of the query, so editing a query fetches
    a new file. Two failure modes of the service are guarded against:

    * errors come back as a VOTable document, sometimes with HTTP 200 (`expect` = first CSV column name);
    * long responses are sometimes cut off cleanly at a line boundary with no error. The row count is therefore
      checked against a COUNT(*) of the same query (stored as `<name>.rows` once verified) and the download
      repeated on mismatch. (For GROUP BY queries pass `count_query`, which must return the expected row count.)
    """
    cond = f" WHERE {where}" if where else ""
    query = f"SELECT {select} FROM {table}{cond}"
    qhash = hashlib.sha256(query.encode()).hexdigest()[:10]
    name = f"{base}_{qhash}.csv"
    dest = RAW / subdir / name
    rows_file = dest.with_name(name + ".rows")
    for attempt in range(retries + 1):
        path = fetch(TAP_URL + "/sync", subdir, name, timeout=900.0,
                     params={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query})
        with path.open("rb") as f:
            head = f.read(200)
        if not head.startswith(expect.encode()):
            path.unlink()
            raise RuntimeError(f"Gaia TAP query failed ({name}): {head[:200]!r}")
        with path.open("rb") as f:
            n = sum(1 for _ in f) - 1
        if not rows_file.exists():
            expected = int(_sync(count_query or f"SELECT COUNT(*) AS n FROM {table}{cond}").splitlines()[1])
            if n == expected:
                rows_file.write_text(str(expected))
        else:
            expected = int(rows_file.read_text())
        if n == expected:
            break
        print(f"  {name}: {n} rows, expected {expected}; refetching", flush=True)
        path.unlink()
    else:
        raise RuntimeError(f"Gaia TAP query {name} kept returning truncated results")
    sidecar = path.with_name(path.name + ".adql")
    if not sidecar.exists():
        sidecar.write_text(query)
    return path


def _fits_table_ok(path: Path) -> bool:
    """True when `path` is a complete FITS file whose first extension is a binary table (a truncated response or
    an error document fails). Reads only the headers."""
    size = path.stat().st_size
    with path.open("rb") as f:
        head = f.read(2880)
        if not head.startswith(b"SIMPLE  ="):
            return False
        off = 0
        cards: dict[str, str] = {}
        for hdu in range(2):
            cards = {}
            while True:
                f.seek(off)
                block = f.read(2880)
                off += 2880
                if len(block) < 2880:
                    return False
                end = False
                for i in range(0, 2880, 80):
                    card = block[i:i + 80].decode("ascii", "replace")
                    key = card[:8].strip()
                    if key == "END":
                        end = True
                        break
                    if card[8:10] == "= ":
                        cards[key] = card[10:].split("/")[0].strip()
                if end:
                    break
            if hdu == 0:
                naxis = int(cards.get("NAXIS", "0"))
                n = 1
                for k in range(1, naxis + 1):
                    n *= int(cards[f"NAXIS{k}"])
                off += -(-n * abs(int(cards["BITPIX"])) // 8 // 2880) * 2880 if naxis else 0
        if cards.get("XTENSION", "").strip("' ") != "BINTABLE":
            return False
        need = int(cards["NAXIS1"]) * int(cards["NAXIS2"]) + int(cards.get("PCOUNT", "0"))
        return size >= off + need


def tap_query_fits(select: str, table: str, where: str, subdir: str, base: str) -> Path:
    """Like `tap_query` but FITS binary table output (~2.5x smaller than CSV for numeric columns).

    A FITS response declares its row count before the data, so a truncated transfer is detected from the file
    size alone (`_fits_table_ok`, run by `fetch` as validation); no COUNT(*) round trip is needed."""
    query = f"SELECT {select} FROM {table} WHERE {where}"
    qhash = hashlib.sha256(query.encode()).hexdigest()[:10]
    name = f"{base}_{qhash}.fits"
    path = fetch(TAP_URL + "/sync", subdir, name, timeout=1800.0, validate=_fits_table_ok,
                 params={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "fits", "QUERY": query})
    sidecar = path.with_name(path.name + ".adql")
    if not sidecar.exists():
        sidecar.write_text(query)
    return path


def healpix_source_id_range(level: int, pix: int) -> tuple[int, int]:
    """[lo, hi) source_id range of HEALPix (nested, ICRS) pixel `pix` at `level`: Gaia source_id >> 35 is the
    level-12 index (Gaia DR3 documentation, source_id)."""
    span = 4 ** (12 - level) * 2 ** 35
    return pix * span, (pix + 1) * span


# ------------------------------------------------------------------------------------- XP bulk files

def xp_index() -> list[tuple[str, str]]:
    """(file name, md5) for every bulk XP sampled file, from ESA's _MD5SUM.txt (downloaded + hashed)."""
    p = fetch(XP_BASE + "_MD5SUM.txt", XP_SUBDIR, "_MD5SUM.txt")
    out = []
    for line in p.read_text().splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].endswith(".csv.gz"):
            out.append((parts[1], parts[0]))
    return out


_WANTED: set[int] = set()


def _init_worker(wanted: np.ndarray) -> None:
    global _WANTED
    _WANTED = set(int(x) for x in wanted)


def _parse_array(field: bytes) -> np.ndarray:
    s = field.strip().strip(b'"').strip(b"[]()")
    return np.array([float(v) if v and v != b"null" else np.nan for v in s.split(b",")], dtype=np.float32)


def _stream_one(name: str, md5_expected: str, out_path: str, retries: int = 5) -> dict:
    url = XP_BASE + name
    delay = 5.0
    for attempt in range(retries + 1):
        try:
            md5, sha = hashlib.md5(), hashlib.sha256()
            dec = zlib.decompressobj(wbits=47)  # auto-detect gzip header
            buf = b""
            nbytes = 0
            nrows = 0
            ids, fluxes, errs = [], [], []
            header_seen = False

            def handle(lines):
                nonlocal header_seen, nrows
                for ln in lines:
                    if not ln or ln[:1] == b"#":
                        continue
                    if not header_seen:
                        if ln.split(b",")[:6] != [b"source_id", b"solution_id", b"ra", b"dec", b"flux", b"flux_error"]:
                            raise ValueError(f"unexpected header in {name}: {ln[:120]!r}")
                        header_seen = True
                        continue
                    nrows += 1
                    sid = int(ln[:ln.index(b",")])
                    if sid in _WANTED:
                        # source_id,solution_id,ra,dec,"[flux...]","[flux_error...]"
                        q1 = ln.index(b'"')
                        q2 = ln.index(b'"', q1 + 1)
                        q3 = ln.index(b'"', q2 + 1)
                        q4 = ln.index(b'"', q3 + 1)
                        ids.append(sid)
                        fluxes.append(_parse_array(ln[q1 + 1:q2]))
                        errs.append(_parse_array(ln[q3 + 1:q4]))

            with requests.get(url, stream=True, timeout=180) as r:
                r.raise_for_status()
                for chunk in r.iter_content(1 << 20):
                    nbytes += len(chunk)
                    md5.update(chunk)
                    sha.update(chunk)
                    buf += dec.decompress(chunk)
                    lines = buf.split(b"\n")
                    buf = lines.pop()
                    handle(lines)
            buf += dec.flush()
            handle(buf.split(b"\n"))
            if md5.hexdigest() != md5_expected:
                raise IOError(f"md5 mismatch for {name}: {md5.hexdigest()} != {md5_expected}")
            n = len(ids)
            flux = np.stack(fluxes) if n else np.zeros((0, XP_WAVELENGTHS.size), np.float32)
            err = np.stack(errs) if n else np.zeros((0, XP_WAVELENGTHS.size), np.float32)
            if n and flux.shape[1] != XP_WAVELENGTHS.size:
                raise ValueError(f"{name}: {flux.shape[1]} samples, expected {XP_WAVELENGTHS.size}")
            tmp = out_path + ".tmp.npz"
            np.savez(tmp, source_id=np.array(ids, dtype=np.int64), flux=flux, flux_error=err)
            Path(tmp).replace(out_path)
            return {"name": name, "url": url, "md5": md5_expected, "sha256": sha.hexdigest(), "bytes": nbytes,
                    "rows": nrows, "kept": n, "retrieved": _dt.date.today().isoformat(),
                    "subset_sha256": sha256_file(Path(out_path))}
        except (requests.RequestException, IOError, zlib.error) as e:
            if attempt == retries:
                raise RuntimeError(f"streaming {name} failed: {e}") from e
            time.sleep(delay)
            delay *= 2
    raise RuntimeError("unreachable")


def stream_xp(wanted: np.ndarray, *, workers: int = 4, log=print, stream: bool = True) -> tuple[list[Path], dict]:
    """Stream every bulk XP file, keep rows whose source_id is in `wanted`. Returns (npz paths, stream ledger).

    Resumable: files already in the stream ledger with their subset present are skipped. If the wanted set
    changes, the selection is redone (the ledger stores a hash of the wanted ids). stream=False (development
    only) returns whatever has been streamed so far without downloading anything.
    """
    index = xp_index()
    d = RAW / XP_SUBDIR
    d.mkdir(parents=True, exist_ok=True)
    ledger_path = d / "_streamed.json"
    if not stream:
        ledger = json.loads(ledger_path.read_text())
        done = [n for n, _ in index if n in ledger["files"] and (d / (n + ".npz")).exists()]
        log(f"  XP: using {len(done)}/{len(index)} already-streamed files (streaming disabled)")
        return [d / (n + ".npz") for n in done], ledger
    wanted = np.unique(np.asarray(wanted, dtype=np.int64))
    wanted_hash = hashlib.sha256(wanted.tobytes()).hexdigest()
    ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else {}
    if ledger.get("wanted_sha256") != wanted_hash:
        # A superset selection is still valid: the loader filters. Only redo when ids are missing.
        prev = d / "_wanted.npy"
        if prev.exists() and ledger.get("files"):
            prev_ids = np.load(prev)
            if np.isin(wanted, prev_ids).all():
                wanted_hash = ledger["wanted_sha256"]
            else:
                ledger = {}
        else:
            ledger = {}
    if not ledger:
        ledger = {"wanted_sha256": wanted_hash, "wanted_count": int(wanted.size), "files": {}}
        np.save(d / "_wanted.npy", wanted)
    todo = [(n, m) for n, m in index
            if not (n in ledger["files"] and (d / (n + ".npz")).exists())]
    log(f"  XP bulk files: {len(index)} total, {len(todo)} to stream ({len(wanted)} wanted sources)")
    t0 = time.time()
    done = 0
    if todo:
        with ProcessPoolExecutor(max_workers=workers, initializer=_init_worker, initargs=(wanted,)) as ex:
            futs = {ex.submit(_stream_one, n, m, str(d / (n + ".npz"))): n for n, m in todo}
            for f in as_completed(futs):
                rec = f.result()
                ledger["files"][rec["name"]] = rec
                done += 1
                if done % 25 == 0 or done == len(todo):
                    ledger_path.write_text(json.dumps(ledger, indent=1, sort_keys=True))
                    el = time.time() - t0
                    log(f"  XP streamed {done}/{len(todo)} files, {el / 60:.1f} min, "
                        f"eta {(len(todo) - done) * el / done / 60:.1f} min")
    ledger_path.write_text(json.dumps(ledger, indent=1, sort_keys=True))
    paths = [d / (n + ".npz") for n, _ in index]
    return paths, ledger


def load_xp(paths: list[Path], wanted: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    ids, flux, err = [], [], []
    for p in paths:
        z = np.load(p)
        if z["source_id"].size:
            ids.append(z["source_id"])
            flux.append(z["flux"])
            err.append(z["flux_error"])
    sid = np.concatenate(ids)
    f = np.concatenate(flux)
    e = np.concatenate(err)
    if wanted is not None:
        m = np.isin(sid, wanted)
        sid, f, e = sid[m], f[m], e[m]
    o = np.argsort(sid)
    return sid[o], f[o], e[o]


def stream_ledger_digest(ledger: dict) -> str:
    """One sha256 over the per-file sha256s (sorted by file name): pins the exact set of bulk files streamed."""
    h = hashlib.sha256()
    for name in sorted(ledger["files"]):
        h.update(f"{name} {ledger['files'][name]['sha256']}\n".encode())
    return h.hexdigest()


# ------------------------------------------------------------------- XP bulk files, reduced per star

XP_REDUCED_SUBDIR = "stars/xp_reduced"  # under CACHE: derived from the streamed bulk files
_W: np.ndarray | None = None
_COVER: np.ndarray | None = None


def _init_reduce(W: np.ndarray, cover: np.ndarray) -> None:
    global _W, _COVER
    _W, _COVER = W, cover


def _parse_flux(field: bytes) -> np.ndarray:
    """'[f1,f2,...]' -> float64 array; 'null' samples -> NaN."""
    s = field.strip().strip(b'"').strip(b"[]()")
    parts = s.split(b",")
    try:
        return np.array(parts, dtype=np.float64)
    except ValueError:
        return np.array([float(v) if v and v != b"null" else np.nan for v in parts])


def _reduce_one(name: str, md5_expected: str, out_path: str, retries: int = 5) -> dict:
    """Stream one bulk XP file; reduce every spectrum to `flux @ W` (NaN where samples in `cover` are missing)."""
    url = XP_BASE + name
    delay = 5.0
    for attempt in range(retries + 1):
        try:
            md5, sha = hashlib.md5(), hashlib.sha256()
            dec = zlib.decompressobj(wbits=47)
            buf = b""
            nbytes = 0
            ids, fl = [], []
            header_seen = False

            def handle(lines):
                nonlocal header_seen
                for ln in lines:
                    if not ln or ln[:1] == b"#":
                        continue
                    if not header_seen:
                        if ln.split(b",")[:5] != [b"source_id", b"solution_id", b"ra", b"dec", b"flux"]:
                            raise ValueError(f"unexpected header in {name}: {ln[:120]!r}")
                        header_seen = True
                        continue
                    q1 = ln.index(b'"')
                    q2 = ln.index(b'"', q1 + 1)
                    ids.append(int(ln[:ln.index(b",")]))
                    fl.append(_parse_flux(ln[q1 + 1:q2]))

            with requests.get(url, stream=True, timeout=180) as r:
                r.raise_for_status()
                for chunk in r.iter_content(1 << 20):
                    nbytes += len(chunk)
                    md5.update(chunk)
                    sha.update(chunk)
                    buf += dec.decompress(chunk)
                    lines = buf.split(b"\n")
                    buf = lines.pop()
                    handle(lines)
            buf += dec.flush()
            handle(buf.split(b"\n"))
            if md5.hexdigest() != md5_expected:
                raise IOError(f"md5 mismatch for {name}: {md5.hexdigest()} != {md5_expected}")
            n = len(ids)
            red = np.full((n, _W.shape[1]), np.nan, dtype=np.float64)
            if n:
                F = np.stack(fl)
                if F.shape[1] != _W.shape[0]:
                    raise ValueError(f"{name}: {F.shape[1]} samples, expected {_W.shape[0]}")
                ok = np.isfinite(F[:, _COVER]).all(axis=1)
                red[ok] = np.nan_to_num(F[ok]) @ _W
            tmp = out_path + ".tmp.npz"
            np.savez(tmp, source_id=np.array(ids, dtype=np.int64), red=red.astype(np.float32))
            Path(tmp).replace(out_path)
            return {"name": name, "url": url, "md5": md5_expected, "sha256": sha.hexdigest(), "bytes": nbytes,
                    "rows": n, "retrieved": _dt.date.today().isoformat(),
                    "subset_sha256": sha256_file(Path(out_path))}
        except (requests.RequestException, IOError, zlib.error) as e:
            if attempt == retries:
                raise RuntimeError(f"streaming {name} failed: {e}") from e
            time.sleep(delay)
            delay *= 2
    raise RuntimeError("unreachable")


def stream_xp_reduced(W: np.ndarray, cover: np.ndarray, tag: str, *, workers: int = 4, log=print
                      ) -> tuple[list[Path], dict]:
    """Stream every bulk XP file and keep, for every source, the linear reductions `flux @ W` (float32).

    `W` (343 x K) is e.g. the CIE X, Y, Z, S operator plus band averages; `tag` must change whenever W does (it names
    the cache directory and is stored with a hash of W). Resumable per file, like `stream_xp`.
    """
    index = xp_index()
    d = CACHE / XP_REDUCED_SUBDIR / tag
    d.mkdir(parents=True, exist_ok=True)
    ledger_path = d / "_streamed.json"
    w_hash = hashlib.sha256(np.ascontiguousarray(W, dtype=np.float64).tobytes() + cover.tobytes()).hexdigest()
    ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else {}
    if ledger.get("W_sha256") != w_hash:
        ledger = {"W_sha256": w_hash, "files": {}}
    todo = [(n, m) for n, m in index if not (n in ledger["files"] and (d / (n + ".npz")).exists())]
    log(f"  XP bulk files (reduced '{tag}'): {len(index)} total, {len(todo)} to stream")
    t0 = time.time()
    done = 0
    if todo:
        with ProcessPoolExecutor(max_workers=workers, initializer=_init_reduce, initargs=(W, cover)) as ex:
            futs = {ex.submit(_reduce_one, n, m, str(d / (n + ".npz"))): n for n, m in todo}
            for f in as_completed(futs):
                rec = f.result()
                ledger["files"][rec["name"]] = rec
                done += 1
                if done % 25 == 0 or done == len(todo):
                    ledger_path.write_text(json.dumps(ledger, indent=1, sort_keys=True))
                    el = time.time() - t0
                    log(f"  XP reduced {done}/{len(todo)} files, {el / 60:.1f} min, "
                        f"eta {(len(todo) - done) * el / done / 60:.1f} min")
    ledger_path.write_text(json.dumps(ledger, indent=1, sort_keys=True))
    return [d / (n + ".npz") for n, _ in index], ledger


def load_xp_reduced(paths: list[Path]) -> tuple[np.ndarray, np.ndarray]:
    ids, red = [], []
    for p in paths:
        z = np.load(p)
        if z["source_id"].size:
            ids.append(z["source_id"])
            red.append(z["red"])
    sid = np.concatenate(ids)
    r = np.concatenate(red)
    o = np.argsort(sid)
    return sid[o], r[o]


# ------------------------------------------------------------------------------------ stage queries

GAIA_COLUMNS = (
    "source_id", "ref_epoch", "ra", "dec", "ra_error", "dec_error", "parallax", "parallax_error",
    "pmra", "pmdec", "pmra_error", "pmdec_error", "radial_velocity", "radial_velocity_error",
    "ruwe", "astrometric_params_solved", "phot_g_mean_mag", "phot_bp_mean_mag", "phot_rp_mean_mag",
    "phot_bp_rp_excess_factor", "has_xp_sampled", "phot_variable_flag", "duplicated_source",
    "ipd_frac_multi_peak", "non_single_star",
)
#: G slices keep each synchronous response at <= ~1.2e5 rows (the whole set is ~0.8 M rows).
G_SLICES = ((None, 8.0), (8.0, 9.0), (9.0, 9.5), (9.5, 9.75), (9.75, 10.0), (10.0, 10.2), (10.2, 10.35),
            (10.35, 10.5))
SUBDIR = f"stars/gaia_{REL.key}"


def fetch_gaia_sources(g_max: float) -> list[Path]:
    """gaiadr3.gaia_source rows with phot_g_mean_mag < g_max (astrometry, photometry, XP availability)."""
    out = []
    for lo, hi in G_SLICES:
        if lo is not None and lo >= g_max:
            break
        hi = min(hi, g_max)
        cond = f"phot_g_mean_mag < {hi}" if lo is None else f"phot_g_mean_mag >= {lo} AND phot_g_mean_mag < {hi}"
        out.append(tap_query(", ".join(GAIA_COLUMNS), f"{REL.schema}.gaia_source", cond, SUBDIR,
                             f"gaia_source_G{lo if lo is not None else 'min'}-{hi}", "source_id"))
    return out


def fetch_hip_xmatch() -> Path:
    """Gaia DR3's own Hipparcos-2 cross-match (gaiadr3.hipparcos2_best_neighbour), complete table."""
    return tap_query("source_id, original_ext_source_id, angular_distance, number_of_neighbours, xm_flag",
                     f"{REL.schema}.hipparcos2_best_neighbour", "", SUBDIR, "hipparcos2_best_neighbour", "source_id")


def fetch_tycho_pm_for_2p(g_max: float) -> Path:
    """Tycho-2 proper motions of the Gaia DR3 sources that have only a 2-parameter solution (no proper motion)."""
    return tap_query(
        "g.source_id, t.id, t.pm_ra, t.pm_de, t.e_pm_ra, t.e_pm_de, b.angular_distance",
        f"{REL.schema}.gaia_source AS g JOIN {REL.schema}.tycho2tdsc_merge_best_neighbour AS b ON b.source_id = g.source_id "
        f"JOIN {REL.schema}.tycho2tdsc_merge AS t ON t.id = b.original_ext_source_id",
        f"g.astrometric_params_solved = 3 AND g.phot_g_mean_mag < {g_max}",
        SUBDIR, f"tycho2_pm_for_gaia2p_G{g_max}", "source_id")


def fetch_tycho_unmatched(vt_max: float) -> Path:
    """Tycho-2 (+TDSC) stars brighter than vt_max with no Gaia DR3 best neighbour (candidates Gaia misses)."""
    return tap_query(
        "t.id, t.hip, t.tyc1, t.tyc2, t.tyc3, t.ra_mdeg, t.de_mdeg, t.pm_ra, t.pm_de, t.e_ra_mdeg, "
        "t.e_de_mdeg, t.e_pm_ra, t.e_pm_de, t.ra_deg, t.de_deg, t.ep_ra1990, t.ep_de1990, "
        "t.bt_mag, t.vt_mag, t.e_bt_mag, t.e_vt_mag, t.pflag, t.posflg, "
        "t.prox, t.ccdm, t.cmp, t.hd, t.n_main, t.n_sup",
        f"{REL.schema}.tycho2tdsc_merge AS t LEFT OUTER JOIN {REL.schema}.tycho2tdsc_merge_best_neighbour AS b "
        "ON b.original_ext_source_id = t.id", f"b.source_id IS NULL AND t.vt_mag < {vt_max}",
        SUBDIR, f"tycho2tdsc_unmatched_VT{vt_max}", "id")


# ------------------------------------------------------------------------------------ deep tiers and sky sums

DEEP_COLUMNS = ("source_id", "ra", "dec", "pmra", "pmdec", "parallax", "phot_g_mean_mag", "phot_bp_mean_mag",
                "phot_rp_mean_mag", "astrometric_params_solved", "has_xp_sampled")
DEEP_LEVEL = 2  # one query per HEALPix level-2 pixel (192 queries, ~1e5 rows each for 10 <= G < 14)


def fetch_gaia_deep(g_lo: float, g_hi: float, *, log=print) -> list[Path]:
    """gaia_source rows with g_lo <= G < g_hi, one FITS file per HEALPix level-2 pixel (sequential: the ledger
    is a single JSON file)."""
    out = []
    t0 = time.time()
    for pix in range(12 * 4 ** DEEP_LEVEL):
        lo, hi = healpix_source_id_range(DEEP_LEVEL, pix)
        where = (f"source_id >= {lo} AND source_id < {hi} AND phot_g_mean_mag >= {g_lo} "
                 f"AND phot_g_mean_mag < {g_hi}")
        out.append(tap_query_fits(", ".join(DEEP_COLUMNS), f"{REL.schema}.gaia_source", where,
                                  SUBDIR + "_deep", f"gaia_source_G{g_lo}-{g_hi}_hpx{DEEP_LEVEL}_{pix:03d}"))
        if pix % 12 == 11:
            log(f"  deep G {g_lo}-{g_hi}: {pix + 1}/{12 * 4 ** DEEP_LEVEL} pixels, {(time.time() - t0) / 60:.1f} min")
    return out


SUM_LEVEL = 1  # aggregation queries run per HEALPix level-1 pixel (48 queries)


def fetch_faint_sums(g_min: float, level: int) -> list[Path]:
    """Per HEALPix pixel (nested, `level`) sums over all gaia_source rows with G >= g_min: counts and sums of
    10^(-0.4 m) in G, BP, RP, split by whether BP and RP both exist."""
    select = (f"GAIA_HEALPIX_INDEX({level}, source_id) AS hpx, COUNT(*) AS n, "
              "SUM(POWER(10, -0.4 * phot_g_mean_mag)) AS fg, "
              "COUNT(phot_bp_mean_mag + phot_rp_mean_mag) AS n_c, "
              "SUM(POWER(10, -0.4 * phot_g_mean_mag) + 0 * phot_bp_mean_mag + 0 * phot_rp_mean_mag) AS fg_c, "
              "SUM(POWER(10, -0.4 * phot_bp_mean_mag) + 0 * phot_rp_mean_mag) AS fbp_c, "
              "SUM(POWER(10, -0.4 * phot_rp_mean_mag) + 0 * phot_bp_mean_mag) AS frp_c")
    out = []
    for pix in range(12 * 4 ** SUM_LEVEL):
        lo, hi = healpix_source_id_range(SUM_LEVEL, pix)
        cut = f"source_id >= {lo} AND source_id < {hi} AND phot_g_mean_mag >= {g_min}"
        count = (f"SELECT COUNT(*) AS n FROM (SELECT GAIA_HEALPIX_INDEX({level}, source_id) AS hpx FROM "
                 f"{REL.schema}.gaia_source WHERE {cut} GROUP BY hpx) AS t")
        out.append(tap_query(select, f"{REL.schema}.gaia_source", cut + " GROUP BY hpx", SUBDIR + "_sums",
                             f"faint_sums_G{g_min}_L{level}_p{pix:02d}", "hpx", count_query=count))
    return out


def fetch_faint_colour_sums(g_min: float, level: int) -> list[Path]:
    """Per HEALPix pixel (`level`) and BP-RP bin of 0.1 mag (cbin = FLOOR(10 (BP - RP)); NULL = no colour), for all
    sources with G >= g_min: count and sum of 10^(-0.4 G). Gives the colour mix of the faint stars."""
    select = (f"GAIA_HEALPIX_INDEX({level}, source_id) AS hpx, "
              "FLOOR(10 * (phot_bp_mean_mag - phot_rp_mean_mag)) AS cbin, COUNT(*) AS n, "
              "SUM(POWER(10, -0.4 * phot_g_mean_mag)) AS fg")
    out = []
    for pix in range(12 * 4 ** SUM_LEVEL):
        lo, hi = healpix_source_id_range(SUM_LEVEL, pix)
        cut = f"source_id >= {lo} AND source_id < {hi} AND phot_g_mean_mag >= {g_min}"
        count = (f"SELECT COUNT(*) AS n FROM (SELECT GAIA_HEALPIX_INDEX({level}, source_id) AS hpx, "
                 f"FLOOR(10 * (phot_bp_mean_mag - phot_rp_mean_mag)) AS cbin FROM {REL.schema}.gaia_source "
                 f"WHERE {cut} GROUP BY hpx, cbin) AS t")
        out.append(tap_query(select, f"{REL.schema}.gaia_source", cut + " GROUP BY hpx, cbin", SUBDIR + "_sums",
                             f"faint_colour_sums_G{g_min}_L{level}_p{pix:02d}", "hpx", count_query=count))
    return out


def fetch_count_grid(level: int) -> list[Path]:
    """Archive star counts and G-flux sums per HEALPix pixel (`level`) and integer G bin, all G: the reference
    for tier counts (docs/reports/sky.md)."""
    select = (f"GAIA_HEALPIX_INDEX({level}, source_id) AS hpx, FLOOR(phot_g_mean_mag) AS gbin, COUNT(*) AS n, "
              "SUM(POWER(10, -0.4 * phot_g_mean_mag)) AS fg")
    out = []
    for pix in range(12 * 4 ** SUM_LEVEL):
        lo, hi = healpix_source_id_range(SUM_LEVEL, pix)
        cut = f"source_id >= {lo} AND source_id < {hi}"
        count = (f"SELECT COUNT(*) AS n FROM (SELECT GAIA_HEALPIX_INDEX({level}, source_id) AS hpx, "
                 f"FLOOR(phot_g_mean_mag) AS gbin FROM {REL.schema}.gaia_source WHERE {cut} GROUP BY hpx, gbin) AS t")
        out.append(tap_query(select, f"{REL.schema}.gaia_source", cut + " GROUP BY hpx, gbin", SUBDIR + "_sums",
                             f"count_grid_L{level}_p{pix:02d}", "hpx", count_query=count))
    return out
