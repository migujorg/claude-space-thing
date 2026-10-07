"""NASA Langley SatCORPS Global Cloud Composite (GEO-LEO global, V2): reader and reducer for the Earth's clouds.

The product (docs/sources/satcorps-gcc.md): hourly netCDF-4 files on a 1/36° latitude-longitude grid, each cell
holding the cloud retrieval of one satellite chosen by the provider (five geostationary imagers and NOAA-20
VIIRS), with its class (`cloud_phase`), visible optical depth, top height, source (`satellite_ID`), observation
time (`relative_time`) and geometry. Nothing in a file says how a cell's value was obtained, so the groups
below are decided from the class, the solar zenith angle and the viewing geometry.

What the Earth layer takes (surf_earth.build_clouds):

- **Each longitude from the hourly file nearest 13:30 local solar time** of the pinned UTC day (`strips`): 24
  strips of 15°, cut hard at multiples of 15°; the 24-hour cut is at 150° W. Only the strip's columns of nine
  variables are read, by HTTP Range requests (`RangeFile`): every byte range is a raw file with a ledger entry.
- **A class per cell** (`classify`): not observed; clear; cloud with a thickness retrieved from sunlight
  (`MEASURED`); cloud whose thickness is the provider's estimate (`ESTIMATED`: night and twilight, and the
  geometry where the provider's processing is evidently different); "possible" cloud; cloud without a value.
- **Area-overlap aggregation** to the texel grid (`aggregate`, `layers`): shares and ln τ sums per texel, never a
  value across a hole.
"""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass, field
from pathlib import Path

import h5py
import numpy as np
import scipy.sparse as sp

from . import download

PRODUCT_DIR = "https://satcorps.larc.nasa.gov/prod/GCC-GEO-LEO/visst-pixel-netcdf-v2/"
FILE_NAME = "satcorps-gcc.v02.geoleo.glob-comp.{year}{doy:03d}.{hour:02d}00.3km.nc"
SUBDIR = "surfaces/earth/satcorps"
LOCAL_SOLAR_HOUR = 13.5        # the local time of the product's own polar orbiter and of the Earth's wind layer
META_BLOCK = 1 << 16           # small reads (HDF5 metadata) are fetched in aligned blocks of this size
VARIABLES = ("satellite_ID", "cloud_phase", "relative_time", "solar_zenith", "view_zenith", "relative_azimuth",
             "cloud_optical_depth", "cloud_top_height", "surface_type")

# `satellite_ID` (the file's ID_legend). A source not listed here is an input change, not a default.
GEOSTATIONARY = {52: "Meteosat-9", 53: "Meteosat-10", 190: "GOES-18", 192: "GOES-19", 287: "Himawari-9"}
POLAR = {321: "NOAA-20 VIIRS"}
# `cloud_phase` (the file's legend): 0 clear snow/ice, 1 water cloud, 2 ice cloud, 3 no cloud-property retrieval,
# 4 clear land/water, 5 bad input data, 6 possible water cloud, 7 possible ice cloud, 13 cleaned data.
PHASE_CLEAR, PHASE_CLOUD, PHASE_NO_RETRIEVAL, PHASE_POSSIBLE, PHASE_UNUSABLE = (0, 4), (1, 2), (3,), (6, 7), (5, 13)
PHASE_ICE = 2
WATER_SURFACE = 17             # `surface_type` (CERES surface types): water

# Minnis et al. (2008), Proc. SPIE 7107, §3, p. 4, and Minnis et al. (2021), IEEE TGRS 59, 2744, §III-A, p. 5:
# the solar retrieval (VISST) runs where the solar zenith angle is below 82°; otherwise thermal channels only,
# a thickness for thin cloud alone, thick cloud a default and, in V2, a k-nearest-neighbour extrapolation
# (SatCORPS GCC overview v2, slides 8-9).
DAY_SZA_DEG = 82.0
# Not documented; found in the files (docs/sources/satcorps-gcc.md, "Where the processing differs"). In the
# geostationary cells the provider's "possible" classes stop at a solar zenith angle of 75.25° on every satellite,
# and over water they all but stop within 40° of the Sun's mirror direction in the strips used here. The overview
# (slide 7) lists an extrapolation "from surrounding space/time" for "data products in the solar terminator and
# sun-glint"; no cell is flagged. A thickness in that geometry is therefore taken as the provider's estimate.
GEO_QUALIFIED_SZA_DEG = 75.25
GLINT_CONE_DEG = 40.0

