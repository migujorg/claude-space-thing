"""Observation geometry for the validation cases.

* Observer → target vectors: JPL Horizons vector tables (VEC_CORR='LT': the target at t − light time, as seen from
  the spacecraft at t, ICRF), from the missions' reconstructed trajectories. Cached verbatim under
  data/raw/validation/horizons/ with the query in the download ledger.
* Target orientation (body-fixed → ICRF at t − light time) and radii: NAIF pck00011 (IAU rotation models).
* Sun: de442s, the Sun seen from the target's system barycenter at t − light time (LT-corrected); the barycenter
  offset (≤ 2100 km for Pluto) changes the Sun direction by < 1e-6 rad.
* Camera: the renderer's pinhole model (app/src/render/scene.ts SceneCamera): camera → ICRF rotation with columns
  (right, up, back), looking along −Z; pixel (x, y) (y down) has the ray right·(x+½−W/2)s + up·(H/2−y−½)s − back with
  s = 2 tan(fovY/2)/H.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, field

import numpy as np
import spiceypy as sp

from .. import ephem_horizons as eh
from .. import ephem_kernels as ek

AU_KM = 149597870.7
C_KMS = 299792.458
HORIZONS_SUBDIR = "validation/horizons"

# SPICE body used for the Sun vector (de442s has planet barycenters 1-9; Mercury, Venus, Earth and Moon centres).
SUN_FROM = {199: "199", 299: "299", 399: "399", 301: "301", 499: "4", 599: "5", 699: "6", 799: "7", 899: "8",
            999: "9", 901: "9", 501: "5", 502: "5", 503: "5", 504: "5",
            **{n: "6" for n in range(601, 607)}}
FRAMES = {199: "IAU_MERCURY", 299: "IAU_VENUS", 399: "IAU_EARTH", 301: "IAU_MOON", 499: "IAU_MARS",
          599: "IAU_JUPITER", 699: "IAU_SATURN", 799: "IAU_URANUS", 899: "IAU_NEPTUNE", 999: "IAU_PLUTO",
          901: "IAU_CHARON", 501: "IAU_IO", 502: "IAU_EUROPA", 503: "IAU_GANYMEDE", 504: "IAU_CALLISTO",
          601: "IAU_MIMAS", 602: "IAU_ENCELADUS", 603: "IAU_TETHYS", 604: "IAU_DIONE", 605: "IAU_RHEA",
          606: "IAU_TITAN"}


@contextmanager
def kernels():
    """LSK, pck00011 and de442s loaded for the duration of the block."""
    spk = str(ek.planetary())
    with ek.pool(ek.lsk(), ek.pck()):
        sp.furnsh(spk)
        try:
            yield
        finally:
            sp.unload(spk)


def utc_to_et(utc: str) -> float:
    with ek.pool(ek.lsk()):
        return float(sp.str2et(utc))


def et_to_utc(et: float) -> str:
    with ek.pool(ek.lsk()):
        return sp.et2utc(et, "ISOC", 3)


@dataclass
class RingModel:
    """Ring plane through the planet centre, normal = the body-fixed +Z (IAU pole): radius grid and normal τ."""
    radius_km: np.ndarray
    tau: np.ndarray               # NaN = unknown
    sources: list[str] = field(default_factory=list)

    def tau_at(self, r: np.ndarray) -> np.ndarray:
        out = np.interp(r, self.radius_km, np.nan_to_num(self.tau, nan=0.0), left=0.0, right=0.0)
        return out

    @property
    def extent(self) -> tuple[float, float]:
        nz = self.radius_km[np.nan_to_num(self.tau) > 0]
        return float(nz.min()), float(nz.max())


@dataclass
class Target:
    naif: int
    name: str
    pos: np.ndarray               # km, ICRF, target centre relative to the observer (light-time corrected)
    orient: np.ndarray            # body-fixed -> ICRF at t - lt
    to_sun: np.ndarray            # km, ICRF, target centre -> Sun
    radii: np.ndarray             # km (pck00011)
    horizons_file: str | None = None
    rings: RingModel | None = None

    @property
    def range_km(self) -> float:
        return float(np.linalg.norm(self.pos))

    @property
    def sun_distance_au(self) -> float:
        return float(np.linalg.norm(self.to_sun) / AU_KM)

    @property
    def pole(self) -> np.ndarray:
        return self.orient[:, 2]

    def sub_point(self, direction_icrf: np.ndarray) -> tuple[float, float]:
        """Planetocentric latitude and east longitude (deg) of the point below a direction from the centre."""
        v = self.orient.T @ direction_icrf
        _, lon, lat = sp.reclat(v)
        return float(np.degrees(lat)), float(np.degrees(lon) % 360.0)

    def phase_deg(self) -> float:
        a, b = -self.pos, self.to_sun
        return float(np.degrees(np.arccos(np.dot(a, b) / np.linalg.norm(a) / np.linalg.norm(b))))


def horizons_target(case_id: str, naif: int, observer: str, et: float, *, horizons_id: str | None = None) -> Target:
    """Target state from a Horizons vector table (observer e.g. '@-82' for Cassini) plus pck/de442s (kernels loaded
    by the caller with `kernels()`)."""
    hid = horizons_id or str(naif)
    params = eh.vector_params(hid, observer, tlist=[f"{eh.et_to_jd(et):.9f}"], corr="LT")
    path, tab = eh.fetch_vectors(params, HORIZONS_SUBDIR, f"{case_id}_{hid}_from_{observer.lstrip('@')}.txt")
    pos = tab.states[0, :3].astype(float)
    return target_from_vector(naif, pos, et, horizons_file=path.name)


def target_from_vector(naif: int, pos: np.ndarray, et: float, *, horizons_file: str | None = None) -> Target:
    lt = float(np.linalg.norm(pos)) / C_KMS
    orient = np.array(sp.pxform(FRAMES[naif], "J2000", et - lt))
    sun, _ = sp.spkpos("SUN", et - lt, "J2000", "LT", SUN_FROM[naif])
    radii = np.array(sp.bodvrd(str(naif), "RADII", 3)[1], float)
    return Target(naif, sp.bodc2n(naif).title(), np.asarray(pos, float), orient, np.array(sun, float), radii,
                  horizons_file)


# ---------------------------------------------------------------------------------------------- camera


def _rot_between(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Smallest rotation taking unit vector a to unit vector b."""
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    s = float(np.linalg.norm(v))
    if s < 1e-15:
        return np.eye(3)
    k = v / s
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + s * K + (1 - c) * (K @ K)


