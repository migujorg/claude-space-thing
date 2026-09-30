"""Zodiacal light: Leinert et al. (1998) brightness at 1 AU and the Kelsall et al. (1998) dust cloud with a visible
phase function and albedo fitted to it, so the renderer can integrate the brightness from any position.

* `leinert_table()`: Table 16 (S10sun at 500 nm, annual average seen from the Earth), transcribed in sky_tables/.
* `Kelsall`: the DIRBE interplanetary dust model geometry (Table 1 and Eqs. 3-9), transcribed in sky_tables/.
  Its densities n_c are cross-section densities in AU^-1 (optical depth per AU).
* Scattered brightness (Kelsall Eq. 1, scattering term only): I = sum_c integral n_c A Phi(Theta) F_sun / R^2 ds,
  here in units of the solar flux at 1 AU per sr, from the observer out to R = 5.2 AU.
* `fit_visible_scattering()`: the phase function keeps Kelsall's form Phi = N [C0 + C1 Theta + exp(C2 Theta)]
  (Eq. 2, chosen by Kelsall et al. because it reproduces Hong's visible phase function) but C0, C1, C2 and the
  albedo A are fitted to Leinert Table 16 with the geometry fixed (annual average over the Earth's orbit).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

TABLES = Path(__file__).parent / "sky_tables"
S10_PER_SOLAR_FLUX_SR = 6.61e-12  # Leinert 1998 p. 4: 1 S10sun = 6.61e-12 F_sun / sr
R_OUT_AU = 5.2                     # Kelsall 1998 Sect. 4.2: outer cutoff of the line-of-sight integral


def _read_csv(name: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    lines = [ln for ln in (TABLES / name).read_text(encoding="utf-8").splitlines() if ln and not ln.startswith("#")]
    head = lines[0].split(",")
    beta = np.array([float(h.split("_")[1]) for h in head[1:]])
    lam, rows = [], []
    for ln in lines[1:]:
        f = ln.split(",")
        lam.append(float(f[0]))
        rows.append([float(v) if v else np.nan for v in f[1:]])
    return np.array(lam), beta, np.array(rows)


def leinert_table(number: int = 16) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(lambda - lambda_sun [deg], beta [deg], values [n_lam, n_beta], NaN = blank). Table 16: S10sun; 17: SI."""
    return _read_csv(f"leinert_1998_table{number}.csv")


def leinert_constants() -> dict:
    return json.loads((TABLES / "leinert_1998.json").read_text(encoding="utf-8"))


def kelsall_params() -> dict:
    return json.loads((TABLES / "kelsall_1998.json").read_text(encoding="utf-8"))


def fco(wl_nm: np.ndarray, elong_deg: float) -> np.ndarray:
    """Leinert 1998 Eq. (22): zodiacal-light colour relative to the Sun, f_co(lambda) (1 = solar), interpolated
    linearly in elongation between the 30 deg and 90 deg relations (constant outside). Applied to 220-2500 nm;
    NaN outside that range."""
    c = leinert_constants()["colour_fco"]
    wl = np.asarray(wl_nm, float)
    x = np.log10(wl / 500.0)

    def rel(key):
        r = c[key]
        return np.where(wl < 500.0, 1.0 + r["below_500nm"]["slope"] * x, 1.0 + r["above_500nm"]["slope"] * x)
    t = float(np.clip((elong_deg - 30.0) / 60.0, 0.0, 1.0))
    out = (1 - t) * rel("eps30") + t * rel("eps90")
    return np.where((wl >= 220.0) & (wl <= 2500.0), out, np.nan)


# ------------------------------------------------------------------------------------------ Kelsall geometry

def _tilt_z(x: np.ndarray, y: np.ndarray, z: np.ndarray, i_deg: float, om_deg: float) -> np.ndarray:
    """Height above a plane with inclination i and ascending node Omega (Kelsall Eq. 5)."""
    i, om = np.radians(i_deg), np.radians(om_deg)
    return x * np.sin(om) * np.sin(i) - y * np.cos(om) * np.sin(i) + z * np.cos(i)


