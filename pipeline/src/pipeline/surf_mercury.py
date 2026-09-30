"""Mercury (NAIF 199): MESSENGER MDIS 8-colour global map → albedo; USGS MESSENGER DEM → height.

albedo  MDIS Map Projected Multispectral RDR (MDR) version 4 (Hash et al., PDS; calibration Denevi et al. 2018,
        SSR 214, 2): global 64 px/deg I/F photometrically normalized to i = 30°, e = 0, g = 30° (Kaasalainen-
        Shkuratov correction with global parameters), 8 WAC filters of which the six in the visible range
        (430, 480, 560, 630, 750, 830 nm) are read with byte-range requests (bands 1-6 of the 17-band cubes).
        Equatorial and mid-latitude tiles are equirectangular, the two polar tiles polar stereographic; the south
        polar gap-fill tile (2.7 km/px images) is used only where the nominal tile has no data.
        NOT used: the USGS "EnhancedColor" (principal-component stretch) and "MD3Color" (1000/750/430 nm false
        colour) products, and the monochrome basemaps (single band).
height  USGS global MESSENGER DEM v2 (Becker et al. 2016), 665 m/px, relative to a 2439.4 km sphere, converted to
        height above the pck00011 ellipsoid.
"""

from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import requests
import tifffile

from . import surf_color as sc
from . import surf_grid as sg
from . import surf_layers as sl
from . import surf_pds as pds
from . import surf_tiles as st
from .download import fetch, record
from .schema import BuildContext
from .surf_fetch import Prefetcher, discard, fetch_range

NAIF = 199
NAME = "Mercury"
SUBDIR = "surfaces/mercury"
ALBEDO_LEVEL = 4
HEIGHT_LEVEL = 3
MDR = "https://planetarydata.jpl.nasa.gov/img/data/messenger/MSGRMDS_5001/MDR/"
DEM = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mercury_Messenger_USGS_DEM_Global_665m_v2.tif"
VIS_BANDS = 6  # bands 1-6: 430, 480, 560, 630, 750, 830 nm
SRC_MDR = "mdis-mdr-8color-v4"
SRC_DEM = "usgs-mercury-dem-665m-v2"


def mdr_tiles() -> list[str]:
    """Stems of the 64 px/deg MDR tiles (highest version per quadrant), from the archive's directory listings."""
    stems = []
    for h in range(1, 16):
        html = requests.get(f"{MDR}H{h:02d}/", timeout=60).text
        names = set(re.findall(r'href="(MDIS_MDR_064PPD_(?:2700_)?H\d\d[A-Z]{2}\d)\.IMG"', html))
        best: dict[str, str] = {}
        for n in names:
            key = n[:-1]
            if key not in best or n[-1] > best[key][-1]:
                best[key] = n
        stems += sorted(best.values())
    return stems


def fetch_tile(stem: str) -> tuple[dict, Path, dict, Path]:
    h = re.search(r"_(H\d\d)", stem).group(1)
    lbl = fetch(f"{MDR}{h}/{stem}.LBL", SUBDIR)
    lab = pds.parse_odl(lbl.read_text(encoding="latin-1"))
    img = pds.find(lab, "IMAGE")
    n = int(img["LINES"]) * int(img["LINE_SAMPLES"]) * 4 * VIS_BANDS
    names = pds.find(lab, "BAND_NAME")
    if not all(f" {nm} " in f" {names[i]} " for i, nm in enumerate(["430", "480", "560", "630", "750", "830"])):
        raise ValueError(f"{stem}: unexpected band order {names[:6]}")
    path, rec = fetch_range(f"{MDR}{h}/{stem}.IMG", SUBDIR, f"{stem}.bands1-6.img", pds.image_offset(lab), n)
    return lab, path, rec, lbl


