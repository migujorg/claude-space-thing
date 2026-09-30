"""`synthetic` stage -> app/public/data/synthetic/ (the COMPLETE reality level: objects no survey has found yet).

Fills, population by population, only what the catalogue is missing (algorithm: pipeline/syn_model.py; description
and numbers: docs/reports/synthetic-populations.md):

  neo       q < 1.3 au: the Granvik et al. (2018) NEO model realization (17 < H < 25).
  hungaria  1.78 <= a < 2.0 au, q >= 1.3 au  } the catalogue, complete to the Hendler & Malhotra (2020) limit
  mainbelt  2.0 <= a < 3.7 au, q >= 1.3 au   } H_lim(a) refitted here, continued fainter with the debiased slope of
                                             } Maeda et al. (2021)
  hilda     3.7 <= a < 4.2 au, q >= 1.3 au: the same, slope of Terai & Yoshida (2018)
  trojan    5.05 <= a < 5.35 au: the same, slope of Yoshida & Terai (2017)
  tno       a >= 30 au: the CFEPS L7 Kuiper-belt model realization (H_g <= 8.5 -> H_V <= 8.08)

Products:
  synthetic/objects.bin/.json  one record per synthetic object: osculating heliocentric ecliptic-J2000 elements at
                               the small-body epoch (smallbodies/core.json epochEt), H, p_V, rotation period, colour
                               class, the cell it fills and its place in that cell's stream. Every attribute is
                               labelled `synthetic`.
  synthetic/cells.bin/.json    one record per cell: box, completeness limit, model and known counts, deficit, seed
                               inputs, how many synthetic objects it shows and where they start in objects.bin.
Also docs/reports/synthetic-populations.json (verification numbers).

Parameters (defaults in PARAMS; JSON overrides in the environment variable SYNTHETIC_PARAMS, e.g.
'{"hFloor": {"mainbelt": 19.5}}'): the seed, the faint limit (H floor) per population, and optionally
"completenessC": {population: C} to pin the completeness limit instead of refitting it to the catalogue.
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import os
import time
from collections import Counter
from pathlib import Path

import numpy as np

from .. import syn_model as sm
from .. import syn_sources as ss
from ..download import sha256_file
from ..ephem_kernels import planetary
from ..ephem_spk import evaluate, read_spk
from ..paths import OUT
from ..sb_table import LABEL_CODE, Field, read_table, write_table
from ..schema import BuildContext

DEPENDS: tuple[str, ...] = ("smallbodies",)
STAGE = "synthetic"
DIR = "synthetic"
REPORT = Path(__file__).resolve().parents[4] / "docs" / "reports" / "synthetic-populations.json"
FIGURE = REPORT.parent / "img" / "synthetic-h-distributions.svg"
DIAGNOSTIC = REPORT.parent / "img" / "synthetic-diagnostic-known-vs-synthetic.png"
J2000_JD = 2451545.0
DAY = 86400.0
AU_KM = 149597870.7                      # IAU 2012 Resolution B2
Q_MIN_AU = 1.3                           # NEO / non-NEO boundary (perihelion distance)
SLOPE_G = 0.15                           # Bowell et al. (1989) conventional G (as the smallbodies stage)

PARAMS = {
    "seed": 20260930,
    # Faint limit per population (V absolute magnitude). neo, hilda, trojan, tno: the faint end of the model or of
    # the survey that measured the slope (see _floors). mainbelt/hungaria: a budget choice inside the measured range
    # (Maeda et al. 2021 reach H_V 20.55): 20.0 keeps the synthetic main belt near 2 million objects.
    "hFloor": {"mainbelt": 20.0, "hungaria": 20.0},
    "minTemplates": {"albedo": 200, "rotation": 50},
}
POP_CODES = {"neo": 0, "hungaria": 1, "mainbelt": 2, "hilda": 3, "trojan": 4, "tno": 5}
_MB_GRID = dict(e_width=0.05, i_width=2.5, n_e=14, n_i=36)
GRIDS = {
    "neo": sm.Grid(sm.uniform_edges(0.25, 4.25, 0.25), 0.1, 10.0, 10, 18),
    "hungaria": sm.Grid(sm.uniform_edges(1.78, 2.0, 0.02), **_MB_GRID),
    "mainbelt": sm.Grid(sm.uniform_edges(2.0, 3.7, 0.02), **_MB_GRID),
    "hilda": sm.Grid(sm.uniform_edges(3.7, 4.2, 0.02), **_MB_GRID),
    "trojan": sm.Grid(sm.uniform_edges(5.05, 5.35, 0.02), **_MB_GRID),
    "tno": sm.Grid(sm.uniform_edges(30.0, 50.0, 1.0) + sm.uniform_edges(50.0, 100.0, 5.0)[1:]
                   + (125.0, 150.0, 175.0, 200.0) + sm.uniform_edges(200.0, 800.0, 100.0)[1:], 0.1, 5.0, 10, 18),
}
# Region over which C of H_lim(a) is fitted (Hendler & Malhotra 2020, Table 1 regions).
FIT_RANGE = {"hungaria": (1.78, 2.0), "mainbelt": (2.12, 3.25), "hilda": (3.92, 4.004), "trojan": (5.095, 5.319)}
ANGLES = {"hungaria": "uniform", "mainbelt": "uniform", "hilda": "hilda", "trojan": "trojan"}


def params(over: str | None = None) -> dict:
    """PARAMS with the overrides of `over` (JSON; default: the synthetic.params build parameter's variable)."""
    p = json.loads(json.dumps(PARAMS))
    over = (os.environ.get("SYNTHETIC_PARAMS", "") if over is None else over).strip()
    if over:
        for k, v in json.loads(over).items():
            if isinstance(v, dict):
                p.setdefault(k, {}).update(v)
            else:
                p[k] = v
    return p


def _floors(tab: dict, p: dict) -> dict[str, float]:
    sfd = tab["sfd"]
    kb = tab["kuiperBeltColour"]
    v_minus_g = -(kb["transformation"]["k"] * kb["gMinusR"] - kb["transformation"]["c"])
    mb_max = sfd["mainBelt"]["sampleMaxHr"] + sfd["mainBelt"]["vMinusR"]
    f = {
        "neo": 25.0,     # the NEO model's faint end (README: 17 < H < 25)
        "hilda": round(sfd["hildas"]["maxHr"] + sfd["hildas"]["vMinusR"], 3),
        "trojan": round(sfd["jupiterTrojans"]["validHr"][1] + sfd["jupiterTrojans"]["vMinusR"], 3),
        "tno": round(8.5 + v_minus_g, 3),   # L7: H_g <= 8.5 (model page)
        "mainbelt": mb_max, "hungaria": mb_max,
    }
    for k, v in p.get("hFloor", {}).items():
        if k in ("mainbelt", "hungaria") and v > mb_max:
            raise ValueError(f"hFloor.{k} = {v}: beyond the measured slope range (H_V <= {mb_max})")
        f[k] = float(v)
    return f


# ---------------------------------------------------------------------------------------------- catalogue
def load_catalogue(root: Path = OUT / "smallbodies") -> dict:
    """The known objects (smallbodies products): osculating heliocentric ecliptic-J2000 elements at epochEt from the
    core states, H, and the templates for the attributes (measured albedos and rotation periods)."""
    hdr, core = read_table(root / "core.json")
    fm = hdr["forceModel"]
    mu = fm["sun"]["gm"]
    obl = math.radians(fm["obliquityArcsec"] / 3600.0)
    flag = {v: int(k) for k, v in hdr["flagBits"].items()}
    pos = sm.rotate_icrf_to_ecliptic(core["pos"], obl)
    vel = sm.rotate_icrf_to_ecliptic(core["vel"], obl)
    el = sm.state_to_elements(pos, vel, mu)
    comet = (core["flags"] & flag["comet"]) != 0
    H = core["H"].astype(np.float64)
    ok = ~comet & np.isfinite(el["a"]) & np.isfinite(H)
    ph, phys = read_table(root / "physical.json")
    return {"header": hdr, "mu": mu, "obliquity": obl, "a": el["a"] / AU_KM, "e": el["e"], "i": el["i"],
            "node": el["node"], "peri": el["peri"], "M": el["M"], "H": H, "ok": ok, "colorClass": core["colorClass"],
            "diameterFromH": core["diameterFromH"].astype(np.float64), "physHeader": ph, "phys": phys,
            "coreSha256": sha256_file(root / "core.bin"), "physSha256": sha256_file(root / "physical.bin")}


def population_masks(cat: dict) -> dict[str, np.ndarray]:
    a, e, ok = cat["a"], cat["e"], cat["ok"]
    q = a * (1.0 - e)
    with np.errstate(invalid="ignore"):
        return {
            "neo": ok & (q < Q_MIN_AU),
            "hungaria": ok & (q >= Q_MIN_AU) & (a >= 1.78) & (a < 2.0),
            "mainbelt": ok & (q >= Q_MIN_AU) & (a >= 2.0) & (a < 3.7),
            "hilda": ok & (q >= Q_MIN_AU) & (a >= 3.7) & (a < 4.2),
            "trojan": ok & (q >= Q_MIN_AU) & (a >= 5.05) & (a < 5.35),
            "tno": ok & (a >= 30.0),
        }


def _known(cat: dict, m: np.ndarray) -> sm.Known:
    return sm.Known(cat["a"][m], cat["e"][m], cat["i"][m], cat["H"][m])


# ---------------------------------------------------------------------------------------------- ephemeris
def _helio_state(spk: dict, naif: int, et: float) -> tuple[np.ndarray, np.ndarray]:
    p, v = evaluate(spk[(naif, 0)], et)
    s, sv = evaluate(spk[(10, 0)], et)
    return (p - s)[0], (v - sv)[0]


def planet_longitudes(cat: dict, epoch_et: float, l7_epoch_jd: float) -> dict:
    """Jupiter's mean longitude at epochEt (Trojan and Hilda geometry) and Neptune's at the L7 epoch (check of the
    model file's lambdaN), from DE442s: heliocentric barycentre states rotated to the ecliptic, mu = GM_sun + GM."""
    spk = {(s.target, s.center): s for s in read_spk(planetary(None))}
    gm = {p["naifId"]: p["gm"] for p in cat["header"]["forceModel"]["perturbers"]}
    out = {}
    for name, naif, et in (("jupiter", 5, epoch_et), ("neptune", 8, (l7_epoch_jd - J2000_JD) * DAY)):
        r, v = _helio_state(spk, naif, et)
        el = sm.state_to_elements(sm.rotate_icrf_to_ecliptic(r, cat["obliquity"]),
                                  sm.rotate_icrf_to_ecliptic(v, cat["obliquity"]), cat["mu"] + gm[naif])
        lam = float((el["node"][0] + el["peri"][0] + el["M"][0]) % 360.0)
        rr = sm.rotate_icrf_to_ecliptic(r, cat["obliquity"])[0]
        out[name] = {"et": et, "meanLongitudeDeg": lam, "eclipticLongitudeDeg": float(math.degrees(math.atan2(rr[1], rr[0])) % 360.0)}
    return out


# ---------------------------------------------------------------------------------------------- angles
def _mean_longitude(cat: dict, m: np.ndarray) -> np.ndarray:
    return (cat["node"][m] + cat["peri"][m] + cat["M"][m]) % 360.0


def angle_templates(cat: dict, masks: dict, lam_j: float, hlim_of: dict) -> dict:
    """Sorted resonant-angle templates from the complete (H < H_lim) catalogue: Trojans lambda - lambda_J, Hildas
    sigma = 3 lambda_J - 2 lambda - varpi."""
    out = {}
    for pop in ("trojan", "hilda"):
        m = masks[pop] & (cat["H"] < hlim_of[pop](cat["a"]))
        lam = _mean_longitude(cat, m)
        varpi = (cat["node"][m] + cat["peri"][m]) % 360.0
        if pop == "trojan":
            x = (lam - lam_j + 180.0) % 360.0 - 180.0
        else:
            x = (3.0 * lam_j - 2.0 * lam - varpi + 180.0) % 360.0 - 180.0
        out[pop] = np.sort(x)
    return out


def assign_angles(kind: str, u: np.ndarray, lam_j: float, tpl: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(node, peri, M) in degrees from the candidate's angle uniforms u[:, 0:4]."""
    node = 360.0 * u[:, 0]
    if kind == "uniform":
        return node, 360.0 * u[:, 1], 360.0 * u[:, 2]
    varpi = 360.0 * u[:, 1]
    t = tpl[kind]
    x = t[np.minimum((u[:, 2] * t.size).astype(np.int64), t.size - 1)]
    if kind == "trojan":
        lam = lam_j + x
    else:   # sigma = 3 lambda_J - 2 lambda - varpi, both solutions lambda and lambda + 180
        lam = 0.5 * (3.0 * lam_j - varpi - x) + 180.0 * np.floor(2.0 * u[:, 3])
    return node, (varpi - node) % 360.0, (lam - varpi) % 360.0


# ---------------------------------------------------------------------------------------------- attributes
def attribute_pools(cat: dict, masks: dict, p: dict) -> tuple[dict, sm.QuantilePool, dict]:
    ph, P = cat["physHeader"], cat["phys"]
    lab = LABEL_CODE
    row = P["row"].astype(np.int64)
    meas = (P["albedoLabel"] == lab["measured"]) & np.isfinite(P["albedo"]) & (P["albedo"] > 0)
    pools, info = {}, {}
    for pop, grid in GRIDS.items():
        m = meas & masks[pop][row]
        r = row[m]
        ia, _, _, _ = grid.index(cat["a"][r], np.zeros(r.size), np.zeros(r.size), np.zeros(r.size))
        pools[pop] = sm.make_pool(np.where(ia < 0, 0, ia), P["albedo"][m].astype(np.float64),
                                  cat["colorClass"][r].astype(np.int64), r, grid.n_a,
                                  min(p["minTemplates"]["albedo"], int(m.sum())))
        info[pop] = {"templates": int(m.sum()), "maxWidenedABins": int(pools[pop].widened.max())}
    # rotation: LCDB periods of quality U >= 2- (physical rotLabel measured), binned by log10 D
    codes = ph.get("lcdbU", [])
    umin = codes.index("2-") if "2-" in codes else 0
    rm = (P["rotLabel"] == lab["measured"]) & np.isfinite(P["rotPeriod"]) & (P["rotPeriod"] > 0) & (P["rotQuality"] >= umin)
    D = np.where((P["diameterLabel"] <= lab["derived"]) & np.isfinite(P["diameter"]), P["diameter"].astype(np.float64),
                 cat["diameterFromH"][row])
    rm &= np.isfinite(D) & (D > 0)
    b = np.clip(np.floor((np.log10(D[rm]) + 2.0) / 0.2).astype(np.int64), 0, ROT_BINS - 1)
    rot = sm.make_pool(b, P["rotPeriod"][rm].astype(np.float64), row[rm], row[rm], ROT_BINS, p["minTemplates"]["rotation"])
    info["rotation"] = {"templates": int(rm.sum()), "qualityMin": codes[umin] if codes else None,
                        "log10DBins": [-2.0, 0.2, ROT_BINS], "maxWidenedBins": int(rot.widened.max())}
    return pools, rot, info


ROT_BINS = 26


def attributes(pop: str, a: np.ndarray, H: np.ndarray, u_pv: np.ndarray, u_rot: np.ndarray, pools: dict,
               rot: sm.QuantilePool) -> dict[str, np.ndarray]:
    grid = GRIDS[pop]
    ia, _, _, _ = grid.index(a, np.zeros(a.size), np.zeros(a.size), np.zeros(a.size))
    pv, cc = pools[pop].draw(np.where(ia < 0, 0, ia), u_pv)
    D = sm.diameter_km(H, pv)
    b = np.clip(np.floor((np.log10(D) + 2.0) / 0.2).astype(np.int64), 0, ROT_BINS - 1)
    per, _ = rot.draw(b, u_rot)
    return {"pV": pv, "colorClass": cc, "diameter": D, "rotPeriod": per}


# ---------------------------------------------------------------------------------------------- populations
def build(cat: dict, p: dict | None = None, *, only: tuple[str, ...] | None = None, granvik: np.ndarray | None = None,
          l7: tuple | None = None) -> dict:
    """Every population (or `only` some): cells, objects and diagnostics. Pure given its inputs (tests call it on
    modified catalogues)."""
    p = p or params()
    tab = ss.tables()
    floors = _floors(tab, p)
    seed = p["seed"]
    masks = population_masks(cat)
    epoch = cat["header"]["epochEt"]
    sfd = tab["sfd"]
    pops = only or tuple(POP_CODES)
    res: dict = {"floors": floors, "seed": seed, "populations": {}}
    fits: dict = {}
    hlim_of: dict = {}
    for pop in ("hungaria", "mainbelt", "hilda", "trojan"):
        m = masks[pop]
        lo, hi = FIT_RANGE[pop]
        fits[pop] = sm.fit_hlim(cat["a"][m], cat["H"][m], lo, hi)
        if pop in p.get("completenessC", {}):     # pinned (reproduce a limit, or isolate the yield rule in tests)
            fits[pop] = {**fits[pop], "fittedC": fits[pop]["C"], "C": float(p["completenessC"][pop]), "pinned": True}
        C = fits[pop]["C"]
        hlim_of[pop] = (lambda C: (lambda a: sm.hlim_model(np.clip(a, 1.0001, None), C)))(C)
    need_angles = any(x in pops for x in ("trojan", "hilda"))
    lon = planet_longitudes(cat, epoch, l7[0]["epochJd"] if l7 else ss.read_l7()[0]["epochJd"]) if (need_angles or "tno" in pops) else None
    tpl = angle_templates(cat, masks, lon["jupiter"]["meanLongitudeDeg"], hlim_of) if need_angles else {}
    pools, rot, pool_info = attribute_pools(cat, masks, p)
    res["attributePools"] = pool_info
    res["planets"] = lon
    for pop in pops:
        grid = GRIDS[pop]
        known = _known(cat, masks[pop])
        t0 = time.time()
        if pop in ANGLES:
            model_id = {"hungaria": "catalogue+hendler-malhotra-2020+maeda-2021-hsc",
                        "mainbelt": "catalogue+hendler-malhotra-2020+maeda-2021-hsc",
                        "hilda": "catalogue+hendler-malhotra-2020+terai-yoshida-2018-hsc",
                        "trojan": "catalogue+hendler-malhotra-2020+yoshida-terai-2017-hsc"}[pop]
            ac = 0.5 * (np.asarray(grid.a_edges[:-1]) + np.asarray(grid.a_edges[1:]))
            hlim_a = hlim_of[pop](ac)
            if pop in ("hungaria", "mainbelt"):
                mb = sfd["mainBelt"]
                ia, _, _, _ = grid.index(known.a, known.e, known.i, known.H)
                ok = ia >= 0
                bright, sinfo = sm.local_slopes(ia[ok], known.H[ok], hlim_a, grid.n_a, fallback=mb["alpha2"])
                slope = sm.SlopeLaw(mb["alpha2"], mb["HbreakR"] + mb["vMinusR"], bright)
                slope_info = {"alphaFaint": mb["alpha2"], "hBreakV": mb["HbreakR"] + mb["vMinusR"],
                              "alphaBrightFromCatalogue": sinfo, "source": mb["source"]}
            else:
                s = sfd["hildas" if pop == "hilda" else "jupiterTrojans"]
                slope = sm.SlopeLaw(s["alpha"])
                slope_info = {"alpha": s["alpha"], "alphaSigma": s["alphaSigma"], "source": s["source"]}
            cells, gobs, diag = sm.extrapolated_cells(grid, known, hlim_a, slope, floors[pop])
            tot = sm.condition(cells, gobs)
            prefix = f"{sm.ALGORITHM}|{seed}|{model_id}"
            objs = sm.sample_extrapolated(grid, cells, slope, Q_MIN_AU, prefix)
            node, peri, M = assign_angles(ANGLES[pop], objs["u"], lon["jupiter"]["meanLongitudeDeg"] if lon else 0.0, tpl)
            el = {"a": objs["a"], "e": objs["e"], "i": objs["i"], "node": node, "peri": peri, "M": M, "H": objs["H"]}
            limit = {"method": "hendler-malhotra-2020", "fit": fits[pop], "hLimPerABin": [round(float(x), 4) for x in hlim_a]}
            hlim_exact = np.asarray(hlim_a, dtype=np.float64)
            extra = {"slope": slope_info, "angles": ANGLES[pop], "referenceBin": "[H_lim - 1, H_lim - 0.5)",
                     "referenceCounts": diag["referenceCounts"]}
        else:
            if pop == "neo":
                G = granvik if granvik is not None else ss.read_granvik()
                members = sm.Known(G[:, 0], G[:, 1], G[:, 2], G[:, 6])
                model_id = ss.GRANVIK.id
                ang = G[:, 3:6]
                extra = {"members": int(G.shape[0]), "hRange": [17.0, 25.0]}
            else:
                hdr, L, comp = l7 if l7 is not None else ss.read_l7()
                kb = tab["kuiperBeltColour"]
                v_minus_g = -(kb["transformation"]["k"] * kb["gMinusR"] - kb["transformation"]["c"])
                Hv = L[:, 6] + v_minus_g
                members = sm.Known(L[:, 0], L[:, 1], L[:, 2], Hv)
                model_id = ss.L7.id
                t_l7 = (hdr["epochJd"] - J2000_JD) * DAY
                n_deg = np.degrees(np.sqrt(cat["mu"] / (L[:, 0] * AU_KM) ** 3)) * (epoch - t_l7)
                ang = np.stack([L[:, 3], L[:, 4], (L[:, 5] + n_deg) % 360.0], axis=1)
                lam_n = lon["neptune"]
                extra = {"members": int(L.shape[0]), "vMinusG": round(v_minus_g, 4),
                         "components": dict(Counter(comp.tolist()).most_common()),
                         "epochJd": hdr["epochJd"], "lambdaNFileRad": hdr["lambdaN"],
                         "lambdaNFileDeg": round(math.degrees(hdr["lambdaN"]) % 360.0, 3),
                         "neptuneFromDE442s": lam_n,
                         "propagation": "mean anomaly advanced two-body (GM_sun) from the model epoch to epochEt"}
                dl = abs((math.degrees(hdr["lambdaN"]) - lam_n["meanLongitudeDeg"] + 180.0) % 360.0 - 180.0)
                if dl > 2.0:
                    raise ValueError(f"L7 lambdaN {hdr['lambdaN']} rad differs from Neptune's mean longitude by {dl:.2f} deg")
                extra["lambdaNDifferenceDeg"] = round(dl, 3)
            cells, gobs, lists, diag = sm.realization_cells(grid, known, members, floors[pop])
            tot = sm.condition(cells, gobs)
            prefix = f"{sm.ALGORITHM}|{seed}|{model_id}"
            objs = sm.sample_realization(grid, cells, lists, prefix)
            mi = objs["member"]
            el = {"a": members.a[mi], "e": members.e[mi], "i": members.i[mi], "node": ang[mi, 0], "peri": ang[mi, 1],
                  "M": ang[mi, 2], "H": members.H[mi]}
            limit = {"method": "model-comparison", "rule": diag["limitRule"], "hLimPerABin": diag["hlimPerABin"]}
            hlim_exact = np.array([np.inf if x is None else x for x in diag["hlimPerABin"]], dtype=np.float64)
        attrs = attributes(pop, el["a"], el["H"], objs["u_pv"], objs["u_rot"], pools, rot)
        res["populations"][pop] = {
            "code": POP_CODES[pop], "modelId": model_id, "grid": grid, "cells": cells, "objects": {**el, **attrs},
            "cellOf": objs["cell"], "k": objs["k"], "limit": limit, "extra": extra, "totals": tot,
            "hFloor": floors[pop], "prefix": prefix, "seconds": round(time.time() - t0, 1),
            "knownInGrid": int(known.a.size), "hlim": hlim_exact,
            "distribution": _distribution(grid, known, hlim_exact, floors[pop], cells, objs["cell"], el["H"],
                                          members if pop not in ANGLES else None),
        }
    return res


# ---------------------------------------------------------------------------------------------- stage
def run(ctx: BuildContext) -> None:
    t_stage = time.time()
    src = ss.register(ctx)
    p = params(ctx.param("synthetic.params"))
    cat = load_catalogue()
    res = build(cat, p)
    core_hdr = cat["header"]
    cat_sources = core_hdr.get("sourceTable", [])
    # ---- tables
    cell_cols = {k: [] for k in ("pop", "ia", "ie", "ii", "ih", "aLo", "aHi", "eLo", "eHi", "iLo", "iHi", "hLo", "hHi",
                                  "hLim", "nModel", "nObs", "rawDeficit", "deficit", "u0", "nShown", "first")}
    obj_cols = {k: [] for k in ("a", "e", "i", "node", "peri", "M", "H", "pV", "rotPeriod", "cell", "k", "pop",
                                "colorClass")}
    pops_hdr = []
    first_obj = 0
    first_cell = 0
    for pop, r in res["populations"].items():
        c, g, o = r["cells"], r["grid"], r["objects"]
        a_lo, a_hi = g.a_bounds(c.ia)
        n_obj = int(c.n_shown.sum())
        firsts = first_obj + np.concatenate([[0], np.cumsum(c.n_shown)[:-1]]) if c.n else np.zeros(0, np.int64)
        hl = r["hlim"][c.ia]
        for k, v in (("pop", np.full(c.n, r["code"])), ("ia", c.ia), ("ie", c.ie), ("ii", c.ii), ("ih", c.ih),
                     ("aLo", a_lo), ("aHi", a_hi), ("eLo", c.ie * g.e_width), ("eHi", (c.ie + 1) * g.e_width),
                     ("iLo", c.ii * g.i_width), ("iHi", (c.ii + 1) * g.i_width), ("hLo", c.h_lo), ("hHi", c.h_hi),
                     ("hLim", hl), ("nModel", c.n_model), ("nObs", c.n_obs), ("rawDeficit", c.raw),
                     ("deficit", c.deficit), ("u0", c.u0), ("nShown", c.n_shown), ("first", firsts)):
            cell_cols[k].append(np.asarray(v))
        # objects: cell order (sample functions emit cells in order), k ascending within a cell
        order = np.lexsort((r["k"], r["cellOf"]))
        for k in ("a", "e", "i", "node", "peri", "M", "H", "pV", "rotPeriod"):
            obj_cols[k].append(np.asarray(o[k])[order])
        obj_cols["cell"].append(first_cell + r["cellOf"][order])
        obj_cols["k"].append(r["k"][order])
        obj_cols["pop"].append(np.full(n_obj, r["code"]))
        obj_cols["colorClass"].append(np.asarray(o["colorClass"])[order])
        pops_hdr.append(_pop_header(pop, r, src, first_cell, first_obj))
        first_obj += n_obj
        first_cell += c.n
    cells = {k: np.concatenate(v) for k, v in cell_cols.items()}
    objs = {k: np.concatenate(v) for k, v in obj_cols.items()}
    if not np.all(objs["H"].astype(np.float32) >= cells["hLim"][objs["cell"]].astype(np.float32)):
        raise AssertionError("a synthetic object is brighter than its cell's completeness limit")
    n_obj, n_cell = int(objs["a"].size), int(cells["pop"].size)
    common = {
        "algorithm": sm.ALGORITHM, "seed": res["seed"], "epochEt": core_hdr["epochEt"],
        "epochTdb": core_hdr.get("epochTdb"),
        "catalogue": {"product": "smallbodies/core.bin", "snapshot": core_hdr.get("snapshot"),
                      "coreSha256": cat["coreSha256"], "physicalSha256": cat["physSha256"],
                      "sources": [s for s in cat_sources if s.startswith("jpl-sbdb")]},
        "populations": pops_hdr,
        "labels": "Every attribute of a synthetic object is `synthetic` (source: its population's model, the "
                  "completeness method, the catalogue snapshot, and the measured templates of its attributes). "
                  "Real objects are unchanged by this stage (their `estimated` values stay population statistics "
                  "applied to a real object).",
        "seedRule": "cell stream: PCG64 seeded with the first 16 bytes (little-endian integer) of sha256('<algorithm>|<seed>|"
                    "<population modelId>|ia|ie|ii|ih'), split as [low 64 bits, high 64 bits, 0] (salt 1 for the "
                    "attribute stream of model-realization populations); u0 = first 8 bytes of sha256(same string + "
                    "'|round') / 2^64",
        "yieldRule": "shown = the first floor(deficit + u0) candidates of the cell's stream that pass its current "
                     "limits; a larger catalogue lowers the deficit and truncates the list from its end",
        "frame": "heliocentric osculating elements, ecliptic and equinox J2000 (IAU 1976 obliquity to ICRF), at epochEt",
        "gmSun": cat["mu"], "obliquityArcsec": core_hdr["forceModel"]["obliquityArcsec"], "auKm": AU_KM,
        "slopeParameterG": {"value": SLOPE_G, "source": "bowell-1989",
                            "method": "The conventional slope parameter of the H-G law (Bowell et al. 1989), the value "
                                      "the catalogue uses where no G is fitted; every synthetic object gets it."},
        "attributePools": res["attributePools"],
        "colorClasses": "smallbodies/core.json colorClasses (the same indices)",
        "params": p, "floors": res["floors"],
    }
    lab = "synthetic"
    ofields = [
        Field("a", "f32", 1, {"unit": "au", "label": lab}), Field("e", "f32", 1, {"label": lab}),
        Field("i", "f32", 1, {"unit": "deg", "label": lab}), Field("node", "f32", 1, {"unit": "deg", "label": lab}),
        Field("peri", "f32", 1, {"unit": "deg", "label": lab, "method": "argument of perihelion"}),
        Field("M", "f32", 1, {"unit": "deg", "label": lab, "method": "mean anomaly at epochEt"}),
        Field("H", "f32", 1, {"unit": "mag", "label": lab, "method": "V-band absolute magnitude; G = 0.15 (Bowell et al. 1989 conventional value)"}),
        Field("pV", "f32", 1, {"label": lab, "method": "quantile draw from the measured albedos of real objects of the same population near the same a (attributePools)"}),
        Field("rotPeriod", "f32", 1, {"unit": "h", "label": lab, "method": "quantile draw from LCDB periods (U >= 2-) of real objects of similar diameter D = 1329 km / sqrt(pV) 10^(-H/5)"}),
        Field("cell", "u32", 1, {"method": "row in synthetic/cells.bin"}),
        Field("k", "u32", 1, {"method": "candidate number in the cell's stream (0-based; valid candidates only for model realizations, raw stream index for catalogue-extrapolated populations)"}),
        Field("pop", "u8", 1, {"method": "population code (header populations[].code)"}),
        Field("colorClass", "u8", 1, {"label": lab, "method": "index into smallbodies/core.json colorClasses: the class of the albedo template"}),
    ]
    write_table(ctx, f"{DIR}/objects", ofields, {k: objs[k].astype(np.float32) if k in ("a", "e", "i", "node", "peri", "M", "H", "pV", "rotPeriod") else objs[k] for k in objs},
                n_obj, STAGE, source_table=sorted({s for ph in pops_hdr for s in ph["sources"]}),
                extra={**common, "cells": f"{DIR}/cells.json", "counts": {"synthetic": n_obj, "cells": n_cell}},
                notes="Synthetic small bodies: objects that no survey has found yet, standing in for the undiscovered "
                      "members of each (a, e, i, H) cell (the COMPLETE reality level). Not real objects: every value is "
                      "labelled synthetic.")
    cfields = [Field("pop", "u8"), Field("ia", "u16"), Field("ie", "u16"), Field("ii", "u16"), Field("ih", "i32"),
               Field("aLo", "f32", 1, {"unit": "au"}), Field("aHi", "f32", 1, {"unit": "au"}), Field("eLo", "f32"),
               Field("eHi", "f32"), Field("iLo", "f32", 1, {"unit": "deg"}), Field("iHi", "f32", 1, {"unit": "deg"}),
               Field("hLo", "f32", 1, {"unit": "mag", "method": "conditioned H range [hLo, hHi): the cell's H bin above its limit"}),
               Field("hHi", "f32", 1, {"unit": "mag"}),
               Field("hLim", "f32", 1, {"unit": "mag", "method": "completeness limit of the cell's a-bin"}),
               Field("nModel", "f32", 1, {"method": "expected number of objects in the conditioned range (model)"}),
               Field("nObs", "u32", 1, {"method": "catalogued objects in the conditioned range"}),
               Field("rawDeficit", "f32", 1, {"method": "max(0, nModel - nObs)"}),
               Field("deficit", "f32", 1, {"method": "rawDeficit scaled so each (ia, ih) group totals max(0, model - known)"}),
               Field("u0", "f32", 1, {"method": "rounding offset from the cell seed"}),
               Field("nShown", "u32", 1, {"method": "floor(deficit + u0)"}), Field("first", "u32", 1, {"method": "first object row in objects.bin"})]
    write_table(ctx, f"{DIR}/cells", cfields, {k: v.astype(np.float32) if k in ("aLo", "aHi", "eLo", "eHi", "iLo", "iHi", "hLo", "hHi", "hLim", "nModel", "rawDeficit", "deficit", "u0") else v for k, v in cells.items()},
                n_cell, STAGE, extra={**{k: common[k] for k in ("algorithm", "seed", "epochEt", "catalogue", "seedRule", "yieldRule")},
                                      "populations": [{k: ph[k] for k in ("name", "code", "modelId", "firstCell", "cells", "grid")} for ph in pops_hdr]},
                notes="Cells of the synthetic populations (see synthetic/objects.json).")
    report = verification(res, cells, objs)
    report.update({"generated": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
                   "seconds": round(time.time() - t_stage, 1), "counts": {"synthetic": n_obj, "cells": n_cell},
                   "products": {k: v for k, v in ctx.products.items() if v["stage"] == STAGE}})
    if ctx.param("build.writeRepoFiles"):
        REPORT.write_text(json.dumps(report, indent=1, allow_nan=False), encoding="utf-8", newline="\n")
        FIGURE.write_text(distribution_svg(report), encoding="utf-8", newline="\n")
        diagnostic_png(cat, res, DIAGNOSTIC)
    else:
        print(f"[synthetic] {REPORT.name} and its figures not rewritten (build.writeRepoFiles is off)")
    per_pop = ", ".join(f"{k} {int(v['cells'].n_shown.sum())}" for k, v in res["populations"].items())
    print(f"[synthetic] {n_obj} synthetic objects in {n_cell} cells ({per_pop}); {time.time() - t_stage:.0f} s")


def _pop_header(pop: str, r: dict, src: dict, first_cell: int, first_obj: int) -> dict:
    srcs = {"neo": [ss.GRANVIK.id], "tno": [ss.L7.id, ss.PETIT.id, ss.JESTER.id]}.get(pop, [])
    if pop in ANGLES:
        srcs = ["jpl-sbdb-orbits", ss.HENDLER_MALHOTRA.id,
                {"hungaria": ss.MAEDA.id, "mainbelt": ss.MAEDA.id, "hilda": ss.TERAI_YOSHIDA.id,
                 "trojan": ss.YOSHIDA_TERAI.id}[pop]]
    else:
        srcs = srcs + ["jpl-sbdb-orbits"]
    srcs += ["neowise-v2", "jpl-sbdb-physical", "lcdb-2023-10", "smallbody-class-colors", "bowell-1989"]
    c = r["cells"]
    t = r["totals"]
    return {
        "name": pop, "code": r["code"], "modelId": r["modelId"], "sources": srcs, "prefix": r["prefix"],
        "grid": r["grid"].to_json(), "hFloor": r["hFloor"], "limit": r["limit"], "model": r["extra"],
        "firstCell": first_cell, "cells": c.n, "firstObject": first_obj, "objects": int(c.n_shown.sum()),
        "knownInGrid": r["knownInGrid"], "totals": {**t, "shown": int(c.n_shown.sum())}, "seconds": r["seconds"],
    }


def _distribution(grid: sm.Grid, known: sm.Known, hlim_a: np.ndarray, h_floor: float, cells: sm.Cells,
                  cell_of: np.ndarray, H_syn: np.ndarray, members: sm.Known | None) -> dict:
    """Whole-population H distribution in H_BIN bins (inside the grid, H < floor): the debiased model (catalogue-
    extrapolated populations: the catalogue brighter than each a-bin's limit + the model cells; model populations:
    the realization), the catalogue, and the synthetic objects shown."""
    ia, ie, ii, ih = grid.index(known.a, known.e, known.i, known.H)
    ok = (ia >= 0) & (known.H < h_floor)
    if members is not None:     # compare inside the model's H range only (e.g. the NEO model starts at H = 17)
        ok &= known.H >= np.floor(np.min(members.H) / grid.h_width) * grid.h_width
    kh = ih[ok]
    lo = int(min(kh.min() if kh.size else 0, cells.ih.min() if cells.n else 0))
    hi = int(max(kh.max() if kh.size else 0, cells.ih.max() if cells.n else 0))
    nb = hi - lo + 1
    known_n = np.bincount(kh - lo, minlength=nb).astype(np.float64)
    if members is None:
        comp = ok & (known.H < hlim_a[np.maximum(ia, 0)])
        model = np.bincount(ih[comp] - lo, minlength=nb).astype(np.float64)
        model += np.bincount(cells.ih - lo, weights=cells.n_model, minlength=nb)
    else:
        mia, _, _, mih = grid.index(members.a, members.e, members.i, members.H)
        mok = (mia >= 0) & (members.H < h_floor) & (mih >= lo) & (mih <= hi)
        model = np.bincount(mih[mok] - lo, minlength=nb).astype(np.float64)
    syn = np.bincount(np.floor(H_syn / grid.h_width).astype(np.int64) - lo, minlength=nb).astype(np.float64)
    return {"hLo": [round((lo + k) * grid.h_width, 2) for k in range(nb)], "model": model.round(2).tolist(),
            "known": known_n.astype(int).tolist(), "synthetic": syn[:nb].astype(int).tolist()}


def diagnostic_png(cat: dict, res: dict, path: Path) -> None:
    """DIAGNOSTIC figure (a data plot, not a rendering): catalogued objects in cyan, synthetic objects in orange.
    Left: positions at the epoch seen from the ecliptic north pole (|x|, |y| < 6 au), log density. Right: the a-H
    plane (1.6-5.6 au) with the completeness limit of every a-bin (white): synthetic objects lie only fainter."""
    from PIL import Image, ImageDraw

    def xy(a, e, i, node, peri, M):
        x, _ = sm.elements_to_icrf(a, e, i, node, peri, M, cat["mu"], AU_KM, 0.0)
        return x[:, 0] / AU_KM, x[:, 1] / AU_KM

    masks = population_masks(cat)
    kn = cat["ok"] & (cat["e"] < 1)
    kx, ky = xy(cat["a"][kn], cat["e"][kn], cat["i"][kn], cat["node"][kn], cat["peri"][kn], cat["M"][kn])
    so = [r["objects"] for r in res["populations"].values()]
    cat_syn = {k: np.concatenate([o[k] for o in so]) for k in ("a", "e", "i", "node", "peri", "M", "H")}
    sx, sy = xy(cat_syn["a"], cat_syn["e"], cat_syn["i"], cat_syn["node"], cat_syn["peri"], cat_syn["M"])

    def layer(h):
        v = np.log1p(h)
        return v / max(np.percentile(v[v > 0], 99.5) if np.any(v > 0) else 1.0, 1e-9)

    def rgb(hk, hs):
        k, t = np.clip(layer(hk), 0, 1), np.clip(layer(hs), 0, 1)
        img = np.stack([0.30 * k + 1.00 * t, 0.80 * k + 0.50 * t, 1.00 * k + 0.08 * t], axis=-1)
        return (np.clip(img, 0, 1) * 255).astype(np.uint8)

    N = 900
    ext = 6.0
    hk, _, _ = np.histogram2d(ky, kx, bins=N, range=[[-ext, ext], [-ext, ext]])
    hs, _, _ = np.histogram2d(sy, sx, bins=N, range=[[-ext, ext], [-ext, ext]])
    left = Image.fromarray(rgb(hk[::-1], hs[::-1]))
    A0, A1, H0, H1, W2 = 1.6, 5.6, 8.0, 20.6, 900
    ka, kH = cat["a"][kn], cat["H"][kn]
    hk2, _, _ = np.histogram2d(kH, ka, bins=[N, W2], range=[[H0, H1], [A0, A1]])
    hs2, _, _ = np.histogram2d(cat_syn["H"], cat_syn["a"], bins=[N, W2], range=[[H0, H1], [A0, A1]])
    right = Image.fromarray(rgb(hk2, hs2))
    d2 = ImageDraw.Draw(right)
    for pop, r in res["populations"].items():
        if pop not in ANGLES:
            continue
        ed = np.asarray(r["grid"].a_edges)
        for k, hl in enumerate(r["hlim"]):
            if not np.isfinite(hl):
                continue
            x0 = (ed[k] - A0) / (A1 - A0) * W2
            x1 = (ed[k + 1] - A0) / (A1 - A0) * W2
            y = (hl - H0) / (H1 - H0) * N
            d2.line([(x0, y), (x1, y)], fill=(255, 255, 255), width=2)
    img = Image.new("RGB", (2 * N + 30, N + 70), (0, 0, 0))
    img.paste(left, (0, 40))
    img.paste(right, (N + 30, 40))
    d = ImageDraw.Draw(img)
    d.text((8, 8), "DIAGNOSTIC (a data plot, not a rendering): catalogued objects cyan, synthetic objects orange, log density", fill=(230, 230, 230))
    d.text((8, 22), "Left: positions at the small-body epoch seen from ecliptic north, 12 x 12 au around the Sun", fill=(180, 180, 180))
    d.text((N + 38, 22), f"Right: a {A0}-{A1} au (x) vs H {H0}-{H1} (y, fainter down); white: completeness limit per a-bin", fill=(180, 180, 180))
    for h in range(9, 21):
        y = 40 + (h - H0) / (H1 - H0) * N
        d.text((N + 32, y - 5), f"{h}", fill=(150, 150, 150))
    for a in (2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5):
        x = N + 30 + (a - A0) / (A1 - A0) * W2
        d.text((x - 8, N + 44), f"{a}", fill=(150, 150, 150))
    n_known, n_syn = int(kn.sum()), int(cat_syn["a"].size)
    d.text((8, N + 50), f"catalogue {n_known:,} objects, synthetic {n_syn:,} (pipeline stage synthetic)", fill=(180, 180, 180))
    path.parent.mkdir(parents=True, exist_ok=True)
    img.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(path, optimize=True)


def distribution_svg(report: dict) -> str:
    """Cumulative H distributions per population (log N(<H)): the debiased model, the catalogue, catalogue +
    synthetic. Plain SVG (no plotting library in the pipeline)."""
    names = {"neo": "NEOs (Granvik et al. 2018 model)", "hungaria": "Hungarias", "mainbelt": "Main belt",
             "hilda": "Hildas", "trojan": "Jupiter Trojans", "tno": "Trans-Neptunian (CFEPS L7 model)"}
    W, H, PW, PH, ML, MB, MT = 1140, 640, 380, 320, 52, 34, 26
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
           'font-family="sans-serif" font-size="11">', f'<rect width="{W}" height="{H}" fill="white"/>']
    for k, (pop, r) in enumerate(report["populations"].items()):
        d = r["wholePopulation"]
        x0, y0 = (k % 3) * PW, (k // 3) * PH
        hx = [h + 0.5 for h in d["hLo"]]
        series = [("model", d["cumulativeModel"], "#222", "5,3", 1.6), ("catalogue", d["cumulativeKnown"], "#888", "", 1.4),
                  ("catalogue + synthetic", d["cumulativeKnownPlusSynthetic"], "#d95f02", "", 1.6)]
        top = max(max(v) for _, v, *_ in series)
        ymax = math.ceil(math.log10(max(top, 10)))
        xmin, xmax = min(hx) - 0.5, max(hx)
        pw, ph = PW - ML - 14, PH - MB - MT - 8
        X = lambda h: x0 + ML + (h - xmin) / (xmax - xmin) * pw
        Y = lambda n: y0 + MT + ph - (math.log10(max(n, 1)) / ymax) * ph
        out.append(f'<text x="{x0 + ML}" y="{y0 + 16}" font-weight="bold">{names.get(pop, pop)}</text>')
        out.append(f'<rect x="{x0 + ML}" y="{y0 + MT}" width="{pw}" height="{ph}" fill="none" stroke="#bbb"/>')
        for e in range(0, ymax + 1):
            yy = Y(10 ** e)
            out.append(f'<line x1="{x0 + ML}" x2="{x0 + ML + pw}" y1="{yy:.1f}" y2="{yy:.1f}" stroke="#eee"/>')
            out.append(f'<text x="{x0 + ML - 4}" y="{yy + 4:.1f}" text-anchor="end">1e{e}</text>')
        step = 2 if xmax - xmin > 8 else 1
        for h in range(math.ceil(xmin), math.floor(xmax) + 1, step):
            out.append(f'<text x="{X(h):.1f}" y="{y0 + MT + ph + 14}" text-anchor="middle">{h}</text>')
        out.append(f'<text x="{x0 + ML + pw / 2}" y="{y0 + MT + ph + 28}" text-anchor="middle">H (V mag)</text>')
        for j, (lab, v, col, dash, wdt) in enumerate(series):
            pts = " ".join(f"{X(h):.1f},{Y(n):.1f}" for h, n in zip(hx, v) if n > 0)
            out.append(f'<polyline points="{pts}" fill="none" stroke="{col}" stroke-width="{wdt}"'
                       + (f' stroke-dasharray="{dash}"' if dash else "") + "/>")
            ly = y0 + MT + 14 + 14 * j
            out.append(f'<line x1="{x0 + ML + 8}" x2="{x0 + ML + 30}" y1="{ly - 4}" y2="{ly - 4}" stroke="{col}" '
                       f'stroke-width="{wdt}"' + (f' stroke-dasharray="{dash}"' if dash else "") + "/>")
            out.append(f'<text x="{x0 + ML + 34}" y="{ly}">{lab} (total to the floor: {v[-1]:,.0f})</text>')
    out.append(f'<text x="8" y="{H - 6}" fill="#555">Cumulative number N(&lt;H) inside each population\'s grid, below its '
               "H floor. Synthetic objects appear only fainter than the completeness limit of their a-bin. "
               "(pipeline stage synthetic; numbers in docs/reports/synthetic-populations.json)</text>")
    out.append("</svg>")
    return "\n".join(out)


def verification(res: dict, cells: dict, objs: dict) -> dict:
    """Per population and H bin: model, known and synthetic counts in the conditioned ranges (known + synthetic vs the
    debiased model), the completeness guard, and the parameters."""
    out: dict = {"populations": {}}
    for pop, r in res["populations"].items():
        c = r["cells"]
        hb = c.ih
        rows = []
        for h in np.unique(hb):
            m = hb == h
            rows.append({"hLo": float(h * 0.5), "model": round(float(c.n_model[m].sum()), 2),
                         "known": int(c.n_obs[m].sum()), "synthetic": int(c.n_shown[m].sum()),
                         "deficit": round(float(c.deficit[m].sum()), 2)})
        cm = np.cumsum([x["model"] for x in rows])
        ck = np.cumsum([x["known"] + x["synthetic"] for x in rows])
        o = objs["pop"] == r["code"]
        guard = int(np.sum(objs["H"][o] < cells["hLim"][objs["cell"][o]] - 1e-6))
        d = r["distribution"]
        dm = np.cumsum(d["model"])
        dk = np.cumsum(np.add(d["known"], d["synthetic"]))
        big = dm >= 100
        out["populations"][pop] = {
            "hBins": rows, "cumulative": {"model": [round(float(x), 1) for x in cm], "knownPlusSynthetic": [int(x) for x in ck]},
            "maxCumulativeRelDiff": round(float(np.max(np.abs(ck - cm)[cm >= 100] / cm[cm >= 100])) if np.any(cm >= 100) else 0.0, 4),
            "wholePopulation": {**d, "cumulativeModel": [round(float(x), 1) for x in dm],
                                "cumulativeKnownPlusSynthetic": [int(x) for x in dk],
                                "cumulativeKnown": [int(x) for x in np.cumsum(d["known"])],
                                "maxCumulativeRelDiff": round(float(np.max(np.abs(dk - dm)[big] / dm[big])) if np.any(big) else 0.0, 4),
                                "note": "cumulative relative differences over H bins where the cumulative model holds at least 100 objects"},
            "brighterThanLimit": guard, "totals": r["totals"], "hFloor": r["hFloor"], "limit": {k: v for k, v in r["limit"].items() if k != "fit"} | ({"C": r["limit"]["fit"]["C"], "CSigma": r["limit"]["fit"]["CSigma"], "residualRmsMag": r["limit"]["fit"]["residualRmsMag"]} if "fit" in r["limit"] else {}),
        }
    out["planets"] = res.get("planets")
    out["attributePools"] = res.get("attributePools")
    return out
