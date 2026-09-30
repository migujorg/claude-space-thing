"""The Earth's disk-integrated reflectance from measurements (photometry.json → 399).

Two independent measured data sets (earth_data.py):

  Himawari-9 AHI, 2025-03-20 02:30 UTC, bands 1-4 (0.47, 0.51, 0.64, 0.86 µm), full disk from geostationary orbit at
  the satellite's local noon one day before the equinox: the Sun is ~1° from the satellite as seen from the Earth's
  centre, so this is the whole sunlit hemisphere at almost zero phase. Per pixel: calibrated radiance L (Himawari
  Standard Data calibration), I/F = π L d²/E_b with E_b the TSIS-1 HSRS irradiance averaged over the band's spectral
  response. Disk-integrated reflectance as seen from far away in the same direction:

      A_b = Σ_pixels (I/F)_b · dA · μ∞ / (π R²),  dA = Ω_pix · s² / μ_sat

  with Ω_pix = cos y · Δx · Δy the pixel solid angle (CGMS normalized geostationary projection, scan angles x, y),
  s the satellite-surface distance, μ_sat and μ∞ the cosines between the ellipsoid normal and the directions to the
  satellite and to infinity (the Earth-centre → satellite direction), R the volumetric mean radius (pck00011).
  From 6.6 Earth radii the satellite sees the Earth up to 81.3° from the sub-satellite point: the rest of the disk
  (2.3 % of the projected area) is filled with the mean I/F of the outer ring. A = p·Φ(α) at α ≈ 1°.

  Deep Impact/EPOXI HRIV, 24-hour sequences of the whole Earth in 7 filters (350-950 nm) at phase angles 57.5°,
  76.6° and 85.9° (2008-03, 2008-06, 2009-03): aperture photometry on the calibrated images (I/F per the archive's
  own conversion), A = Σ (I/F) Ω_pix / (π (R/Δ)²), averaged over the day (rotation). Used as a check of the phase
  function and of the colour at large phase.
"""

from __future__ import annotations

import bz2
import hashlib
import io
import json
import math
import struct
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from .. import download
from ..paths import CACHE
from . import earth_data as ed, solar

R_MEAN_KM = 6371.0004       # pck00011 BODY399_RADII volumetric mean (albedo.mean_radius(399); checked in tests)


# ---------------------------------------------------------------------------------------------- AHI SRFs
_XNS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


@lru_cache(maxsize=None)
def ahi_passband(band: int) -> tuple[np.ndarray, np.ndarray]:
    """(wavelength nm, relative responsivity) of AHI-09 band `band` from JMA's workbook (sheet 'Band <n>')."""
    outer = zipfile.ZipFile(ed.AHI_SRF.fetch())
    z = zipfile.ZipFile(io.BytesIO(outer.read(outer.namelist()[0])))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    names = [s.get("name") for s in wb.find("m:sheets", _XNS)]
    # sheet order in the workbook = sheetN numbering (checked: 'Title', 'Band 1', ... 'Band 16')
    k = names.index(f"Band {band}") + 1
    root = ET.fromstring(z.read(f"xl/worksheets/sheet{k}.xml"))
    wl, resp = [], []
    for row in root.find("m:sheetData", _XNS):
        vals = {}
        for c in row:
            v = c.find("m:v", _XNS)
            if v is not None and c.get("t") != "s":
                vals[c.get("r").rstrip("0123456789")] = float(v.text)
        if "A" in vals and "C" in vals:
            wl.append(vals["A"] * 1000.0)
            resp.append(vals["C"])
    wl, resp = np.array(wl), np.array(resp)
    o = np.argsort(wl)
    return wl[o], resp[o]


def ahi_band_irradiance(band: int) -> float:
    """TSIS-1 HSRS irradiance at 1 AU averaged over the band response (W m⁻² µm⁻¹)."""
    wl, r = ahi_passband(band)
    s = solar.spectrum()
    m = (s.wl_air >= wl.min()) & (s.wl_air <= wl.max())
    w = np.interp(s.wl_air[m], wl, r, left=0.0, right=0.0)
    return float(np.sum(s.ssi_air[m] * w) / np.sum(w)) * 1000.0


# ---------------------------------------------------------------------------------------------- HSD reader
@dataclass
class Segment:
    band: int
    cols: int
    lines: int
    first_line: int
    sub_lon: float
    cfac: float
    lfac: float
    coff: float
    loff: float
    h_km: float
    req: float
    rpol: float
    slope: float
    intercept: float
    c_prime: float
    err_count: int
    out_count: int
    wl_um: float
    t_start_mjd: float
    t_end_mjd: float
    counts: np.ndarray


