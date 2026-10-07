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


def _cassini_vicar_pixels(img: Path, lab: dict[str, str], lines: int, samples: int) -> np.ndarray:
    """Read the single-band REAL/BSQ/RIEEE layout used by CISSCAL, refusing other layouts.

    VICAR File Format (Deen, JPL IPSD:384-92-196), Labels and Binary Labels:
    https://nasa-ammos.github.io/VICAR-DOCS/external/VICAR_file_fmt.pdf
    LBLSIZE precedes NLB binary-header records; every image record has NBB prefix bytes.
    The detached ^IMAGE in these holdings can point at the binary header instead of the pixels.
    """
    if lab.get("IMAGE_HEADER.HEADER_TYPE") != "VICAR2":
        raise ValueError(f"{img}: expected VICAR2 image header")
    rb = int(_num(lab["RECORD_BYTES"]))
    pointer = re.fullmatch(r'\(\s*"[^"\n]+"\s*,\s*(\d+)\s*\)', lab["^IMAGE_HEADER"])
    if rb <= 0 or pointer is None or int(pointer[1]) < 1:
        raise ValueError(f"{img}: invalid VICAR image-header record pointer")
    base = (int(pointer[1]) - 1) * rb
    with img.open("rb") as stream:
        stream.seek(base)
        first = stream.read(64)
        match = re.match(rb"LBLSIZE\s*=\s*(\d+)\b", first)
        if match is None:
            raise ValueError(f"{img}: missing VICAR LBLSIZE")
        size = int(match[1])
        if size <= 0 or size > img.stat().st_size - base:
            raise ValueError(f"{img}: invalid or truncated VICAR label")
        stream.seek(base)
        text = stream.read(size).split(b"\0", 1)[0].decode("ascii")
        system = {}
        # Consume quoted values as a whole; history/property keywords cannot override the system layout.
        for m in re.finditer(r"\b([A-Z][A-Z0-9_]*)\s*=\s*('(?:[^']|'')*'|[^\s]+)", text):
            key, value = m.groups()
            if key in ("PROPERTY", "TASK"):
                break
            system[key] = value.strip("'")

        def integer(key: str, default: int | None = None) -> int:
            value = system.get(key, default)
            if value is None or re.fullmatch(r"[+-]?\d+", str(value)) is None:
                raise ValueError(f"{img}: invalid or missing VICAR {key}")
            return int(value)

        if integer("EOL", 0) != 0:
            raise ValueError(f"{img}: VICAR EOL labels are not supported (EOL must be 0)")
        if system.get("TYPE") != "IMAGE" or system.get("FORMAT") != "REAL":
            raise ValueError(f"{img}: expected VICAR REAL IMAGE")
        if system.get("ORG") != "BSQ" or integer("NB") != 1:
            raise ValueError(f"{img}: expected single-band VICAR BSQ")
        if system.get("REALFMT") != "RIEEE" or system.get("COMPRESS", "NONE") != "NONE":
            raise ValueError(f"{img}: expected uncompressed VICAR RIEEE samples")
        if (integer("NL"), integer("NS")) != (lines, samples) or min(lines, samples) <= 0:
            raise ValueError(f"{img}: VICAR and detached IMAGE dimensions disagree")
        stride, prefix, nlb = integer("RECSIZE"), integer("NBB", 0), integer("NLB", 0)
        if prefix < 0 or nlb < 0:
            raise ValueError(f"{img}: negative VICAR binary header/prefix size")
        if stride != prefix + samples * 4 or size % stride != 0:
            raise ValueError(f"{img}: inconsistent VICAR record or label size")
        offset = base + size + nlb * stride
        stream.seek(offset)
        records = stream.read(lines * stride)
    if len(records) != lines * stride:
        raise ValueError(f"{img}: truncated VICAR pixel records")
    return np.ndarray((lines, samples), dtype="<f4", buffer=records,
                      offset=prefix, strides=(stride, 4)).astype(float)


