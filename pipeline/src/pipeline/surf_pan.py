"""Panchromatic 8-bit global mosaics (USGS Astrogeology): the Galilean moons (Pluto and Charon: see surf_nh).

These mosaics are calibrated and photometrically normalized by their producers (Lunar-Lambert or similar), matched
across image boundaries, and delivered as 8-bit pixels. GeoTIFF GDAL scale/offset metadata are decoded before use
(also documented by the ISIS labels). The decoded, tone-matched values are assumed proportional to relative
reflectance (DN 0 = no data), including unresolved topographic shading, so the brightness pattern is labelled
`estimated`; with a single band the local colour is the disk colour, so the colour is `estimated` too
(docs/architecture.md §4.4). The texel is decoded value / ⟨decoded value⟩ (cos²φ disk weighting) in all four channels.

Excluded on purpose: colour composites ('ClrMosaic', 'ClrMerge', 'FalseColor' — filter composites with contrast
enhancement, not calibrated colour), high-pass-filtered mosaics ('HPF'), and gap-filled products ('GlobalFill')
whose fill is not documented.

Georeferencing is checked per body against a named albedo feature (IAU Gazetteer of Planetary Nomenclature
coordinates): the feature must stand out at its east-longitude position and not at the mirrored position, which
catches a west/east longitude mix-up.
"""

from __future__ import annotations

import json
import math
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import tifffile

from . import surf_grid as sg
from . import surf_layers as sl
from . import surf_tiles as st
from .download import fetch, record
from .schema import BuildContext
from .surf_fetch import discard

USGS = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/"


@dataclass(frozen=True)
class Feature:
    name: str
    lat: float
    lon_e: float       # east longitude, degrees
    radius_km: float
    kind: str          # 'dark' or 'bright'
    ref: str           # coordinate source


@dataclass(frozen=True)
class PanMap:
    naif: int
    name: str
    file: str
    src_id: str
    title: str
    citation: str
    level: int
    feature: Feature | None
    observed: str
    notes: tuple = field(default_factory=tuple)
    keep_raw: bool = True
    # documented linear 8-bit stretch (DN_lo, DN_hi, value_lo, value_hi) from the FGDC metadata, inverted before use
    stretch: tuple | None = None


