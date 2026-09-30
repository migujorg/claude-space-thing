"""The small-body force model and integrator settings, built from the NAIF kernels (sha256-recorded downloads).

`ForceModel` holds (a) numba-ready arrays for `sb_dynamics` and (b) `to_json()`, the `forceModel` block written
into the small-body product header. The TypeScript reference (app/src/core/smallbody.ts) reads that block, so the
app's propagator uses exactly these perturbers, GMs, radii, constants and splitting coefficients: no number in
the app describes the force model on its own.

Model (heliocentric, test particle):
  d2x/dt2 = -GM_sun x/|x|^3                                                  (Kepler drift, exact)
          + sum_p GM_p [ (x_p - x)/|x_p - x|^3 - x_p/|x_p|^3 ]                (planets, direct + indirect)
          + GM_sun/(c^2 |x|^3) [ (4 GM_sun/|x| - |v|^2) x + 4 (x.v) v ]      (solar 1PN, PPN beta = gamma = 1)
          + Earth J2 (zonal harmonic about the IAU_EARTH pole at the reference epoch)
          + g(r) (A1 r_hat + A2 t_hat + A3 n_hat)                             (non-gravitational, where fitted)
Perturbers x_p: Mercury, Venus, Earth, Moon, Mars, Jupiter, Saturn, Uranus, Neptune, Pluto (barycenters of systems
with moons, since the moons' pull on a distant body acts at the system barycenter), heliocentric from DE442s.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .ephem_kernels import PLANETARY, SRC_GM, SRC_PCK, SRC_PLANETARY, gd, gm as gm_kernel, pck, planetary, pool
from .ephem_spk import read_spk, restrict
from .schema import BuildContext

C_KM_S = 299792.458              # SI defining constant (BIPM SI Brochure, 9th ed., 2019)
AU_KM = 149597870.7              # IAU 2012 Resolution B2
DAY_S = 86400.0
OBLIQUITY_ARCSEC = 84381.448     # IAU 1976 obliquity of the ecliptic at J2000 (Lieske et al. 1977, A&A 58, 1)
# Earth's dynamical form factor and its reference radius: IERS Conventions (2010), Petit & Luzum (eds.), IERS
# Technical Note 36, Table 1.1 (J2 = 1.0826359e-3 zero-tide, a_E = 6378136.6 m). Matters only for passages within
# ~1e5 km of Earth (deep close approaches).
EARTH_J2 = 1.0826359e-3
EARTH_J2_RADIUS_KM = 6378.1366

# (label, NAIF id of the attracting mass, SSB chain as (target, center) segments, radius body)
PERTURBERS = [
    ("Mercury", 1, [(1, 0)], 199),
    ("Venus", 2, [(2, 0)], 299),
    ("Earth", 399, [(3, 0), (399, 3)], 399),
    ("Moon", 301, [(3, 0), (301, 3)], 301),
    ("Mars system", 4, [(4, 0)], 499),
    ("Jupiter system", 5, [(5, 0)], 599),
    ("Saturn system", 6, [(6, 0)], 699),
    ("Uranus system", 7, [(7, 0)], 799),
    ("Neptune system", 8, [(8, 0)], 899),
    ("Pluto system", 9, [(9, 0)], 999),
]
SUN_CHAIN = [(10, 0)]

# SABA_n splitting coefficients (Laskar & Robutel 2001, Table 1): drifts c_i (symmetric), kicks d_i.
_S15 = math.sqrt(15.0)
SCHEMES = {
    "SABA1": ([0.5, 0.5], [1.0]),
    "SABA2": ([0.5 - math.sqrt(3.0) / 6.0, math.sqrt(3.0) / 3.0, 0.5 - math.sqrt(3.0) / 6.0], [0.5, 0.5]),
    "SABA3": ([0.5 - _S15 / 10.0, _S15 / 10.0, _S15 / 10.0, 0.5 - _S15 / 10.0], [5.0 / 18.0, 4.0 / 9.0, 5.0 / 18.0]),
}

# Integrator defaults (see docs/reports/small-bodies.md for how they were chosen).
SCHEME = "SABA3"
BASE_STEP_DAYS = 2.0
ETA_SUN = 0.3
ETA_PLANET = 0.3
ETA_ENCOUNTER = 0.01
KMAX = 16
ENC_RATIO = 0.001  # planet pull / solar pull above which a step's substeps use RK4 instead of the splitting


@dataclass
class ForceModel:
    mu_sun: float
    gm: np.ndarray                 # (P,)
    radius: np.ndarray             # (P + 1,) perturbers then the Sun, km
    data: np.ndarray               # flat Chebyshev records
    segs: np.ndarray               # (S, 8): offset, n, rsize, ncoef, initEt, intLen, startEt, endEt
    chains: np.ndarray             # (P, 2) segment indices, -1 padded
    sun_chain: np.ndarray          # (1,)
    drift_c: np.ndarray
    kick_d: np.ndarray
    scheme: str
    base_step: float               # s
    eta_sun: float
    eta_planet: float
    eta_enc: float
    kmax: int
    enc_ratio: float
    j2p: np.ndarray                # [perturber index, J2, R_ref km, pole x, y, z] (ICRF unit vector)
    gr: bool = True
    obliquity: float = OBLIQUITY_ARCSEC * math.pi / (180.0 * 3600.0)
    c2inv: float = 1.0 / (C_KM_S * C_KM_S)
    names: list[str] = field(default_factory=list)
    ids: list[int] = field(default_factory=list)
    span: tuple[float, float] = (0.0, 0.0)

    def args(self) -> tuple:
        """Positional arguments shared by sb_dynamics.saba_step / propagate_* after the per-object ones."""
        return (self.drift_c, self.kick_d, self.data, self.segs, self.chains, self.sun_chain, self.gm, self.radius,
                self.mu_sun, self.c2inv, self.gr, self.j2p)

    def ctrl(self) -> tuple:
        """Step-control arguments of sb_dynamics.propagate_* (after ng, has_ng)."""
        return (self.eta_sun, self.eta_planet, self.eta_enc, self.kmax, self.enc_ratio)

    def to_json(self) -> dict:
        return {
            "frame": "heliocentric ICRF (SPICE J2000); km, s",
            "sun": {"naifId": 10, "gm": self.mu_sun, "radius": float(self.radius[-1]),
                    "sources": [SRC_GM, SRC_PCK]},
            "perturbers": [{"name": n, "naifId": i, "gm": float(g), "radius": float(r)}
                           for n, i, g, r in zip(self.names, self.ids, self.gm, self.radius[:-1])],
            "perturberSources": [SRC_GM, SRC_PCK, SRC_PLANETARY],
            "ephemeris": f"ephem/{PLANETARY}",
            "indirect": "sum_p GM_p x_p/|x_p|^3 (Newtonian acceleration of the Sun by the perturbers)",
            "zonal": {"perturber": self.ids[int(self.j2p[0])] if self.j2p[0] >= 0 else None,
                      "j2": float(self.j2p[1]), "referenceRadiusKm": float(self.j2p[2]),
                      "poleIcrf": [float(c) for c in self.j2p[3:6]],
                      "source": "IERS Conventions (2010), IERS Technical Note 36, Table 1.1; pole: IAU_EARTH "
                                "(pck00011) at the reference epoch",
                      "model": "a = -(3/2) J2 GM R^2/d^5 [(1 - 5 z^2/d^2) d_vec + 2 z k], d_vec = x - x_earth, "
                               "z = d_vec . k"},
            "relativity": {"model": "solar 1PN (PPN beta = gamma = 1), heliocentric velocity", "enabled": self.gr,
                           "cKmS": C_KM_S},
            "nonGravitational": "g(r) = ALN (r/R0)^-NM (1 + (r/R0)^NN)^-NK; a = g(r(t - DT)) (A1 r_hat + A2 t_hat + "
                                "A3 n_hat); t_hat = n_hat x r_hat, n_hat = (x x v)/|x x v|; A in km/s^2, R0 in km",
            "scheme": {"name": self.scheme, "drift": [float(c) for c in self.drift_c],
                       "kick": [float(d) for d in self.kick_d],
                       "order": "drift c0 h, kick d0 h (at the running time), drift c1 h, ..., drift c_last h"},
            "grid": {"baseStepS": self.base_step,
                     "rule": "steps end on grid epochEt + m*baseStepS (first/last may be partial); each step of "
                             "length h is split into 2^level equal substeps, level from the state at the step start"},
            "stepControl": {"etaSun": self.eta_sun, "etaPlanet": self.eta_planet, "etaEncounter": self.eta_enc,
                            "kmax": self.kmax,
                            "rule": "from the state at the step start and perturber positions at its start and end: "
                                    "tau_sun = sqrt(r_eff^3/GM_sun), r_eff = max(q_osc, r - |v| |h|); u_p = (x_p(end) "
                                    "- x_p(start))/h - v; d_min = max(closest distance of the straight path x_p - x "
                                    "+ u_p tau, tau between 0 and h, R_p); tau_p = min(d_min/|u_p|, "
                                    "sqrt(d_min^3/GM_p)); h_max = min(etaSun tau_sun, min_p eta_p tau_p), eta_p = "
                                    "etaEncounter if (GM_p/d_min^2)/(GM_sun/r^2) > encounterRatio else etaPlanet; in encounter mode "
                                    "also h_max <= etaEncounter tau_sun; "
                                    "level = clamp(ceil(log2(|h|/h_max)), 0, kmax) (0 when |h| <= h_max)",
                            "encounterRatio": self.enc_ratio,
                            "encounter": "if max_p (GM_p/d_min^2)/(GM_sun/r^2) > encounterRatio, the step's 2^level "
                                         "substeps are classical RK4 steps on the full acceleration (Sun + kick terms, "
                                         "perturbers evaluated at t, t + h/2, t + h) instead of the splitting"},
            "obliquityArcsec": OBLIQUITY_ARCSEC,
            "kepler": "universal variables (Stumpff c2, c3; Maclaurin series for |z| < 1), Laguerre-Conway n = 5, "
                      "stop after the iteration in which |ds| <= 1e-12 |s| (cubic convergence)",
        }


def build(ctx: BuildContext | None, t0: float, t1: float, ref_et: float, *, scheme: str = SCHEME,
          base_days: float = BASE_STEP_DAYS, eta_sun: float = ETA_SUN, eta_planet: float = ETA_PLANET, kmax: int = KMAX,
          eta_enc: float = ETA_ENCOUNTER, enc_ratio: float = ENC_RATIO, gr: bool = True, j2: bool = True) -> ForceModel:
    """Force model with planetary records covering [t0, t1] (TDB s past J2000); Earth's pole evaluated at ref_et."""
    spk = {(s.target, s.center): s for s in read_spk(planetary(ctx))}
    with pool(gm_kernel(ctx), pck(ctx)):
        mu_sun = gd("BODY10_GM")[0]
        sun_r = max(gd("BODY10_RADII"))
        gms, radii, names, ids = [], [], [], []
        for name, naif, _, rbody in PERTURBERS:
            gms.append(gd(f"BODY{naif}_GM")[0])
            radii.append(max(gd(f"BODY{rbody}_RADII")))
            names.append(name)
            ids.append(naif)
        # IAU_EARTH pole (pck00011: BODY399_POLE_RA/DEC polynomials in Julian centuries), no nutation.
        T = ref_et / (DAY_S * 36525.0)
        ra = math.radians(sum(c * T ** k for k, c in enumerate(gd("BODY399_POLE_RA"))))
        dec = math.radians(sum(c * T ** k for k, c in enumerate(gd("BODY399_POLE_DEC"))))
    pole = [math.cos(dec) * math.cos(ra), math.cos(dec) * math.sin(ra), math.sin(dec)]
    j2p = np.array([float(ids.index(399)) if j2 else -1.0, EARTH_J2, EARTH_J2_RADIUS_KM, *pole])
    keys = sorted({k for _, _, ch, _ in PERTURBERS for k in ch} | set(SUN_CHAIN))
    index = {k: i for i, k in enumerate(keys)}
    # Clamp the requested span to what every needed segment declares (DE442s: 1849-12-26 .. 2150-01-22).
    t0 = max(t0, max(spk[k].start for k in keys))
    t1 = min(t1, min(spk[k].end for k in keys))
    blobs, segs, off = [], [], 0
    for k in keys:
        s = restrict(spk[k], t0, t1)
        if s.type != 2:
            raise ValueError(f"segment {k} is SPK type {s.type}; the small-body kernels evaluate type 2 only")
        blobs.append(s.records.reshape(-1))
        segs.append([off, s.n, s.rsize, s.ncoef, s.init, s.intlen, s.start, s.end])
        off += s.records.size
    chains = -np.ones((len(PERTURBERS), 2), dtype=np.int64)
    for p, (_, _, ch, _) in enumerate(PERTURBERS):
        for j, k in enumerate(ch):
            chains[p, j] = index[k]
    drift, kick = SCHEMES[scheme]
    return ForceModel(
        mu_sun=mu_sun, gm=np.array(gms), radius=np.array(radii + [sun_r]), data=np.concatenate(blobs),
        segs=np.array(segs, dtype=np.float64), chains=chains, sun_chain=np.array([index[SUN_CHAIN[0]]]),
        drift_c=np.array(drift), kick_d=np.array(kick), scheme=scheme, base_step=base_days * DAY_S,
        eta_sun=eta_sun, eta_planet=eta_planet, eta_enc=eta_enc, kmax=kmax, enc_ratio=enc_ratio, j2p=j2p, gr=gr, names=names, ids=ids,
        span=(max(s[6] for s in segs), min(s[7] for s in segs)))


def propagate(model: ForceModel, states: np.ndarray, t0: np.ndarray, t1: float, grid0: float, ng: np.ndarray,
              has_ng: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """sb_dynamics.propagate_many with this model: states (N, 6) in place from t0[i] to t1 on the grid anchored at
    grid0. Returns (status (N,), stats (N, 3): substeps, max level, encounter substeps)."""
    from . import sb_dynamics as dyn
    return dyn.propagate_many(states, np.asarray(t0, dtype=np.float64), float(t1), float(grid0), model.base_step,
                              *model.args(), ng, has_ng, *model.ctrl())
