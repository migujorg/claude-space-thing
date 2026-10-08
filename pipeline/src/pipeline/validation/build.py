"""Build one validation case: download → I/F → geometry (Horizons + pck) → pointing fit → common reference view →
regions of interest → expected band radiance and XYZS with uncertainties → validation/cases/<id>/.

Outputs per case (all small enough to commit):
  case.json       view, ROIs with expected values and tolerances, fits, sources
  reference.bin   float32 little-endian I/F, shape (bands, H, W), resampled to the renderer's pixel grid of the view
  preview.png     the reference image (bands as colours) with the ROI rectangles
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from scipy import ndimage

from .. import cie, download
from .. import ephem_horizons as eh
from .. import ephem_kernels as ek
from ..paths import CACHE, OUT, RAW, REPO
from ..photometry import albedo, filters, solar
from ..photometry.common import Download
from ..schema import BuildContext, SourceRecord
from . import geometry as g
from . import photometry as vp
from . import checks, readers, register, roi
from .cases import FrameCase

VALIDATION = REPO / "validation"
TOLERANCE_K = 2.0
MIN_REGISTRATION_PX = 0.5
SCHEMA = "validation-case-v1"
FIT_VERSION = 2            # corrected VICAR pixel layout changes pointing inputs; invalidate cached fits
BG_WIDTH = 5               # pixels: sky frame around a disk-integrated rectangle for its background level
PARITY_RATIO_MIN = 1.10    # other parity's residual / chosen one below this: the image alone does not decide


@dataclass
class Prepared:
    """Everything the measurement step needs, whatever the instrument."""
    id: str
    title: str
    summary: str
    instrument: str
    observer_name: str
    observer_id: str
    targets: list[g.Target]                 # [primary, others...]
    view: g.Camera
    refs: list[np.ndarray]                  # I/F per band on the view grid
    bands: list[str]
    img_meta: list[dict]
    ctx: BuildContext
    calibration_sigma: list[float]          # per band, 1σ relative
    calibration_note: str
    calibration_sources: list[str]
    roi_specs: list[roi.RoiSpec]
    shape: vp.ShapeSpectrum
    pixel: dict
    notes: list[str]
    reference_image: int
    epoch_utc: str
    et: float
    rings: g.RingModel | None = None
    shapes: dict = field(default_factory=dict)   # naif -> ShapeSpectrum for secondary targets
    annotate: object = None                      # optional callable(roi entry) -> extra fields for that ROI
    ratios: list = field(default_factory=list)   # (numerator ROI id, denominator ROI id): calibration-free tests


def _rings(naif: int) -> g.RingModel:
    path = OUT / "rings.json"
    if not path.exists():
        raise FileNotFoundError(f"{path} missing: run `uv run python -m pipeline build --only light` first")
    from . import reproducibility as repro
    rj = repro.read_product(path, [[str(naif), "opticalDepth", "value", 0, "radiusKm"],
                                   [str(naif), "opticalDepth", "value", 0, "normalTau"],
                                   [str(naif), "opticalDepth", "sources"]])[str(naif)]
    od = rj["opticalDepth"]
    p = od["value"][0]
    tau = np.array([np.nan if v is None else v for v in p["normalTau"]], float)
    return g.RingModel(np.array(p["radiusKm"], float), tau, list(od["sources"]))


def _read(case: FrameCase, path: Path, lpath: Path | None) -> readers.Frame:
    if case.reader == "cassini":
        return readers.cassini_calib(path, lpath)
    if case.reader == "voyager":
        return readers.voyager_geomed(path, lpath)
    if case.reader == "lorri":
        return readers.lorri_sci(path)
    if case.reader == "epoxi":
        return readers.epoxi_rad(path)
    raise ValueError(case.reader)


def horizons_source(ctx: BuildContext, path_name: str, what: str) -> str:
    p = RAW / g.HORIZONS_SUBDIR / path_name
    rec = download.record(p)
    sid = f"horizons-{Path(path_name).stem.lower()}"
    ctx.add_source(SourceRecord(
        id=sid, title=f"JPL Horizons vector table: {what}", citation=eh.CITATION, url=rec["url"],
        retrieved=rec["retrieved"], sha256=rec["sha256"],
        notes="ICRF, km; VEC_CORR='LT' (target at t − light time as seen from the observer at t); reconstructed "
              "trajectory as served by Horizons (source named in the file header)."))
    return sid


def shape_for(naif: int, ctx: BuildContext) -> vp.ShapeSpectrum:
    if naif in (501, 502, 503, 504):
        from ..photometry import moons
        spec = moons.galilean_spectrum(naif, ctx)
    else:
        spec = albedo.spectrum_for(naif, ctx)
    return vp.ShapeSpectrum(spec.wl, spec.p, spec.label, list(spec.sources),
                            f"the disk-integrated geometric-albedo spectrum of NAIF {naif} (the light stage's input, "
                            f"label {spec.label})")


def resample_to_view(native: np.ndarray, cam_native: g.Camera, view: g.Camera, sub: int) -> np.ndarray:
    """Area-average the native image onto the view's pixel grid (sub × sub bilinear samples per view pixel)."""
    rays = view.grid_rays(sub).reshape(-1, 3)
    c = rays @ cam_native.M
    x = c[:, 0] / -c[:, 2] / cam_native.pitch + 0.5 * cam_native.width
    y = 0.5 * cam_native.height - c[:, 1] / -c[:, 2] / cam_native.pitch
    r, c = y - 0.5, x - 0.5                         # array index coordinates (pixel centres at integers)
    H, W = native.shape
    outside = (r < -0.5) | (r > H - 0.5) | (c < -0.5) | (c > W - 0.5)
    v = ndimage.map_coordinates(native, [np.clip(r, 0, H - 1), np.clip(c, 0, W - 1)], order=1, mode="nearest")
    v[outside] = np.nan
    v = v.reshape(view.height * sub, view.width * sub)
    return v.reshape(view.height, sub, view.width, sub).mean(axis=(1, 3))


def _fit_cached(case_id: str, product: str, sha: str, b: np.ndarray, targets: list[g.Target], pitch: float,
                flips: tuple[bool, ...]) -> register.Fit:
    """Pointing fit cached by every numerical input, implementation and environment."""
    signature = register.fit_inputs(b, targets, 0, pitch, operation="pointing", flips=flips,
                                    imageSha256=sha, fitVersion=FIT_VERSION)
    key = register.input_digest(signature)
    path = CACHE / "validation" / case_id / f"{product}-{key}.json"
    tg = targets[0]
    d = register.read_json_cache(path) if register.USE_CACHE else None
    if d is not None and "cameraOrient" in d:
        # The optimizer may use an unwrapped angle; recomputing from roll % 360
        # changes trig rounding. Replay the exact returned camera as well as pose.
        cam = g.Camera(np.array(d["cameraOrient"], float).reshape(3, 3), b.shape[1], b.shape[0], pitch)
        return register.Fit(d["cx"], d["cy"], d["roll"], d["flipped"], d["rss"], d["rss_other"], d["sigma"],
                            d["resid"], cam, d["coef"])
    ft = register.fit_pointing(b, targets, 0, pitch, flips=flips)
    register.write_json_cache(path, {"cx": ft.cx, "cy": ft.cy, "roll": ft.roll_deg, "flipped": ft.flipped,
                                     "rss": ft.rss, "rss_other": ft.rss_other_parity, "sigma": ft.sigma_px,
                                     "resid": ft.residual_rms, "coef": ft.coef,
                                     "cameraOrient": ft.camera.row_major()})
    return ft


