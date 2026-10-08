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
        if not m.any():
            assert p["objects"] == 0
            continue
        # Population total: the model against the catalogued objects in the cells' (a, H) groups (any e, i: known
        # objects can sit in (e, i) cells the model leaves empty, e.g. irregular moons outside the known-moon template)
        # plus the synthetic ones; rounding adds up to half an object per cell.
        tm = float(c["nModel"][m].sum())
        th = float(p["totals"]["knownInGroups"] + c["nShown"][m].sum())
        assert abs(th - tm) <= max(0.03 * tm, 0.5 * math.sqrt(int(m.sum())) + 2.0), (p["name"], th, tm)


def test_new_populations_in_products(products):
    """Centaurs and irregular moons: frames, regions (no overlap with the Trojan and Kuiper-belt grids), grey colour
    and unknown rotation of synthetic moons, and the irregular-moon limits."""
    ho, o, hc, c = products
    by = {p["name"]: p for p in ho["populations"]}
    assert {"centaur", "irregular-jupiter", "irregular-saturn", "irregular-uranus", "irregular-neptune"} <= set(by)
    cen = o["pop"] == by["centaur"]["code"]
    assert cen.sum() > 10000
    a, e = o["a"][cen].astype(np.float64), o["e"][cen].astype(np.float64)
    assert np.all((a >= 5.35) & (a < 30.0) & (a * (1 - e) > 5.2 - 1e-5))
    for name in ("trojan", "tno"):
        edges = by[name]["grid"]["aEdgesAu"]
        assert edges[-1] <= 5.35 or edges[0] >= 30.0
    for name in ("irregular-jupiter", "irregular-saturn", "irregular-uranus", "irregular-neptune"):
        p = by[name]
        assert p["center"]["naifId"] in (5, 6, 7, 8) and p["center"]["gm"] > 1e6
        m = o["pop"] == p["code"]
        assert int(m.sum()) == p["objects"]
        if m.any():
            assert np.all(o["colorClass"][m] == 255) and np.all(np.isnan(o["rotPeriod"][m]))
            assert np.all(o["a"][m] < p["grid"]["aEdgesAu"][-1]) and np.all(o["H"][m] >= p["limit"]["hLimV"] - 1e-4)
    # Jupiter: retrograde only (the model's class); Uranus and Neptune: no published population, nothing added
    assert np.all(o["i"][o["pop"] == by["irregular-jupiter"]["code"]] > 90.0)
    assert by["irregular-jupiter"]["objects"] > 100
    assert by["irregular-uranus"]["objects"] == 0 and by["irregular-neptune"]["objects"] == 0


# ---------------------------------------------------------------------------------------------- outer populations
_HIMALIA = ("J006S        K2669 2461304.80448  49.57893  35.41308  28.49007 0.1545808 0.0649571 05  7.93  48328  4099 "
            "Ale MPC xxxxx I941Q-K265M  0.53 M-v 3Ek Himalia")
_S2003J4 = ("    SK03J040 K25BL 2461065.98254 274.50624 288.33026 152.13451 0.4839109 0.0809965 05 16.74   8807    48 Ale "
            "MPC194205 K01CA-K261K  0.09 M-v 3Ek")


def test_parse_mpc_natural_satellite_elements():
    """MPC one-line natural-satellite elements (SatOrbitFormat.html): numbered and provisional designations."""
    from pipeline import syn_sources as ss
    rows = ss.parse_natsats(f"<pre>{_HIMALIA}\n{_S2003J4}\n</pre>")
    assert [r["key"] for r in rows] == ["J6", "S/2003 J 4"]
    h, s = rows
    assert h["name"] == "Himalia" and h["planet"] == 5 and h["H"] == 7.93 and h["i"] == 28.49007
    assert math.isclose(h["a"], 0.0649571 / (1 - 0.1545808)) and s["name"] == "" and s["i"] > 90
    assert ss.satellite_key("SK19S010") == "S/2019 S 1" and ss.satellite_key("S067S") == "S67"


