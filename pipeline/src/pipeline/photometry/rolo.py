"""The Moon's disk-integrated reflectance from the ROLO model (Kieffer & Stone 2005, version 311g).

Kieffer & Stone fitted Eq. 10 to about 38 000 ROLO irradiance measurements of the whole Moon in 32 bands
(350-2384 nm), 1.55° < g < 97°, over the Earth-based libration range (tables/kieffer_stone_2005_rolo.json):

  ln A_k = Σ_{i=0..3} a_ik g^i + Σ_{j=1..3} b_jk Φ^(2j−1) + c1 θ + c2 φ + c3 Φ θ + c4 Φ φ
           + d1k exp(−g/p1) + d2k exp(−g/p2) + d3k cos[(g − p3)/p4]

A_k is the disk-equivalent reflectance: I_k = A_k Ω_M E_k/π with Ω_M = 6.4177e-5 sr at 384 400 km, i.e. the Moon's
irradiance is A_k (R/Δ)² E_k with R = 1737.4 km, the same form as E_obs = p Φ(α) (R/Δ)² E of docs/architecture.md
§4.3 (A = p Φ). g = phase angle, θ and φ = selenographic latitude and longitude of the observer, Φ = selenographic
longitude of the Sun (east positive: Φ > 0 before full Moon). g and Φ in radians in the polynomials, degrees
elsewhere. The two exponentials are the opposition effect; the b terms make the waxing and waning Moon differ
(maria vs highlands); the c terms are libration.

Here (derived):
  * `channel_reflectance`: A per CIE channel (X, Y, Z, scotopic; solar-weighted like geometricAlbedoXYZS), by
    interpolating the band values linearly in wavelength (350-865 nm bands cover the 360-830 nm grid).
  * `channel_model`: Eq. 10 refitted per channel (a, b, d; c and p are wavelength independent, so they factor out
    exactly) — what the app evaluates (`diskReflectanceModel`).
  * `phase_table`: the Moon's α-only phase function: A_Y at zero libration, geometric mean of waxing and waning
    (the odd Φ terms cancel), divided by the Lane & Irvine albedo p_Y that geometricAlbedoXYZS keeps.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from .. import cie
from ..schema import BuildContext, sourced
from . import solar
from .common import Download, bin_average, read_table_json

ROLO = Download(
    id="kieffer-stone-2005",
    url="https://iopscience.iop.org/article/10.1086/430185/pdf", subdir="papers", name="KiefferStone2005_AJ129_2887.pdf",
    title="ROLO lunar disk reflectance model, version 311g (Eq. 10, Table 4, Eq. 11)",
    citation="Kieffer, H. H. & Stone, T. C. (2005). The spectral irradiance of the Moon. Astronomical Journal 129, "
             "2887-2901. DOI:10.1086/430185.",
    notes="Robotic Lunar Observatory (USGS Flagstaff) whole-Moon irradiance model fitted to observations in 32 "
          "bands (350-2384 nm), 1.55-97 deg phase. Table 4 and Eq. 11 transcribed to "
          "photometry/tables/kieffer_stone_2005_rolo.json (docs/sources/kieffer-stone-2005.md).",
    browser_agent=True,
    sha256="1666a5414916c2e38fcf34097aad3794cc1aae9d4a7d090bef2a049219316e96", retrieved="2026-09-30",
)

_T = read_table_json("kieffer_stone_2005_rolo.json")
TABLE = np.array(_T["table4"], float)            # (32, 11): λ, a0..a3, b1..b3, d1..d3
WAVELENGTH = TABLE[:, 0]
COEF = TABLE[:, 1:]                              # a0 a1 a2 a3 b1 b2 b3 d1 d2 d3
C = tuple(_T["constants"][k] for k in ("c1", "c2", "c3", "c4"))
P = tuple(_T["constants"][k] for k in ("p1", "p2", "p3", "p4"))
MIN_PHASE, MAX_PHASE = 1.55, 97.0                # Sec. 3.3.1
RADIUS_KM = 384400.0 * math.sqrt(6.4177e-5 / math.pi)     # Eq. 8's Ω_M ↔ disk radius: 1737.4 km
# Earth-based libration range of the fitted observations, read from the paper's Fig. 2 (approximate).
OBS_LAT_RANGE, OBS_LON_RANGE = 7.0, 8.0


def basis(g_deg, sunlon_deg) -> np.ndarray:
    """The ten wavelength-dependent basis functions of Eq. 10 (without the libration terms), shape (..., 10)."""
    g_deg = np.asarray(g_deg, float)
    g = np.radians(g_deg)
    s = np.radians(np.asarray(sunlon_deg, float))
    g, s, g_deg = np.broadcast_arrays(g, s, g_deg)
    return np.stack([np.ones_like(g), g, g ** 2, g ** 3, s, s ** 3, s ** 5,
                     np.exp(-g_deg / P[0]), np.exp(-g_deg / P[1]), np.cos((g_deg - P[2]) / P[3])], axis=-1)


def libration(obs_lat_deg, obs_lon_deg, sunlon_deg):
    """c1 θ + c2 φ + c3 Φ θ + c4 Φ φ (θ, φ in degrees, Φ in radians); the same at every wavelength."""
    s = np.radians(np.asarray(sunlon_deg, float))
    th, ph = np.asarray(obs_lat_deg, float), np.asarray(obs_lon_deg, float)
    return C[0] * th + C[1] * ph + C[2] * s * th + C[3] * s * ph


def ln_a_bands(g_deg, sunlon_deg, obs_lat_deg=0.0, obs_lon_deg=0.0) -> np.ndarray:
    """ln A_k for the 32 ROLO bands, shape (..., 32)."""
    return basis(g_deg, sunlon_deg) @ COEF.T + np.asarray(libration(obs_lat_deg, obs_lon_deg, sunlon_deg))[..., None]


@lru_cache(maxsize=1)
def _weights():
    """Rows: X, Y, Z, S weights on the 1 nm grid for a reflectance interpolated from the band values (solar-weighted,
    normalized so that a flat reflectance of 1 gives 1). Linear interpolation is linear in the band values, so the
    channel reflectance is a fixed weighted sum of the band reflectances."""
    e = solar.spectrum()
    sun = cie.xyzs(e.grid)
    w = np.zeros((4, WAVELENGTH.size))
    for k in range(WAVELENGTH.size):
        unit = np.zeros(WAVELENGTH.size)
        unit[k] = 1.0
        w[:, k] = cie.xyzs(bin_average(WAVELENGTH, unit) * e.grid) / sun
    assert np.allclose(w.sum(axis=1), 1.0, atol=1e-9)
    return w


def channel_reflectance(g_deg, sunlon_deg, obs_lat_deg=0.0, obs_lon_deg=0.0) -> np.ndarray:
    """Disk-equivalent reflectance A per channel (X, Y, Z, S), shape (..., 4), from the 32-band model."""
    return np.exp(ln_a_bands(g_deg, sunlon_deg, obs_lat_deg, obs_lon_deg)) @ _weights().T


def _fit_samples():
    """(g, Φ) samples of the Earth-based geometry: Φ = ±g plus the observer's longitude offset (|φ| ≤ 8°, Sun latitude
    ≤ 1.6°), over the model's phase range."""
    g = np.arange(MIN_PHASE, MAX_PHASE + 1e-9, 0.25)
    gg, dd, ss = np.meshgrid(g, np.linspace(-OBS_LON_RANGE, OBS_LON_RANGE, 9), (-1.0, 1.0), indexing="ij")
    return gg.ravel(), (ss * gg + dd).ravel()