def cassini_calib(img: Path, lbl: Path) -> Frame:
    """CISSCAL-calibrated Cassini ISS image (RMS Node 'calibrated' holdings): PC_REAL float32 after the VICAR label
    and binary-header records, units I/F (label DESCRIPTION: UNITS = 'I/F')."""
    lab = pds3_label(lbl.read_text(encoding="utf-8", errors="replace"))
    if "UNITS = 'I/F'" not in lab.get("DESCRIPTION", ""):
        raise ValueError(f"{img}: calibrated image is not in I/F units")
    lines, samples = int(_num(lab["IMAGE.LINES"])), int(_num(lab["IMAGE.LINE_SAMPLES"]))
    if lab["IMAGE.SAMPLE_TYPE"] != "PC_REAL" or int(_num(lab["IMAGE.SAMPLE_BITS"])) != 32:
        raise ValueError(f"{img}: unexpected sample type")
    a = _cassini_vicar_pixels(img, lab, lines, samples)
    # Invalid pixels: CISSCAL's ~ -1.5e36 markers. A calibrated pixel that is exactly 0.0 or outside −1 … 5 in I/F
    # is not a measurement. No special first-line mask: the apparent junk row was the binary header.
    a[~np.isfinite(a) | (a == 0.0) | (a < -1.0) | (a > 5.0) | ((np.abs(a) < 1e-30) & (a != 0))] = np.nan
    return Frame(a, lab, "CISSCAL 4.0beta I/F", lab["IMAGE_MID_TIME"].strip('"'),
                 _num(lab["EXPOSURE_DURATION"]) / 1000.0)


def _voyager_vicar_pixels(img: Path, lab: dict[str, str], lines: int, samples: int) -> np.ndarray:
    """Check GEOMED's embedded HALF/BSQ/LOW layout against the detached image pointer.

    VICAR File Format (Deen, JPL IPSD:384-92-196), Labels and Binary Labels:
    https://nasa-ammos.github.io/VICAR-DOCS/external/VICAR_file_fmt.pdf
    LBLSIZE is followed by NLB binary-header records; NBB bytes prefix each pixel record.
    """
    if lab.get("VICAR_HEADER.HEADER_TYPE") != "VICAR":
        raise ValueError(f"{img}: expected VICAR image header")
    rb = int(_num(lab["RECORD_BYTES"]))

    def record_pointer(key: str) -> int:
        m = re.fullmatch(r'\(\s*"[^"\n]+"\s*,\s*(\d+)\s*\)', lab.get(key, ""))
        if rb <= 0 or m is None or int(m[1]) < 1:
            raise ValueError(f"{img}: invalid detached {key} record pointer")
        return (int(m[1]) - 1) * rb

    base, detached = record_pointer("^VICAR_HEADER"), record_pointer("^IMAGE")
    with img.open("rb") as stream:
        stream.seek(base)
        match = re.match(rb"LBLSIZE\s*=\s*(\d+)\b", stream.read(64))
        if match is None:
            raise ValueError(f"{img}: missing VICAR LBLSIZE")
        size = int(match[1])
        if size <= 0 or size > img.stat().st_size - base:
            raise ValueError(f"{img}: invalid or truncated VICAR label")
        stream.seek(base)
        text = stream.read(size).split(b"\0", 1)[0].decode("ascii")
        system = {}
        for m in re.finditer(r"\b([A-Z][A-Z0-9_]*)\s*=\s*('(?:[^']|'')*'|[^\s]+)", text):
            key, value = m.groups()
            if key in ("PROPERTY", "TASK"):
                break
            system[key] = value.strip("'")

        def integer(key: str, default: int | None = None) -> int:
            value = system.get(key, default)
            if value is None or re.fullmatch(r"[+-]?\d+", str(value)) is None:
                raise ValueError(f"{img}: invalid or missing VICAR {key}")
            return int(value)

        if integer("EOL", 0) != 0:
            raise ValueError(f"{img}: VICAR EOL labels are not supported (EOL must be 0)")
        if system.get("TYPE") != "IMAGE" or system.get("FORMAT") != "HALF":
            raise ValueError(f"{img}: expected VICAR HALF IMAGE")
        if system.get("ORG") != "BSQ" or integer("NB") != 1:
            raise ValueError(f"{img}: expected single-band VICAR BSQ")
        if system.get("INTFMT") != "LOW" or system.get("COMPRESS", "NONE") != "NONE":
            raise ValueError(f"{img}: expected uncompressed VICAR LOW integer samples")
        if (integer("NL"), integer("NS")) != (lines, samples) or min(lines, samples) <= 0:
            raise ValueError(f"{img}: VICAR and detached IMAGE dimensions disagree")
        stride, prefix, nlb = integer("RECSIZE"), integer("NBB", 0), integer("NLB", 0)
        if prefix < 0 or nlb < 0:
            raise ValueError(f"{img}: negative VICAR binary header/prefix size")
        if stride != rb or stride != prefix + samples * 2 or size % stride != 0:
            raise ValueError(f"{img}: inconsistent VICAR/detached record or label size")
        offset = base + size + nlb * stride
        if offset != detached:
            raise ValueError(f"{img}: detached ^IMAGE offset {detached} bytes disagrees with "
                             f"VICAR image-record offset {offset} bytes")
        end = offset + lines * stride
        actual_size = img.stat().st_size
        if actual_size < end:
            raise ValueError(f"{img}: truncated VICAR pixel records (file size {actual_size}, expected {end})")
        if actual_size != end or actual_size != int(_num(lab["FILE_RECORDS"])) * rb:
            raise ValueError(f"{img}: VICAR/detached file size disagrees (actual {actual_size}, "
                             f"VICAR {end}, detached {int(_num(lab['FILE_RECORDS'])) * rb})")
        stream.seek(offset)
        records = stream.read(lines * stride)
    if len(records) != lines * stride:
        raise ValueError(f"{img}: truncated VICAR pixel records")
    return np.ndarray((lines, samples), dtype="<i2", buffer=records,
                      offset=prefix, strides=(stride, 2))