def read_segment(path) -> Segment:
    """Himawari Standard Data (format 1.3): 11 header blocks, then uint16 counts (little endian here)."""
    raw = bz2.decompress(path.read_bytes())
    blocks, off = {}, 0
    for _ in range(11):
        num, length = struct.unpack_from("<BH", raw, off)
        blocks[num] = raw[off:off + length]
        off += length
    b1, b2, b3, b5, b7 = blocks[1], blocks[2], blocks[3], blocks[5], blocks[7]
    if b1[5] != 0:
        raise ValueError(f"{path.name}: big-endian HSD not supported")
    cols, lines = struct.unpack_from("<HH", b2, 5)
    counts = np.frombuffer(raw, dtype="<u2", count=cols * lines, offset=off).reshape(lines, cols)
    return Segment(
        band=struct.unpack_from("<H", b5, 3)[0], cols=cols, lines=lines,
        first_line=struct.unpack_from("<H", b7, 5)[0],
        sub_lon=struct.unpack_from("<d", b3, 3)[0], cfac=float(struct.unpack_from("<I", b3, 11)[0]),
        lfac=float(struct.unpack_from("<I", b3, 15)[0]), coff=struct.unpack_from("<f", b3, 19)[0],
        loff=struct.unpack_from("<f", b3, 23)[0], h_km=struct.unpack_from("<d", b3, 27)[0],
        req=struct.unpack_from("<d", b3, 35)[0], rpol=struct.unpack_from("<d", b3, 43)[0],
        slope=struct.unpack_from("<d", b5, 51)[0], intercept=struct.unpack_from("<d", b5, 59)[0],
        c_prime=struct.unpack_from("<d", b5, 35)[0], err_count=struct.unpack_from("<H", b5, 15)[0],
        out_count=struct.unpack_from("<H", b5, 17)[0], wl_um=struct.unpack_from("<d", b5, 5)[0],
        t_start_mjd=struct.unpack_from("<d", b1, 46)[0], t_end_mjd=struct.unpack_from("<d", b1, 54)[0],
        counts=counts)


def radiance(seg: Segment) -> np.ndarray:
    c = seg.counts
    L = c.astype(np.float32) * np.float32(seg.slope) + np.float32(seg.intercept)
    L[(c == seg.err_count) | (c == seg.out_count)] = np.nan
    return L


def geometry(seg: Segment, sun_dir: np.ndarray, line0: int, nlines: int) -> dict[str, np.ndarray]:
    """Per 1 km pixel of lines [line0, line0 + nlines) (1-based, full-disk numbering): the weight
    dA·μ∞/(πR²) (NaN off the Earth), the view zenith angle from the satellite, the solar incidence cosine and the
    per-pixel phase angle. Satellite frame: x toward the sub-satellite point, z north (CGMS formulas)."""
    col = np.arange(1, seg.cols + 1, dtype=np.float64)
    lin = np.arange(line0, line0 + nlines, dtype=np.float64)
    step = math.radians(2.0 ** 16 / seg.cfac)
    x = np.radians((col - seg.coff) * 2.0 ** 16 / seg.cfac)[None, :]
    y = np.radians((lin - seg.loff) * 2.0 ** 16 / seg.lfac)[:, None]
    h, a2, c2 = seg.h_km, seg.req ** 2, seg.rpol ** 2
    cx, cy, sx, sy = np.cos(x), np.cos(y), np.sin(x), np.sin(y)
    k = cy * cy + (a2 / c2) * sy * sy
    disc = (h * cx * cy) ** 2 - k * (h * h - a2)
    on = disc > 0
    sd = np.sqrt(np.where(on, disc, 0.0))
    sn = (h * cx * cy - sd) / k
    p = np.stack([h - sn * cx * cy, sn * sx * cy, -sn * np.broadcast_to(sy, sn.shape)], axis=-1)
    n = p / np.array([a2, a2, c2])
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    to_sat = np.array([h, 0.0, 0.0]) - p
    to_sat /= np.linalg.norm(to_sat, axis=-1, keepdims=True)
    mu_sat = np.einsum("...i,...i->...", n, to_sat)
    mu_inf = n[..., 0]
    omega = np.broadcast_to(cy, sn.shape) * step * step
    w = omega * sn * sn * mu_inf / mu_sat / (math.pi * R_MEAN_KM ** 2)
    w = np.where(on & (mu_sat > 0), w, np.nan)
    mu0 = n @ sun_dir
    phase = np.degrees(np.arccos(np.clip(to_sat @ sun_dir, -1, 1)))
    return {"w": w.astype(np.float64), "vza": np.degrees(np.arccos(np.clip(mu_sat, -1, 1))).astype(np.float32),
            "mu0": mu0.astype(np.float32), "phase": phase.astype(np.float32)}


