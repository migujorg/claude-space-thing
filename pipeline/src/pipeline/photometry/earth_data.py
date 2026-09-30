"""Measured whole-disk photometry of the Earth: the downloads (earth.py does the photometry).

  * Himawari-9 AHI Level 1b full-disk images (NOAA Open Data on AWS, JMA Himawari Standard Data format), bands 1-4
    (0.47, 0.51, 0.64, 0.86 µm), at 2025-03-20 02:30 UTC: the satellite's local noon one day before the March
    equinox, so the Sun is almost behind the satellite (phase angle ~1°).
  * AHI-09 spectral response functions (JMA Meteorological Satellite Center).
  * Deep Impact / EPOXI HRIV calibrated images of the whole Earth, 7 filters 350-950 nm, three 24-hour sequences at
    phase angles 57.5°, 76.6° and 85.9° (PDS Small Bodies Node, DIF-E-HRIV-3/4-EPOXI-EARTH-V2.0).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from .. import download
from ..schema import BuildContext, SourceRecord
from .common import Download

# ---------------------------------------------------------------------------------------------- Himawari-9
HIMAWARI_BUCKET = "https://noaa-himawari9.s3.amazonaws.com/"
HIMAWARI_TIME = ("2025", "03", "20", "0230")
HIMAWARI_BANDS = {1: "R10", 2: "R10", 3: "R05", 4: "R10"}      # resolution code: 1 km, 0.5 km
HIMAWARI_SEGMENTS = 10


def himawari_key(band: int, segment: int) -> str:
    y, m, d, hm = HIMAWARI_TIME
    return (f"AHI-L1b-FLDK/{y}/{m}/{d}/{hm}/HS_H09_{y}{m}{d}_{hm}_B{band:02d}_FLDK_{HIMAWARI_BANDS[band]}_"
            f"S{segment:02d}{HIMAWARI_SEGMENTS:02d}.DAT.bz2")


def himawari_files() -> list[Path]:
    """All 40 segment files (bands 1-4 × 10 segments), downloaded once (628 MB)."""
    out = []
    for b in HIMAWARI_BANDS:
        for s in range(1, HIMAWARI_SEGMENTS + 1):
            key = himawari_key(b, s)
            out.append(download.fetch(HIMAWARI_BUCKET + key, "earth/himawari9", key.split("/")[-1], timeout=300.0))
    return out


HIMAWARI_CITATION = (
    "Japan Meteorological Agency, Himawari-9 Advanced Himawari Imager (AHI) Level 1b full-disk data in Himawari "
    "Standard Data format, distributed by the NOAA Open Data Dissemination program on Amazon Web Services "
    "(s3://noaa-himawari9, https://registry.opendata.aws/noaa-himawari/). Instrument and format: Bessho, K. et al. "
    "(2016). An introduction to Himawari-8/9 — Japan's new-generation geostationary meteorological satellites. "
    "Journal of the Meteorological Society of Japan 94, 151-183. DOI:10.2151/jmsj.2016-009.")

AHI_SRF = Download(
    id="jma-ahi9-srf",
    url="https://www.data.jma.go.jp/mscweb/en/himawari89/space_segment/srf_201310/AHI-09_SpectralResponsivity.zip",
    subdir="earth", name="AHI-09_SpectralResponsivity.zip",
    title="AHI-09 spectral response curves (bands 1-16), released October 2013",
    citation="Japan Meteorological Agency, Meteorological Satellite Center: AHI-09 Spectral Response Curves "
             "(Excel workbook), https://www.data.jma.go.jp/mscweb/en/himawari89/space_segment/spsg_ahi.html#srf.",
    notes="Relative spectral responsivity vs wavelength (µm) per band; bands 1-4 used.")


def register_himawari(ctx: BuildContext) -> str:
    paths = himawari_files()
    h = hashlib.sha256()
    for p in paths:
        h.update((download.record(p)["sha256"] + "\n").encode())
    first = download.record(paths[0])
    y, m, d, hm = HIMAWARI_TIME
    return ctx.add_source(SourceRecord(
        id="himawari9-ahi-l1b-fldk-20250320-0230",
        title=f"Himawari-9 AHI L1b full disk, {y}-{m}-{d} {hm[:2]}:{hm[2:]} UTC, bands 1-4 (40 segment files)",
        citation=HIMAWARI_CITATION,
        url=HIMAWARI_BUCKET + himawari_key(1, 1).rsplit("/", 1)[0] + "/",
        retrieved=first["retrieved"], sha256=h.hexdigest(),
        version="Himawari Standard Data format 1.3",
        license="Open data (NOAA Open Data Dissemination; JMA data policy for Himawari)",
        notes="sha256 is SHA-256 over the per-file sha256 values (one per line; band 1-4, segment 1-10 order); files "
              "are in data/raw/earth/himawari9/ and listed with their digests in data/raw/_downloads.json."))


# ---------------------------------------------------------------------------------------------- EPOXI
EPOXI_BASE = "https://pdssbn.astro.umd.edu/holdings/dif-e-hriv-3_4-epoxi-earth-v2.0/"
EPOXI_INDEX = Download(
    id="epoxi-hriv-earth-index", url=EPOXI_BASE + "document/hriv_3_4_epoxi_earth.tab", subdir="earth/epoxi",
    name="hriv_3_4_epoxi_earth.tab",
    title="EPOXI HRIV Earth observations: index of calibrated images with geometry",
    citation="A'Hearn, M. F. et al. (2012). EPOXI HRIV Earth observations - calibrated images, "
             "DIF-E-HRIV-3/4-EPOXI-EARTH-V2.0, NASA Planetary Data System Small Bodies Node.",
    notes="Per image: time, filter, range, pixel scale, phase angle, sub-spacecraft and sub-solar points.")
EPOXI_CITATION = (
    "McLaughlin, S. A., Carcich, B., Sackett, S. E., Klaasen, K. P. et al. (2012). EPOXI HRIV Earth observations - "
    "calibrated images, DIF-E-HRIV-3/4-EPOXI-EARTH-V2.0, NASA Planetary Data System Small Bodies Node "
    "(PI M. F. A'Hearn; EPOCh PI D. Deming). Observations: Livengood, T. A. et al. (2011). Properties of an "
    "Earth-like planet orbiting a Sun-like star: Earth observed by the EPOXI mission. Astrobiology 11, 907-930. "
    "DOI:10.1089/ast.2011.0614. Instrument: Hampton, D. L. et al. (2005), Space Science Reviews 117, 43-93, "
    "DOI:10.1007/s11214-005-3390-8; calibration: Klaasen, K. P. et al. (2013), Icarus 225, 643-680, "
    "DOI:10.1016/j.icarus.2013.03.024.")
EPOXI_EPOCHS = {                # first day of each 24-hour sequence -> the days it spans
    "2008-03": ("2008-03-18", "2008-03-19"),
    "2008-06": ("2008-06-04", "2008-06-05"),
    "2009-03": ("2009-03-27", "2009-03-28"),
}
EPOXI_FILTERS = ("VIOLET", "BLUE", "GREEN", "ORANGE", "RED", "NIR", "IR")
EPOXI_SAMPLES = 4               # images per filter per sequence, spread over the 24 hours (rotation average)


@dataclass(frozen=True)
class EpoxiImage:
    time: str
    jd: float
    filter: str
    range_km: float
    pixel_scale_m: float
    phase_deg: float
    file: str               # index FILE_NAME (the RADREV name); the RAD file is its lower-case "_r" sibling
    year: str
    doy: str


@lru_cache(maxsize=1)
def epoxi_index() -> list[EpoxiImage]:
    out = []
    for line in EPOXI_INDEX.fetch().read_text().splitlines():
        f = line.split()
        if not f or not f[0][:2] == "20":
            continue
        out.append(EpoxiImage(f[0], float(f[1]), f[10], float(f[4]), float(f[5]), float(f[6]), f[13], f[11], f[12]))
    return out


@lru_cache(maxsize=1)
def epoxi_selection() -> dict[tuple[str, str], list[EpoxiImage]]:
    """(epoch, filter) -> images at EPOXI_SAMPLES times evenly spread over the sequence."""
    idx = epoxi_index()
    sel = {}
    for ep, days in EPOXI_EPOCHS.items():
        rows = [r for r in idx if r.time[:10] in days]
        t0, t1 = min(r.jd for r in rows), max(r.jd for r in rows)
        for flt in EPOXI_FILTERS:
            cand = [r for r in rows if r.filter == flt]
            picks = []
            for k in range(EPOXI_SAMPLES):
                t = t0 + (k + 0.5) * (t1 - t0) / EPOXI_SAMPLES
                best = min(cand, key=lambda r: abs(r.jd - t))
                if best not in picks:
                    picks.append(best)
            sel[(ep, flt)] = picks
    return sel


def epoxi_rad_url(img: EpoxiImage) -> str:
    name = img.file.lower().replace("_rr.fit", "_r.fit")
    return f"{EPOXI_BASE}data/rad/{img.year}/{img.doy}/{name}"


def epoxi_files() -> dict[tuple[str, str], list[Path]]:
    out = {}
    for key, imgs in epoxi_selection().items():
        out[key] = [download.fetch(epoxi_rad_url(i), "earth/epoxi", epoxi_rad_url(i).split("/")[-1], retries=6)
                    for i in imgs]
    return out


def register_epoxi(ctx: BuildContext) -> list[str]:
    files = epoxi_files()
    paths = [p for k in sorted(files) for p in files[k]]
    h = hashlib.sha256()
    for p in paths:
        h.update((download.record(p)["sha256"] + "\n").encode())
    idx = EPOXI_INDEX.register(ctx)
    sid = ctx.add_source(SourceRecord(
        id="epoxi-hriv-earth-v2", title=f"EPOXI HRIV calibrated images of the Earth ({len(paths)} images, 7 filters, "
                                        "2008-03, 2008-06, 2009-03)",
        citation=EPOXI_CITATION, url=EPOXI_BASE + "data/rad/", retrieved=download.record(paths[0])["retrieved"],
        sha256=h.hexdigest(), version="V2.0 (2012-12-31)", license="NASA PDS (public)",
        notes=f"Irreversibly calibrated radiance images (RAD). sha256 is SHA-256 over the per-file sha256 values "
              f"(epoch, filter, time order); files in data/raw/earth/epoxi/. Selection from the index ({idx})."))
    return [sid, idx]
