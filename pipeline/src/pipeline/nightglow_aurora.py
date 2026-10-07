"""Aurora for the `nightglow` stage: where electrons precipitate (OVATION Prime 2010), how hard (energy flux, mean
energy), how that becomes light at which altitude, and the magnetic coordinates that place the oval on the globe.

1. Precipitation: OVATION Prime 2010 (Newell et al. 2009, 2010; DMSP-based regressions of electron energy and
   number flux on the solar-wind coupling dPhi/dt, per season, 96 MLT x 160 MLAT bins, for diffuse, monoenergetic
   and broadband aurora). Coefficient files of the NOAA NCEI IDL release, as redistributed with OvationPyme. The
   model is evaluated exactly as the IDL/OvationPyme code does (flux = (b1 + b2 dPhi) p with the probability model,
   the caps on unphysical values, the northern dawn-wedge interpolation, hemispheres averaged and seasons weighted
   by day of year) on a grid of dPhi/dt nodes; the app interpolates linearly between nodes.
2. Driver: the Newell et al. (2007) coupling dPhi/dt = v^(4/3) B_T^(2/3) sin^(8/3)(theta_c/2) from the measured
   hourly OMNI 2 solar wind (bow-shock-shifted), averaged over the 4 preceding hours with weights 1, 0.65, 0.65^2,
   0.65^3 (OP2010). Times without measurements: the median of the measured series (a climatological input).
3. Magnetic coordinates: AACGM-like (Baker & Wing 1989) from IGRF-14: field lines traced from 110 km to the
   centred-dipole equator (or extrapolated with the dipole beyond 5 R_E); latitude = acos(sqrt(R_E / r_apex)),
   longitude = dipole longitude of the apex. MLT = 12 h + (mlon - dipole longitude of the Sun) / 15.
4. Light: Maxwellian electrons of characteristic energy E0 = <E>/2 (<E> = energy flux / number flux) deposit their
   energy per Fang et al. (2008) in the US Standard Atmosphere 1976 (us76_upper), 35 eV per ion pair. The N2+ first
   negative (0, v'') bands follow the N2 ionisation (equal ionisation cross sections per particle assumed for the
   N2 share) with Q_emis(391.4)/Q_ion(N2) at 100 eV (Itikawa 2006) and band Einstein coefficients (Gilmore, Laher &
   Espy 1992, Laher's tables). The 557.7 nm and 630.0 nm columns relative to 427.8 nm are the B3C electron-transport
   results for Maxwellian precipitation and the reference O/N2 (fO = 1) of Gabrielse et al. (2021, Fig. 2B, read
   from the figure). Green follows the blue profile (Whiter et al. 2023: green and blue peak at about the same
   height); red follows the ionisation times the O(1D) survival A/(A + k_N2 [N2] + k_O2 [O2]) (IUPAC rate
   coefficients, Atkinson et al. 2004; NIST transition probabilities).
"""

from __future__ import annotations

import datetime as _dt
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import us76_upper

TABLES = Path(__file__).parent / "nightglow_tables"
KEV_PER_ERG = 1.0 / 1.602176634e-9      # SI-defined elementary charge: 1 keV = 1.602176634e-16 J = 1.602176634e-9 erg
R_EARTH_AACGM_KM = 6371.2               # AACGM / IGRF reference radius


def tables() -> dict:
    return json.loads((TABLES / "aurora.json").read_text(encoding="utf-8"))


# ============================================================================================ Fang et al. (2008)

def fang2008_coefficients(e0_kev: float) -> np.ndarray:
    p = np.array(tables()["fang2008"]["P"], float)          # (8, 4)
    le = np.log(e0_kev)
    return np.exp(p @ np.array([1.0, le, le ** 2, le ** 3]))


