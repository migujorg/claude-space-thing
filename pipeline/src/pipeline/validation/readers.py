"""Readers for the calibrated images used by the validation cases (all return I/F arrays in display order:
row 0 = top line, column 0 = first sample, as the archive's own display keywords define)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np


def pds3_label(text: str) -> dict[str, str]:
    """Flat KEY = value map of a PDS3 label (later objects overwrite earlier keys; OBJECT blocks are prefixed)."""
    out: dict[str, str] = {}
    obj: list[str] = []
    key = None
    open_quote = False
    for line in text.splitlines():
        if open_quote:                                   # inside a multi-line quoted value
            out[".".join(obj + [key])] += "\n" + line
            open_quote = line.count('"') % 2 == 0
            continue
        m = re.match(r"^\s*([A-Z0-9_\^:]+)\s*=\s*(.*)$", line)
        if m:
            if m.group(2).strip().count('"') % 2 == 1:
                open_quote = True
            key, val = m.group(1), m.group(2).strip()
            if key == "OBJECT":
                obj.append(val)
                key = None
                continue
            if key == "END_OBJECT":
                obj.pop()
                key = None
                continue
            full = ".".join(obj + [key])
            out[full] = val
            out.setdefault(key, val)
        elif key is not None and line.strip() and not line.strip().startswith("/*"):
            out[".".join(obj + [key])] += " " + line.strip()
    return out


def _num(v: str) -> float:
    return float(re.sub(r"<.*?>", "", v).strip().strip('"'))


@dataclass
class Frame:
    iof: np.ndarray              # (lines, samples) float64, I/F; NaN where invalid
    label: dict[str, str]
    notes: str
    utc_mid: str                 # mid-exposure time (UTC, SPICE-parsable)
    exposure_s: float
    times_r2: bool = False       # iof still has to be multiplied by (Sun distance / AU)²


def cassini_calib(img: Path, lbl: Path) -> Frame:
    """CISSCAL-calibrated Cassini ISS image (RMS Node 'calibrated' holdings): PC_REAL float32 after one VICAR
    header record, units I/F (label DESCRIPTION: UNITS = 'I/F')."""
    lab = pds3_label(lbl.read_text(encoding="utf-8", errors="replace"))
    if "UNITS = 'I/F'" not in lab.get("DESCRIPTION", ""):
        raise ValueError(f"{img}: calibrated image is not in I/F units")
    rb = int(_num(lab["RECORD_BYTES"]))
    rec = int(re.search(r",\s*(\d+)\s*\)", lab["^IMAGE"]).group(1))
    lines, samples = int(_num(lab["IMAGE.LINES"])), int(_num(lab["IMAGE.LINE_SAMPLES"]))
    if lab["IMAGE.SAMPLE_TYPE"] != "PC_REAL" or int(_num(lab["IMAGE.SAMPLE_BITS"])) != 32:
        raise ValueError(f"{img}: unexpected sample type")
    raw = np.fromfile(img, dtype="<f4", count=lines * samples, offset=(rec - 1) * rb)
    a = raw.reshape(lines, samples).astype(float)
    # Invalid pixels: CISSCAL's ~ -1.5e36 markers, and line 0 of these products (zeros and junk values). A calibrated
    # pixel that is exactly 0.0 or outside −1 … 5 in I/F is not a measurement.
    a[~np.isfinite(a) | (a == 0.0) | (a < -1.0) | (a > 5.0) | ((np.abs(a) < 1e-30) & (a != 0))] = np.nan
    if np.isnan(a[0]).mean() > 0.5:
        a[0] = np.nan
    return Frame(a, lab, "CISSCAL 4.0beta I/F", lab["IMAGE_MID_TIME"].strip('"'),
                 _num(lab["EXPOSURE_DURATION"]) / 1000.0)


def voyager_geomed(img: Path, lbl: Path) -> Frame:
    """Voyager ISS GEOMED image (calibrated, geometrically corrected, 1000×1000 LSB int16); I/F = DN ×
    REFLECTANCE_SCALING_FACTOR. The blank frame around the resampled area (DN 0) and saturated/negative pixels are
    returned as NaN."""
    lab = pds3_label(lbl.read_text(encoding="utf-8", errors="replace"))
    rb = int(_num(lab["RECORD_BYTES"]))
    rec = int(re.search(r",\s*(\d+)\s*\)", lab["^IMAGE"]).group(1))
    lines, samples = int(_num(lab["IMAGE.LINES"])), int(_num(lab["IMAGE.LINE_SAMPLES"]))
    if lab["IMAGE.SAMPLE_TYPE"] != "LSB_INTEGER" or int(_num(lab["IMAGE.SAMPLE_BITS"])) != 16:
        raise ValueError(f"{img}: unexpected sample type")
    if lab["IMAGE.SAMPLE_DISPLAY_DIRECTION"] != "RIGHT" or lab["IMAGE.LINE_DISPLAY_DIRECTION"] != "DOWN":
        raise ValueError(f"{img}: unexpected display direction")
    raw = np.fromfile(img, dtype="<i2", count=lines * samples, offset=(rec - 1) * rb).reshape(lines, samples)
    scale = _num(lab["IMAGE.REFLECTANCE_SCALING_FACTOR"])
    a = raw.astype(float) * scale
    # The blank frame around the resampled area is DN 0 connected to the image edge; isolated zeros inside the
    # image are dark sky (I/F below the 1e-4 step) and are kept.
    from scipy import ndimage
    lab_, _ = ndimage.label(raw == 0)
    edge = np.unique(np.concatenate([lab_[0], lab_[-1], lab_[:, 0], lab_[:, -1]]))
    blank = np.isin(lab_, edge[edge > 0])
    a[blank | (raw >= 32767) | (raw <= -32768)] = np.nan
    exp = _num(lab["EXPOSURE_DURATION"])
    stop = lab["STOP_TIME"].strip('"')
    from .geometry import et_to_utc, utc_to_et
    mid = et_to_utc(utc_to_et(stop) - exp / 2)
    return Frame(a, lab, f"FICOR77 I/F = DN × {scale:g}", mid, exp)


LORRI_F_SOLAR_PIVOT = 176.0      # erg cm^-2 s^-1 Å^-1 at 1 AU at the pivot wavelength (SOC ICD 05310-SOCINST-01 §9.3.9)
LORRI_EXPOSURE_OFFSET_S = 0.0006  # true exposure = header EXPTIME + 0.6 ms (Spencer & Weaver 2020)
# Diffuse solar-spectrum photometry keyword from the 2016 in-flight calibration (Weaver et al. 2020, Table 2), for
# FORMAT 0 (1×1) and 1 (4×4). Products archived before that calibration carry the pre-flight value (e.g. 266400 for
# 1×1 in the 2007 Jupiter-encounter archive); LORRI's sensitivity showed no change at the ~1 % level over the mission
# (Weaver et al. 2020), so the in-flight value applies to all epochs.
LORRI_RSOLAR = {0: 2.349e5, 1: 4.092e6}


def lorri_sci(fit: Path) -> Frame:
    """New Horizons LORRI Level-2 ('sci') FITS: calibrated DN. Solar-weighted band I/F from the SOC ICD recipe
    I = C / TEXP / RSOLAR (radiance at the pivot wavelength for a solar-type spectrum), I/F = π I r² / F_solar.
    Returned without the r² factor (times_r2=True): the caller knows the Sun distance at the image time."""
    from astropy.io import fits
    with fits.open(fit) as h:
        hd = h[0].header
        c = np.asarray(h[0].data, float)
        q = np.asarray(h[2].data) if len(h) > 2 else None
    texp = float(hd["EXPTIME"])
    year = int(str(hd.get("ARCHDATE", "2099/001")).split("/")[0])
    if year < 2020:      # archived before the pipeline added the offset to EXPTIME (Spencer & Weaver, Feb 2020)
        texp += LORRI_EXPOSURE_OFFSET_S
    fmt = int(hd.get("FORMAT", 0))
    rsolar = LORRI_RSOLAR[fmt]
    iof = np.pi * (c / texp / rsolar) / LORRI_F_SOLAR_PIVOT
    if q is not None:
        iof[q != 0] = np.nan
    lab = {k: str(hd[k]) for k in hd if k and k != "COMMENT" and k != "HISTORY"}
    return Frame(iof, lab, f"I/F = π·C/(TEXP·RSOLAR)·r²/176; TEXP = {texp:.4f} s (header EXPTIME "
                           f"{float(hd['EXPTIME']):g} s); RSOLAR = {rsolar:g} (Weaver et al. 2020 Table 2, "
                           f"{'4×4' if fmt else '1×1'}; the header's value is {float(hd['RSOLAR']):g})",
                 str(hd["SPCUTCAL"]), texp, times_r2=True)


def epoxi_rad(fit: Path) -> Frame:
    """EPOXI HRI-VIS 'RAD' image (W m⁻² sr⁻¹ µm⁻¹); I/F = radiance × MULT2IOF (the archive's own solar flux per
    filter, at the target's Sun distance). Fill values and corrupt pixels (|I/F| > 3) are NaN (as in
    photometry/earth.epoxi_photometry)."""
    from astropy.io import fits
    with fits.open(fit) as h:
        hd = h[0].header
        d = np.asarray(h[0].data, float)
    with np.errstate(over="ignore", invalid="ignore"):
        iof = d * float(hd["MULT2IOF"])
    iof[~np.isfinite(iof) | (np.abs(iof) > 3.0)] = np.nan
    lab = {k: str(hd[k]) for k in hd if k and k not in ("COMMENT", "HISTORY")}
    return Frame(iof, lab, f"I/F = radiance × MULT2IOF ({float(hd['MULT2IOF']):.6g})", str(hd["OBSMIDDT"]),
                 float(hd["INTTIME"]) / 1000.0)