def test_moon_calibration_and_models():
    """The offset is the median of H_MPC - m (an outlier does not move it); the models reproduce the papers' counts."""
    from pipeline import syn_outer as so
    rows = [{"key": "J30", "name": "Hermippe", "H": 15.5}, {"key": "J25", "name": "Erinome", "H": 16.04},
            {"key": "S/2003 J 16", "name": "", "H": 16.34}, {"key": "J51", "name": "unnamed", "H": 16.13}]
    cal = so.calibrate([["Hermippe", 21.8], ["Erinome", 22.4], ["S/2003 J 16", 22.8], ["J51", 24.2], ["Nope", 20]], rows)
    assert cal["n"] == 4 and cal["notInMpcList"] == ["Nope"]
    assert math.isclose(cal["offset"], np.median([-6.3, -6.36, -6.46, -8.07]), abs_tol=1e-9)
    jup = so.moon_model({"magRange": [24.0, 25.7], "nBright": 160, "nFaint": 600, "alpha": 0.29}, -6.37)
    assert math.isclose(jup.n_between(0, 99), 440.0) and math.isclose(jup.h_lo, 17.63) and math.isclose(jup.h_hi, 19.33)
    assert jup.n_between(18.5, 19.0) > jup.n_between(18.0, 18.5)          # rising luminosity function
    sat = so.moon_model({"magRange": [25.7, 26.3], "nFaint": 150, "q": 4.9}, -9.98)
    assert math.isclose(sat.alpha, 0.78) and math.isclose(sat.n_total, 150 * (1 - 10 ** (-0.78 * 0.6)))
    # limit: the first bin where known < model - 2 sqrt(model)
    H = np.r_[np.full(60, 17.8), np.full(110, 18.2)]
    hlim, rows_ = so.moon_limit(H, jup)
    assert hlim == 18.5 and [r["short"] for r in rows_] == [False, False, True, True]
    assert so.moon_limit(np.full(1000, 18.7), so.MoonModel(18.5, 19.0, 0.3, 10.0))[0] is None


def test_knee_law_and_selection_reweighting():
    """The knee law's inverse and cumulative agree; weighting a magnitude-selected sample by 1/P(selected | distance
    modulus) recovers the full sample size (the Centaur archive's reconstruction)."""
    from pipeline import syn_outer as so
    law = so.KneeLaw(0.9, 0.4, 7.7, 13.7)
    u = np.linspace(0.001, 0.999, 50)
    h = law.inverse(u)
    assert np.allclose(law.cum(h) / law.cum(13.7), u, atol=1e-12) and np.all(np.diff(h) > 0)
    rng = np.random.default_rng(3)
    n = 400_000
    H = law.inverse(rng.random(n))
    d = 5 * np.log10(rng.uniform(6, 30, n) ** 2)                 # distance moduli of objects 6-30 au away
    m = H + d
    sel = (m > 21) & (m < 23.5)
    w = 1 / law.selection_probability(d[sel], 21.0, 23.5)
    assert abs(w.sum() / n - 1) < 0.03


@pytest.fixture(scope="module")
def centaur_archive():
    from pipeline import syn_sources as ss
    if not ss.KURLANDER_ARCHIVE._dest().exists():
        pytest.skip("Centaur model archive not downloaded")
    return ss.read_centaur_archive()


def test_centaur_archive_reconstruction(centaur_archive):
    """The archive follows the knee law read as a differential law (and not the cumulative reading), and the
    selection weights add up to the model size stated in the archive (within the members that could never be
    selected, about 1 %)."""
    from pipeline import syn_outer as so
    from pipeline import syn_sources as ss
    tab = ss.tables()["centaurs"]
    chk = so.knee_check(centaur_archive, tab)
    assert chk["differential knee (used)"]["chi2PerBin"] < 1.5 < 10 < chk["cumulative knee (alternative)"]["chi2PerBin"]
    mem, diag = so.centaur_realization(centaur_archive, tab)
    assert 0.97 < diag["sumWeightsOverModelSize"] <= 1.0 and diag["effectiveSampleSize"] > 50_000
    assert mem["a"].size == 21_400 and np.all(mem["Hr"] <= 13.7 + 1e-9)
    mem2, _ = so.centaur_realization(centaur_archive, tab)
    assert np.array_equal(mem["a"], mem2["a"]) and np.array_equal(mem["H"], mem2["H"])


