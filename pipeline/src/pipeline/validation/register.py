"""Pointing and roll of an image, fitted to the image itself.

The missions' C-kernels (attitude) are hundreds of MB per year, so instead the target's position in the frame and the
roll about the line of sight are fitted: a model image (Lambert-shaded ellipsoid, rings as single-scattering slabs
with the app's measured τ profile, plus a constant sky level; amplitudes solved by linear least squares at every
trial pose) is matched to the observed image. The observer → target vector and the target's orientation come from
Horizons and pck00011 (geometry.py), so the only free parameters are the pixel of the target centre (cx, cy), the roll
and the image parity (whether the archive's display order is mirrored relative to a right-handed camera): both
parities are fitted and the better one kept; the parity must agree for all frames of one camera.

Search, on an image pyramid (2× binning per level): at the coarsest level (≤ 96 px) every 3° of roll the model with
the target at the centre of a double-size canvas is cross-correlated with the image (FFT) for the best translation;
the best (roll, translation) seeds Nelder–Mead refinements of the exact model at each finer level (the camera is
rebuilt for every trial, so off-axis projection is exact).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import optimize

from . import geometry as g

VERBOSE = False
USE_CACHE = True


def model_components(res: dict[str, np.ndarray], sub: int) -> tuple[np.ndarray, np.ndarray]:
    """(disk, ring) model images per pixel from a cast() result."""
    cls = res["cls"]
    disk = np.where(cls == g.LIT, np.nan_to_num(res["mu0"]), 0.0)
    mu, mu0, tau = np.nan_to_num(res["mu"], nan=1.0), np.nan_to_num(res["mu0"], nan=1.0), np.nan_to_num(res["tau"])
    with np.errstate(divide="ignore", invalid="ignore"):
        ss = mu0 / (mu0 + mu) * (1 - np.exp(-tau * (1 / np.maximum(mu, 1e-3) + 1 / np.maximum(mu0, 1e-3))))
    ring = np.where(cls == g.RING_LIT, ss, 0.0)
    return g.pixel_view(disk, sub), g.pixel_view(ring, sub)


def components(res: dict[str, np.ndarray], sub: int, n_targets: int) -> list[np.ndarray]:
    """Model columns: the Lambert disk of each target (own amplitude each) and the rings."""
    d, r = model_components(res, sub)
    if n_targets == 1:
        return [d, r]
    out = []
    for k in range(n_targets):
        dk = np.where((res["cls"] == g.LIT) & (res["tgt"] == k), np.nan_to_num(res["mu0"]), 0.0)
        out.append(g.pixel_view(dk, sub))
    return out + [r]


def _lsq(obs: np.ndarray, comps: list[np.ndarray]) -> tuple[float, np.ndarray, np.ndarray]:
    ok = np.isfinite(obs)
    cols = [c[ok] for c in comps if np.any(c[ok] != 0)] + [np.ones(ok.sum())]
    A = np.column_stack(cols)
    coef, *_ = np.linalg.lstsq(A, obs[ok], rcond=None)
    r = obs[ok] - A @ coef
    model = np.full(obs.shape, np.nan)
    model[ok] = A @ coef
    return float(r @ r), coef, model


def bin_image(a: np.ndarray, b: int) -> np.ndarray:
    """Block mean (NaN-aware) over b×b; the image is cropped to a multiple of b."""
    h, w = (a.shape[0] // b) * b, (a.shape[1] // b) * b
    blk = a[:h, :w].reshape(h // b, b, w // b, b)
    with np.errstate(invalid="ignore"):
        return np.nanmean(blk, axis=(1, 3)) if np.isnan(blk).any() else blk.mean(axis=(1, 3))


@dataclass
class Fit:
    cx: float
    cy: float
    roll_deg: float
    flipped: bool
    rss: float
    rss_other_parity: float
    sigma_px: float               # statistical 1σ of the centre position (Gauss-Newton), pixels
    residual_rms: float           # rms (obs - model), I/F
    camera: g.Camera
    coef: list[float]

    def exact_json(self) -> dict:
        """The pose actually used to resample, at full precision (no display rounding)."""
        return {"cx": self.cx, "cy": self.cy, "rollDeg": self.roll_deg,
                "flipped": self.flipped, "rss": self.rss,
                "rssOtherParity": self.rss_other_parity, "centreSigmaPx": self.sigma_px,
                "residualRmsIoverF": self.residual_rms, "modelAmplitudes": self.coef,
                "cameraOrient": self.camera.row_major()}

    def to_json(self) -> dict:
        return {"targetCentrePx": [round(self.cx, 3), round(self.cy, 3)], "rollDeg": round(self.roll_deg, 4),
                "mirroredDisplayOrder": self.flipped, "rss": self.rss, "rssOtherParity": self.rss_other_parity,
                "centreSigmaPx": round(self.sigma_px, 4), "residualRmsIoverF": self.residual_rms,
                "modelAmplitudes": self.coef}


def _coarse(obs: np.ndarray, targets: list[g.Target], primary: int, pitch: float,
            roll_step: float = 3.0) -> tuple[float, float, float, float]:
    """Best (score, cx, cy, roll) from roll steps × FFT translation."""
    H, W = obs.shape
    o = np.nan_to_num(obs - np.nanmean(obs))
    pad = np.zeros((2 * H, 2 * W))
    pad[:H, :W] = o
    F_o = np.conj(np.fft.rfft2(pad))
    best = (-np.inf, 0.0, 0.0, 0.0)
    tg = targets[primary]
    for roll in np.arange(0.0, 360.0, roll_step):
        cam = g.camera_for(tg, 2 * W, 2 * H, pitch, W, H, roll)
        m = sum(components(g.cast(cam, targets, sub=1), 1, len(targets)))
        m = m - m.mean()
        c = np.fft.irfft2(F_o * np.fft.rfft2(m), s=m.shape)[:H + 1, :W + 1]
        v, u = np.unravel_index(np.argmax(c), c.shape)
        seg = m[v:v + H, u:u + W]
        score = c[v, u] / max(np.sqrt((seg ** 2).sum()), 1e-12)   # normalised by the model energy in the frame
        if score > best[0]:
            best = (float(score), float(W - u), float(H - v), float(roll))
    return best


def _rss_fn(o: np.ndarray, targets: list[g.Target], primary: int, pitch: float, sub: int):
    H, W = o.shape

    def rss(p):
        cam = g.camera_for(targets[primary], W, H, pitch, p[0], p[1], p[2])
        return _lsq(o, components(g.cast(cam, targets, sub=sub), sub, len(targets)))[0]
    return rss


def fit_pointing(obs: np.ndarray, targets: list[g.Target], primary: int, pitch: float,
                 flips: tuple[bool, ...] = (False, True), coarsest: int = 96) -> Fit:
    H, W = obs.shape
    levels = [1]
    while max(H, W) // (levels[-1] * 2) >= coarsest // 2 and max(H, W) // levels[-1] > coarsest:
        levels.append(levels[-1] * 2)
    results = []
    for flip in flips:
        o_full = obs[:, ::-1] if flip else obs
        pyr = {b: (o_full if b == 1 else bin_image(o_full, b)) for b in levels}
        top = levels[-1]
        _, cx, cy, roll = _coarse(pyr[top], targets, primary, pitch * top)
        x = np.array([cx, cy, roll])
        for b in reversed(levels):
            if b != top:
                x[:2] *= 2
            rss = _rss_fn(pyr[b], targets, primary, pitch * b, 1)
            step = 1.0 if b == top else 0.5
            simplex = x + np.array([[0, 0, 0], [step, 0, 0], [0, step, 0], [0, 0, step * (3.0 if b == top else 0.3)]])
            opt = optimize.minimize(rss, x, method="Nelder-Mead",
                                    options={"initial_simplex": simplex, "xatol": 5e-3, "fatol": 1e-12,
                                             "maxiter": 150 if b == 1 else 300})
            x = opt.x
            if VERBOSE:
                print(f"  flip={flip} level={b} rss={opt.fun:.5g} x={np.round(x, 3)} nfev={opt.nfev}", flush=True)
        results.append((opt.fun, flip, x, o_full, rss))
    results.sort(key=lambda t: t[0])
    best_rss, flip, x, o, rss = results[0]
    other = results[1][0] if len(results) > 1 else float("nan")
    cam = g.camera_for(targets[primary], W, H, pitch, x[0], x[1], x[2])
    _, coef, model = _lsq(o, components(g.cast(cam, targets, sub=1), 1, len(targets)))
    n = int(np.isfinite(o).sum())
    s2 = best_rss / max(n - 6, 1)
    h = 0.25                      # Gauss-Newton curvature of rss in (cx, cy), central differences
    hess = np.zeros((2, 2))
    for i in range(2):
        e_i = np.eye(3)[i] * h
        hess[i, i] = (rss(x + e_i) - 2 * best_rss + rss(x - e_i)) / h ** 2
    e0, e1 = np.eye(3)[0] * h, np.eye(3)[1] * h
    hess[0, 1] = hess[1, 0] = (rss(x + e0 + e1) - rss(x + e0 - e1) - rss(x - e0 + e1) + rss(x - e0 - e1)) / (4 * h * h)
    try:
        cov = 2 * s2 * np.linalg.inv(hess)
        sig = float(np.sqrt(max(np.max(np.diag(cov)), 0.0)))
    except np.linalg.LinAlgError:
        sig = float("nan")
    resid = float(np.sqrt(np.nanmean((o - model) ** 2)))
    return Fit(float(x[0]), float(x[1]), float(x[2]) % 360.0, bool(flip), best_rss, float(other), sig, resid, cam,
               [float(c) for c in coef])


def refit_translation(obs: np.ndarray, targets: list[g.Target], primary: int, pitch: float, cx: float, cy: float,
                      roll_deg: float) -> tuple[float, float, float]:
    """(cx, cy, rss) with the roll held fixed (e.g. the common roll of several frames of one sequence). Results are
    cached in data/cache/validation/refit/ by a digest of every input."""
    from ..paths import CACHE
    signature = fit_inputs(obs, targets, primary, pitch,
                           operation="translation", start=[cx, cy, roll_deg])
    path = CACHE / "validation" / "refit" / f"{input_digest(signature)}.json"
    cached = read_json_cache(path) if USE_CACHE else None
    if cached is not None:
        return tuple(cached)
    rss = _rss_fn(obs, targets, primary, pitch, 1)
    opt = optimize.minimize(lambda q: rss([q[0], q[1], roll_deg]), [cx, cy], method="Nelder-Mead",
                            options={"initial_simplex": [[cx, cy], [cx + 0.5, cy], [cx, cy + 0.5]], "xatol": 5e-3,
                                     "fatol": 1e-12, "maxiter": 200})
    out = (float(opt.x[0]), float(opt.x[1]), float(opt.fun))
    write_json_cache(path, out)
    return out


def read_json_cache(path):
    """A cached JSON value, or None when the file is missing or unreadable (e.g. truncated by a full disk)."""
    import json
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def write_json_cache(path, value) -> None:
    """Write a JSON cache file atomically (temporary file + rename), so an interrupted write leaves no stub."""
    import json
    import os
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value), encoding="utf-8", newline="\n")
    os.replace(tmp, path)


def fit_inputs(obs, targets, primary, pitch, **controls):
    """Every input to the optimizer, including numerical implementation/environment."""
    import hashlib
    from pathlib import Path
    from . import reproducibility as repro
    pixels = np.ascontiguousarray(obs, dtype="<f8")
    return {"pixels": {"sha256": hashlib.sha256(pixels.tobytes()).hexdigest(),
                       "shape": list(pixels.shape), "dtype": "float64-le"},
            "targets": [{"naif": t.naif, "pos": t.pos.tolist(), "orient": t.orient.tolist(),
                         "toSun": t.to_sun.tolist(), "radii": t.radii.tolist(),
                         "rings": None if t.rings is None else
                         {"radiusKm": t.rings.radius_km.tolist(), "tau": t.rings.tau.tolist()}}
                        for t in targets],
            "primary": primary, "pitch": pitch, "controls": controls,
            "runtime": repro.runtime(),
            "code": {p.name: repro.file_record(p)["sha256"] for p in
                     (Path(__file__), Path(g.__file__))}}


def input_digest(value):
    import hashlib
    import json
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
