"""Pluto and Charon from the New Horizons MVIC global colour maps (PDS SBN, nh_derived plutosystem_composition).

The New Horizons team's "Global Color Map Mosaic" of each body is a 4-band float32 cube: CH4 (895 nm), NIR (870),
Red (625) and Blue (475). Every MVIC colour scan was converted from calibrated I/F to normal albedo with a
lunar-Lambert photometric function (McEwen 1991; L(15°) = 0.65), registered to the LORRI base map and mosaicked.
The lower-resolution global colour mosaic was merged with the panchromatic base map (McEwen 1991) to full
resolution. So the bands are documented normal albedos ("no longer strictly I/F values, but similar", label).
This replaces the 8-bit USGS panchromatic mosaics (surf_pan) for these two bodies: the brightness is documented
(not an inverted display stretch), and the colour varies per texel.

Colour: Blue and Red are 150 nm wide filters 150 nm apart and NIR is beyond the eye's range, so interpolating the
spectrum between them is an estimate (surf_color criterion), and the colour is labelled `estimated`.
Brightness: `measured` (normal albedo from calibrated scans, box-averaged; the photometric normalization is a
documented model step, as for the other measured maps).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import surf_color as sc
from . import surf_grid as sg
from . import surf_layers as sl
from . import surf_pds as pds
from . import surf_tiles as st
from .download import fetch, record
from .schema import BuildContext
from .surf_fetch import discard
from .surf_pan import Feature, GAZ, feature_check, hemisphere_ratio

SBN = "https://pds-smallbodies.astro.umd.edu/holdings/pds4-nh_derived:plutosystem_composition-v1.0/mosaic/"
# band order in the cube (label Band_Bin_Set): 1 CH4 895, 2 NIR 870, 3 Red 625, 4 Blue 475 (nm, width)
BANDS = {"Blue": (3, 475.0, 150.0), "Red": (2, 625.0, 150.0), "NIR": (1, 870.0, 180.0)}
SRC = "nh-mvic-global-color-maps"


@dataclass(frozen=True)
class NhMap:
    naif: int
    name: str
    file: str
    lines: int
    samples: int
    pixel_m: float
    radius_m: float
    center_lon: float
    upper_left_x: float
    upper_left_y: float
    level: int
    feature: Feature | None
    notes: tuple


MAPS = [
    NhMap(999, "Pluto", "nh_pluto_color_mosaic", 5744, 11487, 650.0, 1188300.0, 180.0, -3733600.0, 1866800.0, 3,
          Feature("Belton Regio (dark)", -9.21, 91.42, 500, "dark", GAZ + ": 9.21°S, 91.42°E"),
          ("Encounter hemisphere (centred near 180°E) from ~0.65 km/px scans at ~38° phase; the rest from approach "
           "scans at ~15° phase and coarser resolution; south of ~30°S was in polar night.",
           "Pluto's volatile ices (N2, CH4, CO) move seasonally: this is the July 2015 state.")),
    NhMap(901, "Charon", "nh_charon_color_mosaic", 1904, 3808, 1000.0, 606000.0, 0.0, -1904000.0, 952000.0, 2, None,
          ("Pluto-facing hemisphere best resolved (0.15-35 km/px with longitude); south of ~38°S was in darkness.",)),
]


def grid(m: NhMap) -> sg.EquirectGrid:
    """Equirectangular cube geometry from the PDS4 label (upper-left corner in metres on the sphere)."""
    mpd = m.radius_m * math.pi / 180.0
    d = m.pixel_m / mpd
    return sg.EquirectGrid(lat0=m.upper_left_y / mpd - d / 2, lon0=m.center_lon + m.upper_left_x / mpd + d / 2,
                           dlat=d, dlon=d, lines=m.lines, samples=m.samples)


def band_path(m: NhMap, band: int) -> Path:
    """Range read of one band (band-sequential float32 LSB cube, 0-based band index)."""
    n = m.lines * m.samples * 4
    return fetch(SBN + m.file + ".img", f"surfaces/{m.name.lower()}", f"{m.file}.band{band}.f32",
                 byte_range=(band * n, (band + 1) * n), timeout=900.0)


def build_one(ctx: BuildContext, m: NhMap) -> dict:
    from .photometry import bodies, solar
    level = m.level
    h, w = st.level_shape(level)
    g = grid(m)
    lab = fetch(SBN + m.file + ".lblx", f"surfaces/{m.name.lower()}")
    files = {lab.name: record(lab)}
    bands, known, stats = {}, np.ones((h, w), bool), {}
    for key, (b, nm, _) in BANDS.items():
        p = band_path(m, b)
        files[p.name] = record(p)
        data = np.memmap(p, dtype="<f4", mode="r", shape=(m.lines, m.samples))
        num = np.zeros((h, w), np.float32)
        den = np.zeros((h, w), np.float32)
        c = sg.accumulate_chunked(num, den, data, g, level, lambda a: ~pds.isis_special_mask(a) & (a > 0))
        v, k = sg.finish(num, den, 0.5)
        bands[key] = v
        known &= k
        stats[key] = {"validFraction": round(c["validPixels"] / c["totalPixels"], 5),
                      "medianNormalAlbedo": round(float(np.median(v[k])), 4)}
        del data
        discard(p)
    order = list(BANDS)
    centres = [BANDS[k][1] for k in order]
    means = sl.normalize_bands([bands[k] for k in order], known, level)
    body = bodies.build_body(m.naif)
    e = solar.spectrum().grid
    W = sc.channel_weights(centres, body.p_grid, e)
    diag = sc.diagnostics(centres, body.p_grid, e)
    ratios = [bands[k] / np.float32(mu) for k, mu in zip(order, means)]
    top = np.zeros((h, w, 4), np.float32)
    sl.xyzs_from_ratios(ratios, W, known, top)
    rng = np.random.default_rng(m.naif)
    jj, ii = np.nonzero(known)
    pick = rng.choice(jj.size, size=min(4000, jj.size), replace=False)
    spread = sc.interpolation_spread(np.array([[r[jj[q], ii[q]] for r in ratios] for q in pick]), centres,
                                     body.p_grid, e)
    radius_km = m.radius_m / 1000
    y = top[..., 1]
    if m.feature is not None:
        check = feature_check(y, known, level, m.feature, radius_km)
        if not check["passed"]:
            raise ValueError(f"{m.name}: georeferencing check failed: {check}")
    else:
        check = {"passed": None, "note": "no named albedo feature selected; orientation from the PDS4 label"}
    red_blue = bands["Red"] / np.where(known, bands["Blue"], 1)
    sl.register_dataset(
        ctx, SRC, "New Horizons MVIC global colour map mosaics of Pluto and Charon (PDS SBN)",
        "Olkin, C. B. et al. (2017). The global color of Pluto from New Horizons. Astronomical Journal 154, 258. "
        "doi:10.3847/1538-3881/aa965b. Calibration: Howett, C. J. A. et al. (2017). Inflight radiometric "
        "calibration of New Horizons' Multispectral Visible Imaging Camera (MVIC). Icarus 287, 140-151. "
        "doi:10.1016/j.icarus.2016.12.007. Cartography: Schenk, P. M. et al. (2018), Icarus 314, 400-433 and "
        "Icarus 315, 124-145. Archive: New Horizons Encounter with the Pluto System: Global Color Maps, Image "
        "Cubes, and Absorption Band Maps (urn:nasa:pds:nh_derived:plutosystem_composition, v1.0, PDS Small "
        "Bodies Node, 2025).",
        SBN, files, version="plutosystem_composition v1.0", license="public domain (NASA)",
        notes="Band-sequential float32 cubes read one band at a time by HTTP Range (Blue, Red, NIR; the CH4 band is "
              "not used) and deleted after box-averaging; ISIS special values are no data.")
    src_color = list(dict.fromkeys([SRC, *body.entry["geometricAlbedoXYZS"]["sources"]]))
    spec = sl.LayerSpec(
        naif=m.naif, body=m.name, layer="albedo", kind="relative-reflectance", fmt="f16", channels=list(sc.CHANNELS),
        frame={"name": f"IAU_{m.name.upper()}",
               "note": "PDS4 cube in planetocentric latitude / east longitude on a sphere of radius "
                       f"{radius_km:g} km" + (f"; orientation verified with {m.feature.name}." if m.feature else ".")},
        sources=[SRC, *body.entry["geometricAlbedoXYZS"]["sources"]],
        brightness=sl.Provenance("measured", [SRC],
                                 "Normal albedo per band from calibrated MVIC scans (lunar-Lambert normalization, "
                                 "L(15°) = 0.65), merged with the LORRI panchromatic base map for spatial detail, "
                                 f"box-averaged to level {level}; texels are band ratios to the disk mean.",
                                 "MVIC absolute calibration a few % (Howett et al. 2017); the photometric "
                                 "normalization is a model and scans at different phase angles (15°-38°) meet at "
                                 "seams"),
        color=sl.Provenance(diag.label, src_color,
                            "Band ratios at 475 (Blue), 625 (Red) and 870 nm (NIR) interpolated linearly and held "
                            "flat outside, times the disk-integrated albedo spectrum, integrated against sunlight and "
                            "the CIE observers. " + diag.reason,
                            "linear vs monotone-cubic interpolation: 99th percentile |Δ| "
                            + ", ".join(f"{k} {v['p99'] * 100:.2f} %" for k, v in spread.items())),
        regions=[sl.Region(-90, 90, -180, 180, sl.Provenance("measured", [SRC], "MVIC global colour map"),
                           note="Cells without MVIC data (the unlit south, gaps) are unknown.")],
        epoch={"start": "2015-07-12T00:00:00Z", "end": "2015-07-14T12:00:00Z",
               "observed": "New Horizons approach and flyby, 2015-07-12 to 2015-07-14",
               "changes": "seasonal volatile transport changes Pluto's surface over years to decades"},
        normalization={"weighting": "cos²(lat) projected area at zero phase, equatorial observer, rotation-averaged; "
                                    "known texels only",
                       "bandDiskMean": {str(c): round(mu, 6) for c, mu in zip(centres, means)},
                       "channelWeights": {"bandsNm": centres, "W": [[round(float(x), 6) for x in r] for r in W]},
                       "texelDiskMeanCheck": [round(float(x), 5) for x in st.disk_mean(top, known, level)]},
        diagnostics={"color": diag.to_json(), "interpolationSpread": spread, "bands": stats,
                     "georeferencing": check,
                     "redOverBlue": {"p5": round(float(np.percentile(red_blue[known], 5)), 3),
                                     "median": round(float(np.median(red_blue[known])), 3),
                                     "p95": round(float(np.percentile(red_blue[known], 95)), 3)},
                     **({"subCharonOverAntiCharon": round(hemisphere_ratio(y, known, level, 0.0, 180.0), 4)}
                        if m.naif == 999 else {})},
        notes=list(m.notes),
    )
    return sl.write_layer(ctx, spec, top, known, level)


def build(ctx: BuildContext, work: Path) -> list[dict]:
    return [build_one(ctx, m) for m in MAPS]
