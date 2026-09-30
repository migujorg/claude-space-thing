"""Regions of interest: square pixel windows chosen from the geometric model of the fitted view.

A window qualifies only if every sub-sample of every pixel in it (and in a margin of `margin` pixels around it, for
registration error) belongs to the required class (lit surface of the target, lit ring face within a radius band,
empty sky) and satisfies the angle criteria. Among qualifying windows the kind decides which one is taken:

  disk-centre    lit surface, smallest mean emission angle (the sub-observer region)
  limb           lit surface, all emission angles ≥ min_emission (default 60°): the brightest (smallest mean
                 incidence) such window
  terminator     lit surface, all incidence angles ≥ 65° and ≤ 88°: largest mean incidence, then smallest emission
  ring           lit ring face with radii inside [r1, r2]: the window farthest from the planet's disk
  point          lit surface: the window whose mean surface point is nearest to `lat_lon`
  sky            no body or ring within `clear` pixels: nearest to the target and farthest from it (upper limits)
  disk-integrated  the rectangle enclosing the target's whole projected disk plus a margin (sum of all its light)
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage

from . import geometry as g


@dataclass
class RoiSpec:
    id: str
    kind: str
    size: int = 5
    target: int = 0
    ring_range_km: tuple[float, float] | None = None
    margin: int = 1
    clear: int = 6               # sky: minimum distance (px) from anything
    min_emission: float = 60.0   # limb: every sub-sample's emission angle at least this (deg)
    lat_lon: tuple[float, float] | None = None     # point: planetocentric latitude, east longitude (deg)
    note: str = ""


@dataclass
class Roi:
    spec: RoiSpec
    rect: tuple[int, int, int, int]            # x0, y0, x1, y1 (exclusive), renderer pixel coordinates
    geometry: dict = field(default_factory=dict)


def _windows(mask: np.ndarray, k: int, margin: int) -> np.ndarray:
    """Boolean map of window top-left corners (y, x) where the k×k window, grown by margin, lies inside mask."""
    kk = k + 2 * margin
    ok = ndimage.minimum_filter(mask.astype(np.uint8), size=kk, mode="constant", cval=0, origin=0) > 0
    # minimum_filter centres the footprint; convert centre positions to top-left corners of the k×k window
    H, W = mask.shape
    tl = np.zeros_like(mask)
    c0 = kk // 2
    ys, xs = np.nonzero(ok)
    y0, x0 = ys - c0 + margin, xs - c0 + margin
    good = (y0 >= 0) & (x0 >= 0) & (y0 + k <= H) & (x0 + k <= W)
    tl[y0[good], x0[good]] = True
    return tl


def _wmean(a: np.ndarray, k: int) -> np.ndarray:
    """Mean of a over the k×k window whose top-left corner is at each pixel (NaN beyond the edge)."""
    H, W = a.shape
    cs = np.zeros((H + 1, W + 1))
    cs[1:, 1:] = np.cumsum(np.cumsum(a, 0), 1)
    out = np.full((H, W), np.nan)
    s = cs[k:, k:] - cs[:-k, k:] - cs[k:, :-k] + cs[:-k, :-k]
    out[:H - k + 1, :W - k + 1] = s / (k * k)
    return out


def select(specs: list[RoiSpec], sub_res: dict[str, np.ndarray], sub: int) -> list[Roi]:
    cls_sub, tgt_sub = sub_res["cls"], sub_res["tgt"]
    cls, tgt = g.uniform_class(cls_sub, tgt_sub, sub)
    pv = {k: g.pixel_view(np.nan_to_num(sub_res[k], nan=0.0), sub) for k in ("inc", "emi", "pha", "mu0", "mu")}
    ring_r = g.pixel_view(np.nan_to_num(sub_res["ring_r"], nan=0.0), sub)
    inc_max = g.pixel_view(np.nan_to_num(sub_res["inc"], nan=180.0), sub, "max")
    inc_min = g.pixel_view(np.nan_to_num(sub_res["inc"], nan=0.0), sub, "min")
    emi_min = g.pixel_view(np.nan_to_num(sub_res["emi"], nan=0.0), sub, "min")
    emi_max = g.pixel_view(np.nan_to_num(sub_res["emi"], nan=90.0), sub, "max")
    r_min = g.pixel_view(np.nan_to_num(sub_res["ring_r"], nan=0.0), sub, "min")
    r_max = g.pixel_view(np.nan_to_num(sub_res["ring_r"], nan=1e12), sub, "max")
    anything = cls != g.SKY
    dist_any = ndimage.distance_transform_edt(~anything)
    out: list[Roi] = []
    for s in specs:
        k = s.size
        if s.kind == "disk-integrated":
            body = (tgt_sub == s.target)
            ys, xs = np.nonzero(body)
            if len(ys) == 0:
                continue
            y0, y1 = ys.min() // sub - s.margin, ys.max() // sub + 1 + s.margin
            x0, x1 = xs.min() // sub - s.margin, xs.max() // sub + 1 + s.margin
            H, W = cls.shape
            if y0 < 0 or x0 < 0 or y1 > H or x1 > W:
                continue                    # the disk is not entirely in the frame
            other = (tgt_sub >= 0) & (tgt_sub != s.target)
            if other[y0 * sub:y1 * sub, x0 * sub:x1 * sub].any():
                continue
            out.append(Roi(s, (int(x0), int(y0), int(x1), int(y1))))
            continue
        lit = (cls == g.LIT) & (tgt == s.target)
        if s.kind == "disk-centre":
            mask = lit
            score = -_wmean(pv["emi"], k)
        elif s.kind == "limb":
            mask = lit & (emi_min >= s.min_emission)
            score = -_wmean(pv["inc"], k)
        elif s.kind == "terminator":
            mask = lit & (inc_min >= 65.0) & (inc_max <= 88.0) & (emi_max <= 75.0)
            score = _wmean(pv["inc"], k) - 0.01 * _wmean(pv["emi"], k)
        elif s.kind == "ring":
            r1, r2 = s.ring_range_km
            mask = (cls == g.RING_LIT) & (tgt == s.target) & (r_min >= r1) & (r_max <= r2)
            disk = (tgt == s.target) & ((cls == g.LIT) | (cls == g.DARK))
            score = _wmean(ndimage.distance_transform_edt(~disk), k)
        elif s.kind == "point":
            mask = lit
            la, lo = np.radians(s.lat_lon[0]), np.radians(s.lat_lon[1])
            tv = np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])
            lat_s, lon_s = np.radians(sub_res["lat"]), np.radians(sub_res["lon"])
            comps = [np.cos(lat_s) * np.cos(lon_s), np.cos(lat_s) * np.sin(lon_s), np.sin(lat_s)]
            score = sum(tv[k] * _wmean(g.pixel_view(np.nan_to_num(comps[k]), sub), k_) for k, k_ in
                        ((0, s.size), (1, s.size), (2, s.size)))
        elif s.kind in ("sky-near", "sky-far"):
            mask = dist_any >= s.clear
            d_t = ndimage.distance_transform_edt(~((tgt == s.target) | (cls == -1)))
            score = -_wmean(d_t, k) if s.kind == "sky-near" else _wmean(d_t, k)
        else:
            raise ValueError(s.kind)
        tl = _windows(mask, k, s.margin)
        if not tl.any():
            continue
        sc = np.where(tl, np.nan_to_num(score, nan=-np.inf), -np.inf)
        y0, x0 = np.unravel_index(np.argmax(sc), sc.shape)
        out.append(Roi(s, (int(x0), int(y0), int(x0 + k), int(y0 + k))))
    for r in out:
        r.geometry = describe(r, sub_res, sub)
    return out


def describe(r: Roi, sub_res: dict[str, np.ndarray], sub: int) -> dict:
    x0, y0, x1, y1 = r.rect
    sl = (slice(y0 * sub, y1 * sub), slice(x0 * sub, x1 * sub))
    cls = sub_res["cls"][sl]
    out: dict = {"classFractions": {g.CLASS_NAMES[c]: round(float((cls == c).mean()), 4)
                                    for c in np.unique(cls) if c >= 0}}
    for key, name in (("inc", "incidenceDeg"), ("emi", "emissionDeg"), ("pha", "phaseDeg"), ("lat", "latitudeDeg"),
                      ("ring_r", "ringRadiusKm")):
        v = sub_res[key][sl]
        v = v[np.isfinite(v)]
        if v.size:
            out[name] = {"mean": round(float(v.mean()), 3), "min": round(float(v.min()), 3),
                         "max": round(float(v.max()), 3)}
    lon = sub_res["lon"][sl]
    lon = lon[np.isfinite(lon)]
    if lon.size and r.spec.kind not in ("ring",):
        z = np.exp(1j * np.radians(lon)).mean()
        out["eastLongitudeDeg"] = {"mean": round(float(np.degrees(np.angle(z)) % 360), 3),
                                   "spreadDeg": round(float(np.degrees(np.sqrt(-2 * np.log(max(abs(z), 1e-12))))), 3)}
    return out