def test_centaur_yield_to_discoveries(cat, centaur_archive):
    """Remove catalogued Centaurs fainter than their limit: the synthetic count in their groups rises by about as
    many, and every synthetic Centaur shown before is still shown (same cell, same place in its stream)."""
    from pipeline.stages import synthetic as syn
    base = syn.build(cat, only=("centaur",), centaur_archive=centaur_archive)["populations"]["centaur"]
    grid = syn.GRIDS["centaur"]
    rows = np.nonzero(syn.population_masks(cat)["centaur"])[0]
    ia, ie, ii, ih = grid.index(cat["a"][rows], cat["e"][rows], cat["i"][rows], cat["H"][rows])
    hl = base["hlim"]
    ok = (ia >= 0) & np.isfinite(hl[np.maximum(ia, 0)]) & (cat["H"][rows] >= hl[np.maximum(ia, 0)] + 0.5) \
        & (cat["H"][rows] < base["hFloor"])
    removed = rows[np.nonzero(ok)[0]]
    assert removed.size >= 20
    groups = {(int(a), int(h)) for a, h in zip(ia[ok], ih[ok])}
    cat2 = dict(cat)
    cat2["ok"] = cat["ok"].copy()
    cat2["ok"][removed] = False
    after = syn.build(cat2, only=("centaur",), centaur_archive=centaur_archive)["populations"]["centaur"]

    def shown_in(r):
        c = r["cells"]
        m = np.array([(int(a), int(h)) in groups for a, h in zip(c.ia, c.ih)])
        return int(c.n_shown[m].sum()), int(m.sum())

    n0, k0 = shown_in(base)
    n1, _ = shown_in(after)
    assert abs((n1 - n0) - removed.size) <= 3.0 * math.sqrt(k0) / 2.0 + 2.0, (n1 - n0, removed.size)
    key = lambda r: {(int(r["cells"].ia[c]), int(r["cells"].ie[c]), int(r["cells"].ii[c]), int(r["cells"].ih[c]), int(k))
                     for c, k in zip(r["cellOf"], r["k"])}
    assert not key(base) - key(after)


def test_irregular_moons_yield_to_discoveries(cat):
    """Discover 30 of the synthetic retrograde jovian moons (add them to the MPC list as known moons): the layer
    shows about 30 fewer, all of them moons it showed before; the same seed gives the same moons."""
    from pipeline import syn_sources as ss
    from pipeline.stages import synthetic as syn
    if not ss.NATSATS["jupiter"]._dest().exists():
        pytest.skip("MPC natural-satellite elements not downloaded")
    rows = ss.read_natsats("jupiter")
    pop = ("irregular-jupiter",)
    base = syn.build(cat, only=pop, moons={"jupiter": rows})["populations"]["irregular-jupiter"]
    again = syn.build(cat, only=pop, moons={"jupiter": rows})["populations"]["irregular-jupiter"]
    assert all(np.array_equal(base["objects"][k], again["objects"][k]) for k in ("a", "e", "i", "node", "H", "pV"))
    o = base["objects"]
    pick = np.nonzero((o["H"] >= 18.0) & (o["H"] < 18.5))[0][:30]
    assert pick.size == 30
    found = [{"key": f"S/2099 J {j + 1}", "name": "", "planet": 5, "H": float(o["H"][j]), "e": float(o["e"][j]),
              "q": float(o["a"][j] * (1 - o["e"][j])), "a": float(o["a"][j]), "i": float(o["i"][j]), "node": 0.0,
              "peri": 0.0, "epoch": "", "arcDays": None} for j in pick]
    after = syn.build(cat, only=pop, moons={"jupiter": rows + found})["populations"]["irregular-jupiter"]
    n0, n1 = int(base["cells"].n_shown.sum()), int(after["cells"].n_shown.sum())
    assert abs((n0 - n1) - 30) <= 4, (n0, n1)
    key = lambda r: {(int(r["cells"].ia[c]), int(r["cells"].ie[c]), int(r["cells"].ii[c]), int(r["cells"].ih[c]), int(k))
                     for c, k in zip(r["cellOf"], r["k"])}
    assert not key(after) - key(base)
    assert after["limit"]["hLimV"] == base["limit"]["hLimV"]