# Classes of a cell.
UNOBSERVED, CLEAR, MEASURED, ESTIMATED, POSSIBLE, NO_THICKNESS = range(6)
CLASS_NAMES = {UNOBSERVED: "notObserved", CLEAR: "clear", MEASURED: "cloudMeasuredThickness",
               ESTIMATED: "cloudEstimatedThickness", POSSIBLE: "possibleCloud", NO_THICKNESS: "cloudWithoutThickness"}


# ------------------------------------------------------------------------------------------------------ strips


@dataclass(frozen=True)
class Strip:
    hour: int            # nominal UTC hour of the file
    url: str
    lon_west: float      # the strip is lon_west < λ ≤ lon_east (degrees east)
    lon_east: float


def file_url(day: str, hour: int) -> str:
    import datetime as _dt
    d = _dt.date.fromisoformat(day)
    return (f"{PRODUCT_DIR}{d.year}/{d.month:02d}/{d.day:02d}/"
            + FILE_NAME.format(year=d.year, doy=d.timetuple().tm_yday, hour=hour))


def strips(day: str) -> list[Strip]:
    """The 24 strips of a UTC day: the file of hour h serves the 15° of longitude whose local solar time at h is
    within half an hour of 13:30 (h + λ/15 = 13.5 at the strip's centre). The 24-hour step is at 150° W, between
    the strips of 23 and 00 UTC."""
    out = []
    for h in range(24):
        west = 15.0 * (LOCAL_SOLAR_HOUR - 0.5 - h)
        if west >= 180.0:
            west -= 360.0
        out.append(Strip(h, file_url(day, h), west, west + 15.0))
    return out


def columns(lon: np.ndarray, strip: Strip) -> slice:
    """The columns of a file whose cell centres lie in the strip (lon ascending)."""
    return slice(int(np.searchsorted(lon, strip.lon_west, side="right")),
                 int(np.searchsorted(lon, strip.lon_east, side="right")))


# ------------------------------------------------------------------------------------------------ range reader


class RangeFile(io.RawIOBase):
    """A remote file read through `download.fetch(byte_range=…)`: h5py opens it and reads only what a slice needs.
    A read larger than META_BLOCK (HDF5 reads each compressed chunk in one call) is fetched as exactly that
    range; smaller reads (metadata) come from aligned META_BLOCK blocks. Every range is a raw file of its own
    with a ledger entry (range, sha256, the remote file's size, ETag and Last-Modified), so a rebuild reads the
    same bytes without the network."""

    def __init__(self, url: str, subdir: str = SUBDIR):
        super().__init__()
        self.url = url
        self.subdir = f"{subdir}/{url.rstrip('/').split('/')[-1]}"
        self.paths: list[Path] = []
        self._blocks: dict[int, bytes] = {}
        self.pos = 0
        first = self._fetch(0, META_BLOCK)
        e = download.record(first)
        if not e.get("remoteBytes"):
            raise OSError(f"{url}: the server did not state the file's size")
        self.size = int(e["remoteBytes"])
        self.remote = {"bytes": self.size, "etag": e.get("etag"), "lastModified": e.get("lastModified")}

    def _fetch(self, start: int, stop: int) -> Path:
        p = download.fetch(self.url, self.subdir, f"{start:012d}-{stop:012d}.bin", byte_range=(start, stop), timeout=300.0)
        if p not in self.paths:
            self.paths.append(p)
        return p

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def _block(self, k: int) -> bytes:
        if k not in self._blocks:
            self._blocks[k] = self._fetch(k * META_BLOCK, min((k + 1) * META_BLOCK, self.size)
                                          if k else META_BLOCK).read_bytes()
        return self._blocks[k]

    def readinto(self, b):
        n = min(len(b), self.size - self.pos)
        if n <= 0:
            return 0
        if n > META_BLOCK:
            data = self._fetch(self.pos, self.pos + n).read_bytes()
        else:
            k0, k1 = self.pos // META_BLOCK, (self.pos + n - 1) // META_BLOCK
            data = b"".join(self._block(k) for k in range(k0, k1 + 1))
            off = self.pos - k0 * META_BLOCK
            data = data[off:off + n]
        if len(data) != n:
            raise OSError(f"{self.url}: {len(data)} bytes where {n} were asked at {self.pos}")
        b[:n] = data
        self.pos += n
        return n