def mdr_bands(work: Path) -> tuple[list[np.ndarray], np.ndarray, dict, int]:
    """Level-4 means of MDR bands 1-6 (0 = unknown) with the files' ledger entries; cached in `work` so a rebuild
    does not download the 4 GB of band ranges again."""
    import json
    level = ALBEDO_LEVEL
    h, w = st.level_shape(level)
    meta_p = work / "mdr_bands.json"
    paths = [work / f"mdr_band{b}.f32" for b in range(VIS_BANDS)]
    if meta_p.exists() and all(p.exists() for p in paths):
        meta = json.loads(meta_p.read_text())
        bands = [np.fromfile(p, np.float32).reshape(h, w) for p in paths]
        known = np.ones((h, w), bool)
        for b in bands:
            known &= b > 0
        return bands, known, meta["files"], meta["filled"]
    work.mkdir(parents=True, exist_ok=True)
    stems = mdr_tiles()
    nominal = [s for s in stems if "_2700_" not in s]
    fill = [s for s in stems if "_2700_" in s]
    num = np.zeros((VIS_BANDS, h, w), np.float32)
    den = np.zeros((VIS_BANDS, h, w), np.float32)
    files = {}
    lat, lon = st.lat_centers(level), st.lon_centers(level)

    def add_polar(lab, cube, target_num, target_den, only_unknown=None):
        mp = pds.find(lab, "IMAGE_MAP_PROJECTION")
        north = pds.num(mp, "CENTER_LATITUDE") > 0
        lo = pds.num(mp, "MINIMUM_LATITUDE") if north else -90.0
        hi = 90.0 if north else pds.num(mp, "MAXIMUM_LATITUDE")
        rows = np.nonzero((lat >= lo) & (lat <= hi))[0]
        # 64 px/deg polar pixels are ~0.67 km, level-4 texels 1.9 km: 3×3 block means, then bilinear
        k = 3
        for b in range(VIS_BANDS):
            band = cube[b]
            valid = ~pds.isis_special_mask(band) & (band > 0)
            blk, frac = sg.block_mean(band, valid, k)
            LA, LO = np.meshgrid(lat[rows], lon, indexing="ij")
            li, si = pds.polar_stereo_pixel(lab, LA, LO)
            v, wt = sg.bilinear(blk, frac >= 0.5, (li - (k - 1) / 2) / k, (si - (k - 1) / 2) / k)
            ok = wt >= 0.5
            if only_unknown is not None:
                ok &= ~only_unknown[rows]
            target_num[b, rows] += np.where(ok, v, 0).astype(np.float32)
            target_den[b, rows] += ok.astype(np.float32)

    for stem, (lab, path, rec, lbl) in Prefetcher(nominal, fetch_tile):
        files[path.name] = rec
        files[lbl.name] = record(lbl)
        img = pds.find(lab, "IMAGE")
        cube = np.memmap(path, "<f4", mode="r", shape=(VIS_BANDS, int(img["LINES"]), int(img["LINE_SAMPLES"])))
        if "POLAR" in str(pds.find(lab, "MAP_PROJECTION_TYPE")).upper():
            add_polar(lab, cube, num, den)
        else:
            grid = pds.equirect_grid(lab)
            for b in range(VIS_BANDS):
                sg.accumulate(num[b], den[b], np.asarray(cube[b]), ~pds.isis_special_mask(cube[b]) & (cube[b] > 0),
                              grid, level)
        del cube
        discard(path)  # 4 GB of band ranges in total: keep only the ledger entry
    known_nominal = (den >= 0.5).all(axis=0)
    for stem in fill:
        lab, path, rec, lbl = fetch_tile(stem)
        files[path.name] = rec
        files[lbl.name] = record(lbl)
        img = pds.find(lab, "IMAGE")
        cube = np.memmap(path, "<f4", mode="r", shape=(VIS_BANDS, int(img["LINES"]), int(img["LINE_SAMPLES"])))
        n2, d2 = np.zeros_like(num), np.zeros_like(den)
        add_polar(lab, cube, n2, d2, only_unknown=known_nominal)
        use = (d2 >= 0.5).all(axis=0) & ~known_nominal
        num[:, use] = n2[:, use]
        den[:, use] = d2[:, use]
        del cube
        discard(path)
    bands, known = [], np.ones((h, w), bool)
    for b in range(VIS_BANDS):
        v, k = sg.finish(num[b], den[b], 0.5)
        bands.append(v)
        known &= k
    filled = int(((den >= 0.5).all(axis=0) & ~known_nominal).sum())
    del num, den
    for b, p in zip(bands, paths):
        np.where(known, b, 0).astype(np.float32).tofile(p)
    meta_p.write_text(json.dumps({"files": files, "filled": filled}))
    return [np.where(known, b, 0).astype(np.float32) for b in bands], known, files, filled


