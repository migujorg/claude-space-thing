"""Ring components (rings.json `components`, kind 'ring-components-v1'; schema `RingComponentModel` in
app/src/data/schema.ts): the narrow, eccentric and dusty rings of Jupiter, Uranus and Neptune, drawn one by one.

Each component is a band between an inner and an outer edge. An edge is a precessing, inclined keplerian ellipse with
optional normal modes (French et al. 2024, Eqs. 1, 5, 6, 8):

    r(λ, t) = a(1 − e²)/(1 + e cos(λ − ϖ0 − ϖ̇ (t − t0))) − Σ A_m cos(m(λ − Ω_P (t − t0) − δ_m))
    z(λ, t) = a sin i · sin(λ − Ω0 − Ω̇ (t − t0))

(λ: inertial longitude in the ring plane from the ascending node of the planet's equator on the ICRF equator, in the
direction of orbital motion; for m = 0 the mode argument is −(Ω_P (t − t0) + δ_0)). A circular edge has e = i = 0 and no modes. Across the band, u = (r − r_in)/(r_out − r_in)
and the profile gives the normal optical depth τ_ref(u) measured where the band was `widthRefKm` wide; elsewhere
τ = τ_ref(u) · W_ref / W(λ) when `widthScaling` is set (the ring's material per unit length is conserved along an
eccentric ring: streamline mass conservation, with τ taken proportional to surface density), times an optional
longitudinal factor f(φ) (Neptune's arcs, φ = λ − λ0 − n (t − t_arc)).

Light (per CIE channel c, μ = |sin B|, μ0 = |sin B′|, α the phase angle; Chandrasekhar 1960, as for Saturn):
    layer (macroscopic particles, many-particle-thick layer):
        lit   I/F = L_c(α) · μ0/(4(μ+μ0)) · [1 − exp(−τ(1/μ + 1/μ0))]
        unlit I/F = L_c(α) · μ0/(4|μ−μ0|) · |exp(−τ/μ) − exp(−τ/μ0)|
    thin (dust, optically thin, both faces):  I/F = D_c(α) · τ/(4μ)
with L_c = layer.scale · table(α) and D_c = thin.scale · table(α) from the named phase-function tables. A component
whose profile is a brightness (normal I/F at a reference phase) rather than an optical depth has `opticalDepthKnown`
false: it scatters as `thin` but does not absorb.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

# Phase grid for the tables (degrees): dense where dust forward scattering rises steeply. The renderer interpolates
# log(value) linearly in α between nodes.
PHASE_GRID = (0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 7.5, 10.0, 12.5, 15.0, 20.0, 25.0, 30.0, 40.0, 50.0, 60.0, 70.0,
              80.0, 90.0, 100.0, 110.0, 120.0, 130.0, 140.0, 145.0, 150.0, 155.0, 160.0, 165.0, 168.0, 170.0, 172.0,
              173.5, 175.0, 176.0, 177.0, 177.5, 178.0, 178.5, 179.0, 179.25, 179.5)

J2000_JD = 2451545.0
DAY = 86400.0


def et_of_jd_tdb(jd: float) -> float:
    return (jd - J2000_JD) * DAY


def et_of_tdb_calendar(y: int, mo: int, d: int, h: float = 0.0) -> float:
    """TDB calendar date (Gregorian) -> seconds past J2000 TDB."""
    a = (14 - mo) // 12
    yy, mm = y + 4800 - a, mo + 12 * a - 3
    jdn = d + (153 * mm + 2) // 5 + 365 * yy + yy // 4 - yy // 100 + yy // 400 - 32045
    return et_of_jd_tdb(jdn - 0.5 + h / 24.0)


# ---------------------------------------------------------------------------------------------- phase functions
def power_law(alpha_deg, n: float) -> np.ndarray:
    """Disk-integrated particle phase function Φ(α) = ((180° − α)/180°)^n, Φ(0) = 1: the Callisto-like form that
    Salo & French (2010) use for Saturn's ring particles (n = 3.09, after Dones et al. 1993)."""
    a = np.asarray(alpha_deg, float)
    return np.clip((180.0 - a) / 180.0, 0.0, None) ** n


def phase_integral(phi, n_steps: int = 20001) -> float:
    """q = 2 ∫ Φ(α) sin α dα over 0..π (Φ normalized to 1 at α = 0)."""
    a = np.linspace(0.0, 180.0, n_steps)
    y = phi(a) * np.sin(np.radians(a))
    return float(2.0 * np.trapezoid(y, np.radians(a)))


def henyey_greenstein(g: float, theta_deg) -> np.ndarray:
    """p(g, θ) = (1/4π)(1 − g²)/(1 + g² − 2g cos θ)^{3/2}, θ the scattering angle (= 180° − α)."""
    c = np.cos(np.radians(np.asarray(theta_deg, float)))
    return (1.0 - g * g) / (4.0 * math.pi * (1.0 + g * g - 2.0 * g * c) ** 1.5)


