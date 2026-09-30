"""Synthetic populations (M6): the completeness fit, the conditioning, determinism, the yield to discoveries, and the
built products (completeness guard, known + synthetic vs the debiased model)."""

from __future__ import annotations

import math

import numpy as np
import pytest

from pipeline import syn_model as sm
from pipeline.paths import OUT
from pipeline.sb_table import read_table

HAVE_SB = (OUT / "smallbodies" / "core.json").exists() and (OUT / "smallbodies" / "physical.json").exists()
HAVE_SYN = (OUT / "synthetic" / "objects.json").exists() and (OUT / "synthetic" / "cells.json").exists()


# ---------------------------------------------------------------------------------------------- unit
def test_fit_hlim_recovers_constant():
    """Objects drawn from dN/dH ~ 10^(0.3 H) with a detection cut at H_lim(a) = -5 log10(a(a-1)) + 20.5: the peak
    method returns C within two 0.25-mag H bins, on the bright side (the most populated bin is the last full one)."""
    rng = np.random.default_rng(1)
    a = rng.uniform(2.2, 3.0, 400_000)
    H = 12.0 + np.log1p(rng.random(a.size) * math.expm1(0.3 * math.log(10) * 10.0)) / (0.3 * math.log(10))
    lim = sm.hlim_model(a, 20.5)
    keep = H < lim + rng.normal(0.0, 0.1, a.size)       # a soft edge
    fit = sm.fit_hlim(a[keep], H[keep], 2.2, 3.0)
    assert -0.5 < fit["C"] - 20.5 < 0.0
    assert fit["bins"] == 80


def test_condition_group_scaling():
    """raw = max(0, model - known); each (ia, ih) group totals max(0, sum model - known); deficit <= raw."""
    c = sm.Cells(ia=np.array([0, 0, 0, 1]), ie=np.array([0, 1, 2, 0]), ii=np.zeros(4, np.int64), ih=np.full(4, 36),
                 h_lo=np.full(4, 18.0), h_hi=np.full(4, 18.5), n_model=np.array([2.0, 2.0, 2.0, 5.0]),
                 n_obs=np.array([4.0, 0.0, 1.0, 1.0]))
    tot = sm.condition(c, {(0, 36): 5, (1, 36): 1})
    assert np.allclose(c.raw, [0.0, 2.0, 1.0, 4.0])
    assert math.isclose(c.deficit[:3].sum(), 1.0)          # 6 - 5, shared 2:1
    assert np.allclose(c.deficit[:3], [0.0, 2.0 / 3.0, 1.0 / 3.0])
    assert math.isclose(c.deficit[3], 4.0)
    assert np.all(c.deficit <= c.raw + 1e-12)
    assert math.isclose(tot["deficit"], 5.0)


def test_cell_seed_is_stable():
    s1, u1 = sm.cell_seed("synthetic-v1|1|model", 3, 4, 5, 36)
    s2, u2 = sm.cell_seed("synthetic-v1|1|model", 3, 4, 5, 36)
    s3, _ = sm.cell_seed("synthetic-v1|2|model", 3, 4, 5, 36)
    assert (s1, u1) == (s2, u2) and s1 != s3 and 0.0 <= u1 < 1.0
    # prefix property of the candidate stream: drawing more rows does not change the first ones
    a = sm.stream(s1).random((5, sm.ROW))
    b = sm.stream(s1).random((50, sm.ROW))
    assert np.array_equal(a, b[:5])


def test_elements_roundtrip():
    mu = 1.32712440041e11
    el = dict(a_au=np.array([2.5, 5.2, 1.1]), e=np.array([0.1, 0.05, 0.6]), inc=np.array([5.0, 20.0, 40.0]),
              node=np.array([80.0, 300.0, 10.0]), peri=np.array([150.0, 20.0, 250.0]), M=np.array([10.0, 200.0, 359.0]))
    obl = math.radians(84381.448 / 3600.0)
    x, v = sm.elements_to_icrf(el["a_au"], el["e"], el["inc"], el["node"], el["peri"], el["M"], mu, 149597870.7, obl)
    back = sm.state_to_elements(sm.rotate_icrf_to_ecliptic(x, obl), sm.rotate_icrf_to_ecliptic(v, obl), mu)
    assert np.allclose(back["a"] / 149597870.7, el["a_au"], rtol=1e-12)
    for k, kk in (("e", "e"), ("i", "inc"), ("node", "node"), ("peri", "peri")):
        assert np.allclose(back[k], el[kk], atol=1e-8)
    assert np.allclose((back["M"] - el["M"] + 180) % 360 - 180, 0.0, atol=1e-8)


# ---------------------------------------------------------------------------------------------- catalogue runs
@pytest.fixture(scope="module")
def cat():
    if not HAVE_SB:
        pytest.skip("smallbodies products not built")
    from pipeline.stages import synthetic as syn
    return syn.load_catalogue()


def _objects(res, pop):
    r = res["populations"][pop]
    o = r["objects"]
    return np.stack([o[k] for k in ("a", "e", "i", "node", "peri", "M", "H", "pV", "rotPeriod")], axis=1), r


def test_determinism_same_seed_same_products(cat):
    from pipeline.stages import synthetic as syn
    pops = ("trojan", "hilda", "tno")
    r1 = syn.build(cat, only=pops)
    r2 = syn.build(cat, only=pops)
    p = syn.params()
    p["seed"] = p["seed"] + 1
    r3 = syn.build(cat, p, only=pops)
    for pop in pops:
        a1, c1 = _objects(r1, pop)
        a2, c2 = _objects(r2, pop)
        a3, _ = _objects(r3, pop)
        assert a1.tobytes() == a2.tobytes()
        assert np.array_equal(c1["cellOf"], c2["cellOf"]) and np.array_equal(c1["k"], c2["k"])
        assert a1.shape[0] > 1000
        assert a1.shape != a3.shape or a1.tobytes() != a3.tobytes()