@dataclass(frozen=True)
class ChannelModel:
    coef: np.ndarray          # (4, 10): a0..a3, b1..b3, d1..d3 per channel X, Y, Z, S
    max_residual: float       # max |Δ ln A| of the refit over the fitted geometry

    def ln_a(self, g_deg, sunlon_deg, obs_lat_deg=0.0, obs_lon_deg=0.0) -> np.ndarray:
        return basis(g_deg, sunlon_deg) @ self.coef.T + np.asarray(
            libration(obs_lat_deg, obs_lon_deg, sunlon_deg))[..., None]


@lru_cache(maxsize=1)
def channel_model() -> ChannelModel:
    g, s = _fit_samples()
    x = basis(g, s)
    y = np.log(channel_reflectance(g, s))
    coef, *_ = np.linalg.lstsq(x, y, rcond=None)
    resid = float(np.max(np.abs(x @ coef - y)))
    return ChannelModel(coef.T.copy(), resid)


def mean_phase_y(alpha_deg) -> np.ndarray:
    """A_Y(α) at zero libration, geometric mean of the waxing (Φ = +α) and waning (Φ = −α) Moon: the odd Φ terms
    cancel, leaving the a and d terms of the channel model."""
    m = channel_model()
    return np.exp(0.5 * (m.ln_a(alpha_deg, alpha_deg)[..., 1] + m.ln_a(alpha_deg, -np.asarray(alpha_deg))[..., 1]))