# Hedman & Stark (2015), ApJ 811, 67, Table 7: best 3-component HG fit to the measured scattering phase function of
# Saturn's G ring (Cassini ISS, scattering angles 0.5-170°; χ²/ν = 0.71).
G_RING_HG3 = ((0.995, 0.643), (0.665, 0.176), (0.035, 0.181))


def g_ring_spf(theta_deg) -> np.ndarray:
    return sum(w * henyey_greenstein(g, theta_deg) for g, w in G_RING_HG3)


def g_ring_vs_phase(alpha_deg) -> np.ndarray:
    return g_ring_spf(180.0 - np.asarray(alpha_deg, float))


# ---------------------------------------------------------------------------------------------- JSON pieces
def phase_table(name: str, values: np.ndarray, label: str, sources: list[str], method: str,
                grid=PHASE_GRID, domain=(0.0, 180.0)) -> dict:
    """A phase-function table: values[k] = (X, Y, Z, S) at grid[k] (dimensionless; scaled per component)."""
    v = np.asarray(values, float)
    if v.ndim == 1:
        v = np.repeat(v[:, None], 4, axis=1)
    if v.shape != (len(grid), 4) or not np.all(np.isfinite(v)) or np.any(v < 0):
        raise ValueError(f"{name}: bad phase table")
    payload = {"name": name, "phaseDeg": [float(x) for x in grid],
               "valuesXYZS": [[float(f"{x:.6g}") for x in row] for row in v],
               "minPhaseDeg": float(domain[0]), "maxPhaseDeg": float(domain[1])}
    # Keep the renderer's flat fields as compatibility aliases of the canonical Sourced payload.
    return {**payload, "value": payload if label != "unknown" else None,
            "label": label, "sources": list(sources), "method": method}


def edge(a: float, ae: float = 0.0, varpi0: float = 0.0, varpidot: float = 0.0, asini: float = 0.0,
         node0: float = 0.0, nodedot: float = 0.0, modes: list[dict] | None = None) -> dict:
    return {"a": a, "ae": ae, "varpi0Deg": varpi0, "varpiDotDegPerDay": varpidot, "aSinI": asini,
            "node0Deg": node0, "nodeDotDegPerDay": nodedot, "modes": modes or []}


def edge_radius(e: dict, lam_deg, t_days) -> np.ndarray:
    """Radius of an edge (dict as from `edge`) at inertial longitude λ (deg), t days after the model epoch."""
    lam = np.radians(np.asarray(lam_deg, float))
    a = e["a"]
    ecc = e["ae"] / a
    f = lam - np.radians(e["varpi0Deg"] + e["varpiDotDegPerDay"] * t_days)
    r = a * (1 - ecc * ecc) / (1 + ecc * np.cos(f))
    for m in e["modes"]:
        r = r - m["amplitudeKm"] * np.cos(mode_argument(m, lam, t_days))
    return r


def mode_argument(m: dict, lam_rad, t_days):
    """m θ with θ = λ − Ω_P (t − t0) − δ_m (French et al. 2024, Eqs. 5-6). For m = 0 (the γ ring's radial
    oscillation) the argument is −(Ω_P (t − t0) + δ_0): Ω_P is then the oscillation frequency."""
    ph = np.radians(m["patternSpeedDegPerDay"] * t_days + m["phaseDeg"])
    if m["m"] == 0:
        return -ph + 0.0 * np.asarray(lam_rad)
    return m["m"] * (np.asarray(lam_rad) - ph)


def tiled_bins(n: int = 20) -> tuple[float, float, np.ndarray]:
    """(u_start, u_step, centres) of n profile bins that exactly tile the band 0 <= u <= 1 (profile values are bin
    averages centred on u_start + j u_step)."""
    step = 1.0 / n
    return 0.5 * step, step, (np.arange(n) + 0.5) * step


@dataclass
class Prov:
    """Provenance of one aspect of a component (geometry, optical depth, reflectance)."""
    label: str
    sources: list[str]
    method: str

    def json(self, value, inputs: list[str] | None = None) -> dict:
        if (value is None) != (self.label == "unknown"):
            raise ValueError("component provenance: value must be null iff label is unknown")
        return {"value": value, "label": self.label,
                "sources": sorted(set(self.sources + (inputs or []))), "method": self.method}


