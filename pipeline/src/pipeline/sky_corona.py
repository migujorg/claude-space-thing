"""The solar corona near the Sun: the K-corona (Thomson scattering of photospheric light by coronal electrons) as an
electron-density model the renderer integrates along any line of sight, and the published F-corona brightness
against which the zodiacal-light model (sky_zodi) is checked where it meets the corona.

K-corona
* Measured brightness: van de Hulst (1950), BAN 11, 135, Eqs. 5-9 (transcribed in sky_tables/vandehulst_1950.json):
  surface brightness in the plane of the sky, as sums of power laws of the apparent distance rho from the Sun's
  centre (R_sun), for the maximum phase of the solar cycle (circular corona) and for the minimum phase (equatorial
  regions over 0.7 of the circumference, polar regions over 0.3), from Baumbach's eclipse compilation with the
  F-corona removed and new photoelectric absolute measures. K_max = c K_min with c = 1.78.
* Physics: Thomson scattering of a linearly limb-darkened Sun, I(mu) = I0 (1 - u + u mu), by free electrons
  (Minnaert 1930; closed forms of the irradiance integrals as in Inhester 2015, arXiv:1512.00651, App. A):
      dB/ds = (pi r_e^2 / 2) I0 n_e(r) [2((1-u) C + u D) - sin^2 chi ((1-u) A + u B)]
  with Omega = asin(1/r) the Sun's angular radius seen from the electron, chi the angle between the radius vector
  and the line of sight, and
      A = cos Om sin^2 Om,                 C = 4/3 - cos Om - cos^3 Om / 3,
      B = -(1/8)[1 - 3 sin^2 Om - (1 + 3 sin^2 Om) G],   D = (1/8)[5 + sin^2 Om - (5 - sin^2 Om) G],
      G = (cos^2 Om / sin Om) ln((1 + sin Om) / cos Om).
  Brightness is expressed in units of the mean radiance of the solar disk, B_sun = I0 (1 - u/3) (van de Hulst's
  unit), so the K-corona's colour is that of the disk-integrated photospheric spectrum.
* Electron densities: each measured brightness law is inverted, as van de Hulst (1950) and Saito et al. (1977) did,
  by fitting n_e(r) = sum_k a_k r^-d_k (non-negative a_k) so that the forward integral reproduces it (distant
  observer; `fit_density`). The polar density is fitted inside the latitude-blended model (electrons in the
  equatorial belt along a polar line of sight included), so the model reproduces both laws.
* Solar-cycle phase: van de Hulst's phase (Mitchell's definition: 0 at minimum, 1 at maximum, linear in time between
  those epochs), from the SILSO smoothed sunspot-number extrema and, for the next minimum, the NOAA SWPC prediction.
  Between the phases the density is interpolated linearly (van de Hulst's Fig. 1: total brightness rising about
  linearly with phase).

F-corona: `f_corona_references()` collects the published brightness (van de Hulst 1950 Eq. 7; Saito et al. 1977
Tables II-III, Skylab; Leinert et al. 1998 Table 23 after Koutchmy & Lamy 1985) in units of B_sun.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

TABLES = Path(__file__).parent / "sky_tables"

R_E_CM = 2.8179403262e-13          # classical electron radius (CODATA 2018)
R_SUN_KM = 695700.0                # IAU 2015 nominal solar radius (= pck00011 BODY10_RADII, bodies.json)
AU_KM = 149597870.7
#: (pi r_e^2 / 2) x R_sun: brightness per unit I0 contributed by 1 electron/cm^3 over 1 R_sun of path.
K0_CM3 = np.pi * R_E_CM ** 2 / 2.0 * R_SUN_KM * 1e5
R_MAX = 30.0                       # R_sun: outer edge of the K-corona model (module docstring of the product)


def vandehulst() -> dict:
    return json.loads((TABLES / "vandehulst_1950.json").read_text(encoding="utf-8"))


def saito1977() -> dict:
    return json.loads((TABLES / "saito_1977.json").read_text(encoding="utf-8"))


def power_law(coeffs: dict[str, float], rho: np.ndarray) -> np.ndarray:
    """sum_n C_n rho^-n for {"n": C_n} (string keys, as in the JSON tables)."""
    rho = np.asarray(rho, float)
    return sum(float(c) * rho ** -float(n) for n, c in coeffs.items())


def law(name: str, rho: np.ndarray) -> np.ndarray:
    """van de Hulst (1950) brightness law `name` (K_max, K_min, F, K_pole, K_pole_plus_F) in units of B_sun."""
    v = vandehulst()
    return power_law(v["laws"][name]["coeffs"], rho) * float(v["unit_B_sun"])


def ring_total(coeffs: dict[str, float], r1: float, r2: float) -> float:
    """van de Hulst Eq. 10: total brightness of the ring r1..r2 (r2 = inf allowed) in units of the Sun's total
    brightness, for a law with coefficients C_n in units of the mean surface brightness."""
    tot = 0.0
    for n, c in coeffs.items():
        n = float(n)
        t2 = 0.0 if np.isinf(r2) else r2 ** (2 - n)
        tot += (r1 ** (2 - n) - t2) * 2 * float(c) / (n - 2)
    return tot


# ------------------------------------------------------------------------------------------------ Thomson kernel

def minnaert(r: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Minnaert's A, B, C, D at distance r >= 1 (R_sun) from the Sun's centre (module docstring). The closed forms
    lose precision as r grows (O(1) terms cancel to O(1/r^2)); within the model's r <= R_MAX = 30 that costs 3 of
    float64's 16 digits (the tests compare them with a direct integration over the solar disk)."""
    r = np.asarray(r, float)
    s = np.minimum(1.0 / r, 1.0)
    c = np.sqrt(np.maximum(1.0 - s * s, 0.0))
    with np.errstate(divide="ignore", invalid="ignore"):
        g = np.where(c > 0, c * c / s * np.log((1.0 + s) / np.maximum(c, 1e-300)), 0.0)
    a = c * s * s
    cc = 4.0 / 3.0 - c - c ** 3 / 3.0
    b = -(1.0 - 3.0 * s * s - (1.0 + 3.0 * s * s) * g) / 8.0
    d = (5.0 + s * s - (5.0 - s * s) * g) / 8.0
    return a, b, cc, d