GAZ = "IAU Gazetteer of Planetary Nomenclature (planetarynames.wr.usgs.gov)"
MAPS = [
    PanMap(501, "Io", "Io_GalileoSSI-Voyager_Global_Mosaic_1km.tif", "usgs-io-galileo-voyager-1km",
           "Io Galileo SSI / Voyager global mosaic, 1 km/px (USGS)",
           "Williams, D. A., Keszthelyi, L. P., Crown, D. A., Yff, J. A., Jaeger, W. L., Schenk, P. M., Geissler, "
           "P. E. & Becker, T. L. (2011). Geologic map of Io. USGS Scientific Investigations Map 3168 (base mosaic: "
           "Becker, T. & Geissler, P. (2005), Galileo global mosaics of Io, LPSC XXXVI abstract 1862). Data: USGS "
           "Astrogeology, Io_GalileoSSI-Voyager_Global_Mosaic_1km.tif.",
           3, Feature("Loki Patera", 13.01, 51.21, 90, "dark", GAZ + ": 13.0083°N, 51.2136°E"),
           "Voyager 1979; Galileo 1996-2001",
           ("Combined Galileo SSI moderate-resolution / Voyager II high-resolution monochrome morphology mosaic "
            "(Becker & Geissler 2005); topographic shading remains. The 32-image grayscale description in the "
            "USGS metadata describes the Galileo-only sibling, not this combined product.",
            "Io's surface changes with volcanic activity: this is a 1979-2001 composite.")),
    PanMap(502, "Europa", "Europa_Voyager_GalileoSSI_global_mosaic_500m.tif", "usgs-europa-voyager-galileo-500m",
           "Europa Voyager / Galileo SSI global mosaic, 500 m/px (USGS)",
           "U.S. Geological Survey Astrogeology Science Center (2002, updated 2022). Europa Voyager - Galileo SSI "
           "global mosaic 500 m. Processing: Lunar-Lambert photometric normalization (McEwen 1991, Icarus 92, 298, "
           "doi:10.1016/0019-1035(91)90053-V; Kirk et al. 2000, LPSC XXXI 2025), linear overlap matching and seam "
           "removal (Soderblom et al. 1978, Icarus 34, doi:10.1016/0019-1035(78)90037-4).",
           3, Feature("Pwyll (bright ray crater)", -25.2, 88.6, 60, "bright", GAZ + ": 25.2°S, 88.6°E"),
           "Voyager 1979; Galileo 1996-2003",
           ("Image resolutions vary widely (tens of m to ~20 km/px gap fill).",)),
    PanMap(503, "Ganymede", "Ganymede_Voyager_GalileoSSI_global_mosaic_1km.tif", "usgs-ganymede-voyager-galileo-1km",
           "Ganymede Voyager / Galileo SSI global mosaic, 1 km/px (USGS)",
           "Becker, T. et al. (2001). Final digital global maps of Ganymede, Europa, and Callisto. LPSC XXXII, "
           "abstract 2009. Data: USGS Astrogeology, Ganymede_Voyager_GalileoSSI_global_mosaic_1km.tif "
           "(Lunar-Lambert normalization, overlap matching; clear, 559 nm and 757 nm images).",
           3, Feature("Galileo Regio (dark)", 45.0, 233.0, 600, "dark", GAZ + ": 45°N, 233°E"),
           "Voyager 1979; Galileo 1996-2000",
           ("Input resolutions 180 m to 20 km/px (gap fill).",)),
    PanMap(504, "Callisto", "Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif", "usgs-callisto-voyager-galileo-1km",
           "Callisto Voyager / Galileo SSI global mosaic, 1 km/px (USGS)",
           "Becker, T. et al. (2001). Final digital global maps of Ganymede, Europa, and Callisto. LPSC XXXII, "
           "abstract 2009. Data: USGS Astrogeology, Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif.",
           3, Feature("Valhalla (bright centre)", 14.7, 304.0, 300, "bright", GAZ + ": 14.7°N, 304°E"),
           "Voyager 1979; Galileo 1996-2001", ()),
]

# Pluto and Charon now come from the New Horizons MVIC colour maps (surf_nh: documented normal albedo, colour per
# texel). The USGS 8-bit mosaics are kept here for comparison (`build(ctx, work, NH_PAN_MAPS)`).
NH_PAN_MAPS = [
    PanMap(999, "Pluto", "Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif", "usgs-pluto-newhorizons-300m",
           "Pluto New Horizons LORRI/MVIC global mosaic, 300 m/px (USGS, July 2017)",
           "Schenk, P. M., Beyer, R. A., McKinnon, W. B., Moore, J. M., Spencer, J. R., White, O. L. et al. (2018). "
           "Basins, fractures and volcanoes: global cartography and topography of Pluto from New Horizons. Icarus 314, "
           "400-433. doi:10.1016/j.icarus.2018.06.008. Data: USGS Astrogeology, "
           "Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif.",
           3, Feature("Belton Regio (dark)", -9.21, 91.42, 500, "dark", GAZ + ": 9.21°S, 91.42°E"),
           "2015-07 (New Horizons flyby, 2015-07-14)",
           ("Encounter hemisphere (centred near 180°E) at up to ~0.3-1 km/px; the far hemisphere only at ~20-40 km/px "
            "from approach images; south of ~30°S was in polar night and is unknown.",
            "Pluto's surface volatiles (N2, CH4, CO ices) move seasonally; this is the July 2015 state."), False,
           (1, 255, 0.03344, 0.99981)),
    PanMap(901, "Charon", "Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif", "usgs-charon-newhorizons-300m",
           "Charon New Horizons LORRI/MVIC global mosaic, 300 m/px (USGS, July 2017)",
           "Schenk, P. M., Beyer, R. A., McKinnon, W. B., Moore, J. M., Spencer, J. R., White, O. L. et al. (2018). "
           "Breaking up is hard to do: global cartography and topography of Pluto's mid-sized icy moon Charon from New "
           "Horizons. Icarus 315, 124-145. doi:10.1016/j.icarus.2018.06.010. Data: USGS Astrogeology, "
           "Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif.",
           2, None, "2015-07 (New Horizons flyby, 2015-07-14)",
           ("Encounter hemisphere at high resolution, far side from approach images; the south was in polar night.",),
           True, (1, 255, 0.10892, 1.3745)),
]

