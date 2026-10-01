"""Synthetic irregular moons and Centaurs (M6): their models, completeness limits and the Centaur realization.

Numbers come from syn_tables/populations.json ("irregularMoons", "centaurs"); the algorithm around them (cells, deficit,
streams, yield) is the one of syn_model and docs/reports/synthetic-populations.md. In short:

  irregular moons   per planet, the debiased luminosity function of the deepest characterised survey, shifted onto the
                    MPC H_V scale by an offset measured on the survey's own photometry of known moons (calibrate). The
                    completeness limit is the model-comparison rule of the model populations (moon_limit): the first
                    H bin, bright to faint, in which the known moons fall 2 sigma (Poisson) below the model. Below it,
                    each cell's model is the model's count in the H bin times the cell's share of the known moons
                    brighter than the limit (template_cells: the orbit distribution of the known moons, an assumption:
                    no debiased orbit model of irregular moons exists). Elements are planet-barycentric (ecliptic
                    J2000); a planet without a published population below its completeness limit gets no moons.
  Centaurs          one realization of the Kurlander et al. (2025) literature model (Nesvorny et al. 2019 orbits,
                    Lawler et al. 2018 H law, 21 400 with H_r < 13.7): the archive keeps only members with 21 < m <
                    23.5, so each member is weighted by 1/P(selected | its distance modulus) (Horvitz-Thompson), which
                    recovers the model's (a, e, i) distribution; H from the knee law, angles uniform (Murtagh et al.
                    2025). It is then conditioned on the catalogue like the NEO and Kuiper-belt realizations.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass

import numpy as np

from . import syn_model as sm

LN10 = math.log(10.0)


# ---------------------------------------------------------------------------------------------- irregular moons
def calibrate(moons: list, rows: list[dict]) -> dict:
    """Offset H_MPC - m of a survey's photometry of known moons: median over the moons found in the MPC list (by name,
    MPC number 'J59' or provisional designation), robust sigma 1.4826 MAD, its standard error 1.2533 sigma / sqrt(n)."""
    by = {}
    for r in rows:
        by[r["key"].lower()] = r
        if r["name"] and r["name"].lower() != "unnamed":
            by[r["name"].lower()] = r
    used, missing = [], []
    for name, m in moons:
        r = by.get(str(name).lower())
        (used if r else missing).append((name, m, r["H"] if r else None))
    if not used:
        raise ValueError("no calibrator found in the MPC list")
    off = np.array([h - m for _, m, h in used])
    med = float(np.median(off))
    sig = 1.4826 * float(np.median(np.abs(off - med)))
    return {"offset": round(med, 4), "robustSigma": round(sig, 4),
            "offsetSigma": round(1.2533 * sig / math.sqrt(len(used)), 4) if len(used) > 1 else None,
            "n": len(used), "used": [[n, m, h, round(h - m, 3)] for n, m, h in used],
            "notInMpcList": [n for n, _, _ in missing], "rule": "H_V = m + offset (median of H_MPC - m over the calibrators)"}


@dataclass(frozen=True)
class MoonModel:
    """A debiased luminosity function on the H_V scale: n_total moons in [h_lo, h_hi), dN/dH ~ 10^(alpha H)."""
    h_lo: float
    h_hi: float
    alpha: float
    n_total: float

    def n_between(self, h1: float, h2: float) -> float:
        lo, hi = max(h1, self.h_lo), min(h2, self.h_hi)
        if hi <= lo:
            return 0.0
        k = self.alpha * LN10
        full = math.expm1(k * (self.h_hi - self.h_lo))
        return self.n_total * (math.exp(k * (hi - self.h_lo)) - math.exp(k * (lo - self.h_lo))) / full

    def to_json(self) -> dict:
        return {"hLoV": round(self.h_lo, 4), "hHiV": round(self.h_hi, 4), "alpha": self.alpha, "nInRange": self.n_total}


def moon_model(spec: dict | None, offset: float) -> MoonModel | None:
    """The table's model (survey band, apparent magnitudes) on the H_V scale."""
    if not spec:
        return None
    m0, m1 = spec["magRange"]
    if "q" in spec:              # Ashton et al. (2021): N(<m1) = nFaint, differential size index q -> alpha = (q - 1)/5
        alpha = (spec["q"] - 1.0) / 5.0
        n = spec["nFaint"] * (1.0 - 10.0 ** (-alpha * (m1 - m0)))
    else:                        # Ashton et al. (2020): nFaint - nBright between the two anchored magnitudes
        alpha = spec["alpha"]
        n = float(spec["nFaint"] - spec["nBright"])
    return MoonModel(m0 + offset, m1 + offset, alpha, float(n))


