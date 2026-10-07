"""Calibrated epoxi reader; kept separate for per-case import locks."""
from __future__ import annotations

import re
from pathlib import Path
import numpy as np
from .readers import Frame, _num, pds3_label


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