def build_albedo(ctx: BuildContext, work: Path) -> dict:
    from .photometry import bodies, solar

    level = ALBEDO_LEVEL
    h, w = st.level_shape(level)
    bands, known, files, filled = mdr_bands(work)
    means = sl.normalize_bands(bands, known, level)
    body = bodies.build_body(NAIF)
    e = solar.spectrum().grid
    centres = [430.0, 480.0, 560.0, 630.0, 750.0, 830.0]
    W = sc.channel_weights(centres, body.p_grid, e)
    diag = sc.diagnostics(centres, body.p_grid, e)
    ratios = [b / np.float32(m) for b, m in zip(bands, means)]
    top = np.zeros((h, w, 4), np.float32)
    sl.xyzs_from_ratios(ratios, W, known, top)
    rng = np.random.default_rng(NAIF)
    jj, ii = np.nonzero(known)
    pick = rng.choice(jj.size, size=min(4000, jj.size), replace=False)
    spread = sc.interpolation_spread(np.array([[r[jj[q], ii[q]] for r in ratios] for q in pick]), centres,
                                     body.p_grid, e)
    check = st.disk_mean(top, known, level)
    sl.register_dataset(
        ctx, SRC_MDR, "MESSENGER MDIS Map Projected Multispectral RDR (MDR), 8-colour global map, 64 px/deg, v4",
        "Hash, C. (2014). MESSENGER MDIS map projected multispectral RDR V1.0, MESS-H-MDIS-5-RDR-MDR-V1.0, NASA "
        "Planetary Data System (volume MSGRMDS_5001). Calibration and products: Denevi, B. W. et al. (2018). "
        "Calibration, projection, and final image products of MESSENGER's Mercury Dual Imaging System. Space "
        "Science Reviews 214, 2. doi:10.1007/s11214-017-0440-y.",
        MDR, files, version="MDR version 4 (end of mission + 2 years)", license="public domain (NASA)",
        notes="I/F normalized to i = 30°, e = 0, g = 30° with a Kaasalainen-Shkuratov photometric correction; each "
              "value is the average of the best image sets (v3/v4 mosaicking). Only bands 1-6 (430-830 nm) of each "
              "17-band cube were downloaded (byte ranges).")
    src_color = list(dict.fromkeys([SRC_MDR, *body.entry["geometricAlbedoXYZS"]["sources"]]))
    spec = sl.LayerSpec(
        naif=NAIF, body=NAME, layer="albedo", kind="relative-reflectance", fmt="f16", channels=list(sc.CHANNELS),
        frame={"name": "IAU_MERCURY",
               "note": "MDR tiles: planetocentric, east longitude, 2439.4 km sphere. Label offsets leave a "
                       "sub-pixel (≤ 1 source pixel, 0.016°) registration ambiguity, < 0.4 level-4 texel."},
        sources=[SRC_MDR, *body.entry["geometricAlbedoXYZS"]["sources"]],
        brightness=sl.Provenance("measured", [SRC_MDR],
                                 "MDR photometrically normalized I/F (i = g = 30°, e = 0), box-averaged (equirectangular "
                                 "tiles) or 3×3-block-averaged and bilinearly sampled (polar tiles) to level 4; the "
                                 "texel is the ratio to the disk average per band. With the product's spatially "
                                 "uniform photometric correction this ratio is also the normal-albedo ratio.",
                                 "MDR v4 mosaics average several image sets; residual seams between image sets are "
                                 "at the percent level (Denevi et al. 2018)"),
        color=sl.Provenance(diag.label, src_color,
                            "Six calibrated bands (430, 480, 560, 630, 750, 830 nm) as band ratios, interpolated "
                            "linearly and held flat below 430 nm, times the disk albedo spectrum, integrated against "
                            "sunlight and the CIE observers. " + diag.reason,
                            "linear vs monotone-cubic interpolation: 99th percentile |Δ| "
                            + ", ".join(f"{k} {v['p99'] * 100:.2f} %" for k, v in spread.items())),
        regions=[sl.Region(-90, 90, -180, 180, sl.Provenance("measured", [SRC_MDR], "MDR 8-colour map"),
                           note=f"{filled} level-{level} texels near the south pole come from the MDR gap-fill tile "
                                "(images binned to 2.7 km/px); texels without data in all six bands are unknown.")],
        epoch={"observed": "2011-03-29/2015-04-30", "changes": "negligible"},
        normalization={"weighting": "cos²(lat) projected area at zero phase, equatorial observer, rotation-averaged; "
                                    "known texels only",
                       "bandDiskMeanIoverF": {str(c): round(m, 6) for c, m in zip(centres, means)},
                       "channelWeights": {"bandsNm": centres, "W": [[round(float(x), 6) for x in r] for r in W]},
                       "texelDiskMeanCheck": [round(float(x), 5) for x in check]},
        diagnostics={"color": diag.to_json(), "interpolationSpread": spread, "tiles": len(files) // 2,
                     "southPoleGapFillTexels": filled},
        notes=["The USGS 'EnhancedColor' and 'MD3Color' mosaics are stretched/false-colour products and are not used."],
    )
    return sl.write_layer(ctx, spec, top, known, level)


