"""Comets in the catalogue window: every comet's geocentric total magnitude, day by day, from the smallbodies
products (core states at epochEt, propagated with the stage's own force model, non-gravitational terms included)
and DE442s Earth, through the SBDB total-magnitude law m1 = M1 + 5 log10(Delta) + K1 log10(r).

The result (per comet: peak m1, its date, r, Delta and solar elongation there; the daily curve of the brightest) feeds
the `comets` stage: its report ("which comets are interesting in the window") and the app's list of comets whose
extended rendering is precomputed. A magnitude predicted with M1/K1 is estimated: comets depart from the law by 1-2
mag (and sungrazers or disintegrating comets by far more).
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from . import sb_model
from .ephem_kernels import planetary
from .ephem_spk import evaluate, read_spk
from .sb_table import read_table

DAY = 86400.0
AU_KM = sb_model.AU_KM


def load_comets(root: Path) -> dict:
    """Comet rows with a total-magnitude law and a known position: core state, M1/K1, non-grav, names."""
    hdr, core = read_table(root / "core.json")
    _, com = read_table(root / "comets.json")
    _, ng = read_table(root / "nongrav.json")
    flag = {v: int(k) for k, v in hdr["flagBits"].items()}
    names = (root / "names.txt").read_text(encoding="utf-8").split("\n")
    rows = com["row"].astype(np.int64)
    m1 = com["M1"].astype(np.float64)
    k1 = com["K1"].astype(np.float64)
    pos = core["pos"][rows].astype(np.float64)
    vel = core["vel"][rows].astype(np.float64)
    keep = np.isfinite(m1) & np.isfinite(k1) & np.all(np.isfinite(pos), axis=1) & np.all(np.isfinite(vel), axis=1)
    keep &= (core["flags"][rows] & flag["comet"]) != 0
    ngrow = {int(r): i for i, r in enumerate(ng["row"])}
    ngarr = np.zeros((rows.size, 9))
    has = np.zeros(rows.size, dtype=np.bool_)
    cols = ["A1", "A2", "A3", "DT", "ALN", "R0", "NM", "NN", "NK"]
    for i, r in enumerate(rows):
        j = ngrow.get(int(r))
        if j is None:
            ngarr[i, 4:] = [1.0, AU_KM, 2.0, 0.0, 0.0]  # g(r) = r^-2 placeholder never used (has = False)
            continue
        ngarr[i] = [float(ng[c][j]) for c in cols]
        has[i] = bool(np.any(ngarr[i, :3] != 0.0))
    sel = np.flatnonzero(keep)
    return {
        "header": hdr, "rows": rows[sel], "comRec": sel, "M1": m1[sel], "K1": k1[sel], "pos": pos[sel], "vel": vel[sel],
        "ng": ngarr[sel], "hasNg": has[sel], "names": [names[int(r)] if int(r) < len(names) else "" for r in rows[sel]],
        "totalLabel": com["totalLabel"][sel],
    }


def earth_sun(ets: np.ndarray) -> np.ndarray:
    """Earth's heliocentric ICRF position (km) at each et, DE442s: (3,0) + (399,3) - (10,0)."""
    spk = {(s.target, s.center): s for s in read_spk(planetary(None))}
    emb, _ = evaluate(spk[(3, 0)], ets)
    ea, _ = evaluate(spk[(399, 3)], ets)
    sun, _ = evaluate(spk[(10, 0)], ets)
    return emb + ea - sun


def magnitudes(M1: np.ndarray, K1: np.ndarray, helio: np.ndarray, earth: np.ndarray) -> tuple[np.ndarray, ...]:
    """m1, r (au), Delta (au), solar elongation (deg) for heliocentric comet positions (N, 3) seen from earth (3,)."""
    geo = helio - earth
    r = np.linalg.norm(helio, axis=1) / AU_KM
    d = np.linalg.norm(geo, axis=1) / AU_KM
    m = M1 + 5.0 * np.log10(d) + K1 * np.log10(r)
    re = np.linalg.norm(earth) / AU_KM
    cos_e = np.clip(np.einsum("ij,j->i", geo, -earth) / (d * AU_KM * re * AU_KM), -1.0, 1.0)
    return m, r, d, np.degrees(np.arccos(cos_e))


def window_curves(cat: dict, start_et: float, end_et: float, step_days: float = 1.0, ctx=None) -> dict:
    """Daily m1, r, Delta, elongation of every comet over [start_et, end_et] (propagated from the core epoch both
    ways with the smallbodies force model). Arrays (T, N); NaN where the propagation failed (collision etc.)."""
    epoch = float(cat["header"]["epochEt"])
    n = cat["M1"].size
    k0 = -int(math.floor((epoch - start_et) / (step_days * DAY)))
    k1 = int(math.floor((end_et - epoch) / (step_days * DAY)))
    ets = epoch + np.arange(k0, k1 + 1) * step_days * DAY
    model = sb_model.build(ctx, start_et - 10 * DAY, end_et + 10 * DAY, epoch)
    earth = earth_sun(ets)
    T = ets.size
    out = {k: np.full((T, n), np.nan) for k in ("m", "r", "d", "elong")}
    helio = np.full((T, n, 3), np.nan)
    i0 = -k0
    for direction in (+1, -1):
        s = np.concatenate([cat["pos"], cat["vel"]], axis=1).copy()
        t = np.full(n, epoch)
        alive = np.ones(n, dtype=np.bool_)
        steps = range(i0, T) if direction > 0 else range(i0 - 1, -1, -1)
        for i in steps:
            if i != i0:
                st, _ = sb_model.propagate(model, s, t, float(ets[i]), epoch, cat["ng"], cat["hasNg"])
                alive &= st == 0
                t[:] = ets[i]
            p = np.where(alive[:, None], s[:, :3], np.nan)
            helio[i] = p
            m, r, d, el = magnitudes(cat["M1"], cat["K1"], p, earth[i])
            out["m"][i], out["r"][i], out["d"][i], out["elong"][i] = m, r, d, el
    out["et"] = ets
    out["helio"] = helio
    out["earth"] = earth
    return out


def peaks(cat: dict, cur: dict) -> list[dict]:
    """Per comet: the brightest predicted m1 in the window and where it happens (sorted brightest first)."""
    m = cur["m"]
    res = []
    for j in range(m.shape[1]):
        col = m[:, j]
        if not np.any(np.isfinite(col)):
            continue
        i = int(np.nanargmin(col))
        rmin = int(np.nanargmin(cur["r"][:, j]))
        res.append({
            "index": j, "row": int(cat["rows"][j]), "name": cat["names"][j], "M1": float(cat["M1"][j]), "K1": float(cat["K1"][j]),
            "peakMag": float(col[i]), "peakEt": float(cur["et"][i]), "rAu": float(cur["r"][i, j]), "deltaAu": float(cur["d"][i, j]),
            "elongationDeg": float(cur["elong"][i, j]), "perihelionEt": float(cur["et"][rmin]), "qAu": float(cur["r"][rmin, j]),
        })
    res.sort(key=lambda x: x["peakMag"])
    return res
