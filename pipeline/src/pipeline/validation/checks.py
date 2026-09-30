"""Independent checks of the fitted pointing against the missions' own (C-kernel) pointing.

The fit uses only the image and Horizons + pck00011; the archives record where the camera actually pointed:
  * OPUS (PDS Ring-Moon Systems Node) lists each image's RA/Dec footprint (min/max over the field of view) computed
    with the mission's reconstructed pointing: its centre is compared with our camera's boresight.
  * New Horizons LORRI headers carry a full WCS from the reconstructed C-kernel: the pixel it assigns to the
    target's apparent direction is compared with our fitted target centre.
The fitted view is self-consistent in light-time-corrected ('LT') directions, as the renderer's scene is; the
archives' pointing is in apparent (aberrated) directions, so the stellar-aberration shift (Horizons 'LT+S' minus 'LT'
direction of the target) is added before comparing.
"""

from __future__ import annotations

import json
import math

import numpy as np

from .. import download
from .. import ephem_horizons as eh
from . import geometry as g

OPUS_META = "https://opus.pds-rings.seti.org/opus/api/metadata/{id}.json"


def _radec(v: np.ndarray) -> tuple[float, float]:
    v = v / np.linalg.norm(v)
    return math.degrees(math.atan2(v[1], v[0])) % 360.0, math.degrees(math.asin(v[2]))


def _unit(ra: float, dec: float) -> np.ndarray:
    r, d = math.radians(ra), math.radians(dec)
    return np.array([math.cos(d) * math.cos(r), math.cos(d) * math.sin(r), math.sin(d)])


def aberration_shift(case_id: str, product: str, naif: int, observer: str, et: float,
                     pos_lt: np.ndarray) -> np.ndarray:
    params = eh.vector_params(str(naif), observer, tlist=[f"{eh.et_to_jd(et):.9f}"], corr="LT+S")
    _, tab = eh.fetch_vectors(params, g.HORIZONS_SUBDIR, f"{case_id}_{product}_{naif}_from_{observer.lstrip('@')}"
                                                         f"_lts.txt")
    u_lts = tab.states[0, :3] / np.linalg.norm(tab.states[0, :3])
    return u_lts - pos_lt / np.linalg.norm(pos_lt)


def opus_footprint(case_id: str, opus_id: str) -> dict | None:
    try:
        path = download.fetch(OPUS_META.format(id=opus_id), f"validation/{case_id}", f"opus_{opus_id}.json")
    except Exception:  # noqa: BLE001 - the check is optional
        return None
    gc = json.loads(path.read_text()).get("General Constraints", {})
    try:
        return {k: float(gc[k]) for k in ("rightasc1", "rightasc2", "declination1", "declination2")} | \
            {"url": download.record(path)["url"]}
    except (KeyError, TypeError, ValueError):
        return None


def boresight_vs_opus(cam_native: g.Camera, shift: np.ndarray, fp: dict, pixel_rad: float) -> dict:
    """Our boresight (frame centre, aberration added) against the centre of OPUS's RA/Dec footprint."""
    b = cam_native.rays(np.array([0.5 * cam_native.width]), np.array([0.5 * cam_native.height]))[0]
    ra, dec = _radec(b + shift)
    ra1, ra2 = fp["rightasc1"], fp["rightasc2"]
    if ra2 < ra1:                         # footprint across RA 0
        ra2 += 360.0
    rc = 0.5 * (ra1 + ra2) % 360.0
    dc = 0.5 * (fp["declination1"] + fp["declination2"])
    ang = math.acos(max(-1.0, min(1.0, float(np.dot(_unit(ra, dec), _unit(rc, dc))))))
    inside = (fp["declination1"] <= dec <= fp["declination2"]) and \
        ((ra1 <= ra <= ra2) or (ra1 <= ra + 360.0 <= ra2))
    return {"method": "OPUS footprint centre (mission C-kernel pointing) vs fitted boresight + aberration",
            "fittedBoresightRaDec": [round(ra, 5), round(dec, 5)], "opusFootprintCentreRaDec": [round(rc, 5),
                                                                                                round(dc, 5)],
            "insideFootprint": bool(inside), "offsetDeg": round(math.degrees(ang), 5),
            "offsetNativePx": round(ang / pixel_rad, 2), "opusUrl": fp["url"]}


