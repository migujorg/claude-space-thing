"""Earth (NAIF 399): surface albedo, water, clouds, night lights (docs/architecture.md §4.4; research note m2 1c).

Every Earth layer is dated. All inputs are public and need no login.

clouds  NASA Langley's SatCORPS Global Cloud Composite (GEO-LEO, V2; satcorps.py): each longitude from the hourly
        file nearest 13:30 local solar time of one UTC day, 24 strips with hard cuts. Cloud fraction (every cloud
        class), mean optical depth and ice share of the cells with a thickness retrieved from sunlight, mean
        cloud-top height; aggregated to level 4 (4.9 km) by area overlap of the 1/36° cells.
cloudTau, cloudTauEstimated  From the same cells: the share with a thickness and the ln τ sums of it, for the
        cells with a measured thickness (Strict) and for those with a measured or an estimated one (Best,
        Complete). Cloud without either is cloud of unmeasured thickness at every level.
night   VIIRS (NOAA-20) Black Marble gap-filled, lunar-BRDF-corrected nighttime-light radiance VJ146A2 (Román et al.
        2018) of one day, decoded from its GIBS colour map (bins 0.1 nW cm⁻² sr⁻¹ wide below 5, up to 0.6 near the
        top, open-ended above 38.2: those samples are lower bounds and counted in a censored-fraction channel). The
        header gives the factors that turn Day/Night-Band radiance into X, Y, Z, S luminance for CIE lamp spectra
        (an assumption: the spectrum of the light is not measured).
albedo  Nadir reflectance factor relative to its disk mean (XYZS; the absolute disk means are in the header): land
        from the MODIS MCD43A4 v061 nadir BRDF-adjusted reflectance (Schaaf et al. 2002; Planetary Computer
        cloud-optimized copies), water from the ESA Ocean Colour CCI v6.0 monthly remote-sensing reflectance
        (ρw = π Rrs). See `build_albedo`.
water   Fraction of each texel that is water (ocean and inland water) and the sea-ice concentration, so the renderer
        can add Fresnel reflection and sun glint (not part of the albedo) where they apply.
"""

from __future__ import annotations

import concurrent.futures as cf
import datetime as _dt
import hashlib
import json
import threading
import time
import urllib.parse
import zipfile
from pathlib import Path

import numpy as np

from . import cie
from . import download
from . import satcorps
from . import surf_cog
from . import surf_gibs as gb
from . import surf_layers as sl
from . import surf_tiles as st
from .download import fetch, record
from .schema import BuildContext, sourced
from .surf_fetch import discard

NAIF = 399
NAME = "Earth"
SUBDIR = "surfaces/earth"
LEVEL = 4
SAMPLES = 4                      # WMS pixels per texel along each axis (GIBS layers: 1.1 km samples for 4.9 km texels)
L_DNB = "VIIRS_NOAA20_GapFilled_BRDF_Corrected_DayNightBand_Radiance"

FRAME = {"name": "IAU_EARTH (≈ ITRF93 at this resolution)",
         "sourceLatitude": "WGS84 geodetic (all sources); texel rows are resampled to planetocentric latitude "
                           "(nearest row, shift ≤ 0.19°)",
         "note": "Longitudes are WGS84/ITRF; the IAU_EARTH rotation model (no nutation, UT1 or polar motion) "
                 "matches ITRF to ≲ 40″, a fraction of a level-4 texel (0.044°)."}

SOLAR_SOURCE = "tsis1-hsrs-v2"   # registered by the light stage (photometry.solar)
SRC_GIBS = "nasa-gibs"
SRC_VJ146 = "viirs-noaa20-vj146a2"
SRC_DNB_RSR = "noaa20-viirs-dnb-rsr"
SRC_CIE_HP = "cie-illuminants-hp"
SRC_CIE_LED = "cie-illuminants-led"


# ---------------------------------------------------------------------------------------------- helpers


def _fetch_blocks(layer: str, day: str) -> list[tuple[tuple, int, int, Path]]:
    """Download the 16 WMS blocks of a layer (4 in parallel; download.fetch is thread-safe)."""
    h, w = st.level_shape(LEVEL)
    bw, bh = w * SAMPLES // 4, h * SAMPLES // 4
    items = list(gb.blocks(4, 4))
    with cf.ThreadPoolExecutor(4) as ex:
        paths = list(ex.map(lambda it: gb.getmap(layer, day, it[0], bw, bh), items))
    return [(it[0], it[1], it[2], p) for it, p in zip(items, paths)]


def _reshape_blocks(a: np.ndarray) -> np.ndarray:
    """(H·S, W·S) block → (H, W, S·S) samples per texel."""
    hh, ww = a.shape[0] // SAMPLES, a.shape[1] // SAMPLES
    return a.reshape(hh, SAMPLES, ww, SAMPLES).transpose(0, 2, 1, 3).reshape(hh, ww, SAMPLES * SAMPLES)


WGS84_F = 1 / 298.257223563


def geodetic_from_centric(lat_deg):
    """WGS84 geodetic latitude of a planetocentric latitude (tan φg = tan φc / (1 − f)²)."""
    return np.degrees(np.arctan(np.tan(np.radians(lat_deg)) / (1 - WGS84_F) ** 2))


def centric_from_geodetic(lat_deg):
    return np.degrees(np.arctan(np.tan(np.radians(lat_deg)) * (1 - WGS84_F) ** 2))


def centric_rows(level: int) -> np.ndarray:
    """For each planetocentric texel row, the row of the same-size grid in WGS84 geodetic latitude (all Earth
    products are on geodetic latitude) that contains its centre: `planetocentric = geodetic[centric_rows]`.
    Nearest-row resampling, so positions are within half a texel; the shift is up to 0.19° (≈ 4 level-4 rows)."""
    h, _ = st.level_shape(level)
    g = geodetic_from_centric(st.lat_centers(level))
    return np.clip(np.floor((90.0 - g) / (180.0 / h)).astype(np.int64), 0, h - 1)


def solar_declination_deg(day: str) -> float:
    """Solar declination at noon UTC of `day` (Spencer 1971 Fourier series, J. Opt. Soc. Am. 61, 1159), only used to
    place the Sun of 13:30 local time in the cloud layers' diagnostics (not a data value)."""
    d = _dt.date.fromisoformat(day)
    g = 2 * np.pi * (d.timetuple().tm_yday - 1) / 365.0
    dec = (0.006918 - 0.399912 * np.cos(g) + 0.070257 * np.sin(g) - 0.006758 * np.cos(2 * g)
           + 0.000907 * np.sin(2 * g) - 0.002697 * np.cos(3 * g) + 0.00148 * np.sin(3 * g))
    return float(np.degrees(dec))


def _register_gibs(ctx: BuildContext) -> str:
    caps = gb.capabilities()
    return sl.register_dataset(
        ctx, SRC_GIBS, "NASA Global Imagery Browse Services (GIBS) WMTS/WMS and colour maps",
        "NASA Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System "
        "(ESDIS). https://earthdata.nasa.gov/gibs. Colour maps: https://gibs.earthdata.nasa.gov/colormaps/v1.3/.",
        gb.CAPS, {caps.name: record(caps)}, license="NASA data policy (no restrictions on use; cite GIBS)",
        notes=f"Capabilities snapshot pinned to {gb.CAPS_SNAPSHOT}; layer images are fetched by WMS GetMap and decoded through "
              "the layer's colour map (see the layer sources).")


# ---------------------------------------------------------------------------------------------- clouds


CLOUD_DAY = "2026-09-28"         # the UTC day of the cloud mosaic: the wind layer and the validation case earth-himawari9-2026 use it
TAU_LAYER = "cloudTau"
TAU_ESTIMATED_LAYER = "cloudTauEstimated"
G_LIQUID, G_ICE = 0.867, 0.75    # the asymmetry parameters of the renderer's cloud (docs/rendering-earth.md §2); diagnostics only
SWATH = (-40.0, 40.0, 125.0, 160.0)  # lat/lon box of the validation case's swath (Himawari-9, docs/rendering-earth.md §2)
SRC_SATCORPS = "satcorps-gcc-geoleo"
SATCORPS_CITATION = (
    "NASA Langley Research Center, SatCORPS Group: SatCORPS Global Cloud Composite, GEO-LEO global product, version 2 "
    "(file attribute `version`: SatCORPS V2.30; composite algorithm 4.09f). https://satcorps.larc.nasa.gov. "
    "Algorithm: Minnis, P., et al. (2008), Near-real time cloud retrievals from operational and research "
    "meteorological satellites, Proc. SPIE 7107, 710703, doi:10.1117/12.800344; Minnis, P., et al. (2021), CERES MODIS "
    "cloud product retrievals for Edition 4, Part I: Algorithm changes, IEEE Trans. Geosci. Remote Sens. 59, 2744-2780, "
    "doi:10.1109/TGRS.2020.3008866. Composite: Khlopenkov, K., et al. (2017), Development of multi-sensor global cloud "
    "and radiance composites for Earth radiation budget monitoring from DSCOVR, Proc. SPIE 10424, 104240K, "
    "doi:10.1117/12.2278645.")


def _serves(info: dict, day: str) -> bool:
    """Whether a GIBS layer advertises `day` in its time periods ('start/end/P1D' or single dates)."""
    for p in info["periods"]:
        parts = p.split("/")
        if (len(parts) >= 2 and parts[0][:10] <= day <= parts[1][:10]) or parts[0][:10] == day:
            return True
    return False


def cloud_plane_albedo(tau, g, mu0):
    """δ-Eddington plane albedo of a conservative layer over a black surface (as app/src/render/earth.ts)."""
    tt = (1 - g) * tau
    tp = (1 - g * g) * tau
    m = np.maximum(mu0, 1e-4)
    return np.clip((tt + (2 / 3 - m) * (1 - np.exp(-tp / m))) / (4 / 3 + tt), 0, 1)


def _local_mu0(lat_deg: np.ndarray, day: str) -> np.ndarray:
    """cos of the solar zenith angle at 13:30 local solar time (diagnostics only; 0 where the Sun is at or beyond
    the product's daytime limit)."""
    lat = np.radians(lat_deg)
    dec = np.radians(solar_declination_deg(day))
    hour = np.radians(15.0 * (satcorps.LOCAL_SOLAR_HOUR - 12.0))
    mu = np.sin(lat) * np.sin(dec) + np.cos(lat) * np.cos(dec) * np.cos(hour)
    return np.where(mu > np.cos(np.radians(satcorps.DAY_SZA_DEG)), mu, 0.0)