@pytest.mark.skipif(not HAVE_SYN, reason="synthetic products not built")
def test_product_statements_disclose_limits_and_motion():
    """Product metadata must distinguish fitted guards, aggregate yield and sampled drift from guarantees."""
    import json
    h = json.loads((OUT / "synthetic" / "objects.json").read_text())
    assert "aggregate" in h["yieldRule"] and "not one-to-one" in h["yieldRule"]
    for p in h["populations"]:
        assert "proxy" in p["limit"]["uncertainty"]
        assert "not a detection probability" in p["limit"]["uncertainty"]
        assert "pointing" in p["limit"]["uncertainty"]
        assert "unknown" in p["model"]["positionUncertainty"]
        if p.get("center"):
            assert "differential Sun" in p["model"]["motion"]
            integration = p["model"]["integration"]
            fm = integration["forceModel"]
            assert fm["sun"]["naifId"] == p["center"]["naifId"]
            assert fm["sun"]["gm"] == p["center"]["gm"]
            assert fm["sun"]["naifId"] not in [q["naifId"] for q in fm["perturbers"]]
            assert 10 in [q["naifId"] for q in fm["perturbers"]]
            assert not fm["relativity"]["enabled"] and fm["zonal"]["perturber"] is None
            assert integration["budgets"]["gpuNumericalKm"] is None
            from pipeline.download import sha256_file
            assert integration["inputProducts"]["ephem/centers.bin"] == sha256_file(OUT / "ephem/centers.bin")
            assert set(fm["sun"]["sources"] + fm["perturberSources"]).issubset(p["sources"])
        else:
            assert "fixed" in p["model"]["motion"]
        if p["objects"]:
            assert "C3" in p["model"]["positionUncertainty"]
            assert "not a bound" in p["model"]["positionUncertainty"]
        if p.get("center"):
            assert "no bias-corrected orbit distribution was found" in p["model"]["orbitDistribution"]
            if p["objects"]:
                assert "normalization" in p["model"]["uncertainty"]
    centaur = next(p for p in h["populations"] if p["name"] == "centaur")
    assert centaur["model"]["cataloguedCometsNotCounted"] == 43
    assert centaur["model"]["cataloguedCometsCounted"] == 1
    assert "43" in centaur["model"]["uncertainty"]
    assert "comet-flagged" in centaur["model"]["uncertainty"]
    nuclei = centaur["model"]["cometNuclei"]
    assert len(nuclei["objects"]) == 44
    assert "M1" in nuclei["rule"] and "lower bounds" in nuclei["rule"]
    assert sum("nuclearLaw" in r["photometry"] for r in nuclei["objects"]) == 18
    assert [r["designation"] for r in nuclei["objects"] if r["status"] == "conditioned"] == ["C/2014 OG392"]
    assert next(r for r in nuclei["objects"] if r["designation"] == "39P")["H_V"]["label"] == "unknown"
    assert "rejects their joint distribution" in centaur["model"]["uncertainty"]