def kernel(r: np.ndarray, sin2chi: np.ndarray, u: float) -> np.ndarray:
    """Total scattered brightness per electron, in units of (pi r_e^2 / 2) I0: 2((1-u)C + uD) - sin^2 chi ((1-u)A + uB)."""
    a, b, c, d = minnaert(r)
    return 2.0 * ((1 - u) * c + u * d) - sin2chi * ((1 - u) * a + u * b)


def kernel_polarized(r: np.ndarray, sin2chi: np.ndarray, u: float) -> np.ndarray:
    """Polarized brightness pB per electron, same units: sin^2 chi ((1-u)A + uB)."""
    a, b, _, _ = minnaert(r)
    return sin2chi * ((1 - u) * a + u * b)


def los_distant(n_fn, rho: np.ndarray, u: float, r_max: float = R_MAX, nodes: int = 48,
                polarized: bool = False) -> np.ndarray:
    """K-corona brightness (units of B_sun) for a distant observer at apparent distance rho (R_sun) from the Sun's
    centre. The electron density is n_fn(r, t), t = s / r = sin(theta), where s is the distance along the line of
    sight from its closest approach (the callers turn t into a heliographic latitude). Gauss-Legendre in theta with
    s = rho tan(theta), the line of sight cut where r = r_max."""
    rho = np.atleast_1d(np.asarray(rho, float))
    x, w = np.polynomial.legendre.leggauss(nodes)
    out = np.zeros(rho.size)
    for i, p in enumerate(rho):
        if p >= r_max:
            continue
        th1 = np.arccos(p / r_max)
        th = th1 * x                       # symmetric in theta
        r = p / np.cos(th)
        ds = p / np.cos(th) ** 2 * th1     # ds/dx
        sin2chi = np.cos(th) ** 2
        k = kernel_polarized(r, sin2chi, u) if polarized else kernel(r, sin2chi, u)
        out[i] = np.sum(w * n_fn(r, np.sin(th)) * k * ds)
    return out * K0_CM3 / (1.0 - u / 3.0)