def fang2008_ionization(z_km: np.ndarray, q0_erg: float, e0_kev: float, atm: dict | None = None) -> np.ndarray:
    """Total ionization rate (cm^-3 s^-1) of Maxwellian electrons of characteristic energy E0 (keV) and energy flux
    Q0 (erg cm^-2 s^-1), isotropic over the downward hemisphere (Fang et al. 2008, eqs. 2, 4, 6, 7)."""
    f = tables()["fang2008"]
    atm = atm or us76_upper.profile(z_km)
    rho = atm["rho"] * 1e-3            # g cm^-3
    h = atm["H"] * 1e2                 # cm
    y = (1.0 / e0_kev) * (rho * h / f["yNorm_g_cm2"]) ** f["yExponent"]
    c = fang2008_coefficients(e0_kev)
    fy = c[0] * y ** c[1] * np.exp(-c[2] * y ** c[3]) + c[4] * y ** c[5] * np.exp(-c[6] * y ** c[7])
    q0_kev = q0_erg * KEV_PER_ERG
    return q0_kev / (2.0 * f["deltaEpsilon_keV"]) * fy / h


# ============================================================================================ emission

def n2_share(atm: dict) -> np.ndarray:
    """Fraction of the ionizations that ionize N2, with equal cross sections per particle (assumption)."""
    return atm["N2"] / (atm["N2"] + atm["O2"] + atm["O"] + atm["Ar"] + atm["He"])


def o1d_survival(atm: dict) -> np.ndarray:
    t = tables()
    a = t["o1d"]["A_total_s"]
    kn2 = t["o1d"]["kN2"]
    ko2 = t["o1d"]["kO2"]
    temp = atm["T"]
    q = kn2["A"] * np.exp(kn2["EoverR"] / temp) * atm["N2"] * 1e-6 + ko2["A"] * np.exp(ko2["EoverR"] / temp) * atm["O2"] * 1e-6
    return a / (a + q)


def photons_4278_per_n2_ionization() -> float:
    t = tables()["n2plus"]
    return t["Qemis3914_cm2_100eV"] / t["Qion_N2_cm2_100eV"] * t["A01_over_A00"]


def ratio_curves() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    g = tables()["gabrielse2021"]
    e = np.array([p[0] for p in g["points"]], float)
    rb = np.array([p[1] for p in g["points"]], float)
    gb = np.array([p[2] for p in g["points"]], float)
    return e, rb, gb


