"""Orientation provenance of a shape model: the body-fixed frame its vertices are in, the rotation model that frame
uses (from the source's own SPICE kernels or label), and how far it is from the app's frame for the body (the IAU
frame of pck00011, used by bodies.json), evaluated with SPICE at given epochs.
"""

from __future__ import annotations

import datetime as _dt
import math
from pathlib import Path

import numpy as np

J2000 = _dt.datetime(2000, 1, 1, 12, 0, 0)


def et_of(tdb_iso: str) -> float:
    """TDB seconds past J2000 of an ISO TDB calendar string (no leap seconds involved: TDB is uniform)."""
    return (_dt.datetime.fromisoformat(tdb_iso) - J2000).total_seconds()


def _rotations(kernels: list[Path], frame: str, ets: list[float]) -> list[np.ndarray]:
    import spiceypy as sp
    sp.kclear()
    try:
        for k in kernels:
            sp.furnsh(str(k))
        return [np.array(sp.pxform("J2000", frame, et)) for et in ets]
    finally:
        sp.kclear()


def _constants(kernels: list[Path], frame: str) -> dict | None:
    """Rotation constants (POLE_RA, POLE_DEC, PM polynomials) behind a PCK-class frame, if in a text kernel."""
    import spiceypy as sp
    sp.kclear()
    try:
        for k in kernels:
            sp.furnsh(str(k))
        code = sp.namfrm(frame)
        if code == 0:
            return None
        _, cls, clsid = sp.frinfo(code)
        if cls != 2 or not sp.bodfnd(clsid, "PM"):
            return None
        out = {"body": int(clsid)}
        for item in ("POLE_RA", "POLE_DEC", "PM"):
            n, vals = sp.bodvcd(clsid, item, 3)
            out[item] = [float(v) for v in vals[:n]]
        return out
    except Exception:  # noqa: BLE001 - absent constants are reported as None
        return None
    finally:
        sp.kclear()


def _pole_and_w(r: np.ndarray) -> tuple[float, float, float]:
    """IAU-style (α0, δ0, W) of a J2000 → body-fixed rotation matrix (rows = body axes in J2000)."""
    z, x = r[2], r[0]
    ra = math.degrees(math.atan2(z[1], z[0])) % 360.0
    dec = math.degrees(math.asin(max(-1.0, min(1.0, z[2]))))
    node = np.cross([0.0, 0.0, 1.0], z)                      # ascending node of the body equator on the ICRF equator
    node /= np.linalg.norm(node)
    w = math.degrees(math.atan2(float(np.cross(node, x) @ z), float(node @ x))) % 360.0
    return ra, dec, w


def equivalent_constants(kernels: list[Path], frame: str) -> dict | None:
    """For a frame without PCK constants of its own (a TK frame fixed to a PCK frame, e.g. ROS_LUTETIA), the
    IAU-form constants it amounts to: fixed pole and uniform W = W0 + Ẇ d (d = days from J2000 TDB), derived by
    evaluating the frame. None if the pole moves (> 1e-6°) or the rate is not uniform (> 1e-4° over 30 years)."""
    import spiceypy as sp
    day = 86400.0
    sp.kclear()
    try:
        for k in kernels:
            sp.furnsh(str(k))
        rot = {t: np.array(sp.pxform("J2000", frame, t * day)) for t in (0.0, 60.0 / day, 1.0, 100.0, 5000.0, 10000.0)}
    except Exception:  # noqa: BLE001 - not evaluable without more kernels
        return None
    finally:
        sp.kclear()
    ra0, dec0, w0 = _pole_and_w(rot[0.0])
    rate = ((_pole_and_w(rot[60.0 / day])[2] - w0 + 180.0) % 360.0 - 180.0) / (60.0 / day)
    for t in (1.0, 100.0, 10000.0):                            # refine, unwrapping with the running estimate
        ra, dec, w = _pole_and_w(rot[t])
        if abs(ra - ra0) > 1e-6 or abs(dec - dec0) > 1e-6:
            return None
        turns = round((w0 + rate * t - w) / 360.0)
        rate = (w + 360.0 * turns - w0) / t
    ra, dec, w = _pole_and_w(rot[5000.0])                      # independent check at ~14 years
    if abs(((w0 + rate * 5000.0 - w) + 180.0) % 360.0 - 180.0) > 1e-4:
        return None
    return {"POLE_RA": [round(ra0, 9), 0.0, 0.0], "POLE_DEC": [round(dec0, 9), 0.0, 0.0],
            "PM": [round(w0, 9), round(rate, 10), 0.0],
            "derived": f"evaluated from {frame} with SPICE (constant pole, uniform rotation)"}


def rotation_angle_deg(a: np.ndarray, b: np.ndarray) -> float:
    r = a @ b.T
    return math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(r) - 1.0) / 2.0))))


def iau_frame_name(pck11: Path, body: int) -> str | None:
    import spiceypy as sp
    sp.kclear()
    try:
        sp.furnsh(str(pck11))
        if not sp.bodfnd(body, "PM"):
            return None
        try:
            _, name = sp.cidfrm(body)
        except Exception:  # noqa: BLE001 - no frame associated with the body
            return None
        return name or None
    finally:
        sp.kclear()


def compare(kernels: list[Path], frame: str, pck11: Path, body: int | None, epochs: tuple[str, ...]) -> dict:
    """Orientation block for a shape header."""
    out: dict = {"frame": frame, "kernels": [k.name for k in kernels]}
    ets = [et_of(e) for e in epochs]
    iau = iau_frame_name(pck11, body) if body is not None else None
    out["appFrame"] = (f"{iau} (pck00011)" if iau else "none: pck00011 has no rotation model for this body")
    consts = _constants(kernels, frame) if kernels else None
    if consts:
        out["sourceRotation"] = consts
    if iau:
        consts11 = _constants([pck11], iau)
        if consts11:
            out["appRotation"] = consts11
    if not kernels:
        return out
    try:
        src = _rotations(kernels, frame, ets)
    except Exception as e:  # noqa: BLE001 - e.g. CK/dynamic frames that need more kernels
        out["comparison"] = f"not evaluated: {type(e).__name__}"
        return out
    if not consts:
        eq = equivalent_constants(kernels, frame)
        if eq:
            out["sourceRotation"] = eq
    if iau:
        try:
            app = _rotations([pck11], iau, ets)
            out["differenceDeg"] = {e: round(rotation_angle_deg(s, a), 4) for e, s, a in zip(epochs, src, app)}
            out["poleDifferenceDeg"] = {e: round(math.degrees(math.acos(max(-1.0, min(1.0, float(s[2] @ a[2]))))), 4)
                                        for e, s, a in zip(epochs, src, app)}
        except Exception as e:  # noqa: BLE001
            out["comparison"] = f"app frame not evaluated: {type(e).__name__}"
    return out


def compare_isolated(*args) -> dict:
    """`compare` in a separate process, so that loading and clearing kernels never touches the SPICE kernel pool of
    the build process (other stages may rely on it)."""
    import concurrent.futures as cf
    import multiprocessing as mp
    with cf.ProcessPoolExecutor(1, mp_context=mp.get_context("spawn")) as ex:
        return ex.submit(compare, *args).result()