def sun_direction(mjd_utc: float, sub_lon_deg: float) -> tuple[np.ndarray, float]:
    """Unit vector to the Sun in the satellite frame (x toward the sub-satellite point, z north) and the Earth-Sun
    distance in AU, from astropy's solar ephemeris (geocentric, ITRS)."""
    from astropy.coordinates import ITRS, get_sun
    from astropy.time import Time
    t = Time(mjd_utc, format="mjd", scale="utc")
    s = get_sun(t).transform_to(ITRS(obstime=t))
    v = s.cartesian.xyz.to_value("km")
    d_au = float(np.linalg.norm(v) / 149597870.7)
    lon = math.radians(sub_lon_deg)
    rot = np.array([[math.cos(lon), math.sin(lon), 0.0], [-math.sin(lon), math.cos(lon), 0.0], [0.0, 0.0, 1.0]])
    u = rot @ (v / np.linalg.norm(v))
    return u, d_au


# ---------------------------------------------------------------------------------------------- disk integral
OUTER_RING_VZA = (70.0, 80.0)      # view zenith range whose mean I/F fills the unseen limb annulus


def _cache_key(paths) -> str:
    h = hashlib.sha256()
    for p in paths:
        h.update((download.record(p)["sha256"] + "\n").encode())
    return h.hexdigest()[:16]


def read_header_times(path) -> tuple[float, float]:
    """Observation start and end (MJD UTC) from header block 1, without decompressing the image."""
    with bz2.BZ2File(path) as f:
        b1 = f.read(282)
    return struct.unpack_from("<d", b1, 46)[0], struct.unpack_from("<d", b1, 54)[0]


GEOMETRY_CHUNK = 220       # lines per geometry block (memory)


