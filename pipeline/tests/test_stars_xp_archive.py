"""The targeted XP route (stars.xpSource=archive, stars_gaia.fetch_xp_archive / xp_reduced_archive) against the bulk
route: the same spectra give the same bytes. Offline: a local TAP-like server answers the POSTed ADQL with FITS
tables, and the same spectra are also written as a bulk ECSV file for stars_gaia._stream_file."""

from __future__ import annotations

import gzip
import hashlib
import http.server
import io
import re
import threading
import urllib.parse

import numpy as np
import pytest
from astropy.io import fits

from pipeline import download
from pipeline import stars_deep as sd
from pipeline import stars_gaia as sg

N = sg.XP_WAVELENGTHS.size


def _spectra(rng, n):
    """float32 spectra spanning many decades (shortest-decimal printing differs from float64 repr there)."""
    f = (rng.lognormal(-37, 2.0, (n, N)) * rng.choice([1, 1, 1, -1], (n, N))).astype(np.float32)
    f[3, 100] = np.nan     # a missing sample inside 360-830 nm: the reduction is NaN
    f[5, 0] = np.nan       # outside the CIE range: still usable
    return f


# two HEALPix level-2 pixels (source_id >> 55), several ids each
IDS = np.array(sorted([(3 << 55) + 17 * k for k in range(1, 12)] + [(40 << 55) + 5 * k for k in range(1, 8)]),
               dtype=np.int64)
FLUX = _spectra(np.random.default_rng(7), IDS.size)
SERVED = {"ids": IDS, "flux": FLUX}     # what the fake TAP service has


def _fits_response(ids) -> bytes:
    row = {int(s): k for k, s in enumerate(SERVED["ids"])}
    k = [row[i] for i in ids if i in row]
    cols = [fits.Column(name="source_id", format="K", array=SERVED["ids"][k]),
            fits.Column(name="flux", format=f"{N}E", array=SERVED["flux"][k])]
    buf = io.BytesIO()
    fits.HDUList([fits.PrimaryHDU(), fits.BinTableHDU.from_columns(cols)]).writeto(buf)
    return buf.getvalue()


class _Tap(http.server.BaseHTTPRequestHandler):
    queries: list[str] = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        form = urllib.parse.parse_qs(body.decode())
        q = form["QUERY"][0]
        assert form["FORMAT"] == ["fits"] and "xp_sampled_mean_spectrum" in q
        _Tap.queries.append(q)
        ids = [int(x) for x in re.search(r"IN \(([^)]*)\)", q).group(1).split(",")]
        out = _fits_response(ids)
        self.send_response(200)
        self.send_header("Content-Type", "application/fits")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


@pytest.fixture(autouse=True)
def _real_matplotlib_or_none(monkeypatch):
    """colour-science, imported by earlier tests, may leave a MagicMock as sys.modules['matplotlib'], which makes
    astropy's FITS writer (the fake service below) fail; hide it (stages/stars.py::_import_astropy)."""
    import sys
    m = sys.modules.get("matplotlib")
    if m is not None and getattr(m, "__spec__", None) is None:
        monkeypatch.delitem(sys.modules, "matplotlib")


@pytest.fixture(scope="module")
def op():
    """The deep tiers' operator (reads the CIE tables from data/raw, before `tap` points data/raw elsewhere)."""
    return sd.xp_operator()


