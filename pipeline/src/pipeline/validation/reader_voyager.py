"""Calibrated voyager reader; kept separate for per-case import locks."""
from __future__ import annotations

import re
from pathlib import Path
import numpy as np
from .readers import Frame, _num, pds3_label


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