def himawari_disk() -> dict:
    """Disk-integrated reflectance per AHI band (cached in data/cache/earth/ by the inputs' digests)."""
    paths = ed.himawari_files()
    key = _cache_key(paths)
    cache = CACHE / "earth" / f"himawari-{key}.json"
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    nseg = ed.HIMAWARI_SEGMENTS
    by_band = {b: paths[(b - 1) * nseg:b * nseg] for b in ed.HIMAWARI_BANDS}
    t0 = read_header_times(by_band[1][0])[0]
    t1 = read_header_times(by_band[1][-1])[1]
    t_mid = 0.5 * (t0 + t1)
    first = read_segment(by_band[1][0])
    sun, d_au = sun_direction(t_mid, first.sub_lon)
    out = {"mjd_start": t0, "mjd_end": t1, "mjd_mid": t_mid, "sun_dir": sun.tolist(), "d_au": d_au,
           "sub_lon": first.sub_lon, "alpha_deg": math.degrees(math.acos(max(-1.0, min(1.0, float(sun[0]))))),
           "R_mean_km": R_MEAN_KM, "weight_all": 0.0, "phase_min": 180.0, "phase_max": 0.0, "bands": {}}
    acc = {b: {"sum": 0.0, "w": 0.0, "ring_sum": 0.0, "ring_w": 0.0, "missing_px": 0, "earth_px": 0,
               "E_band": ahi_band_irradiance(b)} for b in by_band}
    for s_idx in range(nseg):
        segs = {b: read_segment(by_band[b][s_idx]) for b in by_band}
        ref = segs[1]
        t_seg = 0.5 * (ref.t_start_mjd + ref.t_end_mjd)
        sun_s, _ = sun_direction(t_seg, ref.sub_lon)
        iofs = {}
        for b, seg in segs.items():
            acc[b]["c_prime"] = seg.c_prime
            L = radiance(seg)
            if seg.cols == 2 * ref.cols:            # 0.5 km band: average 2x2 onto the 1 km grid
                with np.errstate(invalid="ignore"):
                    L = np.nanmean(L.reshape(seg.lines // 2, 2, seg.cols // 2, 2), axis=(1, 3))
            iofs[b] = (math.pi * d_au ** 2 / acc[b]["E_band"]) * L
        del segs
        for r0 in range(0, ref.lines, GEOMETRY_CHUNK):
            nl = min(GEOMETRY_CHUNK, ref.lines - r0)
            g = geometry(ref, sun_s, ref.first_line + r0, nl)
            earth = np.isfinite(g["w"])
            if not earth.any():
                continue
            out["weight_all"] += float(np.sum(g["w"][earth]))
            ph = g["phase"][earth]
            out["phase_min"] = min(out["phase_min"], float(ph.min()))
            out["phase_max"] = max(out["phase_max"], float(ph.max()))
            ringsel = earth & (g["vza"] >= OUTER_RING_VZA[0]) & (g["vza"] < OUTER_RING_VZA[1])
            for b in by_band:
                iof = iofs[b][r0:r0 + nl]
                valid = earth & np.isfinite(iof)
                a = acc[b]
                a["earth_px"] += int(earth.sum())
                a["missing_px"] += int((earth & ~np.isfinite(iof)).sum())
                a["sum"] += float(np.sum(iof[valid] * g["w"][valid]))
                a["w"] += float(np.sum(g["w"][valid]))
                ring = ringsel & valid
                a["ring_sum"] += float(np.sum(iof[ring] * g["w"][ring]))
                a["ring_w"] += float(np.sum(g["w"][ring]))
    # the unseen limb annulus: projected area of the ellipsoid seen along x (π a c) minus what the pixels cover
    total = ref.req * ref.rpol / R_MEAN_KM ** 2
    out["projected_total"] = total
    for b, a in acc.items():
        ring = a["ring_sum"] / a["ring_w"]
        mean = a["sum"] / a["w"]
        w_invalid = out["weight_all"] - a["w"]            # on-Earth pixels without a valid radiance: disk mean
        w_annulus = total - out["weight_all"]             # not seen from the satellite: outer-ring mean
        a["A"] = a["sum"] + w_invalid * mean + w_annulus * ring
        a["annulus_weight"] = w_annulus
        a["annulus_fraction_of_A"] = w_annulus * ring / a["A"]
        a["ring_iof"] = ring
        out["bands"][str(b)] = a
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(out, indent=1), encoding="utf-8", newline="\n")
    return out


# ---------------------------------------------------------------------------------------------- EPOXI
EPOXI_APERTURE_MARGIN_PX = 25      # aperture radius = Earth radius + this (the HRIV is defocused, PSF ~10 px)
EPOXI_SKY_WIDTH_PX = 30            # background annulus just outside the aperture


def epoxi_photometry(path, img: "ed.EpoxiImage") -> dict:
    """Disk-integrated reflectance A = Σ(I/F)/(π R_px²) from one calibrated HRIV image (I/F per pixel = radiance ×
    the archive's MULT2IOF), with a background annulus; R_px = R/(Δ·IFOV), IFOV = pixel scale / range."""
    from astropy.io import fits
    with fits.open(path) as h:
        d = h[0].data.astype(np.float64)
        mult = float(h[0].header["MULT2IOF"])
    with np.errstate(over="ignore", invalid="ignore"):
        raw_iof = d * mult
    bad = ~np.isfinite(raw_iof) | (np.abs(raw_iof) > 3.0)      # fill values (±3e38 and other corrupt pixels)
    iof = np.where(bad, np.nan, raw_iof)
    ifov = img.pixel_scale_m / (img.range_km * 1000.0)
    r_px = R_MEAN_KM / (img.range_km * ifov)
    peak = np.nanpercentile(iof, 99.5)
    yy, xx = np.indices(iof.shape)
    m = np.nan_to_num(iof) > 0.1 * peak
    wgt = np.nan_to_num(iof) * m
    cy, cx = float(np.sum(yy * wgt) / wgt.sum()), float(np.sum(xx * wgt) / wgt.sum())
    rr = np.hypot(yy - cy, xx - cx)
    r_ap = r_px + EPOXI_APERTURE_MARGIN_PX
    sky = (rr >= r_ap) & (rr < r_ap + EPOXI_SKY_WIDTH_PX) & ~bad
    bg = float(np.nanmedian(iof[sky])) if sky.sum() > 100 else 0.0
    ap = rr < r_ap
    n_bad = int((ap & bad).sum())
    fill = np.where(bad & ap, 0.0, iof - bg)            # bad pixels inside the aperture: counted, set to sky
    total = float(np.sum(fill[ap]))
    edge = min(cy, cx, iof.shape[0] - 1 - cy, iof.shape[1] - 1 - cx)
    return {"A": total / (math.pi * r_px ** 2), "r_px": r_px, "center": (cx, cy), "bg": bg, "bad_in_aperture": n_bad,
            "aperture_inside_frame": bool(edge >= r_ap), "sky_pixels": int(sky.sum()), "phase": img.phase_deg}


def epoxi_disk() -> dict:
    """(epoch, filter) -> mean disk-integrated reflectance over the day's samples, with the individual values."""
    files = ed.epoxi_files()
    key = _cache_key([p for k in sorted(files) for p in files[k]])
    cache = CACHE / "earth" / f"epoxi-{key}.json"
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    sel = ed.epoxi_selection()
    out = {}
    for (ep, flt), paths in files.items():
        res = [epoxi_photometry(p, img) for p, img in zip(paths, sel[(ep, flt)])]
        a = np.array([r["A"] for r in res])
        out[f"{ep}|{flt}"] = {"epoch": ep, "filter": flt, "A_mean": float(a.mean()), "A_min": float(a.min()),
                              "A_max": float(a.max()), "n": len(res), "phase": float(np.mean([r["phase"] for r in res])),
                              "times": [i.time for i in sel[(ep, flt)]], "images": res}
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(out, indent=1), encoding="utf-8", newline="\n")
    return out