def _parity_from_reference(case: FrameCase, ctx: BuildContext) -> tuple[bool, str]:
    """Image parity of the case's camera from a frame with a companion body: fit the primary with both parities and
    look for the companion's light where each solution puts it (kernels loaded by the caller)."""
    im, naif, comp = case.parity_reference
    sub = f"validation/{case.id}"
    dl = Download(id=f"{case.id}-parity-{im.product.lower()}", url=im.data_url, subdir=sub,
                  name=im.data_url.rsplit("/", 1)[-1], title=f"{case.instrument} image {im.product} (parity reference)",
                  citation=case.archive_citation)
    lab = Download(id=f"{case.id}-parity-{im.product.lower()}-label", url=im.label_url, subdir=sub,
                   name=im.label_url.rsplit("/", 1)[-1], title=f"PDS3 label of {im.product}",
                   citation=case.archive_citation) if im.label_url else None
    path = dl.fetch()
    fr = _read(case, path, lab.fetch() if lab else None)
    et = g.utc_to_et(fr.utc_mid)
    tg = g.horizons_target(f"{case.id}_parity_{im.product}", naif, case.observer, et)
    if naif == 699:
        tg.rings = _rings(699)
    tcs = [g.horizons_target(f"{case.id}_parity_{im.product}", c, case.observer, et) for c in comp]
    dl.register(ctx)
    if lab:
        lab.register(ctx)
    for t in [tg] + tcs:
        horizons_source(ctx, t.horizons_file, f"NAIF {t.naif} from {case.observer_name} at {fr.utc_mid} UTC")
    b = register.bin_image(fr.iof, case.bin)
    sha = download.sha256_file(path)
    best = _fit_cached(case.id, im.product, sha, b, [tg], case.pixel_rad * case.bin, (False, True))
    alt = _fit_cached(case.id, im.product, sha, b, [tg], case.pixel_rad * case.bin, (not best.flipped,))
    nat = fr.iof[: b.shape[0] * case.bin, : b.shape[1] * case.bin]
    res, detail = {}, {}
    for cand in (best, alt):
        cam = g.camera_for(tg, nat.shape[1], nat.shape[0], case.pixel_rad, cand.cx * case.bin, cand.cy * case.bin,
                           cand.roll_deg)
        per = {t.naif: checks.companion_signal(nat, cam, t.pos, cand.flipped) for t in tcs}
        detail[cand.flipped] = {k: round(v[0], 5) for k, v in per.items() if np.isfinite(v[0])}
        both = [k for k in per if np.isfinite(per[k][0])]
        res[cand.flipped] = both
    common = [k for k in res[True] if k in res[False]]
    sig = {f: float(sum(detail[f][k] for k in common)) for f in (True, False)}
    if not common or max(sig.values()) < 5 * max(abs(min(sig.values())), 1e-9):
        raise RuntimeError(f"{case.id}: parity reference {im.product} is not conclusive: {detail}")
    flip = max(sig, key=sig.get)
    ratio = max(best.rss, best.rss_other_parity) / min(best.rss, best.rss_other_parity)
    note = (f"from the reference frame {im.product} ({fr.utc_mid} UTC; NAIF {naif}, whose fit fixes the roll, with "
            f"NAIF {', '.join(str(k) for k in common)} in the field): the moons' light at their predicted places sums "
            f"to {sig[flip]:.4g} (I/F × pixels, background-subtracted) with the {'mirrored' if flip else 'direct'} "
            f"archive order and {sig[not flip]:.3g} with the other (per moon: {detail[flip]} vs {detail[not flip]}); "
            f"the primary's own fit residuals differ by a factor {ratio:.3f}")
    return flip, note


def _adopt_wcs_roll(case: FrameCase, path: Path, nat: np.ndarray, ft: register.Fit, tg: g.Target,
                    shift: np.ndarray) -> tuple[register.Fit, dict]:
    """LORRI: a sphere at low phase hardly constrains the roll, but the header WCS (reconstructed C-kernel) does.
    Rotate the fitted camera onto the WCS orientation, then refit only the target's pixel position."""
    W, H = nat.shape[1], nat.shape[0]

    def droll(roll):
        cam = g.camera_for(tg, W, H, case.pixel_rad, ft.cx * case.bin, ft.cy * case.bin, roll)
        return checks.roll_vs_wcs(path, cam, tg.pos, shift, ft.flipped)
    d0 = droll(ft.roll_deg)
    roll = min((ft.roll_deg + d0, ft.roll_deg - d0), key=lambda r: abs(droll(r)))
    roll = roll - droll(roll) if abs(droll(roll - droll(roll))) < abs(droll(roll)) else roll
    b = register.bin_image(nat, case.bin)
    cx, cy, rss = register.refit_translation(b, [tg], 0, case.pixel_rad * case.bin, ft.cx, ft.cy, roll % 360.0)
    free = ft.roll_deg
    ft.cx, ft.cy, ft.roll_deg, ft.rss = cx, cy, roll % 360.0, rss
    ft.camera = g.camera_for(tg, b.shape[1], b.shape[0], case.pixel_rad * case.bin, cx, cy, ft.roll_deg)
    note = {"freeRollDeg": round(free, 4), "rollDeg": round(ft.roll_deg, 4),
            "targetCentrePx": [round(cx, 3), round(cy, 3)], "rss": rss,
            "rollNote": f"roll from the header WCS (reconstructed C-kernel attitude); the free fit's roll differed by "
                        f"{d0:+.2f}° (a nearly spherical body at low phase fixes the roll only weakly); target "
                        "position refitted with the roll held"}
    return ft, note