def test_all_population_metadata_including_no_model():
    """The disclosure path also covers intentionally empty Uranus/Neptune populations."""
    from pipeline.stages import synthetic as syn
    res = {"populations": {pop: {"limit": {}, "extra": {"orbitDistribution": "template assumption",
            "cataloguedCometsNotCounted": 44, "cataloguedCometsCounted": 0, "cometNuclei": {"rule": "Qualified H_V only", "objects": []},
            "realization": {"sumWeightsOverModelSize": 0.99},
            "normalization": {"nBelowHr": 21400, "plus": 3400, "minus": 2800, "hrMax": 13.7}}} for pop in syn.POP_CODES}}
    result = syn._order(res)
    assert list(result["populations"]) == list(syn.POP_CODES)
    for pop, r in result["populations"].items():
        assert "not a detection probability" in r["limit"]["uncertainty"]
        assert "unknown" in r["extra"]["positionUncertainty"]
        assert r["extra"]["method"] and r["extra"]["uncertainty"]
        if pop not in syn.MOONS:
            assert "fixed two-body" in r["extra"]["motion"]


def test_centaur_comet_nucleus_conditioning():
    """A sourced point nuclear H yields in its represented group; M1, bounds and out-of-range H do not."""
    from pipeline.stages import synthetic as syn
    cat = {k: np.array(v) for k, v in {
        'a': [10.2] * 6, 'e': [0.2] * 6, 'i': [7.] * 6,
        'H': [np.nan] * 6, 'comet': [True] * 6, 'ok': [False] * 6,
        'spkid': [1, 2, 3, 4, 5, 6], 'designation': ['P/point', 'P/total', 'P/faint', 'P/bound', 'P/no-colour', 'P/unsourced'],
    }.items()}
    def record(k, value, kind='bare-nucleus', band='V', sources=None):
        return {'spkid': k, 'kind': kind, 'band': band,
                'H': {'value': value, 'label': 'estimated', 'sources': ['paper'] if sources is None else sources},
                'H_V': {'value': value if band == 'V' else None,
                        'label': 'estimated' if band == 'V' else 'unknown',
                        'sources': ['paper'] if sources is None else sources}}
    records = [record(1, 12.2), record(2, 12.2, 'total-magnitude'), record(3, 15.2),
               record(4, 12.2, 'lower-bound'), record(5, 12.2, band='r'), record(6, 12.2, sources=[])]
    known, diag = syn.centaur_known(cat, records, 14.0)
    grid = syn.GRIDS['centaur']
    def count(k):
        c = sm.cells_from_rows([(5, 2, 1, 24, 12., 12.5, 16.)])
        idx = grid.index(k.a, k.e, k.i, k.H)
        totals = sm.condition(c, sm.count_known(grid, c, (*idx, k.H)))
        sm.sample_realization(grid, c, {int(grid.key(c.ia, c.ie, c.ii, c.ih)[0]): np.arange(16)}, 'test')
        return totals['deficit'], c.n_shown.sum()
    empty, _ = syn.centaur_known(cat, [], 14.0)
    assert count(known) == (count(empty)[0] - 1, count(empty)[1] - 1)
    assert known.H.tolist() == [12.2]
    assert [r['status'] for r in diag['objects']] == ['eligible', 'unqualified', 'outside-model-H', 'unqualified', 'unknown-model-band', 'unsourced']


def test_centaur_classifier_parser_rejects_executable_pickle(tmp_path):
    import pickle
    from pipeline import syn_sources as ss
    class Executable:
        def __reduce__(self):
            return eval, ("1 + 1",)
    with pytest.raises(ValueError, match='global|opcode|format'):
        ss.parse_centaur_classifier(pickle.dumps(Executable(), protocol=3))


def test_centaur_source_selection_uses_state_and_domain(centaur_archive):
    from pipeline import syn_sources as ss
    classifier = ss.read_centaur_classifier()
    states = centaur_archive['states']
    result = ss.centaur_selection(classifier, states)
    # Notebook and paper §4.4 report 54,638 selected literature states out of 26,116,868 original members.
    assert int((result['status'] == 1).sum()) == 54638
    assert np.all(np.isfinite(result['distance']))
    assert classifier['points'].shape == (379485, 7)
    probe = states[:2].copy()
    probe[:, 6] = [20.99, 23.51]
    assert ss.centaur_selection(classifier, probe)['status'].tolist() == [-1, -1]
    # A nonfinite query must be unknown, never silently counted as undetected.
    probe[0, 6] = 22.; probe[0, 0] = np.nan
    assert ss.centaur_selection(classifier, probe)['status'][0] == -1


