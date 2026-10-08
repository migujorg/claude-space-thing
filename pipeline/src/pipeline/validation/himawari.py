"""Earth from Himawari-9 AHI on the day of the app's cloud snapshot (2026-09-28), inside the app's time window.

The app's Earth clouds (surfaces/399/clouds) are the SatCORPS mosaic of 2026-09-28, each longitude near
13:30 local solar time. The AHI full-disk scan of 04:00 UTC sees the sub-satellite point (140.7°E) at 13:23
local solar time. This proximity does not guarantee identical clouds: actual strip times and retrievals differ,
and the existing comparison budget has no cloud-variation term. Only the equatorial swath (segment 6 of 10: the sub-satellite point to ~16°S,
limb to limb) is fetched, for bands 1-3 (0.47, 0.51, 0.64 µm; 62 MB).

Geometry: the AHI fixed grid (CGMS normalised geostationary projection; block 3 of the header: CFAC/LFAC/COFF/LOFF,
sub-satellite longitude, distance) is defined for the nominal satellite position, which is the viewpoint used here.
Earth-fixed (ITRF93) → ICRF from NAIF's high-precision Earth PCK; the Sun from de442s. The view is a pinhole camera
at the satellite looking at the swath's centre with Earth's north up; the AHI radiances are area-averaged onto its
pixels through the exact scan-angle mapping (no pointing fit is needed: navigation is accurate to 1 km, Okuyama et
al. 2018).
"""

from __future__ import annotations

import datetime as _dt
import math
import re

import numpy as np
import spiceypy as sp
from scipy import ndimage

from .. import download
from .. import ephem_kernels as ek
from ..photometry import earth as pe
from ..photometry import earth_data as ed
from ..photometry import filters, solar
from ..photometry.common import Download
from ..schema import BuildContext, SourceRecord
from . import geometry as g
from .build import Prepared, shape_for
from .roi import RoiSpec

BUCKET = "https://noaa-himawari9.s3.amazonaws.com/"
TIME = ("2026", "09", "28", "0400")
BANDS = {1: "R10", 2: "R10", 3: "R05"}
SEGMENT = 6
VIEW_BIN = 8                  # 1 km grid pixels per view pixel (~8 km at the sub-satellite point)
NAV_SIGMA_KM = 1.0            # Okuyama et al. (2018): image navigation accurate to within 1 km
VIIRS_LOCAL_H = 13.5          # NOAA-20 ascending-node local solar time (the app's cloud layer)

OKUYAMA_2018 = Download(
    id="okuyama-2018-ahi-calibration", url="https://www.jstage.jst.go.jp/article/jmsj/96B/0/96B_2018-033/_pdf",
    subdir="validation/docs", name="okuyama2018_jmsj.pdf", browser_agent=True,
    title="Validation of Himawari-8/AHI Radiometric Calibration Based on Two Years of In-Orbit Data",
    citation="Okuyama, A., Takahashi, M., Date, K., Hosaka, K., Murata, H., Tabata, T. and Yoshino, R. (2018). "
             "Validation of Himawari-8/AHI radiometric calibration based on two years of in-orbit data. Journal of "
             "the Meteorological Society of Japan 96B, 91-109. DOI:10.2151/jmsj.2018-033.",
    notes="Navigation 'accurate to within 1 km'. VNIR vicarious calibration against radiative-transfer simulations "
          "(Table 7): monthly slopes 0.99-1.02 (B01), 1.00-1.03 (B02), 0.97-0.99 (B03); maximum method "
          "uncertainties 4.0, 3.8, 3.6 % for bands 1-3 (§5.2.a). Himawari-9 carries an AHI of the same design.")
CAL_SIGMA = 0.05
CAL_NOTE = ("Okuyama et al. (2018), for the AHI of the same design on Himawari-8: vicarious-calibration slopes against "
            "radiative-transfer simulations deviate from 1 by up to 3 % in bands 1-3 (Table 7), and the method's own "
            "uncertainty is 3.6-4.0 % (§5.2.a); combined in quadrature, 5 % (1σ) per band, fully correlated.")