def _adopt_companion_roll(case: FrameCase, nat: np.ndarray, ft: register.Fit, targets: list[g.Target]
                          ) -> tuple[register.Fit, dict, float]:
    """Roll from a companion's observed position: rotate the camera about the primary's centre until the predicted
    place of the companion (NAIF targets[1]) falls on its light-weighted centroid, then refit the primary's position
    with that roll. Returns the fit, a note and the companion's light in a 20-pixel aperture at the result."""
    tg, comp = targets[0], targets[1]
    W, H = nat.shape[1], nat.shape[0]
    roll = ft.roll_deg
    b = register.bin_image(nat, case.bin)
    cx, cy = ft.cx, ft.cy
    moved = 0.0
    for _ in range(3):
        cam = g.camera_for(tg, W, H, case.pixel_rad, cx * case.bin, cy * case.bin, roll)
        cen = checks.companion_centroid(nat, cam, comp.pos)
        if cen is None:
            break
        px, py = cam.project(comp.pos)
        a_obs = math.atan2(cen[1] - cy * case.bin, cen[0] - cx * case.bin)
        a_mod = math.atan2(py - cy * case.bin, px - cx * case.bin)
        d = math.degrees((a_obs - a_mod + math.pi) % (2 * math.pi) - math.pi)
        # image angles run clockwise (y down); pick the roll sign that closes the gap
        best = None
        for sgn in (1.0, -1.0):
            c2 = g.camera_for(tg, W, H, case.pixel_rad, cx * case.bin, cy * case.bin, roll + sgn * d)
            q = c2.project(comp.pos)
            miss = math.hypot(q[0] - cen[0], q[1] - cen[1])
            if best is None or miss < best[0]:
                best = (miss, roll + sgn * d)
        moved += best[1] - roll
        roll = best[1] % 360.0
        cx, cy, rss = register.refit_translation(b, [tg], 0, case.pixel_rad * case.bin, cx, cy, roll)
    cam = g.camera_for(tg, W, H, case.pixel_rad, cx * case.bin, cy * case.bin, roll)
    sig = checks.companion_signal(nat, cam, comp.pos, False, r_in=20.0, r_out=35.0)[0]
    rss = register.refit_translation(b, [tg], 0, case.pixel_rad * case.bin, cx, cy, roll)[2]
    free = ft.roll_deg
    ft = register.Fit(cx, cy, roll, ft.flipped, rss, ft.rss_other_parity, ft.sigma_px, ft.residual_rms,
                      g.camera_for(tg, b.shape[1], b.shape[0], case.pixel_rad * case.bin, cx, cy, roll), ft.coef)
    note = {"freeRollDeg": round(free, 4), "rollDeg": round(roll, 4), "targetCentrePx": [round(cx, 3), round(cy, 3)],
            "rss": rss, "rollNote": f"roll from NAIF {comp.naif}'s observed position (its light-weighted centroid "
                                    f"brought onto its predicted place; {moved:+.2f}° from the free fit), target "
                                    "position refitted with the roll held"}
    return ft, note, sig


