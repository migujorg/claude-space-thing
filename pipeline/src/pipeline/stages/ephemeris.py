"""`ephemeris` stage -> app/public/data/ephem/{de440s,centers}.{json,bin} (schema EphemHeader).

de440s: every segment of NAIF's de440s.bsp, restricted to the records overlapping the manifest window
widened by MARGIN_S on both sides (room for light-time: no observer in the solar system sees anything more
than a few hours in the past). Records are copied bit-for-bit (label `measured`).

centers: DE440s has no planet centers relative to their system barycenters (499 wrt 4 ... 999 wrt 9). Those
offsets come from the JPL satellite ephemerides (tens of cm for Mars, ~100 km for Jupiter and Saturn,
~2000 km for Pluto). We sample them from JPL Horizons (geometric ICRF states, TDB) every STEP_MIN minutes and
fit SPK type 2 records, one per day (label `derived`). A second, independent Horizons query on a different
time grid is the hold-out check; the build fails if either residual reaches MAX_RESIDUAL_KM.
See docs/sources/jpl-horizons-center-*.md for why Horizons rather than the (0.1-2 GB) satellite SPKs.
"""

from __future__ import annotations

import math

import numpy as np

from .. import ephem_horizons as hz
from ..download import record
from ..ephem_kernels import PLANETARY, SRC_PLANETARY, planetary
from ..ephem_spk import Segment, evaluate, fit_type2, read_spk, restrict, write_product, J2000_FRAME_CODE
from ..schema import BuildContext, SourceRecord

DEPENDS: tuple[str, ...] = ()

DAY = 86400.0
MARGIN_S = 2 * DAY
# Centers product: record layout and sampling.
RECORD_S = DAY
DEGREE = 11
STEP_MIN = 60
HOLDOUT_STEP_MIN = 437      # 7 h 17 min: the hold-out epochs sweep through every phase of the 1-day records
HOLDOUT_OFFSET_MIN = 13
ALIGN_S = 32 * DAY          # centers coverage snaps outward to 32-day multiples so nearby rebuilds reuse downloads
# Record boundaries at 0h TDB (ET = 43200 s mod 1 day). The satellite ephemerides behind Horizons have record
# boundaries there; a record straddling one fits ~100x worse (measured: 3 m vs sub-mm for Uranus).
ALIGN_PHASE_S = 0.5 * DAY
MAX_RESIDUAL_KM = 1.0

CENTERS = [(499, 4, "Mars"), (599, 5, "Jupiter"), (699, 6, "Saturn"), (799, 7, "Uranus"), (899, 8, "Neptune"),
           (999, 9, "Pluto")]


def center_source_id(target: int) -> str:
    return f"jpl-horizons-center-{target}"


def run(ctx: BuildContext) -> None:
    t0, t1 = ctx.start_et - MARGIN_S, ctx.end_et + MARGIN_S

    path = planetary(ctx)
    segs = []
    for s in read_spk(path):
        r = restrict(s, t0, t1)
        r.sources = [SRC_PLANETARY]
        r.label = "measured"
        r.method = f"SPK type 2 records copied unchanged from {PLANETARY}.bsp (those overlapping the window)."
        segs.append(r)
    write_product(ctx, PLANETARY, segs, "ephemeris", notes=(
        f"Every {PLANETARY}.bsp segment restricted to the records overlapping the manifest window +/- 2 days; records "
        "are bit-identical to the kernel. Chain: 10,1..9 wrt 0 (SSB); 199 wrt 1; 299 wrt 2; 301, 399 wrt 3."))
    print(f"[ephemeris] {PLANETARY}: {len(segs)} segments, {sum(s.records.size for s in segs)} doubles")

    centers = [_center(ctx, tgt, ctr, name, t0, t1) for tgt, ctr, name in CENTERS]
    write_product(ctx, "centers", centers, "ephemeris", notes=(
        "Planet centers wrt their system barycenters (not in DE440s), fitted to JPL Horizons geometric state "
        f"vectors: SPK type 2, degree {DEGREE}, {RECORD_S / DAY:g}-day records, samples every {STEP_MIN} min. "
        f"Chain each to the SSB through the barycenter segments of ephem/{PLANETARY}."))