def lane_irvine_py(ctx: BuildContext | None = None) -> float:
    """Photopic (Y) geometric albedo of the Moon's Lane & Irvine spectrum (what geometricAlbedoXYZS holds)."""
    from . import albedo
    spec = albedo.spectrum_for(301, ctx)
    e = solar.spectrum()
    return float(cie.xyzs(bin_average(spec.wl, spec.p) * e.grid)[1] / cie.xyzs(e.grid)[1])


# Phase-angle nodes of the tabulated Φ(α): dense near opposition (linear interpolation in magnitudes < 0.003 mag).
NODES = (1.55, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 7.0, 8.0, 9.0, 10.0, 12.0, 14.0, 16.0,
         18.0, 20.0, 23.0, 26.0, 30.0, 35.0, 40.0, 45.0, 50.0, 55.0, 60.0, 65.0, 70.0, 75.0, 80.0, 85.0, 90.0, 95.0,
         97.0)


def phase_table(p_y: float, li_alpha: list[float], li_dm: list[float]) -> dict:
    """Tabulated Φ(α) = A_Y(α)/p_Y for 1.55-97° (ROLO), continued to Lane & Irvine's 120° with their curve's shape,
    scaled to meet ROLO at 97°. Returns the schema PhaseFunction and the join factor."""
    a = np.array(NODES)
    dm = -2.5 * np.log10(mean_phase_y(a) / p_y)
    li_97 = float(np.interp(MAX_PHASE, li_alpha, li_dm))
    shift = float(dm[-1] - li_97)            # magnitudes added to Lane & Irvine's curve beyond 97°
    tail = [(x, d + shift) for x, d in zip(li_alpha, li_dm) if x > MAX_PHASE]
    alpha = [float(x) for x in a] + [float(x) for x, _ in tail]
    dmag = [round(float(v), 4) for v in dm] + [round(float(d), 4) for _, d in tail]
    return {"function": {"kind": "tabulated", "alphaDeg": alpha, "deltaMag": dmag}, "tail_shift_mag": shift}


FORMULA = ("A_c = exp(a0 + a1·g + a2·g² + a3·g³ + b1·Φ + b2·Φ³ + b3·Φ⁵ + c1·θ + c2·φ + c3·Φ·θ + c4·Φ·φ + "
           "d1·exp(−g°/p1) + d2·exp(−g°/p2) + d3·cos((g° − p3)/p4)) per channel c (X, Y, Z, scotopic: a, b, d are "
           "per channel; c, p shared). g = phase angle and Φ = selenographic longitude of the Sun (east positive) in "
           "RADIANS in the polynomial terms; g° = phase angle in DEGREES in the exponential and cosine terms (p1-p4 "
           "are degrees, the cosine's argument is then taken in radians); θ, φ = selenographic latitude and "
           "longitude of the observer (sub-observer point) in DEGREES. Illuminance at the observer: "
           "E_c = A_c · E☉,c(1 AU)/d² · (R/Δ)², E☉ from light.json, d = Sun-Moon distance in AU, R = radiusKm, "
           "Δ = observer distance; i.e. A_c = p_c·Φ(α) of the albedo/phase-function contract.")


