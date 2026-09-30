"""Stage `deepstars`: the deep star tiers, Gaia sources with G_LIMIT (10) <= G < DEEP_G_MAX (14).

Products (docs/architecture.md §6):
* stars/deep.json: header (same 48-byte record as stars/bright.bin, TiledBinaryTableHeader) + tile index;
* stars/deep-o3-NNN.bin: one file per HEALPix order-3 NESTED (ICRS) pixel, records sorted by Y, brightest first.

Tier split: stars/bright holds every Gaia source with G < 10 (plus Hipparcos/Tycho stars Gaia lacks, and the Gaia
counterparts of Hipparcos stars with V < 10); the deep tier holds every other Gaia source with 10 <= G < 14. A deep
source is dropped when bright already has it (same source_id), or when it lies within DEDUP_RADIUS of a bright
record that does not come from Gaia and has a Y within DEDUP_DMAG magnitudes (the same star from another catalogue).

Per-record provenance works exactly as in the bright tier (routes in the header):
* position: Gaia 5/6-parameter astrometry propagated to the epoch (derived); 2-parameter solutions with a Tycho-2
  proper motion (derived) or left at J2016.0 (estimated);
* light: the star's XP spectrum through the CIE functions (derived) unless blended; otherwise the G, BP-RP
  relation fitted on this tier's XP stars (estimated); G alone with the population median (estimated).
"""

from __future__ import annotations

import json
import time

import numpy as np

from .. import cie
from .. import sky_healpix as hp
from .. import stars_astrometry as sa
from .. import stars_deep as sd
from .. import stars_format as sf
from .. import stars_gaia as sg
from .. import stars_light as sl
from ..download import record
from ..output import write_bin, write_json
from ..paths import CACHE, OUT, RAW
from ..schema import LABEL_ORDER, BuildContext, SourceRecord
from . import stars as st

DEPENDS = ("stars",)

DEEP_G_MAX = 14.0
TILE_ORDER = 3
DEDUP_RADIUS = 2.0      # arcsec
DEDUP_DMAG = 1.5        # |m_Y(deep) - m_Y(bright)|
SRC_DEEP = f"gaia-{sg.REL.key}-deep"
SRC_XP_ALL = f"gaia-{sg.REL.key}-xp-sampled-all"
SRC_TP = f"gaia-{sg.REL.key}-tycho2-pm"
#: prefix-count thresholds for progressive loading: Y of a G = 11, 12, 13 star at the tier's median colour
PREFIX_G = (11.0, 12.0, 13.0)


def log(msg: str) -> None:
    print(f"  [deepstars] {msg}", flush=True)


def load_deep(paths) -> dict[str, np.ndarray]:
    st._import_astropy()
    from astropy.io import fits
    cols = {c: [] for c in sg.DEEP_COLUMNS}
    for p in paths:
        with fits.open(p, memmap=False) as h:
            d = h[1].data
            for c in cols:
                a = np.asarray(d[c])
                cols[c].append(a.astype(a.dtype.newbyteorder("=")))   # FITS is big-endian
    out = {c: np.concatenate(v) for c, v in cols.items()}
    for c in ("phot_g_mean_mag", "phot_bp_mean_mag", "phot_rp_mean_mag"):
        out[c] = out[c].astype(np.float64)
    return out