def prepare_frame_case(case: FrameCase, *, verbose: bool = True) -> Prepared:
    t_start = time.time()
    ctx = BuildContext(0.0, 0.0)
    ek.lsk(ctx), ek.pck(ctx), ek.planetary(ctx)
    for d in case.doc_sources:
        d.register(ctx)
    filters.register(ctx, tuple(im.band for im in case.images))
    solar.register_sources(ctx)
    shape = shape_for(case.target, ctx) if case.shape == "body" else vp.FLAT
    shapes = {n: shape_for(n, ctx) for n in case.others}
    rings = _rings(case.target) if case.rings else None      # τ sources: cited via rings.json ('appProducts')

    frames, fits, tlist, img_meta = [], [], [], []
    flip = None
    parity_note = ""
    with g.kernels():
        if case.parity_reference is not None:
            flip, parity_note = _parity_from_reference(case, ctx)
        for i, (im, dl, lab) in enumerate(case.downloads()):
            path = dl.fetch()
            lpath = lab.fetch() if lab else None
            fr = _read(case, path, lpath)
            et = g.utc_to_et(fr.utc_mid)
            fr.utc_mid = g.et_to_utc(et)                     # ISO calendar form for every mission
            tg = g.horizons_target(f"{case.id}_{im.product}", case.target, case.observer, et)
            tg.rings = rings
            others = [g.horizons_target(f"{case.id}_{im.product}", n, case.observer, et) for n in case.others]
            if fr.times_r2:
                fr.iof = fr.iof * tg.sun_distance_au ** 2
            a = fr.iof
            if case.crop:
                x0, y0, x1, y1 = case.crop
                a = a[y0:y1, x0:x1]
            b = register.bin_image(a, case.bin)
            if flip is None and case.reader == "lorri":
                flip, parity_note = checks.wcs_parity(path)
            flips = (False, True) if flip is None else (flip,)
            if verbose:
                print(f"[{case.id}] {im.product} {im.band}: pointing fit "
                      f"({'both parities' if flip is None else 'mirrored' if flip else 'direct'})", flush=True)
            fit_targets = [tg] + (others if case.fit_with_others else [])
            ft = _fit_cached(case.id, im.product, download.sha256_file(path), b, fit_targets,
                             case.pixel_rad * case.bin, flips)
            shift = checks.aberration_shift(case.id, im.product, case.target, case.observer, et, tg.pos)
            if flip is None:
                ratio = ft.rss_other_parity / ft.rss
                parity_note = (f"image fit: the other parity's residual sum of squares is {ratio:.3f} × the chosen "
                               "one's")
                mb = checks.mission_boresight(case.id, im.opus_id, path if case.reader == "lorri" else None) \
                    if ratio < PARITY_RATIO_MIN and not case.fit_with_others else None
                if ratio < PARITY_RATIO_MIN and case.fit_with_others:
                    alt = _fit_cached(case.id, im.product, download.sha256_file(path), b, fit_targets,
                                      case.pixel_rad * case.bin, (not ft.flipped,))
                    cand = {}
                    for c0 in (ft, alt):
                        o = a[: b.shape[0] * case.bin, : b.shape[1] * case.bin]
                        o = o[:, ::-1] if c0.flipped else o
                        c1, _, sig = _adopt_companion_roll(case, o, c0, [tg] + others)
                        cand[c0.flipped] = (c1, sig)
                    win = min(cand, key=lambda k: cand[k][0].rss)
                    parity_note = (f"the image fit alone does not decide (other parity's residual {ratio:.3f} × the "
                                   f"better one's); with the roll set by NAIF {others[0].naif}'s observed position, "
                                   f"the {'mirrored' if win else 'direct'} order explains the primary with residual "
                                   f"{cand[win][0].rss:.4g}, the other order with {cand[not win][0].rss:.4g} "
                                   f"(companion light at its predicted place {cand[win][1]:.4g} vs "
                                   f"{cand[not win][1]:.4g})")
                    ft = alt if alt.flipped == win else ft
                if mb is not None:
                    alt = _fit_cached(case.id, im.product, download.sha256_file(path), b, fit_targets,
                                      case.pixel_rad * case.bin, (not ft.flipped,))
                    offs = []
                    for cand in (ft, alt):
                        cam_c = g.camera_for(tg, b.shape[1] * case.bin, b.shape[0] * case.bin, case.pixel_rad,
                                             cand.cx * case.bin, cand.cy * case.bin, cand.roll_deg)
                        offs.append(checks.boresight_offset_px(cam_c, shift, mb[0], case.pixel_rad))
                    if offs[1] < offs[0]:
                        alt.rss_other_parity = ft.rss
                        ft, offs = alt, offs[::-1]
                    parity_note = (f"the image fit does not decide (other parity's residual {ratio:.3f} × the "
                                   f"better one's); decided by the mission's pointing ({mb[1]}): boresight offset "
                                   f"{offs[0]:.1f} native px for the chosen parity against {offs[1]:.1f} for the "
                                   "other")
                flip = ft.flipped
            nat = a[: b.shape[0] * case.bin, : b.shape[1] * case.bin]
            nat = nat[:, ::-1] if flip else nat
            free_fit_result = ft.exact_json()
            wcs_roll_note = None
            if case.reader == "lorri":        # roll from the mission's attitude (header WCS), translation refitted
                ft, wcs_roll_note = _adopt_wcs_roll(case, path, nat, ft, tg, shift)
            elif case.fit_with_others and others:   # roll from the companion's observed position
                ft, wcs_roll_note, _ = _adopt_companion_roll(case, nat, ft, [tg] + others)
            cam_n = g.camera_for(tg, nat.shape[1], nat.shape[0], case.pixel_rad, ft.cx * case.bin,
                                 ft.cy * case.bin, ft.roll_deg)
            frames.append((fr, nat, cam_n))
            fits.append(ft)
            tlist.append([tg] + others)
            dl.register(ctx)
            if lab:
                lab.register(ctx)
            hids = [horizons_source(ctx, t.horizons_file, f"NAIF {t.naif} from {case.observer_name} "
                                                           f"({case.observer}) at {fr.utc_mid} UTC")
                    for t in [tg] + others]
            pc = []
            if im.opus_id:
                fp = checks.opus_footprint(case.id, im.opus_id)
                if fp:
                    pc.append(checks.boresight_vs_opus(cam_n, shift, fp, case.pixel_rad))
            roll_sigma = 0.0
            if case.reader == "lorri":
                chk = checks.target_vs_wcs(path, cam_n, tg.pos, shift, flip)
                droll = checks.roll_vs_wcs(path, cam_n, tg.pos, shift, flip)
                chk["rollDifferenceDeg"] = round(droll, 3)
                pc.append(chk)
                roll_sigma = abs(droll)             # the mission's attitude as the roll reference
            img_meta.append({"product": im.product, "opusId": im.opus_id, "band": im.band, "utcMid": fr.utc_mid,
                             "et": et, "exposureS": fr.exposure_s, "archiveUrl": im.data_url,
                             "labelUrl": im.label_url, "calibration": fr.notes, "horizonsSources": hids,
                             "fit": ft.to_json(),
                             "fitInputs": register.fit_inputs(b, fit_targets, 0, case.pixel_rad * case.bin,
                                                               operation="pointing", flips=flips,
                                                               imageSha256=download.sha256_file(path),
                                                               fitVersion=FIT_VERSION),
                             "fitResult": ft.exact_json(),
                             "freeFitResult": free_fit_result,
                             "registrationSigmaPx": max(MIN_REGISTRATION_PX, 3 * ft.sigma_px),
                             "aberrationShiftRad": float(np.linalg.norm(shift)), "pointingChecks": pc,
                             "rollSigmaDeg": roll_sigma})
            if wcs_roll_note:
                img_meta[-1]["fit"].update(wcs_roll_note)
            if case.reader == "lorri":
                img_meta[-1]["geometryCheck"] = checks.lorri_geometry(path, tg)
            if verbose:
                print(f"    centre ({ft.cx:.2f}, {ft.cy:.2f}) roll {ft.roll_deg:.3f} mirrored={ft.flipped} "
                      f"rss {ft.rss:.4g} (other parity {ft.rss_other_parity:.4g}) {time.time() - t_start:.0f} s",
                      flush=True)
    if case.common_roll and len(fits) > 1:
        z = np.mean([np.exp(1j * np.radians(f.roll_deg)) for f in fits])
        roll_c = float(np.degrees(np.angle(z)) % 360.0)
        roll_sig = float(np.degrees(np.sqrt(-2.0 * np.log(abs(z)))))
        with g.kernels():
            for k, (ft, (fr, nat, cam_n), tl) in enumerate(zip(fits, frames, tlist)):
                b = register.bin_image(nat, case.bin)            # nat is in the fitted (possibly mirrored) order
                cx, cy, rss = register.refit_translation(b, tl if case.fit_with_others else [tl[0]], 0,
                                                         case.pixel_rad * case.bin, ft.cx, ft.cy, roll_c)
                img_meta[k]["fit"]["freeRollDeg"] = img_meta[k]["fit"]["rollDeg"]
                img_meta[k]["fit"].update({"targetCentrePx": [round(cx, 3), round(cy, 3)], "rollDeg": round(roll_c, 4),
                                           "rssCommonRoll": rss,
                                           "rollNote": f"common roll of the {len(fits)} frames (circular mean of the "
                                                       f"free fits); their circular spread {roll_sig:.2f}° is the "
                                                       "roll uncertainty"})
                img_meta[k]["rollSigmaDeg"] = roll_sig
                ft.cx, ft.cy, ft.roll_deg = cx, cy, roll_c
                ft.camera = g.camera_for(tl[0], b.shape[1], b.shape[0], case.pixel_rad * case.bin, cx, cy, roll_c)
                frames[k] = (fr, nat, g.camera_for(tl[0], nat.shape[1], nat.shape[0], case.pixel_rad,
                                                   cx * case.bin, cy * case.bin, roll_c))
    for meta, ft in zip(img_meta, fits):
        meta["fitResult"] = ft.exact_json()
    ref = case.reference_image
    view = fits[ref].camera
    refs = [resample_to_view(nat, cam_n, view, case.bin) for (fr, nat, cam_n) in frames]
    return Prepared(
        id=case.id, title=case.title, summary=case.summary, instrument=case.instrument,
        observer_name=case.observer_name, observer_id=case.observer, targets=tlist[ref], view=view, refs=refs,
        bands=[im.band for im in case.images], img_meta=img_meta, ctx=ctx,
        calibration_sigma=[case.calibration_sigma] * len(case.images), calibration_note=case.calibration_note,
        calibration_sources=[d.id for d in case.doc_sources], roi_specs=case.rois, shape=shape,
        pixel={"nativePitchRad": case.pixel_rad, "binning": case.bin, "note": case.pixel_note,
               "mirroredDisplayOrder": bool(flip), "parityDecision": parity_note,
               "mirrorNote": "reference.bin and the ROIs are in the renderer's (right-handed) orientation; if "
                             "mirroredDisplayOrder is true the archive image was flipped left-right"},
        notes=case.notes, reference_image=ref, epoch_utc=img_meta[ref]["utcMid"], et=img_meta[ref]["et"],
        rings=rings, shapes=shapes, ratios=list(case.ratios))


# ---------------------------------------------------------------------------------------------- measurement