def ratios_at(e_avg_kev: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(630.0/427.8, 557.7/427.8) at average energies (keV), log-log interpolation of the digitised B3C curve,
    held at the end values outside the digitised range."""
    e, rb, gb = ratio_curves()
    x = np.log(np.clip(np.asarray(e_avg_kev, float), e[0], e[-1]))
    return np.exp(np.interp(x, np.log(e), np.log(rb))), np.exp(np.interp(x, np.log(e), np.log(gb)))


@dataclass
class EmissionTable:
    energies_kev: np.ndarray          # average energies <E>
    altitudes_km: np.ndarray
    column_r_per_erg: dict            # line -> (nE,) R per (erg cm^-2 s^-1)
    profile_per_km: dict              # line -> (nE, nZ), integrates to 1 over altitude
    peak_km: dict                     # line -> (nE,)


def emission_table(energies_kev: np.ndarray, z_km: np.ndarray) -> EmissionTable:
    atm = us76_upper.profile(z_km)
    dz_cm = np.gradient(z_km) * 1e5
    eta = photons_4278_per_n2_ionization()
    fn2 = n2_share(atm)
    surv = o1d_survival(atm)
    rb, gb = ratios_at(energies_kev)
    cols = {k: [] for k in ("N2p4278", "OI5577", "OI6300")}
    prof = {k: [] for k in cols}
    peaks = {k: [] for k in cols}
    for i, e in enumerate(energies_kev):
        q = fang2008_ionization(z_km, 1.0, 0.5 * e, atm)          # Maxwellian: <E> = 2 E0
        v_b = q * fn2 * eta                                       # photons cm^-3 s^-1 of 427.8 nm
        col_b = float(np.sum(v_b * dz_cm)) * 1e-6                 # R
        shapes = {"N2p4278": v_b, "OI5577": v_b, "OI6300": q * surv}
        colv = {"N2p4278": col_b, "OI5577": col_b * gb[i], "OI6300": col_b * rb[i]}
        for k in cols:
            s = shapes[k]
            norm = s / float(np.sum(s * np.gradient(z_km)))
            cols[k].append(colv[k])
            prof[k].append(norm)
            peaks[k].append(float(z_km[np.argmax(s)]))
    return EmissionTable(energies_kev=np.asarray(energies_kev, float), altitudes_km=np.asarray(z_km, float),
                         column_r_per_erg={k: np.array(v) for k, v in cols.items()},
                         profile_per_km={k: np.array(v) for k, v in prof.items()},
                         peak_km={k: np.array(v) for k, v in peaks.items()})


def n2plus_bands() -> list[tuple[float, float]]:
    """N2+ first negative (0, v'') bands: (vacuum wavelength nm, photons relative to (0,1) 427.8 nm)."""
    b = tables()["n2plus"]["bands_v0"]
    a01 = next(x["A_s"] for x in b if x["vpp"] == 1)
    return [(x["lambda_vac_um"] * 1e3, x["A_s"] / a01) for x in b]


# ============================================================================================ IGRF / AACGM-like

def read_igrf(path: Path, year: float) -> tuple[np.ndarray, np.ndarray, int]:
    """Schmidt semi-normalised g, h (nT) at decimal `year` from the IGRF coefficient file (linear between 5-year
    models; secular variation after the last)."""
    lines = path.read_text(encoding="utf-8").splitlines()
    head = next(i for i, ln in enumerate(lines) if ln.startswith("g/h"))
    cols = lines[head].split()
    epochs = [float(c) for c in cols[3:-1]]
    rows = [ln.split() for ln in lines[head + 1:] if ln.strip()]
    nmax = max(int(r[1]) for r in rows)
    g = np.zeros((nmax + 1, nmax + 1))
    h = np.zeros((nmax + 1, nmax + 1))
    for r in rows:
        n, m = int(r[1]), int(r[2])
        vals = [float(x) for x in r[3:]]
        main, sv = vals[:-1], vals[-1]
        if year >= epochs[-1]:
            v = main[-1] + sv * (year - epochs[-1])
        else:
            k = int(np.searchsorted(epochs, year, side="right") - 1)
            f = (year - epochs[k]) / (epochs[k + 1] - epochs[k])
            v = main[k] + f * (main[k + 1] - main[k])
        (g if r[0] == "g" else h)[n, m] = v
    return g, h, nmax


def _legendre(theta: np.ndarray, nmax: int) -> tuple[np.ndarray, np.ndarray]:
    """Schmidt semi-normalised P_n^m(cos theta) and dP/dtheta, arrays (nmax+1, nmax+1, N), by the standard
    recursions: P_n^n = sqrt(1 - 1/(2n)) sin P_{n-1}^{n-1} (P_1^1 = sin), and for n > m
    P_n^m = [(2n-1) cos P_{n-1}^m - sqrt((n-1)^2 - m^2) P_{n-2}^m] / sqrt(n^2 - m^2)."""
    x, s = np.cos(theta), np.sin(theta)
    P = np.zeros((nmax + 1, nmax + 1) + theta.shape)
    dP = np.zeros_like(P)
    P[0, 0] = 1.0
    for n in range(1, nmax + 1):
        k = 1.0 if n == 1 else np.sqrt(1.0 - 1.0 / (2.0 * n))
        P[n, n] = k * s * P[n - 1, n - 1]
        dP[n, n] = k * (x * P[n - 1, n - 1] + s * dP[n - 1, n - 1])
        for m in range(0, n):
            c = np.sqrt((n - 1.0) ** 2 - m * m) if n - 2 >= m else 0.0
            p2 = P[n - 2, m] if n - 2 >= m else 0.0
            d2 = dP[n - 2, m] if n - 2 >= m else 0.0
            den = np.sqrt(n * n - m * m)
            P[n, m] = ((2.0 * n - 1.0) * x * P[n - 1, m] - c * p2) / den
            dP[n, m] = ((2.0 * n - 1.0) * (x * dP[n - 1, m] - s * P[n - 1, m]) - c * d2) / den
    return P, dP


def igrf_field(xyz_km: np.ndarray, g: np.ndarray, h: np.ndarray, nmax: int) -> np.ndarray:
    """B (nT) in geocentric Cartesian (Earth-fixed) components at Cartesian points (N, 3) km."""
    a = R_EARTH_AACGM_KM
    x, y, z = xyz_km.T
    r = np.sqrt(x * x + y * y + z * z)
    theta = np.arccos(np.clip(z / r, -1.0, 1.0))
    phi = np.arctan2(y, x)
    P, dP = _legendre(theta, nmax)
    br = np.zeros_like(r); bt = np.zeros_like(r); bp = np.zeros_like(r)
    s = np.maximum(np.sin(theta), 1e-12)
    for n in range(1, nmax + 1):
        ar = (a / r) ** (n + 2)
        for m in range(0, n + 1):
            cm, sm = np.cos(m * phi), np.sin(m * phi)
            gh = g[n, m] * cm + h[n, m] * sm
            br += (n + 1) * ar * gh * P[n, m]
            bt -= ar * gh * dP[n, m]
            bp += ar * m * (g[n, m] * sm - h[n, m] * cm) * P[n, m] / s
    st, ct, sp, cp = np.sin(theta), np.cos(theta), np.sin(phi), np.cos(phi)
    bx = br * st * cp + bt * ct * cp - bp * sp
    by = br * st * sp + bt * ct * sp + bp * cp
    bz = br * ct - bt * st
    return np.stack([bx, by, bz], axis=1)


def dipole_axis(g: np.ndarray, h: np.ndarray) -> np.ndarray:
    """Unit vector (Earth-fixed) toward the centred dipole's northern geomagnetic pole (the dipole moment points
    the other way): -(g11, h11, g10) / |.|."""
    v = -np.array([g[1, 1], h[1, 1], g[1, 0]])
    return v / np.linalg.norm(v)


def dipole_frame(g: np.ndarray, h: np.ndarray) -> np.ndarray:
    """Rows: x, y, z axes of the centred-dipole frame in Earth-fixed coordinates; z = northern geomagnetic pole,
    y = z_geo x z / |.| (perpendicular to both poles), x = y x z (the meridian of the geographic pole, on the side
    away from it... the zero of dipole longitude; only differences of dipole longitude are used)."""
    zd = dipole_axis(g, h)
    yd = np.cross([0.0, 0.0, 1.0], zd)
    yd /= np.linalg.norm(yd)
    xd = np.cross(yd, zd)
    return np.stack([xd, yd, zd])


def aacgm_grid(g: np.ndarray, h: np.ndarray, nmax: int, lat_deg: np.ndarray, lon_deg: np.ndarray,
               alt_km: float = 110.0, min_abs_lat: float = 20.0, r_switch_re: float = 5.0) -> tuple[np.ndarray, np.ndarray]:
    """AACGM-like (latitude, longitude) in degrees at geographic (lat, lon) grid points at altitude alt_km
    (spherical Earth of radius 6371.2 km for the start point; NaN where |lat| < min_abs_lat)."""
    LA, LO = np.meshgrid(np.radians(lat_deg), np.radians(lon_deg), indexing="ij")
    shape = LA.shape
    lat, lon = LA.ravel(), LO.ravel()
    sel = np.abs(np.degrees(lat)) >= min_abs_lat
    r0 = R_EARTH_AACGM_KM + alt_km
    p = np.stack([r0 * np.cos(lat) * np.cos(lon), r0 * np.cos(lat) * np.sin(lon), r0 * np.sin(lat)], axis=1)[sel]
    D = dipole_frame(g, h)
    zd = D[2]
    hemi = np.sign(p @ zd)                              # +1 north of the dipole equator
    b0 = igrf_field(p, g, h, nmax)
    rhat = p / np.linalg.norm(p, axis=1)[:, None]
    sgn = np.sign(np.sum(b0 * rhat, axis=1))            # move away from the Earth: along -B where B points down
    active = np.ones(len(p), bool)
    apex_r = np.full(len(p), np.nan)
    apex_lon = np.full(len(p), np.nan)
    re = R_EARTH_AACGM_KM

    def fdir(q, sg):
        b = igrf_field(q, g, h, nmax)
        return sg[:, None] * b / np.linalg.norm(b, axis=1)[:, None]

    for _ in range(4000):
        if not active.any():
            break
        q = p[active]
        sg = sgn[active]
        rq = np.linalg.norm(q, axis=1)
        ds = (0.02 * rq)[:, None]
        k1 = fdir(q, sg); k2 = fdir(q + 0.5 * ds * k1, sg); k3 = fdir(q + 0.5 * ds * k2, sg); k4 = fdir(q + ds * k3, sg)
        qn = q + ds * (k1 + 2 * k2 + 2 * k3 + k4) / 6.0
        zq, zn = q @ zd, qn @ zd
        crossed = np.sign(zn) != np.sign(zq)
        far = np.linalg.norm(qn, axis=1) > r_switch_re * re
        idx = np.flatnonzero(active)
        if crossed.any():
            # linear interpolation to the dipole equatorial plane
            f = zq[crossed] / (zq[crossed] - zn[crossed])
            qe = q[crossed] + f[:, None] * (qn[crossed] - q[crossed])
            apex_r[idx[crossed]] = np.linalg.norm(qe, axis=1)
            ql = qe @ D.T
            apex_lon[idx[crossed]] = np.arctan2(ql[:, 1], ql[:, 0])
        sw = far & ~crossed
        if sw.any():
            ql = qn[sw] @ D.T
            rr = np.linalg.norm(ql, axis=1)
            cl2 = 1.0 - (ql[:, 2] / rr) ** 2               # cos^2 of dipole latitude
            apex_r[idx[sw]] = rr / np.maximum(cl2, 1e-12)
            apex_lon[idx[sw]] = np.arctan2(ql[:, 1], ql[:, 0])
        done = crossed | sw
        p[idx] = qn
        active[idx[done]] = False
    mlat = np.full(lat.shape, np.nan)
    mlon = np.full(lat.shape, np.nan)
    ok = np.isfinite(apex_r) & (apex_r >= re)
    ml = np.degrees(np.arccos(np.sqrt(np.clip(re / np.where(ok, apex_r, re), 0.0, 1.0)))) * hemi
    mlat[np.flatnonzero(sel)[ok]] = ml[ok]
    mlon[np.flatnonzero(sel)[ok]] = np.degrees(apex_lon[ok])
    return mlat.reshape(shape), mlon.reshape(shape)


# ============================================================================================ OVATION Prime 2010

SEASONS = ("winter", "spring", "summer", "fall")
ATYPES = ("diff", "mono", "wave")
N_MLT, N_MLAT, N_DF = 96, 160, 12
DF_AVE = 4421.0          # OP2010 mean coupling (IDL constant); probability bins are dF_AVE / 8 wide


def season_weights(doy: float) -> dict[str, float]:
    """OP2010 (IDL season_epoch) weights of the four seasonal regressions for a day of year (northern hemisphere;
    the southern uses 365 - doy)."""
    w = {s: 0.0 for s in SEASONS}
    if 79 <= doy < 171:
        w["summer"] = 1.0 - (171.0 - doy) / 92.0; w["spring"] = 1.0 - w["summer"]
    elif 171 <= doy < 263:
        w["fall"] = 1.0 - (263.0 - doy) / 92.0; w["summer"] = 1.0 - w["fall"]
    elif 263 <= doy < 354:
        w["winter"] = 1.0 - (354.0 - doy) / 91.0; w["fall"] = 1.0 - w["winter"]
    else:
        d0 = doy - 365.0 if doy >= 354 else doy
        w["spring"] = 1.0 - (79.0 - d0) / 90.0; w["winter"] = 1.0 - w["spring"]
    return w


@dataclass
class SeasonalModel:
    b1a: np.ndarray      # (2, N_MLT, N_MLAT) energy, number
    b2a: np.ndarray
    b1p: np.ndarray      # (N_MLT, N_MLAT)
    b2p: np.ndarray
    prob: np.ndarray     # (N_MLT, N_MLAT, N_DF)


def read_op_files(afile_e: Path, afile_n: Path, pfile: Path) -> SeasonalModel:
    def read_a(path):
        d = np.loadtxt(path, skiprows=1, max_rows=N_MLT * N_MLAT)
        b1 = np.full((N_MLT, N_MLAT), np.nan); b2 = np.full((N_MLT, N_MLAT), np.nan)
        i, j = d[:, 0].astype(int), d[:, 1].astype(int)
        b1[i, j] = d[:, 2]; b2[i, j] = d[:, 3]
        return b1, b2, i, j
    b1e, b2e, i, j = read_a(afile_e)
    b1n, b2n, _, _ = read_a(afile_n)
    with open(pfile, "r", encoding="utf-8") as f:
        f.readline()
        pb = np.loadtxt(f, max_rows=N_MLT * N_MLAT)
        pv = np.loadtxt(f, max_rows=N_MLT * N_MLAT * N_DF)
    b1p = np.full((N_MLT, N_MLAT), np.nan); b2p = np.full((N_MLT, N_MLAT), np.nan)
    b1p[i, j] = pb[:, 0]; b2p[i, j] = pb[:, 1]
    prob = np.full((N_MLT, N_MLAT, N_DF), np.nan)
    pcol = pv.reshape((-1, N_DF), order="F")
    for k in range(N_DF):
        prob[i, j, k] = pcol[:, k]
    return SeasonalModel(b1a=np.stack([b1e, b1n]), b2a=np.stack([b2e, b2n]), b1p=b1p, b2p=b2p, prob=prob)


def _prob(m: SeasonalModel, dF: float) -> np.ndarray:
    p = np.clip(m.b1p + m.b2p * dF, 0.0, 1.0)
    use_tab = (m.b1p == 0.0) & (m.b2p == 0.0)
    kb = int(np.clip(np.floor(dF / (DF_AVE / 8.0)), 0, N_DF - 1))
    tab = m.prob[:, :, kb]
    k1 = kb - 1 if kb > 0 else kb + 2
    k2 = kb + 1 if kb < N_DF - 1 else kb - 2
    tab = np.where(tab == 0.0, 0.5 * (m.prob[:, :, k1] + m.prob[:, :, k2]), tab)
    return np.where(use_tab, tab, p)


def _caps(flux: np.ndarray, kind: str) -> np.ndarray:
    """The IDL code's corrections of extreme values (electrons), replicated as OvationPyme does."""
    f = np.where(flux < 0.0, 0.0, flux)
    if kind == "energy":
        return np.where(f > 10.0, 0.5, np.where(f > 5.0, 5.0, f))
    return np.where(f > 2.0e9, 1.0e9, f)