# ------------------------------------------------------------------------------------------------ geometry & model

@dataclass
class LatitudeBlend:
    """Weight of the equatorial density at heliographic latitude phi (min phase): 1 for |phi| <= lat0, 0 for
    |phi| >= lat1, linear in between (van de Hulst: polar regions over 0.3 of the circumference -> boundary at
    63 deg; the polar corona separated by a density minimum near 70 deg)."""
    lat0_deg: float
    lat1_deg: float

    def w(self, sin_lat: np.ndarray) -> np.ndarray:
        lat = np.degrees(np.arcsin(np.clip(np.abs(sin_lat), 0.0, 1.0)))
        return np.clip((self.lat1_deg - lat) / (self.lat1_deg - self.lat0_deg), 0.0, 1.0)


def density(coef: dict[str, float], r: np.ndarray) -> np.ndarray:
    return power_law(coef, r)


def sector_boundary_deg() -> float:
    """van de Hulst's plane-of-sky boundary between equatorial and polar sectors at minimum: two polar sectors of
    (0.3 x 360 deg) / 2 each, centred on the poles, i.e. 90 x 0.3 = 27 deg from each pole -> 63 deg."""
    v = vandehulst()["model"]
    return 90.0 - 90.0 * float(v["min_phase_sector_fractions"]["polar"])


def ramp_half_width_deg() -> float:
    """Half-width of the equatorial-to-polar density ramp: from the sector boundary (63 deg) to the density minimum
    that separates the polar corona (70 deg, van de Hulst's abstract)."""
    return float(vandehulst()["model"]["polar_density_minimum_lat_deg"]) - sector_boundary_deg()


EXPONENTS = (20.0, 18.0, 16.0, 14.0, 12.0, 10.0, 9.0, 8.0, 7.0, 6.0, 5.0, 4.0, 3.5, 3.0, 2.5, 2.0, 1.5)


def fit_density(target, rho: np.ndarray, u: float, basis_exponents=EXPONENTS, fixed=None, w_basis=None
                ) -> tuple[dict[str, float], float]:
    """Non-negative a_k such that the forward integral of sum a_k r^-d_k (times w_basis(r, t) if given) plus the
    fixed contribution `fixed(rho)` reproduces target(rho), weighted in relative terms. Returns ({d: a}, max |rel|)."""
    from scipy.optimize import nnls
    y = np.asarray(target(rho), float)
    base = np.zeros_like(y) if fixed is None else fixed(rho)
    cols = []
    for dk in basis_exponents:
        fn = (lambda dk: (lambda r, t: r ** -dk * (1.0 if w_basis is None else w_basis(r, t))))(dk)
        cols.append(los_distant(fn, rho, u))
    M = np.stack(cols, axis=1)
    scale = M.max(axis=0)
    a, _ = nnls(M / scale / y[:, None], (y - base) / y)
    a = a / scale
    pred = M @ a + base
    coef = {f"{dk:g}": float(ak) for dk, ak in zip(basis_exponents, a) if ak > 0}
    return coef, float(np.max(np.abs(pred / y - 1)))


@dataclass
class CoronaModel:
    u: float                       # linear limb-darkening coefficient (photopic Y)
    eq: dict[str, float]           # n_e(r) equatorial, minimum phase (cm^-3, r in R_sun)
    pole: dict[str, float]         # n_e(r) polar, minimum phase
    c_max: float                   # n_max = c_max x eq, circular
    blend: LatitudeBlend
    r_max: float = R_MAX

    def n(self, r: np.ndarray, sin_lat: np.ndarray, phase: float) -> np.ndarray:
        w = self.blend.w(sin_lat)
        ne, npol = density(self.eq, r), density(self.pole, r)
        out = (1 - phase) * (w * ne + (1 - w) * npol) + phase * self.c_max * ne
        return np.where((r >= 1.0) & (r <= self.r_max), out, 0.0)