# ---------------------------------------------------------------------------------------------- products
AHI_KEYS = {1: "ahi9.B01", 2: "ahi9.B02", 3: "ahi9.B03", 4: "ahi9.B04"}
EPOXI_FILTER_KEYS = {"VIOLET": "hriv.Violet", "BLUE": "hriv.Blue", "GREEN": "hriv.Green", "ORANGE": "hriv.Orange",
                     "RED": "hriv.Red", "NIR": "hriv.NIR", "IR": "hriv.IR"}


def _src(ctx, dl):
    return dl.register(ctx) if ctx else dl.id


def earth_spectrum(ctx=None):
    """geometricAlbedoXYZS basis: the Himawari-9 disk reflectances in bands 1-4 at α ≈ 2.4° (a reference albedo)."""
    from . import albedo, filters
    hd = himawari_disk()
    bands = {AHI_KEYS[int(b)]: a["A"] for b, a in hd["bands"].items()}
    psg = albedo.payne(399, None)

    def blue_shape(wl):
        return np.interp(wl, psg.wl, psg.p)

    wl, p, nodes = albedo.broadband_reconstruction(bands, wl_min=300.0, blue_shape=blue_shape)
    himawari = ed.register_himawari(ctx) if ctx else "himawari9-ahi-l1b-fldk-20250320-0230"
    sources = [himawari, _src(ctx, ed.AHI_SRF), _src(ctx, albedo.PAYNE[399]), _src(ctx, albedo.PCK),
               _src(ctx, solar.HSRS)]
    vals = ", ".join(f"{bands[k]:.4f}" for k in AHI_KEYS.values())
    return albedo.AlbedoSpectrum(
        399, wl, p, "estimated", sources,
        f"Measured: the whole sunlit Earth from Himawari-9 (AHI Level 1b, 2025-03-20 02:30-02:39 UTC, the satellite's "
        f"local noon at 140.7°E one day before the equinox). Disk-integrated reflectance A = p·Φ at the phase angle "
        f"of the configuration, α = {hd['alpha_deg']:.2f}° (Sun-Earth-satellite; per pixel {hd['phase_min']:.1f}-"
        f"{hd['phase_max']:.1f}° because the satellite is only 6.6 Earth radii away), in bands 1-4 (0.47, 0.51, "
        f"0.64, 0.86 µm): {vals}. Per pixel I/F = πLd²/E_band (calibrated radiance; E_band = TSIS-1 HSRS averaged "
        "over the AHI-09 response), integrated over the disk as seen from far away in the same direction "
        "(A = Σ I/F·dA·μ∞/(πR²), R = pck00011 volumetric mean radius); the 2.3 % of the projected disk the "
        "satellite cannot see (beyond 81.3° from the sub-satellite point) takes the mean I/F of the 70-80° view-"
        "zenith ring. This is a REFERENCE ALBEDO at α ≈ 2.4° (Φ = 1 there), for one hemisphere (Asia, Australia, "
        "western Pacific) at one instant. Spectrum: piecewise-linear through the four band averages (nodes at the "
        f"bands' solar-weighted effective wavelengths, {', '.join(f'{n:.0f}' for n in nodes)} nm, solved exactly), "
        "constant beyond 0.86 µm; below 0.47 µm the relative shape of the Planetary Spectrum Generator model of "
        "Payne et al. (2026) (validated against DSCOVR/EPIC; Rayleigh-dominated) — an assumption, hence "
        "'estimated'.",
        "calibration: AHI visible bands are vicariously calibrated (a few percent); the Earth's disk-integrated "
        "reflectance varies with clouds, season and the hemisphere in view by ~10-20 % (EPOXI's 24-hour ranges: "
        "±5-10 % over one day); per-pixel phase spread 0-12° (the geometric albedo at exactly 0° may differ by a "
        "few percent: cloud glory, hot spots); limb annulus fill ≤ 2.3 % of A; spectral shape between 4 nodes and "
        "below 0.47 µm modelled",
        p_v_method=f"Bessell V band average of the spectrum above (reference phase α = {hd['alpha_deg']:.2f}°).",
        notes={"reference_phase_deg": hd["alpha_deg"], "himawari_bands": bands})


