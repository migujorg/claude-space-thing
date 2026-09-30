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