def _fit_pole(eq: dict[str, float], blend: LatitudeBlend, u: float, rho_pole: np.ndarray):
    # along a polar line of sight (distant observer in the equatorial plane): sin(lat) = rho / r = cos(theta)
    fixed = lambda p: los_distant(lambda r, t: density(eq, r) * blend.w(np.sqrt(1 - t * t)), p, u)  # noqa: E731
    return fit_density(lambda p: law("K_pole", p), rho_pole, u, fixed=fixed,
                       w_basis=lambda r, t: 1.0 - blend.w(np.sqrt(1 - t * t)))


def build_model(u: float) -> tuple[CoronaModel, dict]:
    """Fit the minimum-phase densities to van de Hulst's laws (distant observer in the solar equatorial plane).

    * Equatorial density: to K_min over 1.01 - fit_max_rho R_sun. A line of sight over the equator stays at latitude 0,
      so this fit does not depend on the latitude structure.
    * The 3-D latitude structure: equatorial density up to latitude lat_b - h, polar density beyond lat_b + h, linear
      in between (h = 7 deg, `ramp_half_width_deg`). van de Hulst's 0.7 / 0.3 split is one of position angles on the
      sky; seen in projection a belt reaching 63 deg in latitude would put more electrons on a polar line of sight
      than his polar law allows. lat_b is therefore fitted so that the model's total minimum-phase K brightness
      (r >= 1, all position angles) equals his Table I value for the 0.7 / 0.3 sector model (K'_min, 0.569e-6 of
      the Sun), the polar density being refitted to K_pole over 1.01 - polar_fit_max_rho R_sun for each lat_b."""
    v = vandehulst()
    mdl = v["model"]
    rho_eq = np.geomspace(1.01, float(mdl["fit_max_rho"]), 90)
    eq, err_eq = fit_density(lambda p: law("K_min", p), rho_eq, u)
    rho_pole = np.geomspace(1.01, float(mdl["polar_fit_max_rho"]), 50)
    half = ramp_half_width_deg()
    target = float(v["table1"]["K_min_weighted"][3]) * 1e-6
    c_max = float(mdl["c"])

    def make(lat_b):
        blend = LatitudeBlend(lat_b - half, lat_b + half)
        pole, err = _fit_pole(eq, blend, u, rho_pole)
        m = CoronaModel(u=u, eq=eq, pole=pole, c_max=c_max, blend=blend)
        return m, err, ring_total_model(m, 1.0, R_MAX, 0.0)

    lo, hi = 20.0, sector_boundary_deg()
    m_lo, _, t_lo = make(lo)
    m_hi, _, t_hi = make(hi)
    if not (t_lo < target < t_hi):
        raise RuntimeError(f"corona: K'_min total {target:.3e} not bracketed ({t_lo:.3e} at {lo} deg, {t_hi:.3e} "
                           f"at {hi} deg)")
    for _ in range(12):
        mid = 0.5 * (lo + hi)
        m, err_pole, t = make(mid)
        if t < target:
            lo = mid
        else:
            hi = mid
    lat_b = 0.5 * (lo + hi)
    m, err_pole, t = make(lat_b)
    return m, {"maxRelErrEquator": err_eq, "maxRelErrPole": err_pole,
               "fitRangeEquator": [float(rho_eq[0]), float(rho_eq[-1])],
               "fitRangePole": [float(rho_pole[0]), float(rho_pole[-1])],
               "beltLatitudeDeg": lat_b, "rampHalfWidthDeg": half, "minPhaseTotal": t, "minPhaseTotalTarget": target}


def brightness_distant(m: CoronaModel, rho: np.ndarray, pa_from_north_deg: float, phase: float,
                       polarized: bool = False) -> np.ndarray:
    """K brightness (B_sun) seen from far away in the Sun's equatorial plane at position angle PA (0 = solar north,
    90 = equator) and apparent distance rho. The line of sight: x = rho (sin PA, cos PA) in the plane of the sky
    (equator, axis), s along the view direction (perpendicular to both): sin(lat) = rho cos(PA) / r."""
    cpa = np.cos(np.radians(pa_from_north_deg))
    return los_distant(lambda r, t: m.n(r, np.clip(np.sqrt(np.maximum(1 - t * t, 0)) * cpa, -1, 1), phase),
                       rho, m.u, m.r_max, polarized=polarized)


