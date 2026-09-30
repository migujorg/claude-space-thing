"""Jupiter, Saturn, Uranus, Neptune: Hubble OPAL global maps (Simon et al. 2015; MAST HLSP, doi:10.17909/T9G593).

Each OPAL map is one planet rotation in one WFC3/UVIS filter, cylindrical, cell-registered, planetographic latitude
−90…+90 (north up), 360° of longitude. The limb darkening has been removed by the OPAL team with a Minnaert law
(per-filter k in the cycle README), so the values are Minnaert albedos ∝ the reflectance at normal incidence and
emission at the observing phase (≤ 11° for Jupiter, less further out). FITS × the README scale factor = I/F.

We take the latest epoch (the later rotation of the newest cycle), convert planetographic to planetocentric
latitude on the OPAL navigation ellipsoid (radii from the README), convert System III west longitude (Jupiter,
Saturn, Neptune: "left edge = 0/360 W, decreasing to the right") or east longitude (Uranus: "right edge = 0 E,
increasing to the left") to east longitude, and combine the limb-corrected continuum filters inside the visible
range into XYZS per surf_color. Filters without a Minnaert correction ("none" in the README) and methane-band
filters (FQ619N, FQ727N, FQ889N) are not used as colour bands. Latitudes that Earth sees only at emission angles
> 72.5° (cos e < MU_MIN even at central-meridian passage, from the sub-Earth latitude at the map epoch) are left
unknown: the Minnaert limb correction diverges there.
"""

from __future__ import annotations

import datetime as _dt
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from astropy.io import fits

from . import surf_color as sc
from . import surf_grid as sg
from . import surf_layers as sl
from . import surf_tiles as st
from .download import fetch, record
from .schema import BuildContext

BASE = "https://archive.stsci.edu/hlsps/opal/"
METHANE_BANDS = {"FQ619N", "FQ727N", "FQ889N"}
# Limb cut: texels whose emission angle exceeds this even at central-meridian passage are set unknown. The Minnaert
# limb correction (division by μ0^k μ^(k-1)) diverges towards the limb and the OPAL maps show filter-dependent
# artefacts there (e.g. Neptune's northern edge).
MU_MIN = 0.3
SRC_PREFIX = "opal"


@dataclass(frozen=True)
class Planet:
    naif: int
    name: str
    cycle: int
    epoch: str        # e.g. "2025b"
    readme: str       # README file name in the cycle directory
    west_left_edge: bool  # True: W longitude, left edge = 0/360 W decreasing to the right; False: Uranus convention


PLANETS = [
    Planet(599, "Jupiter", 32, "2025b", "hlsp_opal_hst_wfc3-uvis_jupiter-2025_all_v1_readme.txt", True),
    Planet(699, "Saturn", 32, "2025b", "hlsp_opal_hst_wfc3-uvis_saturn-2025_all_v1_readme.txt", True),
    Planet(799, "Uranus", 33, "2025b", "hlsp_opal_hst_wfc3-uvis_uranus-2025_all_v1_readme.txt", False),
    Planet(899, "Neptune", 32, "2025c", "hlsp_opal_hst_wfc3-uvis_neptune-2025b_all_v1_readme.txt", True),
]

# Filters present per planet and epoch (MAST directory listings, checked 2026-09-30).
FILTERS = {
    599: ["F395N", "F467M", "F502N", "F631N", "F658N", "F275W", "F343N", "FQ889N"],
    699: ["F395N", "F467M", "F502N", "F631N", "F763M", "F225W", "FQ727N", "FQ889N"],
    799: ["F467M", "F547M", "F657N", "F763M", "F845M", "FQ619N", "FQ727N"],
    899: ["F467M", "F547M", "F657N", "F763M", "F845M", "FQ619N", "FQ727N"],
}


def planet_dir(p: Planet) -> str:
    return f"{BASE}cycle{p.cycle}/{p.name.lower()}/"


def map_name(p: Planet, filt: str, epoch: str | None = None) -> str:
    return f"hlsp_opal_hst_wfc3-uvis_{p.name.lower()}-{epoch or p.epoch}_{filt.lower()}_v1_globalmap.fits"