def moon_limit(known_H: np.ndarray, model: MoonModel, h_width: float = sm.H_BIN, sigma: float = 2.0
               ) -> tuple[float | None, list[dict]]:
    """Completeness limit (H_V): the lower edge of the first H bin (bright to faint, inside the model's range) where the
    known moons number fewer than model - sigma sqrt(model); None if the catalogue is never short of the model."""
    rows, hlim = [], None
    for k in range(int(math.floor(model.h_lo / h_width)), int(math.ceil(model.h_hi / h_width))):
        lo, hi = max(k * h_width, model.h_lo), min((k + 1) * h_width, model.h_hi)
        if hi <= lo:
            continue
        n = model.n_between(lo, hi)
        kn = int(np.sum((known_H >= lo) & (known_H < hi)))
        short = kn < n - sigma * math.sqrt(n)
        rows.append({"hLo": round(lo, 4), "hHi": round(hi, 4), "model": round(n, 2), "known": kn, "short": bool(short)})
        if short and hlim is None:
            hlim = lo
    return hlim, rows


def template_cells(grid: sm.Grid, known: sm.Known, template: np.ndarray, model: MoonModel, hlim: float,
                   h_floor: float) -> tuple[sm.Cells, dict, dict]:
    """Model cells below the limit: model(cell) = n_model(H range of the cell) x the cell's share of the template
    (known moons brighter than the limit) in (a, e, i); known moons counted per cell and per (a, H) group."""
    ia, ie, ii, ih = grid.index(known.a, known.e, known.i, known.H)
    t = template & (ia >= 0)
    f_key = (ia[t] * grid.n_e + ie[t]) * grid.n_i + ii[t]
    fk, fc = np.unique(f_key, return_counts=True)
    n_t = float(fc.sum())
    rows = []
    for k, c in zip(fk.tolist(), fc.tolist()):
        a_, e_, i_ = k // (grid.n_e * grid.n_i), (k // grid.n_i) % grid.n_e, k % grid.n_i
        for h_ in range(int(math.floor(hlim / grid.h_width)), int(math.ceil(h_floor / grid.h_width))):
            lo, hi = max(h_ * grid.h_width, hlim), min((h_ + 1) * grid.h_width, h_floor)
            if hi > lo:
                rows.append((a_, e_, i_, h_, lo, hi, c / n_t * model.n_between(lo, hi)))
    cells = sm.cells_from_rows(rows)
    ok = ia >= 0
    gobs = sm.count_known(grid, cells, (ia[ok], ie[ok], ii[ok], ih[ok], known.H[ok]))
    return cells, gobs, {"templateMoons": int(n_t), "templateCells": int(fk.size)}


def match_bodies(rows: list[dict], bodies: list[dict], naif_planet: int) -> dict:
    """Which MPC irregulars of a planet the app has (bodies.json moons of the planet, by number or designation)."""
    moons = [b for b in bodies if b.get("parent") == naif_planet * 100 + 99]
    by_id = {b["id"]: b for b in moons}
    by_name = {b["name"].strip().lower(): b for b in moons}
    letter = "JSUN"[naif_planet - 5]
    found, missing = set(), []
    for r in rows:
        b = None
        if r["key"].startswith(letter) and r["key"][1:].isdecimal():
            b = by_id.get(naif_planet * 100 + int(r["key"][1:]))
        b = b or by_name.get(r["key"].lower()) or (by_name.get(r["name"].lower()) if r["name"] else None)
        if b is None:
            missing.append(r["key"])
        else:
            found.add(b["id"])
    # The MPC list holds the outer irregular moons only: the app's other moons of the planet that are not in it are
    # its regular and inner moons, and the provisionally designated ones listed here (those are moons the MPC list
    # may carry under a number since assigned, e.g. an unmatched 'J73' above).
    return {"mpcIrregulars": len(rows), "inBodies": len(found), "mpcNotInBodies": missing,
            "provisionalBodiesNotInMpcList": [b["name"] for b in moons
                                              if b["id"] not in found and b["name"].upper().startswith("S")
                                              and "20" in b["name"]]}