# ------------------------------------------------------------------------------------------------ solar-cycle phase

def et_of_iso(iso: str) -> float:
    """TDB seconds past J2000 of a TDB calendar time 'YYYY-MM-DDTHH:MM:SS' (month-level uses only)."""
    import datetime as dt
    t = dt.datetime.fromisoformat(iso)
    return (t - dt.datetime(2000, 1, 1, 12, 0, 0)).total_seconds()


def decimal_year(et: float) -> float:
    """Decimal year of TDB seconds past J2000 (the convention of the SILSO files: mid-month = (m - 0.5) / 12)."""
    return 2000.0 + (et / 86400.0 + 0.5) / 365.25


def cycle_phase(t_year: float, t_min_prev: float, t_max: float, t_min_next: float) -> float:
    """van de Hulst's phase (Mitchell): 0 at minimum, 1 at maximum, linear in time in between."""
    if t_year <= t_max:
        return float(np.clip((t_year - t_min_prev) / (t_max - t_min_prev), 0.0, 1.0))
    return float(np.clip(1.0 - (t_year - t_max) / (t_min_next - t_max), 0.0, 1.0))


def silso_extrema(csv_path: Path, after: float) -> tuple[tuple[float, float, str], tuple[float, float, str]]:
    """(minimum, maximum) of the SILSO 13-month smoothed total sunspot number (SN_ms_tot_V2.0.csv): the minimum
    within 6 years after `after` and the maximum within 7 years after that minimum: (decimal year, SN, 'YYYY-MM')."""
    rows = []
    for ln in csv_path.read_text(encoding="utf-8").splitlines():
        f = [x.strip() for x in ln.split(";")]
        if len(f) >= 4 and float(f[3]) >= 0:
            rows.append((float(f[2]), float(f[3]), f"{f[0]}-{int(f[1]):02d}"))
    mn = min((x for x in rows if after < x[0] < after + 6), key=lambda x: x[1])
    mx = max((x for x in rows if mn[0] < x[0] <= mn[0] + 7), key=lambda x: x[1])
    return mn, mx


def swpc_value(json_path: Path, month: str) -> float:
    """NOAA SWPC predicted smoothed sunspot number for 'YYYY-MM'."""
    d = json.loads(json_path.read_text(encoding="utf-8"))
    return float(next(x["predicted_ssn"] for x in d if x["time-tag"] == month))


def swpc_next_minimum(json_path: Path) -> tuple[float, float, str, bool]:
    """Epoch of the minimum of NOAA SWPC's predicted smoothed sunspot number: (decimal year, SN, 'YYYY-MM',
    at_end) — at_end = the prediction is still falling at its last month (the minimum is then no earlier)."""
    d = json.loads(json_path.read_text(encoding="utf-8"))
    vals = [(int(x["time-tag"][:4]) + (int(x["time-tag"][5:7]) - 0.5) / 12.0, float(x["predicted_ssn"]), x["time-tag"])
            for x in d]
    m = min(vals, key=lambda x: x[1])
    return m[0], m[1], m[2], m[2] == vals[-1][2]


# ------------------------------------------------------------------------------------------------ totals

