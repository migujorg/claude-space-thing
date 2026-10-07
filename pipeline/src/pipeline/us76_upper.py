"""U.S. Standard Atmosphere 1976 above 86 km: temperature and the number densities of N2, O, O2, Ar and He to 1000 km.

The Standard (NOAA-S/T 76-1562, Part 1 sect. 1.3, eqs. 25-37 and Tables 5-7) defines the thermosphere by a
temperature profile in four segments and by diffusion equations for each species with eddy mixing below 115 km and
empirical vertical-flux terms for O and O2. This is a port of those defining relations as implemented in
`ussa1976` 0.3.4 (Y. Nollet, MIT licence; https://github.com/nollety/ussa1976), with its constants (transcribed by
its author from the Standard), restricted to the species needed here (atomic hydrogen, which matters only far above
the aurora, is left out of the mean molar mass and density). One change: ussa1976 uses M(N2) as the mean molar mass
in atomic oxygen's diffusion term below 115 km, which puts O 7 % above the Standard's tables from 100 km up; with the
mean molar mass of the other species (M0 below 100 km), O agrees with them to 0.05 %. The result is checked against
the Standard's printed Table VIII (number densities, pdf pages 225-230 of the NTRS scan; check rows in
tests/test_nightglow.py).
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np

R = 8.31432            # J K^-1 mol^-1 (the Standard's R*, per mole)
G0 = 9.80665           # m s^-2
R0 = 6.356766e6        # m, effective Earth radius of the Standard
M = {"N2": 0.0280134, "O2": 0.0319988, "Ar": 0.039948, "He": 0.0040026, "O": 0.01599939}   # kg mol^-1
M0 = 0.028964425278793997                                                                    # sea-level mean
ALPHA = {"N2": 0.0, "O": 0.0, "O2": 0.0, "Ar": 0.0, "He": -0.4}
A_DIFF = {"O": 6.986e20, "O2": 4.863e20, "Ar": 4.487e20, "He": 1.7e21}
B_DIFF = {"O": 0.75, "O2": 0.75, "Ar": 0.87, "He": 0.691}
K7 = 1.2e2             # eddy diffusion coefficient at 86-95 km, m^2 s^-1
Q1 = {"O": -5.809644e-13, "O2": 1.366212e-13, "Ar": 9.434079e-14, "He": -2.457369e-13}
Q2_O = -3.416248e-12   # only below 97 km
U1 = {"O": 56.90311e3, "O2": 86e3, "Ar": 86e3, "He": 86e3}
U2_O = 97e3
W1 = {"O": 2.706240e-14, "O2": 8.333333e-14, "Ar": 8.333333e-14, "He": 6.666667e-13}
W2_O = 5.008765e-13
Z7, Z8, Z9, Z10, Z12 = 86e3, 91e3, 110e3, 120e3, 1000e3
T7, T9, T10, TINF = 186.8673, 240.0, 360.0, 1000.0
LAMBDA = 0.01875e-3    # m^-1
LK9 = 12.0e-3          # K m^-1
N7 = {"N2": 1.129794e20, "O": 8.6e16, "O2": 3.030898e19, "Ar": 1.351400e18, "He": 7.5817e14}   # m^-3 at 86 km
TC, A_ELL, B_ELL = 263.1905, -76.3232, -19942.9   # elliptical segment 91-110 km (K, K, m)
NA = 6.022169e23


def temperature(z: np.ndarray) -> np.ndarray:
    z = np.asarray(z, float)
    t = np.full(z.shape, np.nan)
    m = (z >= Z7) & (z <= Z8)
    t[m] = T7
    m = (z > Z8) & (z <= Z9)
    t[m] = TC + A_ELL * np.sqrt(1.0 - ((z[m] - Z8) / B_ELL) ** 2)
    m = (z > Z9) & (z <= Z10)
    t[m] = T9 + LK9 * (z[m] - Z9)
    m = (z > Z10) & (z <= Z12)
    t[m] = TINF - (TINF - T10) * np.exp(-LAMBDA * (z[m] - Z10) * (R0 + Z10) / (R0 + z[m]))
    return t


def temperature_gradient(z: np.ndarray) -> np.ndarray:
    z = np.asarray(z, float)
    g = np.zeros(z.shape)
    m = (z > Z8) & (z <= Z9)
    u = (z[m] - Z8) / B_ELL
    g[m] = -A_ELL / B_ELL * u / np.sqrt(1.0 - u * u)
    m = (z > Z9) & (z <= Z10)
    g[m] = LK9
    m = (z > Z10) & (z <= Z12)
    zeta = (z[m] - Z10) * (R0 + Z10) / (R0 + z[m])
    g[m] = LAMBDA * (TINF - T10) * ((R0 + Z10) / (R0 + z[m])) ** 2 * np.exp(-LAMBDA * zeta)
    return g


def gravity(z: np.ndarray) -> np.ndarray:
    return G0 * (R0 / (R0 + np.asarray(z, float))) ** 2


def _cumtrapz(y: np.ndarray, x: np.ndarray) -> np.ndarray:
    return np.concatenate([[0.0], np.cumsum(0.5 * (y[1:] + y[:-1]) * np.diff(x))])


def _f_below(g, t, dtdz, m, mi, alpha, d, k):
    return g * d / ((d + k) * (R * t)) * (mi + (m * k) / d + (alpha * R * dtdz) / g)


def _f_above(g, t, dtdz, mi, alpha):
    return (g / (R * t)) * (mi + ((alpha * R) / g) * dtdz)


@lru_cache(maxsize=1)
def _grid() -> tuple[np.ndarray, dict]:
    z = np.concatenate([np.linspace(Z7, 150e3, 640, endpoint=False), np.geomspace(150e3, Z12, 100)])
    m = np.where(z <= 100e3, M0, M["N2"])
    g = gravity(z)
    t = temperature(z)
    dtdz = temperature_gradient(z)
    below = z < 115e3
    k = np.where(z[below] < 95e3, K7, K7 * np.exp(1.0 - 4e8 / (4e8 - (z[below] - 95e3) ** 2)))
    n = {"N2": N7["N2"] * (T7 / t) * np.exp(-_cumtrapz(m * g / (R * t), z))}

    def velocity(s):
        v = np.zeros(z.shape)
        lo = z <= 150e3
        zz = z[lo]
        v[lo] = Q1[s] * (zz - U1[s]) ** 2 * np.exp(-W1[s] * (zz - U1[s]) ** 3)
        if s == "O":
            hump = zz <= U2_O
            v[lo] = np.where(hump, v[lo] + Q2_O * (U2_O - zz) ** 2 * np.exp(-W2_O * (U2_O - zz) ** 3), v[lo])
        return v

    def diffuse(s, background, mean_m):
        d = (A_DIFF[s] / background) * (t[below] / 273.15) ** B_DIFF[s]
        y = np.concatenate([_f_below(g[below], t[below], dtdz[below], mean_m, M[s], ALPHA[s], d, k),
                            _f_above(g[~below], t[~below], dtdz[~below], M[s], ALPHA[s])])
        return N7[s] * (T7 / t) * np.exp(-_cumtrapz(y + velocity(s), z))

    n["O"] = diffuse("O", n["N2"][below], m[below])
    n["O2"] = diffuse("O2", n["N2"][below], m[below])
    bg = n["N2"][below] + n["O"][below] + n["O2"][below]
    n["Ar"] = diffuse("Ar", bg, m[below])
    n["He"] = diffuse("He", bg, m[below])
    return z, n


def profile(z_km: np.ndarray) -> dict[str, np.ndarray]:
    """N2, O, O2, Ar, He number densities (m^-3), T (K), mass density rho (kg m^-3) and pressure scale height
    H = kT/(m g) (m) at geometric altitudes 86-1000 km (log-linear interpolation on the integration grid)."""
    z = np.asarray(z_km, float) * 1e3
    if np.any(z < Z7 - 1e-6) or np.any(z > Z12 + 1e-6):
        raise ValueError("us76_upper covers 86-1000 km")
    zg, ng = _grid()
    out = {s: np.exp(np.interp(z, zg, np.log(v))) for s, v in ng.items()}
    t = temperature(z)
    ntot = sum(out[s] for s in M)
    rho = sum(out[s] * M[s] for s in M) / NA
    mbar = rho * NA / ntot
    out.update({"T": t, "rho": rho, "H": R * t / (mbar * gravity(z)), "n": ntot})
    return out