# Saturn's mid-size moons are NOT built: the USGS/CICLOPS global maps (Tethys, Dione, Rhea, Iapetus, Enceladus)
# compress large-scale contrast. The Iapetus map implies a leading/trailing brightness ratio of 0.84 (0.18 mag)
# at zero phase, against the ~2 mag asymmetry seen since Cassini (1671); Dione's gives 4 %. See the stage's
# EXCLUDED list and docs/reports/surfaces.md.


def geotiff_grid(path: Path) -> tuple[sg.EquirectGrid, float, dict]:
    with tifffile.TiffFile(path) as t:
        p = t.pages[0]
        sx, sy, _ = p.tags["ModelPixelScaleTag"].value
        tie = p.tags["ModelTiepointTag"].value
        geo = p.tags["GeoDoubleParamsTag"].value
        nd = p.tags.get("GDAL_NODATA")
        nodata = float(nd.value) if nd is not None else 0.0
        info = {"shape": list(p.shape), "dtype": str(p.dtype), "ascii": str(p.tags["GeoAsciiParamsTag"].value)
                if "GeoAsciiParamsTag" in p.tags else ""}
        metadata = p.tags.get("GDAL_METADATA")
        encoding = {"scale": 1.0, "offset": 0.0, "documented": False}
        if metadata is not None:
            # GDAL's band scale/offset: value = stored pixel * scale + offset. The USGS
            # detached ISIS labels repeat these as Pixels.Multiplier and Pixels.Base.
            # https://gdal.org/en/stable/drivers/raster/gtiff.html#metadata
            items = ET.fromstring(metadata.value).findall("Item")
            for key in ("scale", "offset"):
                matches = [e for e in items if e.get("sample") == "0" and e.get("role") == key]
                if len(matches) > 1:
                    raise ValueError(f"{path.name}: duplicate GDAL band {key}")
                if matches:
                    encoding[key] = float(matches[0].text)
                    encoding["documented"] = True
        if not (math.isfinite(encoding["scale"]) and encoding["scale"] > 0
                and math.isfinite(encoding["offset"])):
            raise ValueError(f"{path.name}: invalid GDAL pixel encoding {encoding}")
        info["pixelEncoding"] = encoding
    r = geo[5]
    clon = geo[1]
    mpd = r * math.pi / 180.0
    dlon, dlat = sx / mpd, sy / mpd
    grid = sg.EquirectGrid(lat0=tie[4] / mpd - dlat / 2, lon0=clon + tie[3] / mpd + dlon / 2, dlat=dlat, dlon=dlon,
                           lines=info["shape"][0], samples=info["shape"][1])
    info["radiusM"] = r
    info["centerLon"] = clon
    return grid, nodata, info


def _disk_patch_mean(v: np.ndarray, known: np.ndarray, level: int, lat0: float, lon0: float, r_km: float,
                     radius_km: float, ring: tuple[float, float] | None = None) -> float:
    lat = np.radians(st.lat_centers(level))[:, None]
    lon = np.radians(st.lon_centers(level))[None, :]
    p0, l0 = math.radians(lat0), math.radians(lon0)
    c = np.sin(p0) * np.sin(lat) + np.cos(p0) * np.cos(lat) * np.cos(lon - l0)
    d = radius_km * np.arccos(np.clip(c, -1, 1))
    sel = (d < r_km) if ring is None else ((d >= ring[0]) & (d < ring[1]))
    sel &= known
    return float(v[sel].mean()) if sel.any() else float("nan")