def _stats(a: np.ndarray, rect: tuple[int, int, int, int], delta_px: float) -> dict:
    x0, y0, x1, y1 = rect
    v = a[y0:y1, x0:x1]
    n = int(np.isfinite(v).sum())
    mean = float(np.nanmean(v)) if n else float("nan")
    std = float(np.nanstd(v)) if n else float("nan")

    def m(dx, dy):
        xs0, ys0 = x0 + dx, y0 + dy
        if xs0 < 0 or ys0 < 0 or xs0 + (x1 - x0) > a.shape[1] or ys0 + (y1 - y0) > a.shape[0]:
            return mean
        return float(np.nanmean(a[ys0:ys0 + (y1 - y0), xs0:xs0 + (x1 - x0)]))
    gx = (m(1, 0) - m(-1, 0)) / 2
    gy = (m(0, 1) - m(0, -1)) / 2
    reg = float(delta_px * np.hypot(gx, gy))
    return {"mean": mean, "std": std, "n": n, "nTotal": int(v.size), "sigmaNoise": std / np.sqrt(max(n, 1)),
            "sigmaRegistration": reg}


def _rel(x: float, ref: float) -> float:
    return float(abs(x) / abs(ref)) if ref else float("inf")


def measure(p: Prepared, sub: int = 4) -> dict:
    tref = p.targets[0]
    res = g.cast(p.view, p.targets, sub=sub)
    rois = roi.select(p.roi_specs, res, sub, refs=p.refs)
    cls_pix, _ = g.uniform_class(res["cls"], res["tgt"], sub)
    with g.kernels():
        sub_pts = [(t.sub_point(-t.pos), t.sub_point(t.to_sun)) for t in p.targets]
    sun_au = tref.sun_distance_au
    sky_std = [np.nan] * len(p.refs)
    for r in rois:
        if r.spec.kind.startswith("sky"):
            for k, a in enumerate(p.refs):
                st = _stats(a, r.rect, 0.0)
                sky_std[k] = st["std"] if not np.isfinite(sky_std[k]) else min(sky_std[k], st["std"])
    roi_json = []
    for r in rois:
        tgt = p.targets[r.spec.target]
        bands, band_json = [], []
        tcx, tcy = p.view.project(tgt.pos)
        r_px = math.hypot(0.5 * (r.rect[0] + r.rect[2]) - tcx, 0.5 * (r.rect[1] + r.rect[3]) - tcy)
        for k, (band, a) in enumerate(zip(p.bands, p.refs)):
            delta = math.hypot(p.img_meta[k]["registrationSigmaPx"],
                               math.radians(p.img_meta[k].get("rollSigmaDeg") or 0.0) * r_px)
            st = _stats(a, r.rect, 0.0 if r.spec.kind == "disk-integrated" else delta)
            bg = None
            if r.spec.kind == "disk-integrated":
                # the camera's scattered light and zero level around the disk: the median sky level in a frame
                # of BG_WIDTH pixels around the rectangle is subtracted (the renderer has no scattered light). The
                # level's uncertainty under the disk: the scatter of the frame's four sides' medians (gradients) and
                # the robust pixel scatter / √n (noise)
                x0, y0, x1, y1 = r.rect
                w = BG_WIDTH
                box = np.zeros(a.shape, bool)
                box[max(y0 - w, 0):y1 + w, max(x0 - w, 0):x1 + w] = True
                box[y0:y1, x0:x1] = False
                ring = box & (cls_pix == g.SKY) & np.isfinite(a)
                if ring.sum() >= 20:
                    vals = a[ring]
                    lvl = float(np.median(vals))
                    mad = float(1.4826 * np.median(np.abs(vals - lvl)))
                    yy, xx = np.nonzero(ring)
                    sides = [a[yy[m], xx[m]] for m in (yy < y0, yy >= y1, (xx < x0) & (yy >= y0) & (yy < y1),
                                                       (xx >= x1) & (yy >= y0) & (yy < y1))]
                    meds = [float(np.median(v)) for v in sides if v.size >= 5]
                    grad = float(np.std(meds)) if len(meds) >= 2 else mad
                    sig_lvl = math.hypot(grad, mad / math.sqrt(vals.size))
                    bg = {"level": lvl, "levelSigma": sig_lvl, "robustPixelSpread": mad,
                          "sideMedians": meds, "pixels": int(vals.size), "rawMean": st["mean"]}
                    st["mean"] = st["mean"] - lvl
                    st["sigmaNoise"] = math.hypot(sig_lvl, (sky_std[k] if np.isfinite(sky_std[k]) else 0.0)
                                                  / np.sqrt(max(st["n"], 1)))
                elif np.isfinite(sky_std[k]):
                    st["sigmaNoise"] = sky_std[k] / np.sqrt(max(st["n"], 1))
            srel = {"calibration": p.calibration_sigma[k], "noise": _rel(st["sigmaNoise"], st["mean"]),
                    "registration": _rel(st["sigmaRegistration"], st["mean"])}
            bands.append(vp.BandValue(band, st["mean"], srel))
            lb = vp.band_radiance(band, st["mean"], sun_au)
            s_tot = float(np.sqrt(sum(v ** 2 for v in srel.values()))) if st["mean"] > 0 else float("nan")
            band_json.append({
                "filter": band, "product": p.img_meta[k]["product"],
                "iof": {"mean": st["mean"], "std": st["std"], "n": st["n"], "nInRect": st["nTotal"],
                        **({"background": bg} if bg else {})},
                "sigmaRel": {k2: round(v, 5) for k2, v in srel.items()},
                "bandRadiance": {"value": lb, "sigma": abs(lb) * s_tot if np.isfinite(s_tot) else None,
                                 "unit": "W m-2 sr-1 nm-1", "bandSolarIrradiance1AU": vp.band_solar_irradiance(band)},
            })
        if r.spec.kind == "ring":
            sh = vp.FLAT
        elif r.spec.target == 0:
            sh = p.shape
        else:
            sh = p.shapes.get(tgt.naif, vp.FLAT)
        entry = {"id": r.spec.id, "kind": r.spec.kind, "note": r.spec.note or None, "target": tgt.naif,
                 "rect": list(r.rect), "pixels": (r.rect[2] - r.rect[0]) * (r.rect[3] - r.rect[1]),
                 "geometry": r.geometry, "bands": band_json}
        complete = all(bj["iof"]["n"] == bj["iof"]["nInRect"] for bj in band_json)
        if r.spec.kind.startswith("sky") and not complete:
            entry["expected"] = {"type": "none", "label": "unknown",
                                 "method": "no valid sky pixels in this window (not recorded by the instrument)"}
        elif r.spec.kind.startswith("sky"):
            up_iof = max(max(b.iof, 0.0) + TOLERANCE_K * bj["iof"]["std"] for b, bj in zip(bands, band_json))
            G = cie.xyzs(solar.spectrum().grid) / (np.pi * sun_au ** 2)
            entry["expected"] = {
                "type": "upper-limit", "upperLimitXYZS": [float(v) for v in G * up_iof],
                "comparison": "every channel of the renderer's mean radiance over rect ≤ upperLimitXYZS",
                "label": "derived",
                "method": f"Largest band I/F in the window + {TOLERANCE_K:g} × its pixel standard deviation "
                          f"(I/F {up_iof:.3g}), converted with a solar (grey) spectrum. The camera's scattered "
                          "light and the calibration's zero level make this an upper limit on the true sky."}
        elif not complete or not all(b.iof > 0 for b in bands):
            entry["expected"] = {"type": "none", "label": "unknown",
                                 "method": "the window has pixels without valid data in some band, or a band mean "
                                           "≤ 0: no expectation"}
        else:
            x = vp.xyzs_radiance(bands, sh, sun_au)
            entry["expected"] = {
                "type": "value", "XYZS": x["value"], "sigma": x["sigma"],
                "tolerance": [TOLERANCE_K * s for s in x["sigma"]],
                "comparison": "|renderer mean XYZS over rect − XYZS| ≤ tolerance, per channel",
                "label": x["label"],
                "method": ("XYZS radiance of r(λ) = p̃(λ)·ρ(λ) (validation/photometry.py): p̃ = " + sh.note +
                           f"; ρ from {len(bands)} band I/F value(s); Sun at {sun_au:.5f} AU (TSIS-1 HSRS, "
                           "CIE 1931 2° and 1951 scotopic observers)."),
                "budget": x["budget"], "bandCentersNm": x["bandCentersNm"], "rho": x["rho"],
                "colorCriterion": x["colorCriterion"]}
        if r.spec.kind == "disk-integrated":
            prev = app_preview(tgt, entry, p.view)
            if prev:
                entry["appDataPreview"] = prev
        if p.annotate is not None:
            entry.update(p.annotate(entry))
        if p.id == "jupiter-nh-lorri-2007" and r.spec.kind == "disk-centre":
            entry["sceneDependence"] = {
                "reason": "The observed centre is in Jupiter's 2007 equatorial zone; the app holds the OPAL "
                          "2025-12-11 map, not that atmospheric scene at the observation epoch.",
                "sources": ["LORRI observation: lor_0031736039 (2007-01-22)",
                            "Simon et al. (2015), OPAL, ApJ 812, 55, doi:10.1088/0004-637X/812/1/55; "
                            "MAST doi:10.17909/T9G593, cycle 32 Jupiter map 2025-12-11"]}
        if p.id == "earth-moon-epoxi-2008" and r.spec.id == "earth-centre":
            entry["sceneDependence"] = {
                "reason": "Earth-centre and earth-centre / earth-disk-integrated compare one region of the "
                          "2008-05-29 frame with Earth drawn using the satellite cloud mosaic of 2026-09-28. "
                          "Whether cloud lies in that region is weather the app does not hold for 2008. "
                          "The whole-disk earth-disk-integrated row remains a brightness comparison of cloud "
                          "statistics, as the case's own note states. Root decided this on 2026-10-07 at "
                          "19:30 PDT when the cloud-angular-law correction was about to turn both rows from "
                          "pass to fail: both rows passed until then with a cloud law that was two to eight "
                          "times too bright at this geometry. The decision rests on what the rows compare, "
                          "not on either verdict.",
                "sources": ["EPOXI observation: HV08052902_1000116_001 (2008-05-29)",
                            "earth-moon-epoxi-2008 case note: renderer cloud epoch 2026-09-28; "
                            "docs/architecture.md section 6, Earth cloud mosaic",
                            "Root decision, 2026-10-07 19:30 PDT, epoxi-scene-rows lane brief; "
                            ".lanes/run/cloud-angular-law/PROPOSAL.md section 4"]}
        roi_json.append(entry)

    ratio_json = _ratios(p, roi_json)
    view = p.view
    bodies = []
    for t, (so, ss) in zip(p.targets, sub_pts):
        bodies.append({"naifId": t.naif, "name": t.name, "pos": t.pos.tolist(), "toSun": t.to_sun.tolist(),
                       "orient": [float(v) for v in t.orient.ravel()], "radii": t.radii.tolist(),
                       "rangeKm": t.range_km, "sunDistanceAu": t.sun_distance_au, "phaseDeg": t.phase_deg(),
                       "subObserver": {"latDeg": so[0], "eastLonDeg": so[1]},
                       "subSolar": {"latDeg": ss[0], "eastLonDeg": ss[1]}, "rings": t.rings is not None})
    out = {
        "schema": SCHEMA, "id": p.id, "title": p.title, "summary": p.summary,
        "generated": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "observation": {
            "observer": p.observer_name, "observerHorizonsId": p.observer_id, "instrument": p.instrument,
            "target": {"naifId": tref.naif, "name": tref.name},
            "images": p.img_meta, "referenceImage": p.reference_image, "pixel": p.pixel,
            "calibration": {"sigmaRel1": p.calibration_sigma, "note": p.calibration_note,
                            "sources": p.calibration_sources},
        },
        "view": {
            "epochUtc": p.epoch_utc, "et": p.et,
            "camera": {"orient": view.row_major(), "fovY": view.fov_y, "width": view.width, "height": view.height,
                       "pixelPitchRad": view.pitch,
                       "convention": "SceneCamera: camera→ICRF, columns (right, up, back), row-major; looks along "
                                     "−Z; pixel (x, y), y down, ray ∝ right·(x+½−W/2)s + up·(H/2−y−½)s − back, "
                                     "s = pixelPitchRad = 2·tan(fovY/2)/height"},
            "bodies": bodies,
            "sun": {"pos": (tref.pos + tref.to_sun).tolist()},
        },
        "reference": {"file": "reference.bin", "dtype": "float32-le", "shape": [len(p.refs), view.height, view.width],
                      "bands": p.bands, "quantity": "I/F (NaN = no valid data)",
                      "note": "each band image resampled (area average) onto the view with its own fitted "
                              "registration; row 0 = top"},
        "comparison": {
            "renderOutput": "the renderer's HDR buffer in absolute XYZS radiance (X, Y, Z in cd/m² with K_m = "
                            "683.002 lm/W, S in scotopic cd/m² with K'_m = 1700.06 lm/W), before the eye model "
                            "(no exposure, glare, PSF or tone mapping), rendered for `view` at width × height",
            "roiStatistic": "mean over the pixels x0 ≤ x < x1, y0 ≤ y < y1 of `rect`",
            "tolerance": f"{TOLERANCE_K:g}σ of the combined 1σ budget (calibration, noise, registration, spectral "
                         "model); sky ROIs are upper limits",
        },
        "rois": roi_json,
        "ratios": ratio_json,
        "appProducts": {"rings.json opticalDepth sources": p.rings.sources if p.rings else None,
                        "shape spectrum sources": p.shape.sources or None},
        "notes": p.notes,
        "sources": [s.to_json() for s in p.ctx.sources.values()],
    }
    return {"json": out, "refs": p.refs, "rois": rois}


