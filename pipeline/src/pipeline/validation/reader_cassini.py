"""Calibrated cassini reader; kept separate for per-case import locks."""
from __future__ import annotations

import re
from pathlib import Path
import numpy as np
from .readers import Frame, _num, pds3_label


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