def target_vs_wcs(fits_path, cam_native: g.Camera, target_pos: np.ndarray, shift: np.ndarray, flipped: bool) -> dict:
    """LORRI: pixel of the target's apparent direction from the header WCS vs our fitted target centre."""
    from astropy.io import fits
    from astropy.wcs import WCS
    hdr = fits.getheader(fits_path)
    w = WCS(hdr)
    ra, dec = _radec(target_pos / np.linalg.norm(target_pos) + shift)
    x, y = (float(v) for v in w.all_world2pix(ra, dec, 0))
    cx, cy = cam_native.project(target_pos)          # continuous coords in our (possibly mirrored) frame
    col = cx - 0.5
    if flipped:
        col = (cam_native.width - 1) - col
    row = cy - 0.5
    return {"method": "LORRI header WCS (reconstructed C-kernel) pixel of the target's apparent direction vs the "
                      "fitted target centre (0-based array indices of the archive image)",
            "wcsPixel": [round(x, 2), round(y, 2)], "fittedPixel": [round(col, 2), round(row, 2)],
            "offsetNativePx": round(math.hypot(col - x, row - y), 2)}


def mission_boresight(case_id: str, opus_id: str | None, fits_path=None) -> tuple[np.ndarray, str] | None:
    """The mission's (apparent) boresight direction: LORRI header WCS at the frame centre, else OPUS's footprint
    centre."""
    if fits_path is not None:
        from astropy.io import fits
        from astropy.wcs import WCS
        hdr = fits.getheader(fits_path)
        w = WCS(hdr)
        ra, dec = (float(v) for v in w.all_pix2world(hdr["NAXIS1"] / 2 - 0.5, hdr["NAXIS2"] / 2 - 0.5, 0))
        return _unit(ra, dec), "LORRI header WCS at the frame centre"
    if opus_id:
        fp = opus_footprint(case_id, opus_id)
        if fp:
            ra1, ra2 = fp["rightasc1"], fp["rightasc2"] + (360.0 if fp["rightasc2"] < fp["rightasc1"] else 0.0)
            return (_unit(0.5 * (ra1 + ra2) % 360.0, 0.5 * (fp["declination1"] + fp["declination2"])),
                    "OPUS RA/Dec footprint centre")
    return None


def boresight_offset_px(cam_native: g.Camera, shift: np.ndarray, mission: np.ndarray, pixel_rad: float) -> float:
    b = cam_native.rays(np.array([0.5 * cam_native.width]), np.array([0.5 * cam_native.height]))[0] + shift
    b /= np.linalg.norm(b)
    return float(math.acos(max(-1.0, min(1.0, float(np.dot(b, mission))))) / pixel_rad)


def companion_signal(native: np.ndarray, cam_native: g.Camera, companion_pos: np.ndarray, flipped: bool,
                     r_in: float = 4.0, r_out: float = 9.0) -> tuple[float, float, float]:
    """Background-subtracted I/F summed within r_in native pixels of where the camera puts a companion body (in the
    archive's own pixel order), and that position. The image parity that puts real light there is the right one."""
    cx, cy = cam_native.project(companion_pos)
    col = cx - 0.5
    if flipped:
        col = (cam_native.width - 1) - col
    row = cy - 0.5
    H, W = native.shape
    if not (r_out <= col < W - r_out and r_out <= row < H - r_out):
        return float("nan"), col, row
    yy, xx = np.mgrid[0:H, 0:W]
    rr = np.hypot(xx - col, yy - row)
    ap, ann = rr <= r_in, (rr > r_in + 2) & (rr <= r_out)
    bg = float(np.nanmedian(native[ann]))
    return float(np.nansum(native[ap] - bg)), col, row


