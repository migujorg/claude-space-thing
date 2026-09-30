"""The Moon (NAIF 301): albedo (7-band LROC WAC), height (LOLA) and Hapke-parameter layers.

albedo  Relative normal reflectance XYZS, level 5 (16384 × 8192 texels, 0.67 km at the equator).
        70°S–70°N: LROC WAC Hapke-normalized 7-band mosaic (Sato et al. 2017; I/F at i = g = 60°, e = 0), converted
        texel by texel to normal albedo with the same published per-1°-cell Hapke parameters that were used for the
        normalization (Sato et al. 2014). Normal albedo here excludes the shadow-hiding opposition surge (B_S0 → 0
        at g = 0), consistently with the disk-integrated geometric albedo the renderer multiplies by (Lane & Irvine
        1973, which extrapolates to zero phase from outside the surge), and because the surge width h_s sits at its
        fit bounds (0 or 0.2) in hundreds of cells.
        Poleward of 70°: LROC WAC empirically normalized polar mosaics (Boyd et al. 2012; i = g = 30°, e = 0), scaled
        per band to the Hapke-derived normal albedo by the median ratio in the 62–69.5° ring where both exist
        (an assumption that the ratio holds poleward → `estimated`). Texels neither product covers stay unknown.
        Colour: band ratios interpolated per surf_color (bands 321–689 nm; 689–830 nm held at the 689 nm ratio).
height  LOLA LDEM_64 (V3.1, 64 px/deg), meters above the 1737.4 km sphere (the IAU/pck00011 Moon radius).
hapke   The published Hapke parameters (w, b, c, B_S0, h_s per band), level 0, nearest-neighbour from the 1° grid.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from . import surf_color as sc
from . import surf_grid as sg
from . import surf_hapke as hk
from . import surf_layers as sl
from . import surf_pds as pds
from . import surf_tiles as st
from .download import fetch, record
from .schema import BuildContext
from .surf_fetch import Prefetcher, discard, fetch_transient

NAIF = 301
NAME = "Moon"
SUBDIR = "surfaces/moon"
ALBEDO_LEVEL = 5
HEIGHT_LEVEL = 4
BANDS = (321, 360, 415, 566, 604, 643, 689)
BASE = ("https://pds.mcp.nasa.gov/data/store/img/lunar_reconnaissance_orbiter/pds4/lroc/lro-l-lroc-5-rdr/"
        "LROLRC_2001/DATA/")
WAC_TILES = [f"E350{h}{lon}" for h in "NS" for lon in ("0450", "1350", "2250", "3150")]
PARAM_URL = BASE + "SDP/WAC_HAPKEPARAMMAP/WAC_HAPKEPARAMMAP_7BAND.IMG"
LDEM = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/"
PARAM_NAMES = ("w", "b", "c", "Bc0", "hc", "Bs0", "hs", "theta", "phi")
RING = (62.0, 69.5)   # |lat| range used to tie the polar mosaics to the Hapke-normalized one
EMP_BLOCK = 3         # 200 m polar pixels → 600 m blocks before sampling at 0.67 km texels

SRC_WAC = "lroc-wac-hapke-7band"
SRC_PARAM = "lroc-wac-hapke-parameters"
SRC_EMP = "lroc-wac-emp-polar"
SRC_LOLA = "lola-ldem-64"


def wac_url(band: int, tile: str) -> str:
    return f"{BASE}MDR/WAC_HAPKE/WAC_HAPKE_{band}NM_{tile}.IMG"


def emp_url(band: int, pole: str) -> str:
    return f"{BASE}MDR/WAC_EMP/WAC_EMP_{band}NM_P900{pole}0000_152P.IMG"


# ---------------------------------------------------------------------------------------------- inputs


def hapke_params() -> tuple[np.ndarray, sg.EquirectGrid, Path]:
    """(7 bands, 9 params, 140, 360) array on the 1° grid, and its grid."""
    p = fetch(PARAM_URL, SUBDIR)
    lab = pds.read_attached_label(p)
    grid = pds.equirect_grid(lab)
    arr = np.stack([np.asarray(pds.read_band(p, lab, k), np.float32) for k in range(63)])
    if pds.isis_special_mask(arr).any():
        raise ValueError("unexpected special pixels in the Hapke parameter map")
    return arr.reshape(7, 9, grid.lines, grid.samples), grid, p


def _memmap(path: Path, shape, mode="r") -> np.ndarray:
    return np.memmap(path, np.float32, mode=mode, shape=shape)


def wac_band(band: int, work: Path) -> tuple[np.ndarray, dict]:
    """Level-5 mean of the Hapke-normalized I/F for one band (0 = unknown); cached in `work`."""
    shape = st.level_shape(ALBEDO_LEVEL)
    arr_p, meta_p = work / f"wac60_{band}.f32", work / f"wac60_{band}.json"
    if arr_p.exists() and meta_p.exists():
        return _memmap(arr_p, shape), json.loads(meta_p.read_text(encoding="utf-8"))
    num = _memmap(work / "num.tmp", shape, "w+")
    den = _memmap(work / "den.tmp", shape, "w+")
    files, counts = {}, {"valid": 0, "total": 0}
    for tile, (path, rec) in Prefetcher(WAC_TILES, lambda t: fetch_transient(wac_url(band, t), SUBDIR)):
        lab = pds.read_attached_label(path)
        grid = pds.equirect_grid(lab)
        data = pds.read_band(path, lab)
        c = sg.accumulate_chunked(num, den, data, grid, ALBEDO_LEVEL,
                                  lambda b: ~pds.isis_special_mask(b) & (b > 0))
        counts["valid"] += c["validPixels"]
        counts["total"] += c["totalPixels"]
        files[path.name] = rec
        del data
        discard(path)
        print(f"[surfaces] Moon WAC {band} nm {tile}: {c['validPixels'] / c['totalPixels']:.4f} valid")
    out = _memmap(arr_p, shape, "w+")
    sg.finish(num, den, 0.5, out)
    out.flush()
    del num, den
    discard(work / "num.tmp")   # tolerant of Windows, where a file still memory-mapped cannot be deleted
    discard(work / "den.tmp")
    meta = {"files": files, "counts": counts}
    meta_p.write_text(json.dumps(meta), encoding="utf-8", newline="\n")
    return _memmap(arr_p, shape), meta


def hapke_consistency(params: np.ndarray, pgrid: sg.EquirectGrid, band_index: int, a60: np.ndarray) -> dict:
    """Check of our Hapke implementation against the product: the mosaic's mean I/F over the central 40 × 40
    texels of 1° cells (every 10th cell) divided by the model's RADF(60°, 0°, 60°) for that cell's parameters."""
    h, w = a60.shape
    wp, bp, cp, bc0, hc, bs0, hs = (params[band_index, k] for k in range(7))
    model = hk.radf(60, 0, 60, wp, bp, cp, bs0, np.maximum(hs, 1e-6), bc0, hc)
    ratios = []
    for li in range(5, pgrid.lines, 10):
        j = int((90 - (pgrid.lat0 - li * pgrid.dlat)) / 180 * h)
        for si in range(0, pgrid.samples, 10):
            lon = ((pgrid.lon0 + si * pgrid.dlon + 180) % 360) - 180
            i = int((lon + 180) / 360 * w)
            blk = np.asarray(a60[j - 20:j + 20, i - 20:i + 20])
            if (blk > 0).all():
                ratios.append(float(blk.mean() / model[li, si]))
    r = np.array(ratios)
    return {"median": float(np.median(r)), "p5": float(np.percentile(r, 5)), "p95": float(np.percentile(r, 95)),
            "cells": int(r.size)}


def surge_sensitivity(params: np.ndarray, band_index: int) -> dict:
    """How much the normal-albedo pattern would change if the fitted opposition surge were included at g = 0:
    percentiles of [RADF(0,0,0) with surge / RADF(0,0,0) without], normalized to its median."""
    wp, bp, cp, bc0, hc, bs0, hs = (params[band_index, k] for k in range(7))
    hs = np.maximum(hs, 1e-6)
    q = hk.radf(0, 0, 0, wp, bp, cp, bs0, hs, bc0, hc) / hk.radf(0, 0, 0, wp, bp, cp, 0 * bs0, hs, bc0, hc)
    q = q / np.median(q)
    return {"p1": float(np.percentile(q, 1)), "p99": float(np.percentile(q, 99)), "relStd": float(np.std(q))}


def normal_factor(params: np.ndarray, pgrid: sg.EquirectGrid, band_index: int, level: int,
                  rows: slice) -> tuple[np.ndarray, np.ndarray]:
    """RADF(0,0,0; B_S0 = 0) / RADF(60,0,60) per 1° cell, bilinear to the texel centres of `rows` at `level`.
    Returns (factor (nrows, W), weight)."""
    w, b, c, bc0, hc, bs0, hs = (params[band_index, k] for k in range(7))
    hs = np.maximum(hs, 1e-6)  # h_s = 0 in some cells (fit bound): the surge is then zero at g = 60° either way
    f = hk.radf(0, 0, 0, w, b, c, 0 * bs0, hs, bc0, hc) / hk.radf(60, 0, 60, w, b, c, bs0, hs, bc0, hc)
    lat = st.lat_centers(level)[rows]
    lon = st.lon_centers(level)
    L, S = np.meshgrid((pgrid.lat0 - lat) / pgrid.dlat, ((lon - pgrid.lon0) % 360.0) / pgrid.dlon, indexing="ij")
    return sg.bilinear(f.astype(np.float64), np.ones(f.shape, bool), L, S, periodic_samples=True)


def emp_cap(band: int, pole: str, work: Path) -> tuple[np.ndarray, slice, dict]:
    """Polar empirically-normalized mosaic sampled at level-5 texel centres poleward of 60° (0 = unknown)."""
    h, wdt = st.level_shape(ALBEDO_LEVEL)
    lat = st.lat_centers(ALBEDO_LEVEL)
    rows = slice(0, int(np.searchsorted(-lat, -60.0))) if pole == "N" else slice(int(np.searchsorted(-lat, 60.0)), h)
    nrows = rows.stop - rows.start
    arr_p, meta_p = work / f"emp_{band}_{pole}.f32", work / f"emp_{band}_{pole}.json"
    if arr_p.exists() and meta_p.exists():
        return _memmap(arr_p, (nrows, wdt)), rows, json.loads(meta_p.read_text(encoding="utf-8"))
    path, rec = fetch_transient(emp_url(band, pole), SUBDIR)
    lab = pds.read_attached_label(path)
    data = np.asarray(pds.read_band(path, lab), np.float32)
    valid = ~pds.isis_special_mask(data) & (data > 0)
    blk, frac = sg.block_mean(data, valid, EMP_BLOCK)
    del data, valid
    discard(path)
    out = _memmap(arr_p, (nrows, wdt), "w+")
    lon = st.lon_centers(ALBEDO_LEVEL)
    for j0 in range(0, nrows, 128):
        la = lat[rows][j0:j0 + 128]
        LA, LO = np.meshgrid(la, lon, indexing="ij")
        line, samp = pds.polar_stereo_pixel(lab, LA, LO)
        # block-mean pixel k covers source pixels k*B .. k*B+B-1, centre at k*B + (B-1)/2
        v, wgt = sg.bilinear(blk, frac >= 0.5, (line - (EMP_BLOCK - 1) / 2) / EMP_BLOCK,
                             (samp - (EMP_BLOCK - 1) / 2) / EMP_BLOCK)
        out[j0:j0 + 128] = np.where(wgt >= 0.5, v, 0)
    out.flush()
    meta = {"files": {path.name: rec}, "validFraction": float((np.asarray(out) > 0).mean())}
    meta_p.write_text(json.dumps(meta), encoding="utf-8", newline="\n")
    print(f"[surfaces] Moon EMP {band} nm {pole}: {meta['validFraction']:.4f} of cap texels known")
    return _memmap(arr_p, (nrows, wdt)), rows, meta


# ---------------------------------------------------------------------------------------------- layers


def build_albedo(ctx: BuildContext, work: Path) -> dict:
    from .photometry import bodies, solar

    level = ALBEDO_LEVEL
    h, wdt = st.level_shape(level)
    params, pgrid, ppath = hapke_params()
    lat = st.lat_centers(level)
    in_wac = np.abs(lat) <= 70.0
    wac_rows = slice(int(np.argmax(in_wac)), int(len(lat) - np.argmax(in_wac[::-1])))

    band_paths, wac_files, emp_files, ring_stats, factor_stats = [], {}, {}, {}, {}
    model_check, surge = {}, {}
    known = np.zeros((h, wdt), bool)
    for bi, band in enumerate(BANDS):
        a60, meta = wac_band(band, work)
        wac_files.update(meta["files"])
        model_check[band] = hapke_consistency(params, pgrid, bi, a60)
        surge[band] = surge_sensitivity(params, bi)
        an_p = work / f"normal_{band}.f32"
        an = _memmap(an_p, (h, wdt), "w+")
        kb = np.zeros((h, wdt), bool)
        fvals = []
        # 1. Hapke-normalized I/F -> normal albedo (|lat| <= 70)
        for j0 in range(wac_rows.start, wac_rows.stop, 512):
            rs = slice(j0, min(j0 + 512, wac_rows.stop))
            f, fw = normal_factor(params, pgrid, bi, level, rs)
            a = np.asarray(a60[rs])
            k = (a > 0) & (fw > 0)
            an[rs] = np.where(k, a * f, 0)
            kb[rs] = k
            fvals.append(f[k][::97])
        fv = np.concatenate(fvals)
        factor_stats[band] = {"median": float(np.median(fv)), "p1": float(np.percentile(fv, 1)),
                              "p99": float(np.percentile(fv, 99)), "relStd": float(np.std(fv) / np.mean(fv))}
        # 2. polar caps from the empirically normalized mosaics, tied to (1) in the ring
        ring_stats[band] = {}
        for pole in "NS":
            cap, rows, emeta = emp_cap(band, pole, work)
            emp_files.update(emeta["files"])
            la = np.abs(lat[rows])
            ring = (la >= RING[0]) & (la <= RING[1])
            c_arr = np.asarray(cap)
            a_rows = np.asarray(an[rows])
            both = (c_arr > 0) & (a_rows > 0) & ring[:, None]
            ratio = a_rows[both] / c_arr[both]
            kfac = float(np.median(ratio))
            q25, q75 = np.percentile(ratio, [25, 75])
            la_both = np.broadcast_to(la[:, None], both.shape)[both]
            by_lat = {f"{lo:g}-{lo + 2.5:g}": float(np.median(ratio[(la_both >= lo) & (la_both < lo + 2.5)]))
                      for lo in (62.0, 64.5, 67.0)}
            fill = (a_rows <= 0) & (c_arr > 0)
            a_rows = np.where(fill, kfac * c_arr, a_rows)
            an[rows] = a_rows
            kb[rows] |= fill
            ring_stats[band][pole] = {"scale": kfac, "iqrOverMedian": float((q75 - q25) / kfac),
                                      "n": int(both.sum()), "medianByLatitude": by_lat,
                                      "texelsFromPolarMosaic": int(fill.sum())}
        an.flush()
        known |= kb
        band_paths.append(an_p)
        del an
        print(f"[surfaces] Moon {band} nm: normal/60° factor median {factor_stats[band]['median']:.3f} "
              f"(rel. std {factor_stats[band]['relStd']:.3f}); polar scale N {ring_stats[band]['N']['scale']:.3f} "
              f"S {ring_stats[band]['S']['scale']:.3f}")

    # every band must know the same texels (a texel is known only where all 7 bands are)
    bands = [_memmap(p, (h, wdt)) for p in band_paths]
    for b in bands:
        for j0 in range(0, h, 1024):
            known[j0:j0 + 1024] &= np.asarray(b[j0:j0 + 1024]) > 0
    means = sl.normalize_bands(bands, known, level)

    # colour weights from the Moon's disk spectrum
    body = bodies.build_body(NAIF)
    e = solar.spectrum().grid
    W = sc.channel_weights(BANDS, body.p_grid, e)
    diag = sc.diagnostics(BANDS, body.p_grid, e)

    class Ratio:
        def __init__(self, arr, m):
            self.arr, self.m = arr, m

        def __getitem__(self, s):
            return np.asarray(self.arr[s], np.float32) / np.float32(self.m)

    ratios = [Ratio(b, m) for b, m in zip(bands, means)]
    top = _memmap(work / "xyzs.f32", (h, wdt, 4), "w+")
    sl.xyzs_from_ratios(ratios, W, known, top)
    top.flush()
    rng = np.random.default_rng(301)
    jj, ii = np.nonzero(known[::64, ::64])
    pick = rng.choice(jj.size, size=min(4000, jj.size), replace=False)
    sample = np.array([[r[jj[p] * 64, ii[p] * 64] for r in ratios] for p in pick])
    spread = sc.interpolation_spread(sample, BANDS, body.p_grid, e)
    check = st.disk_mean(top, known, level)

    # sources
    led = {n: e for n, e in wac_files.items()}
    sl.register_dataset(
        ctx, SRC_WAC, "LROC WAC Hapke-normalized 7-band mosaic of the Moon (WAC_HAPKE, 400 m/px, 70°S-70°N)",
        "Sato, H., Robinson, M. S., Lawrence, S. J., Denevi, B. W., Hapke, B., Jolliff, B. L. & Hiesinger, H. (2017). "
        "Lunar mare TiO2 abundances estimated from UV/Vis reflectance. Icarus 296, 216-238. "
        "doi:10.1016/j.icarus.2017.06.013. Data: LRO LROC RDR archive LROLRC_2001 (PDS), MDR/WAC_HAPKE.",
        BASE + "MDR/WAC_HAPKE/", led, version="WAC_HAPKE v1.2 (PDS3 PRODUCT_VERSION_ID)", license="public domain (NASA)",
        notes="Median of ~40 months of WAC observations (2010-01-21 to 2013-05-01), photometrically normalized to "
              "i = g = 60°, e = 0 with the per-1° Hapke parameter maps and the GLD100 terrain; bands 321, 360, 415, "
              "566, 604, 643, 689 nm; float32 I/F, 8 tiles per band. The 3BAND TIFs of the same product are false "
              "colour and are not used.")
    sl.register_dataset(
        ctx, SRC_PARAM, "LROC WAC Hapke photometric parameter maps of the Moon (1° × 1°, 7 bands)",
        "Sato, H., Robinson, M. S., Hapke, B., Denevi, B. W. & Boyd, A. K. (2014). Resolved Hapke parameter maps of "
        "the Moon. JGR Planets 119, 1775-1805. doi:10.1002/2013JE004580. Model: Hapke, B. (2012), Theory of "
        "Reflectance and Emittance Spectroscopy, 2nd ed., Cambridge University Press, doi:10.1017/CBO9781139025683.",
        PARAM_URL, {ppath.name: record(ppath)}, version="v1.1 (PDS3 PRODUCT_VERSION_ID)",
        license="public domain (NASA)",
        notes="63 bands = (w, b, c, Bc0, hc, Bs0, hs, theta, phi) x 7 WAC bands, 70°S-70°N. Bc0 = 0, hc = 1, "
              "theta = 23.657° are constant; phi is 0 in the file although the README says 'fixed at 1.0' (either "
              "way the porosity factor K is 1). The PDS4 label's array offset (1440) disagrees with the attached "
              "PDS3 label (^IMAGE = record 6 of 1440 bytes = 7200) and with the file size; the PDS3 value is used.")
    sl.register_dataset(
        ctx, SRC_EMP, "LROC WAC empirically normalized 7-band polar mosaics (WAC_EMP, 152 px/deg, 60-90°N/S)",
        "Boyd, A. K., Robinson, M. S. & Sato, H. (2012). Lunar Reconnaissance Orbiter Wide Angle Camera photometry: "
        "an empirical solution. 43rd Lunar and Planetary Science Conference, abstract 2795. Data: LRO LROC RDR "
        "archive LROLRC_2001 (PDS), MDR/WAC_EMP.",
        BASE + "MDR/WAC_EMP/", emp_files, version="WAC_EMP v1.3 (polar tiles, PDS3 PRODUCT_VERSION_ID)",
        license="public domain (NASA)",
        notes="Median of 137,400 WAC images (2010-01-21 to 2013-01-31) normalized to i = g = 30°, e = 0 with an "
              "empirical photometric function and GLD100 topography; polar stereographic, 200 m/px.")
    src_color = list(dict.fromkeys([SRC_WAC, SRC_PARAM, SRC_EMP, *body.entry["geometricAlbedoXYZS"]["sources"]]))

    rs = {b: {p: round(ring_stats[b][p]["scale"], 4) for p in "NS"} for b in BANDS}
    regions = [
        sl.Region(-70, 70, -180, 180,
                  sl.Provenance("derived", [SRC_WAC, SRC_PARAM],
                                "WAC Hapke-normalized I/F (i = g = 60°, e = 0), converted to normal albedo without the "
                                "opposition surge by the ratio RADF(0,0,0; B_S0=0)/RADF(60,0,60) of the published "
                                "per-1°-cell Hapke model (bilinear between cell centres).",
                                "conversion factor varies by "
                                + ", ".join(f"{factor_stats[b]['relStd'] * 100:.1f} %" for b in (415, 566, 643))
                                + " rms (415/566/643 nm) across the Moon"),
                  note="Level-5 texels average the 400 m/px mosaic (box filter)."),
        *[sl.Region(70 if pole == "N" else -90, 90 if pole == "N" else -70, -180, 180,
                    sl.Provenance("estimated", [SRC_EMP, SRC_WAC, SRC_PARAM],
                                  "WAC empirically normalized polar mosaic (i = g = 30°, e = 0), 3×3-pixel means "
                                  "sampled bilinearly, scaled per band by the median ratio to the Hapke-derived normal "
                                  f"albedo in the {RING[0]:g}-{RING[1]:g}° ring (assumed to hold poleward).",
                                  "ring ratio interquartile range / median: "
                                  + ", ".join(f"{b} nm {ring_stats[b][pole]['iqrOverMedian'] * 100:.0f} %"
                                              for b in (415, 566, 643))),
                    note="Also used for any texel between 60° and 70° that the Hapke-normalized mosaic lacks. "
                         "Permanently shadowed or never-imaged texels stay unknown.")
          for pole in "NS"],
    ]
    spec = sl.LayerSpec(
        naif=NAIF, body=NAME, layer="albedo", kind="relative-reflectance", fmt="f16", channels=list(sc.CHANNELS),
        frame={"name": "MOON_ME (DE421 mean Earth/polar axis)",
               "note": "LROC and LOLA products are in the DE421 mean-Earth frame. The app's IAU_MOON (pck00011) "
                       "differs from it by about 0.1-0.2 km on the surface, below one level-5 texel (0.67 km)."},
        sources=[SRC_WAC, SRC_PARAM, SRC_EMP, *body.entry["geometricAlbedoXYZS"]["sources"]],
        brightness=sl.Provenance(sl.worst(*(r.brightness.label for r in regions)), [SRC_WAC, SRC_PARAM, SRC_EMP],
                                 "Spatial pattern of normal albedo per band (see regions); the texel is the ratio to "
                                 "the disk average, so the absolute level comes from photometry.json."),
        color=sl.Provenance(diag.label, src_color,
                            "Per texel, band ratios ρ_b = A_b/⟨A_b⟩ at 321-689 nm are interpolated linearly in "
                            "wavelength (held at the 689 nm ratio from 689 to 830 nm, where "
                            f"{diag.above_last[0] * 100:.2f} % of X and {diag.above_last[1] * 100:.2f} % of Y of the "
                            "sunlight-weighted observer integrand lie), multiplied by the Moon's disk albedo spectrum "
                            "and integrated against sunlight and the CIE observers. " + diag.reason,
                            "linear vs monotone-cubic interpolation of the band ratios: 99th percentile |Δ| "
                            + ", ".join(f"{k} {v['p99'] * 100:.2f} %" for k, v in spread.items())),
        regions=regions,
        epoch={"observed": "2010-01-21/2013-05-01", "changes": "negligible (geologic time scales)"},
        normalization={"weighting": "cos²(lat): projected area at zero phase, observer in the equatorial plane, "
                                    "averaged over rotation (docs/architecture.md §4.4); known texels only",
                       "bandNormalAlbedoDiskMean": {str(b): round(m, 6) for b, m in zip(BANDS, means)},
                       "channelWeights": {"bandsNm": list(BANDS),
                                          "W": [[round(float(x), 6) for x in row] for row in W]},
                       "texelDiskMeanCheck": [round(float(x), 5) for x in check]},
        diagnostics={"color": diag.to_json(), "interpolationSpread": spread,
                     "normalOver60Factor": {str(b): v for b, v in factor_stats.items()},
                     "hapkeModelCheck": {"what": "mosaic I/F / our Hapke RADF(60,0,60) per 1° cell (should be ~1)",
                                         **{str(b): v for b, v in model_check.items()}},
                     "surgeSensitivity": {"what": "texel change if the fitted surge were kept at g = 0 "
                                                  "(RADF(0,0,0) with/without B_S0, per 1° cell, median-normalized)",
                                          **{str(b): v for b, v in surge.items()}},
                     "polarScale": rs, "polarRing": {str(b): v for b, v in ring_stats.items()}},
        notes=["The Hapke-normalized mosaic is photometrically normalized, so the map carries no shading from the "
               "Sun at the time of imaging; topographic shading comes from the height layer.",
               "Level 5 is the finest level; the source (400 m/px) is about 1.7x finer."],
    )
    header = sl.write_layer(ctx, spec, top, known, level)
    return header


def build_height(ctx: BuildContext, work: Path) -> dict:
    lbl = fetch(LDEM + "ldem_64.lbl", SUBDIR)
    img = fetch(LDEM + "ldem_64.img", SUBDIR)
    lab = pds.parse_odl(lbl.read_text(encoding="latin-1"))
    grid = pds.equirect_grid(lab)
    imgd = pds.find(lab, "IMAGE")
    scale = pds.num(imgd, "SCALING_FACTOR")
    data = np.memmap(img, pds.image_dtype(lab), mode="r", shape=(grid.lines, grid.samples))
    level = HEIGHT_LEVEL
    shape = st.level_shape(level)
    num = np.zeros(shape, np.float32)
    den = np.zeros(shape, np.float32)
    sg.accumulate_chunked(num, den, data, grid, level, lambda b: np.ones(b.shape, bool),
                          lambda b: b.astype(np.float32) * np.float32(scale))
    top, known = sg.finish(num, den, 0.5)
    sl.register_dataset(
        ctx, SRC_LOLA, "LRO LOLA gridded lunar topography LDEM_64 (64 px/deg, V3.1)",
        "Smith, D. E. et al. (2010). The Lunar Orbiter Laser Altimeter investigation on the Lunar Reconnaissance "
        "Orbiter mission. Space Science Reviews 150, 209-241. doi:10.1007/s11214-009-9512-y. Data: Smith, D. E., "
        "Neumann, G. A. et al., LRO-L-LOLA-4-GDR-V1.0, NASA PDS Geosciences Node (product LDEM_64, V3.1, 2019).",
        LDEM + "ldem_64.img", {img.name: record(img), lbl.name: record(lbl)}, version="LDEM_64 V3.1 (2019-03-15)",
        license="public domain (NASA)",
        notes="int16 heights × 0.5 m relative to a 1737.4 km sphere, pixel registered, MEAN EARTH/POLAR AXIS OF DE421. "
              "LOLA data to mission phase LRO_ES_52; between laser tracks the grid is interpolated by the producer "
              "(GMT 'surface', tension 0.5), so at the equator (track spacing ~1-2 km) sub-kilometre relief is partly "
              "interpolated.")
    hmin, hmax = float(top[known].min()), float(top[known].max())
    spec = sl.LayerSpec(
        naif=NAIF, body=NAME, layer="height", kind="height", fmt="f32", channels=["height"],
        frame={"name": "MOON_ME (DE421 mean Earth/polar axis)", "referenceRadiusKm": 1737.4,
               "note": "Heights are radius − 1737.4 km; 1737.4 km is also the pck00011 radius of the Moon."},
        sources=[SRC_LOLA],
        brightness=sl.Provenance("measured", [SRC_LOLA],
                                 "LOLA gridded radius minus 1737.4 km, texel = mean over the texel (box filter from "
                                 "64 px/deg)."),
        units="m",
        regions=[sl.Region(-90, 90, -180, 180, sl.Provenance("measured", [SRC_LOLA], "LOLA LDEM_64"))],
        epoch={"observed": "2009-07-13/2016-11-29"},
        diagnostics={"minHeightM": hmin, "maxHeightM": hmax},
        notes=[f"Level {level} (texel {180 / shape[0] * 30.3234:.2f} km at the equator) matches the LOLA cross-track "
               "spacing at low latitudes; the 64 px/deg grid is finer only by interpolation there."],
    )
    return sl.write_layer(ctx, spec, top, known, level)


def build_hapke(ctx: BuildContext) -> dict:
    params, pgrid, ppath = hapke_params()
    level = 0
    h, wdt = st.level_shape(level)
    lat, lon = st.lat_centers(level), st.lon_centers(level)
    li = np.floor((pgrid.lat0 + pgrid.dlat / 2 - lat) / pgrid.dlat).astype(int)
    si = (np.floor(((lon - (pgrid.lon0 - pgrid.dlon / 2)) % 360.0) / pgrid.dlon).astype(int)) % pgrid.samples
    rows_ok = (li >= 0) & (li < pgrid.lines)
    keep = [0, 1, 2, 5, 6]  # w, b, c, Bs0, hs (the others are constants)
    names = [f"{PARAM_NAMES[k]}@{band}nm" for band in BANDS for k in keep]
    top = np.zeros((h, wdt, len(names)), np.float32)
    lic = np.clip(li, 0, pgrid.lines - 1)
    for bi in range(7):
        for kk, k in enumerate(keep):
            top[:, :, bi * len(keep) + kk] = params[bi, k][lic][:, si]
    known = np.repeat(rows_ok[:, None], wdt, axis=1)
    top[~known] = 0
    spec = sl.LayerSpec(
        naif=NAIF, body=NAME, layer="hapke", kind="photometric-parameters", fmt="f16", channels=names,
        frame={"name": "MOON_ME (DE421 mean Earth/polar axis)"},
        sources=[SRC_PARAM],
        brightness=sl.Provenance("measured", [SRC_PARAM],
                                 "Published Hapke parameters of each 1° × 1° cell (nearest cell to each texel centre; "
                                 "no interpolation). 70°S-70°N; poleward unknown."),
        constants={"Bc0": 0.0, "hc": 1.0, "thetaBarDeg": 23.657, "porosityK": 1.0,
                   "model": "Hapke 2012 as in Sato et al. 2014: r = K w/(4π) μ0e/(μ0e+μe) [p(g)(1+Bs0 Bs(g)) + "
                            "H(μ0e/K)H(μe/K) − 1][1 + Bc0 Bc(g)] S(i,e,ψ); double Henyey-Greenstein p(g) with (b, c); "
                            "Bs(g) = 1/(1+tan(g/2)/hs); H from Hapke (2002); roughness S of Hapke (1984). "
                            "I/F = π r. Implementation: pipeline/src/pipeline/surf_hapke.py.",
                   "nativeGridDeg": 1.0, "fitBoundsHit": "hs = 0 or 0.2 and c = 1.1994 occur in some cells"},
        epoch={"observed": "2010-02/2011-10"},
        notes=["float16 storage: relative precision 5e-4."],
    )
    return sl.write_layer(ctx, spec, top, known, level)


def build(ctx: BuildContext, work: Path) -> list[dict]:
    work.mkdir(parents=True, exist_ok=True)
    return [build_albedo(ctx, work), build_height(ctx, work), build_hapke(ctx)]