@pytest.fixture
def tap(op, monkeypatch, tmp_path):
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Tap)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    _Tap.queries = []
    monkeypatch.setattr(sg, "ARI_TAP_URL", f"http://127.0.0.1:{srv.server_port}/tap")
    for mod in (sg, download):
        monkeypatch.setattr(mod, "RAW", tmp_path / "raw")
    monkeypatch.setattr(download, "_LEDGER", tmp_path / "raw" / "_downloads.json")
    monkeypatch.setattr(download, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(sg, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(sg, "XP_BATCH", 4)         # several queries per pixel
    yield srv
    srv.shutdown()


def _bulk_reductions(tmp_path, op):
    """The bulk route on the same spectra: a bulk ECSV file printing every sample as ESA's files do (the shortest
    decimal that round-trips to the float32), streamed and reduced by _stream_file."""
    lines = ["# %ECSV 1.0", "# ---", "source_id,solution_id,ra,dec,flux,flux_error"]
    for s, f in zip(IDS, FLUX):
        txt = ",".join("null" if np.isnan(v) else np.format_float_scientific(np.float32(v), unique=True)
                       for v in f)
        lines.append(f'{s},1,0.0,0.0,"[{txt}]","[{",".join(["1e-20"] * N)}]"')
    body = gzip.compress(("\n".join(lines) + "\n").encode())

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = sg.XP_BASE
    try:
        sg.XP_BASE = f"http://127.0.0.1:{srv.server_port}/"
        W, cover = op
        sg._init_worker(IDS, W, cover)
        out_s, out_r = str(tmp_path / "bulk_s.npz"), str(tmp_path / "bulk_r.npz")
        sg._stream_file("f.csv.gz", hashlib.md5(body).hexdigest(), out_s, out_r)
    finally:
        sg.XP_BASE = base
        srv.shutdown()
    return np.load(out_s), np.load(out_r)


def test_batches_stay_in_their_pixel():
    b = sg.xp_batches(np.concatenate([IDS, IDS[:3]]))
    assert all(np.unique(x >> 55).size == 1 and x.size <= sg.XP_BATCH for x in b)
    assert np.array_equal(np.concatenate(b), IDS)


def test_text_float64_is_the_bulk_files_parse():
    rng = np.random.default_rng(3)
    x = (rng.lognormal(-30, 6, 20000) * rng.choice([-1, 1], 20000)).astype(np.float32)
    x[:3] = [np.nan, 0.0, 1.0]
    want = np.array([float(np.format_float_scientific(v, unique=True)) for v in x])   # numpy: shortest
    got = sg.xp_text_float64(x)
    assert np.array_equal(got, want, equal_nan=True)
    assert (got != x.astype(np.float64)).mean() > 0.5      # the text differs from the float32 widened to float64


def test_archive_equals_bulk(tap, op, tmp_path):
    paths, ledger = sg.fetch_xp_archive(IDS, workers=2, log=lambda *_: None)
    assert len(paths) == len(_Tap.queries) == len(sg.xp_batches(IDS))
    assert all(p.with_name(p.name + ".adql").exists() for p in paths)
    rec = download.record(paths[0])
    assert rec["method"] == "POST" and len(rec["postSha256"]) == 64 and ledger["wanted_count"] == IDS.size
    sid, flux = sg.load_xp_archive(paths)
    bulk_s, bulk_r = _bulk_reductions(tmp_path, op)
    # the bright tier: the same float32 spectra
    assert np.array_equal(sid, bulk_s["source_id"]) and np.array_equal(flux, bulk_s["flux"], equal_nan=True)
    # a second call finds everything in data/raw
    n = len(_Tap.queries)
    sg.fetch_xp_archive(IDS, workers=2, log=lambda *_: None)
    assert len(_Tap.queries) == n
    # the deep tiers: the same reductions, bit for bit; the ids above are reduced from the raw responses, only the
    # extra one is queried; asking again queries nothing
    W, cover = op
    extra = np.array([(90 << 55) + 3], dtype=np.int64)
    try:
        SERVED["ids"] = np.concatenate([IDS, extra])
        SERVED["flux"] = np.concatenate([FLUX, _spectra(np.random.default_rng(9), 6)[:1]])
        rpaths, rledger = sg.xp_reduced_archive(SERVED["ids"], W, cover, "t", workers=2, log=lambda *_: None)
        q = len(_Tap.queries)
        assert q == n + 1                                    # only the id not in data/raw was queried
        rs, rr = sg.load_xp_reduced(rpaths)
        k = np.searchsorted(rs, IDS)
        assert np.array_equal(rs[k], IDS)
        assert np.array_equal(rr[k], bulk_r["red"], equal_nan=True)
        assert np.isnan(rr[k][3]).all() and np.isfinite(rr[k][5]).all()
        assert all(v["sha256"] for v in rledger["files"].values())
        sg.xp_reduced_archive(SERVED["ids"], W, cover, "t", workers=2, log=lambda *_: None)
        assert len(_Tap.queries) == q
    finally:
        SERVED.update(ids=IDS, flux=FLUX)


def test_missing_source_is_an_error(tap):
    with pytest.raises(RuntimeError, match="missing"):
        sg.fetch_xp_archive(np.array([(3 << 55) + 1], dtype=np.int64), workers=1, log=lambda *_: None)