def mh_earth_delta(alpha: float) -> float:
    from .phase import MH
    c = MH["bodies"]["399"]["pieces"][0]["coeffs"]
    return float(sum(ci * alpha ** i for i, ci in enumerate(c)))


def earth_phase(ctx=None):
    from . import filters
    from .phase import APMAG_CODE, Phase
    hd = himawari_disk()
    a_ref = hd["alpha_deg"]
    grid = sorted(set(np.round(np.arange(0.0, 170.0 + 1e-9, 0.5), 6).tolist()) | {round(a_ref, 4)})
    dm = [round(mh_earth_delta(a) - mh_earth_delta(a_ref), 5) for a in grid]
    src_mh = APMAG_CODE.register(ctx) if ctx else APMAG_CODE.id
    himawari = ed.register_himawari(ctx) if ctx else "himawari9-ahi-l1b-fldk-20250320-0230"
    epoxi = ed.register_epoxi(ctx) if ctx else ["epoxi-hriv-earth-v2", ed.EPOXI_INDEX.id]
    chk = epoxi_check()
    txt = "; ".join(f"{c['epoch']} (α = {c['phase']:.1f}°) {c['ratio']:.2f}" for c in chk)
    return Phase(
        {"kind": "tabulated", "alphaDeg": [float(a) for a in grid], "deltaMag": dm}, "estimated",
        [src_mh, himawari, *epoxi, *(filters.register(ctx, ("hriv.Green",)) if ctx else ["svo-deepimpact-hriv-green"])],
        "Shape: Mallama & Hilton (2018) Eq. 5, a spline fit to the 'realistic clouds' radiative-transfer model of "
        "Tinetti et al. (2006) — a model, not a measured phase curve. Normalized to 1 at the reference phase angle "
        f"of the albedo, α = {a_ref:.2f}° (the Himawari-9 measurement), so Δm(0) = "
        f"{mh_earth_delta(0) - mh_earth_delta(a_ref):+.3f}. Tabulated every 0.5°, valid 0-170° (the model's range). "
        "Measured check (Deep Impact/EPOXI 24-hour means in the HRIV green filter, divided by this curve × the "
        f"albedo): {txt} — the Earth's brightness at a given phase varies by ±10-20 % with epoch, clouds and the "
        "hemisphere in view, and the three EPOXI days differ from the Himawari day.",
        "shape: model; measured points scatter ±20-30 % about it (EPOXI); weather and season: ±10-20 %",
        zero_phase_V10=None)


def epoxi_check() -> list[dict]:
    """EPOXI measured A (24-hour mean, green filter) vs the product's p(λ)·Φ(α) band-averaged over the same filter."""
    from . import filters
    spec = earth_spectrum(None)
    ep = epoxi_disk()
    out = []
    for key, v in ep.items():
        if v["filter"] != "GREEN":
            continue
        a = v["phase"]
        pred = filters.band_average(EPOXI_FILTER_KEYS["GREEN"], spec.wl, spec.p) * 10 ** (
            -0.4 * (mh_earth_delta(a) - mh_earth_delta(himawari_disk()["alpha_deg"])))
        frame = all(i["aperture_inside_frame"] for i in v["images"])
        out.append({"epoch": v["epoch"], "phase": a, "measured": v["A_mean"], "predicted": pred,
                    "ratio": v["A_mean"] / pred, "day_range": (v["A_min"], v["A_max"]), "aperture_inside_frame": frame})
    return out