def ring_total_model(m: CoronaModel, r1: float, r2: float, phase: float, n_pa: int = 19, n_rho: int = 64,
                     extra=None) -> float:
    """Brightness of the ring r1..r2 (plane of the sky, distant observer in the solar equatorial plane) in units of
    the Sun's total brightness (pi R_sun^2 B_sun), as van de Hulst's Table I: (1/pi) int int B rho drho dPA.
    `extra(rho)` adds a circular component (e.g. an F-corona law) in B_sun. Gauss-Legendre in ln(rho - 1 + 1e-3)
    (the brightness falls as rho^-17 at the limb) and in position angle."""
    r2 = min(r2, m.r_max)
    xg, wg = np.polynomial.legendre.leggauss(n_rho)
    a, b = np.log(r1 - 1 + 1e-3), np.log(r2 - 1 + 1e-3)
    t = 0.5 * (b - a) * xg + 0.5 * (a + b)
    rho = np.exp(t) + 1 - 1e-3
    w_rho = 0.5 * (b - a) * wg * np.exp(t)                 # d rho = e^t dt
    xp, wp = np.polynomial.legendre.leggauss(n_pa)
    pa = 45.0 * (xp + 1.0)                                  # quadrant 0..90 deg (symmetric about equator and axis)
    bb = np.stack([brightness_distant(m, rho, p, phase) for p in pa])      # (n_pa, n_rho)
    mean_pa = (wp @ bb) / 2.0
    if extra is not None:
        mean_pa = mean_pa + extra(rho)
    return float(2.0 * np.sum(w_rho * mean_pa * rho))


# ------------------------------------------------------------------------------------------------ F-corona (LASCO)

AU_RSUN = AU_KM / R_SUN_KM          # 215.03 R_sun per AU (Leinert et al. 1998 use 214.94, Allen 1985)


def lamy2022() -> dict:
    return json.loads((TABLES / "lamy_2022_table5.json").read_text(encoding="utf-8"))