class _TauDiagnostics:
    """How well the layer's ln τ moments give the cloud's plane albedo, against the independent-pixel mean over the
    cells with a measured thickness (Cahalan et al. 1994), per texel (level 4) and per level-0 texel (16 × 16
    level-4 texels, aggregated as the pyramid does). Sums are weighted by μ0 (reflected flux) and cos(latitude) (area)."""

    APPROX = ("linearMeanTau", "logMeanTau", "logNormal3")

    def __init__(self):
        self.sums: dict[str, dict[str, float]] = {}

    def _add(self, key: str, name: str, v: float) -> None:
        self.sums.setdefault(key, {}).setdefault(name, 0.0)
        self.sums[key][name] += float(v)

    @staticmethod
    def approximations(f, m1, m2, fl, fice, mu0) -> dict[str, np.ndarray]:
        """Plane albedo × measured share from the moments (f: share, m1, m2: ln τ sums per unit area, fl: linear τ sum
        per unit area, fice: ice share per unit area)."""
        with np.errstate(invalid="ignore", divide="ignore"):
            fs = np.maximum(f, 1e-12)
            mu, var = m1 / fs, np.maximum(m2 / fs - (m1 / fs) ** 2, 0)
            g = G_LIQUID + (G_ICE - G_LIQUID) * np.clip(fice / fs, 0, 1)
            sd = np.sqrt(var)
            out = {"linearMeanTau": f * cloud_plane_albedo(fl / fs, g, mu0),
                   "logMeanTau": f * cloud_plane_albedo(np.exp(mu), g, mu0),
                   # probabilists' 3-point Gauss-Hermite: nodes μ, μ ± √3 σ, weights 2/3, 1/6, 1/6
                   "logNormal3": f * (2 / 3 * cloud_plane_albedo(np.exp(mu), g, mu0)
                                      + 1 / 6 * cloud_plane_albedo(np.exp(mu + np.sqrt(3) * sd), g, mu0)
                                      + 1 / 6 * cloud_plane_albedo(np.exp(mu - np.sqrt(3) * sd), g, mu0))}
        return {k: np.where(f > 0, v, 0.0) for k, v in out.items()}

    def add_block(self, lat_c: np.ndarray, lon_c: np.ndarray, f_cloud, f, m1, m2, fl, fice, ipa, mu0_rows) -> None:
        wrow = mu0_rows * np.cos(np.radians(lat_c))
        in_swath = ((lat_c >= SWATH[0]) & (lat_c <= SWATH[1]))[:, None] & ((lon_c >= SWATH[2]) & (lon_c <= SWATH[3]))[None, :]
        day = (mu0_rows > 0)[:, None] & np.ones_like(in_swath)
        texel = self.approximations(f, m1, m2, fl, fice, mu0_rows[:, None])
        for key, sel in (("global", day), ("swath", day & in_swath)):
            ww = np.where(sel, wrow[:, None], 0.0)
            self._add(key, "cloudFraction", (ww * f_cloud).sum())
            self._add(key, "tauRetrievedFraction", (ww * f).sum())
            self._add(key, "ipa", (ww * ipa).sum())
            for k in self.APPROX:
                self._add(key, k, (ww * texel[k]).sum())
                self._add(key, k + "|abs", (ww * np.abs(texel[k] - ipa)).sum())
        # Level 0 (16 × 16 level-4 texels): moments and IPA averaged as the pyramid averages them.
        c = 2 ** LEVEL
        if f.shape[0] % c or f.shape[1] % c:
            return

        def pool(a):
            return a.reshape(a.shape[0] // c, c, a.shape[1] // c, c).mean(axis=(1, 3))
        mu0c = pool(np.repeat(mu0_rows[:, None], f.shape[1], axis=1))
        daylit = pool(np.repeat((mu0_rows > 0)[:, None].astype(np.float64), f.shape[1], axis=1)) == 1
        coarse = self.approximations(pool(f), pool(m1), pool(m2), pool(fl), pool(fice), mu0c)
        ipac = pool(ipa)
        wc = mu0c * np.cos(np.radians(pool(np.repeat(lat_c[:, None], f.shape[1], axis=1))))
        swc = pool(in_swath.astype(np.float64)) == 1
        for key, sel in (("global.level0", daylit), ("swath.level0", daylit & swc)):
            ww = np.where(sel, wc, 0.0)
            self._add(key, "ipa", (ww * ipac).sum())
            for k in self.APPROX:
                self._add(key, k, (ww * coarse[k]).sum())
                self._add(key, k + "|abs", (ww * np.abs(coarse[k] - ipac)).sum())

    def report(self) -> dict:
        out = {}
        for key, s in self.sums.items():
            r = {}
            if "cloudFraction" in s and s["cloudFraction"] > 0:
                r["cloudyShareWithoutMeasuredTau"] = round(1 - s["tauRetrievedFraction"] / s["cloudFraction"], 4)
            for k in self.APPROX:
                if s.get("ipa", 0) > 0:
                    r[k] = {"ratioToIpa": round(s[k] / s["ipa"], 4), "meanAbsErrorOverIpa": round(s[k + "|abs"] / s["ipa"], 4)}
            out[key] = r
        return out


def _iso(day: str, seconds: float) -> str:
    t = _dt.datetime.fromisoformat(day + "T00:00:00+00:00") + _dt.timedelta(seconds=float(seconds))
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _geometric_test(info: dict) -> dict:
    """The header's statement of which thickness values are taken as the provider's estimate, with the counts
    from the strips of this build that show where the provider's processing differs."""
    ev = info["evidence"]
    tot = {k: {c: sum(ev[s][k][c] for s in ev) for c in ("cells", "possible", "noRetrieval")}
           for k in ("waterInsideCone", "waterOutsideCone", "lowSun", "sun60toLowSun")}
    return {
        "label": "estimated",
        "appliesTo": "cells classed water or ice cloud with an optical depth",
        "estimatedWhere": [
            f"any satellite: solar zenith angle ≥ {satcorps.DAY_SZA_DEG:g}° (or not stated)",
            f"a geostationary satellite: solar zenith angle ≥ {satcorps.GEO_QUALIFIED_SZA_DEG:g}°",
            f"a geostationary satellite, over water (the file's surface_type = {satcorps.WATER_SURFACE}): angle Θ between "
            f"the view direction and the Sun's mirror direction < {satcorps.GLINT_CONE_DEG:g}° (no inner limit), with "
            "cos Θ = cos θ0 cos θ + sin θ0 sin θ cos φ from the file's solar_zenith θ0, view_zenith θ and "
            "relative_azimuth φ (φ = 0 on the mirror side); a cell whose angles are not stated counts as inside"],
        "documented": {
            "night": f"Solar retrieval where the solar zenith angle is below {satcorps.DAY_SZA_DEG:g}°; otherwise thermal "
                     "channels only, a thickness for thin cloud alone ('optical depths less than 3 or so'), thick cloud a "
                     "default (Minnis et al. 2008, §3, p. 4; Minnis et al. 2021, §III-A, p. 5 and §III-A.5, p. 9) and, in "
                     "version 2, a k-nearest-neighbour extrapolation of daytime thickness from the 6.7 and 11 µm channels "
                     "(SatCORPS GCC overview v2, slides 8-9).",
            "terminatorAndGlint": "SatCORPS GCC overview v2, slide 7, lists for 'data products in the solar terminator and "
                                  "sun-glint' a k-nearest-neighbour extrapolation 'from surrounding space/time domain'. No "
                                  "document read states the zone's definition, and the files flag no cell."},
        "evidence": {
            "what": "Counts of geostationary cells of this build's strips, all classes, and how many of them are in the "
                    "provider's classes 'possible water/ice cloud' (6, 7) and 'no cloud property retrievals' (3). The "
                    "'possible' classes are a few percent of cells elsewhere and all but absent inside the cone and at "
                    f"a low Sun; 'sun60toLowSun' is solar zenith 60°-{satcorps.GEO_QUALIFIED_SZA_DEG:g}°, 'lowSun' "
                    f"{satcorps.GEO_QUALIFIED_SZA_DEG:g}°-{satcorps.DAY_SZA_DEG:g}°; 'waterInsideCone' and 'waterOutsideCone' "
                    f"are cells over water with the solar zenith angle below {satcorps.GEO_QUALIFIED_SZA_DEG:g}°, inside "
                    "and outside the cone.",
            "allGeostationary": tot, "bySatellite": ev},
        "limits": "The cone's edge was found at this local hour (each satellite near 13:30 local): the 'possible' classes "
                  "return between 40° and 42° on all five satellites. Away from it the edge moves (in the 04:00 UTC file "
                  "of the same day GOES-18, seen near its evening limb, has them back from 28°), and Himawari-9 has them "
                  "again inside 10°: the provider's zone depends on more than this angle. The solar-zenith limit holds on "
                  "every satellite in that file: none of 3,232,427 geostationary cells between 75.25° and 82° is in a "
                  "'possible' class, against 116,722 of 7,128,216 between 60° and 75.25° (docs/sources/satcorps-gcc.md). "
                  "The polar orbiter's cells show neither feature and are not tested for them."}


def build_clouds(ctx: BuildContext) -> list[dict]:
    """The cloud layers from the SatCORPS composite (satcorps.py): `clouds`, the thickness sums of the cells with a
    measured thickness (`cloudTau`) and of those with a measured or an estimated one (`cloudTauEstimated`)."""
    day = CLOUD_DAY
    pins = satcorps.PINS.get(day)
    if pins is None:
        raise RuntimeError(f"no SatCORPS pins for {day} (pipeline/src/pipeline/satcorps.py PINS)")
    m = satcorps.mosaic(day, pins)
    info = m.info
    h, w = st.level_shape(LEVEL)
    lat_c, lon_c = st.lat_centers(LEVEL), st.lon_centers(LEVEL)
    # The product's grid is read as WGS84 geodetic latitude (docs/sources/satcorps-gcc.md): texel rows are
    # planetocentric, so their edges are converted before the areas are intersected.
    lat_edges = geodetic_from_centric(np.clip(st.lat_edges(LEVEL), -90 + 1e-9, 90 - 1e-9))
    mu0_cell = _local_mu0(m.lat, day).astype(np.float32)[:, None]
    meas = m.cls == satcorps.MEASURED
    ipa_cell = np.where(meas, cloud_plane_albedo(np.exp(np.where(meas, m.ln_tau, 0.0)),
                                                 np.where(m.ice, np.float32(G_ICE), np.float32(G_LIQUID)), mu0_cell), 0.0)
    a = satcorps.aggregate(m, lat_edges, st.lon_edges(LEVEL), extra={"measuredPlaneAlbedo": ipa_cell})
    del ipa_cell, meas
    lay = satcorps.layers(a)
    known = lay["known"]
    top, mom, mom_est = lay["clouds"], lay["cloudTau"], lay["cloudTauEstimated"]

    # What the layers say, as area shares (cos of the texel's latitude), computed from the arrays that are written.
    wrow = np.cos(np.radians(lat_c))[:, None] * np.ones((1, w))
    wk = np.where(known, wrow, 0.0)

    def share(x) -> float:
        return float((wk * np.where(known, x, 0.0)).sum() / wrow.sum())
    with np.errstate(invalid="ignore", divide="ignore"):
        obs = np.where(known, a["observed"], np.nan)
        possible, no_tau = a["possible"] / obs, a["noThickness"] / obs
    area = {"known": float(wk.sum() / wrow.sum()),
            "cloud": share(top[..., 0]),
            "cloudMeasuredThickness": share(mom[..., 0]),
            "cloudEstimatedThickness": share(mom_est[..., 0] - mom[..., 0]),
            "possibleCloud": share(possible),
            "cloudWithoutThickness": share(no_tau),
            "clear": share(1.0 - top[..., 0])}
    with np.errstate(invalid="ignore", divide="ignore"):
        tau_stats = {
            "measured": {"meanLnTau": float((wk * np.nan_to_num(mom[..., 1])).sum() / (wk * np.nan_to_num(mom[..., 0])).sum()),
                         "iceShare": float((wk * np.nan_to_num(mom[..., 3])).sum() / (wk * np.nan_to_num(mom[..., 0])).sum())},
            "measuredAndEstimated": {
                "meanLnTau": float((wk * np.nan_to_num(mom_est[..., 1])).sum() / (wk * np.nan_to_num(mom_est[..., 0])).sum()),
                "iceShare": float((wk * np.nan_to_num(mom_est[..., 3])).sum() / (wk * np.nan_to_num(mom_est[..., 0])).sum())}}
    diag = _TauDiagnostics()
    z = lambda x: np.nan_to_num(np.where(known, x, 0.0))   # noqa: E731
    with np.errstate(invalid="ignore", divide="ignore"):
        diag.add_block(lat_c, lon_c, z(top[..., 0]), z(mom[..., 0]), z(mom[..., 1]), z(mom[..., 2]), z(a["measuredTau"] / obs),
                       z(mom[..., 3]), z(a["measuredPlaneAlbedo"] / obs), _local_mu0(geodetic_from_centric(lat_c), day))
    rep = diag.report()

    sid = sl.register_dataset(
        ctx, SRC_SATCORPS, f"SatCORPS Global Cloud Composite (GEO-LEO, V2), {day}, 24 hourly strips", SATCORPS_CITATION,
        satcorps.PRODUCT_DIR, info["files"], version=f"{info['grid']['version']}, files of {day}",
        license="No licence stated in the files. Their `user_notes` ask that the source be acknowledged ('NASA Langley "
                "Cloud and Radiation Research Group, http://satcorps.larc.nasa.gov') and that Dr. William L. Smith Jr. be "
                "contacted before a publication that uses the data.",
        notes=f"An 'early access' research product (product page, retrieved {max(e['retrieved'] for e in info['files'].values())}): "
              "the archive may not keep these files, so the byte ranges read are kept in data/raw. Of each hourly file only "
              f"the 15° strip nearest {satcorps.LOCAL_SOLAR_HOUR:g} h local solar time is read, by HTTP Range requests "
              f"({', '.join(satcorps.VARIABLES)}); the remote files and the decoded strips are pinned in "
              "pipeline/src/pipeline/satcorps.py PINS.")
    known_rows = np.flatnonzero(known.any(axis=1))
    regions = [sl.Region(float(st.lat_edges(LEVEL)[known_rows[-1] + 1]), float(st.lat_edges(LEVEL)[known_rows[0]]), -180, 180,
                         sl.Provenance("derived", [sid], "Area-weighted shares, sums and means over the composite's cells"),
                         note="A texel observed over less than half its area is unknown; otherwise its shares are of the "
                              "area that was observed. Nothing is carried across a hole.")]
    t_first = min(s["fileHourUtc"] * 3600 + v["secondsFromNominal"][0] for s in info["strips"] for v in s["sources"].values()
                  if v["secondsFromNominal"])
    t_last = max(s["fileHourUtc"] * 3600 + v["secondsFromNominal"][1] for s in info["strips"] for v in s["sources"].values()
                 if v["secondsFromNominal"])
    geo_t = [v["secondsFromNominal"] for s in info["strips"] for n, v in s["sources"].items()
             if n in satcorps.GEOSTATIONARY.values() and v["secondsFromNominal"]]
    leo_t = [v["secondsFromNominal"] for s in info["strips"] for n, v in s["sources"].items()
             if n in satcorps.POLAR.values() and v["secondsFromNominal"]]
    mosaic = {
        "what": f"A mosaic of 24 moments, not one: each longitude from the hourly file nearest {satcorps.LOCAL_SOLAR_HOUR:g} h "
                f"local solar time of the UTC day {day}.",
        "localSolarHour": satcorps.LOCAL_SOLAR_HOUR, "stripWidthDeg": 15.0, "hoursBetweenNeighbourStrips": 1.0,
        "dayCut": {"lonDeg": -150.0, "hours": 24.0,
                   "what": "Between the strips of 23 UTC (east of 150° W) and 00 UTC (west of it) the weather is 23 hours "
                           "apart in time and a day apart in local date: a real discontinuity, as every strip edge is."},
        "cuts": "Hard cuts at every multiple of 15° of longitude; no blending between hours. A level-4 texel that a cut "
                "runs through is the area mean of the cells on both sides of it.",
        "strips": [{k: s[k] for k in ("fileHourUtc", "lonWest", "lonEast", "referenceTime", "sources", "cells")}
                   for s in info["strips"]],
        "secondsFromNominalHour": {
            "geostationary": [min(t[0] for t in geo_t), max(t[1] for t in geo_t)] if geo_t else None,
            "polarOrbiter": [min(t[0] for t in leo_t), max(t[1] for t in leo_t)] if leo_t else None}}
    epoch = {"start": f"{day}T00:00:00Z", "end": f"{day}T23:59:59Z",
             "observed": f"{day} (UTC day of the 24 hourly files): each place within about half an hour of "
                         f"{satcorps.LOCAL_SOLAR_HOUR:g} h local solar time where a geostationary imager saw it, within about "
                         "two hours of it where NOAA-20 did; 15° strips one hour apart, a 24-hour cut at 150° W",
             "observedSpan": {"earliest": _iso(day, t_first), "latest": _iso(day, t_last)},
             "mosaic": mosaic,
             "changes": "clouds change within minutes to hours; this is a mosaic of one day's early afternoons, 'estimated' "
                        "at any other time"}
    classes = {
        "clear": "the provider's clear classes (0 snow/ice, 4 land/water)",
        "cloudMeasuredThickness": "water or ice cloud (1, 2) with an optical depth retrieved from sunlight: every reality level",
        "cloudEstimatedThickness": "water or ice cloud with an optical depth that is the provider's estimate (geometricTest): "
                                   "cloud of unmeasured thickness at Strict, drawn with the provider's value at Best and "
                                   "Complete (label estimated)",
        "possibleCloud": "the provider's 'possible water/ice cloud' (6, 7): the class is not defined in any document read, so "
                         "it is not measured at every level (counted in cloudFraction, never given a thickness)",
        "cloudWithoutThickness": "'no cloud property retrievals' (3: a cloudy pixel that neither the water nor the ice model "
                                 "fits; Minnis et al. 2021, §III-A, p. 5), or a cloud class without a valid optical depth: "
                                 "thickness not measured at every level; no published thickness exists for this class",
        "notObserved": "no source satellite, fill, 'bad input data' (5) or 'cleaned data' (13): cloud state not measured"}
    unknowns = [
        "No uncertainty per cell and no validation of V2.30 itself. Published comparisons of the algorithm family: thin ice "
        "cloud against CALIOP by day, imager minus lidar, bias and RMS +0.86, 4.27 (MODIS), +0.91, 4.83 (VIIRS), +2.25, 10.61 "
        "(geostationary imagers of 2008): thin cirrus is, on average, too thick here (Yost et al. 2016, NTRS 20160007830, "
        "table 'Global COD biases'); liquid cloud against surface sites 30 % low (Azores), 5 % low and 8 % high (Barrow) "
        "(Minnis et al. 2021, §V-C.1, p. 26).",
        "Parallax: the composite's paper (Khlopenkov et al. 2017) does not mention a correction. A 10 km top seen at 60° "
        "view zenith is displaced 17 km towards the limb of its satellite's disk.",
        "Cloud smaller than a pixel: a 2-3 km pixel is cloudy or clear as a whole, and a cloudy pixel's thickness is the "
        "plane-parallel value for its mean reflectance. Small cumulus in pixels called clear is not in the layer.",
        "The grid's latitude is not stated in the files. Read as WGS84 geodetic: against this pipeline's water layer, the "
        "files' surface_type matches better near coasts at mid-latitudes when read so (agreement 0.754 against 0.702 at "
        "30-60° N, 0.715 against 0.629 at 30-60° S; docs/sources/satcorps-gcc.md).",
        "The provider's phase is the radiatively dominant one; thin cirrus over water cloud can be missed and mixed phase "
        "is not a class (product page)."]
    common = {"samplesPerTexel": "area overlap of 1/36° cells: 2.5 cells per level-4 texel on average", "sourceDate": day,
              "classes": classes, "geometricTest": _geometric_test(info),
              "pins": {"table": "pipeline/src/pipeline/satcorps.py PINS",
                       "strips": {f"{s['fileHourUtc']:02d}": {**s["remote"], "sha256": s["sha256"], "url": s["url"],
                                                               "bytesRead": s["bytesRead"], "rangesRead": s["rangesRead"]}
                                  for s in info["strips"]}}}
    diagnostics = {"areaShares": {k: round(v, 6) for k, v in area.items()},
                   "cells": info["cells"], "thickness": tau_stats,
                   "notMeasuredAtStrict": round(area["cloud"] - area["cloudMeasuredThickness"], 6),
                   "notMeasuredAtBest": round(area["cloud"] - area["cloudMeasuredThickness"] - area["cloudEstimatedThickness"], 6)}
    uncertainty = ("No uncertainty per cell. Optical depth is stored in steps of 0.01 (0.01-150), top height in steps of 1 m "
                   "(to 25 km). See notes for the published comparisons of the algorithm family.")
    out = []
    spec = sl.LayerSpec(
        naif=NAIF, body=NAME, layer="clouds", kind="cloud-properties", fmt="f16", nodata="nan",
        channels=["cloudFraction", "opticalThickness", "cloudTopHeightM", "iceFraction"],
        frame=FRAME, sources=[sid],
        brightness=sl.Provenance("derived", [sid],
                                 "The composite's cells (cloud class, visible optical depth at about 0.65 µm, cloud-top "
                                 "height, each from one satellite's retrieval) aggregated per texel by area overlap.",
                                 uncertainty),
        regions=regions, epoch=epoch, units=None,
        constants={"channels": {
            "cloudFraction": "share of the texel's observed area classed cloud: water or ice cloud with or without an "
                             "optical depth, and the 'possible' classes (0-1)",
            "opticalThickness": "mean optical depth of the cells with a MEASURED thickness (0 where cloudFraction = 0; NaN "
                                f"= cloud, none of it with a measured thickness). The {TAU_LAYER} layer says how much of "
                                "the cloud has one",
            "cloudTopHeightM": "mean cloud-top height (m) of the cells with a measured or an estimated thickness (0 where "
                               "cloudFraction = 0; NaN = cloud without any). Where a texel holds cells of the estimated "
                               f"group ({TAU_ESTIMATED_LAYER} share above {TAU_LAYER} share) this mean includes their "
                               "heights and is estimated there; one channel serves both levels",
            "iceFraction": "ice share of the cells with a measured thickness"},
            "companionLayers": {TAU_LAYER: f"surfaces/{NAIF}/{TAU_LAYER}.json", TAU_ESTIMATED_LAYER: f"surfaces/{NAIF}/{TAU_ESTIMATED_LAYER}.json"},
            **common},
        diagnostics={"meanCloudFraction": float(np.nanmean(top[..., 0][known])), **diagnostics},
        notes=["Cloud fraction counts every cell the provider classes cloud or possible cloud. Which of it has a "
               f"thickness, and of which kind, is in the {TAU_LAYER} and {TAU_ESTIMATED_LAYER} layers; the rest is cloud of "
               "unmeasured thickness and is drawn as not measured.",
               "The picture is a mosaic of the day's 13:30 local hours (epoch.mosaic): 24 strips with hard cuts one hour "
               "apart and a 24-hour cut at 150° W. The cuts are real discontinuities in the weather shown.",
               "Coarser levels are 2×2 means of each channel. That is exact for cloudFraction where the texels are fully "
               "observed; opticalThickness, cloudTopHeightM and iceFraction are in-cloud means, averaged without their "
               "weights.",
               *unknowns])
    out.append(sl.write_layer(ctx, spec, top, known, LEVEL))

    def tau_spec(layer, label, what, arr, companion):
        est = label == "estimated"
        return sl.LayerSpec(
            naif=NAIF, body=NAME, layer=layer, kind="cloud-optical-thickness-moments", fmt="f16", nodata="nan",
            channels=["tauRetrievedFraction", "lnTauMoment1", "lnTauMoment2", "iceTauFraction"],
            frame=FRAME, sources=[sid],
            brightness=sl.Provenance(label, [sid], what, uncertainty),
            regions=[sl.Region(r.lat_min, r.lat_max, r.lon_min, r.lon_max, sl.Provenance(label, [sid], r.brightness.method),
                               note=r.note) for r in regions],
            epoch=epoch, units=None,
            constants={
                "channels": {
                    "tauRetrievedFraction": "f_τ: share of the texel's observed area that is cloud with a thickness of this "
                                            "layer's group (0 ≤ f_τ ≤ cloudFraction of the clouds layer)",
                    "lnTauMoment1": "Σ a_i ln τ_i over those cells, a_i the cell's share of the observed area (= f_τ · mean ln τ)",
                    "lnTauMoment2": "Σ a_i (ln τ_i)² over the same cells (= f_τ · mean (ln τ)²)",
                    "iceTauFraction": "share of the observed area that is ice cloud with a thickness of this group (= f_τ · ice share)"},
                "group": ("cells with a measured or an estimated thickness (classes cloudMeasuredThickness and "
                          "cloudEstimatedThickness); equal to the cloudTau layer wherever a texel has no estimated cell"
                          if est else "cells with a measured thickness (class cloudMeasuredThickness)"),
                "use": {
                    "meanLnTau": "lnTauMoment1 / tauRetrievedFraction; exp of it is Cahalan et al.'s (1994) effective thickness",
                    "varLnTau": "lnTauMoment2 / tauRetrievedFraction − meanLnTau²",
                    "iceShare": "iceTauFraction / tauRetrievedFraction",
                    "levels": f"Strict draws the thickness of {TAU_LAYER} (measured cells only). Best estimate and Complete "
                              f"draw {TAU_ESTIMATED_LAYER} in its place (measured and estimated cells together, label "
                              "estimated). At every level cloudFraction − f_τ of the layer in use is cloud of unmeasured "
                              "thickness: no reflected light, marked not measured; no statistic stands in for it.",
                    "levels2x2": "every channel is an area-weighted sum, so the pyramid's 2×2 means are the same quantities "
                                 "for the coarser texel where the texels are fully observed"},
                "companionOf": f"surfaces/{NAIF}/clouds.json", "companionLayers": companion, **common},
            diagnostics={"meanTauRetrievedFraction": float(np.nanmean(arr[..., 0][known])),
                         "meanCloudFraction": float(np.nanmean(top[..., 0][known])), **diagnostics,
                         **({} if est else {"planeAlbedoCheck": {
                             "what": "plane albedo × f_τ of the measured cells from the moments, against the area mean over the "
                                     "cells of R(τ_i) (independent pixels), with the Sun of 13:30 local; δ-Eddington with g = "
                                     "0.867 liquid / 0.75 ice; sums weighted by μ0·cos(latitude); 'swath' = 40° S-40° N, "
                                     "125-160° E (the validation case); 'level0' = texels of 16 × 16 level-4 texels, moments "
                                     "averaged as the pyramid does", **rep}})},
            notes=["The clouds layer's cloudFraction counts every cloud class; this layer says how much of the texel is "
                   "cloud with a thickness of its group and how that thickness is distributed (ln τ moments).",
                   "The picture is a mosaic of the day's 13:30 local hours (epoch.mosaic): 24 strips with hard cuts one hour "
                   "apart and a 24-hour cut at 150° W.",
                   *([f"Where the estimated group is: constants.geometricTest. In a texel without estimated cells this layer "
                      f"equals {TAU_LAYER}."] if est else []),
                   *unknowns])
    companions = {TAU_LAYER: f"surfaces/{NAIF}/{TAU_LAYER}.json", TAU_ESTIMATED_LAYER: f"surfaces/{NAIF}/{TAU_ESTIMATED_LAYER}.json"}
    out.append(sl.write_layer(ctx, tau_spec(
        TAU_LAYER, "derived", "Area-weighted sums of ln τ over the cells whose optical depth the provider retrieved from "
        "sunlight (water or ice cloud, by day, outside the geometry of constants.geometricTest).", mom, companions), mom, known, LEVEL))
    out.append(sl.write_layer(ctx, tau_spec(
        TAU_ESTIMATED_LAYER, "estimated", "As cloudTau, with in addition the cells whose optical depth is the provider's "
        "estimate (night and twilight; the geostationary sun-glint cone and low Sun of constants.geometricTest): taking those "
        "values as the cloud's thickness is the assumption.", mom_est, companions), mom_est, known, LEVEL))
    return out


# ---------------------------------------------------------------------------------------------- night lights

RSR_ZIP = "https://ncc.nesdis.noaa.gov/NOAA-20/docs/J1_VIIRS_RSR_DAWG_At-Launch_Public_Release_V2.1_Nov2016.zip"
RSR_MEMBER = "J1_VIIRS_BA_RSR_V2F/J1_VIIRS_RSR_DNBLGS_BA_Fused_V2FS.txt"
CIE_BASE = "https://files.cie.co.at/Publications-datasets/"
NIGHT_DAY = "2026-10-02"          # surfaces/399/night.json constants.sourceDate of the shared build


def dnb_rsr() -> tuple[np.ndarray, Path]:
    """NOAA-20 VIIRS DNB (low-gain stage) band-averaged relative spectral response on the CIE grid."""
    path = fetch(RSR_ZIP, SUBDIR)
    with zipfile.ZipFile(path) as z:
        rows = [ln.split() for ln in z.read(RSR_MEMBER).decode("latin-1").splitlines()
                if ln.strip() and not ln.startswith("%")]
    wl = np.array([float(r[1]) for r in rows])
    rsr = np.array([float(r[2]) for r in rows])
    o = np.argsort(wl)
    return np.interp(cie.WAVELENGTHS, wl[o], rsr[o], left=0.0, right=0.0), path


def cie_lamp(file: str, meta_suffix: str, column: str) -> tuple[np.ndarray, Path]:
    """One column of a CIE illuminant table on the CIE grid (linear interpolation, zero outside, as the CIE
    metadata specifies). The table is checked against the sha256 and column sums published in its metadata, and
    the column is found by the metadata's column titles (the CSV has no header row)."""
    path = fetch(CIE_BASE + file, "cie")
    meta_path = fetch(CIE_BASE + file + meta_suffix, "cie")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    data = np.loadtxt(path, delimiter=",")
    cie._validate(path, meta_path, data)
    titles = [c["title"] for c in meta["datatableInfo"]["columnHeaders"]]
    if len(titles) != data.shape[1] or titles[0] != "lambda":
        raise ValueError(f"{file}: metadata columns {titles} do not match the table")
    j = titles.index(column)
    return np.interp(cie.WAVELENGTHS, data[:, 0], data[:, j], left=0.0, right=0.0), path


def luminance_factors(rsr: np.ndarray, spectrum: np.ndarray) -> list[float]:
    """X, Y, Z, S (cd m⁻² etc.) per 1 nW cm⁻² sr⁻¹ of DNB radiance for a light of spectral shape `spectrum`,
    with DNB radiance = ∫ L(λ) RSR(λ) dλ (RSR peak-normalized)."""
    obs = np.vstack([cie.cmfs().T, cie.scotopic()[None, :]])
    k = np.array([cie.KM_PHOTOPIC] * 3 + [cie.KM_SCOTOPIC])
    per_band = (obs * spectrum[None, :]).sum(axis=1) * k / (spectrum * rsr / rsr.max()).sum()
    return [float(v) * 1e-5 for v in per_band]   # 1 nW cm⁻² sr⁻¹ = 1e-5 W m⁻² sr⁻¹


def build_night(ctx: BuildContext) -> dict:
    rsr, rsr_path = dnb_rsr()
    hp1, hp_path = cie_lamp("CIE_illum_HPs.csv", "_metadata_v2.json", "HP1")
    led, led_path = cie_lamp("CIE_illum_LEDs_1nm.csv", "_metadata.json", "LED-B3")
    f_hp1, f_led = luminance_factors(rsr, hp1), luminance_factors(rsr, led)
    caps = gb.capabilities()
    info = gb.layer_info(caps, L_DNB)
    day = NIGHT_DAY
    if not _serves(info, day):
        raise RuntimeError(f"GIBS snapshot does not advertise {L_DNB} for pin {day}")
    cm = gb.colormap(info["colormap"])
    h, w = st.level_shape(LEVEL)
    top = np.full((h, w, 2), np.nan, np.float32)
    files, unmatched = {}, 0
    for bbox, bi, bj, p in _fetch_blocks(L_DNB, day):
        val, _, cen, u = gb.decode(gb.read_rgba(p), cm)
        unmatched += u
        files[p.name] = record(p)
        discard(p)
        v, c = _reshape_blocks(val), _reshape_blocks(cen)
        n = np.isfinite(v).sum(axis=2)
        with np.errstate(invalid="ignore", divide="ignore"):
            mean = np.where(n > 0, np.nansum(v, axis=2) / np.maximum(n, 1), np.nan)
            cfr = np.where(n > 0, c.sum(axis=2) / np.maximum(n, 1), np.nan)
        rows = slice(bi * (h // 4), (bi + 1) * (h // 4))
        cols = slice(bj * (w // 4), (bj + 1) * (w // 4))
        top[rows, cols] = np.stack([mean, cfr], axis=-1)
    top = top[centric_rows(LEVEL)]
    known = np.isfinite(top[..., 0])
    gibs_id = _register_gibs(ctx)
    sl.register_dataset(
        ctx, SRC_VJ146, f"VIIRS/NOAA-20 Black Marble gap-filled BRDF-adjusted nighttime lights VJ146A2, {day}, via GIBS",
        "Román, M. O. et al. (2018). NASA's Black Marble nighttime lights product suite. Remote Sensing of "
        "Environment 210, 113-143. doi:10.1016/j.rse.2018.03.017. Product: VJ146A2 v2 (VIIRS/JPSS1 Gap-Filled Lunar "
        f"BRDF-Adjusted Nighttime Lights Daily L3, 15 arc-second), GIBS layer {L_DNB}.",
        gb.WMS, files, version=f"VJ146A2 v2, GIBS day {day}", license="NASA data policy (no restrictions)",
        notes=f"Decoded with {cm.url}: bins 0.1 nW cm⁻² sr⁻¹ wide below 5, widening to 0.6 at 38.2, then one "
              "open-ended bin; blocks deleted.")
    rsr_id = sl.register_dataset(
        ctx, SRC_DNB_RSR, "NOAA-20 (JPSS-1) VIIRS relative spectral responses, DAWG at-launch release V2.1",
        "NOAA/NESDIS STAR and the JPSS VIIRS Data Analysis Working Group (2016). J1 VIIRS RSR DAWG At-Launch Public "
        "Release V2.1 (Nov 2016); band-averaged fused DNB low-gain-stage RSR (J1_VIIRS_RSR_DNBLGS_BA_Fused_V2FS).",
        RSR_ZIP, {rsr_path.name: record(rsr_path)}, license="public domain (NOAA)")
    for sid, pth, title in ((SRC_CIE_HP, hp_path, "high-pressure discharge lamp illuminants HP1-HP5"),
                            (SRC_CIE_LED, led_path, "illuminants representing typical LED lamps (1 nm)")):
        sl.register_dataset(ctx, sid, f"CIE relative spectral power distributions of {title}",
                            "CIE 015:2018 Colorimetry, 4th ed., DOI:10.25039/TR.015.2018; data table published by the "
                            "CIE (files.cie.co.at, Publications-datasets).", CIE_BASE + pth.name,
                            {pth.name: record(pth)}, license="CC BY-SA 4.0")
    spec = sl.LayerSpec(
        naif=NAIF, body=NAME, layer="night", kind="emitted-radiance", fmt="f16", nodata="nan",
        channels=["dnbRadiance", "censoredFraction"],
        frame=FRAME,
        sources=[SRC_VJ146, gibs_id, rsr_id, SRC_CIE_HP, SRC_CIE_LED],
        brightness=sl.Provenance("measured", [SRC_VJ146, gibs_id],
                                 "Black Marble at-surface nighttime-light radiance in the VIIRS Day/Night Band "
                                 "(500-900 nm), moonlight, atmosphere and viewing-angle effects removed by the product, "
                                 f"cloud gaps filled from earlier clear nights; mean of {SAMPLES * SAMPLES} samples per "
                                 "texel.",
                                 "quantization 0.1 (below 5) to 0.6 nW cm⁻² sr⁻¹ (near 38); samples ≥ 38.2 are lower "
                                 "bounds (share in censoredFraction), so bright city cores are underestimated"),
        color=sl.Provenance("estimated", [rsr_id, SRC_CIE_HP, SRC_CIE_LED],
                            "Luminance needs the lamps' spectrum, which is not measured: constants.toXYZS gives "
                            "X, Y, Z, S per nW cm⁻² sr⁻¹ for CIE HP1 (high-pressure sodium) and CIE LED-B3 (4000 K "
                            "phosphor LED), computed with the NOAA-20 DNB response.",
                            f"Y factors differ by {abs(f_hp1[1] / f_led[1] - 1) * 100:.0f} % between the two spectra; "
                            "the CIE tables end at 780 nm while the DNB responds to ~900 nm, so lamp emission beyond "
                            "780 nm (e.g. the 819 nm sodium lines of HPS lamps) is missing from the DNB integral and "
                            "the factors are upper limits"),
        units="nW cm⁻² sr⁻¹",
        regions=[sl.Region(-90, 90, -180, 180, sl.Provenance("measured", [SRC_VJ146], "VJ146A2 land tiles"),
                           note="Open ocean and other areas without a Black Marble value are unknown.")],
        epoch={"start": f"{day}T00:00:00Z", "end": f"{day}T23:59:59Z",
               "observed": f"night of {day} (NOAA-20 overpass ~01:30 local), gaps filled from earlier nights",
               "changes": "lights vary nightly (fires, fishing fleets, gas flares, outages) and seasonally"},
        constants={"toXYZS": {"HP1": f_hp1, "LED-B3": f_led,
                              "units": "cd m⁻² (X, Y, Z; scotopic cd m⁻² for S) per nW cm⁻² sr⁻¹",
                              "definition": "DNB radiance = ∫ L(λ) RSR(λ) dλ with the RSR normalized to peak 1; "
                                            "luminance = K_m ∫ L(λ) V(λ) dλ"},
                   "censoredAbove": 38.2, "sourceDate": day},
        diagnostics={"unmatchedColours": unmatched,
                     "knownFraction": float(known.mean()),
                     "texelsWithCensoring": int((top[..., 1] > 0).sum())},
        notes=["Radiance, not luminance, is stored because the conversion depends on the unmeasured lamp spectrum."],
    )
    return sl.write_layer(ctx, spec, top, known, LEVEL)


# ---------------------------------------------------------------------------------------------- water


L_WATER = "MODIS_Terra_L3_Land_Water_Mask"
L_SEAICE = "GHRSST_L4_MUR_Sea_Ice_Concentration"
WATER_RGB = (168, 248, 255)
SRC_MOD44W = "modis-mod44w-v6-water-mask"
SRC_MUR_ICE = "ghrsst-mur-sea-ice"
WATER_DAY = "2015-01-01"          # shared water header's waterMaskYear; MOD44W annual GIBS date
SEAICE_DAY = "2026-10-02"         # surfaces/399/water.json constants.seaIceDate of the shared build


SOUTH_LIMIT = -60.0     # south of this, MOD44W "water" also means "not mapped" (see WaterMask)
ETOPO_DAP = ("https://www.ngdc.noaa.gov/thredds/dodsC/global/ETOPO2022/60s/60s_surface_elev_netcdf/"
             "ETOPO_2022_v1_60s_N90W180_surface.nc")
SRC_ETOPO = "noaa-etopo-2022"


def etopo_south() -> tuple[np.ndarray, Path]:
    """ETOPO 2022 60″ surface elevation (m, EGM2008) for 90°S-60°S, all longitudes: (1800, 21600), row 0 at
    89.99°S (the file's latitude is ascending). Read as one OPeNDAP binary subset (DAP2 XDR, big-endian)."""
    rows = int(round((SOUTH_LIMIT + 90.0) * 60))
    url = f"{ETOPO_DAP}.dods?z.z[0:1:{rows - 1}][0:1:21599]"
    path = fetch(url, f"{SUBDIR}/etopo", f"etopo2022-60s-surface-south{int(-SOUTH_LIMIT)}.dods", timeout=900,
                 validate=lambda q: b"Data:\n" in q.read_bytes()[:2000])
    raw = path.read_bytes()
    i = raw.index(b"Data:\n")
    if f"z[lat = {rows}][lon = 21600]".encode() not in raw[:i]:
        raise ValueError(f"{path.name}: unexpected DAP structure {raw[:i]!r}")
    n = np.frombuffer(raw, ">u4", 2, i + 6)
    if n[0] != rows * 21600:
        raise ValueError(f"{path.name}: {n[0]} values, expected {rows * 21600}")
    z = np.frombuffer(raw, ">f4", rows * 21600, i + 14).astype(np.float32).reshape(rows, 21600)
    return z, path


class WaterMask:
    """Land/water mask at SAMPLES × SAMPLES points per level-4 texel on the WGS84 geodetic grid, kept as packed bits
    (1 = water), with the texel water fraction and sea-ice concentration on the planetocentric grid.

    North of 60°S: MOD44W v6 (GIBS). Its colour map draws the product's no-data value (253) in the water colour
    (`sourceValue="1,253"`), and MOD44W does not map Antarctica, so the whole continent comes out as water. South
    of 60°S the mask is therefore taken from ETOPO 2022 instead: a sample is water where the 60″ surface
    elevation (ice surface on land and on the floating ice shelves, bathymetry at sea) is ≤ 0 m.
    """

    def __init__(self):
        caps = gb.capabilities()
        self.info = gb.layer_info(caps, L_WATER)
        self.day = WATER_DAY
        self.ice_info = gb.layer_info(caps, L_SEAICE)
        self.ice_day = SEAICE_DAY
        for info, day in ((self.info, self.day), (self.ice_info, self.ice_day)):
            if not _serves(info, day):
                raise RuntimeError(f"GIBS snapshot does not advertise {info['layer']} for pin {day}")
        cm = gb.colormap(self.ice_info["colormap"])
        self.ice_cm_url = cm.url
        h, w = st.level_shape(LEVEL)
        self.sh, self.sw = h * SAMPLES, w * SAMPLES
        self.bits = np.zeros((self.sh, self.sw // 8), np.uint8)
        frac = np.zeros((h, w), np.float32)
        ice = np.full((h, w), np.nan, np.float32)
        self.files, self.ice_files = {}, {}
        self.unmatched = 0
        agree = {"mod44wLandWithMur": 0, "mod44wLand": 0}
        lat_s = 90.0 - (np.arange(self.sh) + 0.5) * (180.0 / self.sh)    # geodetic latitude of sample rows
        lon_s = -180.0 + (np.arange(self.sw) + 0.5) * (360.0 / self.sw)
        etopo, self.etopo_path = etopo_south()
        et_col = np.clip(np.floor((lon_s + 180.0) * 60).astype(np.int64), 0, 21599)
        for (bbox, bi, bj, p), (_, _, _, q) in zip(_fetch_blocks(L_WATER, self.day),
                                                    _fetch_blocks(L_SEAICE, self.ice_day)):
            rgba = gb.read_rgba(p)
            opaque = rgba[..., 3] > 0
            wat = (opaque & (rgba[..., 0] == WATER_RGB[0]) & (rgba[..., 1] == WATER_RGB[1])
                   & (rgba[..., 2] == WATER_RGB[2]))
            if (opaque & ~wat).any():
                raise ValueError(f"{p.name}: unexpected opaque colours in the water mask")
            val, _, _, u = gb.decode(gb.read_rgba(q), cm)
            self.unmatched += u
            self.files[p.name], self.ice_files[q.name] = record(p), record(q)
            discard(p)
            discard(q)
            r0, c0 = bi * rgba.shape[0], bj * rgba.shape[1]
            north = (lat_s[r0:r0 + rgba.shape[0]] >= SOUTH_LIMIT)[:, None]
            mur = np.isfinite(val)       # MUR has a sea-ice value (only near the ice, not a full ocean mask)
            agree["mod44wLandWithMur"] += int((~wat & mur & north).sum())
            agree["mod44wLand"] += int((~wat & north).sum())
            south = ~north[:, 0]
            if south.any():
                et_row = np.clip(np.floor((lat_s[r0:r0 + rgba.shape[0]][south] + 90.0) * 60).astype(np.int64), 0,
                                 etopo.shape[0] - 1)
                wat[south] = etopo[et_row][:, et_col[c0:c0 + rgba.shape[1]]] <= 0
            self.bits[r0:r0 + rgba.shape[0], c0 // 8:(c0 + rgba.shape[1]) // 8] = np.packbits(wat, axis=1)
            rs = slice(r0 // SAMPLES, (r0 + rgba.shape[0]) // SAMPLES)
            cs = slice(c0 // SAMPLES, (c0 + rgba.shape[1]) // SAMPLES)
            frac[rs, cs] = _reshape_blocks(wat).mean(axis=2)
            v = _reshape_blocks(val)
            n = np.isfinite(v).sum(axis=2)
            with np.errstate(invalid="ignore", divide="ignore"):
                ice[rs, cs] = np.where(n > 0, np.nansum(v, axis=2) / np.maximum(n, 1), np.nan) / 100.0
        rows = centric_rows(LEVEL)
        self.fraction = frac[rows]
        self.ice = ice[rows]
        self.agreement = {
            "mod44wLandSamplesWithSeaIceValue": round(agree["mod44wLandWithMur"] / max(agree["mod44wLand"], 1), 5),
            "what": "north of 60°S, share of MOD44W land samples where the MUR analysis has a sea-ice value (a "
                    "coastline mismatch between the two products; should be ≪ 1)"}

    def at(self, lat_g_deg: np.ndarray, lon_deg: np.ndarray) -> np.ndarray:
        """Water flag (bool) at geodetic latitude / east longitude points."""
        r = np.clip(np.floor((90.0 - lat_g_deg) * (self.sh / 180.0)).astype(np.int64), 0, self.sh - 1)
        c = np.floor((np.asarray(lon_deg) + 180.0) * (self.sw / 360.0)).astype(np.int64) % self.sw
        return ((self.bits[r, c >> 3] >> (7 - (c & 7))) & 1).astype(bool)


def build_water(ctx: BuildContext, mask: WaterMask) -> dict:
    h, w = st.level_shape(LEVEL)
    day, files, unmatched, ice = mask.ice_day, mask.ice_files, mask.unmatched, mask.ice
    top = np.stack([mask.fraction, ice], axis=-1)
    known = np.ones((h, w), bool)
    gibs_id = _register_gibs(ctx)
    sl.register_dataset(
        ctx, SRC_MOD44W, "MODIS/Terra land/water mask MOD44W v6 (250 m), via GIBS",
        "Carroll, M. L., DiMiceli, C. M., Wooten, M. R., Hubbard, A. B., Sohlberg, R. A. & Townshend, J. R. G. "
        "(2017). MOD44W MODIS/Terra Land Water Mask Derived from MODIS and SRTM L3 Global 250m SIN Grid V006. NASA "
        "EOSDIS Land Processes DAAC. doi:10.5067/MODIS/MOD44W.006. GIBS layer " + L_WATER + ".",
        gb.WMS, mask.files, version=f"MOD44W v6, year {mask.day[:4]}", license="NASA data policy (no restrictions)",
        notes=f"Two-class colour map {mask.info['colormap']}: land transparent, water AND the no-data value 253 "
              f"opaque {WATER_RGB}; MOD44W does not map Antarctica, so it is used only north of 60°S. Blocks deleted "
              "after decoding.")
    sl.register_dataset(
        ctx, SRC_ETOPO, "NOAA ETOPO 2022 global relief, 60 arc-second surface elevation (90°S-60°S subset)",
        "NOAA National Centers for Environmental Information (2022). ETOPO 2022 15 Arc-Second Global Relief Model. "
        "doi:10.25921/fd45-gt74. 60 arc-second surface-elevation version (ice surface over Antarctica and Greenland, "
        "bathymetry at sea; heights relative to EGM2008).",
        ETOPO_DAP, {mask.etopo_path.name: record(mask.etopo_path)}, version="ETOPO 2022 v1",
        license="public domain (NOAA)",
        notes="OPeNDAP binary subset of rows 90°S-60°S, all longitudes; used only as the land/water mask south of "
              "60°S (water = elevation ≤ 0 m).")
    sl.register_dataset(
        ctx, SRC_MUR_ICE, f"GHRSST MUR L4 sea-ice concentration, {day}, via GIBS",
        "JPL MUR MEaSUREs Project (2015). GHRSST Level 4 MUR Global Foundation Sea Surface Temperature Analysis "
        "(v4.1), sea_ice_fraction variable (from EUMETSAT OSI SAF passive-microwave sea-ice concentration). PO.DAAC, "
        "doi:10.5067/GHGMR-4FJ04. GIBS layer " + L_SEAICE + ".",
        gb.WMS, files, version=f"MUR v4.1, GIBS day {day}", license="NASA data policy (no restrictions)",
        notes=f"Decoded with {mask.ice_cm_url} (1 % bins); blocks deleted. The analysis has values only near the "
              "sea ice (none on land or over the open ocean far from ice).")
    spec = sl.LayerSpec(
        naif=NAIF, body=NAME, layer="water", kind="surface-water", fmt="f16", nodata="nan",
        channels=["waterFraction", "seaIceFraction"],
        frame=FRAME, sources=[SRC_MOD44W, SRC_ETOPO, SRC_MUR_ICE, gibs_id],
        brightness=sl.Provenance("measured", [SRC_MOD44W, SRC_ETOPO, SRC_MUR_ICE, gibs_id],
                                 f"waterFraction: share of the texel's {SAMPLES * SAMPLES} samples that are water "
                                 "(ocean and inland water): MOD44W 250 m north of 60°S, ETOPO 2022 surface elevation "
                                 "≤ 0 m south of it (MOD44W does not map Antarctica; ice shelves count as land). seaIceFraction: mean MUR sea-ice concentration "
                                 "(0-1) of the texel's samples that have one (NaN where none, e.g. land).",
                                 "MOD44W is from 2000-2015 MODIS/SRTM data; coastlines and reservoirs that changed "
                                 "since are not updated. Sea-ice concentration from passive microwave (~10-25 km "
                                 "footprints) interpolated by the MUR analysis."),
        epoch={"start": f"{day}T00:00:00Z", "end": f"{day}T23:59:59Z",
               "observed": f"land/water mask: MOD44W v6 year {mask.day[:4]}; sea ice: MUR analysis of {day}",
               "changes": "sea ice changes daily to seasonally (Arctic minimum in September); the land/water mask "
                          "changes on years to decades"},
        constants={"channels": {
            "waterFraction": "fraction of the texel that is open or ice-covered water (0-1)",
            "seaIceFraction": "sea-ice concentration (0-1) over the texel's water; NaN = no value in the analysis "
                              "(land, and open ocean away from the ice: no ice)"},
            "samplesPerTexel": SAMPLES * SAMPLES, "seaIceDate": day, "waterMaskYear": mask.day[:4]},
        diagnostics={"unmatchedColours": unmatched, "maskAgreement": mask.agreement,
                     "waterAreaFraction": round(st.area_mean(mask.fraction, LEVEL), 5),
                     "texelsWithSeaIceOver15pc": int((ice > 0.15).sum())},
        notes=["The renderer adds specular (Fresnel) reflection and sun glint of the water surface on waterFraction "
               "× (1 − seaIceFraction); the albedo layer holds only the diffuse, water-leaving part."],
    )
    return sl.write_layer(ctx, spec, top, known, LEVEL)


# ---------------------------------------------------------------------------------------------- albedo

PC_STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
PC_SAS = "https://planetarycomputer.microsoft.com/api/sas/v1/token/modiseuwest/modis-061-cogs"
MCD_COLLECTION = "modis-43A4-061"
# The shared albedo header's epoch.observed gives this centre day and A2026257.
# Digest of the sorted (granule id, three band hrefs) from the recorded STAC responses:
# includes each granule's processing stamp, so a date alone cannot select a new reprocessing.
MCD_DAY = "2026-09-14"
MCD_GRANULES_SHA256 = "45265021a95244bfe11da6d0c5a9352929879aef8d71b154727e245fc0fd85b3"
MCD_BANDS = (("Nadir_Reflectance_Band3", 469.0), ("Nadir_Reflectance_Band4", 555.0),
             ("Nadir_Reflectance_Band1", 645.0))
MCD_PAGE = 1                        # 926.6 m overview (2 × 2 reduction of the 463 m product)
MCD_SCALE = 1e-4
MODIS_R = 6371007.181               # radius of the MODIS sinusoidal grid sphere (m)
SRC_MCD43 = "modis-mcd43a4-v061"
SRC_PC = "microsoft-planetary-computer"
SRC_OCCCI = "esa-oc-cci-v6-rrs"
OC_BANDS = (412.0, 443.0, 490.0, 510.0, 560.0, 665.0)
OC_MONTH = "2025-09"
OC_NCSS = ("https://www.oceancolour.org/thredds/ncss/cci/v6.0-release/geographic/monthly/rrs/{y}/"
           "ESACCI-OC-L3S-RRS-MERGED-1M_MONTHLY_4km_GEO_PML_RRS-{y}{m}-fv6.0.nc")


class _Sas:
    """Planetary Computer read token for the MODIS container (a URL signature; never written to the ledger)."""

    def __init__(self):
        self.token, self.expiry = None, 0.0
        self.lock = threading.Lock()

    def params(self) -> dict:
        with self.lock:
            if self.token is None or time.time() > self.expiry - 600:
                j = download.request("GET", PC_SAS, timeout=60).json()
                self.token = j["token"]
                exp = j.get("msft:expiry", "")
                self.expiry = (_dt.datetime.fromisoformat(exp.replace("Z", "+00:00")).timestamp() if exp
                               else time.time() + 1800)
            return dict(urllib.parse.parse_qsl(self.token))


def mcd43_items() -> tuple[str, list[dict], list[Path]]:
    """Pinned MCD43A4 centre day and exact granules, reusing the saved STAC pages."""
    day = MCD_DAY
    dt = f"{day}T00:00:00Z"
    doy = f"A{day[:4]}{_dt.date.fromisoformat(day).timetuple().tm_yday:03d}"
    items, paths, k = [], [], 0
    url, params = PC_STAC, {"collections": MCD_COLLECTION, "datetime": dt, "limit": "1000"}
    while url:
        pth = fetch(url, f"{SUBDIR}/mcd43a4", f"stac-{doy}-{k}.json", params=params)
        paths.append(pth)
        page = json.loads(pth.read_text(encoding="utf-8"))
        items += [f for f in page["features"] if f"{doy}." in f["id"]]
        nxt = [ln for ln in page.get("links", []) if ln.get("rel") == "next"]
        url, params, k = (nxt[0]["href"], None, k + 1) if nxt else (None, None, k)
    if len(items) < 250:
        raise RuntimeError(f"MCD43A4 {doy}: only {len(items)} tiles in the STAC catalogue")
    items.sort(key=lambda f: f["id"])
    identity = [(f["id"], [f["assets"][b]["href"] for b, _ in MCD_BANDS]) for f in items]
    digest = hashlib.sha256(json.dumps(identity, separators=(",", ":")).encode()).hexdigest()
    if digest != MCD_GRANULES_SHA256 or any(f["properties"]["datetime"] != dt for f in items):
        raise ValueError(f"MCD43A4 {doy}: granule pin mismatch; restore the recorded STAC pages or explicitly "
                         "update MCD_DAY and MCD_GRANULES_SHA256")
    return doy, items, paths


def _mcd43_tile(item: dict, sas: _Sas) -> tuple[object, np.ndarray, dict]:
    """(COG level info, reflectance (3, n, n) float32 with NaN = fill, ledger records) of one tile."""
    out, recs, lv0 = [], {}, None
    for band, _ in MCD_BANDS:
        href = item["assets"][band]["href"]
        stem = href.rsplit("/", 1)[1].removesuffix(".tif")
        img, lv, paths = surf_cog.read_level(href, sas.params(), f"{SUBDIR}/mcd43a4", stem, MCD_PAGE, href)
        for pth in paths:
            recs[pth.name] = record(pth)
            discard(pth)
        nod = lv.nodata if lv.nodata is not None else 32767
        # values below the product's valid range (0..32766) occur only as ringing of the cubic overview filter
        # next to dark or fill pixels (0.1 % of pixels, median −0.0008); they are kept so that averages over
        # texels stay unbiased
        out.append(np.where(img != nod, img.astype(np.float32) * np.float32(MCD_SCALE), np.nan))
        lv0 = lv0 or lv
    return lv0, np.stack(out), recs


def _sinusoidal_texels(lv, n: int, mask: WaterMask) -> tuple[np.ndarray, np.ndarray]:
    """For the n × n pixels of a tile overview: texel flat index (planetocentric level-4 grid; −1 off the globe)
    and water flag. Pixel centres are mapped exactly (sinusoidal inverse on the MODIS sphere, whose latitude is
    WGS84 geodetic)."""
    h, w = st.level_shape(LEVEL)
    s = lv.scale[0] * lv.full_shape[0] / n
    x0, y0 = lv.tiepoint
    x = x0 + (np.arange(n) + 0.5) * s
    y = y0 - (np.arange(n) + 0.5) * s
    phi_g = np.degrees(y / MODIS_R)
    coslat = np.cos(np.radians(phi_g))
    lam = np.degrees(x[None, :] / (MODIS_R * np.maximum(coslat[:, None], 1e-12)))
    on = np.abs(lam) <= 180.0
    phi_c = centric_from_geodetic(phi_g)
    row = np.clip(np.floor((90.0 - phi_c) / (180.0 / h)).astype(np.int64), 0, h - 1)
    col = np.floor((np.clip(lam, -180, 180 - 1e-9) + 180.0) / (360.0 / w)).astype(np.int64)
    idx = np.where(on, row[:, None] * w + col, -1)
    wat = mask.at(np.repeat(phi_g[:, None], n, axis=1), np.where(on, lam, 0.0))
    return idx, wat


def land_accumulate(mask: WaterMask) -> dict:
    """Box-average MCD43A4 NBAR (3 bands) into level-4 texels, separately for MOD44W land and water pixels."""
    h, w = st.level_shape(LEVEL)
    acc = {k: np.zeros((h * w, 3), np.float32) for k in ("land", "water")}
    cnt = {k: np.zeros(h * w, np.uint16) for k in ("land", "water")}
    doy, items, stac_paths = mcd43_items()
    sas = _Sas()
    files, fill = {}, [0, 0]
    t0 = time.time()
    with cf.ThreadPoolExecutor(6) as ex:
        for k0 in range(0, len(items), 12):
            for lv, refl, recs in ex.map(lambda it: _mcd43_tile(it, sas), items[k0:k0 + 12]):
                files.update(recs)
                n = refl.shape[1]
                idx, wat = _sinusoidal_texels(lv, n, mask)
                good = np.isfinite(refl).all(axis=0)
                fill[0] += int(((idx >= 0) & ~good).sum())
                fill[1] += int((idx >= 0).sum())
                ok = (idx >= 0) & good
                for kind, sel in (("land", ok & ~wat), ("water", ok & wat)):
                    ii = idx[sel]
                    if ii.size == 0:
                        continue
                    lo = int(ii.min())
                    loc = ii - lo
                    m = int(loc.max()) + 1
                    cnt[kind][lo:lo + m] += np.bincount(loc, minlength=m).astype(np.uint16)
                    for b in range(3):
                        acc[kind][lo:lo + m, b] += np.bincount(loc, weights=refl[b][sel],
                                                               minlength=m).astype(np.float32)
            print(f"[surfaces] Earth MCD43A4 {doy}: {min(k0 + 12, len(items))}/{len(items)} tiles "
                  f"({time.time() - t0:.0f} s)", flush=True)
    return {"doy": doy, "items": items, "stac": stac_paths, "files": files, "acc": acc, "cnt": cnt,
            "fillFraction": fill[0] / max(fill[1], 1)}


def ocean_rrs() -> tuple[np.ndarray, dict, str]:
    """OC-CCI v6.0 monthly Rrs (6 bands) at each level-4 texel centre (nearest 4 km cell), as ρw = π·Rrs;
    NaN where a band is missing. Downloaded in four longitude blocks through the THREDDS subset service."""
    import h5py
    h, w = st.level_shape(LEVEL)
    y, m = OC_MONTH.split("-")
    base = OC_NCSS.format(y=y, m=m)
    names = [f"Rrs_{int(b)}" for b in OC_BANDS]
    out = np.full((h, w, len(OC_BANDS)), np.nan, np.float32)
    lat_g = geodetic_from_centric(st.lat_centers(LEVEL))
    lon = st.lon_centers(LEVEL)
    files = {}
    for q in range(4):
        west, east = -180 + 90 * q, -90 + 90 * q
        query = "&".join([f"var={v}" for v in names] + [f"north=90&south=-90&west={west}&east={east}",
                                                         "horizStride=1&accept=netcdf4"])
        pth = fetch(f"{base}?{query}", f"{SUBDIR}/occci", f"occci-rrs-{y}{m}-lon{west}.nc", timeout=900,
                    validate=lambda p: p.read_bytes()[:8] == b"\x89HDF\r\n\x1a\n")
        files[pth.name] = record(pth)
        with h5py.File(pth, "r") as f:
            la, lo = f["lat"][:], f["lon"][:]
            dla, dlo = abs(la[1] - la[0]), abs(lo[1] - lo[0])
            sel = (lon >= west) & (lon < east)
            ci = np.clip(np.round((lon[sel] - lo[0]) / dlo).astype(int), 0, lo.size - 1)
            if la[0] > la[-1]:
                ri = np.clip(np.round((la[0] - lat_g) / dla).astype(int), 0, la.size - 1)
            else:
                ri = np.clip(np.round((lat_g - la[0]) / dla).astype(int), 0, la.size - 1)
            if np.abs(lo[ci] - lon[sel]).max() > dlo or np.abs(la[ri] - lat_g).max() > dla:
                raise ValueError(f"{pth.name}: grid lookup failed")
            for b, v in enumerate(names):
                ds = f[v]
                fillv = ds.attrs.get("_FillValue")
                a = (ds[0] if ds.ndim == 3 else ds[:])[np.ix_(ri, ci)].astype(np.float32)
                if fillv is not None:
                    a[a == np.float32(np.ravel(fillv)[0])] = np.nan
                a[~(np.abs(a) < 1)] = np.nan
                out[:, sel, b] = np.pi * a
        discard(pth)
    return out, files, base


def build_albedo(ctx: BuildContext, mask: WaterMask) -> dict:
    from . import surf_color as sc
    from .photometry import solar
    h, w = st.level_shape(LEVEL)
    e = solar.spectrum().grid
    ones = np.ones_like(e)
    c_land = [b[1] for b in MCD_BANDS]
    W_land = sc.channel_weights(c_land, ones, e)
    W_oc = sc.channel_weights(OC_BANDS, ones, e)
    diag_land = sc.diagnostics(c_land, ones, e)
    diag_oc = sc.diagnostics(OC_BANDS, ones, e)

    oc, oc_files, oc_url = ocean_rrs()
    neg = int((oc < 0).sum())
    oc = np.maximum(oc, 0)
    la = land_accumulate(mask)
    fw = mask.fraction
    top = np.zeros((h, w, 4), np.float32)
    known = np.zeros((h, w), bool)
    part = {"land": 0.0, "ocean": 0.0, "modisWater": 0.0}
    rng = np.random.default_rng(NAIF)
    samples_land, samples_oc = [], []
    strip = 256
    lat = st.lat_centers(LEVEL)
    for r0 in range(0, h, strip):
        rs = slice(r0, r0 + strip)
        fl = slice(r0 * w, (r0 + strip) * w)
        nl = la["cnt"]["land"][fl].reshape(strip, w)
        nw = la["cnt"]["water"][fl].reshape(strip, w)
        with np.errstate(invalid="ignore", divide="ignore"):
            bl = la["acc"]["land"][fl].reshape(strip, w, 3) / nl[..., None]
            bw = la["acc"]["water"][fl].reshape(strip, w, 3) / nw[..., None]
        L = bl @ W_land.T
        Wm = bw @ W_land.T
        ocs = oc[rs]
        oc_x = ocs @ W_oc.T
        ko = np.isfinite(oc_x).all(axis=-1)
        kl = nl > 0
        kw_m = nw > 0
        water_val = np.where(ko[..., None], oc_x, Wm)
        kw = ko | kw_m
        f = fw[rs]
        wl = np.where(kl & (f < 1), 1 - f, 0).astype(np.float32)
        ww = np.where(kw & (f > 0), f, 0).astype(np.float32)
        den = wl + ww
        k = den > 0
        with np.errstate(invalid="ignore", divide="ignore"):
            val = (wl[..., None] * np.nan_to_num(L) + ww[..., None] * np.nan_to_num(water_val)) / den[..., None]
        top[rs] = np.where(k[..., None], val, 0)
        known[rs] = k
        wr = np.cos(np.radians(lat[rs]))[:, None] ** 2
        part["land"] += float((wr * wl).sum())
        part["ocean"] += float((wr * ww * ko).sum())
        part["modisWater"] += float((wr * ww * (~ko & kw_m)).sum())
        jl = np.argwhere(kl & (f == 0))
        if jl.size:
            pick = jl[rng.choice(len(jl), size=min(300, len(jl)), replace=False)]
            samples_land += [bl[a, b] for a, b in pick]
        jo = np.argwhere(ko & (f == 1))
        if jo.size:
            pick = jo[rng.choice(len(jo), size=min(300, len(jo)), replace=False)]
            samples_oc += [ocs[a, b] for a, b in pick]
    del la["acc"], la["cnt"], oc
    negative_texels = int((known & (top < 0).any(axis=-1)).sum())
    np.maximum(top, 0, out=top)
    absolute = st.disk_mean(top, known, LEVEL)
    top /= absolute.astype(np.float32)[None, None, :]
    top[~known] = 0
    check = st.disk_mean(top, known, LEVEL)
    spread_land = sc.interpolation_spread(np.array(samples_land), c_land, ones, e)
    spread_oc = sc.interpolation_spread(np.array(samples_oc), OC_BANDS, ones, e)
    tot = sum(part.values())
    share = {k: round(v / tot, 5) for k, v in part.items()}

    first = la["items"][0]["properties"]
    pc_id = sl.register_dataset(
        ctx, SRC_PC, "Microsoft Planetary Computer STAC API and cloud-optimized MODIS v061 copies",
        "Microsoft Open Source, McFarland, M., Emanuele, R., Morris, D. & Augspurger, T. (2022). "
        "microsoft/PlanetaryComputer: October 2022 (2022.10.28). Zenodo. doi:10.5281/zenodo.7261897. Collection "
        f"{MCD_COLLECTION} (cloud-optimized GeoTIFF conversions of the LP DAAC HDF files).",
        PC_STAC, {p.name: record(p) for p in la["stac"]}, license="MODIS data: no restrictions (NASA data policy)",
        notes=f"STAC search responses for the pinned centre day {MCD_DAY}; exact granule ids and band URLs are "
              f"pinned by sha256 {MCD_GRANULES_SHA256}. Files are read with an anonymous read token that is not "
              "recorded.")
    sl.register_dataset(
        ctx, SRC_MCD43, f"MODIS Terra+Aqua BRDF-adjusted nadir reflectance MCD43A4 v061, {la['doy']}",
        "Schaaf, C. & Wang, Z. (2021). MODIS/Terra+Aqua BRDF/Albedo Nadir BRDF Adjusted Ref Daily L3 Global - 500m "
        "V061. NASA EOSDIS Land Processes DAAC. doi:10.5067/MODIS/MCD43A4.061. Algorithm: Schaaf, C. B. et al. "
        "(2002). First operational BRDF, albedo nadir reflectance products from MODIS. Remote Sensing of "
        "Environment 83, 135-148. doi:10.1016/S0034-4257(02)00091-3.",
        la["items"][0]["assets"][MCD_BANDS[0][0]]["href"].rsplit("/", 4)[0], la["files"], version="v061",
        license="NASA data policy (no restrictions)",
        notes=f"{len(la['items'])} sinusoidal tiles of {la['doy']} (16-day window {first['start_datetime'][:10]} to "
              f"{first['end_datetime'][:10]}), bands 3 (459-479 nm), 4 (545-565 nm), 1 (620-670 nm); for each "
              "band file the COG header and the first overview (926.6 m, a GDAL cubic 2 × 2 reduction as stated in "
              "the file's IMAGE_STRUCTURE metadata) were read by byte range and deleted after use.")
    sl.register_dataset(
        ctx, SRC_OCCCI, f"ESA Ocean Colour CCI v6.0 monthly remote-sensing reflectance, {OC_MONTH}",
        "Sathyendranath, S., Jackson, T., Brockmann, C., Brotas, V., Calton, B., Chuprin, A., Clements, O., "
        "Cipollini, P., Danne, O., Dingle, J., Donlon, C., Grant, M., Groom, S., Krasemann, H., Lavender, S., "
        "Mazeran, C., Mélin, F., Müller, D., Steinmetz, F., Valente, A., Zühlke, M., Feldman, G., Franz, B., Frouin, "
        "R., Werdell, J. & Platt, T. (2023). ESA Ocean Colour Climate Change Initiative (Ocean_Colour_cci): Version "
        "6.0, 4km resolution data. NERC EDS Centre for Environmental Data Analysis. "
        "doi:10.5285/5011d22aae5a4671b0cbc7d05c56c4f0.",
        oc_url, oc_files, version="v6.0", license="free and open (ESA CCI data policy; cite the dataset)",
        notes="THREDDS NetCDF subset service, variables " + ", ".join(f"Rrs_{int(b)}" for b in OC_BANDS)
              + ", four 90° longitude blocks at full 1/24° resolution; files deleted after use.")
    solar_src = SOLAR_SOURCE
    cie_src = ["cie-1931-2deg-cmf", "cie-1951-scotopic"]
    spec = sl.LayerSpec(
        naif=NAIF, body=NAME, layer="albedo", kind="relative-reflectance", fmt="f16", channels=list(sc.CHANNELS),
        coarse="half", frame=FRAME, sources=[SRC_MCD43, SRC_OCCCI, SRC_MOD44W, SRC_ETOPO, pc_id, solar_src, *cie_src],
        brightness=sl.Provenance(
            "measured", [SRC_MCD43, SRC_OCCCI, SRC_MOD44W, SRC_ETOPO],
            "Land: MODIS nadir BRDF-adjusted reflectance (reflectance factor for a nadir view with the Sun at local "
            "solar noon, from the 16-day multi-angle BRDF inversion; atmospherically corrected), box-averaged from "
            "926 m pixels. Water: water-leaving reflectance ρw = π·Rrs from the OC-CCI monthly composite (nearest "
            "4 km cell); where it has no value, the MODIS NBAR of water pixels (inland and coastal water). A texel "
            "mixes its land and water parts by the water fraction of the water layer; if one part is unknown, the "
            "texel is the known part. Channels are absolute reflectances ∫E☉·obs_c·r dλ / ∫E☉·obs_c dλ divided by their disk "
            "means (normalization.absoluteDiskMean).",
            "MCD43A4 NBAR: a few % (relative), more where only a magnitude inversion was possible; ocean ρw: tens "
            "of % in the red and in turbid or coastal water (atmospheric-correction residuals)"),
        color=sl.Provenance(
            sl.worst(diag_land.label, diag_oc.label), [SRC_MCD43, SRC_OCCCI, solar_src, *cie_src],
            "Reflectance interpolated linearly between band centres and held flat outside, integrated against "
            "sunlight and the CIE observers. Land: " + diag_land.reason + " Water: " + diag_oc.reason,
            "linear vs monotone-cubic interpolation, 99th percentile |Δ|: land "
            + ", ".join(f"{k} {v['p99'] * 100:.1f} %" for k, v in spread_land.items()) + "; water "
            + ", ".join(f"{k} {v['p99'] * 100:.1f} %" for k, v in spread_oc.items())
            + ". Vegetation's red edge (> 690 nm) is not sampled: the flat hold beyond 645 nm underestimates X "
              "slightly for green vegetation."),
        regions=[sl.Region(-90, 90, -180, 180,
                           sl.Provenance("measured", [SRC_MCD43, SRC_OCCCI], "land MCD43A4, water OC-CCI"),
                           note="Unknown: sea ice (neither product retrieves it), polar night and persistently "
                                "cloudy areas (no retrieval in the 16-day / monthly windows).")],
        epoch={"start": first["start_datetime"][:19] + "Z", "end": first["end_datetime"][:19] + "Z",
               "observed": f"land: MCD43A4 {la['doy']} (16-day window {first['start_datetime'][:10]} to "
                           f"{first['end_datetime'][:10]}, weighted to its centre day {first['datetime'][:10]}); "
                           f"water: OC-CCI monthly composite {OC_MONTH} (the same season one year earlier, the "
                           "most recent September available)",
               "changes": "vegetation, snow, crops, fires and phytoplankton change over days to months; the map "
                          "is one season"},
        normalization={
            "weighting": "cos²(lat) projected area at zero phase, equatorial observer, rotation-averaged; known "
                         "texels only",
            "absoluteDiskMean": {c: round(float(v), 6) for c, v in zip(sc.CHANNELS, absolute)},
            "absoluteMeaning": "texel × absoluteDiskMean[c] = absolute surface reflectance factor in channel c "
                               "(sunlight-weighted observer average of the reflectance spectrum; no atmosphere, no "
                               "clouds, no specular water reflection). Earth's disk photometry (photometry.json) "
                               "includes clouds and atmosphere and must not be used to scale this map.",
            "lambertSphereGeometricAlbedo": {c: round(float(v) * 2 / 3, 6) for c, v in zip(sc.CHANNELS, absolute)},
            "channelWeights": {"land": {"bandsNm": c_land, "W": [[round(float(x), 6) for x in r] for r in W_land]},
                               "water": {"bandsNm": list(OC_BANDS),
                                         "W": [[round(float(x), 6) for x in r] for r in W_oc]}},
            "texelDiskMeanCheck": [round(float(x), 5) for x in check]},
        diagnostics={"colorLand": diag_land.to_json(), "colorWater": diag_oc.to_json(),
                     "interpolationSpreadLand": spread_land, "interpolationSpreadWater": spread_oc,
                     "diskWeightShare": share, "mcd43FillFraction": round(la["fillFraction"], 5),
                     "negativeRrsClipped": neg, "negativeTexelsClipped": negative_texels,
                     "mcd43Tiles": len(la["items"])},
        notes=["NBAR is the reflectance for a nadir view with the Sun at the local-noon zenith angle of the centre "
               "day, not the reflectance at normal incidence; land surfaces are strongly non-Lambertian (hot spot, "
               "forward scattering), which the renderer's photometric model must supply.",
               "Water texels hold only the diffuse water-leaving part; the specular Fresnel reflection of sun and sky "
               "and the glint follow from the water layer.",
               "MOD44W water pixels without an OC-CCI value (lakes, rivers, some coasts) use the MCD43A4 NBAR, whose "
               "land atmospheric correction is less suited to dark water."],
    )
    return sl.write_layer(ctx, spec, top, known, LEVEL)


# ---------------------------------------------------------------------------------------------- wind

WIND_DAY = CLOUD_DAY                  # the day of the cloud snapshot
WIND_LEVEL = 2                        # 0.176° texels; the sources are on a 0.25° grid
AMSR3_URL = ("https://data.remss.com/amsr3/ocean/L3/V2.0/daily/{y}/RSS_AMSR3_ocean_L3_daily_{d}_v2.0.nc")
GMI_URL = "https://data.remss.com/gmi/bmaps_v08.2/y{y}/m{m}/f35_{ymd}v8.2.gz"
SRC_AMSR3 = "rss-amsr3-l3-daily"
SRC_GMI = "rss-gmi-bmaps-daily"


def _amsr3(day: str) -> tuple[np.ndarray, np.ndarray, np.ndarray, Path]:
    """(MF wind [pass, lat, lon] with NaN, latitude, longitude) from the RSS AMSR3 V2.0 daily L3 file."""
    import h5py
    p = fetch(AMSR3_URL.format(y=day[:4], d=day), f"{SUBDIR}/wind", timeout=600,
              validate=lambda q: q.read_bytes()[:8] == b"\x89HDF\r\n\x1a\n")
    with h5py.File(p, "r") as f:
        w = f["wind_speed_MF"][:].astype(np.float32)
        fill = float(np.ravel(f["wind_speed_MF"].attrs["_FillValue"])[0])
        passes = [int(x) for x in f["pass"][:]]
        lat, lon = f["lat"][:], f["lon"][:]
    if passes != [1, 2]:
        raise ValueError(f"{p.name}: unexpected pass order {passes}")
    w[(w == fill) | ~(w >= 0) | (w > 70)] = np.nan
    return w, lat, lon, p


def _gmi(day: str) -> tuple[np.ndarray, Path]:
    """GMI daily bytemap (RSS v8.2): uint8 [2 passes][7 variables][720 lat, south first][1440 lon from 0.125°E];
    variable 3 = 10 m wind speed (medium frequency) × 0.2 m/s; bytes > 250 are land, ice, no data or bad."""
    import gzip
    y, m, dd = day.split("-")
    p = fetch(GMI_URL.format(y=y, m=m, ymd=f"{y}{m}{dd}"), f"{SUBDIR}/wind", timeout=600)
    raw = np.frombuffer(gzip.decompress(p.read_bytes()), np.uint8)
    if raw.size != 2 * 7 * 720 * 1440:
        raise ValueError(f"{p.name}: {raw.size} bytes, expected {2 * 7 * 720 * 1440}")
    b = raw.reshape(2, 7, 720, 1440)[:, 3].astype(np.float32)
    return np.where(b <= 250, b * np.float32(0.2), np.nan), p


def build_wind(ctx: BuildContext) -> dict:
    amsr3, lat, lon, p_amsr3 = _amsr3(WIND_DAY)
    gmi, p_gmi = _gmi(WIND_DAY)
    if not (np.allclose(lat, -89.875 + 0.25 * np.arange(720)) and np.allclose(lon, 0.125 + 0.25 * np.arange(1440))):
        raise ValueError("AMSR3 grid differs from the RSS 0.25° bytemap grid")
    h, w = st.level_shape(WIND_LEVEL)
    lat_g = geodetic_from_centric(st.lat_centers(WIND_LEVEL))
    ri = np.clip(np.floor((lat_g + 90.0) / 0.25).astype(int), 0, 719)
    ci = np.floor(np.mod(st.lon_centers(WIND_LEVEL), 360.0) / 0.25).astype(int) % 1440
    asc = amsr3[0][np.ix_(ri, ci)]
    stack = np.stack([amsr3[0], amsr3[1], gmi[0], gmi[1]])[:, ri][:, :, ci]
    n = np.isfinite(stack).sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(n > 0, np.nansum(stack, axis=0) / np.maximum(n, 1), np.nan)
    top = np.stack([asc, mean, np.where(n > 0, n, np.nan)], axis=-1).astype(np.float32)
    known = np.isfinite(mean)
    for sid, pth, title, cit in (
            (SRC_AMSR3, p_amsr3, f"RSS AMSR3 V2.0 daily ocean products (GOSAT-GW), {WIND_DAY}",
             "Wentz, F., Meissner, T., Ricciardulli, L., Mears, C., Densberger, M. & Nelson, K. (2026). Remote "
             "Sensing Systems AMSR3 V2.0 Air-Sea Essential Climate Variables (AS-ECV) on 0.25 deg grid, version 1.0. "
             "Remote Sensing Systems, Santa Rosa, CA. www.remss.com/missions/amsr/"),
            (SRC_GMI, p_gmi, f"RSS GMI (GPM) version 8.2 daily ocean bytemaps, {WIND_DAY}",
             "Wentz, F.J., Draper, D. & Remote Sensing Systems (2015, updated daily). RSS GMI daily environmental "
             "suite on 0.25 deg grid, Version 8.2. Remote Sensing Systems, Santa Rosa, CA. "
             "www.remss.com/missions/gmi")):
        sl.register_dataset(ctx, sid, title, cit, AMSR3_URL if sid == SRC_AMSR3 else GMI_URL, {pth.name: record(pth)},
                            version="V2.0" if sid == SRC_AMSR3 else "v8.2",
                            license="free with attribution (Remote Sensing Systems data policy)",
                            notes="10 m ocean-surface wind speed, medium-frequency algorithm (18.7-36.5 GHz); "
                                  "0.25° grid, ascending and descending passes.")
    spec = sl.LayerSpec(
        naif=NAIF, body=NAME, layer="wind", kind="surface-wind", fmt="f16", nodata="nan",
        channels=["windSpeed10mAscending", "windSpeed10mDailyMean", "passes"],
        frame=FRAME, sources=[SRC_AMSR3, SRC_GMI],
        brightness=sl.Provenance(
            "measured", [SRC_AMSR3, SRC_GMI],
            "Microwave-radiometer retrievals of the 10 m ocean-surface wind speed (RSS medium-frequency algorithm). "
            "windSpeed10mAscending: AMSR3 ascending pass (~13:30 local solar time, the local time of the cloud "
            "layer's NOAA-20 overpass). windSpeed10mDailyMean: mean of all AMSR3 and GMI passes of the UTC day that "
            "saw the cell (count in `passes`). Nearest 0.25° cell per texel.",
            "~1 m/s rms against buoys for rain-free retrievals; no value in rain, near land (~50 km), over sea ice "
            "or between swaths (NaN)"),
        epoch={"start": f"{WIND_DAY}T00:00:00Z", "end": f"{WIND_DAY}T23:59:59Z",
               "observed": f"{WIND_DAY}: AMSR3 ascending ~13:30 and descending ~01:30 local solar time; GMI "
                           "(GPM, 65° inclination, precessing) passes within ±70° latitude",
               "changes": "winds change over hours; glint rendered at another time is estimated"},
        units="m/s",
        constants={
            "channels": {"windSpeed10mAscending": "m/s at 10 m, AMSR3 ascending pass",
                         "windSpeed10mDailyMean": "m/s at 10 m, mean of the day's AMSR3 and GMI passes",
                         "passes": "number of passes averaged (1-4)"},
            "coxMunk": {"formula": "σ² = 0.003 + 5.12e-3·U (sum of the two slope variances, clean sea)",
                        "reference": "Cox, C. & Munk, W. (1954). Measurement of the roughness of the sea surface "
                                     "from photographs of the sun's glitter. J. Opt. Soc. Am. 44, 838-850",
                        "height": "Cox & Munk measured U at 12.5 m; for a neutral logarithmic profile with roughness "
                                  "length ~0.2 mm, U(12.5 m) ≈ 1.02·U(10 m), within their fit's scatter, so U10 can "
                                  "be used directly (or multiplied by 1.02)"},
            "sourceDate": WIND_DAY},
        diagnostics={"knownFraction": round(float(known.mean()), 4),
                     "ascendingKnownFraction": round(float(np.isfinite(asc).mean()), 4),
                     "meanWindSpeed": round(float(np.nanmean(mean)), 3)},
        notes=["Ocean only: land, sea ice and cells near coasts are NaN (use the water layer for where water is)."],
    )
    return sl.write_layer(ctx, spec, top, known, WIND_LEVEL)


def build(ctx: BuildContext, work: Path) -> list[dict]:
    only = set(ctx.param("surfaces.earthLayers"))
    out = []
    if not only or "clouds" in only:
        out.extend(build_clouds(ctx))          # clouds and cloudTau (same samples)
    if not only or "night" in only:
        out.append(build_night(ctx))
    if not only or {"water", "albedo"} & only:
        mask = WaterMask()
        if not only or "water" in only:
            out.append(build_water(ctx, mask))
        if not only or "albedo" in only:
            out.append(build_albedo(ctx, mask))
    if not only or "wind" in only:
        out.append(build_wind(ctx))
    return out