def roll_vs_wcs(fits_path, cam_native: g.Camera, target_pos: np.ndarray, shift: np.ndarray, flipped: bool) -> float:
    """Angle (deg) by which the fitted camera's image axes are rotated relative to the header WCS: the direction of
    a point 200 pixels to the right of the target, mapped through the WCS, compared with the fitted image."""
    from astropy.io import fits
    from astropy.wcs import WCS
    w = WCS(fits.getheader(fits_path))
    cx, cy = cam_native.project(target_pos)
    pts = []
    for dx in (0.0, 200.0):
        d = cam_native.rays(np.array([cx + dx]), np.array([cy]))[0] + shift
        ra, dec = _radec(d)
        x, y = (float(v) for v in w.all_world2pix(ra, dec, 0))
        pts.append((x, y))
    (x0, y0), (x1, y1) = pts
    if flipped:                      # archive order -> our (mirrored) order
        x0, x1 = (cam_native.width - 1) - x0, (cam_native.width - 1) - x1
    ang = math.degrees(math.atan2(y1 - y0, x1 - x0))          # 0 if the axes agree
    return (ang + 180.0) % 360.0 - 180.0


def wcs_parity(fits_path) -> tuple[bool, str]:
    """Image parity from a FITS WCS: det(CD) < 0 is the sky as seen (east left of north) when FITS rows run
    upwards, so in our top-down row order the archive image is mirrored."""
    from astropy.io import fits
    h = fits.getheader(fits_path)
    det = float(h["CD1_1"]) * float(h["CD2_2"]) - float(h["CD1_2"]) * float(h["CD2_1"])
    mirrored = det < 0
    return mirrored, (f"header WCS: det(CD) = {det:.4g} deg², i.e. {'standard' if det < 0 else 'reversed'} sky "
                      f"orientation with FITS rows running upwards, so the archive order read top-down is "
                      f"{'mirrored' if mirrored else 'direct'}")


def companion_centroid(native: np.ndarray, cam_native: g.Camera, companion_pos: np.ndarray,
                       radius: float = 40.0) -> tuple[float, float] | None:
    """Light-weighted centroid (our pixel coordinates, pixel centres at i + ½) of the positive, background-subtracted
    signal within `radius` pixels of the companion's predicted place."""
    cx, cy = cam_native.project(companion_pos)
    H, W = native.shape
    yy, xx = np.mgrid[0:H, 0:W]
    rr = np.hypot(xx + 0.5 - cx, yy + 0.5 - cy)
    win, ann = rr <= radius, (rr > radius) & (rr <= 1.5 * radius)
    if not win.any() or not ann.any():
        return None
    w = np.clip(np.nan_to_num(native - np.nanmedian(native[ann])), 0, None) * win
    if w.sum() <= 0:
        return None
    return float((w * (xx + 0.5)).sum() / w.sum()), float((w * (yy + 0.5)).sum() / w.sum())


def lorri_geometry(fits_path, tg: g.Target) -> dict:
    """The New Horizons SOC's SPICE geometry in the LORRI header (sub-spacecraft SPCTSCLA/LO, sub-solar SPCTSOLA/LO,
    target range SPCTRANG) against ours (Horizons + pck00011)."""
    from astropy.io import fits
    h = fits.getheader(fits_path)
    so, ss = tg.sub_point(-tg.pos), tg.sub_point(tg.to_sun)

    def dlon(a, b):
        return (a - b + 180.0) % 360.0 - 180.0
    return {"method": "LORRI header SPICE geometry (NH SOC) vs Horizons + pck00011",
            "subObserverDiffDeg": [round(so[0] - float(h["SPCTSCLA"]), 4), round(dlon(so[1], float(h["SPCTSCLO"])), 4)],
            "subSolarDiffDeg": [round(ss[0] - float(h["SPCTSOLA"]), 4), round(dlon(ss[1], float(h["SPCTSOLO"])), 4)],
            "rangeDiffKm": round(tg.range_km - float(h["SPCTRANG"]), 2)}