# ---------------------------------------------------------------------------------------------- Centaurs
@dataclass(frozen=True)
class KneeLaw:
    """dN/dH ~ 10^(alpha_bright (H - h_break)) below the knee, 10^(alpha_faint (H - h_break)) above, H <= h_max."""
    alpha_bright: float
    alpha_faint: float
    h_break: float
    h_max: float

    def cum(self, h) -> np.ndarray:
        """Unnormalized cumulative number N(< h) (h clipped to h_max)."""
        h = np.minimum(np.asarray(h, dtype=np.float64), self.h_max)
        kb, kf = self.alpha_bright * LN10, self.alpha_faint * LN10
        below = np.exp(kb * (np.minimum(h, self.h_break) - self.h_break)) / kb
        above = np.where(h > self.h_break, np.expm1(kf * (h - self.h_break)) / kf, 0.0)
        return below + above

    def inverse(self, u: np.ndarray) -> np.ndarray:
        """H with cum(H) / cum(h_max) = u."""
        kb, kf = self.alpha_bright * LN10, self.alpha_faint * LN10
        c = np.asarray(u, dtype=np.float64) * float(self.cum(self.h_max))
        cb = 1.0 / kb
        with np.errstate(divide="ignore", invalid="ignore"):
            hb = self.h_break + np.log(np.maximum(c * kb, 1e-300)) / kb
            hf = self.h_break + np.log1p(np.maximum(c - cb, 0.0) * kf) / kf
        return np.where(c < cb, hb, hf)

    def selection_probability(self, d: np.ndarray, m_min: float, m_max: float) -> np.ndarray:
        """P(m_min < H + d < m_max) for H drawn from the law."""
        return (self.cum(m_max - d) - self.cum(m_min - d)) / float(self.cum(self.h_max))


def centaur_colour(tab: dict) -> tuple[float, float]:
    """Mean g - r of the model Centaurs (Murtagh et al. 2025: the less-red and red fractions) and V - r =
    (1 - 0.59)(g - r) - 0.01 from Jester et al. (2005) Table 1 (V = g - 0.59 (g - r) - 0.01)."""
    col = tab["colour"]
    g_r = sum(col["gMinusR"][k] * col["fraction"][k] for k in col["fraction"])
    return g_r, 0.41 * g_r - 0.01


def _rng(seed_string: str) -> np.random.Generator:
    s = int.from_bytes(hashlib.sha256(seed_string.encode()).digest()[:16], "little")
    return sm.stream(s)