@dataclass
class StripData:
    strip: Strip
    lat: np.ndarray                      # cell-centre latitudes of the file, north first
    lon: np.ndarray                      # cell-centre longitudes of the strip's columns
    arrays: dict[str, np.ndarray]        # packed values, (lat, strip columns)
    attrs: dict[str, dict]               # per variable: scale, fill, valid (packed range)
    remote: dict                         # the remote file's bytes, etag, lastModified
    granules: list[str]
    reference_time: str
    version: str
    sources: str
    paths: list[Path]
    digest: str                          # sha256 of the strip's packed arrays (the content pin)


def _text(x) -> str:
    return x.decode("utf-8", "replace") if isinstance(x, bytes) else str(x)


def read_strip(strip: Strip, pin: dict | None, subdir: str = SUBDIR) -> StripData:
    """The strip's columns of every layer variable. `pin` = {bytes, etag, lastModified, sha256}: the remote file
    and the decoded content this build was made with; a difference is an error, never a silent update. None reads
    unpinned (first acquisition, tests)."""
    rf = RangeFile(strip.url, subdir)
    if pin is not None:
        for k in ("bytes", "etag", "lastModified"):
            if pin.get(k) != rf.remote[k]:
                raise ValueError(f"{strip.url}: the remote file differs from its pin ({k}: {rf.remote[k]!r}, pinned "
                                 f"{pin.get(k)!r}); updating the pin is an explicit input change")
    with h5py.File(rf, "r") as f:
        lat = f["lat"][:].astype(np.float64)
        lon_all = f["lon"][:].astype(np.float64)
        if not (np.all(np.diff(lon_all) > 0) and np.all(np.diff(lat) < 0)):
            raise ValueError(f"{strip.url}: grid is not north-first, west-first")
        cols = columns(lon_all, strip)
        arrays, attrs = {}, {}
        for n in VARIABLES:
            ds = f[n]
            arrays[n] = ds[0, :, cols]
            lo, hi = (int(v) for v in ds.attrs["valid_range"])
            attrs[n] = {"scale": float(np.ravel(ds.attrs["scale_factor"])[0]), "fill": int(np.ravel(ds.attrs["_FillValue"])[0]),
                        "valid": (lo, hi)}
        granules = [_text(g) for g in f["granule_name_list"][:]]
        ref, version, sources = (_text(f.attrs.get(k, "")) for k in ("reference_time", "version", "satellite_sources"))
    h = hashlib.sha256()
    for n in sorted(arrays):
        a = np.ascontiguousarray(arrays[n])
        h.update(f"{n}:{a.dtype.str}:{a.shape}:".encode())
        h.update(a.tobytes())
    digest = h.hexdigest()
    if pin is not None and pin.get("sha256") != digest:
        raise ValueError(f"{strip.url}: the strip's content differs from its pin (sha256 {digest}, pinned {pin.get('sha256')})")
    return StripData(strip, lat, lon_all[cols], arrays, attrs, rf.remote, granules, ref, version, sources, list(rf.paths), digest)


# ------------------------------------------------------------------------------------------------------ classes


def glint_angle_deg(sza_deg, vza_deg, raa_deg):
    """Angle between the view direction and the Sun's mirror direction about the local vertical, from the file's
    own angles: cos Θ = cos θ0 cos θ + sin θ0 sin θ cos φ. The file's relative azimuth φ is 0 on the forward
    (mirror) side: with this sign Θ agrees with the angle computed from the satellite's and the Sun's positions to
    0.4° rms over 7.5 million Himawari-9 cells of the 04:00 UTC file of 2026-09-28; with the other, to 72°."""
    t0, tv, ph = np.radians(sza_deg), np.radians(vza_deg), np.radians(raa_deg)
    return np.degrees(np.arccos(np.clip(np.cos(t0) * np.cos(tv) + np.sin(t0) * np.sin(tv) * np.cos(ph), -1.0, 1.0)))


def _valid(a: dict, attrs: dict, name: str) -> np.ndarray:
    v, at = a[name], attrs[name]
    return (v != at["fill"]) & (v >= at["valid"][0]) & (v <= at["valid"][1])


def _packed(limit: float, scale: float) -> int:
    """A physical limit as a packed integer (the files store angles in hundredths of a degree as float32 factors,
    so the comparison is made on the stored integers)."""
    return int(round(limit / scale))


