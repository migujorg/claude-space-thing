"""The Gaia XP bulk-file pass shared by the stars and deep-star stages (stars_gaia._stream_file): one read of a
file gives exactly what the two separate passes give. Offline: a small bulk file served from a local server."""

from __future__ import annotations

import gzip
import hashlib
import http.server
import threading

import numpy as np
import pytest

from pipeline import stars_deep as sd
from pipeline import stars_gaia as sg

N_SAMPLES = sg.XP_WAVELENGTHS.size


def _bulk_file(rng) -> tuple[bytes, list[int]]:
    """ECSV-like bulk XP file: comment header, column line, rows with quoted flux / flux_error arrays."""
    lines = ["# %ECSV 1.0", "# ---", "source_id,solution_id,ra,dec,flux,flux_error"]
    ids = []
    for k in range(40):
        sid = 1000 + 7 * k
        ids.append(sid)
        f = rng.normal(1e-16, 3e-17, N_SAMPLES)
        e = np.abs(rng.normal(1e-18, 1e-19, N_SAMPLES))
        fs = [repr(float(x)) for x in f]
        if k % 9 == 4:
            fs[100] = "null"                      # a missing sample inside 360-830 nm
        if k % 11 == 3:
            fs[0] = "null"                        # outside the CIE range: still usable
        lines.append(f'{sid},{k},{10.0 + k},{-5.0 + k},"[{",".join(fs)}]","[{",".join(repr(float(x)) for x in e)}]"')
    return gzip.compress(("\n".join(lines) + "\n").encode()), ids


class _H(http.server.BaseHTTPRequestHandler):
    body = b""

    def log_message(self, *a):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", str(len(self.body)))
        self.end_headers()
        self.wfile.write(self.body)


@pytest.fixture
def served(monkeypatch):
    body, ids = _bulk_file(np.random.default_rng(5))
    _H.body = body
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setattr(sg, "XP_BASE", f"http://127.0.0.1:{srv.server_port}/")
    yield body, ids
    srv.shutdown()


def _npz(path):
    z = np.load(path)
    return {k: z[k] for k in z.files}


def test_shared_pass_equals_separate_passes(served, tmp_path):
    body, ids = served
    md5 = hashlib.md5(body).hexdigest()
    wanted = np.array(ids[::3] + [999_999], dtype=np.int64)     # some wanted sources, one not in the file
    W, cover = sd.xp_operator()
    p = {k: str(tmp_path / f"{k}.npz") for k in ("subset", "reduced", "both_s", "both_r")}

    sg._init_worker(wanted)
    rs = sg._stream_file("f.csv.gz", md5, p["subset"], None)
    sg._init_worker(None, W, cover)
    rr = sg._stream_file("f.csv.gz", md5, None, p["reduced"])
    sg._init_worker(wanted, W, cover)
    rb = sg._stream_file("f.csv.gz", md5, p["both_s"], p["both_r"])

    for a, b in ((p["subset"], p["both_s"]), (p["reduced"], p["both_r"])):
        za, zb = _npz(a), _npz(b)
        assert za.keys() == zb.keys()
        for k in za:
            assert za[k].dtype == zb[k].dtype and np.array_equal(za[k], zb[k], equal_nan=True), k
    drop = {"subset_sha256"}
    assert {k: v for k, v in rs["subset"].items() if k not in drop} == \
           {k: v for k, v in rb["subset"].items() if k not in drop}
    assert {k: v for k, v in rr["reduced"].items() if k not in drop} == \
           {k: v for k, v in rb["reduced"].items() if k not in drop}
    assert rs["subset"]["kept"] == len(ids[::3]) and rr["reduced"]["rows"] == len(ids)
    red = _npz(p["reduced"])["red"]
    assert np.isnan(red[4]).all() and np.isfinite(red[3]).all()   # missing CIE sample -> unusable; edge -> fine


def test_md5_mismatch_is_an_error(served, tmp_path):
    sg._init_worker(np.array([1000]))
    with pytest.raises(RuntimeError, match="md5 mismatch"):
        sg._stream_file("f.csv.gz", "0" * 32, str(tmp_path / "s.npz"), None, retries=0)


def test_stars_pass_fills_the_deep_cache(served, tmp_path, monkeypatch):
    """stream_xp(also_reduce=...) streams each file once; stream_xp_reduced afterwards has nothing left to fetch."""
    from concurrent.futures import ThreadPoolExecutor

    body, ids = served
    monkeypatch.setattr(sg, "ProcessPoolExecutor", ThreadPoolExecutor)   # same code path, in-process
    monkeypatch.setattr(sg, "RAW", tmp_path / "raw")
    monkeypatch.setattr(sg, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(sg, "xp_index", lambda: [("f.csv.gz", hashlib.md5(body).hexdigest())])
    got = []
    real = sg._stream_file
    monkeypatch.setattr(sg, "_stream_file", lambda *a, **k: got.append(a[2:4]) or real(*a, **k))
    W, cover = sd.xp_operator()
    paths, ledger = sg.stream_xp(np.array(ids[:5]), workers=1, log=lambda *_: None,
                                 also_reduce=(W, cover, sd.XP_TAG))
    assert len(got) == 1 and all(got[0])                      # one pass wrote both outputs
    assert ledger["files"]["f.csv.gz"]["kept"] == 5
    rpaths, rledger = sg.stream_xp_reduced(W, cover, sd.XP_TAG, workers=1, log=lambda *_: None)
    assert len(got) == 1 and rledger["files"]["f.csv.gz"]["rows"] == len(ids)
    assert rpaths[0].exists() and paths[0].exists()
