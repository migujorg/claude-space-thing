"""Calibrated lorri reader; kept separate for per-case import locks."""
from __future__ import annotations

import re
from pathlib import Path
import numpy as np
from .readers import Frame, _num, pds3_label


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