def geometry(a: dict[str, np.ndarray], attrs: dict[str, dict]) -> dict[str, np.ndarray]:
    """The masks the groups are decided from (packed arrays in, booleans out)."""
    sid = a["satellite_ID"]
    sza = a["solar_zenith"]
    sza_ok = _valid(a, attrs, "solar_zenith")
    scale = attrs["solar_zenith"]["scale"]
    geo = np.isin(sid, list(GEOSTATIONARY))
    angles_ok = sza_ok & _valid(a, attrs, "view_zenith") & _valid(a, attrs, "relative_azimuth")
    theta = glint_angle_deg(sza * scale, a["view_zenith"] * attrs["view_zenith"]["scale"],
                            a["relative_azimuth"] * attrs["relative_azimuth"]["scale"])
    water = a["surface_type"] == WATER_SURFACE
    return {"geo": geo, "water": water, "szaKnown": sza_ok,
            "night": ~sza_ok | (sza >= _packed(DAY_SZA_DEG, scale)),
            "lowSun": geo & sza_ok & (sza >= _packed(GEO_QUALIFIED_SZA_DEG, scale)),
            "inCone": angles_ok & (theta < GLINT_CONE_DEG), "anglesKnown": angles_ok}


def classify(a: dict[str, np.ndarray], attrs: dict[str, dict], g: dict[str, np.ndarray] | None = None) -> np.ndarray:
    """Class of every cell (module constants), from the packed arrays of `VARIABLES`."""
    sid, ph = a["satellite_ID"], a["cloud_phase"]
    covered = _valid(a, attrs, "satellite_ID")
    unknown_source = covered & ~np.isin(sid, list(GEOSTATIONARY) + list(POLAR))
    if unknown_source.any():
        raise ValueError(f"satellite_ID values {np.unique(sid[unknown_source]).tolist()} are not in the product's legend "
                         "as read into this module: a new source is an input change")
    listed = PHASE_CLEAR + PHASE_CLOUD + PHASE_NO_RETRIEVAL + PHASE_POSSIBLE + PHASE_UNUSABLE
    odd = covered & (ph != attrs["cloud_phase"]["fill"]) & ~np.isin(ph, listed)
    if odd.any():
        raise ValueError(f"cloud_phase values {np.unique(ph[odd]).tolist()} have no legend: not assigned to any class")
    observed = covered & np.isin(ph, PHASE_CLEAR + PHASE_CLOUD + PHASE_NO_RETRIEVAL + PHASE_POSSIBLE)
    cls = np.full(ph.shape, UNOBSERVED, np.uint8)
    cls[observed & np.isin(ph, PHASE_CLEAR)] = CLEAR
    cls[observed & np.isin(ph, PHASE_POSSIBLE)] = POSSIBLE
    cls[observed & np.isin(ph, PHASE_NO_RETRIEVAL)] = NO_THICKNESS
    cloud = observed & np.isin(ph, PHASE_CLOUD)
    has_tau = cloud & _valid(a, attrs, "cloud_optical_depth")
    cls[cloud & ~has_tau] = NO_THICKNESS
    # Which thickness is a retrieval from sunlight, and which the provider's estimate: night and twilight (documented);
    # a geostationary cell with the Sun at 75.25° or more from the zenith, or over water within 40° of the Sun's
    # mirror direction (not documented, found in the files; a cell whose angles are missing cannot be shown to lie
    # outside the cone).
    g = g or geometry(a, attrs)
    glint = g["geo"] & g["water"] & (g["inCone"] | ~g["anglesKnown"])
    estimated = g["night"] | g["lowSun"] | glint
    cls[has_tau & ~estimated] = MEASURED
    cls[has_tau & estimated] = ESTIMATED
    return cls


# -------------------------------------------------------------------------------------------------- aggregation


@dataclass
class Mosaic:
    lat: np.ndarray          # cell centres, north first (geodetic, as the product's grid is read)
    lon: np.ndarray          # cell centres, west first
    cls: np.ndarray          # class per cell
    ln_tau: np.ndarray       # ln τ where the cell has a thickness (MEASURED, ESTIMATED), NaN elsewhere
    ice: np.ndarray          # ice phase
    top_m: np.ndarray        # cloud-top height (m) where the cell has one, NaN elsewhere
    info: dict = field(default_factory=dict)