def centaur_realization(arch: dict[str, np.ndarray], tab: dict) -> tuple[dict[str, np.ndarray], dict]:
    """One realization of the Centaur model (module docstring). Returns members (a, e, i, H_r, H_V, node, peri, M)
    and diagnostics (the Horvitz-Thompson total against the archive's model size, effective sample size, ...)."""
    law = KneeLaw(tab["hLaw"]["alphaBright"], tab["hLaw"]["alphaFaint"], tab["hLaw"]["hBreak"], tab["hLaw"]["hMax"])
    sel = tab["archive"]["selection"]
    P = law.selection_probability(arch["d"], sel["mMin"], sel["mMax"])
    if np.any(P <= 0):
        raise ValueError("an archive member could not have been selected under the H law: wrong law?")
    w = 1.0 / P
    q = arch["a"] * (1.0 - arch["e"])
    dfn = tab["definition"]
    inside = (q > dfn["qMinAu"]) & (arch["a"] < dfn["aMaxAu"])
    n = int(round(tab["normalization"]["nBelowHr"]))
    rng = _rng(tab["realizationSeed"])
    cw = np.cumsum(np.where(inside, w, 0.0))
    pos = (rng.random() + np.arange(n)) / n * cw[-1]                 # systematic resampling
    idx = np.searchsorted(cw, pos, side="right")
    Hr = law.inverse(rng.random(n))
    ang = rng.random((n, 3)) * 360.0
    g_r, v_r = centaur_colour(tab)
    ess = float(w.sum() ** 2 / np.sum(w * w))
    members = {"a": arch["a"][idx], "e": arch["e"][idx], "i": arch["i"][idx], "Hr": Hr, "H": Hr + v_r,
               "node": ang[:, 0], "peri": ang[:, 1], "M": ang[:, 2], "archiveRow": idx}
    diag = {"archiveMembers": int(arch["a"].size), "outsideDefinition": int((~inside).sum()),
            "sumWeights": round(float(w.sum()), 1), "modelSize": tab["archive"]["modelSize"],
            "sumWeightsOverModelSize": round(float(w.sum()) / tab["archive"]["modelSize"], 4),
            "effectiveSampleSize": round(ess), "maxWeight": round(float(w.max()), 1),
            "minSelectionProbability": float(P.min()), "distinctOrbits": int(np.unique(idx).size), "realization": n,
            "gMinusR": round(g_r, 4), "vMinusR": round(v_r, 4), "hVMax": round(law.h_max + v_r, 4),
            "law": {"alphaBright": law.alpha_bright, "alphaFaint": law.alpha_faint, "hBreak": law.h_break,
                    "hMaxR": law.h_max}}
    return members, diag


def knee_check(arch: dict[str, np.ndarray], tab: dict, bins: int = 20) -> dict:
    """Does the archive follow the H law? Within slices of distance modulus d, the members' H must be distributed as
    the law restricted to [21 - d, 23.5 - d]: compare the counts in H bins with the law's expectation (chi-square per
    degree of freedom), and the same for the alternative reading (cumulative law continuous at the knee)."""
    law = KneeLaw(tab["hLaw"]["alphaBright"], tab["hLaw"]["alphaFaint"], tab["hLaw"]["hBreak"], tab["hLaw"]["hMax"])
    sel = tab["archive"]["selection"]
    out = {}
    for name, cum in (("differential knee (used)", law.cum),
                      ("cumulative knee (alternative)", lambda h: np.where(np.minimum(h, law.h_max) < law.h_break,
                                                                            10.0 ** (law.alpha_bright * (np.minimum(h, law.h_max) - law.h_break)),
                                                                            10.0 ** (law.alpha_faint * (np.minimum(h, law.h_max) - law.h_break))))):
        chi2, dof = 0.0, 0
        for d0 in np.arange(9.0, 16.5, 0.5):
            m = (arch["d"] >= d0) & (arch["d"] < d0 + 0.5)
            if m.sum() < 500:
                continue
            h, dd = arch["H"][m], arch["d"][m]
            edges = np.linspace(sel["mMin"] - d0, min(sel["mMax"] - d0 - 0.5, law.h_max), bins // 2 + 1)
            obs, _ = np.histogram(h, edges)
            p = np.array([np.mean((cum(np.minimum(e1, sel["mMax"] - dd)) - cum(np.maximum(e0, sel["mMin"] - dd)))
                                  .clip(0) / (cum(sel["mMax"] - dd) - cum(sel["mMin"] - dd)))
                          for e0, e1 in zip(edges[:-1], edges[1:])])
            exp = p * m.sum()
            ok = exp > 20
            chi2 += float(np.sum((obs[ok] - exp[ok]) ** 2 / exp[ok]))
            dof += int(ok.sum())
        out[name] = {"chi2PerBin": round(chi2 / max(dof, 1), 2), "bins": dof}
    return out