def model_entry(ctx: BuildContext | None) -> dict:
    """The schema `DiskReflectanceModel` (kind 'rolo-v1') for photometry.json → 301.diskReflectanceModel."""
    m = channel_model()
    src = [ROLO.register(ctx) if ctx else ROLO.id,
           solar.HSRS.register(ctx) if ctx else solar.HSRS.id,
           *(cie.register_sources(ctx) if ctx else [cie.SOURCE_CMF, cie.SOURCE_SCOTOPIC])]
    val = {
        "kind": "rolo-v1",
        "formula": FORMULA,
        "a": [[float(f"{v:.6g}") for v in row[:4]] for row in m.coef],
        "b": [[float(f"{v:.6g}") for v in row[4:7]] for row in m.coef],
        "d": [[float(f"{v:.6g}") for v in row[7:]] for row in m.coef],
        "c": list(C), "p": list(P),
        "radiusKm": round(RADIUS_KM, 2),
        "minPhaseDeg": MIN_PHASE, "maxPhaseDeg": MAX_PHASE,
        "maxObserverLatitudeDeg": OBS_LAT_RANGE, "maxObserverLongitudeDeg": OBS_LON_RANGE,
    }
    method = (
        "ROLO lunar irradiance model version 311g (Kieffer & Stone 2005, Eq. 10 with Table 4 and Eq. 11), an "
        "empirical fit to ~38 000 whole-Moon irradiance measurements from the USGS Robotic Lunar Observatory in 32 "
        "bands, 1.55° < g < 97°, including the opposition effect (the two exponential terms), the waxing/waning "
        "asymmetry of maria and highlands (b terms) and libration (c terms). Converted to the CIE channels: the "
        "band reflectances are interpolated linearly in wavelength (bands 350-865 nm cover 360-830 nm), weighted "
        "by sunlight (TSIS-1 HSRS) and the CIE observers like geometricAlbedoXYZS, and Eq. 10's wavelength-"
        f"dependent coefficients refitted per channel over the Earth-based geometry (max |Δ ln A| = "
        f"{m.max_residual:.1e}; c1-c4 and p1-p4 are wavelength independent and carry over exactly). Disk radius "
        f"{RADIUS_KM:.1f} km from Eq. 8's Ω_M = 6.4177e-5 sr at 384 400 km (= the pck00011 mean radius). Domain: "
        f"{MIN_PHASE}° ≤ g ≤ {MAX_PHASE}°, observer within about ±{OBS_LAT_RANGE:.0f}° selenographic latitude and "
        f"±{OBS_LON_RANGE:.0f}° longitude of the sub-Earth point's mean (the libration range of the fit, from the "
        "paper's Fig. 2); outside, the model does not apply (e.g. views of the far side).")
    uncertainty = ("model precision: mean absolute residual 0.0096 in ln A (paper Sec. 3.3.1; < 1 % of residuals "
                   "exceed 5 %); absolute scale 'uncertain by several percent' (paper Sec. 5; project goal 2.5 %), "
                   "Vega-based (Hayes 1985: 1.5 % at 555.6 nm) and "
                   "adjusted to Apollo sample spectra (average adjustment 3.5 %; the paper notes the adjustment "
                   "choice alone could change it by up to 4 % at 440-700 nm)")
    return sourced(val, "derived", src, method=method, uncertainty=uncertainty)