def _centre_edges(c: np.ndarray) -> np.ndarray:
    step = (c[-1] - c[0]) / (c.size - 1)
    if not np.allclose(np.diff(c), step, rtol=0, atol=abs(step) * 1e-3):
        raise ValueError("source grid is not uniform")
    return c[0] - step / 2 + step * np.arange(c.size + 1)


def overlap(src_edges: np.ndarray, dst_edges: np.ndarray) -> sp.csr_matrix:
    """Rows: destination cells; columns: source cells; entries: the share of the destination cell's extent that
    the source cell covers (both edge arrays ascending). A row sums to 1 where the source grid covers the cell."""
    lo = np.maximum(dst_edges[:-1, None], src_edges[None, :-1]) if dst_edges.size * src_edges.size < 4_000_000 else None
    rows, cols, vals = [], [], []
    if lo is not None:
        ov = np.minimum(dst_edges[1:, None], src_edges[None, 1:]) - lo
        r, c = np.nonzero(ov > 0)
        rows, cols, vals = r, c, ov[r, c] / (dst_edges[1:] - dst_edges[:-1])[r]
    else:
        first = np.clip(np.searchsorted(src_edges, dst_edges[:-1], side="right") - 1, 0, src_edges.size - 2)
        last = np.clip(np.searchsorted(src_edges, dst_edges[1:], side="left") - 1, 0, src_edges.size - 2)
        for i in range(dst_edges.size - 1):
            k = np.arange(first[i], last[i] + 1)
            ov = np.minimum(dst_edges[i + 1], src_edges[k + 1]) - np.maximum(dst_edges[i], src_edges[k])
            keep = ov > 0
            rows.append(np.full(int(keep.sum()), i))
            cols.append(k[keep])
            vals.append(ov[keep] / (dst_edges[i + 1] - dst_edges[i]))
        rows, cols, vals = np.concatenate(rows), np.concatenate(cols), np.concatenate(vals)
    return sp.csr_matrix((vals, (rows, cols)), shape=(dst_edges.size - 1, src_edges.size - 1))


def aggregate(m: Mosaic, lat_edges_deg: np.ndarray, lon_edges_deg: np.ndarray) -> dict[str, np.ndarray]:
    """Area-overlap sums of the cells onto a grid of texels (row edges north first, in the latitude of the
    product's grid; column edges west first). Every output is a share, or a sum per unit area, of the TEXEL:
    `observed` is the share of the texel that has an observation, the classes are shares of the texel, and the
    ln τ, τ, ice and top-height fields are sums over the cells of a group times their share of the texel. All are
    additive: the area-weighted mean of four texels is the value of their union."""
    wr = overlap(np.sin(np.radians(_centre_edges(m.lat)[::-1])), np.sin(np.radians(np.asarray(lat_edges_deg, float)[::-1])))[::-1, ::-1]
    wc = overlap(_centre_edges(m.lon), np.asarray(lon_edges_deg, float))
    wr, wct = sp.csr_matrix(wr), sp.csr_matrix(wc).T.tocsr()
    dt = np.float64 if m.cls.size < 5_000_000 else np.float32

    def agg(x) -> np.ndarray:
        return np.asarray((wr @ np.asarray(x, dt)) @ wct, np.float64 if dt is np.float64 else np.float32)

    meas, est = m.cls == MEASURED, m.cls == ESTIMATED
    both = meas | est
    ln = np.where(both, m.ln_tau, 0).astype(dt)
    has_top = both & np.isfinite(m.top_m)
    out = {"observed": agg(m.cls != UNOBSERVED), "clear": agg(m.cls == CLEAR), "measured": agg(meas), "estimated": agg(est),
           "possible": agg(m.cls == POSSIBLE), "noThickness": agg(m.cls == NO_THICKNESS),
           "measuredLnTau": agg(np.where(meas, ln, 0)), "measuredLnTau2": agg(np.where(meas, ln * ln, 0)),
           "measuredTau": agg(np.where(meas, np.exp(ln), 0)), "measuredIce": agg(meas & m.ice),
           "thicknessLnTau": agg(ln), "thicknessLnTau2": agg(ln * ln), "thicknessIce": agg(both & m.ice),
           "topShare": agg(has_top), "topSum": agg(np.where(has_top, m.top_m, 0))}
    return out