def hemisphere_ratio(v: np.ndarray, known: np.ndarray, level: int, lon_a: float, lon_b: float) -> float:
    """Ratio of the zero-phase, projected-area-weighted mean texel value of the hemisphere centred on (0°, lon_a) to
    that of the hemisphere centred on (0°, lon_b) (no limb darkening; a check of large-scale contrast)."""
    lat = np.radians(st.lat_centers(level))[:, None]
    lon = np.radians(st.lon_centers(level))[None, :]

    def mean(l0):
        mu = np.cos(lat) * np.cos(lon - math.radians(l0))
        w = np.where((mu > 0) & known, mu * np.cos(lat), 0.0)
        return float((w * v).sum() / w.sum())
    return mean(lon_a) / mean(lon_b)


def leading_trailing_diagnostic(ratio: float, model: dict | None) -> dict:
    """Map-only projected-area contrast, compared like-for-like with the fitted slices.

    Not a test with published sigma: Mayorga Table 4 has no numerical slice errors or
    covariance. Table 7 reports peak-to-trough modulation errors, a different statistic.
    The renderer's Lambert slice kernel and viewing-geometry map normalization also
    differ from the map-only projected-area diagnostic; report both explicitly.
    """
    d = {"ratio": round(ratio, 4), "magnitudes": round(2.5 * math.log10(ratio), 3),
         "label": "estimated",
         "what": "map-only zero-phase projected-area mean over leading (270°E) / trailing (90°E); "
                 "weights cos²(latitude) max(cos(longitude - centre), 0), known texels only, "
                 "no limb darkening, before viewing-geometry normalization",
         "comparisonStatus": "unknown", "ratioUncertainty": None,
         "uncertainty": "Mayorga et al. (2020) Table 4 publishes no numerical slice errors or covariance; "
                        "Table 7 modulation errors are not errors on this hemisphere ratio. "
                        "Agreement within slice uncertainty cannot be assessed."}
    if model is not None and model.get("value", {}).get("kind") == "rotation-slices-v1":
        from .photometry.moons import slice_factor
        m = model["value"]
        a = m["relativeAlbedo"]
        projected = (0.5 * a[0] + a[1] + 0.5 * a[2]) / (0.5 * a[3] + a[4] + 0.5 * a[5])
        lead, trail = math.radians(270), math.radians(90)
        rendered = (slice_factor(m["sliceEdgesEastLonDeg"], a, lead, lead)
                    / slice_factor(m["sliceEdgesEastLonDeg"], a, trail, trail))
        d["rotationSlices"] = {
            "sources": model["sources"], "label": model["label"],
            "value": {"projectedAreaRatio": round(projected, 6), "mapOverSlices": round(ratio / projected, 6),
                      "renderedZeroPhaseDiskRatio": round(rendered, 6)},
            "method": "Projected-area slice weights [0.5, 1, 0.5] on each hemisphere; "
                      "rendered disk ratio uses the Lambert slice_factor kernel cos²(longitude - centre). "
                      "frame.ts normalizes law × map at each viewing geometry, leaving disk brightness "
                      "to these slices; the map-only ratio is not the rendered disk ratio."}
    return d


