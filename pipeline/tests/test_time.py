"""time.json vs SPICE (str2et with the same LSK). Requires `python -m pipeline build --only time`."""

import calendar
import datetime as dt
import json
import math
import random

import pytest
import spiceypy as sp

from pipeline import download
from pipeline.ephem_kernels import SRC_LSK, gd, lsk
from pipeline.paths import OUT

TIME = OUT / "time.json"
pytestmark = pytest.mark.skipif(not TIME.exists(), reason="time.json not built (run the time stage)")

UNIX_J2000 = 946728000


@pytest.fixture(scope="module")
def data():
    return json.loads(TIME.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def kernel():
    path = lsk()
    sp.furnsh(str(path))
    yield path
    sp.unload(str(path))


def utc_to_et(d: dict, unix_s: float) -> float:
    """Python port of app/src/core/time.ts TimeScale.utcMsToEt (the algorithm the JSON is meant for)."""
    utc = unix_s - UNIX_J2000
    ls = d["leapSeconds"]
    dat = ls[0]["deltaAT"] - 1
    for e in ls:
        if utc >= e["utcJ2000"]:
            dat = e["deltaAT"]
    tt = utc + dat + d["deltaTA"]
    m = d["m0"] + d["m1"] * tt
    return tt + d["k"] * math.sin(m + d["eb"] * math.sin(m))


def test_table_is_the_lsk(data, kernel):
    table = gd("DELTET/DELTA_AT")
    assert data["deltaTA"] == gd("DELTET/DELTA_T_A")[0]
    assert data["k"] == gd("DELTET/K")[0]
    assert data["eb"] == gd("DELTET/EB")[0]
    assert [data["m0"], data["m1"]] == gd("DELTET/M")
    assert [(e["deltaAT"], e["utcJ2000"]) for e in data["leapSeconds"]] == list(zip(table[0::2], table[1::2]))
    assert data["source"] == SRC_LSK


def test_utc_j2000_convention(data):
    # The documented meaning: unix seconds of the instant minus 946728000.
    first, last = data["leapSeconds"][0], data["leapSeconds"][-1]
    assert first == {"utcJ2000": calendar.timegm((1972, 1, 1, 0, 0, 0)) - UNIX_J2000, "deltaAT": 10}
    assert last == {"utcJ2000": calendar.timegm((2017, 1, 1, 0, 0, 0)) - UNIX_J2000, "deltaAT": 37}


def test_utc_to_et_matches_str2et(data, kernel):
    rng = random.Random(7)
    lo, hi = calendar.timegm((1960, 1, 1, 0, 0, 0)), calendar.timegm((2040, 1, 1, 0, 0, 0))
    instants = [rng.uniform(lo, hi) for _ in range(3000)]
    for e in data["leapSeconds"]:  # both sides of every leap second
        u = e["utcJ2000"] + UNIX_J2000
        instants += [u - 1.0, u - 0.5, u - 1e-3, u, u + 1e-3, u + 0.5]
    worst = 0.0
    for u in instants:
        t = dt.datetime(1970, 1, 1) + dt.timedelta(seconds=u)
        spice = sp.str2et(t.strftime("%Y-%m-%dT%H:%M:%S.%f"))
        # timedelta rounds to 1 us; compare against the instant actually formatted.
        u_fmt = calendar.timegm(t.timetuple()) + t.microsecond * 1e-6
        worst = max(worst, abs(utc_to_et(data, u_fmt) - spice))
    print(f"max |utc->et - str2et| = {worst:.3e} s over {len(instants)} instants")
    assert worst < 1e-6


def test_source_record(kernel):
    sources = {s["id"]: s for s in json.loads((OUT / "sources.json").read_text(encoding="utf-8"))}
    rec = sources[SRC_LSK]
    assert rec["sha256"] == download.sha256_file(kernel) == download.record(kernel)["sha256"]
    assert rec["url"].endswith("/naif0012.tls")