@dataclass
class Kelsall:
    p: dict

    @classmethod
    def load(cls) -> "Kelsall":
        return cls(kelsall_params())

    def _v(self, comp: str, key: str) -> float:
        return float(self.p[comp][key]["value"])

    def smooth(self, x, y, z):
        v = lambda k: self._v("smooth_cloud", k)  # noqa: E731
        xp, yp, zp = x - v("X0_AU"), y - v("Y0_AU"), z - v("Z0_AU")
        rc = np.sqrt(xp * xp + yp * yp + zp * zp)
        zeta = np.abs(_tilt_z(xp, yp, zp, v("i_deg"), v("Omega_deg"))) / rc
        mu = v("mu")
        g = np.where(zeta < mu, zeta * zeta / (2 * mu), zeta - mu / 2)
        return v("n0_per_AU") * rc ** (-v("alpha")) * np.exp(-v("beta") * g ** v("gamma"))

    def bands(self, x, y, z):
        # "All band pairs were centered on the Sun" (Sect. 4.2.2): no offset, Sun-centred R.
        r = np.sqrt(x * x + y * y + z * z)
        out = np.zeros_like(r)
        for b in self.p["dust_bands"]:
            v = lambda k: float(b[k]["value"])  # noqa: E731
            zeta = np.abs(_tilt_z(x, y, z, v("i_deg"), v("Omega_deg"))) / r
            q = zeta / np.radians(v("dzeta_deg"))
            out += (3 * v("n3_per_AU") / r * np.exp(-q ** 6) * (v("v") + q ** v("p"))
                    * (1 - np.exp(-(r / v("dR_AU")) ** 20)))
        return out

    def ring_blob(self, x, y, z, earth_lon_rad: float):
        v = lambda k: self._v("ring", k)  # noqa: E731
        r = np.sqrt(x * x + y * y + z * z)
        zr = np.abs(_tilt_z(x, y, z, v("i_deg"), v("Omega_deg")))
        ring = v("n_SR_per_AU") * np.exp(-(r - v("R_SR_AU")) ** 2 / (2 * v("sigma_r_SR_AU") ** 2)
                                         - zr / v("sigma_z_SR_AU"))
        w = lambda k: self._v("trailing_blob", k)  # noqa: E731
        dth = np.degrees(np.arctan2(y, x) - earth_lon_rad)
        dth = (dth + 180.0) % 360.0 - 180.0 - w("theta_TB_deg")
        blob = w("n_TB_per_AU") * np.exp(-(r - w("R_TB_AU")) ** 2 / (2 * w("sigma_r_TB_AU") ** 2)
                                         - zr / w("sigma_z_TB_AU") - dth ** 2 / (2 * w("sigma_theta_TB_deg") ** 2))
        return ring + blob

    def density(self, x, y, z, earth_lon_rad: float) -> np.ndarray:
        return self.smooth(x, y, z) + self.bands(x, y, z) + self.ring_blob(x, y, z, earth_lon_rad)


# ------------------------------------------------------------------------------------------ line of sight

S_GRID = np.concatenate([np.arange(0.0, 2.5, 0.004), np.arange(2.5, 6.3, 0.02)])


def _trap_weights(s: np.ndarray) -> np.ndarray:
    w = np.zeros_like(s)
    d = np.diff(s)
    w[:-1] += d / 2
    w[1:] += d / 2
    return w


def los_moments(model: Kelsall, obs: np.ndarray, dirs: np.ndarray, earth_lon_rad: float
                ) -> tuple[np.ndarray, np.ndarray]:
    """Per ray: weights w_k = n(x_k) / R_k^2 * ds (AU^-1 * AU / AU^2, i.e. per AU^2 of solar-flux dilution) and the
    scattering angles Theta_k (rad) on the fixed grid S_GRID, truncated at R = 5.2 AU. Shapes (n_rays, n_s)."""
    s = S_GRID[None, :, None]
    x = obs[None, None, :] + s * dirs[:, None, :]
    r = np.linalg.norm(x, axis=2)
    n = model.density(x[..., 0], x[..., 1], x[..., 2], earth_lon_rad)
    w = _trap_weights(S_GRID)[None, :] * n / (r * r)
    w[r > R_OUT_AU] = 0.0
    cos_t = -np.einsum("rsk,rk->rs", x, dirs) / r   # incident r_hat vs scattered -d: Theta = 0 is forward
    return w, np.arccos(np.clip(cos_t, -1.0, 1.0))


def phase_norm(c0: float, c1: float, c2: float) -> float:
    """N of Kelsall Eq. 2 (integral of Phi over 4 pi sr = 1)."""
    t = np.linspace(0.0, np.pi, 20001)
    f = (c0 + c1 * t + np.exp(c2 * t)) * np.sin(t)
    return 1.0 / (2 * np.pi * np.trapezoid(f, t))


def phase(theta: np.ndarray, c0: float, c1: float, c2: float) -> np.ndarray:
    return phase_norm(c0, c1, c2) * (c0 + c1 * theta + np.exp(c2 * theta))


def helio_dirs(dlam_deg: np.ndarray, beta_deg: np.ndarray, sun_lon_rad: float) -> np.ndarray:
    lam = sun_lon_rad + np.radians(dlam_deg)
    b = np.radians(beta_deg)
    return np.stack([np.cos(b) * np.cos(lam), np.cos(b) * np.sin(lam), np.sin(b)], axis=-1)