def lasco_cells() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The LASCO reference map (Lamy et al. 2022, Table 5) as (rho [R_sun, impact parameter for an observer at
    1 AU], sin(psi) [psi = angle from the zodiacal cloud's plane of symmetry, seen around the Sun], B [B_sun]),
    with the table's rows read as beta and its columns as lambda - lambda_sun (see the JSON's _axes_as_printed)."""
    t = lamy2022()
    unit = float(t["unit_B_sun"])
    rho, sp, b = [], [], []
    for blk in ("inner", "outer"):
        bet = np.radians(t[blk]["row_deg"])       # rows: beta (see above)
        lam = np.radians(t[blk]["col_deg"])       # columns: lambda - lambda_sun
        for i, be in enumerate(bet):
            for j, la in enumerate(lam):
                v = t[blk]["values"][i][j]
                if v is None:
                    continue
                d = np.array([np.cos(be) * np.cos(la), np.cos(be) * np.sin(la), np.sin(be)])  # Sun at +x
                eps = np.arccos(d[0])
                rho.append(AU_RSUN * np.sin(eps))
                sp.append(d[2] / np.hypot(d[1], d[2]))
                b.append(v * unit)
    return np.array(rho), np.array(sp), np.array(b)


@dataclass
class FCoronaFit:
    """log10(B / B_sun) = P(x) + sin^2(psi) S(x), x = log10(rho / R_sun), polynomials in x (coefficients from x^0);
    outside [x_lo, x_hi] (the map's range) continued as power laws with the slopes at the edges, except that below
    x_lo the flattening term S stays at its edge value (the map is circular there by construction: the
    Koutchmy-Lamy model, identical along both axes, inside 1.5 R_sun; Lamy et al. 2022 Sect. 4.2)."""
    p: list[float]
    s: list[float]
    x_lo: float
    x_hi: float
    rms_dex: float
    max_dex: float
    n: int

    def _poly(self, c, x):
        return sum(ci * x ** i for i, ci in enumerate(c))

    def _dpoly(self, c, x):
        return sum(i * ci * x ** (i - 1) for i, ci in enumerate(c) if i)

    def log10b(self, rho: np.ndarray, sin_psi: np.ndarray) -> np.ndarray:
        x = np.log10(np.asarray(rho, float))
        xc = np.clip(x, self.x_lo, self.x_hi)
        s2 = np.asarray(sin_psi, float) ** 2
        val = self._poly(self.p, xc) + s2 * self._poly(self.s, xc)
        slope = self._dpoly(self.p, xc) + np.where(x > self.x_hi, s2 * self._dpoly(self.s, xc), 0.0)
        return val + slope * (x - xc)

    def b(self, rho, sin_psi):
        return 10.0 ** self.log10b(rho, sin_psi)


def fit_f_corona(deg_p: int = 3, deg_s: int = 2) -> FCoronaFit:
    rho, sp, b = lasco_cells()
    x = np.log10(rho)
    y = np.log10(b)
    cols = [x ** i for i in range(deg_p + 1)] + [sp ** 2 * x ** i for i in range(deg_s + 1)]
    M = np.stack(cols, axis=1)
    c, *_ = np.linalg.lstsq(M, y, rcond=None)
    res = M @ c - y
    return FCoronaFit(p=[float(v) for v in c[:deg_p + 1]], s=[float(v) for v in c[deg_p + 1:]],
                      x_lo=float(x.min()), x_hi=float(x.max()), rms_dex=float(np.sqrt(np.mean(res ** 2))),
                      max_dex=float(np.max(np.abs(res))), n=int(y.size))


# ------------------------------------------------------------------------------------------------ zodiacal model near the Sun

def zodi_near_sun(rho: np.ndarray, sin_psi: float, n_lon: int = 4, n: int = 6000) -> np.ndarray:
    """The zodiacal-light model (sky_zodi: Kelsall cloud + visible scattering fitted to Leinert Table 16) seen from
    1 AU at impact parameter rho (R_sun) and position angle psi from the ecliptic, in B_sun, averaged over n_lon
    positions of the Earth on its orbit. Fine quadrature (s = s_ca + h sinh t), unlike sky_zodi.S_GRID, which is
    too coarse near the Sun."""
    from . import sky_zodi as zl
    K = zl.Kelsall.load()
    fit, _ = zl.fit_visible_scattering(K)
    b_sun_in_s10 = float(zl.leinert_constants()["f_corona_table23"]["B_sun_in_S10sun"])
    out = np.zeros(np.size(rho))
    cps = np.sqrt(max(1.0 - sin_psi * sin_psi, 0.0))
    for lon in 2 * np.pi * np.arange(n_lon) / n_lon:
        obs = np.array([np.cos(lon), np.sin(lon), 0.0])
        e2 = np.array([-np.sin(lon), np.cos(lon), 0.0])
        perp = cps * e2 + sin_psi * np.array([0.0, 0.0, 1.0])
        for i, p in enumerate(np.atleast_1d(rho)):
            eps = np.arcsin(p / AU_RSUN)
            d = -np.cos(eps) * obs + np.sin(eps) * perp
            b = obs @ d
            h = np.sqrt(max(obs @ obs - b * b, 0.0))
            s1 = -b + np.sqrt(b * b - (obs @ obs - zl.R_OUT_AU ** 2))
            t = np.linspace(np.arcsinh(b / h), np.arcsinh((s1 + b) / h), n)
            s = -b + h * np.sinh(t)
            ds = h * np.cosh(t) * np.gradient(t)
            x = obs[None, :] + s[:, None] * d[None, :]
            r = np.linalg.norm(x, axis=1)
            th = np.arccos(np.clip(-(x @ d) / r, -1, 1))
            f = K.density(x[:, 0], x[:, 1], x[:, 2], lon) * zl.phase(th, fit.c0, fit.c1, fit.c2) / r ** 2
            out[i] += fit.albedo * np.sum(f * ds) / zl.S10_PER_SOLAR_FLUX_SR / b_sun_in_s10 / n_lon
    return out


def corona_checks(m: CoronaModel, ffit: "FCoronaFit", epochs: tuple[float, float, float], ph_ecl: float,
                  skylab_year: float, skylab_epochs: tuple[float, float, float], sn_2027: float | None = None,
                  sn_min: float | None = None, sn_max: float | None = None) -> dict:
    """The numbers docs/reports/sky.md quotes: totals vs van de Hulst Table I and the observed totals, the model vs
    Saito et al. (1977) at the Skylab epoch, and the F-corona (LASCO fit, zodiacal model, other references)."""
    v = vandehulst()
    out: dict = {"totals": {}}
    lasco_circ = lambda r: 0.5 * (ffit.b(r, 0.0 * r) + ffit.b(r, 1.0 + 0.0 * r))   # noqa: E731  (PA mean, approx.)
    for key, ph in (("phase0", 0.0), ("eclipse2027", ph_ecl), ("phase1", 1.0)):
        out["totals"][key] = {
            "phase": ph,
            "1.03-6": ring_total_model(m, 1.03, 6.0, ph) * 1e6,
            "1-30": ring_total_model(m, 1.0, R_MAX, ph) * 1e6,
            "K+F_lasco_1.03-6": ring_total_model(m, 1.03, 6.0, ph, extra=lasco_circ) * 1e6,
            "K+F_lasco_1.08-6": ring_total_model(m, 1.08, 6.0, ph, extra=lasco_circ) * 1e6}
    out["totals"]["vandehulst_table1"] = {k: v["table1"][k] for k in ("K_max", "K_min_weighted", "F", "K_max_plus_F",
                                                                      "K_min_weighted_plus_F")}
    out["totals"]["observed"] = v["total_brightness_observed"]
    # Saito et al. (1977) at the Skylab epoch
    ph_sky = cycle_phase(skylab_year, *skylab_epochs)
    s = saito1977()
    rr = np.array([2.5, 3.0, 4.0, 5.0])
    eq = brightness_distant(m, rr, 90.0, ph_sky)
    po = brightness_distant(m, rr, 0.0, ph_sky)
    bk_eq = np.array([next(x["B_K"] for x in s["table2"] if x["r"] == r) for r in rr])
    bk_po = np.array([next(x["B_K"] for x in s["table3_axisymmetric"] if x["r"] == r) for r in rr])
    out["saito1977"] = {"phase": ph_sky, "rho": rr.tolist(), "modelEquator": eq.tolist(), "saitoEquator": bk_eq.tolist(),
                        "modelPole": po.tolist(), "saitoPole": bk_po.tolist()}
    # F-corona
    rho = np.array([1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 7.0, 10.0, 20.0, 28.0, 56.0])
    refs = f_corona_references()
    fc = {"rho": rho.tolist()}
    for key, sp in (("equator", 0.0), ("pole", 1.0)):
        fc[key] = {"lasco": ffit.b(rho, sp + 0 * rho).tolist(), "zodiacalModel": zodi_near_sun(rho, sp).tolist()}
        for name, d in refs.items():
            r2, b2 = d[key]
            fc[key][name] = [float(b2[np.isclose(r2, r)][0]) if np.any(np.isclose(r2, r)) else None for r in rho]
    out["fCorona"] = fc
    if sn_2027 is not None:
        out["phaseFromSN2027"] = float((sn_2027 - sn_min) / (sn_max - sn_min))
    return out


# ------------------------------------------------------------------------------------------------ F-corona references

def f_corona_references() -> dict:
    """Published visible F-corona brightness near the Sun, in units of B_sun, keyed by source:
    {name: {"equator": (rho[], B[]), "pole": (rho[], B[])}} (Leinert and van de Hulst as laws on a common grid)."""
    rho = np.array([1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 7.0, 10.0])
    out = {"vandehulst1950_eq7": {"equator": (rho, law("F", rho)), "pole": (rho, law("F", rho))}}
    s = saito1977()
    out["saito1977_skylab"] = {
        "equator": tuple(np.array(x, float) for x in zip(*[(r["r"], r["B_F"]) for r in s["table2"] if r.get("B_F")])),
        "pole": tuple(np.array(x, float) for x in zip(*[(r["r"], r["B_F"]) for r in s["table3_spherical"]
                                                         if r.get("B_F")]))}
    from . import sky_zodi as zl
    t23 = zl.leinert_constants()["f_corona_table23"]
    conv = float(t23["B_sun_1e-9_in_W_m2_sr_um"]) / 1e-9
    for key in ("equatorial", "polar"):
        e = t23["500nm"][key]
        out.setdefault("leinert1998_table23", {})["equator" if key == "equatorial" else "pole"] = (
            rho, float(e["I_4Rsun_W_m2_sr_um"]) / conv * (rho / 4.0) ** float(e["radial_slope"]))
    return out
