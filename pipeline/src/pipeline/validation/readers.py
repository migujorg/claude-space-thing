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


def __getattr__(name):
    """Load only the reader selected by the case (retain the readers API)."""
    from importlib import import_module
    mission = {'cassini_calib': 'cassini', '_cassini_vicar_pixels': 'cassini',
               'voyager_geomed': 'voyager', '_voyager_vicar_pixels': 'voyager',
               'lorri_sci': 'lorri', 'LORRI_F_SOLAR_PIVOT': 'lorri',
               'LORRI_EXPOSURE_OFFSET_S': 'lorri', 'LORRI_RSOLAR': 'lorri',
               'epoxi_rad': 'epoxi'}.get(name)
    if mission is None:
        raise AttributeError(name)
    return getattr(import_module(f'{__package__}.reader_{mission}'), name)