def _wedge(flux_n: np.ndarray, mlats: np.ndarray, mlts: np.ndarray) -> np.ndarray:
    """OP2010 interpolation across the northern data gap near MLAT 50-75, MLT 23-4 (IDL constants, edges widened
    by 6 bins), per latitude ring, linear in MLT; flux_n is (N_MLT, n_lat) for the northern bins."""
    out = flux_n.copy()
    mlt = np.where(mlts > 12.0, mlts - 24.0, mlts)
    for j, lat in enumerate(mlats):
        if not (49.0 <= lat <= 75.0):
            continue
        y = out[:, j]
        in_mlt = (mlt >= -1.0) & (mlt <= 4.0)
        miss = in_mlt & ~(y > 0.0)
        if not miss.any():
            continue
        idx = np.flatnonzero(miss)
        m2 = miss.copy()
        for e in range(1, 7):
            m2[(idx[0] - e) % N_MLT] = True
            m2[(idx[-1] + e) % N_MLT] = True
        src = np.flatnonzero(~m2)
        xs = mlt[src]; order = np.argsort(xs)
        out[m2, j] = np.interp(mlt[m2], xs[order], y[src][order])
    return out


def op_grid(models: dict, dF: float) -> np.ndarray:
    """(season, quantity[energy erg cm^-2 s^-1, number cm^-2 s^-1], N_MLT, N_MLAT/2) fluxes summed over the
    electron types, northern and southern bins averaged (OP2010's combined hemispheres)."""
    mlats = np.concatenate([np.linspace(-90.0, -50.0, N_MLAT // 2)[::-1], np.linspace(50.0, 90.0, N_MLAT // 2)])
    mlts = np.linspace(0.0, 24.0, N_MLT)
    out = np.zeros((len(SEASONS), 2, N_MLT, N_MLAT // 2))
    for si, s in enumerate(SEASONS):
        for a in ATYPES:
            m = models[(s, a)]
            p = _prob(m, dF)
            for qi, kind in enumerate(("energy", "number")):
                flux = _caps((m.b1a[qi] + m.b2a[qi] * dF) * p, kind)
                flux = np.nan_to_num(flux, nan=0.0)
                north = _wedge(flux[:, N_MLAT // 2:], mlats[N_MLAT // 2:], mlts)
                south = flux[:, :N_MLAT // 2]          # mlat -50 ... -90 (same |mlat| order as the north)
                out[si, qi] += 0.5 * (north + south)
    return out


def op_mlat_mlt() -> tuple[np.ndarray, np.ndarray]:
    return np.linspace(50.0, 90.0, N_MLAT // 2), np.linspace(0.0, 24.0, N_MLT)


# ============================================================================================ solar wind

def read_omni2(path: Path) -> dict:
    """Hourly OMNI 2 records: datetimes (UTC, start of hour), By, Bz (GSM nT), V (km/s), Kp (x10); NaN = fill."""
    t, by, bz, v, kp = [], [], [], [], []
    for ln in path.read_text(errors="replace").splitlines():
        w = ln.split()
        if len(w) < 40:
            continue
        y, d, hh = int(w[0]), int(w[1]), int(w[2])
        t.append(_dt.datetime(y, 1, 1, tzinfo=_dt.timezone.utc) + _dt.timedelta(days=d - 1, hours=hh))
        b_y, b_z, vv = float(w[15]), float(w[16]), float(w[24])
        by.append(b_y if abs(b_y) < 999 else np.nan)
        bz.append(b_z if abs(b_z) < 999 else np.nan)
        v.append(vv if vv < 9999 else np.nan)
        k = int(w[38])
        kp.append(k if k < 99 else np.nan)
    return {"t": t, "by": np.array(by), "bz": np.array(bz), "v": np.array(v), "kp": np.array(kp, float)}


def newell_coupling(by: np.ndarray, bz: np.ndarray, v: np.ndarray) -> np.ndarray:
    """dPhi_MP/dt = v^(4/3) B_T^(2/3) sin^(8/3)(theta_c / 2) (Newell et al. 2007), v km/s, B nT."""
    bt = np.hypot(by, bz)
    tc = np.arctan2(by, bz)
    return v ** (4.0 / 3.0) * bt ** (2.0 / 3.0) * np.abs(np.sin(tc / 2.0)) ** (8.0 / 3.0)


def op_weighted_coupling(hourly: np.ndarray) -> np.ndarray:
    """At each hour boundary k (the start of record k): the OP2010 weighted mean of the 4 complete hours before it
    (records k-1 .. k-4, weights 1, 0.65, 0.65^2, 0.65^3), normalised by the weights of the hours measured; NaN
    unless at least 2 of the 4 are measured."""
    w = np.array([1.0, 0.65, 0.65 ** 2, 0.65 ** 3])
    out = np.full(hourly.size, np.nan)
    for k in range(4, hourly.size):
        x = hourly[k - 4:k][::-1]
        ok = np.isfinite(x)
        if ok.sum() >= 2:
            out[k] = float(np.sum(w[ok] * x[ok]) / np.sum(w[ok]))
    return out
