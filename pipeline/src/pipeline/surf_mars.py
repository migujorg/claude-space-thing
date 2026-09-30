"""Mars (NAIF 499): HRSC global colour mosaic → albedo, MOLA → height.

albedo  Mars Express HRSC high-altitude global colour mosaic (Michael et al. 2025, Icarus 425, 116350; data
        doi:10.17169/refubium-40624, CC BY 4.0): five 2 km/px float32 mosaics (nadir/panchromatic 675 nm, red
        750 nm, green 530 nm, blue 440 nm, IR 970 nm) colour-referenced with a globally self-consistent colour model
        built only from the relative colour inside each image, which suppresses image-to-image changes of
        atmospheric scattering while keeping long-range colour variation. Colour bands used: 440, 530, 675, 750 nm.
        The absolute level of the mosaics is not used (texels are ratios to the disk average).
height  MGS MOLA MEGDR 32 px/deg planetary radius (Smith et al. 2003, PDS) minus the pck00011 reference ellipsoid
        (3396.19 × 3396.19 × 3376.20 km), i.e. height above the ellipsoid the app uses for Mars.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import tifffile

from . import surf_color as sc
from . import surf_grid as sg
from . import surf_layers as sl
from . import surf_pds as pds
from . import surf_tiles as st
from .download import fetch, record
from .schema import BuildContext

NAIF = 499
NAME = "Mars"
SUBDIR = "surfaces/mars"
ALBEDO_LEVEL = 4
HEIGHT_LEVEL = 4
HRSC = "https://hrscteam.dlr.de/public/data/global_mosaic/extra/"
# (file stem, band centre nm, name); HRSC filter centres from Jaumann et al. 2007 (PSS 55, 928), Table 2
HRSC_BANDS = [("03-bl", 440.0, "blue"), ("02-gr", 530.0, "green"), ("00-nd", 675.0, "nadir (panchromatic)"),
              ("01-re", 750.0, "red")]
MEGDR = "https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg032/"

SRC_HRSC = "hrsc-global-colour-mosaic"
SRC_MOLA = "mola-megdr-32ppd"


def hrsc_grid(path: Path) -> tuple[sg.EquirectGrid, float]:
    """Grid from the GeoTIFF tags (equirectangular on a 3396 km sphere, pixel-is-area tie point at the upper-left
    corner) and the nodata value."""
    with tifffile.TiffFile(path) as t:
        p = t.pages[0]
        sx, sy, _ = p.tags["ModelPixelScaleTag"].value
        tie = p.tags["ModelTiepointTag"].value
        geo = p.tags["GeoDoubleParamsTag"].value
        nodata = float(p.tags["GDAL_NODATA"].value)
        h, w = p.shape
    r = geo[5]  # semi-major axis of the sphere, m
    m_per_deg = r * np.pi / 180.0
    x0, y0 = tie[3], tie[4]
    dlon, dlat = sx / m_per_deg, sy / m_per_deg
    grid = sg.EquirectGrid(lat0=y0 / m_per_deg - dlat / 2, lon0=x0 / m_per_deg + dlon / 2, dlat=dlat, dlon=dlon,
                           lines=h, samples=w)
    return grid, nodata


def build_albedo(ctx: BuildContext) -> dict:
    from .photometry import bodies, solar

    level = ALBEDO_LEVEL
    h, w = st.level_shape(level)
    bands, known, files, stats = [], np.ones((h, w), bool), {}, {}
    for stem, nm, _ in HRSC_BANDS:
        path = fetch(f"{HRSC}{stem}-eqc.tif", SUBDIR)
        files[path.name] = record(path)
        grid, nodata = hrsc_grid(path)
        data = tifffile.memmap(path)
        num = np.zeros((h, w), np.float32)
        den = np.zeros((h, w), np.float32)
        c = sg.accumulate_chunked(num, den, data, grid, level,
                                  lambda b: np.isfinite(b) & (b > 0) & (b != np.float32(nodata)))
        v, k = sg.finish(num, den, 0.5)
        bands.append(v)
        known &= k
        stats[stem] = {"validFraction": c["validPixels"] / c["totalPixels"]}
    means = sl.normalize_bands(bands, known, level)
    body = bodies.build_body(NAIF)
    e = solar.spectrum().grid
    centres = [b[1] for b in HRSC_BANDS]
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
        ctx, SRC_HRSC, "Mars Express HRSC global colour mosaic from high-altitude observations (2 km/px)",
        "Michael, G. G., Tirsch, D., Matz, K.-D., Zuschneid, W., Hauber, E., Gwinner, K., Walter, S. H. G., "
        "Jaumann, R., Roatsch, T. & Postberg, F. (2025). A global colour mosaic of Mars from high altitude "
        "observations. Icarus 425, 116350. doi:10.1016/j.icarus.2024.116350. Data: Freie Universität Berlin "
        "Refubium, doi:10.17169/refubium-40624 (2023). Credit ESA/DLR/FU Berlin.",
        HRSC, files, version="2023-08-07 release (HTTP Last-Modified)", license="CC BY 4.0 (DataCite record)",
        notes="Five float32 equirectangular mosaics on a 3396 km sphere, 10669 × 5334 px; built from ~90 "
              "high-altitude HRSC images (pixel scale > 200 m) with minimal dust and clouds clipped out; small "
              "coverage gaps remain. Files 04-ir (970 nm) and the RGB composite are not used.")
    src_color = list(dict.fromkeys([SRC_HRSC, *body.entry["geometricAlbedoXYZS"]["sources"]]))
    spec = sl.LayerSpec(
        naif=NAIF, body=NAME, layer="albedo", kind="relative-reflectance", fmt="f16", channels=list(sc.CHANNELS),
        frame={"name": "IAU_MARS",
               "note": "HRSC mosaics are planetocentric, east longitude, on the IAU 2000 Mars frame; the pck00011 "
                       "(IAU 2015) Mars prime meridian agrees to well below one level-4 texel (2.6 km)."},
        sources=[SRC_HRSC, *body.entry["geometricAlbedoXYZS"]["sources"]],
        brightness=sl.Provenance("measured", [SRC_HRSC],
                                 "HRSC colour-referenced mosaic, box-averaged to level 4; a texel is the ratio to the "
                                 "disk average in each band.",
                                 "the colour model removes image-to-image atmospheric changes but not the average "
                                 "dust haze of the campaign; Michael et al. 2025 state the absolute surface colour is "
                                 "uncertain because of the varying atmospheric transparency"),
        color=sl.Provenance(diag.label, src_color,
                            "Band ratios at 440, 530, 675 (broad panchromatic nadir channel) and 750 nm interpolated "
                            "linearly and held flat outside, times the disk-integrated albedo spectrum, integrated "
                            "against sunlight and the CIE observers. " + diag.reason,
                            "linear vs monotone-cubic interpolation: 99th percentile |Δ| "
                            + ", ".join(f"{k} {v['p99'] * 100:.2f} %" for k, v in spread.items())),
        regions=[sl.Region(-90, 90, -180, 180, sl.Provenance("measured", [SRC_HRSC], "HRSC global mosaic"),
                           note="Coverage gaps of the mosaic are unknown texels.")],
        epoch={"observed": "Mars Express high-altitude campaign (2004 onwards; images selected for low dust)",
               "changes": "dust deposition and removal changes albedo features on seasonal to decadal time scales; "
                          "the map is a multi-year composite, not a snapshot"},
        normalization={"weighting": "cos²(lat) projected area at zero phase, equatorial observer, rotation-averaged; "
                                    "known texels only",
                       "bandDiskMean": {str(c): round(m, 6) for c, m in zip(centres, means)},
                       "channelWeights": {"bandsNm": centres, "W": [[round(float(x), 6) for x in r] for r in W]},
                       "texelDiskMeanCheck": [round(float(x), 5) for x in check]},
        diagnostics={"color": diag.to_json(), "interpolationSpread": spread, "bands": stats},
        notes=["The HRSC nadir channel is broad (≈ 675 ± 45 nm); using it as a 675 nm sample is part of the colour "
               "estimate."],
    )
    return sl.write_layer(ctx, spec, top, known, level)


def build_height(ctx: BuildContext) -> dict:
    lbl = fetch(MEGDR + "megr90n000fb.lbl", SUBDIR)
    img = fetch(MEGDR + "megr90n000fb.img", SUBDIR)
    lab = pds.parse_odl(lbl.read_text(encoding="latin-1"))
    grid = pds.equirect_grid(lab)
    imgd = pds.find(lab, "IMAGE")
    scale = pds.num(imgd, "SCALING_FACTOR") if "SCALING_FACTOR" in imgd else 1.0
    offset = pds.num(imgd, "OFFSET") if "OFFSET" in imgd else 0.0
    data = np.memmap(img, pds.image_dtype(lab), mode="r", shape=(grid.lines, grid.samples))
    level = HEIGHT_LEVEL
    shape = st.level_shape(level)
    num = np.zeros(shape, np.float32)
    den = np.zeros(shape, np.float32)
    # accumulate radius − 3396 km in float32 (keeps metre precision), subtract the ellipsoid afterwards
    base = 3396000.0
    sg.accumulate_chunked(num, den, data, grid, level, lambda b: np.ones(b.shape, bool),
                          lambda b: (b.astype(np.float64) * scale + offset - base).astype(np.float32))
    top, known = sg.finish(num, den, 0.5)
    top = (top + (base - sl.ellipsoid_radius_m(NAIF, level))).astype(np.float32)
    sl.register_dataset(
        ctx, SRC_MOLA, "MGS MOLA Mission Experiment Gridded Data Record, planetary radius, 32 px/deg (MEGR90N000FB)",
        "Smith, D. E. et al. (2001). Mars Orbiter Laser Altimeter: experiment summary after the first year of global "
        "mapping of Mars. JGR 106, 23689-23722. doi:10.1029/2000JE001364. Data: Smith, D., Neumann, G., Arvidson, "
        "R. E., Guinness, E. A. & Slavney, S. (2003), MGS-M-MOLA-5-MEGDR-L3-V1.0, NASA PDS Geosciences Node.",
        MEGDR + "megr90n000fb.img", {img.name: record(img), lbl.name: record(lbl)}, version="MEGDR V1.0 (2003)",
        license="public domain (NASA)",
        notes="int16 planetary radius (offset 3396000 m), planetocentric, east longitude, 32 px/deg; gaps between "
              "MOLA tracks were interpolated by the producer.")
    spec = sl.LayerSpec(
        naif=NAIF, body=NAME, layer="height", kind="height", fmt="f32", channels=["height"],
        frame={"name": "IAU_MARS", "referenceEllipsoidKm": sl.pck_radii_km(NAIF),
               "note": "Height = MOLA planetary radius − radius of the pck00011 ellipsoid at the texel's "
                       "planetocentric latitude (not the areoid)."},
        sources=[SRC_MOLA, "naif-pck00011"],
        brightness=sl.Provenance("measured", [SRC_MOLA, "naif-pck00011"],
                                 "MOLA radius (box mean over the texel) minus the reference ellipsoid."),
        units="m",
        regions=[sl.Region(-90, 90, -180, 180, sl.Provenance("measured", [SRC_MOLA], "MOLA MEGDR"))],
        epoch={"observed": "1997-09/2001-06 (MGS mapping)"},
        diagnostics={"minHeightM": float(top[known].min()), "maxHeightM": float(top[known].max())},
    )
    return sl.write_layer(ctx, spec, top, known, level)


def build(ctx: BuildContext, work: Path) -> list[dict]:
    return [build_albedo(ctx), build_height(ctx)]