def annual_moments(model: Kelsall, dlam: np.ndarray, beta: np.ndarray, n_lon: int = 12, c2_grid=None):
    """Annual average over the Earth's orbit (circular, 1 AU) and over the +-beta, +-(lambda - lambda_sun)
    reflections that Leinert's table folds together: returns J0, J1 = sum w, sum w Theta per direction, and
    J2[c2] = sum w exp(c2 Theta) for every c2 in c2_grid (shape (len(c2_grid), n_dir))."""
    c2_grid = np.asarray(c2_grid if c2_grid is not None else [-1.0])
    j0 = np.zeros(dlam.size)
    j1 = np.zeros(dlam.size)
    j2 = np.zeros((c2_grid.size, dlam.size))
    count = 0
    for k in range(n_lon):
        lon_e = 2 * np.pi * k / n_lon
        obs = np.array([np.cos(lon_e), np.sin(lon_e), 0.0])
        sun_lon = lon_e + np.pi
        for sb in (1, -1):
            for sl in (1, -1):
                d = helio_dirs(sl * dlam, sb * beta, sun_lon)
                w, th = los_moments(model, obs, d, lon_e)
                j0 += w.sum(1)
                j1 += (w * th).sum(1)
                for i, c2 in enumerate(c2_grid):
                    j2[i] += (w * np.exp(c2 * th)).sum(1)
                count += 1
    return j0 / count, j1 / count, j2 / count


@dataclass
class VisibleScattering:
    albedo: float
    c0: float
    c1: float
    c2: float
    rms_log: float           # rms of ln(model / table) over the fitted cells
    max_abs_log: float
    n_cells: int
    chi2_red: float


def fit_visible_scattering(model: Kelsall | None = None, n_lon: int = 12) -> tuple[VisibleScattering, dict]:
    """Fit A, C0, C1, C2 to Leinert Table 16 (every non-blank cell with elongation >= 15 deg) by weighted least
    squares, sigma = sqrt(12.5^2 + (0.075 I)^2) S10sun (the paper's stated errors, p. 38). For fixed C2 the model
    is linear in (A N C0, A N C1, A N); C2 is scanned."""
    model = model or Kelsall.load()
    lam, beta, tab = leinert_table(16)
    L, B = np.meshgrid(lam, beta, indexing="ij")
    ok = np.isfinite(tab)
    dl, bt, obs_s10 = L[ok], B[ok], tab[ok]
    c2_grid = np.linspace(-6.0, 0.5, 131)
    j0, j1, j2 = annual_moments(model, dl, bt, n_lon=n_lon, c2_grid=c2_grid)
    y = obs_s10 * S10_PER_SOLAR_FLUX_SR       # solar flux units per sr
    sig = np.sqrt(12.5 ** 2 + (0.075 * obs_s10) ** 2) * S10_PER_SOLAR_FLUX_SR
    best = None
    for i, c2 in enumerate(c2_grid):
        M = np.stack([j0, j1, j2[i]], axis=1) / sig[:, None]
        coef, *_ = np.linalg.lstsq(M, y / sig, rcond=None)
        a0, a1, a2 = coef
        if a2 <= 0:
            continue
        c0, c1 = a0 / a2, a1 / a2
        t = np.linspace(0, np.pi, 721)
        if np.any(c0 + c1 * t + np.exp(c2 * t) <= 0):
            continue    # not a phase function
        chi2 = float(np.sum((M @ coef - y / sig) ** 2))
        if best is None or chi2 < best[0]:
            best = (chi2, c0, c1, c2, a2, M @ coef * sig)
    chi2, c0, c1, c2, a2, pred = best
    albedo = a2 / phase_norm(c0, c1, c2)
    lr = np.log(pred / y)
    fit = VisibleScattering(albedo=float(albedo), c0=float(c0), c1=float(c1), c2=float(c2),
                            rms_log=float(np.sqrt(np.mean(lr ** 2))), max_abs_log=float(np.max(np.abs(lr))),
                            n_cells=int(y.size), chi2_red=float(chi2 / (y.size - 4)))
    detail = {"dlam": dl, "beta": bt, "table_s10": obs_s10, "model_s10": pred / S10_PER_SOLAR_FLUX_SR}
    return fit, detail


def brightness_s10(model: Kelsall, fit: VisibleScattering, obs: np.ndarray, dirs: np.ndarray,
                   earth_lon_rad: float) -> np.ndarray:
    """Model brightness (S10sun at 500 nm) seen from `obs` (heliocentric ecliptic, AU) along unit `dirs`."""
    w, th = los_moments(model, obs, dirs, earth_lon_rad)
    i = fit.albedo * (w * phase(th, fit.c0, fit.c1, fit.c2)).sum(1)
    return i / S10_PER_SOLAR_FLUX_SR