def _phase_factor(pf: dict, alpha: float) -> float | None:
    """Φ(α) of a photometry.json PhaseFunction (normalised to 1 at its reference); None outside its range."""
    if pf.get("kind") == "tabulated":
        a, dm = np.array(pf["alphaDeg"], float), np.array(pf["deltaMag"], float)
        if not a[0] <= alpha <= a[-1]:
            return None
        return float(10 ** (-0.4 * np.interp(alpha, a, dm)))
    if pf.get("kind") == "poly-mag":
        if not pf["minDeg"] <= alpha <= pf["maxDeg"]:
            return None
        return float(10 ** (-0.4 * sum(c * alpha ** k for k, c in enumerate(pf["coeffs"]))))
    return None


def app_preview(t: g.Target, entry: dict, view: g.Camera) -> dict | None:
    """Informational: the app's disk-integrated photometry (photometry.json: geometricAlbedoXYZS × Φ(α)) as a mean
    radiance over a disk-integrated ROI. Independent of the renderer; shows whether the app's data agree with the
    observation before any rendering."""
    path = OUT / "photometry.json"
    if not path.exists():
        return None
    from . import reproducibility as repro
    ph = repro.read_product(path, [[str(t.naif), field, part]
                                   for field in ("geometricAlbedoXYZS", "phaseFunction")
                                   for part in ("value", "label")]).get(str(t.naif))
    if not ph or not (ph.get("geometricAlbedoXYZS") or {}).get("value") or not (ph.get("phaseFunction") or {}).get(
            "value"):
        return {"note": "no disk-integrated albedo or phase function in photometry.json"}
    alpha = t.phase_deg()
    phi = _phase_factor(ph["phaseFunction"]["value"], alpha)
    if phi is None:
        return {"note": f"phase angle {alpha:.2f}° is outside the app's phase function range: the app has no "
                        "measured disk brightness here (the renderer hatches or extrapolates, by reality level)"}
    a_xyzs = np.array(ph["geometricAlbedoXYZS"]["value"], float)       # lux at 1 AU (p × E☉)
    r_ref = albedo.mean_radius(t.naif)
    omega = entry["pixels"] * view.pitch ** 2
    pred = a_xyzs * phi / t.sun_distance_au ** 2 * (r_ref / t.range_km) ** 2 / omega
    out = {"XYZS": pred.tolist(), "phaseDeg": alpha, "phi": phi,
           "labels": {"geometricAlbedoXYZS": ph["geometricAlbedoXYZS"]["label"],
                      "phaseFunction": ph["phaseFunction"]["label"]},
           "note": "informational, not a renderer test: photometry.json geometricAlbedoXYZS × Φ(α) / d² × "
                   "(R/Δ)² / Ω_rect with R the pck00011 mean radius (the albedo's reference)"}
    ex = entry.get("expected", {})
    if ex.get("type") == "value":
        out["ratioToExpected"] = (pred / np.array(ex["XYZS"])).tolist()
        out["deviationInSigma"] = ((pred - np.array(ex["XYZS"])) / np.array(ex["sigma"])).tolist()
    return out