def parse_readme(text: str) -> dict:
    """Minnaert k (None where 'none') and I/F scale per filter, navigation radii, acquisition window text."""
    out = {"filters": {}}
    for m in re.finditer(r"^\s*(F[QW]?\d{3}[A-Z]{1,2})\s+([0-9.]+|none)\s+([0-9.]+)\s*$", text, re.M):
        k = None if m.group(2) == "none" else float(m.group(2))
        out["filters"][m.group(1).upper()] = {"minnaertK": k, "ifScale": float(m.group(3))}
    m = re.search(r"equatorial and polar radii of\s+([0-9.]+)\s+and\s+([0-9.]+)\s*km", text)
    out["radiiKm"] = (float(m.group(1)), float(m.group(2)))
    m = re.search(r"acquired with WFC3/UVIS between (.*?)(?:\n|$)", text)
    out["acquired"] = m.group(1).strip() if m else None
    return out


def centre_nm(filt: str) -> float:
    return float(re.search(r"(\d{3})", filt).group(1))


def graphic_to_centric(lat_g_deg: np.ndarray, a: float, b: float) -> np.ndarray:
    return np.degrees(np.arctan((b / a) ** 2 * np.tan(np.radians(lat_g_deg))))


def prepare(data: np.ndarray, west_left_edge: bool, a: float, b: float) -> tuple[np.ndarray, sg.EdgeGrid, str]:
    """Reorder a map to east longitude increasing to the right and give its pixel edges (planetocentric).

    W convention (Jupiter, Saturn, Neptune: left edge = 0/360 W, W decreasing to the right): column j is at
    W = 360 − j·d, i.e. east longitude j·d — already east order. Uranus (right edge = 0 E, E increasing to the left):
    the columns are reversed. Even-sized maps (3600 × 1800, 1800 × 900) are cell-registered (edges at 0 and 360,
    ±90); odd-sized ones (721 × 361) are node-registered (samples at 0, d, …, 360 and −90 … 90): the duplicated
    360° column is dropped and polar rows are half cells."""
    ny, nx = data.shape
    if not west_left_edge:
        data = data[:, ::-1]
    if nx % 2 == 1:
        data = data[:, :-1]
        nx -= 1
        d = 360.0 / nx
        lon_e = -d / 2 + d * np.arange(nx + 1)
        dl = 180.0 / (ny - 1)
        lat_g = np.clip(90.0 + dl / 2 - dl * np.arange(ny + 1), -90.0, 90.0)
        reg = "node-registered (721 × 361)"
    else:
        lon_e = 360.0 / nx * np.arange(nx + 1)
        lat_g = 90.0 - 180.0 / ny * np.arange(ny + 1)
        reg = f"cell-registered ({nx} × {ny})"
    lat_c = graphic_to_centric(lat_g, a, b)
    return np.ascontiguousarray(data), sg.EdgeGrid(tuple(lat_c), tuple(lon_e)), reg