def feature_check(v: np.ndarray, known: np.ndarray, level: int, f: Feature, radius_km: float) -> dict:
    """Contrast of the feature against its surroundings at the east-longitude position and at the mirrored
    (west-read-as-east) position."""
    def contrast(lon):
        inner = _disk_patch_mean(v, known, level, f.lat, lon, f.radius_km, radius_km)
        outer = _disk_patch_mean(v, known, level, f.lat, lon, 0, radius_km, (2 * f.radius_km, 4 * f.radius_km))
        return inner / outer
    east, mirrored = contrast(f.lon_e), contrast(-f.lon_e)
    ok = (east < min(0.95, mirrored)) if f.kind == "dark" else (east > max(1.05, mirrored))
    return {"feature": f.name, "latDeg": f.lat, "lonEastDeg": round(((f.lon_e + 180) % 360) - 180, 2),
            "coordinates": f.ref, "expected": f.kind, "contrastAtFeature": round(east, 3),
            "contrastAtMirroredLongitude": round(mirrored, 3), "passed": bool(ok)}


def build_one(ctx: BuildContext, pm: PanMap) -> dict:
    from .photometry.albedo import pck_radii
    radius_km = float(np.cbrt(np.prod(pck_radii()[pm.naif])))
    subdir = f"surfaces/{pm.name.lower()}"
    path = fetch(USGS + pm.file, subdir)
    rec = record(path)
    grid, nodata, info = geotiff_grid(path)
    if info["dtype"] != "uint8":
        raise ValueError(f"{pm.file}: expected an 8-bit mosaic, got {info['dtype']}")
    data = tifffile.memmap(path)
    level = pm.level
    h, w = st.level_shape(level)
    num = np.zeros((h, w), np.float32)
    den = np.zeros((h, w), np.float32)
    encoding = info["pixelEncoding"]
    if pm.stretch:
        d0, d1, v0, v1 = pm.stretch
        slope = (v1 - v0) / (d1 - d0)
        transform = lambda b: (np.float32(v0) + (b.astype(np.float32) - np.float32(d0)) * np.float32(slope))  # noqa: E731
    elif encoding["documented"]:
        transform = lambda b: (b.astype(np.float32) * np.float32(encoding["scale"])
                               + np.float32(encoding["offset"]))  # noqa: E731
    else:
        transform = None
    c = sg.accumulate_chunked(num, den, data, grid, level, lambda b: b != nodata, transform)
    hist = np.bincount(np.asarray(data[:: max(1, data.shape[0] // 400)]).ravel(), minlength=256)
    del data
    if not pm.keep_raw:
        discard(path)
    v, known = sg.finish(num, den, 0.5)
    if np.any(v[known] <= 0):
        raise ValueError(f"{pm.file}: decoded known pixels must have positive relative reflectance")
    m = float(st.disk_mean(v, known, level)[0])
    ratio = v / np.float32(m)
    top = np.repeat(ratio[..., None], 4, axis=2)
    top[~known] = 0
    if pm.feature is not None:
        check = feature_check(ratio, known, level, pm.feature, radius_km)
        if not check["passed"]:
            raise ValueError(f"{pm.name}: georeferencing check failed: {check}")
    else:
        check = {"passed": None, "note": "no named albedo feature with enough contrast was selected for this body; "
                                         "orientation relies on the producer's GeoTIFF georeferencing"}
    lead_trail = hemisphere_ratio(ratio, known, level, 270.0, 90.0) if pm.naif < 900 else None
    from .paths import OUT
    photometry_path = OUT / "photometry.json"
    model = (json.loads(photometry_path.read_text()).get(str(pm.naif), {}).get("diskReflectanceModel")
             if lead_trail is not None and photometry_path.exists() else None)
    pos = np.nonzero(hist[1:])[0] + 1
    cdf = np.cumsum(hist[1:]) / hist[1:].sum()
    dn = {"min": int(pos.min()), "p1": int(np.searchsorted(cdf, 0.01) + 1), "median": int(np.searchsorted(cdf, 0.5) + 1),
          "p99": int(np.searchsorted(cdf, 0.99) + 1), "max": int(pos.max()),
          "fractionAt255": float(hist[255] / hist[1:].sum())}
    sl.register_dataset(ctx, pm.src_id, pm.title, pm.citation, USGS + pm.file, {path.name: rec},
                        license="public domain (USGS/NASA)",
                        notes=f"8-bit equirectangular GeoTIFF {info['shape'][1]} × {info['shape'][0]} on a "
                              f"{info['radiusM'] / 1000:g} km sphere ({info['ascii'].split('|')[0]}); nodata DN "
                              f"{nodata:g}.")
    spec = sl.LayerSpec(
        naif=pm.naif, body=pm.name, layer="albedo", kind="relative-reflectance", fmt="f16", channels=["X", "Y", "Z", "S"],
        frame={"name": f"IAU_{pm.name.upper()}",
               "note": "USGS mosaic in planetocentric latitude / east longitude on a sphere (GeoTIFF tags)"
                       + (f"; east-longitude orientation verified with {pm.feature.name}." if pm.feature else ".")},
        sources=[pm.src_id],
        brightness=sl.Provenance("estimated", [pm.src_id],
                                 (f"The documented linear 8-bit stretch (DN {pm.stretch[0]}-{pm.stretch[1]} ↔ "
                                  f"{pm.stretch[2]}-{pm.stretch[3]}) was inverted, the values box-averaged to level "
                                  f"{level} and divided by their disk mean. The underlying mosaic mixes images of very "
                                  "different resolution and photometric geometry; values beyond the stretch limits are "
                                  "clipped." if pm.stretch else
                                  f"Texel = decoded value / disk-mean decoded value, with value = DN × "
                                  f"{encoding['scale']:.10g} + ({encoding['offset']:.10g}) "
                                  + ("from GeoTIFF GDAL_METADATA (also ISIS Pixels.Multiplier/Base). "
                                     if encoding["documented"] else "(identity; no GDAL scale/offset supplied). ")
                                  + "Producer's photometrically normalized, "
                                  "overlap-matched 8-bit mosaic, box-averaged to level "
                                  f"{level}. Assumes tone-matched values ∝ relative reflectance at all spatial scales; "
                                  "mixed filters and topographic shading prevent a measured albedo label."),
                                 (f"stretch limits clip {dn['fractionAt255'] * 100:.2f} % of pixels at DN 255; "
                                  if pm.stretch else "per-image tone corrections and reference geometry unavailable; ")
                                 + f"DN distribution p1 {dn['p1']}, median {dn['median']}, p99 {dn['p99']}; seams and "
                                   "resolution changes between source images remain"),
        color=sl.Provenance("estimated", [pm.src_id],
                            "Panchromatic map: the same relative variation in all four channels, i.e. the local colour "
                            "is the disk-average colour from photometry.json (colour variations not measured here)."),
        regions=[sl.Region(-90, 90, -180, 180, sl.Provenance("estimated", [pm.src_id], pm.title),
                           note="Pixels with DN 0 (no data) are unknown.")],
        epoch={"observed": pm.observed},
        normalization={"weighting": "cos²(lat) projected area at zero phase, equatorial observer, rotation-averaged; "
                                    "known texels only", "diskMeanDN": round(
                                        (m - encoding["offset"]) / encoding["scale"] if not pm.stretch else m, 4),
                       "pixelEncoding": encoding,
                       "diskMeanDecodedValue": m,
                       "texelDiskMeanCheck": [round(float(x), 5) for x in st.disk_mean(top, known, level)]},
        diagnostics={"georeferencing": check, "dnStatistics": dn,
                     **({"leadingOverTrailing": leading_trailing_diagnostic(lead_trail, model)}
                        if lead_trail is not None else {}),
                     "sourceValidFraction": c["validPixels"] / c["totalPixels"]},
        notes=list(pm.notes),
    )
    return sl.write_layer(ctx, spec, top, known, level)


def build(ctx: BuildContext, work: Path, maps: list[PanMap] | None = None) -> list[dict]:
    return [build_one(ctx, pm) for pm in (maps or MAPS)]