def _ratios(p: Prepared, roi_json: list[dict]) -> list[dict]:
    """ROI-to-ROI ratios from the same frames: the absolute calibration cancels."""
    by_id = {e["id"]: e for e in roi_json}
    out = []
    pairs = list(p.ratios)
    for target in dict.fromkeys(e["target"] for e in roi_json):
        kinds = {e["kind"]: e["id"] for e in roi_json if e["target"] == target}
        centre, disk = kinds.get("disk-centre"), kinds.get("disk-integrated")
        pairs.extend((kinds[k], centre) for k in ("limb", "terminator") if k in kinds and centre)
        pairs.extend((kinds[k], disk) for k in ("disk-centre", "limb", "terminator") if k in kinds and disk)
    for num, den in dict.fromkeys(pairs):
        a, b = by_id.get(num), by_id.get(den)
        if not a or not b or a["expected"]["type"] != "value" or b["expected"]["type"] != "value":
            continue
        va, vb = np.array(a["expected"]["XYZS"]), np.array(b["expected"]["XYZS"])

        spatial = a["target"] == b["target"]

        def noncal(e):
            bu = e["expected"]["budget"]
            independent = np.array(bu["noiseAndRegistration"])
            return independent if spatial else np.hypot(independent, np.array(bu["spectralModel"]))
        r = va / vb
        sr = np.abs(r) * np.hypot(noncal(a) / va, noncal(b) / vb)
        noise_registration = sr.copy()
        spectral = np.zeros(4)
        if spatial and len(a["bands"]) > 1:
            shape = p.shape if a["target"] == p.targets[0].naif else p.shapes.get(a["target"], vp.FLAT)
            centers = sorted(vp.effective_wavelength(band["filter"], shape.wl, shape.p) for band in a["bands"])
            spectral = vp.ratio_spectral_spread(a["expected"]["rho"], b["expected"]["rho"], centers, shape)
            sr = np.hypot(noise_registration, spectral)
        band = []
        for ba, bb in zip(a["bands"], b["bands"]):
            ra = ba["iof"]["mean"] / bb["iof"]["mean"]
            s_rel = np.hypot(np.hypot(ba["sigmaRel"]["noise"], ba["sigmaRel"]["registration"]),
                             np.hypot(bb["sigmaRel"]["noise"], bb["sigmaRel"]["registration"]))
            band.append({"filter": ba["filter"], "ratio": ra, "sigma": abs(ra) * s_rel})
        out.append({"numerator": num, "denominator": den, "ratioXYZS": r.tolist(), "sigma": sr.tolist(),
                    "tolerance": (TOLERANCE_K * sr).tolist(), "bands": band,
                    "comparison": "|renderer mean(numerator rect) / mean(denominator rect) − ratioXYZS| ≤ tolerance, "
                                  "per channel",
                    "method": "same frames and filters: the absolute calibration cancels; σ from noise, "
                              "registration and the spectral model of both ROIs"})
        if spatial:
            out[-1].update({
                "label": "estimated" if "estimated" in (a["expected"]["label"], b["expected"]["label"]) else "derived",
                "budget": {"noiseAndRegistration": noise_registration.tolist(),
                           "spectralModel": spectral.tolist(),
                           "formula": "sigma(R_c) = |R_c| * hypot(u_a,c / L_a,c, u_b,c / L_b,c); "
                                      "u = each ROI's noiseAndRegistration; total sigma = hypot(sigma(R_c), "
                                      "abs(R_PCHIP - R_linear)); tolerance = 2 total sigma",
                           "correlation": "Shared absolute calibration and a common multiplicative spectral factor "
                                          "cancel (exactly for one band). For multiple bands, apply linear and "
                                          "PCHIP to both ROIs before dividing; their ratio difference is retained "
                                          "as the non-cancelling spectral term. Noise and registration "
                                          "are propagated independently, as in the region budgets; no cross-ROI "
                                          "covariance is measured. Additive background level uncertainty remains "
                                          "in disk noise and does not cancel."},
                "method": "same body, frames and filters: shared calibration and multiplicative spectral factors cancel; "
                          "per-band sigma from noise and registration alone, including disk background uncertainty. "
                          "XYZS retains differential linear/PCHIP ratio spread where local band colours differ"})
        dependence = a.get("sceneDependence") or b.get("sceneDependence")
        if dependence:
            out[-1]["sceneDependence"] = dependence
        if (num, den) == ("moon-disk-integrated", "earth-disk-integrated"):
            out[-1]["sceneDependence"] = {
                "reason": "The ratio depends on Earth's clouds and surface visibility at 2008-05-29; "
                          "the app holds clouds from another epoch. The existing budget has no Earth scene "
                          "variation term: the held calibration document gives no rotational-variation value.",
                "sources": ["EPOXI observation: HV08052902_1000116_001 (2008-05-29)",
                            "Livengood et al. (2011), Astrobiology 11, 907-930, doi:10.1089/ast.2011.0614 "
                            "(cited by the archive; paper needed for an Earth variation budget)",
                            "epoxi-cal-pipeline-summary-2014, section 3, pp. 13-14"]}
    return out