def sub_observer_latitude(ctx: BuildContext, naif: int, utc: str) -> tuple[float, list[str]]:
    """Latitude (degrees) of the Earth direction in the IAU body frame at `utc` (light-time corrected), i.e. the
    planetographic latitude of the sub-Earth point, from DE442s and pck00011."""
    import spiceypy as sp

    from . import ephem_kernels as ek
    paths = [ek.lsk(ctx), ek.planetary(ctx), ek.pck(ctx)]
    with ek.pool(*paths):
        et = sp.str2et(utc.replace("Z", ""))
        pos, lt = sp.spkpos(str(naif // 100), et, "J2000", "LT+S", "399")
        rot = np.array(sp.pxform("J2000", f"IAU_{sp.bodc2n(naif)}", et - lt))
        v = -(rot @ np.array(pos))
    return float(np.degrees(np.arcsin(v[2] / np.linalg.norm(v)))), [ek.SRC_LSK, ek.SRC_PLANETARY, ek.SRC_PCK]


def mjd_to_iso(mjd: float) -> str:
    t = _dt.datetime(1858, 11, 17, tzinfo=_dt.timezone.utc) + _dt.timedelta(days=mjd)
    return t.isoformat(timespec="seconds").replace("+00:00", "Z")


def jet_shift_check(p: Planet, subdir: str, readme: dict) -> dict:
    """Longitude-direction check for Jupiter: cross-correlate the 23.7°N (planetographic) prograde jet between the
    two rotations of the same cycle in F631N. Prograde (eastward) motion must appear as increasing east longitude."""
    a_km, b_km = readme["radiiKm"]
    a = prepare(fits.getdata(fetch(planet_dir(p) + map_name(p, "F631N", "2025a"), subdir)).astype(float),
                p.west_left_edge, a_km, b_km)[0]
    b = prepare(fits.getdata(fetch(planet_dir(p) + map_name(p, "F631N", "2025b"), subdir)).astype(float),
                p.west_left_edge, a_km, b_km)[0]
    ny, nx = b.shape
    y = int((90 - 23.7) / 180 * ny)
    ra, rb = a[y - 5:y + 5].mean(0), b[y - 5:y + 5].mean(0)
    c = np.fft.irfft(np.fft.rfft(rb - rb.mean()) * np.conj(np.fft.rfft(ra - ra.mean())))
    k = int(np.argmax(c))
    shift = (k if k < nx // 2 else k - nx) * 360.0 / nx
    ha, hb = fits.getheader(fetch(planet_dir(p) + map_name(p, "F631N", "2025a"), subdir)), fits.getheader(
        fetch(planet_dir(p) + map_name(p, "F631N", "2025b"), subdir))
    dt_h = (hb["EXPSTART"] - ha["EXPSTART"]) * 24
    return {"latitudePlanetographicDeg": 23.7, "eastwardShiftDeg": shift, "hoursBetweenMaps": round(dt_h, 2),
            "expected": "eastward (the 23.7°N jet is prograde, ~150 m/s ≈ +4.4° per 9.4 h)",
            "passed": bool(shift > 1.0)}


def build_planet(ctx: BuildContext, p: Planet) -> dict:
    from .photometry import bodies, solar

    subdir = f"surfaces/opal/{p.name.lower()}"
    rd_path = fetch(planet_dir(p) + p.readme, subdir)
    readme = parse_readme(rd_path.read_text(encoding="latin-1"))
    a_km, b_km = readme["radiiKm"]
    colour, skipped = [], {}
    for f in FILTERS[p.naif]:
        info = readme["filters"].get(f)
        c = centre_nm(f)
        if info is None:
            skipped[f] = "not in README table"
        elif f in METHANE_BANDS:
            skipped[f] = "methane absorption band filter (samples a band, not the continuum)"
        elif info["minnaertK"] is None:
            skipped[f] = "no limb-darkening (Minnaert) correction applied by OPAL"
        elif not (360 <= c <= 830):
            skipped[f] = "outside 360-830 nm"
        else:
            colour.append(f)
    colour.sort(key=centre_nm)
    files, headers, maps = {rd_path.name: record(rd_path)}, {}, {}
    for f in colour:
        path = fetch(planet_dir(p) + map_name(p, f), subdir)
        files[path.name] = record(path)
        with fits.open(path) as hd:
            d = np.asarray(hd[0].data, np.float32)
            headers[f] = dict(hd[0].header)
        maps[f], grid, registration = prepare(d, p.west_left_edge, a_km, b_km)
    ny, nx = maps[colour[0]].shape
    level = st.level_for_resolution(nx)
    h, w = st.level_shape(level)
    mid = mjd_to_iso(0.5 * (min(headers[f]["EXPSTART"] for f in colour) + max(headers[f]["EXPEND"] for f in colour)))
    sub_lat, eph_src = sub_observer_latitude(ctx, p.naif, mid)
    lat_g_edges = np.degrees(np.arctan(np.tan(np.radians(grid.lat_edges())) * (a_km / b_km) ** 2))
    lat_g = 0.5 * (lat_g_edges[1:] + lat_g_edges[:-1])
    row_ok = np.cos(np.radians(np.abs(lat_g - sub_lat))) >= MU_MIN
    bands, known = [], np.ones((h, w), bool)
    for f in colour:
        num = np.zeros((h, w), np.float32)
        den = np.zeros((h, w), np.float32)
        d = maps[f]
        valid = np.isfinite(d) & (d > 0) & row_ok[:, None]
        sg.accumulate(num, den, np.where(valid, d, 0), valid, grid, level)
        v, k = sg.finish(num, den, 0.5)
        bands.append(v * np.float32(readme["filters"][f]["ifScale"]))
        known &= k
    means = sl.normalize_bands(bands, known, level)
    body = bodies.build_body(p.naif)
    e = solar.spectrum().grid
    centres = [centre_nm(f) for f in colour]
    W = sc.channel_weights(centres, body.p_grid, e)
    diag = sc.diagnostics(centres, body.p_grid, e)
    ratios = [b / np.float32(m) for b, m in zip(bands, means)]
    top = np.zeros((h, w, 4), np.float32)
    sl.xyzs_from_ratios(ratios, W, known, top)
    rng = np.random.default_rng(p.naif)
    jj, ii = np.nonzero(known)
    pick = rng.choice(jj.size, size=min(4000, jj.size), replace=False)
    spread = sc.interpolation_spread(np.array([[r[jj[q], ii[q]] for r in ratios] for q in pick]), centres,
                                     body.p_grid, e)
    check = st.disk_mean(top, known, level)
    starts = [headers[f]["EXPSTART"] for f in colour]
    ends = [headers[f]["EXPEND"] for f in colour]
    epoch = {"start": mjd_to_iso(min(starts)), "end": mjd_to_iso(max(ends)),
             "mid": mjd_to_iso(0.5 * (min(starts) + max(ends))),
             "perFilter": {f: {"start": mjd_to_iso(headers[f]["EXPSTART"]), "end": mjd_to_iso(headers[f]["EXPEND"])}
                           for f in colour},
             "changes": "cloud features evolve and drift in longitude relative to the rotation system (zonal winds "
                        "up to ~150 m/s on Jupiter, ~400 m/s on Saturn, ~250 m/s on Uranus, ~400 m/s on Neptune); "
                        "rendering at another time is 'estimated' and the age of the map should be shown."}
    diagnostics = {"filtersNotUsedForColour": skipped, "sourceSize": [nx, ny], "registration": registration,
                   "limbCut": {"subEarthLatitudeDeg": round(sub_lat, 2), "muMin": MU_MIN,
                               "keptPlanetographicLatitudes": [round(float(lat_g[row_ok].min()), 2),
                                                               round(float(lat_g[row_ok].max()), 2)],
                               "rule": "rows with cos|φg − sub-Earth latitude| < muMin (emission > 72.5° even at "
                                       "central-meridian passage) are unknown"}}
    if p.naif == 599:
        diagnostics["longitudeDirectionCheck"] = jet_shift_check(p, subdir, readme)
        n = map_name(p, "F631N", "2025a")
        files[n] = record(fetch(planet_dir(p) + n, subdir))
    sid = f"{SRC_PREFIX}-{p.name.lower()}-{p.epoch}"
    lic = headers[colour[0]].get("LICENSE", "CC BY 4.0")
    attr = headers[colour[0]].get("LIC_ATTR", "NASA, ESA, A.A. Simon, M.H. Wong")
    sl.register_dataset(
        ctx, sid, f"Hubble OPAL global maps of {p.name}, {p.epoch} (cycle {p.cycle}), filters {', '.join(colour)}",
        "Simon, A. A., Wong, M. H. & Orton, G. S. (2015). First results from the Hubble OPAL program: Jupiter in 2015. "
        "ApJ 812, 55. doi:10.1088/0004-637X/812/1/55. Data: Outer Planet Atmospheres Legacy (OPAL) High Level "
        "Science Product, MAST, doi:10.17909/T9G593 (PI A. A. Simon). See also Wong, M. H. et al. (2020), ApJS "
        "247, 58, doi:10.3847/1538-4365/ab775f.",
        planet_dir(p), files, version=f"cycle {p.cycle}, map {p.epoch}, HLSP v1", license=f"{lic} (attribution: {attr})",
        notes=f"Acquired {readme['acquired']}. Navigation ellipsoid {a_km:g} × {b_km:g} km. Minnaert k / I/F scale "
              "per filter: " + ", ".join(f"{f} {readme['filters'][f]['minnaertK']}/{readme['filters'][f]['ifScale']}"
                                         for f in colour) + ". The README is part of the dataset (parsed for the "
                                                            "table and radii).")
    src_color = list(dict.fromkeys([sid, *body.entry["geometricAlbedoXYZS"]["sources"]]))
    diagnostics.update({"color": diag.to_json(), "interpolationSpread": spread})
    lat_known = st.lat_centers(level)[known.any(axis=1)]
    spec = sl.LayerSpec(
        naif=p.naif, body=p.name, layer="albedo", kind="relative-reflectance", fmt="f16", channels=list(sc.CHANNELS),
        frame={"name": f"IAU_{p.name.upper()}",
               "longitudeSystem": {599: "System III (1965.0)", 699: "System III (Voyager radio period)",
                                   799: "IAU rotation model (Voyager radio period)",
                                   899: "IAU rotation model (Voyager radio period)"}[p.naif],
               "sourceLatitude": f"planetographic on the {a_km:g} × {b_km:g} km ellipsoid, converted to "
                                 "planetocentric (tan φc = (b/a)² tan φg)",
               "note": "cloud-top map at the 1-bar-ish visible cloud level; the ellipsoid is the OPAL navigation one "
                       "(pck00011 radii for Jupiter/Saturn are the same)."},
        sources=[sid, *body.entry["geometricAlbedoXYZS"]["sources"], *eph_src],
        brightness=sl.Provenance("measured", [sid, *eph_src],
                                 f"OPAL Minnaert-corrected maps (limb darkening removed by the OPAL team with k per "
                                 f"filter), resampled to level {level} (box filter where coarser, linear where finer); "
                                 "a texel is the ratio of the local reflectance to its disk average in each band. "
                                 f"Latitudes seen at emission > 72.5° even at central-meridian passage (sub-Earth "
                                 f"latitude {sub_lat:+.1f}° at the map epoch, DE442s + pck00011) are left unknown "
                                 "because the limb correction diverges there."),
        color=sl.Provenance(diag.label, src_color,
                            f"Band ratios at {', '.join(f'{c:g}' for c in centres)} nm (nominal filter wavelengths) "
                            "interpolated linearly and held flat outside, times the disk-integrated albedo spectrum, "
                            "integrated against sunlight and the CIE observers. " + diag.reason,
                            "linear vs monotone-cubic interpolation: 99th percentile |Δ| "
                            + ", ".join(f"{k} {v['p99'] * 100:.2f} %" for k, v in spread.items())),
        regions=[sl.Region(float(lat_known.min()) if lat_known.size else 0.0,
                           float(lat_known.max()) if lat_known.size else 0.0, -180, 180,
                           sl.Provenance("measured", [sid], "OPAL coverage (latitudes seen from Earth)"),
                           note="Texels outside the OPAL coverage or beyond the limb cut (regions seen only at "
                                "grazing emission from Earth at this epoch) are unknown.")],
        epoch=epoch,
        normalization={"weighting": "cos²(lat): projected area at zero phase, observer in the equatorial plane, "
                                    "averaged over rotation; known texels only",
                       "bandDiskMeanIoverF": {f: round(m, 6) for f, m in zip(colour, means)},
                       "channelWeights": {"bandsNm": centres, "W": [[round(float(x), 6) for x in r] for r in W]},
                       "texelDiskMeanCheck": [round(float(x), 5) for x in check]},
        diagnostics=diagnostics,
        notes=[f"Source maps are {nx} × {ny} ({360 / nx:g}°/px); level {level} is {st.level_shape(level)[1]} × "
               f"{st.level_shape(level)[0]}.",
               "OPAL mosaics are stitched from several HST orbits within one rotation; seams were smoothed by the "
               "OPAL team where needed."] + ({699: ["Moons and moon shadows crossing the disk during the observation "
                                                    "are in the map (README); Saturn's rings, near edge-on in 2025, "
                                                    "and their shadow may affect equatorial texels."],
                                              799: ["Uranus's southern hemisphere is in darkness/unseen around the "
                                                    "2030 northern solstice; it is unknown here."]}.get(p.naif, [])),
    )
    return sl.write_layer(ctx, spec, top, known, level)


def build(ctx: BuildContext, work: Path) -> list[dict]:
    return [build_planet(ctx, p) for p in PLANETS]