def build_height(ctx: BuildContext) -> dict:
    path = fetch(DEM, SUBDIR)
    with tifffile.TiffFile(path) as t:
        p = t.pages[0]
        sx, sy, _ = p.tags["ModelPixelScaleTag"].value
        tie = p.tags["ModelTiepointTag"].value
        geo = p.tags["GeoDoubleParamsTag"].value
        nodata = float(p.tags["GDAL_NODATA"].value)
        meta = t.gdal_metadata or ""
    scale = float(re.search(r'name="SCALE"[^>]*>([^<]+)<', meta).group(1))
    offset = float(re.search(r'name="OFFSET"[^>]*>([^<]+)<', meta).group(1))
    r = geo[5]
    clon = geo[1]
    m_per_deg = r * np.pi / 180.0
    data = tifffile.memmap(path)
    dlon, dlat = sx / m_per_deg, sy / m_per_deg
    grid = sg.EquirectGrid(lat0=tie[4] / m_per_deg - dlat / 2, lon0=clon + tie[3] / m_per_deg + dlon / 2,
                           dlat=dlat, dlon=dlon, lines=data.shape[0], samples=data.shape[1])
    level = HEIGHT_LEVEL
    shape = st.level_shape(level)
    num = np.zeros(shape, np.float32)
    den = np.zeros(shape, np.float32)
    c = sg.accumulate_chunked(num, den, data, grid, level, lambda b: b != nodata,
                              lambda b: b.astype(np.float32) * np.float32(scale) + np.float32(offset))
    top, known = sg.finish(num, den, 0.5)
    top = (top + (r - sl.ellipsoid_radius_m(NAIF, level))).astype(np.float32)
    sl.register_dataset(
        ctx, SRC_DEM, "USGS global MESSENGER MDIS stereo DEM of Mercury, 665 m/px, v2",
        "Becker, K. J., Robinson, M. S., Becker, T. L., Weller, L. A., Edmundson, K. L., Neumann, G. A., Perry, M. E. "
        "& Solomon, S. C. (2016). First global digital elevation model of Mercury. 47th Lunar and Planetary Science "
        "Conference, abstract 2959. Data: USGS Astrogeology, Mercury_Messenger_USGS_DEM_Global_665m_v2.tif.",
        DEM, {path.name: record(path)}, version="v2", license="public domain (USGS)",
        notes=f"int16 × {scale} m relative to a {r / 1000:g} km sphere, equirectangular centred on {clon:g}° "
              f"(left edge 0°E); nodata {nodata:g}. Valid pixels {c['validPixels'] / c['totalPixels']:.4f}.")
    spec = sl.LayerSpec(
        naif=NAIF, body=NAME, layer="height", kind="height", fmt="f32", channels=["height"],
        frame={"name": "IAU_MERCURY", "referenceEllipsoidKm": sl.pck_radii_km(NAIF),
               "note": f"Height = ({r / 1000:g} km + DEM value) − radius of the pck00011 ellipsoid at the texel."},
        sources=[SRC_DEM, "naif-pck00011"],
        brightness=sl.Provenance("measured", [SRC_DEM, "naif-pck00011"],
                                 "Stereo DEM (box mean over the texel) re-referenced to the pck00011 ellipsoid."),
        units="m",
        regions=[sl.Region(-90, 90, -180, 180, sl.Provenance("measured", [SRC_DEM], "USGS MESSENGER DEM v2"))],
        epoch={"observed": "2011-03/2015-04"},
        diagnostics={"minHeightM": float(top[known].min()), "maxHeightM": float(top[known].max()),
                     "validSourceFraction": c["validPixels"] / c["totalPixels"]},
    )
    return sl.write_layer(ctx, spec, top, known, level)


def build(ctx: BuildContext, work: Path) -> list[dict]:
    return [build_albedo(ctx, work), build_height(ctx)]