def write_case(case_id: str, built: dict) -> Path:
    d = VALIDATION / "cases" / case_id
    d.mkdir(parents=True, exist_ok=True)
    arr = np.stack(built["refs"]).astype("<f4")
    (d / "reference.bin").write_bytes(arr.tobytes())
    js = dict(built["json"])
    lock = _clean(js.pop("reproducibility", None), digits=None)
    view = _clean(js.pop("view"), digits=None)             # geometry at full double precision
    js = _clean(js)
    out = {}
    for k, v in js.items():                                # keep the key order, view after observation
        out[k] = v
        if k == "observation":
            out["view"] = view
    if lock is not None:
        out["reproducibility"] = lock
    (d / "case.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8",
                                 newline="\n")
    preview(d / "preview.png", built["refs"], built["json"]["reference"]["bands"], built["rois"])
    return d


def _clean(o, digits: int | None = 7):
    """JSON-safe copy: NaN/inf -> null, floats rounded to `digits` significant digits (None: full precision)."""
    if isinstance(o, float):
        if not np.isfinite(o):
            return None
        return o if digits is None else float(f"{o:.{digits}g}")
    if isinstance(o, dict):
        return {k: _clean(v, digits) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v, digits) for v in o]
    if isinstance(o, np.generic):
        return _clean(o.item(), digits)
    return o


def preview(path: Path, refs: list[np.ndarray], bands: list[str], rois: list[roi.Roi], scale: int = 2) -> None:
    from PIL import Image, ImageDraw
    order = sorted(range(len(bands)), key=lambda i: filters.effective_wavelength(bands[i]))
    if len(refs) >= 3:
        rgb = np.stack([refs[order[-1]], refs[order[len(order) // 2]], refs[order[0]]], axis=-1)
    else:
        rgb = np.stack([refs[0]] * 3, axis=-1)
    top = np.nanpercentile(rgb, 99.7)
    v = np.clip(np.nan_to_num(rgb) / max(top, 1e-12), 0, 1) ** (1 / 2.2)
    img = Image.fromarray((v * 255).astype(np.uint8)).resize((v.shape[1] * scale, v.shape[0] * scale),
                                                             Image.NEAREST)
    dr = ImageDraw.Draw(img)
    for r in rois:
        x0, y0, x1, y1 = [c * scale for c in r.rect]
        col = (255, 60, 60) if r.spec.kind.startswith("sky") else (80, 200, 255) if r.spec.kind == "disk-integrated" \
            else (255, 230, 0)
        dr.rectangle([x0, y0, x1 - 1, y1 - 1], outline=col)
        dr.text((x1 + 2, y0), r.spec.id, fill=col)
    img.save(path)


def build_case(case, *, expected: dict | None = None, renew: bool = False) -> dict:
    from . import reproducibility as repro
    repro.require_single_thread()
    repro.clear_process_caches()
    generated = repro.generation_time(expected)
    if expected is not None:
        repro.preflight(expected, renew=renew)
    lock = (expected or {}).get("reproducibility")
    pinned = lock["inputs"] if lock else None
    with repro.capture_tables() as tables, repro.isolated_spectral_cache(), repro.expected_case(expected), repro.capture_inputs(pinned, renew=renew) as inputs:
        # SPICE opens kernels in C, outside Python's file-open audit hook.
        # Hash the exact declared kernel paths before their bytes are consumed.
        for path in (ek.lsk(), ek.pck(), ek.planetary()):
            repro.file_record(path)
        p = prepare_frame_case(case) if isinstance(case, FrameCase) else case.prepare()
        built = measure(p)
        # Sources may already be in a process-local spectral cache. Explicitly
        # read their pinned copies too so every case lock is self-contained.
        ledger = download._load_ledger()
        for src in built["json"]["sources"]:
            path = repro.source_path(src, ledger)
            if path and path.is_file():
                actual = repro.file_record(path)
                if src.get("sha256") and src["sha256"] != actual["sha256"]:
                    raise repro.ReproductionError(f'{src["id"]}: actual input sha256 differs from source ledger')
        if expected is not None:
            repro.check_sources(expected, built["json"])
    built["json"]["generated"] = generated
    built["json"]["reproducibility"] = {
        "schema": "validation-rebuild-v2", "artifactCreated": generated, "criterion": "exact scientific JSON and float32 reference bytes",
        "inputs": inputs, "implementation": repro.implementation({"id": case.id}, tables=tables), "runtime": repro.runtime(),
        "fits": [{"product": m["product"], "inputs": m.get("fitInputs"), "freeResult": m.get("freeFitResult"), "result": m.get("fitResult")}
                 for m in p.img_meta],
        "optimizer": "deterministic 3-degree exhaustive roll/FFT translation seed, explicit Nelder-Mead simplex; "
                     "no random seed or random draws; see hashed register.py for stopping criteria",
        "uncertaintyCriterion": "no relaxed byte criterion: centreSigmaPx is centre-only, registrationSigmaPx "
                                "includes the stated systematic floor, and no roll covariance is available"}
    return built


def write_index() -> Path:
    """validation/index.json: the cases present on disk."""
    rows = []
    for p in sorted((VALIDATION / "cases").glob("*/case.json")):
        c = json.loads(p.read_text(encoding="utf-8"))
        rows.append({"id": c["id"], "title": c["title"], "epochUtc": c["view"]["epochUtc"],
                     "target": c["observation"]["target"], "instrument": c["observation"]["instrument"],
                     "rois": [r["id"] for r in c["rois"]], "path": f"cases/{c['id']}/case.json"})
    out = {"schema": "validation-index-v1", "cases": rows,
           "doc": "docs/reports/validation.md (what the renderer must output and how cases are compared)"}
    path = VALIDATION / "index.json"
    path.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    return path