def test_yield_removing_known_objects_adds_synthetic_ones(cat):
    """Remove N catalogued Jupiter Trojans fainter than the completeness limit: the synthetic count in their (a, H)
    groups rises by ~N, and every synthetic object shown before is still shown (same cell, same stream index)."""
    from pipeline.stages import synthetic as syn
    base = syn.build(cat, only=("trojan",))
    rb = base["populations"]["trojan"]
    grid = syn.GRIDS["trojan"]
    masks = syn.population_masks(cat)
    hl = rb["hlim"]
    rows = np.nonzero(masks["trojan"])[0]
    ia, ie, ii, ih = grid.index(cat["a"][rows], cat["e"][rows], cat["i"][rows], cat["H"][rows])
    ok = (ia >= 0) & (cat["H"][rows] >= hl[np.maximum(ia, 0)] + 0.6) & (cat["H"][rows] < rb["hFloor"])
    rng = np.random.default_rng(7)
    pick = rng.choice(np.nonzero(ok)[0], 300, replace=False)
    removed = rows[pick]
    groups = {(int(a), int(h)) for a, h in zip(ia[pick], ih[pick])}
    cat2 = dict(cat)
    cat2["ok"] = cat["ok"].copy()
    cat2["ok"][removed] = False
    # Refitting C on the smaller catalogue moves the limit by ~0.001 mag (the fit weights use bin counts): pin it to
    # isolate the yield rule, then check the refit separately.
    p = syn.params()
    p["completenessC"] = {"trojan": rb["limit"]["fit"]["C"]}
    after = syn.build(cat2, p, only=("trojan",))["populations"]["trojan"]
    refit = syn.build(cat2, only=("trojan",))["populations"]["trojan"]
    assert abs(refit["limit"]["fit"]["C"] - rb["limit"]["fit"]["C"]) < 0.01

    def shown_in(r):
        c = r["cells"]
        m = np.array([(int(a), int(h)) in groups for a, h in zip(c.ia, c.ih)])
        return int(c.n_shown[m].sum()), int(m.sum())

    n0, k0 = shown_in(rb)
    n1, _ = shown_in(after)
    assert np.array_equal(after["cells"].n_model, rb["cells"].n_model)       # the model did not move
    assert abs((n1 - n0) - removed.size) <= 3.0 * math.sqrt(k0) / 2.0 + 1.0
    n2, _ = shown_in(refit)
    assert abs((n2 - n0) - removed.size) <= 0.25 * removed.size
    key = lambda r: {(int(r["cells"].ia[c]), int(r["cells"].ie[c]), int(r["cells"].ii[c]), int(r["cells"].ih[c]), int(k))
                     for c, k in zip(r["cellOf"], r["k"])}
    before_set, after_set = key(rb), key(after)
    assert len(before_set - after_set) == 0


# ---------------------------------------------------------------------------------------------- products
@pytest.fixture(scope="module")
def products():
    if not HAVE_SYN:
        pytest.skip("synthetic products not built")
    ho, o = read_table(OUT / "synthetic" / "objects.json")
    hc, c = read_table(OUT / "synthetic" / "cells.json")
    return ho, o, hc, c


def test_products_guard_and_layout(products):
    ho, o, hc, c = products
    assert ho["count"] == o.size and hc["count"] == c.size
    # never brighter than the completeness limit of the cell, never outside the conditioned H range
    assert np.all(o["H"] >= c["hLim"][o["cell"]])
    assert np.all(o["H"] >= c["hLo"][o["cell"]] - 1e-6) and np.all(o["H"] < c["hHi"][o["cell"]] + 1e-6)
    # cell ranges tile the object table
    assert np.all(np.diff(o["cell"].astype(np.int64)) >= 0)
    assert int(c["nShown"].sum()) == o.size
    nz = c["nShown"] > 0
    assert np.all(o["cell"][c["first"][nz]] == np.nonzero(nz)[0])
    # shown = floor(deficit + u0) (float32 storage: allow the rare rounding flip)
    want = np.floor(c["deficit"].astype(np.float64) + c["u0"])
    assert np.mean(want == c["nShown"]) > 0.999
    assert np.all(c["deficit"] <= c["rawDeficit"] + 1e-3)
    # the population code of every object matches its cell's
    assert np.all(o["pop"] == c["pop"][o["cell"]])
    labels = {k: v.get("label") for k, v in ho["columns"].items() if isinstance(v, dict)}
    assert all(labels[k] == "synthetic" for k in ("a", "e", "i", "node", "peri", "M", "H", "pV", "rotPeriod", "colorClass"))


def test_known_plus_synthetic_matches_model(products):
    """Per population and H bin (conditioned ranges): catalogued + synthetic = the debiased model, within Poisson
    rounding and the bins where the catalogue already exceeds the model."""
    ho, o, hc, c = products
    for p in ho["populations"]:
        m = c["pop"] == p["code"]
        for h in np.unique(c["ih"][m]):
            mm = m & (c["ih"] == h)
            model = float(c["nModel"][mm].sum())
            have = float(c["nObs"][mm].sum() + c["nShown"][mm].sum())
            if model > 2000:
                assert abs(have - model) / model < 0.05, (p["name"], h, have, model)
        tm = float(c["nModel"][m].sum())
        th = float(c["nObs"][m].sum() + c["nShown"][m].sum())
        assert abs(th - tm) / tm < 0.03, (p["name"], th, tm)