def layers(a: dict[str, np.ndarray], min_observed: float = 0.5) -> dict[str, np.ndarray]:
    """The three layers' top-level arrays from `aggregate`'s sums, and the mask of known texels. A texel observed
    over less than `min_observed` of its area is unknown; otherwise every share is of the OBSERVED area (nothing
    is assumed about the part of a texel that was not observed).

      clouds            [cloud share (every cloud class and the "possible" class), mean τ and ice share of the
                         cells with a measured thickness, mean top height of the cells with a thickness]
      cloudTau          [share, Σ ln τ, Σ (ln τ)², ice share] of the cells with a measured thickness
      cloudTauEstimated the same over the cells with a measured or an estimated thickness
    """
    obs = a["observed"]
    known = obs >= min_observed
    with np.errstate(invalid="ignore", divide="ignore"):
        o = np.where(known, obs, np.nan)
        meas, thick = a["measured"], a["measured"] + a["estimated"]
        cloud = thick + a["possible"] + a["noThickness"]
        none = cloud <= 0

        def in_cloud(num, den):
            return np.where(den > 0, num / den, np.where(none, 0.0, np.nan))

        clouds = np.stack([cloud / o, in_cloud(a["measuredTau"], meas), in_cloud(a["topSum"], a["topShare"]),
                           in_cloud(a["measuredIce"], meas)], axis=-1)
        strict = np.stack([meas / o, a["measuredLnTau"] / o, a["measuredLnTau2"] / o, a["measuredIce"] / o], axis=-1)
        best = np.stack([thick / o, a["thicknessLnTau"] / o, a["thicknessLnTau2"] / o, a["thicknessIce"] / o], axis=-1)
    for x in (clouds, strict, best):
        x[~known] = np.nan
    return {"clouds": clouds.astype(np.float32), "cloudTau": strict.astype(np.float32),
            "cloudTauEstimated": best.astype(np.float32), "known": known}


# ------------------------------------------------------------------------------------------------------ mosaic

#: The remote files and the decoded strips this pipeline was built with, per UTC day and file hour:
#: {bytes, etag, lastModified} of the remote file and the sha256 of the strip's packed arrays (StripData.digest).
#: A file that changes, or a strip that decodes differently, fails the build. `python -m pipeline.satcorps pins
#: <day>` reads a day unpinned and prints this table (an explicit input update, like the other Earth pins).
PINS: dict[str, dict[int, dict]] = {}


def _count(mask: np.ndarray) -> int:
    return int(np.count_nonzero(mask))


