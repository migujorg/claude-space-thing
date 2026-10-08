"""Synthetic irregular moons and Centaurs (M6): their models, completeness limits and the Centaur realization.

Numbers come from syn_tables/populations.json ("irregularMoons", "centaurs"); the algorithm around them (cells, deficit,
streams, yield) is the one of syn_model and docs/reports/synthetic-populations.md. In short:

  irregular moons   per planet, the debiased luminosity function of the deepest characterised survey, shifted onto the
                    MPC H_V scale by an offset measured on the survey's own photometry of known moons (calibrate). The
                    fitted completeness proxy is the model-comparison rule of the model populations (moon_limit): the first
                    H bin, bright to faint, in which the known moons fall 2 sigma (Poisson) below the model. Below it,
                    each cell's model is the model's count in the H bin times the cell's share of the known moons
                    brighter than the limit (template_cells: the orbit distribution of the known moons, an assumption:
                    no bias-corrected orbit distribution was found in the published sources reviewed). Elements are planet-barycentric (ecliptic
                    J2000); a planet without a published population below its completeness limit gets no moons.
  Centaurs          one realization of the Kurlander et al. (2025) literature model (Nesvorny et al. 2019 orbits,
                    Lawler et al. 2018 H law, 21 400 with H_r < 13.7): the archive keeps only members with 21 < m <
                    23.5, so each member is weighted by 1/P(selected | its distance modulus) (Horvitz-Thompson), which
                    estimates the model's (a, e, i) distribution on reconstructible states; H from the knee law, angles uniform (Murtagh et al.
                    2025). It is then conditioned on eligible asteroid counts and qualified, sourced comet nuclear H_V;
                    M1, unqualified M2, lower bounds and unknown object-specific band conversions are excluded.
                    The cited survey rejects the joint orbit/H model, though marginal distributions agree.
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
            "notInMpcList": [n for n, _, _ in missing],
            "rule": "H_V = m + offset (median of H_MPC - m over the calibrators)"}


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
    def cum_continuous(h):        # the other reading: N(<H) itself continuous at the knee
        h = np.minimum(h, law.h_max)
        alpha = np.where(h < law.h_break, law.alpha_bright, law.alpha_faint)
        return 10.0 ** (alpha * (h - law.h_break))

    out = {}
    for name, cum in (("differential knee (used)", law.cum), ("cumulative knee (alternative)", cum_continuous)):
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


def centaur_selection_comparison(arch: dict, classifier: dict, tab: dict, grid: sm.Grid, known: sm.Known,
                                h_floor: float, prefix: str) -> dict:
    """Diagnostic only: current guard versus source status on archived survey-state counterparts.

    Keeps the current deterministic a/e/i/H realization and normalization. Queries resampled archive states
    with m shifted by the newly drawn H; uses the archive's angles at its survey midpoint, not the generator's
    independently randomized angles. Unknown m-domain cases retain the current guard in the comparison
    only; they are reported separately and are not asserted to be unobservable. Does not alter live products.
    """
    from . import syn_sources as ss
    mem, diag = centaur_realization(arch, tab)
    members = sm.Known(mem['a'], mem['e'], mem['i'], mem['H'])
    old, obs, lists, limits = sm.realization_cells(grid, known, members, h_floor)
    sm.condition(old, obs)
    sm.sample_realization(grid, old, lists, prefix)
    hlim = np.array([np.inf if x is None else x for x in limits['hlimPerABin']])
    ia, ie, ii, ih = grid.index(members.a, members.e, members.i, members.H)
    inside = (ia >= 0) & (members.H < h_floor)
    guard = inside & (members.H >= hlim[np.maximum(ia, 0)])
    states = arch['states'][mem['archiveRow']].copy()
    states[:, 6] = mem['Hr'] + arch['d'][mem['archiveRow']]
    result = ss.centaur_selection(classifier, states)
    status = result['status']
    # This policy preserves the current guard where the source cannot classify; it is a diagnostic proposal.
    keep = inside & ((status == 0) | ((status == -1) & guard))
    mkey = grid.key(ia[keep], ie[keep], ii[keep], ih[keep])
    midx = np.flatnonzero(keep)
    order = np.lexsort((midx, mkey)); mkey, midx = mkey[order], midx[order]
    keys, starts, counts = np.unique(mkey, return_index=True, return_counts=True)
    a, e, i, h = grid.unkey(keys)
    new = sm.cells_from_rows([(aa, ee, ii_, hh, hh * grid.h_width, min((hh + 1) * grid.h_width, h_floor), n)
                             for aa, ee, ii_, hh, n in zip(a, e, i, h, counts)])
    known_idx = grid.index(known.a, known.e, known.i, known.H)
    obs = sm.count_known(grid, new, (*known_idx, known.H))
    sm.condition(new, obs)
    new_lists = {int(k): midx[s:s+n] for k, s, n in zip(keys, starts, counts)}
    sm.sample_realization(grid, new, new_lists, prefix)
    def shown(c):
        out = {}
        for aa, hh, n in zip(c.ia, c.ih, c.n_shown):
            key = (int(aa), int(hh)); out[key] = out.get(key, 0) + int(n)
        return out
    old_count, new_count = shown(old), shown(new)
    rows = []
    for a_, h_ in sorted(old_count.keys() | new_count.keys()):
        group = inside & (ia == a_) & (ih == h_)
        n0, n1 = old_count.get((a_, h_), 0), new_count.get((a_, h_), 0)
        spread = math.sqrt(max(n0, n1))  # conservative one-sigma Poisson spread of either group's shown count
        rows.append({'ia': a_, 'ih': h_, 'aLo': grid.a_edges[a_], 'aHi': grid.a_edges[a_+1],
                     'hLoV': h_ * grid.h_width, 'hHiV': min((h_+1) * grid.h_width, h_floor),
                     'todayGuardShown': n0, 'archiveStateSelectionShown': n1, 'difference': n1-n0,
                     'poissonSpread': spread, 'exceedsPoisson': abs(n1-n0) > spread,
                     'sourceDetected': int(np.sum(group & (status == 1))),
                     'sourceUndetected': int(np.sum(group & (status == 0))),
                     'unknownDomain': int(np.sum(group & (status == -1)))})
    return {'method': 'Counterfactual on resampled archive survey-midpoint states with newly drawn H; unknown '
                      'm-domain cases retain today guard. Archive-state angles differ from live randomized angles; '
                      'this is a diagnostic, not an implemented survey veto or a certified unseen count.',
            'model': diag, 'sourceOriginalPopulation': tab['archive']['modelSize'],
            'normalization': tab['normalization'], 'groups': rows,
            'totals': {'todayGuardShown': sum(old_count.values()), 'archiveStateSelectionShown': sum(new_count.values()),
                       'groupsExceedPoisson': sum(r['exceedsPoisson'] for r in rows),
                       'sourceDetected': int(np.sum(inside & (status == 1))),
                       'sourceUndetected': int(np.sum(inside & (status == 0))),
                       'unknownDomain': int(np.sum(inside & (status == -1))),
                       'unknownBright': int(np.sum(inside & (states[:,6] <= 21))),
                       'unknownFaint': int(np.sum(inside & (states[:,6] >= 23.5)))}}


# ---------------------------------------------------------------------------------------------- CFEPS
# IAU 2012 Resolution B2 and SI definition of light speed; Bowell et al. 1989 H-G coefficients.
_C_KM_S = 299792.458


def cfeps_field_probability(field: dict, ra, dec, mag, rate, angle) -> np.ndarray:
    """Discovery probability within published characterized domain, including filling factor.

    Polygons match getsur.f95: each vertex x offset is divided by cos(vertex declination).
    Direction is atan2(north rate, west rate), as in surveysub.f95. Tracking is deliberately separate.
    """
    ra, dec, mag, rate, angle = (np.asarray(x) for x in (ra, dec, mag, rate, angle))
    x = (ra - field['ra'] + 180) % 360 - 180
    verts = np.asarray(field['vertices'])
    vy = verts[:, 1] + field['dec']
    vx = verts[:, 0] / np.cos(np.radians(vy))
    inside = np.zeros(x.shape, dtype=bool)
    for j in range(len(vx)):
        k = (j+1) % len(vx)
        if vy[j] == vy[k]:
            continue
        cross = (vx[k]-vx[j]) * (dec-vy[j]) / (vy[k]-vy[j]) + vx[j]
        inside ^= ((vy[j] > dec) != (vy[k] > dec)) & (x < cross)
    eff = field['eff']
    lo, hi, mean, half = eff['rate_cut']
    r0, r1 = eff['rates']
    eligible = inside & (mag <= eff['mag_lim'][0]) & (rate >= max(lo, r0)) & (rate <= min(hi, r1))
    eligible &= np.abs((angle-mean+180) % 360-180) <= half
    A, m0, s1, s2 = eff['double_param']
    eta = A / 4 * (1-np.tanh((mag-m0)/s1)) * (1-np.tanh((mag-m0)/s2))
    return np.where(eligible, np.clip(field['fill'] * eta, 0, 1), 0.)


def cfeps_keep(probability, prefix: str, member) -> np.ndarray:
    """One independent SHA256 uniform per original L7 member, independent of order and cell counts.

    Keep iff u >= P(any characterized discovery). No redraw or replacement after a veto.
    """
    u = np.array([int.from_bytes(hashlib.sha256(f'{prefix}|cfeps-discovery-v1|{int(m)}'.encode()).digest()[:8], 'big')
                  / 2**64 for m in member])
    return u >= np.asarray(probability)


def cfeps_probability(el: dict, epoch_et: float, fields: list[dict], observer,
                      mu: float, au_km: float, obliquity: float, band_minus_v: dict) -> tuple[np.ndarray, dict]:
    """Orbit-specific P(any discovery) = 1 - product(1 - fill*eta) across published pointings.

    Assumes independent detection/filling draws across pointings, as the released simulator does.
    observer(JD) returns TDB et and geocentric heliocentric ICRF position/velocity in km, km/s.
    Two-body orbit is the candidate's own; light time iterated, no invented measured-magnitude noise.
    """
    n = len(el['a'])
    missed = np.ones(n)
    per_field = []
    for field in fields:
        band = field['eff']['filter']
        if band not in band_minus_v:
            raise ValueError(f'unknown CFEPS band conversion: {band}')
        et, earth, earth_v = observer(field['epochJd'])
        mean_motion = np.degrees(np.sqrt(mu / (el['a'] * au_km)**3))
        def state(t):
            return sm.elements_to_icrf(el['a'], el['e'], el['i'], el['node'], el['peri'],
                                      (el['M'] + mean_motion*(t-epoch_et)) % 360, mu, au_km, obliquity)
        if n == 0:
            per_field.append({'block': field['block'], 'epochJd': field['epochJd'], 'candidates': 0, 'expectedDetections': 0.})
            continue
        pos, vel = state(et)
        for _ in range(4):
            delta = np.linalg.norm(pos-earth, axis=1)
            pos, vel = state(et - delta/_C_KM_S)
        ray = pos - earth
        delta = np.linalg.norm(ray, axis=1)
        direction = ray / delta[:, None]
        # Derivative of the converged light-time equation; velocities are km/s.
        emit_rate = (1 + direction @ earth_v / _C_KM_S) / (1 + np.sum(direction*vel, axis=1)/_C_KM_S)
        rv = vel * emit_rate[:, None] - earth_v
        x, y, z = ray.T
        rho = np.hypot(x, y)
        ra = np.degrees(np.arctan2(y, x)) % 360
        dec = np.degrees(np.arctan2(z, rho))
        east = (-y*rv[:, 0]+x*rv[:, 1]) / (rho*delta)
        north = (rho*rv[:, 2]-z*(x*rv[:, 0]+y*rv[:, 1])/rho) / delta**2
        scale = np.degrees(1.) * 3600 * 3600  # rad/s -> arcsec/hour (unit conversion)
        rate = np.hypot(east, north) * scale
        angle = np.degrees(np.arctan2(north, -east))
        r = np.linalg.norm(pos, axis=1)
        phase = np.arccos(np.clip(np.sum(pos*ray, axis=1)/(r*delta), -1, 1))
        tan = np.tan(phase/2)
        phi = .85*np.exp(-3.33*tan**.63) + .15*np.exp(-1.87*tan**1.22)
        mag = el['H'] + band_minus_v[band] + 5*np.log10(r*delta / au_km**2) - 2.5*np.log10(phi)
        probability = cfeps_field_probability(field, ra, dec, mag, rate, angle)
        missed *= 1-probability
        per_field.append({'block': field['block'], 'epochJd': field['epochJd'],
                          'candidates': int(np.sum(probability > 0)), 'expectedDetections': float(probability.sum())})
    return 1-missed, {'candidatesInCharacterizedSpace': int(np.sum(missed < 1)),
                      'expectedVetoes': float((1-missed).sum()), 'pointings': per_field}
