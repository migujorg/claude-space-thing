"""Independent check of the small-body propagation against JPL Horizons.

For a fixed, diverse set of objects, Horizons heliocentric geometric ICRF state vectors (TDB) are fetched on the
integrator's grid (common epoch + 2 d * m) across the manifest window (cached, sha256-recorded). Our states come
from the same SBDB solution (the orbit_id is compared with the solution Horizons names): elements -> state at the
SBDB epoch -> the product's common epoch (exactly as the stage does) -> every grid epoch (exactly as the app does;
on the grid, propagating epoch by epoch equals propagating from the common epoch directly). Horizons' own model is
JPL's small-body integrator (DE441 planets, the 16 most massive asteroids, relativity, Earth and Sun oblateness,
fitted non-gravitational terms), so the difference measures our force model + integrator, not orbit uncertainty.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

import numpy as np

from . import ephem_horizons as hz
from . import sb_dynamics as dyn
from .download import record
from .sb_catalog import Catalog, epoch_et, states_at_epoch
from .sb_model import ForceModel, propagate

SUBDIR = "horizons/smallbodies"

# (label, SBDB primary designation, category)
OBJECTS = [
    ("1 Ceres", "1", "main belt (dwarf planet)"),
    ("2 Pallas", "2", "main belt, i = 35 deg"),
    ("4 Vesta", "4", "main belt"),
    ("153 Hilda", "153", "Hilda (3:2 with Jupiter)"),
    ("624 Hektor", "624", "Jupiter Trojan (L4)"),
    ("2060 Chiron", "2060", "Centaur"),
    ("10199 Chariklo", "10199", "Centaur"),
    ("136199 Eris", "136199", "scattered-disc TNO"),
    ("486958 Arrokoth", "486958", "cold classical TNO"),
    ("433 Eros", "433", "NEO (Amor)"),
    ("1566 Icarus", "1566", "NEO (Apollo), q = 0.19 au"),
    ("3200 Phaethon", "3200", "NEO (Apollo), q = 0.14 au"),
    ("99942 Apophis", "99942", "NEO (Aten), Yarkovsky A2"),
    ("101955 Bennu", "101955", "NEO (Apollo), Yarkovsky A2"),
    ("2026 RT34", "2026 RT34", "NEO, Earth flyby at 21 000 km on 2026-09-13"),
    ("2P/Encke", "2P", "Jupiter-family comet, q = 0.34 au, non-grav"),
    ("67P/Churyumov-Gerasimenko", "67P", "Jupiter-family comet, non-grav"),
    ("C/2025 A6 (Lemmon)", "C/2025 A6", "long-period comet, non-grav"),
    ("3I/ATLAS (C/2025 N1)", "C/2025 N1", "interstellar, hyperbolic (e = 6.1), non-grav with DT"),
]


@dataclass
class Result:
    label: str
    category: str
    row: int
    pdes: str
    orbit_id: str
    horizons_soln: str
    same_solution: bool
    horizons_url: str
    epochs: np.ndarray          # ET
    horizons: np.ndarray        # (M, 6)
    ours: np.ndarray            # (M, 6)
    status: np.ndarray          # (M,)
    q_au: float
    e: float
    max_substep_level: int
    state_epoch: np.ndarray     # (6,) our state at the SBDB epoch
    state_common: np.ndarray    # (6,) at the common epoch

    @property
    def err_km(self) -> np.ndarray:
        return np.linalg.norm(self.ours[:, :3] - self.horizons[:, :3], axis=1)

    @property
    def max_err_km(self) -> float:
        return float(np.nanmax(self.err_km))

    @property
    def max_err_vel(self) -> float:
        return float(np.nanmax(np.linalg.norm(self.ours[:, 3:] - self.horizons[:, 3:], axis=1)))


def find_row(cat: Catalog, pdes: str) -> int:
    hit = np.nonzero(cat.s["pdes"] == pdes)[0]
    if hit.size == 0 and "/" in pdes:  # SBDB keeps the comet prefix separately: "C/2025 A6" -> prefix C, pdes 2025 A6
        pre, des = pdes.split("/", 1)
        hit = np.nonzero((cat.s["pdes"] == des) & (cat.s["prefix"] == pre))[0]
    if hit.size != 1:
        raise KeyError(f"{pdes}: {hit.size} SBDB rows")
    return int(hit[0])


def horizons_command(cat: Catalog, row: int) -> str:
    if str(cat.s["kind"][row]).startswith("c"):
        pdes, pre = str(cat.s["pdes"][row]), cat.s["prefix"][row]
        des = pdes if (not pre or pdes[:1].isdigit() and pdes.endswith(pre)) else f"{pre}/{pdes}"
        return f"DES={des};CAP;NOFRAG"
    return f"DES={int(cat.spkid[row])};"


def grid_span(common_et: float, start_et: float, end_et: float, step: float) -> tuple[float, float]:
    """First and last grid epochs (common + m step) inside [start_et, end_et]."""
    return (common_et - math.floor((common_et - start_et) / step) * step,
            common_et + math.floor((end_et - common_et) / step) * step)


def fetch(cat: Catalog, row: int, t0: float, t1: float, step_days: float) -> tuple[hz.VectorTable, str, str]:
    params = hz.vector_params(horizons_command(cat, row), "500@10", start=hz.et_to_tdb_calendar(t0)[:16],
                              stop=hz.et_to_tdb_calendar(t1)[:16], step=f"{step_days:g} d")
    params["OBJ_DATA"] = "'YES'"
    name = re.sub(r"[^A-Za-z0-9]+", "_", str(cat.s["pdes"][row])) + f"_{int(cat.spkid[row])}.txt"
    path, table = hz.fetch_vectors(params, SUBDIR, name)
    text = path.read_text(encoding="utf-8")
    m = re.search(r"soln ref\.=\s*(\S+?),", text) or re.search(r"\{source:\s*([^}]+)\}", table.target_line)
    return table, (m.group(1).strip() if m else ""), record(path)["url"]


def same_solution(sbdb_orbit_id: str | None, horizons_soln: str) -> bool:
    a = re.sub(r"^JPL[ #]*", "", str(sbdb_orbit_id or "")).strip()
    b = re.sub(r"^JPL[ #]*", "", horizons_soln).strip()
    return bool(a) and a == b


def _prop(model: ForceModel, s: np.ndarray, t0: float, t1: float, grid0: float, ng, has) -> tuple[int, int]:
    st, stats = propagate(model, s, np.array([t0]), t1, grid0, ng, has)
    return int(st[0]), int(stats[0, 1])


def propagate_along(model: ForceModel, s_common: np.ndarray, common_et: float, epochs: np.ndarray, ng, has
                    ) -> tuple[np.ndarray, np.ndarray, int]:
    """States at grid epochs, stepping outward from the common epoch (forward and backward chains)."""
    out = np.full((epochs.size, 6), np.nan)
    status = np.zeros(epochs.size, dtype=np.int8)
    lvl = 0
    for direction in (1, -1):
        s = s_common.reshape(1, 6).copy()
        t = common_et
        order = np.argsort(epochs) if direction > 0 else np.argsort(-epochs)
        for j in order:
            e = epochs[j]
            if (e - common_et) * direction < 0 or (direction < 0 and e == common_et):
                continue
            st, lv = _prop(model, s, t, float(e), common_et, ng, has)
            lvl = max(lvl, lv)
            status[j] = st
            if st != dyn.OK:
                break
            out[j] = s[0]
            t = float(e)
    return out, status, lvl


def run(cat: Catalog, model: ForceModel, common_et: float, start_et: float, end_et: float,
        states_common: np.ndarray | None = None, step_days: float = 2.0) -> list[Result]:
    """Propagate each verification object as the stage and the app would and compare with Horizons.
    states_common: optional (N, 6) product states at common_et (else computed here from the elements)."""
    step = step_days * 86400.0
    if abs(step / model.base_step - round(step / model.base_step)) > 1e-12:
        raise ValueError("verification epochs must lie on the integrator grid")
    t0, t1 = grid_span(common_et, start_et, end_et, step)
    out = []
    for label, pdes, category in OBJECTS:
        row = find_row(cat, pdes)
        table, soln, url = fetch(cat, row, t0, t1, step_days)
        sub = cat.subset(np.array([row]))
        s_epoch, _ = states_at_epoch(sub, model.mu_sun, model.obliquity)
        if states_common is not None:
            s0 = states_common[row].copy()
        else:
            s = s_epoch.copy()
            _prop(model, s, float(epoch_et(sub)[0]), common_et, common_et, sub.ng, sub.has_ng)
            s0 = s[0]
        et = np.round(table.et / 60.0) * 60.0  # Horizons prints JD to 1e-9 d; the grid is whole minutes
        ours, status, lvl = propagate_along(model, s0, common_et, et, sub.ng, sub.has_ng)
        out.append(Result(label, category, row, pdes, str(cat.s["orbit_id"][row]), soln,
                          same_solution(cat.s["orbit_id"][row], soln), url, et, table.states, ours, status,
                          float(cat.f["q"][row]), float(cat.f["e"][row]), lvl, s_epoch[0], s0))
    return out


def reference(model: ForceModel, s0: np.ndarray, t0: float, epochs: np.ndarray, ng: np.ndarray, has_ng: bool
              ) -> np.ndarray:
    """The same force model integrated with an adaptive 8th-order Runge-Kutta (scipy DOP853, rtol 1e-13) instead of
    the fixed-grid splitting: the difference to `propagate_along` is the integration error of the product's scheme.
    Returns (M, 6) states at `epochs` (NaN where unreachable)."""
    from scipy.integrate import solve_ivp

    rp = np.empty((model.gm.size, 3))
    a = np.empty(3)
    ng1 = np.asarray(ng, dtype=np.float64).reshape(9)

    def rhs(t, y):
        st = dyn._total_accel(y[:3].copy(), y[3:].copy(), t, model.data, model.segs, model.chains, model.sun_chain,
                              model.gm, model.radius, model.mu_sun, model.c2inv, model.gr, model.j2p, ng1,
                              bool(has_ng), rp, a)
        if st != dyn.OK:
            raise RuntimeError(f"reference integration stopped (status {st}) at {t}")
        return np.concatenate([y[3:], a])

    out = np.full((epochs.size, 6), np.nan)
    atol = np.array([1e-6] * 3 + [1e-12] * 3)
    for direction in (1, -1):
        sel = np.nonzero((epochs - t0) * direction >= 0)[0]
        if sel.size == 0:
            continue
        te = epochs[sel]
        order = np.argsort(te * direction)
        tspan = (t0, float(te[order[-1]]))
        if tspan[0] == tspan[1]:
            out[sel] = s0
            continue
        sol = solve_ivp(rhs, tspan, s0, method="DOP853", rtol=1e-13, atol=atol, t_eval=te[order], dense_output=False)
        if sol.status != 0 and sol.y.shape[1] != order.size:
            continue
        out[sel[order]] = sol.y.T
    return out


def summary(results: list[Result]) -> list[dict]:
    return [{"object": r.label, "category": r.category, "qAu": r.q_au, "e": r.e, "sbdbOrbit": r.orbit_id,
             "horizonsSolution": r.horizons_soln, "sameSolution": r.same_solution, "epochs": int(r.epochs.size),
             "maxErrKm": r.max_err_km, "maxErrKmS": r.max_err_vel, "maxLevel": r.max_substep_level}
            for r in results]