def mosaic(day: str, pins: dict[int, dict] | None, subdir: str = SUBDIR) -> Mosaic:
    """The day's 24 strips side by side on the product's grid, classified. `info` holds what the header states:
    per strip the file, its sources with their cell counts and observation times, and the class counts; the
    evidence counts for the geometric test; the ledger entries of every byte range read."""
    lat = None
    info: dict = {"day": day, "localSolarHour": LOCAL_SOLAR_HOUR, "strips": [], "files": {}, "pins": {}}
    names = {**GEOSTATIONARY, **POLAR}
    zero = lambda: {"cells": 0, "possible": 0, "noRetrieval": 0}   # noqa: E731
    ev = {n: {"waterInsideCone": zero(), "waterOutsideCone": zero(), "lowSun": zero(), "sun60toLowSun": zero()}
          for n in GEOSTATIONARY.values()}
    for strip in strips(day):
        if pins is not None and strip.hour not in pins:
            raise ValueError(f"SatCORPS strip of {day} {strip.hour:02d} UTC has no pin")
        d = read_strip(strip, None if pins is None else pins[strip.hour], subdir)
        if lat is None:
            lat = d.lat
            n_lon = int(round(360.0 / float(d.lon[1] - d.lon[0])))
            step = 360.0 / n_lon
            lon = -180.0 + step * (np.arange(n_lon) + 0.5)
            cls = np.full((lat.size, n_lon), 255, np.uint8)
            ln_tau = np.full((lat.size, n_lon), np.nan, np.float32)
            top_m = np.full((lat.size, n_lon), np.nan, np.float32)
            ice = np.zeros((lat.size, n_lon), bool)
            info["grid"] = {"rows": int(lat.size), "columns": n_lon, "stepDeg": step, "version": d.version}
        elif not np.array_equal(lat, d.lat):
            raise ValueError(f"{strip.url}: latitude grid differs from the first strip's")
        c0 = int(round((float(d.lon[0]) + 180.0) / step - 0.5))
        cols = slice(c0, c0 + d.lon.size)
        if d.lon.size != lon[cols].size or not np.allclose(lon[cols], d.lon, atol=step * 1e-2) or (cls[:, cols] != 255).any():
            raise ValueError(f"{strip.url}: strip columns do not fit the mosaic")
        a, at = d.arrays, d.attrs
        g = geometry(a, at)
        k = classify(a, at, g)
        thick = (k == MEASURED) | (k == ESTIMATED)
        tau = a["cloud_optical_depth"].astype(np.float64) * at["cloud_optical_depth"]["scale"]
        cls[:, cols] = k
        ln_tau[:, cols] = np.where(thick, np.log(np.where(thick, tau, 1.0)), np.nan)
        ice[:, cols] = thick & (a["cloud_phase"] == PHASE_ICE)
        h_ok = thick & _valid(a, at, "cloud_top_height")
        top_m[:, cols] = np.where(h_ok, a["cloud_top_height"].astype(np.float64) * at["cloud_top_height"]["scale"] * 1000.0, np.nan)
        # what the header says about this strip
        sid, rt = a["satellite_ID"], a["relative_time"]
        rt_ok = _valid(a, at, "relative_time")
        srcs = {}
        for i, name in names.items():
            m = sid == i
            if m.any():
                t = rt[m & rt_ok]
                srcs[name] = {"cells": _count(m), "secondsFromNominal": [int(t.min()), int(t.max())] if t.size else None}
        files = {download.ledger_key(p): download.record(p) for p in d.paths}
        info["files"].update(files)
        info["pins"][strip.hour] = {**d.remote, "sha256": d.digest}
        info["strips"].append({
            "fileHourUtc": strip.hour, "lonWest": strip.lon_west, "lonEast": strip.lon_east, "url": strip.url,
            "referenceTime": d.reference_time, "version": d.version, "satelliteSources": d.sources,
            "inputGranules": len(d.granules), "remote": d.remote, "sha256": d.digest,
            "bytesRead": int(sum(e["bytes"] for e in files.values())), "rangesRead": len(files), "sources": srcs,
            "cells": {CLASS_NAMES[c]: _count(k == c) for c in CLASS_NAMES}})
        # the evidence for the geometric test, from the cells of this strip
        ph = a["cloud_phase"]
        poss, nor = np.isin(ph, PHASE_POSSIBLE), np.isin(ph, PHASE_NO_RETRIEVAL)
        sza = a["solar_zenith"]
        s60 = _packed(60.0, at["solar_zenith"]["scale"])
        for i, name in GEOSTATIONARY.items():
            m = (sid == i) & g["szaKnown"]
            for key, sel in (("waterInsideCone", m & g["water"] & ~g["lowSun"] & g["inCone"]),
                             ("waterOutsideCone", m & g["water"] & ~g["lowSun"] & g["anglesKnown"] & ~g["inCone"]),
                             ("lowSun", m & g["lowSun"] & ~g["night"]),
                             ("sun60toLowSun", m & ~g["lowSun"] & (sza >= s60))):
                e = ev[name][key]
                e["cells"] += _count(sel)
                e["possible"] += _count(sel & poss)
                e["noRetrieval"] += _count(sel & nor)
    if (cls == 255).any():
        raise ValueError("the strips do not cover every longitude")
    info["evidence"] = ev
    info["cells"] = {CLASS_NAMES[c]: _count(cls == c) for c in CLASS_NAMES}
    return Mosaic(lat=lat, lon=lon, cls=cls, ln_tau=ln_tau, ice=ice, top_m=top_m, info=info)


if __name__ == "__main__":
    import json
    import sys
    if len(sys.argv) == 3 and sys.argv[1] == "pins":
        table = {}
        for st_ in strips(sys.argv[2]):
            d_ = read_strip(st_, None)
            table[st_.hour] = {**d_.remote, "sha256": d_.digest}
            print(f"# {st_.hour:02d} UTC read: {len(d_.paths)} ranges", file=sys.stderr, flush=True)
        print(json.dumps({sys.argv[2]: table}, indent=1))
    else:
        raise SystemExit("usage: python -m pipeline.satcorps pins <YYYY-MM-DD>")