def test_centaur_selection_changes_with_orbital_phase_at_equal_magnitude():
    from pipeline import syn_sources as ss
    # Circular orbits differing only in phase (arbitrary fixture units); the scalar magnitude is identical.
    states = np.array([[1., 0., 0., 0., 1., 0., 22.], [0., 1., 0., -1., 0., 0., 22.]])
    classifier = {'points': states, 'scale': np.ones(7), 'status': np.array([True, False])}
    assert ss.centaur_selection(classifier, states)['status'].tolist() == [1, 0]
    states[0, 6] = 21.; states[1, 6] = 23.5
    assert ss.centaur_selection(classifier, states)['status'].tolist() == [-1, -1]


def test_og392_nuclear_h_reproduces_published_photometry_reduction():
    """Chandler §7 Eq.9–10: quoted H=11.3 is inconsistent with its V=22.4 and geometry.
    Use the published photometry, G and equations, independent of population counts/validation scenes.
    """
    from pipeline import syn_sources as ss
    r = next(r for r in ss.centaur_nuclei()['objects'] if r['designation'] == 'C/2014 OG392')
    t = math.tan(math.radians(5.58) / 2)
    phi = .85 * math.exp(-3.33 * t**.63) + .15 * math.exp(-1.87 * t**1.22)
    expected = 22.4 - 5 * math.log10(10.10 * 10.01) + 2.5 * math.log10(phi)
    assert math.isclose(r['H_V']['value'], expected, abs_tol=5e-5)
    assert r['H_V']['label'] == 'estimated'


@pytest.mark.skipif(not HAVE_SB, reason="smallbodies products not built")
def test_moon_force_translation_preserves_inputs_and_external_set():
    import copy
    import json
    from pipeline.stages.synthetic import moon_integration_metadata
    core = json.loads((OUT / "smallbodies/core.json").read_text())
    before = copy.deepcopy(core)
    for host_id in (5, 6):
        host = next(p for p in core["forceModel"]["perturbers"] if p["naifId"] == host_id)
        m = moon_integration_metadata(core, {"naifId": host_id, "gm": host["gm"]})
        assert m["window"] == core["window"]
        assert m["forceModel"]["sun"]["gm"] == host["gm"]
        assert [p["naifId"] for p in m["forceModel"]["perturbers"]] == [10] + [p["naifId"] for p in core["forceModel"]["perturbers"] if p["naifId"] != host_id]
    assert core == before


@pytest.mark.skipif(not HAVE_SYN, reason="synthetic products not built")
def test_moon_epoch_states_in_product_preserve_stored_elements():
    """Cartesian states live beside the immutable stored elements, with their synthetic label and sources."""
    import math
    header, objects = read_table(OUT / 'synthetic/objects.json')
    moons = [p for p in header['populations'] if p.get('center') and p['objects']]
    assert sum(p['objects'] for p in moons) == 458
    for p in moons:
        initial = p['model']['integration']['initialState']
        assert initial['label'] == 'synthetic'
        assert initial['epochEt'] == header['epochEt']
        assert set(initial['sources']) == set(p['sources'])
        a = slice(p['firstObject'], p['firstObject'] + p['objects'])
        pos, vel = sm.elements_to_icrf(*[objects[k][a].astype(np.float64) for k in ('a','e','i','node','peri','M')],
                                      p['center']['gm'], header['auKm'], math.radians(header['obliquityArcsec']/3600))
        expected = np.column_stack([pos, vel])
        assert np.array_equal(np.asarray(initial['value']), expected)