def sat_rotation(sub_lon_deg: float) -> np.ndarray:
    """Earth-fixed → satellite frame (x from the Earth's centre towards the satellite, z north), as in
    photometry/earth.sun_direction."""
    lon = math.radians(sub_lon_deg)
    return np.array([[math.cos(lon), math.sin(lon), 0.0], [-math.sin(lon), math.cos(lon), 0.0], [0.0, 0.0, 1.0]])


def grid_to_dir(seg, col, lin) -> np.ndarray:
    """Unit view directions (satellite frame) of 1-based grid positions: the CGMS scan angles x, y of
    photometry/earth.geometry, direction (−cos x cos y, sin x cos y, −sin y)."""
    x = np.radians((np.asarray(col, float) - seg.coff) * 2.0 ** 16 / seg.cfac)
    y = np.radians((np.asarray(lin, float) - seg.loff) * 2.0 ** 16 / seg.lfac)
    return np.stack([-np.cos(x) * np.cos(y), np.sin(x) * np.cos(y), -np.sin(y)], axis=-1)


def dir_to_grid(seg, v: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Inverse of grid_to_dir: 1-based (column, line) of view directions v (satellite frame, any length)."""
    v = v / np.linalg.norm(v, axis=-1, keepdims=True)
    x = np.degrees(np.arctan2(v[..., 1], -v[..., 0]))
    y = -np.degrees(np.arcsin(np.clip(v[..., 2], -1, 1)))
    return seg.coff + x * seg.cfac / 2.0 ** 16, seg.loff + y * seg.lfac / 2.0 ** 16


def _key(band: int) -> str:
    y, m, d, hm = TIME
    return (f"AHI-L1b-FLDK/{y}/{m}/{d}/{hm}/HS_H09_{y}{m}{d}_{hm}_B{band:02d}_FLDK_{BANDS[band]}_"
            f"S{SEGMENT:02d}10.DAT.bz2")


def _mjd_to_utc(mjd: float) -> str:
    t = _dt.datetime(1858, 11, 17) + _dt.timedelta(days=mjd)
    return t.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]


def _earth_pck(ctx: BuildContext):
    """Newest Pinned NAIF high-precision Earth PCK (ITRF93), fetched once, registered as a source."""
    import os
    from .reproducibility import EXPECTED_CASE, ReproductionError, check_file
    expected = EXPECTED_CASE.get() or {}
    source = next((s for s in expected.get("sources", []) if s["id"] == "naif-earth-pck-high-prec"), None)
    name = os.environ.get("PIPELINE_VALIDATION_EARTH_PCK") or (source["version"] if source else None)
    if not name or not re.fullmatch(r"earth_000101_\d{6}_\d{6}\.bpc", name):
        raise ReproductionError("Himawari needs an explicit Earth PCK: pass --earth-pck earth_000101_...bpc "
                                "for a new candidate; a committed rebuild uses its recorded source version")
    naif = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/"
    path = download.fetch(naif + name, "naif/pck")
    if source:
        check_file(path, {"sha256": source["sha256"]})
    rec = download.record(path)
    ctx.add_source(SourceRecord(
        id="naif-earth-pck-high-prec", title="NAIF high-precision Earth orientation PCK (ITRF93)",
        citation=f"NAIF/JPL binary PCK {name} (ITRF93; IAU 1976 precession, IAU 1980 nutation, JPL Earth "
                 "orientation parameters, https://eop.jpl.nasa.gov/). Acton, C. H. (1996), PSS 44, 65-70.",
        url=rec["url"], retrieved=rec["retrieved"], sha256=rec["sha256"], version=name))
    return path


class HimawariCase:
    id = "earth-himawari9-2026"
    title = "Earth, Himawari-9 AHI, 2026-09-28 04:00 UTC (the app's cloud day), equatorial swath"
    summary = ("The swath from the sub-satellite point (0°, 140.7°E; 13:23 local solar time) to ~16°S across the "
               "whole disk, from the Indian Ocean at the western limb to the evening terminator in the central "
               "Pacific, in AHI bands 1-3 (0.47, 0.51, 0.64 µm), from geostationary orbit (35 786 km).")
    rois = [RoiSpec("disk-centre", "disk-centre", 5), RoiSpec("limb", "limb", 4, min_emission=70.0),
            RoiSpec("terminator", "terminator", 4),
            RoiSpec("near-centre-130E", "point", 4, lat_lon=(-6.0, 130.0),
                    note="within ±1 h of the SatCORPS mosaic target local hour; the retrieval and actual strip time differ"),
            RoiSpec("near-centre-150E", "point", 4, lat_lon=(-6.0, 150.0),
                    note="within ±1 h of the SatCORPS mosaic target local hour; the retrieval and actual strip time differ"),
            RoiSpec("near-centre-141E-12S", "point", 4, lat_lon=(-12.0, 141.0),
                    note="within ±1 h of the SatCORPS mosaic target local hour; the retrieval and actual strip time differ"),
            RoiSpec("sky-near", "sky-near", 4, clear=4),
            RoiSpec("sky-far", "sky-far", 4, clear=4)]

    def prepare(self) -> Prepared:
        ctx = BuildContext(0.0, 0.0)
        ek.lsk(ctx), ek.pck(ctx), ek.planetary(ctx)
        OKUYAMA_2018.register(ctx)
        ed.AHI_SRF.register(ctx)
        keys = [f"ahi9.B{b:02d}" for b in BANDS]
        filters.register(ctx, tuple(keys))
        solar.register_sources(ctx)
        bpc = _earth_pck(ctx)
        shape = shape_for(399, ctx)

        segs, paths = {}, {}
        for b in BANDS:
            key = _key(b)
            paths[b] = download.fetch(BUCKET + key, f"validation/{self.id}", key.split("/")[-1], timeout=300.0)
            rec = download.record(paths[b])
            ctx.add_source(SourceRecord(
                id=f"himawari9-{key.split('/')[-1].lower().replace('.dat.bz2', '')}",
                title=f"Himawari-9 AHI L1b full disk {TIME[0]}-{TIME[1]}-{TIME[2]} {TIME[3]} UTC, band {b}, "
                      f"segment {SEGMENT}/10", citation=ed.HIMAWARI_CITATION, url=rec["url"],
                retrieved=rec["retrieved"], sha256=rec["sha256"]))
            segs[b] = pe.read_segment(paths[b])
        ref = segs[1]
        t_mid = 0.5 * (ref.t_start_mjd + ref.t_end_mjd)
        utc = _mjd_to_utc(t_mid)
        et = g.utc_to_et(utc)
        with g.kernels():
            sp.furnsh(str(bpc))
            try:
                R = np.array(sp.pxform("ITRF93", "J2000", et))
                sun, _ = sp.spkpos("SUN", et, "J2000", "LT", "399")
                radii = np.array(sp.bodvrd("399", "RADII", 3)[1], float)
            finally:
                sp.unload(str(bpc))
        d_au = float(np.linalg.norm(sun) / g.AU_KM)
        lon = math.radians(ref.sub_lon)
        sat_ef = ref.h_km * np.array([math.cos(lon), math.sin(lon), 0.0])
        earth = g.Target(399, "Earth", R @ (-sat_ef), R, np.array(sun, float), radii)

        # I/F on the 1 km grid of the segment
        iof = {}
        for b, seg in segs.items():
            L = pe.radiance(seg)
            if seg.cols == 2 * ref.cols:
                with np.errstate(invalid="ignore"):
                    L = np.nanmean(L.reshape(seg.lines // 2, 2, seg.cols // 2, 2), axis=(1, 3))
            iof[b] = (math.pi * d_au ** 2 / pe.ahi_band_irradiance(b)) * L.astype(np.float64)

        # view: pinhole at the satellite, north up, centred on the swath
        step = math.radians(2.0 ** 16 / ref.cfac)                  # rad per 1 km-grid column
        lines = np.arange(ref.first_line, ref.first_line + ref.lines)
        y_mid = math.radians((lines.mean() - ref.loff) * 2.0 ** 16 / ref.lfac)
        pitch = step * VIEW_BIN
        W = int(math.ceil(ref.cols / VIEW_BIN))
        H = int(math.ceil(ref.lines / VIEW_BIN))
        cy = 0.5 * H - math.tan(y_mid) / pitch                      # Earth centre above the swath centre
        view = g.camera_for(earth, W, H, pitch, 0.5 * W, cy, 0.0)
        # area-average the AHI grid onto the view through the exact scan-angle mapping
        sub = VIEW_BIN // 2               # 4 × 4 bilinear samples per 8 × 8 km view pixel
        rays = view.grid_rays(sub).reshape(-1, 3)
        v = rays @ R @ sat_rotation(ref.sub_lon).T                 # ICRF -> ITRF93 -> satellite frame
        col, lin = dir_to_grid(ref, v)
        refs = []
        for b in BANDS:
            s = ndimage.map_coordinates(iof[b], [lin - ref.first_line, col - 1.0], order=1, mode="constant",
                                        cval=np.nan)
            refs.append(s.reshape(H * sub, W * sub).reshape(H, sub, W, sub).mean(axis=(1, 3)))
        nav_px = NAV_SIGMA_KM / (ref.h_km - radii[0]) / pitch
        meta = []
        for b in BANDS:
            seg = segs[b]
            meta.append({"product": paths[b].name, "band": f"ahi9.B{b:02d}", "utcMid": _mjd_to_utc(
                0.5 * (seg.t_start_mjd + seg.t_end_mjd)), "et": et, "exposureS": None,
                "archiveUrl": BUCKET + _key(b), "calibration": "I/F = π L d² / E_band; L = counts × slope + "
                "intercept (header block 5); E_band = TSIS-1 HSRS averaged over the AHI-09 response",
                "horizonsSources": [], "fit": None,
                "registrationSigmaPx": max(nav_px, 0.125),
                "navigation": {"subLonDeg": seg.sub_lon, "distanceKm": seg.h_km, "cfac": seg.cfac, "lfac": seg.lfac,
                               "coff": seg.coff, "loff": seg.loff, "firstLine": seg.first_line}})
        notes = [
            "Clouds: the app's Earth cloud layer is the SatCORPS mosaic of 2026-09-28 near 13:30 local solar time; each "
            "ROI's 'cloudTimeOffsetH' is Himawari's local solar time minus 13.5 h at the ROI's mean longitude. Only "
            "ROIs within ~±1 h are near the target local hour, not a guarantee of identical clouds; actual "
            "strip times and retrievals differ, and the existing budget has no cloud-variation term.",
            "Only segment 6 of 10 was fetched (the swath from the equator to ~16°S): pixels outside it are NaN.",
            "The Earth's shape spectrum p̃ is the app's (Himawari 2025-03-20 disk average, 'estimated'); it only "
            "shapes the spectrum between the three band centres.",
        ]
        return Prepared(
            id=self.id, title=self.title, summary=self.summary, instrument="Himawari-9 AHI",
            observer_name="Himawari-9", observer_id="(nominal geostationary position from the image header)",
            targets=[earth], view=view, refs=refs, bands=keys, img_meta=meta, ctx=ctx,
            calibration_sigma=[CAL_SIGMA] * 3, calibration_note=CAL_NOTE, calibration_sources=[OKUYAMA_2018.id],
            roi_specs=self.rois, shape=shape,
            pixel={"nativePitchRad": step, "binning": VIEW_BIN, "note": "AHI 1 km fixed grid (band 3's 0.5 km "
                   "pixels averaged 2×2), resampled onto the pinhole view by the exact scan-angle mapping",
                   "mirroredDisplayOrder": False},
            notes=notes, reference_image=0, epoch_utc=utc, et=et,
            annotate=lambda e, h=(t_mid % 1.0) * 24.0: {"cloudTimeOffsetH": round(
                (h + ((e["geometry"]["eastLongitudeDeg"]["mean"] + 180) % 360 - 180) / 15.0) % 24 - VIIRS_LOCAL_H, 2)}
            if "eastLongitudeDeg" in e["geometry"] else {})


HIMAWARI = HimawariCase()