def run(ctx: BuildContext) -> None:
    t0 = time.time()
    epoch_et = 0.5 * (ctx.start_et + ctx.end_et)
    epoch = sa.et_to_jyear(epoch_et)
    bh_path = OUT / "stars" / "bright.json"
    if not bh_path.exists():
        raise RuntimeError("stars/bright.json missing: run the `stars` stage first")
    bh, bright = sf.read_table(bh_path)
    if abs(bh["epochEt"] - epoch_et) > 86400.0:
        raise RuntimeError("stars/bright was built for another window: rebuild `stars` first")

    paths = sg.fetch_gaia_deep(st.G_LIMIT, DEEP_G_MAX, log=log, workers=ctx.param("gaia.tapWorkers"))
    g = load_deep(paths)
    n0 = g["source_id"].size
    log(f"{sg.REL.label} sources {st.G_LIMIT} <= G < {DEEP_G_MAX}: {n0}")
    diag: dict = {"archiveRows": int(n0)}

    # ------------------------------------------------------------------------------------ positions at the epoch
    sid = g["source_id"]
    has_pm = np.isfinite(g["pmra"]) & np.isfinite(g["pmdec"])
    u = np.empty((n0, 3))
    pos_route = np.full(n0, -1, np.int16)
    u[has_pm] = sa.propagate(g["ra"][has_pm], g["dec"][has_pm], g["pmra"][has_pm], g["pmdec"][has_pm],
                             st.GAIA_EPOCH, epoch, g["parallax"][has_pm], None)
    pos_route[has_pm] = 0
    tp_path = sg.fetch_tycho_pm_for_2p(DEEP_G_MAX)
    tp = st.load_table(tp_path)
    tsid = np.asarray(tp["source_id"], np.int64)
    o = np.argsort(tsid)
    tsid_s = tsid[o]
    j = np.clip(np.searchsorted(tsid_s, sid), 0, max(tsid_s.size - 1, 0))
    t_pmra = np.asarray(tp["pm_ra"], float)
    t_pmde = np.asarray(tp["pm_de"], float)
    with_t = (~has_pm) & (tsid_s[j] == sid)
    with_t[with_t] = np.isfinite(t_pmra[o[j[with_t]]]) & np.isfinite(t_pmde[o[j[with_t]]])
    tj = o[j[with_t]]
    u[with_t] = sa.propagate(g["ra"][with_t], g["dec"][with_t], t_pmra[tj], t_pmde[tj], st.GAIA_EPOCH, epoch)
    pos_route[with_t] = 1
    rest = pos_route < 0
    u[rest] = sa.radec_to_unit(g["ra"][rest], g["dec"][rest])
    pos_route[rest] = 2
    diag["posRoutes"] = {str(k): int((pos_route == k).sum()) for k in range(3)}

    # ------------------------------------------------------------------------------------ XP reductions
    # the deep sources with XP, plus the bright-tier stars lit by their XP spectrum (the sky stage needs their band
    # means; with stars.xpSource=archive they are reduced from the stars stage's raw responses, no download)
    b_xp_routes = [i for i, r in enumerate(bh["routes"]["light"]) if "XP externally calibrated" in r["method"]]
    b_xp = sf.gaia_id(bright["catId"])[(bright["src"] == bh["sourceTable"].index(st.SRC_GAIA))
                                       & np.isin(bright["lightRoute"], b_xp_routes)]
    xsid, xred, xp_ledger = sd.deep_xp(np.concatenate([sid[g["has_xp_sampled"].astype(bool)], b_xp]),
                                       source=ctx.param("stars.xpSource"), log=log,
                                       workers=ctx.param("gaia.xpWorkers"))
    k = np.clip(np.searchsorted(xsid, sid), 0, xsid.size - 1)
    has_xp = xsid[k] == sid
    red = np.full((n0, xred.shape[1]), np.nan, np.float64)
    red[has_xp] = xred[k[has_xp]]
    del xred
    diag["hasXpFlagButMissing"] = int((g["has_xp_sampled"].astype(bool) & ~has_xp).sum())
    diag["xpFound"] = int(has_xp.sum())

    # ------------------------------------------------------------------------------------ blends (J2016 positions)
    from scipy.spatial import cKDTree
    bgid = sf.gaia_id(bright["catId"])[bright["src"] == bh["sourceTable"].index(st.SRC_GAIA)]
    u16 = sa.radec_to_unit(g["ra"], g["dec"])
    tree = cKDTree(u16)
    pairs = tree.query_pairs(2.0 * np.sin(np.radians(st.XP_BLEND_RADIUS / 3600.0) / 2.0), output_type="ndarray")
    gm = g["phot_g_mean_mag"]
    blended = np.zeros(n0, bool)
    if pairs.size:
        a_, b_ = pairs[:, 0], pairs[:, 1]
        blended[a_[gm[b_] < gm[a_] + st.XP_BLEND_DMAG]] = True
        blended[b_[gm[a_] < gm[b_] + st.XP_BLEND_DMAG]] = True
    del tree, u16
    # bright-tier stars (all brighter than any deep source) within 2" at the epoch blend deep sources too
    bu = bright["dir"].astype(np.float64)
    bY = bright["xyzs"][:, 1].astype(np.float64)
    tree_e = cKDTree(u)
    near_b = tree_e.query_ball_point(bu, 2.0 * np.sin(np.radians(st.XP_BLEND_RADIUS / 3600.0) / 2.0))
    for lst in near_b:
        if lst:
            blended[np.asarray(lst)] = True
    diag["blended"] = int(blended.sum())

    # ------------------------------------------------------------------------------------ light
    xyzs = np.full((n0, 4), np.nan)
    light_route = np.full(n0, -1, np.int16)
    xp_ok = has_xp & np.isfinite(red[:, :4]).all(1) & (red[:, :4] > 0).all(1)
    flags = np.zeros(n0, np.uint8)
    flags[has_xp & ~xp_ok] |= sf.FLAG_XP_REJECTED
    flags[blended] |= sf.FLAG_XP_BLENDED
    flags[~has_pm] |= sf.FLAG_POS_2016_NO_PM
    use = xp_ok & ~blended
    xyzs[use] = red[use, :4]
    light_route[use] = 0
    bprp = g["phot_bp_mean_mag"] - g["phot_rp_mean_mag"]
    rel = sl.fit_relation(f"{sg.REL.label} G, BP-RP (deep tier)", gm[use], bprp[use], xyzs[use],
                          per_bin=4000, max_width=0.05)
    todo = (light_route < 0) & np.isfinite(bprp) & np.isfinite(gm)
    xyzs[todo], extrap = rel.predict(gm[todo], bprp[todo])
    light_route[todo] = 1
    diag["relationColourExtrapolated"] = int(extrap.sum())
    rel_m = sl.fit_relation(f"{sg.REL.label} G alone (deep tier)", gm[use], np.zeros(use.sum()), xyzs[use],
                            per_bin=10 ** 9, max_width=1.0)
    todo = (light_route < 0) & np.isfinite(gm)
    xyzs[todo] = rel_m.predict(gm[todo], np.zeros(todo.sum()))[0]
    light_route[todo] = 2
    diag["lightRoutes"] = {str(k): int((light_route == k).sum()) for k in range(-1, 3)}
    # calibration sample for the sky stage (band relations for the faint-star sums): XP-route stars, <= 1e6
    rng = np.random.default_rng(12345)
    cal = np.nonzero(use & np.isfinite(bprp))[0]
    cal = np.sort(rng.choice(cal, size=min(cal.size, 1_000_000), replace=False))
    (CACHE / "stars").mkdir(parents=True, exist_ok=True)
    np.savez(CACHE / "stars" / "deep_calib.npz", source_id=sid[cal], g=gm[cal], bp=g["phot_bp_mean_mag"][cal],
             rp=g["phot_rp_mean_mag"][cal], red=red[cal].astype(np.float32), columns=np.array(sd.XP_COLUMNS))
    diag["relation"] = rel.summary()
    diag["relationG"] = rel_m.summary()

    # ------------------------------------------------------------------------------------ de-duplicate vs bright
    keep = ~np.isin(sid, bgid)
    diag["droppedSameSourceId"] = int((~keep).sum())
    nong = bright["src"] != bh["sourceTable"].index(st.SRC_GAIA)
    r_d = 2.0 * np.sin(np.radians(DEDUP_RADIUS / 3600.0) / 2.0)
    dropped_pos = []
    for bi in np.nonzero(nong)[0]:
        for di in tree_e.query_ball_point(bu[bi], r_d):
            if keep[di] and np.isfinite(xyzs[di, 1]) and bY[bi] > 0 and \
                    abs(2.5 * np.log10(bY[bi] / xyzs[di, 1])) < DEDUP_DMAG:
                keep[di] = False
                dropped_pos.append(int(sid[di]))
    del tree_e
    diag["droppedNearNonGaiaBright"] = len(dropped_pos)
    log(f"dropped {diag['droppedSameSourceId']} (in bright by source_id) + {len(dropped_pos)} (same star as a "
        f"bright Hipparcos/Tycho record)")

    # ------------------------------------------------------------------------------------ records, tiles
    idx = np.nonzero(keep)[0]
    n = idx.size
    lab = {k: sf.label_index(k) for k in ("derived", "estimated", "unknown")}
    POS = [("derived", [SRC_DEEP], f"{sg.REL.label} 5/6-parameter astrometry (ref. epoch J2016.0) propagated to "
            "the epoch by rigorous linear space motion (ESA 1997, SP-1200 Vol. 1 Sect. 1.5.5); radial velocity not "
            "used (perspective acceleration < 0.1 mas over the window for these stars)."),
           ("derived", [SRC_DEEP, SRC_TP], f"{sg.REL.label} 2-parameter solution (position at J2016.0) propagated "
            "with the star's Tycho-2 proper motion (Gaia best neighbour)."),
           ("estimated", [SRC_DEEP], f"{sg.REL.label} 2-parameter solution: position measured at J2016.0, no proper "
            "motion known, not propagated (assumes zero proper motion; typical |pm| ~ 5-10 mas/yr at G 10-14).")]
    cie_srcs = cie.register_sources(ctx)
    note_rel = ("XYZS = 10^(-0.4 G) k(BP-RP), k = median of XYZS 10^(0.4 G) over this tier's XP-route stars in "
                "adaptive colour bins (%d bins, per-bin scatter %.3f-%.3f mag in Y)" % (
                    rel.centers.size, float(np.min(rel.scatter_mag)), float(np.max(rel.scatter_mag))))
    LIGHT = [("derived", [SRC_XP_ALL, *cie_srcs],
              f"{sg.REL.label} XP externally calibrated sampled mean spectrum (336-1020 nm, 2 nm), vacuum wavelengths "
              "used as-is, integrated against the CIE 1931 2° and 1951 scotopic functions (cie.resample + cie.xyzs "
              "as one linear operator), all samples in 360-830 nm present."),
             ("estimated", [SRC_DEEP, SRC_XP_ALL, *cie_srcs], f"{sg.REL.label} G and BP-RP: " + note_rel),
             ("estimated", [SRC_DEEP, SRC_XP_ALL, *cie_srcs], f"{sg.REL.label} G alone (no BP/RP): XYZS = "
              "10^(-0.4 G) k, k = median over this tier's XP-route stars.")]
    rec = np.zeros(n, dtype=sf.dtype())
    rec["dir"] = u[idx].astype(np.float32)
    rec["xyzs"] = xyzs[idx].astype(np.float32)
    rec["labelPos"] = np.array([sf.label_index(POS[r][0]) for r in range(3)], np.uint8)[pos_route[idx]]
    lr = light_route[idx]
    ll = np.array([sf.label_index(LIGHT[r][0]) for r in range(3)] + [lab["unknown"]], np.uint8)
    rec["labelFlux"] = ll[np.where(lr < 0, 3, lr)]
    rec["labelColor"] = rec["labelFlux"]
    rec["src"] = 0
    rec["posRoute"] = pos_route[idx].astype(np.uint8)
    rec["lightRoute"] = np.where(lr < 0, 255, lr).astype(np.uint8)
    rec["flags"] = flags[idx]
    rec["catId"] = sf.split_id(sid[idx])
    rec["hip"] = 0
    tile = (sid[idx] >> (35 + 2 * (12 - TILE_ORDER))).astype(np.int64)
    Y = xyzs[idx, 1]
    order = np.lexsort((-np.nan_to_num(Y, nan=-1.0), tile))
    rec, tile, Y = rec[order], tile[order], Y[order]
    c_med = np.array([float(np.median(bprp[use]))])
    y_thr = [float(rel.predict(np.array([gg]), c_med)[0][0, 1]) for gg in PREFIX_G]
    tiles = []
    starts = np.searchsorted(tile, np.arange(hp.npix(TILE_ORDER) + 1))
    total_bytes = 0
    for p in range(hp.npix(TILE_ORDER)):
        a, b = starts[p], starts[p + 1]
        name = f"deep-o{TILE_ORDER}-{p:03d}.bin"
        write_bin(ctx, f"stars/{name}", sf.encode(rec[a:b]), "deepstars")
        total_bytes += (b - a) * sf.STRIDE
        d = rec["dir"][a:b].astype(np.float64)
        c = hp.pix2vec(TILE_ORDER, np.array([p]))[0]
        rad = float(np.degrees(np.arccos(np.clip(d @ c, -1, 1))).max()) if b > a else 0.0
        yy = Y[a:b]
        tiles.append({"pix": p, "bin": name, "count": int(b - a), "center": [round(float(x), 7) for x in c],
                      "radiusDeg": round(rad + 1e-4, 5), "yMax": float(np.nanmax(yy)) if b > a else None,
                      "yMin": float(np.nanmin(yy)) if b > a else None,
                      "prefixCounts": [int((yy >= t).sum()) for t in y_thr]})
    diag["records"] = int(n)
    diag["bytes"] = int(total_bytes)
    diag["labels"] = {"light": {LABEL_ORDER[i]: int((rec["labelFlux"] == i).sum()) for i in range(len(LABEL_ORDER))},
                      "pos": {LABEL_ORDER[i]: int((rec["labelPos"] == i).sum()) for i in range(len(LABEL_ORDER))}}

    _register_sources(ctx, paths, xp_ledger, tp_path)
    header = {
        "binPattern": f"deep-o{TILE_ORDER}-{{pix:03d}}.bin",
        "count": int(n),
        "stride": sf.STRIDE,
        "fields": sf.header_fields(),
        "labelEncoding": list(LABEL_ORDER),
        "sourceTable": [SRC_DEEP],
        "epochEt": float(epoch_et),
        "idEncoding": {SRC_DEEP: f"catId = {sg.REL.label} source_id as (lo, hi) uint32 words"},
        "flagBits": {"4": bh["flagBits"]["4"], "16": bh["flagBits"]["16"], "32": bh["flagBits"]["32"],
                     "_note": "flags 1 (variable) and 2 (multiple) are not evaluated in this tier (always 0)"},
        "routes": {"pos": [{"label": l, "sources": s, "method": m} for l, s, m in POS],
                   "light": [{"label": l, "sources": s, "method": m} for l, s, m in LIGHT]},
        "tiling": {"scheme": "HEALPix", "ordering": "NESTED", "order": TILE_ORDER, "nside": 1 << TILE_ORDER,
                   "frame": "ICRS", "assignment": "Gaia source_id >> 53 (the pixel of the J2016.0 catalogue position)",
                   "sort": "within a tile by Y, brightest first",
                   "prefixY": y_thr,
                   "prefixNote": ("tiles[i].prefixCounts[k] = number of leading records with Y >= prefixY[k], "
                                  "where prefixY is the Y of a G = %s star of median BP-RP; read that many records "
                                  "to load a tile to about that magnitude" % ", ".join(f"{x:g}" for x in PREFIX_G))},
        "tiles": tiles,
        "tier": {"name": "deep", "gaiaGMin": st.G_LIMIT, "gaiaGMax": DEEP_G_MAX, "brighterTier": "stars/bright.json"},
        "completeness": {
            "statement": (f"All {sg.REL.label} sources with {st.G_LIMIT:g} <= G < {DEEP_G_MAX:g} ({n0} in the archive) "
                          f"except {n0 - n} that are already records of stars/bright (same source_id, or the same "
                          "star from Hipparcos/Tycho-2 within %.1f\")." % DEDUP_RADIUS),
            "archiveCount": int(n0)},
        "notes": ("Same record layout as stars/bright.bin: bytes 0-27 float32 [ux, uy, uz, X, Y, Z, S] (ICRF unit "
                  "vector at epochEt; illuminance at the observer in lux and scotopic lux). Load the tiles whose "
                  "cap (center, radiusDeg) intersects the view."),
    }
    write_json(ctx, "stars/deep.json", header, "deepstars")
    (CACHE / "stars").mkdir(parents=True, exist_ok=True)
    (CACHE / "stars" / "deep_diagnostics.json").write_text(json.dumps(st._jsonable(diag), indent=1), encoding="utf-8", newline="\n")
    log(f"wrote {n} stars in {hp.npix(TILE_ORDER)} tiles ({total_bytes / 1e6:.0f} MB), {time.time() - t0:.0f} s")