@dataclass
class Component:
    id: str
    name: str
    inner: dict
    outer: dict
    u_start: float
    u_step: float
    profile: np.ndarray            # τ_ref(u) (or normal I/F at reference phase when not optical depth)
    width_ref_km: float
    width_scaling: bool
    optical_depth_known: bool
    geometry: Prov
    optical_depth: Prov
    reflectance: Prov
    kind: str = "sheet"
    layer: dict | None = None      # {"phaseFunction": id, "scale": float}
    thin: dict | None = None
    arcs: dict | None = None
    vertical: dict | None = None
    geometry_validity: dict | None = None  # observation-supported interval; not an extrapolation warranty
    notes: dict = field(default_factory=dict)

    def json(self) -> dict:
        d = {"id": self.id, "name": self.name, "kind": self.kind, "inner": self.inner, "outer": self.outer,
             "profile": {"uStart": round(self.u_start, 6), "uStep": round(self.u_step, 6),
                         "values": [float(f"{x:.5g}") for x in self.profile],
                         "widthRefKm": round(self.width_ref_km, 4), "widthScaling": self.width_scaling,
                         "opticalDepthKnown": self.optical_depth_known},
             "layer": self.layer, "thin": self.thin}
        if self.arcs:
            d["arcs"] = self.arcs
        if self.vertical:
            d["vertical"] = self.vertical
        if self.geometry_validity:
            d["geometryValidity"] = self.geometry_validity
        geometry = {k: d[k] for k in ("kind", "inner", "outer", "vertical", "geometryValidity") if k in d}
        reflectance = {"layer": self.layer, "thin": self.thin}
        if self.arcs:
            geometry["arcs"] = {k: v for k, v in self.arcs.items() if k != "factor"}
            reflectance["longitudinalFactor"] = self.arcs["factor"]
        if not self.optical_depth_known:
            # This profile is a reference brightness, not a measured optical depth.
            reflectance["profile"] = d["profile"]
        known = lambda p, v: v if p.label != "unknown" else None
        d["provenance"] = {
            "geometry": self.geometry.json(known(self.geometry, geometry)),
            "opticalDepth": self.optical_depth.json(
                known(self.optical_depth, {"profile": d["profile"]}),
                self.geometry.sources if self.optical_depth.label != "unknown" else []),
            "reflectance": self.reflectance.json(
                known(self.reflectance, reflectance),
                self.geometry.sources + self.optical_depth.sources if self.reflectance.label != "unknown" else []),
        }
        return d


FORMULA = ("Per component: r_in(λ,t), r_out(λ,t) from the edge ellipses (r = a(1−e²)/(1+e cos(λ−ϖ0−ϖ̇t)) − Σ A_m "
           "cos(m(λ−Ω_P t−δ_m)), t in days from epochEt; the band lies in the plane z = aSinI·sin(λ−Ω0−Ω̇t) of its "
           "outer edge); u = (r−r_in)/(r_out−r_in); τ = profile(u)·(widthRefKm/W if widthScaling)·arcs(λ−λ0−n t). "
           "I/F_c = L_c(α)·μ0/(4(μ+μ0))·[1−e^{−τ(1/μ+1/μ0)}] (lit) or L_c(α)·μ0/(4|μ−μ0|)·|e^{−τ/μ}−e^{−τ/μ0}| "
           "(unlit) + D_c(α)·τ/(4μ) (both faces); L_c = layer.scale·table, D_c = thin.scale·table (log-linear in "
           "α); radiance = I/F_c·E☉,c(d)/π. Components with opticalDepthKnown false scatter (thin) but do not "
           "absorb. Torus components (vertical) spread τ over height with the stated law and are integrated along "
           "the line of sight (single scattering). Outside geometryValidity or where W <= 0, geometry is unknown: "
           "no light or extinction, only a not-measured annotation over the component's radial bounds. No width floor.")


def worst_label(*labels: str) -> str:
    from ..schema import worst
    return worst(*labels)


def model_json(components: list[Component], tables: dict[str, dict], epoch_et: float, notes: str,
               pole_sense: int = 1) -> dict:
    """pole_sense: +1 when the ring particles' orbital angular momentum is along the IAU north pole, -1 when opposite
    (Uranus: the IAU pole is the one north of the invariable plane, its rotation and rings are retrograde)."""
    return {"kind": "ring-components-v1", "formula": FORMULA, "epochEt": epoch_et,
            "longitudeOrigin": "ascending node of the planet's equator (pole along its angular momentum) on the "
                               "ICRF (J2000) equator; longitudes increase in the direction of orbital motion",
            "poleSense": pole_sense,
            "phaseFunctions": tables, "components": [c.json() for c in components], "notes": notes}


def components_label(components: list[Component], tables: dict[str, dict]) -> str:
    """Worst label among the model's values. A part labelled unknown carries no value (an optical depth or a
    reflectance not measured): the renderer shows it as not measured (hatched) or omits it, so it does not make the
    whole model unknown; it stays labelled per component."""
    labels = []
    for c in components:
        labels += [c.geometry.label, c.optical_depth.label, c.reflectance.label]
    labels += [t["label"] for t in tables.values()]
    known = [x for x in labels if x != "unknown"]
    return worst_label(*known) if known else "unknown"


# ---------------------------------------------------------------------------------------------- photometry (reference)
def layer_lit(tau, mu, mu0):
    return mu0 / (4.0 * (mu + mu0)) * (1.0 - np.exp(-np.asarray(tau, float) * (1.0 / mu + 1.0 / mu0)))


def interp_table(table: dict, alpha_deg: float, channel: int = 1) -> float:
    """Log-linear interpolation in α of a phase table (as the renderer does)."""
    g = np.asarray(table["phaseDeg"])
    v = np.asarray(table["valuesXYZS"])[:, channel]
    lv = np.log(np.maximum(v, 1e-30))
    return float(np.exp(np.interp(alpha_deg, g, lv)))