def voyager_geomed(img: Path, lbl: Path) -> Frame:
    """Voyager ISS GEOMED image (calibrated, geometrically corrected, 1000×1000 LSB int16); I/F = DN ×
    REFLECTANCE_SCALING_FACTOR. The blank frame around the resampled area (DN 0) and saturated/negative pixels are
    returned as NaN."""
    lab = pds3_label(lbl.read_text(encoding="utf-8", errors="replace"))
    lines, samples = int(_num(lab["IMAGE.LINES"])), int(_num(lab["IMAGE.LINE_SAMPLES"]))
    if lab["IMAGE.SAMPLE_TYPE"] != "LSB_INTEGER" or int(_num(lab["IMAGE.SAMPLE_BITS"])) != 16:
        raise ValueError(f"{img}: unexpected sample type")
    if lab["IMAGE.SAMPLE_DISPLAY_DIRECTION"] != "RIGHT" or lab["IMAGE.LINE_DISPLAY_DIRECTION"] != "DOWN":
        raise ValueError(f"{img}: unexpected display direction")
    raw = _voyager_vicar_pixels(img, lab, lines, samples)
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
    photometry/earth.epoxi_photometry). The FLAGS quality map also excludes invalid radiances."""
    from astropy.io import fits
    with fits.open(fit) as h:
        hd = h[0].header
        with np.errstate(invalid="ignore"):
            d = np.asarray(h[0].data, float)
        if "FLAGS" not in h:
            raise ValueError(f"{fit}: missing EPOXI FLAGS quality map")
        flags = np.asarray(h["FLAGS"].data)
        if flags.shape != d.shape:
            raise ValueError(f"{fit}: EPOXI FLAGS shape {flags.shape} disagrees with image {d.shape}")
        if flags.dtype != np.uint8:
            raise ValueError(f"{fit}: expected EPOXI FLAGS byte map")
    # Product label EXT_QUALITY_FLAGS_HEADER and EPOXI Calibration Pipeline Summary (2014), §1.2:
    # https://pdssbn.astro.umd.edu/holdings/di-c-hrii_hriv_mri_its-6-doc-set-v4.0/document/calibration/
    # calibration_docs/epoxical_v5_10/epoxi_cal_pipeline_summ.pdf
    # Bits 0/1: bad/missing; 4/5/6: partial/full-well/ADC saturation; 7: ultra compressed
    # (very little information). Bits 2/3 describe despiked/reclaimed pixels and alone do not
    # declare invalid radiance; the original bad/missing/saturation flags still invalidate them.
    invalid = (flags & 0xF3) != 0
    with np.errstate(over="ignore", invalid="ignore"):
        iof = d * float(hd["MULT2IOF"])
    iof[invalid | ~np.isfinite(iof) | (np.abs(iof) > 3.0)] = np.nan
    lab = {k: str(hd[k]) for k in hd if k and k not in ("COMMENT", "HISTORY")}
    return Frame(iof, lab, f"I/F = radiance × MULT2IOF ({float(hd['MULT2IOF']):.6g})", str(hd["OBSMIDDT"]),
                 float(hd["INTTIME"]) / 1000.0)