def _register_sources(ctx: BuildContext, paths, xp_ledger, tp_path) -> None:
    rec0 = record(paths[0])
    q0 = paths[0].with_name(paths[0].name + ".adql").read_text(encoding="utf-8")
    ctx.add_source(SourceRecord(
        id=SRC_DEEP, title=f"{sg.REL.label} main source catalogue ({sg.REL.schema}.gaia_source), "
                           f"{st.G_LIMIT:g} <= G < {DEEP_G_MAX:g}",
        citation=sg.REL.citation + f", DOI:{sg.REL.doi}; astrometry: Lindegren L. et al. 2021, A&A 649, A2, "
                 "DOI:10.1051/0004-6361/202039709; photometry: Riello M. et al. 2021, A&A 649, A3, "
                 "DOI:10.1051/0004-6361/202039587.",
        url=sg.TAP_URL, retrieved=rec0["retrieved"], sha256=st._digest(paths), version=sg.REL.label,
        license="ESA/Gaia/DPAC, CC BY-SA 3.0 IGO",
        notes=(f"{len(paths)} synchronous TAP queries (FITS), one per HEALPix level-{sg.DEEP_LEVEL} source_id range; "
               f"first: {q0}. Files data/raw/{paths[0].parent.relative_to(RAW).as_posix()}/*.fits with .adql sidecars; per-file "
               "url/sha256 in data/raw/_downloads.json; this sha256 is over the per-file sha256s.")))
    xp_cite = ("De Angeli F. et al. 2023, A&A 674, A2, DOI:10.1051/0004-6361/202243680; Montegriffo P. et al. "
               "2023, A&A 674, A3, DOI:10.1051/0004-6361/202243880.")
    if xp_ledger.get("source") == "archive":
        ctx.add_source(SourceRecord(
            id=SRC_XP_ALL, title=f"{sg.REL.label} BP/RP externally calibrated sampled mean spectra "
                                 f"({sg.REL.schema}.xp_sampled_mean_spectrum), deep-tier and bright-tier sources",
            citation=xp_cite + " Served by the Gaia archive TAP service of ARI Heidelberg (Astronomisches "
                               "Rechen-Institut, ZAH, Universitaet Heidelberg), a Gaia DPAC partner data centre.",
            url=sg.ARI_TAP_URL, retrieved=min(f["retrieved"] for f in xp_ledger["files"].values()),
            sha256=sg.stream_ledger_digest(xp_ledger), version=sg.REL.label, license="ESA/Gaia/DPAC, CC BY-SA 3.0 IGO",
            notes=(f"Synchronous TAP queries (POST, FITS; stars_gaia.xp_archive_query: at most {sg.XP_BATCH} "
                   f"source_ids each, grouped by HEALPix level-{sg.XP_BATCH_LEVEL} pixel) for the sources that have XP "
                   f"spectra; every spectrum reduced on the fly to {', '.join(sd.XP_COLUMNS)} (stars_deep.xp_operator; "
                   f"W sha256 {xp_ledger['W_sha256'][:16]}...) and only the reductions kept, in data/cache/"
                   f"{sg.XP_REDUCED_SUBDIR}/{sd.XP_TAG}_archive ({len(xp_ledger['files'])} files; per query the POST-"
                   "body sha256, id range, response sha256 and size in its _fetched.json; bright-tier spectra are "
                   "reduced from the stars stage's raw responses). This sha256 is over the per-file sha256s. The "
                   "reductions are bit-identical to those of ESA's bulk files (stars.xpSource=bulk; "
                   "docs/reports/stars.md).")))
    else:
        ctx.add_source(SourceRecord(
            id=SRC_XP_ALL, title=f"{sg.REL.label} BP/RP externally calibrated sampled mean spectra, all sources",
            citation=xp_cite,
            url=sg.XP_BASE, retrieved=min(f["retrieved"] for f in xp_ledger["files"].values()),
            sha256=sg.stream_ledger_digest(xp_ledger), version=sg.REL.label, license="ESA/Gaia/DPAC, CC BY-SA 3.0 IGO",
            notes=(f"All {len(xp_ledger['files'])} bulk files streamed and MD5-verified against ESA's _MD5SUM.txt; "
                   f"every spectrum reduced on the fly to {', '.join(sd.XP_COLUMNS)} (stars_deep.xp_operator; W sha256 "
                   f"{xp_ledger['W_sha256'][:16]}...) and kept in data/cache/{sg.XP_REDUCED_SUBDIR}/{sd.XP_TAG}; "
                   "per-file url/md5/sha256 in its _streamed.json; this sha256 is over the per-file sha256s.")))
    r = record(tp_path)
    ctx.add_source(SourceRecord(
        id=SRC_TP, title=f"Tycho-2 proper motions of {sg.REL.label} 2-parameter sources (Gaia archive best neighbour)",
        citation="Høg E. et al. 2000, The Tycho-2 catalogue of the 2.5 million brightest stars, A&A 355, L27; "
                 "Marrese P. M. et al. 2019, Gaia DR2 cross-match with external catalogues, A&A 621, A144, "
                 "DOI:10.1051/0004-6361/201834142.",
        url=sg.TAP_URL, retrieved=r["retrieved"], sha256=r["sha256"], version=sg.REL.label,
        notes="ADQL: " + tp_path.with_name(tp_path.name + ".adql").read_text(encoding="utf-8")))
