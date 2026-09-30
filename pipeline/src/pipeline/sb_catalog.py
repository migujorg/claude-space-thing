"""Parse an SBDB snapshot (sb_sbdb) into column arrays, and turn the osculating elements into states.

Element conventions (SBDB): heliocentric, ecliptic and equinox J2000 (IAU76/80 obliquity), angles in degrees,
distances in au, epoch and tp as TDB Julian dates. States are heliocentric ICRF, km and km/s (sb_dynamics).
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import sb_dynamics as dyn
from .sb_model import AU_KM, DAY_S

J2000_JD = 2451545.0

# Marsden et al. (1973) g(r) constants, the defaults the SBDB API lists for its non-gravitational model
# (sbdb.api model_pars descriptions: ALN 0.1112620426, R0 2.808 au, NM 2.15, NN 5.093, NK 4.6142).
NG_DEFAULTS = {"ALN": 0.1112620426, "R0": 2.808, "NM": 2.15, "NN": 5.093, "NK": 4.6142}

FLOAT_FIELDS = ["epoch", "e", "a", "q", "i", "om", "w", "ma", "tp", "data_arc", "H", "G", "H_sigma",
                "A1", "A2", "A3", "DT", "S0", "M1", "K1", "M2", "K2", "PC"]
STR_FIELDS = ["full_name", "pdes", "name", "prefix", "kind", "class", "orbit_id", "equinox", "condition_code",
              "two_body", "source", "pe_used"]


@dataclass
class Catalog:
    spkid: np.ndarray
    f: dict[str, np.ndarray]          # float columns (NaN = null)
    s: dict[str, np.ndarray]          # str columns (object arrays, None = null)
    neo: np.ndarray
    pha: np.ndarray
    n_obs: np.ndarray
    duplicates: int = 0
    ng: np.ndarray | None = None      # (N, 9) A1, A2, A3 (km/s^2), DT (s), ALN, R0 (km), NM, NN, NK
    has_ng: np.ndarray | None = None
    ng_unsupported: dict[int, str] = field(default_factory=dict)  # row -> reason (e.g. AMRAT/S0 not modelled)

    @property
    def n(self) -> int:
        return int(self.spkid.size)

    def row_of(self, spkid: int) -> int:
        i = int(np.searchsorted(self.spkid, spkid))
        if i >= self.n or self.spkid[i] != spkid:
            raise KeyError(spkid)
        return i

    def subset(self, rows: np.ndarray) -> "Catalog":
        c = Catalog(self.spkid[rows], {k: v[rows] for k, v in self.f.items()}, {k: v[rows] for k, v in self.s.items()},
                    self.neo[rows], self.pha[rows], self.n_obs[rows])
        if self.ng is not None:
            c.ng, c.has_ng = self.ng[rows], self.has_ng[rows]
        new = {int(r): k for k, r in enumerate(np.asarray(rows).reshape(-1))}
        c.ng_unsupported = {new[i]: why for i, why in self.ng_unsupported.items() if i in new}
        c.duplicates = self.duplicates
        return c


def _num(x) -> float:
    return math.nan if x is None else float(x)


def load_orbits(pages: list[Path]) -> Catalog:
    rows: dict[int, list] = {}
    fields = None
    dup = 0
    for p in pages:
        d = json.loads(p.read_text(encoding="utf-8"))
        fields = d["fields"]
        for r in d["data"]:
            k = int(r[0])
            if k in rows:
                dup += 1
            rows[k] = r
    keys = np.array(sorted(rows), dtype=np.int64)
    idx = {f: fields.index(f) for f in fields}
    data = [rows[int(k)] for k in keys]
    f = {name: np.array([_num(r[idx[name]]) for r in data]) for name in FLOAT_FIELDS}
    s = {name: np.array([r[idx[name]] for r in data], dtype=object) for name in STR_FIELDS}
    neo = np.array([r[idx["neo"]] == "Y" for r in data])
    pha = np.array([r[idx["pha"]] == "Y" for r in data])
    nobs = np.array([-1 if r[idx["n_obs_used"]] is None else int(r[idx["n_obs_used"]]) for r in data])
    return Catalog(keys, f, s, neo, pha, nobs, duplicates=dup)


def attach_nongrav(cat: Catalog, ng_files: dict[int, Path]) -> None:
    """Fill cat.ng / cat.has_ng from the per-object sbdb.api responses (model_pars), SI-like units."""
    n = cat.n
    ng = np.zeros((n, 9))
    ng[:, 4] = NG_DEFAULTS["ALN"]
    ng[:, 5] = NG_DEFAULTS["R0"] * AU_KM
    ng[:, 6] = NG_DEFAULTS["NM"]
    ng[:, 7] = NG_DEFAULTS["NN"]
    ng[:, 8] = NG_DEFAULTS["NK"]
    has = np.zeros(n, dtype=bool)
    acc = AU_KM / (DAY_S * DAY_S)
    for spk, path in ng_files.items():
        try:
            i = cat.row_of(spk)
        except KeyError:
            continue
        d = json.loads(path.read_text(encoding="utf-8"))
        orbit = d.get("orbit", {})
        pars = {m["name"]: m for m in orbit.get("model_pars", []) or []}
        # Consistency: the single-object answer must be the same solution as the bulk row.
        oid = orbit.get("orbit_id")
        if oid is not None and cat.s["orbit_id"][i] is not None and not str(cat.s["orbit_id"][i]).endswith(str(oid)):
            cat.ng_unsupported[i] = f"sbdb.api orbit {oid} differs from bulk orbit {cat.s['orbit_id'][i]}"
        for k, col, scale in (("A1", 0, acc), ("A2", 1, acc), ("A3", 2, acc), ("DT", 3, DAY_S), ("ALN", 4, 1.0),
                              ("R0", 5, AU_KM), ("NM", 6, 1.0), ("NN", 7, 1.0), ("NK", 8, 1.0)):
            if k in pars and pars[k].get("value") is not None:
                ng[i, col] = float(pars[k]["value"]) * scale
        for k in pars:
            if k not in ("A1", "A2", "A3", "DT", "ALN", "R0", "NM", "NN", "NK"):
                v = pars[k].get("value")
                if v is not None and float(v) != 0.0:
                    cat.ng_unsupported[i] = f"model parameter {k} = {v} not modelled"
        has[i] = any(ng[i, j] != 0.0 for j in range(3))
    cat.ng, cat.has_ng = ng, has


def epoch_et(cat: Catalog) -> np.ndarray:
    return (cat.f["epoch"] - J2000_JD) * DAY_S


def time_since_perihelion(cat: Catalog, mu: float) -> np.ndarray:
    """dt_peri (s) at each object's epoch: M/n with M reduced to (-pi, pi] for e < 1 when the mean anomaly is given,
    otherwise (epoch - tp)."""
    e, q = cat.f["e"], cat.f["q"] * AU_KM
    M = np.radians(cat.f["ma"])
    M = np.remainder(M + np.pi, 2.0 * np.pi) - np.pi
    with np.errstate(invalid="ignore", divide="ignore"):
        n = np.sqrt(mu * (1.0 - e) ** 3 / q ** 3)
        dt_m = M / n
    dt_tp = (cat.f["epoch"] - cat.f["tp"]) * DAY_S
    use_m = (e < 1.0) & np.isfinite(dt_m)
    return np.where(use_m, dt_m, dt_tp)


def states_at_epoch(cat: Catalog, mu: float, obliquity: float) -> tuple[np.ndarray, np.ndarray]:
    """(N, 6) heliocentric ICRF states at each object's own epoch, and a status array (sb_dynamics codes)."""
    q = cat.f["q"] * AU_KM
    return dyn.elements_to_states(q, cat.f["e"], np.radians(cat.f["i"]), np.radians(cat.f["om"]),
                                  np.radians(cat.f["w"]), time_since_perihelion(cat, mu), mu, obliquity)