@dataclass
class Camera:
    """Pinhole camera, renderer convention. M: camera → ICRF (columns right, up, back)."""
    M: np.ndarray
    width: int
    height: int
    pitch: float                  # tan-plane pixel pitch (rad at the centre)

    @property
    def fov_y(self) -> float:
        return float(2.0 * np.arctan(0.5 * self.height * self.pitch))

    def camera_rays(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        """Unit rays (camera frame) through pixel coordinates (continuous, pixel centres at i + 0.5)."""
        d = np.stack([(xs - 0.5 * self.width) * self.pitch, (0.5 * self.height - ys) * self.pitch,
                      -np.ones_like(xs, dtype=float)], axis=-1)
        return d / np.linalg.norm(d, axis=-1, keepdims=True)

    def rays(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        return self.camera_rays(xs, ys) @ self.M.T

    def project(self, v_icrf: np.ndarray) -> tuple[float, float]:
        c = self.M.T @ v_icrf
        return (float(c[0] / -c[2] / self.pitch + 0.5 * self.width),
                float(0.5 * self.height - c[1] / -c[2] / self.pitch))

    def grid_rays(self, sub: int) -> np.ndarray:
        """(H·sub, W·sub, 3) rays at sub×sub points per pixel."""
        o = (np.arange(sub) + 0.5) / sub
        xs = (np.arange(self.width)[:, None] + o[None, :]).ravel()
        ys = (np.arange(self.height)[:, None] + o[None, :]).ravel()
        X, Y = np.meshgrid(xs, ys)
        return self.rays(X, Y)

    def row_major(self) -> list[float]:
        return [float(v) for v in self.M.ravel()]


def camera_for(target: Target, width: int, height: int, pitch: float, cx: float, cy: float,
               roll_deg: float) -> Camera:
    """Camera that sees the target centre at pixel (cx, cy) with roll `roll_deg` (0 = the target's projected north
    pole along +up at the target, positive rotates up towards right... i.e. about +back)."""
    u = target.pos / np.linalg.norm(target.pos)
    n = target.pole
    up0 = n - np.dot(n, u) * u
    up0 /= np.linalg.norm(up0)
    back0 = -u
    right0 = np.cross(up0, back0)
    ps = np.radians(roll_deg)
    right = np.cos(ps) * right0 + np.sin(ps) * up0
    up = -np.sin(ps) * right0 + np.cos(ps) * up0
    M0 = np.column_stack([right, up, back0])
    cam = Camera(M0, width, height, pitch)
    d = cam.camera_rays(np.array([cx + 0.0]), np.array([cy + 0.0]))[0]
    R = _rot_between(np.array([0.0, 0.0, -1.0]), d)
    return Camera(M0 @ R.T, width, height, pitch)


# ---------------------------------------------------------------------------------------------- ray casting

SKY, LIT, DARK, RING_LIT, RING_SHADOW, RING_UNLIT_FACE = 0, 1, 2, 3, 4, 5
CLASS_NAMES = {SKY: "sky", LIT: "lit surface", DARK: "unlit or ring-shadowed surface", RING_LIT: "lit ring face",
               RING_SHADOW: "ring in planet shadow", RING_UNLIT_FACE: "unlit ring face"}
RING_TAU_MIN = 0.02     # a ring bin counts as ring (for shadows and classes) above this normal optical depth


def _ellipsoid_hit(o: np.ndarray, d: np.ndarray, radii: np.ndarray) -> np.ndarray:
    """Nearest positive intersection distance of rays o + t d (body-fixed, (N,3)) with the ellipsoid; inf if none."""
    oi, di = o / radii, d / radii
    a = np.einsum("ij,ij->i", di, di)
    b = 2 * np.einsum("ij,ij->i", oi, di)
    c = np.einsum("ij,ij->i", oi, oi) - 1.0
    disc = b * b - 4 * a * c
    t = np.full(len(d), np.inf)
    ok = disc >= 0
    sq = np.sqrt(np.where(ok, disc, 0.0))
    t1 = (-b - sq) / (2 * a)
    t2 = (-b + sq) / (2 * a)
    tt = np.where(t1 > 0, t1, t2)
    good = ok & (tt > 0)
    t[good] = tt[good]
    return t


def cast(camera: Camera, targets: list[Target], sub: int = 2) -> dict[str, np.ndarray]:
    """Per sub-sample (H·sub, W·sub): class, target index, incidence/emission/phase (deg), planetocentric lat / east
    lon (deg), ring radius (km, NaN off-ring), μ0 and μ, and ring optical depth."""
    rays = camera.grid_rays(sub)
    shape = rays.shape[:2]
    d_w = rays.reshape(-1, 3)
    n = len(d_w)
    cls = np.full(n, SKY, np.int8)
    tgt = np.full(n, -1, np.int16)
    best_t = np.full(n, np.inf)
    out = {k: np.full(n, np.nan) for k in ("inc", "emi", "pha", "lat", "lon", "ring_r", "mu0", "mu", "tau")}
    for k, tg in enumerate(targets):
        o = tg.orient.T @ (-tg.pos)                      # camera position, body-fixed
        d = d_w @ tg.orient                              # = (orient.T @ d_w.T).T
        s_bf = tg.orient.T @ (tg.to_sun / np.linalg.norm(tg.to_sun))
        t = _ellipsoid_hit(np.broadcast_to(o, d.shape), d, tg.radii)
        hit = t < best_t
        if tg.rings is not None:
            with np.errstate(divide="ignore", invalid="ignore"):
                tr = -o[2] / d[:, 2]
            pr = o[None, :] + tr[:, None] * d
            rr = np.hypot(pr[:, 0], pr[:, 1])
            tau = tg.rings.tau_at(rr)
            ring = (tr > 0) & (tau > RING_TAU_MIN) & (tr < t) & (tr < best_t)
        else:
            ring = np.zeros(n, bool)
        hit &= ~ring
        if hit.any():
            p = o + t[hit, None] * d[hit]
            nrm = p / tg.radii ** 2
            nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
            mu = -np.einsum("ij,ij->i", nrm, d[hit])
            mu0 = nrm @ s_bf
            to_obs = -d[hit]
            pha = np.degrees(np.arccos(np.clip(to_obs @ s_bf, -1, 1)))
            lit = mu0 > 0
            if tg.rings is not None:                     # ring shadow on the planet
                with np.errstate(divide="ignore", invalid="ignore"):
                    ts = -p[:, 2] / s_bf[2]
                ps_ = p + ts[:, None] * s_bf[None, :]
                rs = np.hypot(ps_[:, 0], ps_[:, 1])
                shadow = (ts > 0) & (tg.rings.tau_at(rs) > RING_TAU_MIN)
                out_tau = np.where(shadow, tg.rings.tau_at(rs), 0.0)
                lit &= ~shadow
            else:
                out_tau = np.zeros(hit.sum())
            idx = np.flatnonzero(hit)
            cls[idx] = np.where(lit, LIT, DARK)
            tgt[idx] = k
            best_t[idx] = t[hit]
            out["mu"][idx], out["mu0"][idx] = mu, mu0
            out["emi"][idx] = np.degrees(np.arccos(np.clip(mu, -1, 1)))
            out["inc"][idx] = np.degrees(np.arccos(np.clip(mu0, -1, 1)))
            out["pha"][idx] = pha
            out["lat"][idx] = np.degrees(np.arcsin(np.clip(p[:, 2] / np.linalg.norm(p, axis=1), -1, 1)))
            out["lon"][idx] = np.degrees(np.arctan2(p[:, 1], p[:, 0])) % 360
            out["tau"][idx] = out_tau
            out["ring_r"][idx] = np.nan
        if ring.any():
            idx = np.flatnonzero(ring)
            p = pr[ring]
            same_side = np.sign(o[2]) == np.sign(s_bf[2])
            # planet shadow on the ring
            ts = _ellipsoid_hit(p + 1e-3 * s_bf, np.broadcast_to(s_bf, p.shape), tg.radii)
            shadowed = np.isfinite(ts)
            c = np.where(shadowed, RING_SHADOW, RING_LIT if same_side else RING_UNLIT_FACE)
            cls[idx] = c
            tgt[idx] = k
            best_t[idx] = tr[ring]
            mu = np.abs(d[ring, 2])
            mu0 = abs(s_bf[2])
            out["mu"][idx], out["mu0"][idx] = mu, mu0
            out["emi"][idx] = np.degrees(np.arccos(mu))
            out["inc"][idx] = np.degrees(np.arccos(mu0))
            out["pha"][idx] = np.degrees(np.arccos(np.clip(-d[ring] @ s_bf, -1, 1)))
            out["ring_r"][idx] = rr[ring]
            out["lon"][idx] = np.degrees(np.arctan2(p[:, 1], p[:, 0])) % 360
            out["tau"][idx] = tau[ring]
    res = {k: v.reshape(shape) for k, v in out.items()}
    res["cls"] = cls.reshape(shape)
    res["tgt"] = tgt.reshape(shape)
    return res


def pixel_view(sample: np.ndarray, sub: int, how: str = "mean") -> np.ndarray:
    """Reduce an (H·sub, W·sub) sub-sample array to (H, W)."""
    h, w = sample.shape[0] // sub, sample.shape[1] // sub
    b = sample.reshape(h, sub, w, sub)
    if how == "mean":
        return np.nanmean(b, axis=(1, 3))
    if how == "min":
        return b.min(axis=(1, 3))
    if how == "max":
        return b.max(axis=(1, 3))
    raise ValueError(how)


def uniform_class(cls_sub: np.ndarray, tgt_sub: np.ndarray, sub: int) -> tuple[np.ndarray, np.ndarray]:
    """(H, W) class and target index where all sub-samples agree, −1 where the pixel is mixed."""
    cmin, cmax = pixel_view(cls_sub, sub, "min"), pixel_view(cls_sub, sub, "max")
    tmin, tmax = pixel_view(tgt_sub, sub, "min"), pixel_view(tgt_sub, sub, "max")
    ok = (cmin == cmax) & (tmin == tmax)
    return np.where(ok, cmin, -1).astype(np.int8), np.where(ok, tmin, -1).astype(np.int16)