def _center(ctx: BuildContext, tgt: int, ctr: int, name: str, t0: float, t1: float) -> Segment:
    a = math.floor((t0 - ALIGN_PHASE_S) / ALIGN_S) * ALIGN_S + ALIGN_PHASE_S
    b = math.ceil((t1 - ALIGN_PHASE_S) / ALIGN_S) * ALIGN_S + ALIGN_PHASE_S
    n = int(round((b - a) / RECORD_S))
    jd_a, jd_b = hz.et_to_jd(a), hz.et_to_jd(b)
    sub = "horizons/centers"

    fit_params = hz.vector_params(str(tgt), f"500@{ctr}", start=hz.et_to_tdb_calendar(a)[:16],
                                  stop=hz.et_to_tdb_calendar(b)[:16], step=f"{STEP_MIN} m")
    fit_path, fit = hz.fetch_vectors(fit_params, sub, f"{tgt}_wrt_{ctr}_JD{jd_a:.1f}-{jd_b:.1f}_{STEP_MIN}m.txt")
    et = _snap(fit.et, a, 60.0)
    expected = n * int(RECORD_S // 60 // STEP_MIN) + 1
    if et.size != expected or not np.all(np.diff(et) == STEP_MIN * 60.0):
        raise ValueError(f"{fit_path.name}: expected {expected} contiguous samples, got {et.size}")
    if "GEOMETRIC" not in fit.output_type:
        raise ValueError(f"{fit_path.name}: not a geometric table ({fit.output_type})")

    records = fit_type2(et, fit.states[:, :3], a, RECORD_S, n, DEGREE)
    seg = Segment(tgt, ctr, J2000_FRAME_CODE, 2, a, RECORD_S, records.shape[1], records)
    pos, vel = evaluate(seg, et)
    fit_res = float(np.linalg.norm(pos - fit.states[:, :3], axis=1).max())
    fit_vres = float(np.linalg.norm(vel - fit.states[:, 3:], axis=1).max())

    ho_params = hz.vector_params(str(tgt), f"500@{ctr}",
                                 start=hz.et_to_tdb_calendar(a + HOLDOUT_OFFSET_MIN * 60)[:16],
                                 stop=hz.et_to_tdb_calendar(b)[:16], step=f"{HOLDOUT_STEP_MIN} m")
    ho_path, ho = hz.fetch_vectors(ho_params, sub, f"{tgt}_wrt_{ctr}_JD{jd_a:.1f}-{jd_b:.1f}_{HOLDOUT_STEP_MIN}m"
                                                   f"+{HOLDOUT_OFFSET_MIN}.txt")
    ho_et = _snap(ho.et, a, 60.0)
    hpos, hvel = evaluate(seg, ho_et)
    ho_res = float(np.linalg.norm(hpos - ho.states[:, :3], axis=1).max())
    ho_vres = float(np.linalg.norm(hvel - ho.states[:, 3:], axis=1).max())

    worst = max(fit_res, ho_res)
    if not worst < MAX_RESIDUAL_KM:
        raise ValueError(f"{tgt} wrt {ctr}: fit residual {worst} km exceeds {MAX_RESIDUAL_KM} km")
    amp = float(np.linalg.norm(fit.states[:, :3], axis=1).max())
    sat = fit.target_source or "unknown"

    fr, hr = record(fit_path), record(ho_path)
    sid = ctx.add_source(SourceRecord(
        id=center_source_id(tgt),
        title=f"JPL Horizons geometric state vectors: {name} center ({tgt}) relative to its system barycenter ({ctr})",
        citation=hz.CITATION + f". Underlying JPL satellite ephemeris named by Horizons: {sat} "
                 "(JPL Solar System Dynamics Group, https://ssd.jpl.nasa.gov/sats/ephem/).",
        url=fr["url"], retrieved=fr["retrieved"], sha256=fr["sha256"], version=sat,
        license="JPL Horizons output; see https://ssd.jpl.nasa.gov/horizons/manual.html",
        notes=(f"Fitted query: {fit.target_line} / {fit.center_line}; {et.size} states every {STEP_MIN} min "
               f"(JD TDB {jd_a:.1f}-{jd_b:.1f}). Hold-out (verification only, not fitted): {hr['url']} "
               f"sha256 {hr['sha256']}, {ho_et.size} states."),
    ))
    seg.sources = [sid]
    seg.label = "derived"
    seg.method = (f"Least-squares Chebyshev fit (SPK type 2, degree {DEGREE}, {RECORD_S / DAY:g}-day records) to "
                  f"JPL Horizons geometric ICRF states of {tgt} wrt {ctr} sampled every {STEP_MIN} min (TDB); "
                  f"Horizons evaluates the JPL satellite ephemeris {sat}.")
    seg.uncertainty = (f"fit vs Horizons: max {fit_res:.2e} km at {et.size} fitted epochs, max {ho_res:.2e} km at "
                       f"{ho_et.size} independent hold-out epochs (velocity max {max(fit_vres, ho_vres):.1e} km/s); "
                       f"offset magnitude up to {amp:.4g} km. Excludes the error of {sat} itself.")
    print(f"[ephemeris] {tgt} wrt {ctr}: |offset|<={amp:.4g} km, fit {fit_res:.2e} km, hold-out {ho_res:.2e} km, "
          f"vel {max(fit_vres, ho_vres):.1e} km/s ({sat})")
    return seg


def _snap(et: np.ndarray, origin: float, quantum: float) -> np.ndarray:
    """Horizons prints JD TDB to 1e-9 d (86 us); our grids are whole minutes, so snap to them exactly."""
    snapped = origin + np.round((et - origin) / quantum) * quantum
    if np.abs(snapped - et).max() > 1e-3:
        raise ValueError("Horizons epochs are not on the requested minute grid")
    return snapped
